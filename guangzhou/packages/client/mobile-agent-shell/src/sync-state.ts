/** Durable cursor and revision state owned by the embedding application. */

/** Cursor a shell holds before it has accepted any acknowledgement. */
const INITIAL_CURSOR = 'start'

/** Cursor, revision and heartbeat sequence a shell must restore after a reload.
 *
 * The shell reads this synchronously at construction so a reloaded page resumes from
 * the last acknowledgement it actually accepted. Persistence never invents progress:
 * a shell with no stored state starts at the initial cursor and revision zero, and a
 * refused or stale acknowledgement is never written.
 */
export interface MobileSyncState {
  /** Cursor committed from the last accepted acknowledgement. */
  readonly cursor: string
  /** Revision of the last accepted acknowledgement; `null` before any accepted sync. */
  readonly lastSyncRevision: number | null
  /** Next heartbeat sequence the shell must exceed. */
  readonly sequence: number
}

/** Storage the embedding application supplies; the shell never opens storage itself. */
export interface MobileSyncStatePort {
  /** Current durable state, or `null` when nothing has been persisted for this identity. */
  readonly snapshot: () => MobileSyncState | null
  /** Persist the next committed state; rejections surface to the caller instead of being dropped. */
  readonly save: (state: MobileSyncState) => Promise<void>
}

/** State a shell uses when the embedding application has no durable record. */
export const MOBILE_SYNC_INITIAL_STATE: MobileSyncState = Object.freeze({
  cursor: INITIAL_CURSOR, lastSyncRevision: null, sequence: 0,
})

/** Trust nothing from storage until its shape is checked at this boundary. */
export function parseMobileSyncState(value: unknown): MobileSyncState | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { cursor?: unknown; lastSyncRevision?: unknown; sequence?: unknown }
  if (typeof candidate.cursor !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/u.test(candidate.cursor)) return null
  const revision = candidate.lastSyncRevision
  if (revision !== null && (!Number.isSafeInteger(revision) || (revision as number) < 0)) return null
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 0) return null
  return Object.freeze({ cursor: candidate.cursor, lastSyncRevision: revision as number | null, sequence: candidate.sequence as number })
}
