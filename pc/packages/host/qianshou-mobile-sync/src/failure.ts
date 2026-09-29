/** Stable refusal codes; every rejection crossing the relay names one, and none embeds text, tokens or paths. */
import { ConnectFailure } from '@deepseek-ai/dsh-host-qianshou-session-connect'

/** Suffixes of the `PC_WINDOW_*` codes the relay forwards to the phone verbatim (pc-relay.ts `/^PC_WINDOW_[A-Z_]{1,96}$/`). */
export type MobileSyncFailureKind =
  | 'BAD_REQUEST' | 'COMMAND_INVALID' | 'NOT_SIGNED_IN' | 'OWNER_CHANGED' | 'BINDING_UNKNOWN' | 'BINDING_REVOKED'
  | 'NO_SESSION' | 'SESSION_UNAVAILABLE' | 'REQUEST_CONFLICT' | 'COMMAND_EXPIRED' | 'ACTION_UNSUPPORTED' | 'TARGET_MISMATCH'
  | 'CURSOR_INVALID' | 'CURSOR_FUTURE' | 'HISTORY_TOO_LARGE' | 'CAPACITY' | 'STORAGE_FAILED' | 'CLOSED' | 'TIMEOUT'
  | 'PC_ID_INVALID' | 'CREDENTIAL_UNAVAILABLE' | 'RELAY_REJECTED' | 'RELAY_UNAVAILABLE' | 'RELAY_INVALID_REPLY'

const STATUS: Readonly<Record<MobileSyncFailureKind, number>> = {
  BAD_REQUEST: 400, COMMAND_INVALID: 400, NOT_SIGNED_IN: 401, OWNER_CHANGED: 403, BINDING_UNKNOWN: 403, BINDING_REVOKED: 403,
  NO_SESSION: 409, SESSION_UNAVAILABLE: 409, REQUEST_CONFLICT: 409, COMMAND_EXPIRED: 409, ACTION_UNSUPPORTED: 409, TARGET_MISMATCH: 409,
  CURSOR_INVALID: 409, CURSOR_FUTURE: 409, HISTORY_TOO_LARGE: 413, CAPACITY: 429, STORAGE_FAILED: 503, CLOSED: 503, TIMEOUT: 504,
  PC_ID_INVALID: 503, CREDENTIAL_UNAVAILABLE: 401, RELAY_REJECTED: 502, RELAY_UNAVAILABLE: 503, RELAY_INVALID_REPLY: 502,
}

/** One refusal with its HTTP status; `code` is the complete wire code and `detail` a bounded relay code for diagnostics only. */
export class MobileSyncFailure extends Error {
  /** The complete `PC_WINDOW_*` wire code the relay forwards verbatim; it carries no text, token or path. */
  readonly code: string
  /** HTTP status the relay reply uses, from the fixed per-kind table unless the caller overrides it. */
  readonly status: number
  constructor(readonly kind: MobileSyncFailureKind, status?: number, readonly detail: string | null = null) {
    super(`PC_WINDOW_${kind}`)
    this.code = `PC_WINDOW_${kind}`
    this.status = status ?? STATUS[kind]
  }
  /**
   * Diagnostic label: the wire code plus the relay's own code when one was reported.
   * @returns Bounded label safe for the status Remote.
   */
  label(): string { return this.detail === null ? this.code : `${this.code}:${this.detail}` }
}

/**
 * Translate a refusal raised by the shared session-connect port into this package's code space.
 * @param error - Any thrown value.
 * @returns A stable refusal; unknown internals collapse to a Session-unavailable refusal without detail.
 */
export function safeFailure(error: unknown): MobileSyncFailure {
  if (error instanceof MobileSyncFailure) return error
  if (error instanceof ConnectFailure) {
    switch (error.code) {
      case 'storage-failed': return new MobileSyncFailure('STORAGE_FAILED')
      case 'cursor-invalid': return new MobileSyncFailure('CURSOR_INVALID')
      case 'history-too-large': return new MobileSyncFailure('HISTORY_TOO_LARGE')
      case 'timeout': return new MobileSyncFailure('TIMEOUT')
      case 'closed': return new MobileSyncFailure('CLOSED')
      case 'capacity': return new MobileSyncFailure('CAPACITY')
      default: return new MobileSyncFailure('SESSION_UNAVAILABLE')
    }
  }
  return new MobileSyncFailure('SESSION_UNAVAILABLE', 503)
}
