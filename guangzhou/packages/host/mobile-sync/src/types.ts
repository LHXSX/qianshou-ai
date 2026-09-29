/** Versioned durable state shared by the sync store and service. Types only; no runtime code. */
import type { PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'
import type { MobileCapabilityHeartbeat, MobileSyncAck } from '@deepseek-ai/dsh-host-platform-observability-contract'

/** Durable file schema version; a mismatch is a corruption failure, never a silent migration. */
export const MOBILE_SYNC_STORE_VERSION = 1 as const

/** Cursor a participant holds before it has accepted any acknowledgement. */
export const MOBILE_SYNC_INITIAL_CURSOR = 'start' as const

/** One identity's durable presentation state.
 *
 * `revision` advances only when the server makes a new presentation durable, so a
 * replayed request returns the stored revision instead of a fresh one. `lastCursor`
 * is the cursor the server last accepted from this participant; it is what makes a
 * stale (out-of-order) request detectable instead of silently accepted. `issuedAt`
 * bounds how long a participant may resume from that cursor.
 */
export interface MobileSyncRecord {
  /** Revision the participant must observe before publishing a new cursor. */
  revision: number
  /** Last cursor accepted from this participant. */
  lastCursor: string
  /** Epoch milliseconds when the last cursor was issued; absent in records written before expiry existed. */
  issuedAt?: number
  /** Durable acknowledgement projected to the participant; never a task result or settlement. */
  ack: MobileSyncAck
}

/** Whole durable file: one bounded record per participating identity. */
export interface MobileSyncFile {
  version: typeof MOBILE_SYNC_STORE_VERSION
  records: Readonly<Record<string, MobileSyncRecord>>
}

/** Immutable per-identity view returned by `MobileSyncStore.list`. */
export interface MobileSyncEntry extends MobileSyncRecord {
  identity: PlatformIdentity
  key: string
}

/** Heartbeat facts the server keeps authoritative instead of echoing back verbatim. */
export type MobileSyncHeartbeat = MobileCapabilityHeartbeat
