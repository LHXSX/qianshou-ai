/** Validate untrusted phone payloads before they can reach any Session or durable state. */
import { MobileSyncError } from '../errors.ts'
import type { WindowAction, WindowBinding, WindowCommand } from './types.ts'

/** Bounded text length for one user-visible command part. */
const MAX_TEXT = 16_000
/** Bounded length for opaque identifiers minted by the client. */
const MAX_ID = 256
/** Bounded length for a dispatch label. */
const MAX_LABEL = 200
/** Commands must expire; an unbounded lifetime would be an unexpiring execution right. */
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  return value as Record<string, unknown>
}

/**
 * Accept a bounded, nonempty string; it may contain whitespace but never NUL.
 *
 * Identifiers and user text share this rule — a NUL would corrupt a storage key in
 * the first case and a durable record in the second — so one implementation carries
 * both callers instead of two identical copies drifting apart.
 * @param value - Candidate string from the request body.
 * @param max - Inclusive upper bound in code units for this field.
 * @returns The validated string.
 */
function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) {
    throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  }
  return value
}

/** Accept a bounded, nonempty opaque identifier; a NUL would corrupt the storage key. */
function id(value: unknown, max = MAX_ID): string {
  return boundedString(value, max)
}

/** Accept bounded user text; it may contain whitespace but not NUL. */
function text(value: unknown, max = MAX_TEXT): string {
  return boundedString(value, max)
}

/** Accept an epoch-millisecond instant. */
function instant(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  return value as number
}

/** Accept a conversation revision; revision 1 is a conversation's initial state. */
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  return value as number
}

/**
 * Validate the complete origin: account, PC, original conversation and phone.
 * @param value - Untrusted origin from the phone.
 * @returns The validated origin; throws when any axis is missing or malformed.
 */
export function parseBinding(value: unknown): WindowBinding {
  const item = record(value)
  return {
    accountId: id(item.accountId),
    pcId: id(item.pcId),
    sessionId: id(item.sessionId),
    sourceDeviceId: id(item.sourceDeviceId),
  }
}

/**
 * Validate one revision-bound control or dispatch action.
 * @param value - Untrusted action.
 * @returns The validated action; throws on an unknown type, empty text or invalid target.
 */
export function parseAction(value: unknown): WindowAction {
  const item = record(value)
  switch (item.type) {
    case 'dispatch':
      return {
        type: 'dispatch',
        text: text(item.text),
        ...(item.label === undefined ? {} : { label: text(item.label, MAX_LABEL) }),
      }
    case 'append':
      return {
        type: 'append',
        targetSessionId: id(item.targetSessionId),
        expectedRevision: revision(item.expectedRevision),
        text: text(item.text),
      }
    case 'cancel':
      return {
        type: 'cancel',
        targetSessionId: id(item.targetSessionId),
        expectedRevision: revision(item.expectedRevision),
      }
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  }
}

/**
 * Validate a complete command, including that its lifetime is real and bounded.
 * @param value - Untrusted command from the phone.
 * @returns The validated command; throws when identity, origin, action or lifetime is invalid.
 */
export function parseCommand(value: unknown): WindowCommand {
  const item = record(value)
  const createdAt = instant(item.createdAt)
  const expiresAt = instant(item.expiresAt)
  if (expiresAt <= createdAt) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  if (expiresAt - createdAt > MAX_LIFETIME_MS) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  return {
    requestId: id(item.requestId),
    origin: parseBinding(item.origin),
    createdAt,
    expiresAt,
    action: parseAction(item.action),
  }
}

/**
 * Validate a pagination cursor: only the gateway's own counter format is accepted,
 * so an opaque or hand-built cursor can never widen or misalign a receipt page.
 * @param value - Untrusted cursor, or `null` for the beginning of the stream.
 * @returns The sequence the cursor names, or 0 for the start of the stream.
 */
export function parseCursor(value: unknown): number {
  if (value === null) return 0
  if (typeof value !== 'string') throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  const match = /^qianshou\.pc-window\.cursor\.v1:(\d+)$/u.exec(value)
  if (match === null) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  const sequence = Number(match[1])
  if (!Number.isSafeInteger(sequence)) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  return sequence
}

/**
 * Validate the bounded list of command ids a phone is reconciling.
 * @param value - Untrusted id list; absence means no reconciliation.
 * @returns The validated ids.
 */
export function parseRequestIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 500) throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
  return value.map(entry => id(entry))
}
