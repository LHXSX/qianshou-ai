/** Public connection views; cloud accounts and owner credentials are never part of a grant. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Actions a device owner may grant for one existing ordinary Session. */
export type ConnectionMode = 'read' | 'text'
/** One owner's revocable authorization; the bearer secret is omitted. */
export interface ConnectionGrant {
  id: string
  sessionId: SessionId
  label: string
  mode: ConnectionMode
  createdAt: number
  expiresAt: number
  revoked: boolean
  lastAccessAt: number | null
  acceptedCommands: number
  /**
   * PC this grant belongs to, or `null` for a grant created before device
   * binding. Taken from the paired device record, never from `hostname`.
   */
  pcId: string | null
  /**
   * Device this grant was issued to, or `null` when the owner created it as a
   * link anyone may present. A grant naming a device refuses any other device.
   */
  deviceId: string | null
}
/** Explicit owner choice; sharing never changes a Session's execution permissions. */
export interface ConnectionGrantInput {
  sessionId: SessionId
  label: string
  mode: ConnectionMode
  durationMinutes: number
  /** PC identity from the paired device record; omission creates an unbound link. */
  pcId?: string
  /** Device to bind; omission creates a link any bearer holder may use. */
  deviceId?: string
}
/** The secret link is returned once; it must not enter logs, diagnostics or Session history. */
export interface ConnectionGrantCreated { grant: ConnectionGrant; path: string }
/** Owner-facing status for only the selected Session. */
export interface ConnectionOwnerState {
  grants: ConnectionGrant[]
  available: boolean
  owner: 'local-device'
  origin: string
  maxDurationMinutes: number
}
/** Bounded plain text; tool arguments, files, reasoning and system instructions are excluded. */
export interface ConnectionTurn { seq: number; role: 'user' | 'assistant'; text: string; truncated: boolean }
/** Incremental committed-log projection, with an explicit reset after replaced history. */
export interface ConnectionPage {
  sessionId: string
  label: string
  mode: ConnectionMode
  expiresAt: number
  cursor: string
  reset: boolean
  hasMore: boolean
  earlierOmitted: boolean
  running: boolean
  turns: ConnectionTurn[]
}
/** Admission is distinct from completion; an uncertain receipt never permits automatic resubmission. */
export interface ConnectionReceipt {
  requestId: string
  state: 'received' | 'uncertain' | 'rejected'
  acceptedAt: number | null
}
