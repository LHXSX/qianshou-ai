/** Owner-private Windows video trial submission journal; no resident lease or publication is inferred. */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, existsSync, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, resolve } from 'node:path'
import { ComputeError } from './errors.ts'

const APPLICATION_ID = 0x51535654
const VERSION = 1
const MAX_RECORD_BYTES = 4096
const HASH = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const KEYS = 'approvalSha256,attemptId,contractDigest,dependencyManifestSha256,graphSha256,inputSha256,ownerId,profileId,promptId,resultSha256,runnerSourceSha256,runtimeWitnessSha256,schema,state,trialKey'
const TRIALS_DDL = `CREATE TABLE trials (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_key TEXT NOT NULL UNIQUE,
  approval_sha256 TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL
) STRICT`

/** Identity the Host must derive from a current owner approval and an exact local installation. */
export interface ComfyVideoLocalTrialBinding {
  readonly ownerId: string
  readonly profileId: string
  readonly trialKey: string
  readonly approvalSha256: string
  readonly graphSha256: string
  readonly contractDigest: string
  readonly dependencyManifestSha256: string
  readonly runnerSourceSha256: string
  readonly runtimeWitnessSha256: string
  readonly inputSha256: string
}

/** Local-only attempt; completed MP4 verification does not confer market approval or supply. */
export interface ComfyVideoLocalTrialRecord extends ComfyVideoLocalTrialBinding {
  readonly schema: 'qianshou.comfy-video-local-trial.v1'
  readonly attemptId: string
  readonly promptId: string | null
  readonly resultSha256: string | null
  readonly state: 'reserved' | 'submitting' | 'submitted' | 'local-verified' | 'abandoned'
}

function invalid(): never { throw new ComputeError('COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_INVALID', 409) }
function storageInvalid(): never { throw new ComputeError('COMPUTE_COMFY_VIDEO_LOCAL_TRIAL_STORAGE_UNVERIFIED', 503) }

function physicalName(path: string): string { return resolve(path).replace(/^\\\\\?\\/u, '').toLowerCase() }

/** Existing parent components must resolve to their literal local path, not a junction or symlink. */
function assertOrdinaryAncestry(path: string): void {
  let current = dirname(path)
  for (;;) {
    if (existsSync(current)) {
      try {
        const named = lstatSync(current)
        if (!named.isDirectory() || named.isSymbolicLink()
          || physicalName(realpathSync.native(current)) !== physicalName(current)) storageInvalid()
      } catch { storageInvalid() }
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Reject a remote or non-NTFS volume before any database creation or open on Windows. */
function assertLocalNtfs(path: string): void {
  if (process.platform !== 'win32') return
  if (!/^[A-Za-z]:[\\/]/u.test(path)) storageInvalid()
  assertOrdinaryAncestry(path)
  try {
    let parent = dirname(path)
    while (!existsSync(parent)) {
      const next = dirname(parent)
      if (next === parent) storageInvalid()
      parent = next
    }
    const physicalParent = realpathSync.native(parent)
    const script = "$v=Get-Volume -FilePath $env:QIANSHOU_LOCAL_TRIAL_VOLUME_PATH -ErrorAction Stop; if ($v.FileSystem -ne 'NTFS' -or $v.DriveType -ne 'Fixed') { exit 3 }; [Console]::Out.Write('NTFS_FIXED')"
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, QIANSHOU_LOCAL_TRIAL_VOLUME_PATH: physicalParent },
    })
    if (result !== 'NTFS_FIXED') storageInvalid()
  } catch { storageInvalid() }
}

async function assertOrdinaryFile(path: string, allowMissing: boolean): Promise<void> {
  const named = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === 'ENOENT') return null
    return storageInvalid()
  })
  if (named && (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
    || process.getuid && (named.uid !== process.getuid() || (named.mode & 0o077) !== 0))) storageInvalid()
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, ' ').replace(/\s*([(),])\s*/gu, '$1')
}

function verifySchema(db: DatabaseSync): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='trials'").get()
  if (typeof table?.sql !== 'string' || normalizedSql(table.sql) !== normalizedSql(TRIALS_DDL)
    || db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='trials' LIMIT 1").get()) storageInvalid()
  const columns = db.prepare('PRAGMA table_info(trials)').all()
  const expected: readonly (readonly [string, string, number, number])[] = [
    ['seq', 'INTEGER', 0, 1], ['trial_key', 'TEXT', 1, 0], ['approval_sha256', 'TEXT', 1, 0],
    ['attempt_id', 'TEXT', 1, 0],
    ['record_json', 'TEXT', 1, 0],
  ]
  if (columns.length !== expected.length || columns.some((column, index) => {
    const field = expected[index]
    return !field || Number(column.cid) !== index || column.name !== field[0] || column.type !== field[1]
      || Number(column.notnull) !== field[2] || Number(column.pk) !== field[3] || column.dflt_value !== null
  })) storageInvalid()
  const indexes = db.prepare('PRAGMA index_list(trials)').all()
  if (indexes.length !== 3) storageInvalid()
  const signatures = indexes.map((index) => {
    if (typeof index.name !== 'string' || !/^sqlite_autoindex_trials_[123]$/u.test(index.name)
      || Number(index.unique) !== 1 || index.origin !== 'u' || Number(index.partial) !== 0) storageInvalid()
    const fields = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name)
    if (fields.some(field => typeof field.name !== 'string')) storageInvalid()
    return fields.map(field => field.name).join(',')
  }).sort()
  if (signatures.join('|') !== 'approval_sha256|attempt_id|trial_key') storageInvalid()
}

/** One-time setup into a new dedicated directory; interruption leaves that directory for operator review. */
export async function provisionComfyVideoLocalTrialLedger(path: string): Promise<void> {
  if (!isAbsolute(path)) storageInvalid()
  assertLocalNtfs(path)
  const parent = dirname(path)
  const ancestor = await lstat(dirname(parent)).catch(() => storageInvalid())
  if (!ancestor.isDirectory() || ancestor.isSymbolicLink()
    || process.getuid && (ancestor.uid !== process.getuid() || (ancestor.mode & 0o077) !== 0)) storageInvalid()
  try { await mkdir(parent, { mode: 0o700 }) }
  catch { storageInvalid() }
  // Provisioning also uses a path-based SQLite open; this directory must be ACL-protected
  // against another process replacing an ancestor between the checks and file creation.
  if (process.platform === 'win32') assertOrdinaryAncestry(path)
  let file
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
    await file.sync()
  } catch { storageInvalid() }
  finally { await file?.close() }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    db.exec(TRIALS_DDL)
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION}; COMMIT`)
  } catch { storageInvalid() }
  finally { db?.close() }
  await assertOrdinaryFile(path, false)
  const verified = new DatabaseSync(path, { readOnly: true })
  try {
    if (Number(verified.prepare('PRAGMA application_id').get()?.application_id) !== APPLICATION_ID
      || Number(verified.prepare('PRAGMA user_version').get()?.user_version) !== VERSION
      || verified.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal'
      || verified.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') storageInvalid()
    verifySchema(verified)
  } catch { storageInvalid() }
  finally { verified.close() }
  if (process.platform === 'win32') assertOrdinaryAncestry(path)
}

function parseRecord(value: unknown): ComfyVideoLocalTrialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== KEYS
    || row.schema !== 'qianshou.comfy-video-local-trial.v1'
    || typeof row.ownerId !== 'string' || !TOKEN.test(row.ownerId)
    || typeof row.profileId !== 'string' || !TOKEN.test(row.profileId)
    || typeof row.trialKey !== 'string' || !TOKEN.test(row.trialKey)
    || typeof row.attemptId !== 'string' || !UUID.test(row.attemptId)
    || typeof row.approvalSha256 !== 'string' || !HASH.test(row.approvalSha256)
    || typeof row.graphSha256 !== 'string' || !HASH.test(row.graphSha256)
    || typeof row.contractDigest !== 'string' || !DIGEST.test(row.contractDigest)
    || typeof row.dependencyManifestSha256 !== 'string' || !HASH.test(row.dependencyManifestSha256)
    || typeof row.runnerSourceSha256 !== 'string' || !HASH.test(row.runnerSourceSha256)
    || typeof row.runtimeWitnessSha256 !== 'string' || !HASH.test(row.runtimeWitnessSha256)
    || typeof row.inputSha256 !== 'string' || !HASH.test(row.inputSha256)
    || row.promptId !== null && (typeof row.promptId !== 'string' || !PROMPT_ID.test(row.promptId))
    || row.resultSha256 !== null && (typeof row.resultSha256 !== 'string' || !HASH.test(row.resultSha256))
    || typeof row.state !== 'string' || !['reserved', 'submitting', 'submitted', 'local-verified', 'abandoned'].includes(row.state)
    || (row.state === 'reserved' || row.state === 'submitting' || row.state === 'abandoned')
      && (row.promptId !== null || row.resultSha256 !== null)
    || row.state === 'submitted' && (row.promptId === null || row.resultSha256 !== null)
    || row.state === 'local-verified' && (row.promptId === null || row.resultSha256 === null)) invalid()
  return row as unknown as ComfyVideoLocalTrialRecord
}

function canonicalRecord(json: unknown): ComfyVideoLocalTrialRecord {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_RECORD_BYTES) invalid()
  try {
    const parsed = JSON.parse(json) as unknown
    const record = parseRecord(parsed)
    if (JSON.stringify(record) !== json) invalid()
    return record
  } catch { return invalid() }
}

function current(db: DatabaseSync): ComfyVideoLocalTrialRecord | null {
  const row = db.prepare('SELECT record_json FROM trials ORDER BY seq DESC LIMIT 1').get()
  return row ? canonicalRecord(row.record_json) : null
}

function sameAttempt(left: ComfyVideoLocalTrialRecord | null, right: ComfyVideoLocalTrialRecord): boolean {
  return left?.attemptId === right.attemptId && left.ownerId === right.ownerId
    && left.profileId === right.profileId && left.trialKey === right.trialKey
    && left.approvalSha256 === right.approvalSha256 && left.graphSha256 === right.graphSha256
    && left.contractDigest === right.contractDigest
    && left.dependencyManifestSha256 === right.dependencyManifestSha256
    && left.runnerSourceSha256 === right.runnerSourceSha256
    && left.runtimeWitnessSha256 === right.runtimeWitnessSha256
    && left.inputSha256 === right.inputSha256
}

/** Separate local-only journal; callers still own approval, current-state checks and GPU exclusion. */
export class ComfyVideoLocalTrialLedger {
  private startupVerified = false
  private physicalParent: string | undefined

  constructor(private readonly path: string) { if (!isAbsolute(path)) invalid() }

  private async open(fullIntegrityCheck = false): Promise<DatabaseSync> {
    // A later mount, volume substitution or reparse change must not inherit the first read.
    assertLocalNtfs(this.path)
    // DatabaseSync opens by path, not by a supplied verified handle. These pre/post checks
    // reject persistent reparse swaps; the Host must keep the private parent ACL protected
    // because a transient swap between checks and SQLite's open cannot be excluded here.
    if (process.platform === 'win32') assertOrdinaryAncestry(this.path)
    const physicalParent = process.platform === 'win32'
      ? physicalName(realpathSync.native(dirname(this.path))) : undefined
    if (this.physicalParent !== undefined && this.physicalParent !== physicalParent) storageInvalid()
    const parent = await lstat(dirname(this.path)).catch(() => storageInvalid())
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || process.getuid && (parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0)) storageInvalid()
    const named = await lstat(this.path).catch(() => storageInvalid())
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1
      || process.getuid && (named.uid !== process.getuid() || (named.mode & 0o077) !== 0)) storageInvalid()
    await assertOrdinaryFile(`${this.path}-wal`, true)
    await assertOrdinaryFile(`${this.path}-shm`, true)
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(this.path)
      const opened = await lstat(this.path).catch(() => storageInvalid())
      if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) storageInvalid()
      db.exec('PRAGMA busy_timeout=10000')
      if (Number(db.prepare('PRAGMA application_id').get()?.application_id) !== APPLICATION_ID
        || Number(db.prepare('PRAGMA user_version').get()?.user_version) !== VERSION
        || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) storageInvalid()
      verifySchema(db)
      db.exec('PRAGMA synchronous=FULL')
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal'
        || Number(db.prepare('PRAGMA synchronous').get()?.synchronous) !== 2) storageInvalid()
      if (fullIntegrityCheck && db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') storageInvalid()
      if (process.platform === 'win32') {
        assertOrdinaryAncestry(this.path)
        if (physicalName(realpathSync.native(dirname(this.path))) !== physicalParent) storageInvalid()
        this.physicalParent = physicalParent
      }
      return db
    } catch {
      try { db?.close() } catch { /* Storage is already unverified. */ }
      return storageInvalid()
    }
  }

  private async withDatabase<T>(operation: (db: DatabaseSync) => T, fullIntegrityCheck = false): Promise<T> {
    const db = await this.open(fullIntegrityCheck)
    try { return operation(db) } finally { db.close() }
  }

  private async transaction(operation: (db: DatabaseSync) => ComfyVideoLocalTrialRecord): Promise<ComfyVideoLocalTrialRecord> {
    if (!this.startupVerified) storageInvalid()
    return this.withDatabase(db => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const expected = operation(db)
        db.exec('COMMIT')
        if (JSON.stringify(current(db)) !== JSON.stringify(expected)) storageInvalid()
        return expected
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* COMMIT may have completed before readback failed. */ }
        throw error
      }
    })
  }

  /** Startup checks the exact database and preserves unknown POSTs; it never auto-resubmits. */
  async recoverAtStartup(): Promise<{ state: 'none' | 'unspent' | 'unknown' | 'local-verified' | 'abandoned'
    record: ComfyVideoLocalTrialRecord | null }> {
    const record = await this.withDatabase(db => current(db), true)
    this.startupVerified = true
    return { record, state: record === null ? 'none' : record.state === 'reserved' ? 'unspent'
      : record.state === 'submitting' || record.state === 'submitted' ? 'unknown'
        : record.state === 'local-verified' ? 'local-verified' : 'abandoned' }
  }

  /** Reserve one exact owner-approved local attempt; another key cannot displace an unknown POST. */
  async reserve(binding: ComfyVideoLocalTrialBinding): Promise<ComfyVideoLocalTrialRecord> {
    const record = parseRecord({ ...binding, schema: 'qianshou.comfy-video-local-trial.v1',
      attemptId: randomUUID(), promptId: null, resultSha256: null, state: 'reserved' })
    const committed = await this.transaction(db => {
      const old = current(db)
      if (old && old.state !== 'local-verified' && old.state !== 'abandoned'
        || db.prepare('SELECT 1 FROM trials WHERE trial_key=? OR approval_sha256=?').get(
          binding.trialKey, binding.approvalSha256)) invalid()
      db.prepare('INSERT INTO trials (trial_key,approval_sha256,attempt_id,record_json) VALUES (?,?,?,?)')
        .run(record.trialKey, record.approvalSha256, record.attemptId, JSON.stringify(record))
      return record
    })
    if (!sameAttempt(await this.latest(), committed)) invalid()
    return committed
  }

  /** Read the exact still-active original attempt before/after local Comfy operations. */
  async assertReserved(reserved: ComfyVideoLocalTrialRecord): Promise<void> {
    if (!this.startupVerified) storageInvalid()
    const row = await this.latest()
    if (!sameAttempt(row, reserved) || row?.state === 'local-verified' || row?.state === 'abandoned') invalid()
  }

  /** Persist the one-shot POST intent under an exclusive SQLite write transaction. */
  async beforePromptSubmit(reserved: ComfyVideoLocalTrialRecord): Promise<void> {
    await this.transition(reserved, 'reserved', { state: 'submitting' })
  }

  /** Bind only the actual ComfyUI prompt ID returned after the single POST. */
  async recordPromptId(reserved: ComfyVideoLocalTrialRecord, promptId: string): Promise<ComfyVideoLocalTrialRecord> {
    if (!PROMPT_ID.test(promptId)) invalid()
    return this.transition(reserved, 'submitting', { promptId, state: 'submitted' })
  }

  /** Retain the MP4 digest after independent local verification; this is not order settlement. */
  async recordLocalResult(reserved: ComfyVideoLocalTrialRecord, resultSha256: string): Promise<ComfyVideoLocalTrialRecord> {
    if (!HASH.test(resultSha256)) invalid()
    return this.transition(reserved, 'submitted', { resultSha256, state: 'local-verified' })
  }

  /** Abandon only an intent that never entered the POST window; a concurrent sender then fails CAS. */
  async abandonReserved(reserved: ComfyVideoLocalTrialRecord): Promise<ComfyVideoLocalTrialRecord> {
    return this.transition(reserved, 'reserved', { state: 'abandoned' })
  }

  private async transition(reserved: ComfyVideoLocalTrialRecord, expected: ComfyVideoLocalTrialRecord['state'],
    change: Partial<ComfyVideoLocalTrialRecord>): Promise<ComfyVideoLocalTrialRecord> {
    return this.transaction(db => {
      const old = current(db)
      if (!sameAttempt(old, reserved) || old?.state !== expected) invalid()
      const next = parseRecord({ ...old, ...change })
      const changed = db.prepare('UPDATE trials SET record_json=? WHERE attempt_id=? AND record_json=?')
        .run(JSON.stringify(next), old.attemptId, JSON.stringify(old))
      if (changed.changes !== 1) invalid()
      return next
    })
  }

  /** Read local state only; unknown records are never restored as fresh reservations. */
  latest(): Promise<ComfyVideoLocalTrialRecord | null> { return this.withDatabase(db => current(db)) }
}
