/** Durable, atomically replaced mobile presentation state; never a task or ledger authority. */
import { open } from 'node:fs/promises'
import type { PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'
import { parseMobileSyncAck } from '@deepseek-ai/dsh-host-platform-observability-contract'
import { writePrivateAtomic } from './atomic-file.ts'
import { MOBILE_SYNC_STORE_VERSION, type MobileSyncEntry, type MobileSyncFile, type MobileSyncRecord } from './types.ts'
import { MobileSyncError } from './errors.ts'

/** Bounded storage settings for one deployment-owned private file. */
export interface MobileSyncStoreConfig {
  /** Absolute private path holding every participant record. */
  path: string
  /** Maximum retained participant records. */
  maxRecords: number
  /** Maximum accepted file size in bytes. */
  maxBytes: number
}

/** Private, atomically replaced per-identity cursor and revision state.
 *
 * The store owns no transport, model call or ledger operation. Every mutation runs
 * through one in-process promise chain so two concurrent sync requests cannot both
 * read revision N and then both decide to write N+1; the second observes the first
 * commit and returns the newer revision instead of a duplicate one.
 */
export class MobileSyncStore {
  private closed = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly pending = new Set<Promise<unknown>>()

  /** @param config - Absolute private path and deployment-owned capacity limits. */
  constructor(private readonly config: MobileSyncStoreConfig) {}

  /** Read every durable record; a missing file is an empty set, not an error.
   * @returns Validated entries in stable key order.
   */
  list(): Promise<MobileSyncEntry[]> { return this.enqueue(() => this.read()) }

  /** Durably commit one identity's next record and return what was stored.
   *
   * A replay of the currently accepted cursor is idempotent: the stored record is
   * returned with the same revision, so a retry cannot consume a second revision.
   * @param identity - Participant the record belongs to.
   * @param next - Record to store when this request advances the presentation.
   * @returns The stored record, which may be the pre-existing one on a replay.
   */
  /** Durably commit one identity's next record and return what was stored.
   *
   * The store writes what it is given. Deciding whether a request is a replay is the
   * service's job, because a recovery restart legitimately re-issues the same cursor
   * text at a new revision and must not be deduplicated away here.
   * @param identity - Participant the record belongs to.
   * @param next - Record to store.
   * @returns The stored record.
   */
  commit(identity: PlatformIdentity, next: MobileSyncRecord): Promise<MobileSyncRecord> {
    return this.enqueue(async () => {
      const entries = await this.read()
      const key = identityKey(identity)
      const existing = entries.find(entry => entry.key === key)
      if (existing === undefined && entries.length >= this.config.maxRecords) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
      const file: MobileSyncFile = {
        version: MOBILE_SYNC_STORE_VERSION,
        records: Object.fromEntries([
          ...entries.map(entry => [entry.key, toRecord(entry)] as const),
          [key, next] as const,
        ]),
      }
      const content = JSON.stringify(file)
      if (Buffer.byteLength(content) > this.config.maxBytes) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
      await writePrivateAtomic(this.config.path, content, () => new MobileSyncError('MOBILE_SYNC_STORE_UNAVAILABLE', 503))
      return next
    })
  }

  /** Drop one identity's durable record, leaving other participants untouched.
   * @param identity - Participant to forget.
   */
  forget(identity: PlatformIdentity): Promise<void> {
    return this.enqueue(async () => {
      const entries = await this.read()
      const key = identityKey(identity)
      const records = Object.fromEntries(entries
        .filter(entry => entry.key !== key)
        .map(entry => [entry.key, toRecord(entry)] as const))
      await writePrivateAtomic(
        this.config.path,
        JSON.stringify({ version: MOBILE_SYNC_STORE_VERSION, records } satisfies MobileSyncFile),
        () => new MobileSyncError('MOBILE_SYNC_STORE_UNAVAILABLE', 503),
      )
    })
  }

  /** Stop new operations and drain accepted writes before plugin disposal. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MobileSyncError('MOBILE_SYNC_CLOSED', 503))
    const run = this.tail.then(operation, operation)
    this.tail = run.catch(() => undefined)
    this.pending.add(run)
    void run.finally(() => this.pending.delete(run)).catch(() => undefined)
    return run
  }

  private async read(): Promise<MobileSyncEntry[]> {
    let text: string
    try {
      const handle = await open(this.config.path, 'r')
      try {
        if ((await handle.stat()).size > this.config.maxBytes) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
        text = await handle.readFile({ encoding: 'utf8' })
      } finally { await handle.close() }
    } catch (error) {
      if (error instanceof MobileSyncError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new MobileSyncError('MOBILE_SYNC_STORE_UNAVAILABLE', 503)
    }
    return parseFile(text, this.config.maxRecords)
  }
}

/** Storage key for one participant; matches the directory's `kind\0id` convention. */
export function identityKey(identity: PlatformIdentity): string {
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(identity.id)) throw new MobileSyncError('MOBILE_SYNC_REQUEST_INVALID')
  return `${identity.kind}\u0000${identity.id}`
}

function parseFile(text: string, maxRecords: number): MobileSyncEntry[] {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
  const file = value as { version?: unknown; records?: unknown }
  if (file.version !== MOBILE_SYNC_STORE_VERSION) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
  if (typeof file.records !== 'object' || file.records === null || Array.isArray(file.records)) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
  const records = file.records as Record<string, unknown>
  const keys = Object.keys(records)
  if (keys.length > maxRecords) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
  return keys.map((key) => {
    const [kind, id] = key.split('\u0000')
    if ((kind !== 'agent' && kind !== 'node' && kind !== 'device') || id === undefined) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
    const raw = records[key]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
    const record = raw as { revision?: unknown; lastCursor?: unknown; issuedAt?: unknown; ack?: unknown }
    if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
    if (typeof record.lastCursor !== 'string') throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
    if (record.issuedAt !== undefined && (!Number.isSafeInteger(record.issuedAt) || (record.issuedAt as number) < 0)) throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503)
    let ack
    try { ack = parseMobileSyncAck(record.ack) } catch { throw new MobileSyncError('MOBILE_SYNC_STORE_INVALID', 503) }
    return {
      key, identity: { kind, id } as PlatformIdentity, revision: record.revision as number,
      lastCursor: record.lastCursor, ack,
      ...(record.issuedAt === undefined ? {} : { issuedAt: record.issuedAt as number }),
    }
  })
}

/** Drop derived fields so a rewrite cannot persist read-only additions. */
function toRecord(entry: MobileSyncEntry): MobileSyncRecord {
  return {
    revision: entry.revision, lastCursor: entry.lastCursor, ack: entry.ack,
    ...(entry.issuedAt === undefined ? {} : { issuedAt: entry.issuedAt }),
  }
}
