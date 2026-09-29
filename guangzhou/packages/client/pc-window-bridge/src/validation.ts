/** Validate persisted and adapter-supplied observations before they can change delivery state. */
import type { WindowBinding, WindowCommand, WindowCommandRecord, WindowJournal, WindowReceipt, WindowSyncPage } from './types.ts'

/**
 * Encode the complete origin without ambiguous delimiter concatenation.
 * @param binding - Validated account, PC, original session and source device.
 * @returns Stable local journal key.
 */
export function originKey(binding: WindowBinding): string {
  return JSON.stringify([binding.accountId, binding.pcId, binding.sessionId, binding.sourceDeviceId])
}

/**
 * Compare every origin axis; matching an account alone is insufficient.
 * @param a - First validated origin.
 * @param b - Second validated origin.
 * @returns Whether both origins address the same journal and conversation.
 */
export function sameOrigin(a: WindowBinding, b: WindowBinding): boolean { return originKey(a) === originKey(b) }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('PC_WINDOW_INVALID_DATA')
  return value as Record<string, unknown>
}

function text(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0')
}

function counter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }

/**
 * Validate nonempty, bounded origin identifiers without granting account access.
 * @param value - Untrusted persisted or adapter-supplied origin.
 * @returns The validated origin; throws for invalid identifiers or object shape.
 */
export function parseBinding(value: unknown): WindowBinding {
  const item = record(value)
  if (![item.accountId, item.pcId, item.sessionId, item.sourceDeviceId].every(value => text(value))) throw new Error('PC_WINDOW_INVALID_ORIGIN')
  return item as unknown as WindowBinding
}

/**
 * Validate user text, identity, lifetime and revision-bound controls.
 * @param value - Untrusted local command candidate.
 * @returns The validated command; throws on malformed origin, action, text, target or expiry.
 */
export function parseCommand(value: unknown): WindowCommand {
  const item = record(value)
  parseBinding(item.origin)
  if (!text(item.requestId) || !counter(item.createdAt) || !counter(item.expiresAt) || item.expiresAt <= item.createdAt) throw new Error('PC_WINDOW_INVALID_COMMAND')
  const action = record(item.action)
  if (action.type !== 'dispatch' && action.type !== 'append' && action.type !== 'cancel') throw new Error('PC_WINDOW_INVALID_ACTION')
  if (action.type !== 'cancel' && !text(action.text, 16_000)) throw new Error('PC_WINDOW_INVALID_TEXT')
  if (action.type === 'dispatch' && action.label !== undefined && !text(action.label)) throw new Error('PC_WINDOW_INVALID_LABEL')
  if (action.type !== 'dispatch' && (!text(action.targetSessionId) || !counter(action.expectedRevision))) throw new Error('PC_WINDOW_INVALID_TARGET')
  return item as unknown as WindowCommand
}

/**
 * Validate an adapter's delivery observation independently of matching it to a command.
 * @param value - Untrusted PC receipt payload.
 * @returns The shape-checked receipt; throws on invalid identity, revision, state or reason.
 */
export function parseReceipt(value: unknown): WindowReceipt {
  const item = record(value)
  parseBinding(item.origin)
  if (!text(item.requestId) || !counter(item.revision)
    || !['received', 'rejected', 'cancelled', 'already-finished'].includes(String(item.state))
    || (item.childSessionId !== undefined && !text(item.childSessionId))
    || (item.reason !== null && !text(item.reason, 1000))) throw new Error('PC_WINDOW_INVALID_RECEIPT')
  return item as unknown as WindowReceipt
}

/**
 * Match an observation to its command and reject conflicting delivery facts.
 * @param entry - Existing local command and last applied receipt.
 * @param receipt - Shape-validated PC observation.
 * @returns The original record for older observations or an updated record; throws on origin, child or terminal-state conflicts.
 */
export function applyReceipt(entry: WindowCommandRecord, receipt: WindowReceipt): WindowCommandRecord {
  if (!sameOrigin(entry.command.origin, receipt.origin) || entry.command.requestId !== receipt.requestId) throw new Error('PC_WINDOW_RECEIPT_ORIGIN_MISMATCH')
  if (entry.state === 'withdrawn' || entry.state === 'expired') throw new Error('PC_WINDOW_UNSENT_RECEIPT')
  if (entry.command.action.type === 'dispatch' && receipt.state === 'received' && !receipt.childSessionId) throw new Error('PC_WINDOW_MISSING_CHILD_RECEIPT')
  if (receipt.state === 'cancelled' && entry.command.action.type !== 'cancel') throw new Error('PC_WINDOW_INVALID_CANCEL_RECEIPT')
  if (entry.receipt && receipt.revision <= entry.receipt.revision) return entry
  if (entry.receipt) {
    if (entry.receipt.childSessionId !== receipt.childSessionId) throw new Error('PC_WINDOW_CHANGED_CHILD_RECEIPT')
    const terminal = ['rejected', 'cancelled', 'already-finished'].includes(entry.receipt.state)
    if ((terminal && entry.receipt.state !== receipt.state)
      || (entry.receipt.state === 'received' && receipt.state === 'rejected')) throw new Error('PC_WINDOW_RECEIPT_REGRESSION')
  }
  return { ...entry, state: receipt.state, receipt }
}

/**
 * Validate persisted commands and receipts before exposing account-local data.
 * @param value - Untrusted stored journal.
 * @param binding - Exact authorized origin expected by the controller.
 * @returns A detached validated journal; throws on wrong origin, duplicate ids or unsupported record states.
 */
export function parseJournal(value: unknown, binding: WindowBinding): WindowJournal {
  const item = record(value)
  if (item.version !== 'qianshou.pc-window.v1' || !sameOrigin(parseBinding(item.binding), binding)
    || !counter(item.revision) || (item.cursor !== null && !text(item.cursor, 4096))
    || !Array.isArray(item.records) || item.records.length > 500) throw new Error('PC_WINDOW_INVALID_JOURNAL')
  const seen = new Set<string>()
  for (const raw of item.records) {
    const entry = record(raw)
    const command = parseCommand(entry.command)
    if (!sameOrigin(command.origin, binding) || seen.has(command.requestId)
      || !['queued', 'delivering', 'uncertain', 'received', 'rejected', 'expired', 'withdrawn', 'cancelled', 'already-finished'].includes(String(entry.state))) throw new Error('PC_WINDOW_INVALID_RECORD')
    seen.add(command.requestId)
    if (entry.receipt !== null) {
      const receipt = parseReceipt(entry.receipt)
      if (entry.state !== receipt.state) throw new Error('PC_WINDOW_INVALID_RECORD')
      applyReceipt({ command, state: 'uncertain', receipt: null }, receipt)
    } else if (['received', 'rejected', 'cancelled', 'already-finished'].includes(String(entry.state))) throw new Error('PC_WINDOW_MISSING_RECEIPT')
  }
  return structuredClone(item) as unknown as WindowJournal
}

/**
 * Validate bounded receipt pages and reject contradictory non-admission proofs.
 * @param value - Untrusted adapter cursor response.
 * @returns The shape-validated page; the controller still checks its current origin, cursor and known command ids.
 */
export function parseSyncPage(value: unknown): WindowSyncPage {
  const item = record(value)
  parseBinding(item.binding)
  if ((item.fromCursor !== null && !text(item.fromCursor, 4096)) || !text(item.nextCursor, 4096)
    || !Array.isArray(item.receipts) || item.receipts.length > 500
    || !Array.isArray(item.notReceivedIds) || item.notReceivedIds.length > 500
    || !item.notReceivedIds.every(value => text(value))) throw new Error('PC_WINDOW_INVALID_SYNC')
  const seen = new Set<string>()
  for (const value of item.receipts) {
    const receipt = parseReceipt(value)
    if (!sameOrigin(receipt.origin, parseBinding(item.binding)) || seen.has(receipt.requestId)) throw new Error('PC_WINDOW_INVALID_SYNC')
    seen.add(receipt.requestId)
  }
  for (const value of item.notReceivedIds) {
    if (seen.has(value)) throw new Error('PC_WINDOW_CONFLICTING_RECEIPTS')
    seen.add(value)
  }
  return item as unknown as WindowSyncPage
}
