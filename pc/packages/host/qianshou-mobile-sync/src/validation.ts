/** Wire limits for relay envelopes and phone payloads; validated before any Session or durable state is touched. */
import { MobileSyncFailure } from './failure.ts'
import type { PcWindowAction, RelayRequest, WindowActionInput, WindowBinding, WindowCommand } from './types.ts'

/** Identifier ceiling shared with the relay (pc-relay.ts `id()` accepts up to 512; session-connect identifiers stop at 256). */
const MAX_ID = 256
/** Command text ceiling equal to the session-connect text route (validation.ts `sendInput`, 4096 characters / 12000 bytes). */
const MAX_TEXT_CHARS = 4096
const MAX_TEXT_BYTES = 12000
const MAX_LABEL = 200
/** Commands must expire; seven days matches the old gateway's `MAX_LIFETIME_MS` (mobile-sync validate.ts). */
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
/** Receipt-stream cursor format the relay validates on both directions (mobile-sync validate.ts `parseCursor`). */
export const SYNC_CURSOR_PREFIX = 'qianshou.pc-window.cursor.v1'
const ACTIONS: ReadonlySet<string> = new Set<PcWindowAction>(['bootstrap', 'access', 'transcript', 'sync', 'submit'])

/**
 * Whether a value is usable as an opaque identifier: non-empty after trimming, bounded, no control characters.
 * @param value - Untrusted candidate.
 * @returns True when the value may become a storage key or wire identity.
 */
export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID && !/[\u0000-\u001f\u007f]/u.test(value)
}
/**
 * Narrow an untrusted value to a plain object.
 * @param value - Untrusted JSON value.
 * @returns The object, or an empty object for anything else.
 */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const id = (value: unknown, kind: 'BAD_REQUEST' | 'COMMAND_INVALID' = 'COMMAND_INVALID'): string => {
  if (!isOpaqueId(value)) throw new MobileSyncFailure(kind)
  return value
}
const text = (value: unknown, maxChars: number, maxBytes: number): string => {
  if (typeof value !== 'string') throw new MobileSyncFailure('COMMAND_INVALID')
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxChars || Buffer.byteLength(trimmed) > maxBytes || trimmed.includes('\0')) throw new MobileSyncFailure('COMMAND_INVALID')
  return trimmed
}
const instant = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MobileSyncFailure('COMMAND_INVALID')
  return value as number
}
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new MobileSyncFailure('COMMAND_INVALID')
  return value as number
}
/**
 * Validate the complete origin: account, PC, original Session and phone.
 * @param value - Untrusted binding from the relay payload.
 * @returns The validated binding.
 */
export function parseBinding(value: unknown): WindowBinding {
  const item = record(value)
  if (Object.keys(item).length === 0) throw new MobileSyncFailure('BAD_REQUEST')
  return { accountId: id(item.accountId, 'BAD_REQUEST'), pcId: id(item.pcId, 'BAD_REQUEST'),
    sessionId: id(item.sessionId, 'BAD_REQUEST'), sourceDeviceId: id(item.sourceDeviceId, 'BAD_REQUEST') }
}
function parseAction(value: unknown): WindowActionInput {
  const item = record(value)
  switch (item.type) {
    case 'dispatch':
      return { type: 'dispatch', text: text(item.text, MAX_TEXT_CHARS, MAX_TEXT_BYTES),
        ...(item.label === undefined ? {} : { label: text(item.label, MAX_LABEL, MAX_LABEL * 4) }) }
    case 'append':
      return { type: 'append', targetSessionId: id(item.targetSessionId), expectedRevision: revision(item.expectedRevision),
        text: text(item.text, MAX_TEXT_CHARS, MAX_TEXT_BYTES) }
    case 'cancel':
      return { type: 'cancel', targetSessionId: id(item.targetSessionId), expectedRevision: revision(item.expectedRevision) }
    default:
      throw new MobileSyncFailure('COMMAND_INVALID')
  }
}
/**
 * Validate a complete command including its bounded lifetime.
 * @param value - Untrusted command from the relay payload.
 * @returns The validated command.
 */
export function parseCommand(value: unknown): WindowCommand {
  const item = record(value)
  if (Object.keys(item).length === 0) throw new MobileSyncFailure('COMMAND_INVALID')
  const createdAt = instant(item.createdAt), expiresAt = instant(item.expiresAt)
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_LIFETIME_MS) throw new MobileSyncFailure('COMMAND_INVALID')
  return { requestId: id(item.requestId), origin: parseBinding(item.origin), createdAt, expiresAt, action: parseAction(item.action) }
}
/**
 * Validate a receipt-stream cursor; only this PC's own counter format is accepted.
 * @param value - Untrusted cursor or `null` for the stream start.
 * @returns The sequence the cursor names; 0 for the start.
 */
export function parseSyncCursor(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value !== 'string') throw new MobileSyncFailure('CURSOR_INVALID')
  const match = new RegExp(`^${SYNC_CURSOR_PREFIX.replaceAll('.', '\\.')}:(\\d{1,15})$`, 'u').exec(value)
  if (match === null) throw new MobileSyncFailure('CURSOR_INVALID')
  return Number(match[1])
}
/**
 * Serialize one receipt-stream position.
 * @param sequence - Issued sequence.
 * @returns The wire cursor.
 */
export function syncCursor(sequence: number): string { return `${SYNC_CURSOR_PREFIX}:${String(sequence)}` }
/**
 * Validate the bounded list of command ids a phone reconciles.
 * @param value - Untrusted list; absence means none.
 * @returns Validated ids.
 */
export function parseRequestIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 500) throw new MobileSyncFailure('BAD_REQUEST')
  return value.map(entry => id(entry, 'BAD_REQUEST'))
}
/**
 * Validate a transcript cursor as an opaque bounded string; its structure is checked by the projection.
 * @param value - Untrusted cursor or `null`.
 * @returns The cursor or `null`.
 */
export function parseTranscriptCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > 160) throw new MobileSyncFailure('CURSOR_INVALID')
  return value
}
/**
 * Validate one forwarded request envelope from the relay.
 * @param value - Untrusted JSON row from the poll response.
 * @returns The validated request.
 */
export function parseRelayRequest(value: unknown): RelayRequest {
  const item = record(value)
  const action = item.action
  if (typeof action !== 'string' || !ACTIONS.has(action)) throw new MobileSyncFailure('RELAY_INVALID_REPLY')
  if (!isOpaqueId(item.id) || !isOpaqueId(item.accountId)) throw new MobileSyncFailure('RELAY_INVALID_REPLY')
  return { id: item.id, action: action as PcWindowAction, accountId: item.accountId, payload: record(item.payload) }
}
