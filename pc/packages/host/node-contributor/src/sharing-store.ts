/** Private SQLite settings, immutable attempt admissions and node-event outbox. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SharingAPIObservation, SharingAPIProbe, SharingAction, SharingAttempt, SharingAuthorization, SharingConsent,
  SharingMode, SharingModeState,
  SharingOperation, SharingSigned } from './sharing-types.ts'
import { sharingCanonical, sharingDigest, sharingFail, sharingObject } from './sharing-protocol.ts'

/** Create/check a canonical private directory without following links.
 * @param path - Host-owned absolute path, never a renderer path.
 * @returns Completion after ordinary directory and owner checks.
 */
export async function sharingDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0') || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(
    path)) sharingFail('STORE_INVALID')
  let current = parse(path).root
  for (const part of path.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) sharingFail('STORE_INVALID')
  }
  const stat = await lstat(path)
  const same = process.platform === 'win32' ? (await realpath(path)).toLowerCase() === path.toLowerCase() : await realpath(path) === path
  if (!same || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) sharingFail('STORE_INVALID')
}
/** Persist one owner-only metadata file with fsync and atomic rename.
 * @param path - Private destination below an already checked root.
 * @param bytes - Exact bounded metadata, no ambient secrets.
 * @returns Completion once the new name is durable on the local filesystem.
 */
export async function sharingWrite(path: string, bytes: Uint8Array): Promise<void> {
  await sharingDirectory(dirname(path))
  const old = await lstat(path).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e })
  if (old && (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1)) sharingFail('STORE_INVALID')
  const temporary = path + '.' + randomUUID() + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  try {
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const parent = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await parent.sync() } finally { await parent.close() }
    }
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
}
/** Read an ordinary owner-only metadata file under a fixed byte limit.
 * @param path - Private metadata path.
 * @param maxBytes - Bound including the complete wrapper.
 * @returns Exact bytes; links, foreign ownership and oversized contents are refused.
 */
export async function sharingRead(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes
      || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) sharingFail('STORE_INVALID')
    return await file.readFile()
  } finally { await file.close() }
}
/** An unconfigured or paused mode has no fabricated calls, money, progress or model.
 * @param mode - Image or video mode identifier.
 * @returns Idle projection with unknown statistics.
 */
export function initialSharingMode(mode: SharingMode): SharingModeState {
  return { mode, phase: 'idle', operationId: null, modelName: null, downloadedBytes: null, totalDownloadBytes: null,
    completedSteps: [], reason: null, completedCalls: null, settledYuan: null }
}
interface ModeRecord { desired: boolean; state: SharingModeState; manifest: SharingSigned | null }
const APP_ID = 0x5153434d
const SCHEMA_VERSION = 2
const PERMISSION_SCHEMA = `CREATE TABLE permissions(owner TEXT NOT NULL,device_id TEXT NOT NULL,mode TEXT NOT NULL,
  version TEXT NOT NULL,connection INTEGER NOT NULL,execution TEXT NOT NULL,revoked INTEGER NOT NULL,
  request_id TEXT NOT NULL,confirmed_at INTEGER NOT NULL,PRIMARY KEY(owner,device_id,mode)) STRICT;
  CREATE TABLE operation_details(owner TEXT NOT NULL,request_id TEXT NOT NULL,intent_sha256 TEXT NOT NULL,
    PRIMARY KEY(owner,request_id),FOREIGN KEY(owner,request_id) REFERENCES operations(owner,request_id)) STRICT;`
const ACTIVE = "state NOT IN ('settled','rejected')"
const STEPS = ['detect', 'download', 'install', 'api', 'connect', 'persist', 'earnings'] as const
function normalizeSteps(steps: unknown): readonly string[] {
  if (!Array.isArray(steps)) sharingFail('STORE_INVALID')
  const values: readonly unknown[] = steps
  const completed = new Set<string>()
  for (const step of values) {
    if (typeof step !== 'string') sharingFail('STORE_INVALID')
    if (step === 'match') continue
    const canonical = step === 'hardware' ? 'detect' : step
    if (!STEPS.some(allowed => allowed === canonical)) sharingFail('STORE_INVALID')
    completed.add(canonical)
  }
  return STEPS.filter(step => completed.has(step))
}

/** One Host-home journal preserves unresolved attempts across account switches and restarts. */
export class SharingStore {
  private constructor(private readonly db: DatabaseSync) {}
  /** Open an existing validated journal or exclusively establish the new format.
   * @param root - Fixed local Host root; a missing previously established database is refused.
   * @returns The shared store, with SQLite enforcing the single active GPU attempt.
   */
  static async open(root: string): Promise<SharingStore> {
    await sharingDirectory(root)
    const path = join(root, 'control.sqlite')
    const marker = join(root, 'established.v1')
    let fresh = false
    let exists = await lstat(path).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e })
    if (exists === null) {
      if (await lstat(marker).then(() => true, (e: unknown) => (e as NodeJS.ErrnoException).code !== 'ENOENT')) sharingFail('STORE_INVALID')
      const file = await open(path, 'wx', 0o600); await file.sync(); await file.close(); fresh = true
      exists = await lstat(path)
    }
    if (!exists.isFile() || exists.isSymbolicLink() || exists.nlink !== 1
      || process.getuid && (exists.uid !== process.getuid() || (exists.mode & 0o077) !== 0)) sharingFail('STORE_INVALID')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      if (fresh) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE modes(owner TEXT NOT NULL,mode TEXT NOT NULL,desired INTEGER NOT NULL,state_json TEXT NOT NULL,
            manifest_json TEXT,PRIMARY KEY(owner,mode)) STRICT;
          CREATE TABLE operations(owner TEXT NOT NULL,request_id TEXT NOT NULL,mode TEXT NOT NULL,action TEXT NOT NULL,
            PRIMARY KEY(owner,request_id)) STRICT;
          CREATE TABLE attempts(task_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,
            mode TEXT NOT NULL,state TEXT NOT NULL,fingerprint TEXT NOT NULL,record_json TEXT NOT NULL) STRICT;
          CREATE UNIQUE INDEX sole_gpu ON attempts((1)) WHERE ${ACTIVE};
          CREATE TABLE events(attempt_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,
            acked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(attempt_id,sequence)) STRICT;
          ${PERMISSION_SCHEMA}
          PRAGMA application_id=${APP_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
        await sharingWrite(marker, sharingCanonical({ schema: 'qianshou.compute-sharing-store.v1', version: SCHEMA_VERSION }))
      }
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      if (Number(db.prepare('PRAGMA application_id').get()?.application_id) !== APP_ID
        || ![1, SCHEMA_VERSION].includes(version)
        || db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') sharingFail('STORE_INVALID')
      const saved = JSON.parse((await sharingRead(marker, 1024)).toString('utf8')) as unknown
      const matches = (expected: number): boolean => sharingDigest(saved) === sharingDigest({
        schema: 'qianshou.compute-sharing-store.v1', version: expected })
      if (!matches(version) && !(version === SCHEMA_VERSION && matches(1))) sharingFail('STORE_INVALID')
      if (version === 1) {
        db.exec(`BEGIN IMMEDIATE; ${PERMISSION_SCHEMA} PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`)
      }
      // Recover only the known marker lag after the committed additive v1-to-v2 migration.
      db.prepare('SELECT owner,device_id,mode,version,connection,execution,revoked,request_id,confirmed_at FROM permissions LIMIT 0').all()
      db.prepare('SELECT owner,request_id,intent_sha256 FROM operation_details LIMIT 0').all()
      if (!matches(SCHEMA_VERSION)) await sharingWrite(marker, sharingCanonical({ schema: 'qianshou.compute-sharing-store.v1',
        version: SCHEMA_VERSION }))
      // Additive read-only metadata outbox; it grants no admission, execution or settlement right.
      db.exec(`CREATE TABLE IF NOT EXISTS api_probe_receipts(owner TEXT NOT NULL,request_id TEXT NOT NULL,
        device_id TEXT NOT NULL,connection_epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        probe_json TEXT NOT NULL,observation_json TEXT NOT NULL,status TEXT,confirmed_at TEXT,
        PRIMARY KEY(owner,request_id)) STRICT;`)
      return new SharingStore(db)
    } catch (error) { db.close(); throw error }
  }
  /** Persist one original metadata response before its first POST; retries retain the same observation.
   * @param owner - Current private account scope.
   * @param device - Current private device identity.
   * @param probe - The exact already delivered UUID/epoch.
   * @param observation - Fixed local GET result, ignored on an identical replay.
   * @returns Original durable observation and any already acknowledged result.
   */
  apiProbeReceipt(owner: string, device: string, probe: SharingAPIProbe, observation: SharingAPIObservation): {
    observation: SharingAPIObservation
    status: 'confirmed' | 'failed' | null
    confirmedAt: string | null
  } {
    const original = this.db.prepare('SELECT * FROM api_probe_receipts WHERE owner=? AND request_id=?').get(owner, probe.requestId)
    if (original !== undefined) {
      if (original.device_id !== device || original.connection_epoch !== probe.epoch
        || original.probe_json !== sharingCanonical(probe).toString()) sharingFail('REQUEST_CONFLICT')
      const saved = JSON.parse(String(original.observation_json)) as SharingAPIObservation
      if (saved.mode !== probe.mode) sharingFail('STORE_INVALID')
      return { observation: saved, status: original.status === null ? null : original.status === 'confirmed' ? 'confirmed' : 'failed',
        confirmedAt: original.confirmed_at === null ? null : String(original.confirmed_at) }
    }
    this.db.prepare('DELETE FROM api_probe_receipts WHERE expires_at < ?').run(Date.now() - 60000)
    if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM api_probe_receipts').get()?.n) >= 256) sharingFail('STORE_INVALID')
    this.db.prepare('INSERT INTO api_probe_receipts(owner,request_id,device_id,connection_epoch,expires_at,probe_json,observation_json) VALUES(?,?,?,?,?,?,?)')
      .run(owner, probe.requestId, device, probe.epoch, Date.parse(probe.expiresAt),
        sharingCanonical(probe).toString(), sharingCanonical(observation).toString())
    return { observation, status: null, confirmedAt: null }
  }
  /** Mark only an exact gateway acknowledgement; no GPU task or financial record is changed.
   * @param owner - Original response account.
   * @param requestId - Original already persisted challenge UUID.
   * @param status - Confirmed/failed actual gateway receipt.
   * @param confirmedAt - Gateway confirmation timestamp, or null on failure.
   * @returns Nothing.
   */
  ackAPIProbe(owner: string, requestId: string, status: 'confirmed' | 'failed', confirmedAt: string | null): void {
    if (this.db.prepare('UPDATE api_probe_receipts SET status=?,confirmed_at=? WHERE owner=? AND request_id=?')
      .run(status, confirmedAt, owner, requestId).changes !== 1) sharingFail('STORE_INVALID')
  }
  /** Read only one authenticated owner's saved mode.
   * @param owner - Current authenticated numeric account string.
   * @param mode - Product mode.
   * @returns Saved settings, or an idle mode with unknown earnings.
   */
  mode(owner: string, mode: SharingMode): ModeRecord {
    const row = this.db.prepare('SELECT * FROM modes WHERE owner=? AND mode=?').get(owner, mode)
    if (row === undefined) return { desired: false, state: initialSharingMode(mode), manifest: null }
    const saved = JSON.parse(String(row.state_json)) as SharingModeState
    return { desired: row.desired === 1, state: { ...saved, completedSteps: normalizeSteps(saved.completedSteps) },
      manifest: row.manifest_json === null ? null : JSON.parse(String(row.manifest_json)) as SharingSigned }
  }
  /** Commit progress or a saved official package; desired intent changes only through command().
   * @param owner - Current account namespace.
   * @param mode - Product mode.
   * @param patch - Observed redacted state.
   * @param manifest - Optional original independently authenticated package envelope.
   * @returns Nothing; SQLite synchronously commits the mode observation.
   */
  updateMode(owner: string, mode: SharingMode, patch: Partial<SharingModeState>, manifest?: SharingSigned): void {
    const old = this.mode(owner, mode)
    const state = { ...old.state, ...patch, mode,
      completedSteps: normalizeSteps([...old.state.completedSteps, ...patch.completedSteps ?? []]) }
    this.db.prepare('INSERT INTO modes VALUES(?,?,?,?,?) ON CONFLICT(owner,mode) DO UPDATE SET state_json=excluded.state_json,manifest_json=excluded.manifest_json')
      .run(owner, mode, old.desired ? 1 : 0, sharingCanonical(state).toString(),
        manifest === undefined ? old.manifest === null ? null : sharingCanonical(old.manifest).toString(
        ) : sharingCanonical(manifest).toString())
  }
  /** Apply an owner+UUID action once; reusing its ID for different intent is refused.
   * @param owner - Authenticated account, never a request body value.
   * @param mode - Image or video.
   * @param action - Enable, pause or resume new intake.
   * @param requestId - Canonical client operation UUID.
   * @returns False for the same previously committed action, true after new intent is durable.
   */
  command(owner: string, mode: SharingMode, action: 'enable' | 'pause' | 'resume', requestId: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const old = this.db.prepare('SELECT mode,action FROM operations WHERE owner=? AND request_id=?').get(owner, requestId)
      if (old !== undefined) {
        if (old.mode !== mode || old.action !== action) sharingFail('REQUEST_CONFLICT')
        this.db.exec('COMMIT'); return false
      }
      const record = this.mode(owner, mode)
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(owner, requestId, mode, action)
      this.db.prepare(
        'INSERT INTO modes VALUES(?,?,?,?,?) ON CONFLICT(owner,mode) DO UPDATE SET desired=excluded.desired,state_json=excluded.state_json')
        .run(owner, mode, action === 'pause' ? 0 : 1, sharingCanonical({ ...record.state, operationId: requestId,
          phase: action === 'pause' ? 'paused' : 'detecting', reason: null }).toString(),
        record.manifest === null ? null : sharingCanonical(record.manifest).toString())
      this.db.exec('COMMIT'); return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Read only this owner/device's explicit media permission, independently of legacy service grants.
   * @param owner - Authenticated account namespace.
   * @param deviceId - Private prepared device identity; unavailable identity cannot grant permission.
   * @param mode - Selected image/video mode.
   * @returns Redacted exact-device permission state.
   */
  authorization(owner: string, deviceId: string | null, mode: SharingMode): SharingAuthorization {
    if (deviceId === null) return { connection: 'required', execution: 'disabled', deviceBound: false }
    const row = this.db.prepare('SELECT * FROM permissions WHERE owner=? AND device_id=? AND mode=?').get(owner, deviceId, mode)
    if (row === undefined) return { connection: 'required', execution: 'disabled', deviceBound: false }
    if (row.version !== 'qianshou.media-sharing-consent.v1' || ![0, 1].includes(Number(row.connection))
      || ![0, 1].includes(Number(row.revoked)) || !['disabled', 'idle_only'].includes(String(row.execution))) sharingFail('STORE_INVALID')
    const granted = row.connection === 1 && row.revoked === 0
    return { connection: granted ? 'granted' : 'revoked', execution: granted
      ? row.execution as SharingAuthorization['execution'] : 'disabled', deviceBound: true }
  }
  /** Atomically save explicit device-bound consent and intent; one UUID cannot change its meaning.
   * @param owner - Authenticated Host account, never supplied by the renderer.
   * @param deviceId - Prepared private device identity bound to that owner.
   * @param mode - Selected mode only; other modes and legacy policy remain untouched.
   * @param action - Confirmed enable/resume or explicit pause/revocation.
   * @param requestId - Stable canonical operation UUID.
   * @param scopeId - The exact current UI owner scope observed before confirmation.
   * @param consent - Required versioned connection/execution permission for enable/resume.
   * @returns False only for an exact already committed operation.
   */
  authorizedCommand(owner: string, deviceId: string, mode: SharingMode, action: SharingAction, requestId: string,
    scopeId: string, consent?: SharingConsent): boolean {
    const enabling = action === 'enable' || action === 'resume'
    const grant = consent === undefined ? null : sharingObject(consent)
    if (enabling && (grant === null || grant.version !== 'qianshou.media-sharing-consent.v1' || grant.connection !== true
      || !['disabled', 'idle_only'].includes(String(grant.execution)))) sharingFail('CONSENT_REQUIRED')
    const fingerprint = sharingDigest({ owner, deviceId, mode, action, scopeId, consent: consent ?? null })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.db.prepare('SELECT intent_sha256 FROM operation_details WHERE owner=? AND request_id=?').get(owner, requestId)
      const old = this.db.prepare('SELECT mode,action FROM operations WHERE owner=? AND request_id=?').get(owner, requestId)
      if (old !== undefined) {
        if (old.mode !== mode || old.action !== action || prior?.intent_sha256 !== fingerprint) sharingFail('REQUEST_CONFLICT')
        this.db.exec('COMMIT'); return false
      }
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(owner, requestId, mode, action)
      this.db.prepare('INSERT INTO operation_details VALUES(?,?,?)').run(owner, requestId, fingerprint)
      if (enabling && consent !== undefined) this.db.prepare(`INSERT INTO permissions VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner,device_id,mode) DO UPDATE SET version=excluded.version,connection=1,execution=excluded.execution,
        revoked=0,request_id=excluded.request_id,confirmed_at=excluded.confirmed_at`).run(owner, deviceId, mode,
        consent.version, 1, consent.execution, 0, requestId, Date.now())
      if (action === 'revoke') this.db.prepare('UPDATE permissions SET connection=0,execution=?,revoked=1 WHERE owner=? AND mode=?')
        .run('disabled', owner, mode)
      const record = this.mode(owner, mode)
      this.db.prepare(`INSERT INTO modes VALUES(?,?,?,?,?) ON CONFLICT(owner,mode) DO UPDATE
        SET desired=excluded.desired,state_json=excluded.state_json`).run(owner, mode, enabling ? 1 : 0,
        sharingCanonical({ ...record.state, operationId: requestId, phase: enabling ? 'detecting' : 'paused', reason: null }).toString(),
        record.manifest === null ? null : sharingCanonical(record.manifest).toString())
      this.db.exec('COMMIT'); return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Reconcile a retained UUID through current-owner GET without recreating write permission.
   * @param owner - Current authenticated account namespace.
   * @param requestId - Original operation UUID.
   * @returns Applied original tuple or an explicit not-found observation.
   */
  operation(owner: string, requestId: string): SharingOperation {
    const row = this.db.prepare('SELECT mode,action FROM operations WHERE owner=? AND request_id=?').get(owner, requestId)
    return row === undefined ? { requestId, mode: null, action: null, status: 'not_found' }
      : { requestId, mode: row.mode as SharingMode, action: row.action as SharingAction, status: 'applied' }
  }
  /** Account exit revokes its future media intake; original attempts and outbox remain unchanged.
   * @param owner - The departing authenticated scope.
   * @returns Nothing after durable revocation; legacy policies are not accessed.
   */
  revokeOwner(owner: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE permissions SET connection=0,execution=?,revoked=1 WHERE owner=?').run('disabled', owner)
      for (const mode of ['image', 'video'] as const) {
        const record = this.mode(owner, mode)
        if (record.desired) this.db.prepare('UPDATE modes SET desired=0,state_json=? WHERE owner=? AND mode=?')
          .run(sharingCanonical({ ...record.state, phase: 'paused', reason: null }).toString(), owner, mode)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Read retained attempts globally for occupancy or only within an authenticated owner.
   * @param owner - Optional owner filter; omission is Host-only occupancy inspection.
   * @returns Nonterminal attempts without executing or clearing them.
   */
  active(owner?: string): SharingAttempt[] {
    const rows = owner === undefined ? this.db.prepare(`SELECT record_json FROM attempts WHERE ${ACTIVE}`).all()
      : this.db.prepare(`SELECT record_json FROM attempts WHERE ${ACTIVE} AND owner=?`).all(owner)
    return rows.map(r => JSON.parse(String(r.record_json)) as SharingAttempt)
  }
  /** Look up a task only in its owner's namespace.
   * @param owner - Authenticated owner.
   * @param taskId - Original workload ID.
   * @returns Original immutable attempt or null.
   */
  attempt(owner: string, taskId: string): SharingAttempt | null {
    const row = this.db.prepare('SELECT record_json FROM attempts WHERE owner=? AND task_id=?').get(owner, taskId)
    return row === undefined ? null : JSON.parse(String(row.record_json)) as SharingAttempt
  }
  /** Reserve the single device slot atomically before returning a delivery acknowledgement.
   * @param record - Independently signature-verified original task and output identity.
   * @returns Original record on an exact replay; changed lease/spec and occupied GPUs refuse.
   */
  admit(record: SharingAttempt): SharingAttempt {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.db.prepare('SELECT fingerprint,record_json FROM attempts WHERE task_id=?').get(record.task.taskId)
      const hash = sharingDigest({ owner: record.owner, task: record.task })
      if (prior !== undefined) {
        if (prior.fingerprint !== hash) sharingFail('ATTEMPT_CONFLICT')
        this.db.exec('COMMIT'); return JSON.parse(String(prior.record_json)) as SharingAttempt
      }
      if (this.active().length !== 0) sharingFail('BUSY')
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)').run(record.task.taskId, record.task.attemptId,
        record.owner, record.mode,
        record.state, hash, sharingCanonical(record).toString())
      this.db.exec('COMMIT'); return record
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Freeze the transition preceding an external side effect; task identities cannot be changed.
   * @param current - Original retained attempt.
   * @param state - New state; only admitted permits the first runtime POST.
   * @param result - Optional immutable output metadata.
   * @returns Updated journal record.
   */
  transition(current: SharingAttempt, state: SharingAttempt['state'], result?: SharingAttempt['result']): SharingAttempt {
    const latest = this.attempt(current.owner, current.task.taskId)
    if (latest === null || latest.task.attemptId !== current.task.attemptId) sharingFail('ATTEMPT_CONFLICT')
    if (['settled', 'rejected'].includes(latest.state) && state !== latest.state) sharingFail('ATTEMPT_CONFLICT')
    if (latest.result !== null && result !== undefined && result !== null && sharingDigest(latest.result) !== sharingDigest(
      result)) sharingFail('RESULT_CONFLICT')
    const record = { ...latest, state, result: result === undefined ? latest.result : result }
    this.db.prepare('UPDATE attempts SET state=?,record_json=? WHERE task_id=? AND attempt_id=?')
      .run(state, sharingCanonical(record).toString(), current.task.taskId, current.task.attemptId)
    return record
  }
  /** Claim the first runtime POST across simultaneous store handles before its side effect.
   * @param current - Immutable admitted attempt.
   * @returns True only for the single committed submit owner; unknown/running attempts stay read-only.
   */
  claimSubmission(current: SharingAttempt): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const latest = this.attempt(current.owner, current.task.taskId)
      if (latest === null || latest.task.attemptId !== current.task.attemptId) sharingFail('ATTEMPT_CONFLICT')
      if (latest.state !== 'admitted') { this.db.exec('COMMIT'); return false }
      this.db.prepare('UPDATE attempts SET state=?,record_json=? WHERE task_id=? AND state=?')
        .run('submitting', sharingCanonical({ ...latest, state: 'submitting' }).toString(), current.task.taskId, 'admitted')
      this.db.exec('COMMIT'); return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Claim one result upload across store handles; unknown writes never receive a second PUT right.
   * @param current - Original generated result.
   * @returns True only when the immutable upload intent changes from generated to uploading.
   */
  claimUpload(current: SharingAttempt): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const latest = this.attempt(current.owner, current.task.taskId)
      if (latest === null || latest.task.attemptId !== current.task.attemptId) sharingFail('ATTEMPT_CONFLICT')
      if (latest.state !== 'generated') { this.db.exec('COMMIT'); return false }
      this.db.prepare('UPDATE attempts SET state=?,record_json=? WHERE task_id=? AND state=?')
        .run('uploading', sharingCanonical({ ...latest, state: 'uploading' }).toString(), current.task.taskId, 'generated')
      this.db.exec('COMMIT'); return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Persist an immutable node event before transmission.
   * @param current - Owning original attempt.
   * @param stage - Observed executor stage, never verified/completed.
   * @param extra - Artifact metadata or actual percent only.
   * @returns The sequence-bound event ready for idempotent delivery.
   */
  event(current: SharingAttempt, stage: string, extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const latest = this.attempt(current.owner, current.task.taskId)
      if (latest === null) sharingFail('ATTEMPT_CONFLICT')
      const payload = { taskId: current.task.taskId, attemptId: current.task.attemptId, leaseEpoch: current.task.leaseEpoch,
        sequence: latest.eventSequence + 1, stage, ...extra }
      this.db.prepare('INSERT INTO events(attempt_id,sequence,payload) VALUES(?,?,?)')
        .run(current.task.attemptId, payload.sequence, sharingCanonical(payload).toString())
      this.db.prepare('UPDATE attempts SET record_json=? WHERE task_id=?')
        .run(sharingCanonical({ ...latest, eventSequence: payload.sequence }).toString(), current.task.taskId)
      this.db.exec('COMMIT'); return payload
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Read unacknowledged exact events in original sequence order.
   * @param attemptId - Persisted original attempt.
   * @returns Immutable replay commands; response loss does not assign a new sequence.
   */
  events(attemptId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT payload FROM events WHERE attempt_id=? AND acked=0 ORDER BY sequence').all(attemptId)
      .map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
  }
  /** Confirm a successfully matched gateway acknowledgement.
   * @param attemptId - Original attempt.
   * @param sequence - Exact event sequence acknowledged by Guangzhou.
   * @returns Nothing; the command is retained as acknowledged history.
   */
  ack(attemptId: string, sequence: number): void { this.db.prepare(
    'UPDATE events SET acked=1 WHERE attempt_id=? AND sequence=?').run(attemptId, sequence) }
  /** Close only this store handle; durable records are preserved. */
  close(): void { this.db.close() }
}
