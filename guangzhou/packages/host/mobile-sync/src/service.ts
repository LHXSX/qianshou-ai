/** Server-authoritative mobile presentation state; never a task, ledger or push authority. */
import type { PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'
import {
  MOBILE_SYNC_VERSION,
  parseMobileCapabilityHeartbeat,
  parseMobileSyncRequest,
  type MobileCapabilityHeartbeat,
  type MobileSyncAck,
  type MobileSyncRequest,
} from '@deepseek-ai/dsh-host-platform-observability-contract'
import { MobileSyncError } from './errors.ts'
import { MobileSyncStore, identityKey } from './store.ts'
import { MOBILE_SYNC_INITIAL_CURSOR, type MobileSyncEntry } from './types.ts'

/** Why one accepted request did or did not advance the durable revision. */
export type MobileSyncOutcome = 'advanced' | 'replayed' | 'stale-cursor'

/** Result of one accepted sync, including the observable reason for its revision choice. */
export interface MobileSyncResult {
  /** Acknowledgement the client must publish only after its own staleness checks. */
  readonly ack: MobileSyncAck
  /** Whether this request created a new revision, replayed the current one, or arrived stale. */
  readonly outcome: MobileSyncOutcome
}

/** Service settings besides storage. */
export interface MobileSyncServiceOptions {
  /** How long a participant may resume from an issued cursor, in milliseconds. */
  readonly cursorMaxAgeMs?: number
  /** Clock used for cursor expiry; injected so the expiry boundary is testable. */
  readonly now?: () => number
}

/** One day: long enough for an offline phone to reconnect, short enough that a cursor cannot be replayed indefinitely. */
const DEFAULT_CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Cursor text this server issues for one accepted revision. */
export function cursorAt(identity: PlatformIdentity, revision: number): string {
  return `${identity.kind}-${identity.id}-r${String(revision)}`
}

/** Revision a cursor names, or `null` when the text is not a server-issued cursor.
 *
 * This is the whole anti-rollback guard: a cursor whose text does not name a revision
 * is refused at the boundary instead of being compared loosely. A loosely compared
 * cursor such as `...-r1-start` would extract no revision, skip the out-of-order check
 * and be accepted as brand-new progress.
 */
export function cursorRevision(cursor: string): number | null {
  const match = /-r(\d+)$/u.exec(cursor)
  return match === null ? null : Number(match[1])
}

/** Owns per-identity cursors and revisions for the mobile window.
 *
 * The service is deliberately small: it validates one bounded request, returns the
 * stored or advanced acknowledgement, and touches no model, task, media or payment
 * path. Revision monotonicity is the point of the whole component — a retry, a
 * replayed request or an out-of-order request must never hand a client a lower
 * revision than it already holds, and must never raise the revision on its own.
 */
export class MobileSyncService {
  private closed = false
  private readonly cursorMaxAgeMs: number
  private readonly now: () => number

  /** @param store - Durable per-identity revision and cursor state.
   * @param options - Cursor lifetime and clock; both default to deployment-safe values.
   */
  constructor(private readonly store: MobileSyncStore, options: MobileSyncServiceOptions = {}) {
    this.cursorMaxAgeMs = options.cursorMaxAgeMs ?? DEFAULT_CURSOR_MAX_AGE_MS
    this.now = options.now ?? (() => Date.now())
    if (!Number.isSafeInteger(this.cursorMaxAgeMs) || this.cursorMaxAgeMs < 1) throw new MobileSyncError('MOBILE_SYNC_REQUEST_INVALID')
  }

  /** Accept one authenticated sync request and return its acknowledgement.
   *
   * Refusals are deliberate and distinguishable: a cursor the server never issued is
   * refused as invalid, a cursor naming an unissued revision is refused as future, and
   * a cursor older than the configured lifetime is refused as invalid rather than
   * silently resuming from a position the server may no longer describe.
   * @param request - Untrusted cursor request from the participant.
   * @param heartbeat - Untrusted capability and liveness facts from the participant.
   * @returns The acknowledgement plus the outcome that explains its revision.
   */
  async sync(request: unknown, heartbeat: unknown): Promise<MobileSyncResult> {
    if (this.closed) throw new MobileSyncError('MOBILE_SYNC_CLOSED', 503)
    const parsed = parseRequest(request)
    const facts = parseHeartbeat(heartbeat, parsed)
    const entries = await this.store.list()
    const existing = entries.find(entry => entry.key === identityKey(parsed.identity))
    const currentRevision = existing?.revision ?? 0
    const storedCursor = existing?.lastCursor ?? MOBILE_SYNC_INITIAL_CURSOR
    const claimed = parseCursor(parsed.cursor, currentRevision)

    if (existing !== undefined) {
      if (claimed !== null) {
        // Resuming an issued cursor past its lifetime is refused: the server will not
        // silently continue from a position it may no longer be able to describe.
        if (this.expired(existing)) throw new MobileSyncError('MOBILE_SYNC_CURSOR_INVALID', 409)
        if (parsed.cursor === storedCursor) return { ack: existing.ack, outcome: 'replayed' }
        if (claimed < existing.revision) return { ack: existing.ack, outcome: 'stale-cursor' }
      } else if (parsed.cursor === storedCursor && !this.expired(existing)) {
        // An ordinary retry of the current cursor replays without consuming a revision.
        return { ack: existing.ack, outcome: 'replayed' }
      } else if (!this.expired(existing)) {
        // The server still holds a later cursor: this is the normal forward move.
        return { ack: existing.ack, outcome: 'stale-cursor' }
      }
      // Otherwise the participant restarted from the initial cursor while its issued
      // cursor is expired. That is the recovery path: issue a fresh cursor and a fresh
      // lifetime rather than leaving a long-offline phone locked out.
    }

    const revision = currentRevision + 1
    const ack = ackFor(parsed.identity, revision, facts)
    const committed = await this.store.commit(parsed.identity, {
      revision, lastCursor: parsed.cursor, issuedAt: this.now(), ack,
    })
    return { ack: committed.ack, outcome: committed.revision === revision ? 'advanced' : 'replayed' }
  }

  /** Current durable view of one participant, for owner-facing diagnostics.
   * @param identity - Participant to look up.
   * @returns The entry, or `null` when this participant has never synced.
   */
  async entry(identity: PlatformIdentity): Promise<MobileSyncEntry | null> {
    const entries = await this.store.list()
    const key = identityKey(identity)
    return entries.find(candidate => candidate.key === key) ?? null
  }

  /** Stop accepting requests before plugin disposal. */
  close(): void { this.closed = true }

  private expired(entry: MobileSyncEntry): boolean {
    return entry.issuedAt !== undefined && this.now() - entry.issuedAt > this.cursorMaxAgeMs
  }
}

function parseRequest(value: unknown): MobileSyncRequest {
  try { return parseMobileSyncRequest(value) }
  catch { throw new MobileSyncError('MOBILE_SYNC_REQUEST_INVALID') }
}

/** The heartbeat must describe the same participant as the request it travels with. */
function parseHeartbeat(value: unknown, request: MobileSyncRequest): MobileCapabilityHeartbeat {
  let facts: MobileCapabilityHeartbeat
  try { facts = parseMobileCapabilityHeartbeat(value) }
  catch { throw new MobileSyncError('MOBILE_SYNC_HEARTBEAT_INVALID') }
  if (identityKey(facts.identity) !== identityKey(request.identity)) throw new MobileSyncError('MOBILE_SYNC_HEARTBEAT_INVALID')
  return facts
}

/** Accept the initial cursor or an issued cursor; refuse everything else.
 *
 * `currentRevision` is the highest revision the server has durably accepted, so a
 * cursor naming a higher one is a client invention and is refused before any state
 * mutation, keeping the server from adopting progress it never issued.
 * @param cursor - Cursor text from the request.
 * @param currentRevision - Highest durably accepted revision for this participant.
 * @returns The named revision, or `null` when the text is the initial cursor.
 */
function parseCursor(cursor: string, currentRevision: number): number | null {
  if (cursor === MOBILE_SYNC_INITIAL_CURSOR) return null
  const revision = cursorRevision(cursor)
  if (revision === null) throw new MobileSyncError('MOBILE_SYNC_CURSOR_INVALID')
  if (revision > currentRevision) throw new MobileSyncError('MOBILE_SYNC_CURSOR_FUTURE', 409)
  return revision
}

/** Project one acknowledgement without contacting any transport, model or billing path.
 *
 * The server owns the revision, the cursor and the echo of the participant's
 * validated sequence. Capacity facts stay exactly as the participant reported them,
 * because this package holds no task authority to contradict them; `runningTasks` is
 * therefore an observation, never a settlement or scheduling decision.
 */
function ackFor(identity: PlatformIdentity, revision: number, facts: MobileCapabilityHeartbeat): MobileSyncAck {
  const cursor = cursorAt(identity, revision)
  return {
    version: MOBILE_SYNC_VERSION, identity, cursor, revision,
    heartbeat: { ...facts, identity, cursor },
  }
}
