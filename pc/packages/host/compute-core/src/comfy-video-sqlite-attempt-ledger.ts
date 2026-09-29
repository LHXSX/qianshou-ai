/** SQLite ComfyUI one-shot journal for an explicitly provisioned local volume. */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute } from 'node:path'
import { ComputeError } from './errors.ts'
import type { ComfyVideoAttemptRecord, ComfyVideoTerminalEvidence } from './comfy-video-attempt-ledger.ts'
import type { ResidentAttempt } from './resident/types.ts'
import type { ComputeTaskStatus } from './task-state.ts'
import type { ComputeTaskStore } from './task-store.ts'

const APPLICATION_ID = 0x51534356
const VERSION = 1
const MAX_RECORD_BYTES = 4096
const HASH = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TERMINAL = new Set<ComputeTaskStatus>(['SETTLED', 'FAILED', 'REVOKED', 'EXPIRED', 'REFUSED'])
const KEYS = 'attempt,attemptId,contractDigest,envelopeFingerprint,graphSha256,idempotencyKey,leaseExpiresAt,promptId,resultSha256,schema,state,taskId,terminalEvidenceSha256'
const ATTEMPTS_DDL = `CREATE TABLE attempts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  UNIQUE(task_id, attempt)
) STRICT`

function invalid(): never { throw new ComputeError('COMPUTE_COMFY_VIDEO_SQLITE_ATTEMPT_INVALID', 409) }
function storageInvalid(): never { throw new ComputeError('COMPUTE_COMFY_VIDEO_SQLITE_STORAGE_UNVERIFIED', 503) }

/** WAL cannot be used on a network filesystem. Check the resolved Windows volume before the first open. */
function assertLocalNtfs(path: string): void {
  if (process.platform !== 'win32') return
  if (!/^[A-Za-z]:[\\/]/u.test(path)) storageInvalid()
  try {
    let parent = dirname(path)
    while (!existsSync(parent)) {
      const next = dirname(parent)
      if (next === parent) storageInvalid()
      parent = next
    }
    const physicalParent = realpathSync.native(parent)
    const script = "$v=Get-Volume -FilePath $env:QIANSHOU_LEDGER_VOLUME_PATH -ErrorAction Stop; if ($v.FileSystem -ne 'NTFS' -or $v.DriveType -ne 'Fixed') { exit 3 }; [Console]::Out.Write('NTFS_FIXED')"
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, QIANSHOU_LEDGER_VOLUME_PATH: physicalParent },
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

/** One-time setup only: a missing database during normal startup is never recreated. The dedicated
 * parent must not exist, so an interrupted first setup needs explicit operator reconciliation.
 */
export async function provisionComfyVideoSqliteAttemptLedger(path: string): Promise<void> {
  if (!isAbsolute(path)) storageInvalid()
  assertLocalNtfs(path)
  const parent = dirname(path)
  const ancestor = await lstat(dirname(parent)).catch(() => storageInvalid())
  if (!ancestor.isDirectory() || ancestor.isSymbolicLink()
    || process.getuid && (ancestor.uid !== process.getuid() || (ancestor.mode & 0o077) !== 0)) storageInvalid()
  try { await mkdir(parent, { mode: 0o700 }) }
  catch { storageInvalid() }
  // Exclusive file creation makes concurrent first-time provisioners fail rather than
  // silently reuse a partially initialized database. Do not clean up after a failure.
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
    db.exec(ATTEMPTS_DDL)
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
}

function parseRecord(value: unknown): ComfyVideoAttemptRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== KEYS
    || row.schema !== 'qianshou.comfy-video-attempt.v1'
    || typeof row.taskId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(row.taskId)
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1
    || typeof row.attemptId !== 'string' || !UUID.test(row.attemptId)
    || typeof row.envelopeFingerprint !== 'string' || !HASH.test(row.envelopeFingerprint)
    || typeof row.idempotencyKey !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(row.idempotencyKey)
    || typeof row.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(row.leaseExpiresAt))
    || typeof row.contractDigest !== 'string' || !DIGEST.test(row.contractDigest)
    || typeof row.graphSha256 !== 'string' || !HASH.test(row.graphSha256)
    || row.promptId !== null && (typeof row.promptId !== 'string' || !PROMPT_ID.test(row.promptId))
    || row.resultSha256 !== null && (typeof row.resultSha256 !== 'string' || !HASH.test(row.resultSha256))
    || row.terminalEvidenceSha256 !== null
      && (typeof row.terminalEvidenceSha256 !== 'string' || !HASH.test(row.terminalEvidenceSha256))
    || typeof row.state !== 'string'
    || !['reserved', 'submitting', 'submitted', 'local-verified', 'never-submitted'].includes(row.state)
    || (row.state === 'reserved' || row.state === 'submitting')
      && (row.promptId !== null || row.resultSha256 !== null || row.terminalEvidenceSha256 !== null)
    || row.state === 'submitted' && (row.promptId === null || row.resultSha256 !== null)
    || row.state === 'local-verified' && (row.promptId === null || row.resultSha256 === null)
    || row.state === 'never-submitted'
      && (row.promptId !== null || row.resultSha256 !== null || row.terminalEvidenceSha256 === null)
    || row.state !== 'never-submitted' && row.terminalEvidenceSha256 !== null) invalid()
  return row as unknown as ComfyVideoAttemptRecord
}

function canonicalRecord(json: unknown): ComfyVideoAttemptRecord {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_RECORD_BYTES) invalid()
  try {
    const parsed = JSON.parse(json) as unknown
    const record = parseRecord(parsed)
    if (JSON.stringify(record) !== json) invalid()
    return record
  } catch { return invalid() }
}

function current(db: DatabaseSync): ComfyVideoAttemptRecord | null {
  const row = db.prepare('SELECT record_json FROM attempts ORDER BY seq DESC LIMIT 1').get()
  return row ? canonicalRecord(row.record_json) : null
}

/** A later attempt cannot erase a previous /prompt intent for the same order. */
function assertNoSpentTaskHistory(db: DatabaseSync, taskId: string): void {
  const rows = db.prepare('SELECT record_json FROM attempts WHERE task_id=?').all(taskId)
  if (rows.some(row => canonicalRecord(row.record_json).state !== 'never-submitted')) invalid()
}

function sameAttempt(left: ComfyVideoAttemptRecord | null, right: ComfyVideoAttemptRecord): boolean {
  return left?.attemptId === right.attemptId && left.taskId === right.taskId
    && left.attempt === right.attempt && left.contractDigest === right.contractDigest
    && left.graphSha256 === right.graphSha256 && left.envelopeFingerprint === right.envelopeFingerprint
    && left.idempotencyKey === right.idempotencyKey && left.leaseExpiresAt === right.leaseExpiresAt
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, ' ').replace(/\s*([(),])\s*/gu, '$1')
}

/** Reject a same-version database whose uniqueness or row format was changed out of band. */
function verifySchema(db: DatabaseSync): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attempts'").get()
  if (typeof table?.sql !== 'string' || normalizedSql(table.sql) !== normalizedSql(ATTEMPTS_DDL)
    || db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='attempts' LIMIT 1").get()) storageInvalid()
  const expectedColumns = [
    ['seq', 'INTEGER', 0, 1], ['task_id', 'TEXT', 1, 0], ['attempt', 'INTEGER', 1, 0],
    ['attempt_id', 'TEXT', 1, 0], ['record_json', 'TEXT', 1, 0],
  ]
  const columns = db.prepare('PRAGMA table_info(attempts)').all()
  if (columns.length !== expectedColumns.length || columns.some((column, index) => {
    const expected = expectedColumns[index]
    return !expected || Number(column.cid) !== index || column.name !== expected[0] || column.type !== expected[1]
      || Number(column.notnull) !== expected[2] || Number(column.pk) !== expected[3]
      || column.dflt_value !== null
  })) storageInvalid()
  const indexes = db.prepare('PRAGMA index_list(attempts)').all()
  if (indexes.length !== 2) storageInvalid()
  const signatures = indexes.map((index) => {
    if (typeof index.name !== 'string' || !/^sqlite_autoindex_attempts_[12]$/u.test(index.name)
      || Number(index.unique) !== 1 || index.origin !== 'u' || Number(index.partial) !== 0) storageInvalid()
    const fields = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name)
    if (fields.some(field => typeof field.name !== 'string')) storageInvalid()
    return fields.map(field => field.name).join(',')
  }).sort()
  if (signatures.join('|') !== 'attempt_id|task_id,attempt') storageInvalid()
}

/** Local SQLite implementation. Call recoverAtStartup before every process's first reservation. */
export class ComfyVideoSqliteAttemptLedger {
  private startupVerified = false
  private volumeVerified = false

  constructor(private readonly path: string, private readonly taskStore: Pick<ComputeTaskStore, 'get'>) {
    if (!isAbsolute(path)) invalid()
  }

  private async open(fullIntegrityCheck = false): Promise<DatabaseSync> {
    // The Host must provision an owner-private database before any order.
    // Recreating a missing database would erase an unresolved /prompt claim.
    if (!this.volumeVerified) { assertLocalNtfs(this.path); this.volumeVerified = true }
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
      const application = Number(db.prepare('PRAGMA application_id').get()?.application_id)
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
      const hasTable = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get())
      if (application !== APPLICATION_ID || version !== VERSION || !hasTable) storageInvalid()
      verifySchema(db)
      db.exec('PRAGMA synchronous=FULL')
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal'
        || Number(db.prepare('PRAGMA synchronous').get()?.synchronous) !== 2) storageInvalid()
      // integrity_check walks the entire database. Run it once per process
      // instance at startup; hot paths still parse the current row strictly.
      if (fullIntegrityCheck && db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') storageInvalid()
      return db
    } catch {
      try { db?.close() } catch { /* storage is already unverified */ }
      return storageInvalid()
    }
  }

  private async withDatabase<T>(operation: (db: DatabaseSync) => T, fullIntegrityCheck = false): Promise<T> {
    const db = await this.open(fullIntegrityCheck)
    try { return operation(db) } finally { db.close() }
  }

  private requireStartupRecovery(): void {
    if (!this.startupVerified) storageInvalid()
  }

  private async transaction(operation: (db: DatabaseSync) => ComfyVideoAttemptRecord): Promise<ComfyVideoAttemptRecord> {
    this.requireStartupRecovery()
    return this.withDatabase((db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const expected = operation(db)
        db.exec('COMMIT')
        // A successful COMMIT is followed by a fresh read on the same FULL-sync connection.
        if (JSON.stringify(current(db)) !== JSON.stringify(expected)) storageInvalid()
        return expected
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* COMMIT may have completed before readback failed. */ }
        throw error
      }
    })
  }

  private async executing(binding: Pick<ResidentAttempt, 'taskId' | 'attempt' | 'envelopeFingerprint' | 'idempotencyKey' | 'leaseExpiresAt'>): Promise<void> {
    const state = await this.taskStore.get(binding.taskId, binding.attempt)
    if (state?.status !== 'EXECUTING' || state.envelopeFingerprint !== binding.envelopeFingerprint
      || state.idempotencyKey !== binding.idempotencyKey || state.leaseExpiresAt !== binding.leaseExpiresAt
      || Date.parse(binding.leaseExpiresAt) <= Date.now()) invalid()
  }

  /** Reserve at most one row for each signed task/attempt after the prior row reaches a safe terminal state. */
  async reserve(binding: ResidentAttempt, contractDigest: string, graphSha256: string): Promise<ComfyVideoAttemptRecord> {
    this.requireStartupRecovery()
    if (!DIGEST.test(contractDigest) || !HASH.test(graphSha256)) invalid()
    await this.executing(binding)
    const previous = await this.latest()
    const previousStatus = previous ? (await this.taskStore.get(previous.taskId, previous.attempt))?.status : undefined
    const record = parseRecord({ schema: 'qianshou.comfy-video-attempt.v1', taskId: binding.taskId,
      attempt: binding.attempt, attemptId: randomUUID(), envelopeFingerprint: binding.envelopeFingerprint,
      idempotencyKey: binding.idempotencyKey, leaseExpiresAt: binding.leaseExpiresAt,
      contractDigest, graphSha256, promptId: null, resultSha256: null,
      terminalEvidenceSha256: null, state: 'reserved' })
    await this.transaction((db) => {
      const old = current(db)
      assertNoSpentTaskHistory(db, binding.taskId)
      if (old?.attemptId !== previous?.attemptId || old && (old.taskId === binding.taskId && old.attempt === binding.attempt
        || old.state === 'local-verified' && previousStatus !== 'SETTLED'
        || old.state === 'never-submitted' && !TERMINAL.has(previousStatus as ComputeTaskStatus)
        || old.state !== 'local-verified' && old.state !== 'never-submitted')) invalid()
      db.prepare('INSERT INTO attempts (task_id,attempt,attempt_id,record_json) VALUES (?,?,?,?)')
        .run(record.taskId, record.attempt, record.attemptId, JSON.stringify(record))
      return record
    })
    if (!sameAttempt(await this.latest(), record)) invalid()
    await this.executing(binding)
    return record
  }

  async assertReserved(reserved: ComfyVideoAttemptRecord): Promise<void> {
    this.requireStartupRecovery()
    const row = await this.latest()
    if (!sameAttempt(row, reserved) || row?.state === 'local-verified'
      || row?.state === 'never-submitted') invalid()
    await this.executing(reserved)
  }

  /** The only pre-POST gate: under BEGIN IMMEDIATE, atomically spend reserved → submitting. */
  async beforePromptSubmit(reserved: ComfyVideoAttemptRecord): Promise<void> {
    this.requireStartupRecovery()
    await this.executing(reserved)
    await this.transaction((db) => {
      const old = current(db)
      if (!sameAttempt(old, reserved) || old?.state !== 'reserved') invalid()
      const rows = db.prepare('SELECT record_json FROM attempts WHERE task_id=? AND attempt_id<>?')
        .all(reserved.taskId, reserved.attemptId)
      if (rows.some(row => canonicalRecord(row.record_json).state !== 'never-submitted')) invalid()
      const next = parseRecord({ ...old, state: 'submitting' })
      const changed = db.prepare('UPDATE attempts SET record_json=? WHERE attempt_id=? AND record_json=?')
        .run(JSON.stringify(next), old.attemptId, JSON.stringify(old))
      if (changed.changes !== 1) invalid()
      return next
    })
    if ((await this.latest())?.state !== 'submitting') invalid()
    await this.executing(reserved)
  }

  /** The returned server ID cannot be invented before committing the submitting state. */
  async recordPromptId(reserved: ComfyVideoAttemptRecord, promptId: string): Promise<ComfyVideoAttemptRecord> {
    this.requireStartupRecovery()
    if (!PROMPT_ID.test(promptId)) invalid()
    return this.transition(reserved, 'submitting', { promptId, state: 'submitted' })
  }

  async recordLocalResult(reserved: ComfyVideoAttemptRecord, resultSha256: string): Promise<ComfyVideoAttemptRecord> {
    this.requireStartupRecovery()
    if (!HASH.test(resultSha256)) invalid()
    return this.transition(reserved, 'submitted', { resultSha256, state: 'local-verified' })
  }

  private async transition(reserved: ComfyVideoAttemptRecord, expected: ComfyVideoAttemptRecord['state'],
    change: Partial<ComfyVideoAttemptRecord>): Promise<ComfyVideoAttemptRecord> {
    return this.transaction((db) => {
      const old = current(db)
      if (!sameAttempt(old, reserved) || old?.state !== expected) invalid()
      const next = parseRecord({ ...old, ...change })
      const changed = db.prepare('UPDATE attempts SET record_json=? WHERE attempt_id=? AND record_json=?')
        .run(JSON.stringify(next), old.attemptId, JSON.stringify(old))
      if (changed.changes !== 1) invalid()
      return next
    })
  }

  /** Release is explicit and possible only before the POST window, with authoritative terminal evidence. */
  async releaseNeverSubmitted(reserved: ComfyVideoAttemptRecord,
    assertAuthoritativeTerminal: () => Promise<ComfyVideoTerminalEvidence>): Promise<void> {
    this.requireStartupRecovery()
    const evidence = await assertAuthoritativeTerminal()
    const state = await this.taskStore.get(reserved.taskId, reserved.attempt)
    if (evidence.taskId !== reserved.taskId || evidence.attempt !== reserved.attempt
      || !TERMINAL.has(evidence.status) || !HASH.test(evidence.sha256)
      || state?.status !== evidence.status) invalid()
    await this.transition(reserved, 'reserved', {
      state: 'never-submitted', terminalEvidenceSha256: evidence.sha256,
    })
  }

  async latest(): Promise<ComfyVideoAttemptRecord | null> {
    return this.withDatabase(db => current(db))
  }

  /** Startup never treats an unknown POST as a fresh reservation or retry authority. */
  async recoverAtStartup(): Promise<{ state: 'none' | 'unspent' | 'unknown' | 'local-verified' | 'terminal-released'
    record: ComfyVideoAttemptRecord | null }> {
    const record = this.startupVerified ? await this.latest()
      : await this.withDatabase(db => current(db), true)
    this.startupVerified = true
    return { record, state: record === null ? 'none' : record.state === 'reserved' ? 'unspent'
      : record.state === 'submitting' || record.state === 'submitted' ? 'unknown'
        : record.state === 'local-verified' ? 'local-verified' : 'terminal-released' }
  }
}

/** Compatibility name for callers that explicitly evaluated the original prototype. */
export { ComfyVideoSqliteAttemptLedger as ComfyVideoSqliteAttemptLedgerPrototype }
