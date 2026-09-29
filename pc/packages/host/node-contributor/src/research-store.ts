/** Private FULL-synchronous original-attempt journal; no account/device credentials are stored here. */
import { DatabaseSync } from 'node:sqlite'
import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { canonical, failure, parseLease, exact, integer, identifier, type ResearchLease } from './research-contract.ts'
/** Immutable outbound progress message, retained until its original ACK is reconciled. */
export interface ResearchEvent {
  readonly sequence: number
  readonly stage: 'accepted' | 'running' | 'outcome_unknown' | 'uploading' | 'failed' | 'cancelled'
  readonly backendJobId: string | null
}
/** Private original-attempt rights and delivery-only recovery state. */
export interface ResearchLocalRecord {
  readonly lease: ResearchLease
  readonly state: 'active' | 'unknown' | 'completed' | 'failed' | 'cancelled'
  readonly claimIssued: boolean
  readonly claimGranted: boolean
  readonly submitIssued: boolean
  readonly uploadIssued: boolean
  readonly backendJobId: string | null
  readonly result: { readonly sha256: string; readonly sizeBytes: number } | null
  readonly event: ResearchEvent | null
  readonly eventCounter: number
}
function localRecord(value: unknown): ResearchLocalRecord {
  const row = exact(value, ['lease', 'state', 'claimIssued', 'claimGranted', 'submitIssued', 'uploadIssued', 'backendJobId', 'result', 'event', 'eventCounter'])
  if (typeof row.state !== 'string' || !['active', 'unknown', 'completed', 'failed', 'cancelled'].includes(row.state)
    || typeof row.claimIssued !== 'boolean' || typeof row.claimGranted !== 'boolean' || typeof row.submitIssued !== 'boolean'
    || typeof row.uploadIssued !== 'boolean' || row.claimGranted && !row.claimIssued || row.submitIssued && !row.claimGranted
    || row.uploadIssued && !row.submitIssued) failure('RESEARCH_STORE_INVALID')
  let result: ResearchLocalRecord['result'] = null
  if (row.result !== null) {
    const r = exact(row.result, ['sha256', 'sizeBytes'])
    if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(r.sha256) || integer(r.sizeBytes, 1) > 67108864) failure('RESEARCH_STORE_INVALID')
    result = { sha256: r.sha256, sizeBytes: integer(r.sizeBytes, 1) }
  }
  let event: ResearchEvent | null = null
  if (row.event !== null) {
    const e = exact(row.event, ['sequence', 'stage', 'backendJobId'])
    if (typeof e.stage !== 'string' || !['accepted', 'running', 'outcome_unknown', 'uploading', 'failed', 'cancelled'].includes(e.stage)) failure('RESEARCH_STORE_INVALID')
    event = { sequence: integer(e.sequence, 1), stage: e.stage as ResearchEvent['stage'], backendJobId: e.backendJobId === null ? null : identifier(e.backendJobId) }
  }
  return { lease: parseLease(row.lease), state: row.state as ResearchLocalRecord['state'], claimIssued: row.claimIssued,
    claimGranted: row.claimGranted, submitIssued: row.submitIssued, uploadIssued: row.uploadIssued,
    backendJobId: row.backendJobId === null ? null : identifier(row.backendJobId), result, event, eventCounter: integer(row.eventCounter) }
}
async function privateDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory) || directory.split(/[\\/]/u).includes('..')) failure('RESEARCH_STORE_INVALID')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let current = parse(directory).root
  for (const part of directory.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part); const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) failure('RESEARCH_STORE_INVALID')
  }
  const stat = await lstat(directory)
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) failure('RESEARCH_STORE_INVALID')
}
/** Private bounded SQLite journal; each irreversible send is committed before transport. */
export class ResearchStore {
  private constructor(private readonly db: DatabaseSync, private readonly maximumRecords: number) {}
  /** Open the owner-private journal without credentials or symlink traversal. */
  static async open(directory: string, maximumRecords: number): Promise<ResearchStore> {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 4096) failure('RESEARCH_CONFIG_INVALID')
    await privateDirectory(directory)
    const path = join(directory, 'research-consumer.sqlite')
    try { const created = await open(path, 'wx', 0o600); try { await created.sync() } finally { await created.close() } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) failure('RESEARCH_STORE_INVALID')
    } finally { await handle.close() }
    const db = new DatabaseSync(path)
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version
      if (version !== 0 && version !== 1) failure('RESEARCH_STORE_VERSION_INVALID')
      db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cursors (device TEXT PRIMARY KEY,sequence INTEGER NOT NULL); PRAGMA user_version=1')
    }
    catch (error) { db.close(); throw error }
    return new ResearchStore(db, maximumRecords)
  }
  /** Read one original attempt without granting another execution. */
  get(attemptId: string): ResearchLocalRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM records WHERE id=?').get(attemptId)
    return row === undefined ? undefined : localRecord(JSON.parse(String(row.payload)) as unknown)
  }
  /** Persist a lease once; changed task, owner, device or input is refused. */
  accept(lease: ResearchLease): ResearchLocalRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const known = this.get(lease.attemptId)
      if (known !== undefined) {
        if (canonical(known.lease) !== canonical(lease)) failure('RESEARCH_ORIGINAL_CONFLICT')
        this.db.exec('COMMIT'); return known
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count
      if (typeof count !== 'number' || count >= this.maximumRecords) failure('RESEARCH_STORE_FULL')
      const value: ResearchLocalRecord = { lease, state: 'active', claimIssued: false, claimGranted: false, submitIssued: false,
        uploadIssued: false, backendJobId: null, result: null, event: null, eventCounter: 0 }
      this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(lease.attemptId, lease.taskId, lease.requestId, canonical(value), value.state)
      this.db.exec('COMMIT'); return value
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Commit monotonic submission, event and delivery observations. */
  update(attemptId: string, patch: Partial<Omit<ResearchLocalRecord, 'lease'>>): ResearchLocalRecord {
    const before = this.get(attemptId); if (before === undefined) failure('RESEARCH_STORE_INVALID')
    const value = localRecord({ ...before, ...patch })
    if (before.claimIssued && !value.claimIssued || before.claimGranted && !value.claimGranted || before.submitIssued && !value.submitIssued
      || before.uploadIssued && !value.uploadIssued || before.backendJobId !== null && before.backendJobId !== value.backendJobId
      || value.eventCounter < before.eventCounter) failure('RESEARCH_ORIGINAL_CONFLICT')
    this.db.prepare('UPDATE records SET payload=?,state=? WHERE id=?').run(canonical(value), value.state, attemptId)
    return value
  }
  /** Read the independent research inbox position for this stable device. */
  cursor(deviceId: string): number { return integer(this.db.prepare('SELECT sequence FROM cursors WHERE device=?').get(deviceId)?.sequence ?? 0) }
  /** Commit an inbox position only after every task is journaled. */
  advance(deviceId: string, sequence: number): void {
    if (sequence < this.cursor(deviceId)) failure('RESEARCH_CURSOR_INVALID')
    this.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(device) DO UPDATE SET sequence=excluded.sequence').run(deviceId, integer(sequence))
  }
  /** Read unresolved originals across account switches. */
  active(): readonly ResearchLocalRecord[] {
    return this.db.prepare("SELECT payload FROM records WHERE state NOT IN ('completed','failed','cancelled')").all().map(row => localRecord(JSON.parse(String(row.payload)) as unknown))
  }
  /** Protect submitted or unknown execution; an unclaimed queued lease is not GPU work. */
  busy(exceptAttempt?: string): boolean { return this.active().some(row => row.submitIssued && row.lease.attemptId !== exceptAttempt) }
  /** Close the private SQLite handle after its consumer drains. */
  close(): void { this.db.close() }
}
