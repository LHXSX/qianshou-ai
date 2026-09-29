import { DatabaseSync } from 'node:sqlite'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComfyVideoSqliteAttemptLedgerPrototype } from '../src/comfy-video-sqlite-attempt-ledger.ts'
import { ComputeTaskId } from '../src/protocol.ts'
import type { ResidentAttempt } from '../src/resident/types.ts'
import { ComputeTaskStore } from '../src/task-store.ts'

const roots: string[] = []
const contractDigest = `sha256:${'a'.repeat(64)}`
const graphSha256 = 'b'.repeat(64)
const promptId = 'cfae9e4d-7443-4e8d-8d44-32f89ab478a2'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'comfy-video-sqlite-'))
  roots.push(root)
  const privateDir = join(root, 'private')
  await mkdir(privateDir, { mode: 0o700 })
  const path = join(privateDir, 'attempts.sqlite')
  const provisioned = new DatabaseSync(path)
  try {
    provisioned.exec(`CREATE TABLE attempts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL,
      UNIQUE(task_id, attempt)
    ) STRICT;
    PRAGMA application_id=1364411222;
    PRAGMA user_version=1;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;`)
  } finally { provisioned.close() }
  await chmod(path, 0o600)
  const store = new ComputeTaskStore({ path: join(root, 'tasks.json'), maxTasks: 10, maxBytes: 32 * 1024 })
  const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
  const binding: ResidentAttempt = { taskId: 'video-task-1', attempt: 1, leaseId: 'lease-1',
    leaseExpiresAt, idempotencyKey: 'key-1', envelopeFingerprint: 'c'.repeat(64),
    capabilityId: 'video.render', capabilityVersion: 'v1', capabilityPluginDigest: 'd'.repeat(64) }
  const now = () => new Date().toISOString()
  await store.putIfAbsent({ taskId: ComputeTaskId(binding.taskId), attempt: binding.attempt,
    envelopeFingerprint: binding.envelopeFingerprint, idempotencyKey: binding.idempotencyKey,
    status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: now() })
  await store.transition(binding.taskId, binding.attempt, { type: 'accept', leaseExpiresAt }, now())
  await store.transition(binding.taskId, binding.attempt, { type: 'start' }, now())
  const ledger = new ComfyVideoSqliteAttemptLedgerPrototype(path, store)
  expect(await ledger.recoverAtStartup()).toMatchObject({ state: 'none' })
  return { path, store, binding, ledger, now }
}

async function killedSubmission(parent = tmpdir()): Promise<void> {
  const { path, store, binding, ledger } = await fixture(parent)
  const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
  const source = new URL('../src/comfy-video-sqlite-attempt-ledger.ts', import.meta.url).href
  const childCode = `const { ComfyVideoSqliteAttemptLedgerPrototype } = await import(${JSON.stringify(source)});
    const reserved = JSON.parse(process.argv[2]);
    const store = { get: async () => ({ status: 'EXECUTING',
      envelopeFingerprint: reserved.envelopeFingerprint, idempotencyKey: reserved.idempotencyKey,
      leaseExpiresAt: reserved.leaseExpiresAt }) };
    const ledger = new ComfyVideoSqliteAttemptLedgerPrototype(process.argv[1], store);
    await ledger.recoverAtStartup();
    await ledger.beforePromptSubmit(reserved);
    process.stdout.write('SUBMITTING_COMMITTED\\n');
    setInterval(() => {}, 1000);`
  const child = spawn(process.execPath,
    ['--experimental-transform-types', '--input-type=module', '-e', childCode, path, JSON.stringify(reserved)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: {} })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('child did not commit submitting')) }, 15_000)
      let output = ''
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString('utf8')
        if (output.includes('SUBMITTING_COMMITTED\n')) { clearTimeout(timer); resolve() }
      })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`child exited before commit: ${code}`)) })
    })
  } finally {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  const restarted = new ComfyVideoSqliteAttemptLedgerPrototype(path, store)
  expect(await restarted.recoverAtStartup())
    .toMatchObject({ state: 'unknown', record: { state: 'submitting', promptId: null } })
  await expect(restarted.beforePromptSubmit(reserved))
    .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_ATTEMPT_INVALID')
}

describe('SQLite Comfy one-shot ledger prototype', () => {
  it('opens WAL with a stable app identity, commits one submitting intent, and recovers unknown after restart', async () => {
    const { path, store, binding, ledger } = await fixture()
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    const readOnly = new DatabaseSync(path, { readOnly: true })
    try {
      expect(readOnly.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
      expect(Number(readOnly.prepare('PRAGMA application_id').get()?.application_id)).toBe(0x51534356)
      expect(readOnly.prepare('SELECT count(*) AS total FROM attempts').get()?.total).toBe(1)
    } finally { readOnly.close() }
    await ledger.beforePromptSubmit(reserved)
    const reopened = new ComfyVideoSqliteAttemptLedgerPrototype(path, store)
    expect(await reopened.recoverAtStartup())
      .toMatchObject({ state: 'unknown', record: { state: 'submitting', promptId: null } })
    await ledger.recordPromptId(reserved, promptId)
    expect(await reopened.recoverAtStartup())
      .toMatchObject({ state: 'unknown', record: { state: 'submitted', promptId } })
    await expect(reopened.reserve(binding, contractDigest, graphSha256))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_ATTEMPT_INVALID')
  })

  it('serializes two independent instances to exactly one pre-POST authorization', async () => {
    const { path, store, binding, ledger } = await fixture()
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    const contender = new ComfyVideoSqliteAttemptLedgerPrototype(path, store)
    await contender.recoverAtStartup()
    const results = await Promise.allSettled([
      ledger.beforePromptSubmit(reserved), contender.beforePromptSubmit(reserved),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await contender.latest()).toMatchObject({ state: 'submitting' })
    await store.transition(binding.taskId, binding.attempt, { type: 'fail' }, new Date().toISOString())
    await expect(ledger.releaseNeverSubmitted(reserved, async () => ({ taskId: binding.taskId,
      attempt: binding.attempt, status: 'FAILED', sha256: 'e'.repeat(64) })))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_ATTEMPT_INVALID')
  })

  it('requires authoritative terminal evidence for an unspent reservation, then allows a distinct task', async () => {
    const { path, store, binding, ledger, now } = await fixture()
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    await store.transition(binding.taskId, binding.attempt, { type: 'fail' }, now())
    await expect(ledger.releaseNeverSubmitted(reserved, async () => ({ taskId: 'wrong-task',
      attempt: binding.attempt, status: 'FAILED', sha256: 'e'.repeat(64) })))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_ATTEMPT_INVALID')
    await ledger.releaseNeverSubmitted(reserved, async () => ({ taskId: binding.taskId,
      attempt: binding.attempt, status: 'FAILED', sha256: 'e'.repeat(64) }))
    expect(await new ComfyVideoSqliteAttemptLedgerPrototype(path, store).recoverAtStartup())
      .toMatchObject({ state: 'terminal-released' })
    const next: ResidentAttempt = { ...binding, taskId: 'video-task-2', idempotencyKey: 'key-2',
      envelopeFingerprint: 'f'.repeat(64) }
    await store.putIfAbsent({ taskId: ComputeTaskId(next.taskId), attempt: next.attempt,
      envelopeFingerprint: next.envelopeFingerprint, idempotencyKey: next.idempotencyKey,
      status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: now() })
    await store.transition(next.taskId, next.attempt, { type: 'accept', leaseExpiresAt: next.leaseExpiresAt }, now())
    await store.transition(next.taskId, next.attempt, { type: 'start' }, now())
    const second = await ledger.reserve(next, contractDigest, graphSha256)
    expect(second.taskId).toBe(next.taskId)
    await ledger.beforePromptSubmit(second)
    await ledger.recordPromptId(second, promptId)
    await ledger.recordLocalResult(second, 'f'.repeat(64))
    expect(await ledger.latest()).toMatchObject({ state: 'local-verified', promptId,
      resultSha256: 'f'.repeat(64) })
    const db = new DatabaseSync(path, { readOnly: true })
    try { expect(db.prepare('SELECT count(*) AS total FROM attempts').get()?.total).toBe(2) }
    finally { db.close() }
  })

  it('requires a full startup recovery for every reopened instance before any write', async () => {
    const { path, store, binding, ledger } = await fixture()
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    const reopened = new ComfyVideoSqliteAttemptLedgerPrototype(path, store)
    await expect(reopened.beforePromptSubmit(reserved))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_STORAGE_UNVERIFIED')
    expect(await reopened.recoverAtStartup()).toMatchObject({ state: 'unspent' })
    await reopened.beforePromptSubmit(reserved)
    expect(await reopened.recoverAtStartup()).toMatchObject({ state: 'unknown' })
  })

  it('refuses a missing journal instead of recreating an empty history after an unknown POST', async () => {
    const { path, store, binding, ledger } = await fixture()
    const reserved = await ledger.reserve(binding, contractDigest, graphSha256)
    await ledger.beforePromptSubmit(reserved)
    await rm(path)
    const reopened = new ComfyVideoSqliteAttemptLedgerPrototype(path, store)
    await expect(reopened.recoverAtStartup())
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_STORAGE_UNVERIFIED')
    await expect(ledger.beforePromptSubmit(reserved))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_STORAGE_UNVERIFIED')
  })

  it('keeps a killed child process in an unknown state without a second POST', async () => { await killedSubmission() })

  it.skipIf(process.platform !== 'win32' || !process.env.QIANSHOU_WINDOWS_NTFS_TEST_ROOT)(
    'Windows NTFS acceptance: a killed process leaves the sole submission unknown', async () => {
      const configured = process.env.QIANSHOU_WINDOWS_NTFS_TEST_ROOT!
      if (!isAbsolute(configured) || !/^[A-Za-z]:[\\/]/u.test(configured)) {
        throw new Error('QIANSHOU_WINDOWS_NTFS_TEST_ROOT must be an absolute local drive path')
      }
      const parent = await realpath(configured)
      const fsName = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Volume -DriveLetter '${parent[0]}').FileSystem`], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true,
      }).trim()
      expect(fsName).toBe('NTFS')
      await killedSubmission(parent)
    })

  it('does not rerun whole-database integrity_check on hot reopens', async () => {
    const { path, store, binding } = await fixture()
    const reopened = new ComfyVideoSqliteAttemptLedgerPrototype(path, store)
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const fullChecks = () => spy.mock.calls.filter(([sql]) => sql === 'PRAGMA integrity_check').length
    try {
      expect(await reopened.recoverAtStartup()).toMatchObject({ state: 'none' })
      expect(fullChecks()).toBe(1)
      await reopened.latest()
      await reopened.reserve(binding, contractDigest, graphSha256)
      await reopened.latest()
      await reopened.recoverAtStartup()
      expect(fullChecks()).toBe(1)
    } finally { spy.mockRestore() }
  })

  it.each([
    ['task/attempt', `CREATE TABLE attempts (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL, attempt INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL) STRICT`],
    ['attempt ID', `CREATE TABLE attempts (seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL, attempt INTEGER NOT NULL, attempt_id TEXT NOT NULL,
      record_json TEXT NOT NULL, UNIQUE(task_id, attempt)) STRICT`],
  ])('refuses a same-version database missing the %s uniqueness constraint', async (_label, ddl) => {
    const { path, store } = await fixture()
    const db = new DatabaseSync(path)
    try {
      expect(Number(db.prepare('PRAGMA application_id').get()?.application_id)).toBe(0x51534356)
      db.exec(`ALTER TABLE attempts RENAME TO obsolete_attempts;
        ${ddl};
        DROP TABLE obsolete_attempts;`)
      expect(Number(db.prepare('PRAGMA application_id').get()?.application_id)).toBe(0x51534356)
      expect(Number(db.prepare('PRAGMA user_version').get()?.user_version)).toBe(1)
      expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
    } finally { db.close() }
    await expect(new ComfyVideoSqliteAttemptLedgerPrototype(path, store).recoverAtStartup())
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SQLITE_STORAGE_UNVERIFIED')
  })
})
