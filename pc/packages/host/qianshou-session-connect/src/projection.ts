/** Bounded committed text projection; internal instructions, tools, reasoning and files never cross the connection. */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ConnectionGrant, ConnectionPage, ConnectionTurn } from './types.ts'
import { ConnectFailure } from './validation.ts'

/**
 * Per-turn byte ceiling for the browser view, whose response budget holds 25
 * turns within 240000 bytes.
 */
export const VIEW_TURN_BYTE_LIMIT = 6000
/**
 * Per-turn byte ceiling for the phone route. The phone's own transcript parser
 * rejects a turn longer than 4096 characters outright rather than truncating it,
 * so this route must not exceed that or the phone treats the whole reply as
 * malformed.
 */
export const PHONE_TURN_BYTE_LIMIT = 4096

function textParts(content: readonly unknown[], limit: number): { text: string; truncated: boolean } {
  let text = '', bytes = 0, truncated = false
  for (const value of content) {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'text' || !('text' in value) || typeof value.text !== 'string') continue
    for (const char of value.text) {
      bytes += Buffer.byteLength(char)
      if (bytes > limit) { truncated = true; break }
      text += char
    }
    if (truncated) break
  }
  return { text, truncated }
}
/**
 * Project one bounded event window with a cursor scoped to the exact grant.
 * @param grant - Verified grant metadata.
 * @param events - Authoritative captured Session prefix.
 * @param cursor - Last cursor accepted by the viewer, or null for a fresh recent window.
 * @param running - Actual current Host Agent activity.
 * @param turnByteLimit - Per-turn ceiling for this route; defaults to the browser view's.
 * @returns A bounded committed-text page.
 */
export function projectConnectionPage(
  grant: ConnectionGrant, events: readonly SessionEvent[], cursor: string | null, running: boolean,
  turnByteLimit: number = VIEW_TURN_BYTE_LIMIT,
): ConnectionPage {
  if (events.length > 100000) throw new ConnectFailure('history-too-large', 413)
  const prefix = `v1:${grant.id}:`
  const tail = events.at(-1)?.seq ?? -1
  let after = -1, observedReplacement = -1, recoveredTail = false
  if (cursor !== null) {
    if (!cursor.startsWith(prefix) || !/^-?\d+:-?\d+$/u.test(cursor.slice(prefix.length))) throw new ConnectFailure('cursor-invalid', 409)
    const parts = cursor.slice(prefix.length).split(':')
    observedReplacement = Number(parts[0]); after = Number(parts[1])
    if (!Number.isSafeInteger(after) || after < -1 || !Number.isSafeInteger(observedReplacement) || observedReplacement < -1) throw new ConnectFailure('cursor-invalid', 409)
    recoveredTail = after > tail || observedReplacement > tail
  }
  /* oxlint-disable typescript/no-non-null-assertion -- The fold owns linked-node insertion/removal; loop bounds own event indices. */
  const visible = new Map<number, { previous: number | null; next: number | null }>()
  let last: number | null = null
  let replacement = -1
  for (const event of events) {
    if (!event.surfaceOp) continue
    if (event.surfaceOp === 'append') {
      if (last !== null) visible.get(last)!.next = event.seq
      visible.set(event.seq, { previous: last, next: null }); last = event.seq
      continue
    }
    const start = visible.get(event.surfaceOp.startSeq), end = visible.get(event.surfaceOp.endSeq)
    if (!start || !end) throw new ConnectFailure('session-unavailable', 409)
    const previous = start.previous, next = end.next
    let current: number | null = event.surfaceOp.startSeq
    while (current !== next) {
      if (current === null || !visible.has(current)) throw new ConnectFailure('session-unavailable', 409)
      const node: { previous: number | null; next: number | null } = visible.get(current)!
      visible.delete(current); current = node.next
    }
    visible.set(event.seq, { previous, next })
    if (previous !== null) visible.get(previous)!.next = event.seq
    if (next !== null) visible.get(next)!.previous = event.seq
    else last = event.seq
    replacement = event.seq
  }
  const reset = cursor === null || recoveredTail || observedReplacement !== replacement
  const first = reset ? Math.max(0, events.length - 200) : after + 1
  let scanned = first - 1
  const turns: ConnectionTurn[] = []
  const envelope = (values: ConnectionTurn[], lastScanned: number): ConnectionPage => ({ sessionId: grant.sessionId, label: grant.label,
    mode: grant.mode, expiresAt: grant.expiresAt, cursor: `${prefix}${replacement}:${lastScanned}`, reset,
    hasMore: lastScanned < tail, earlierOmitted: reset && first > 0, running, turns: values })
  for (let index = first; index < events.length && index < first + 200 && turns.length < 25; index++) {
    const event = events[index]!
    const previousScanned = scanned
    scanned = event.seq
    if (!visible.has(event.seq)) continue
    let role: ConnectionTurn['role'], content: readonly unknown[]
    if (event.type === 'user/message' && event.data.source.kind === 'user') { role = 'user'; content = event.data.content }
    else if (event.type === 'assistant/message') { role = 'assistant'; content = event.data.message.content }
    else continue
    const value = textParts(content, turnByteLimit)
    if (value.text) {
      const turn = { seq: event.seq, role, ...value }
      if (Buffer.byteLength(JSON.stringify(envelope([...turns, turn], scanned))) > 240000) { scanned = previousScanned; break }
      turns.push(turn)
    }
  }
  /* oxlint-enable typescript/no-non-null-assertion */
  return envelope(turns, scanned)
}
