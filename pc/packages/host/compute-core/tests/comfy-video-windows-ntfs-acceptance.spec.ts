import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { copyFile, mkdir, stat, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ComfyVideoAttemptLedger } from '../src/comfy-video-attempt-ledger.ts'
import { ComfyVideoSqliteAttemptLedger, provisionComfyVideoSqliteAttemptLedger } from '../src/comfy-video-sqlite-attempt-ledger.ts'
import type { ResidentAttempt } from '../src/resident/types.ts'
import type { ComputeTaskStore } from '../src/task-store.ts'

const enabled = process.platform === 'win32' && Boolean(process.env.QIANSHOU_WINDOWS_NTFS_TEST_ROOT)
const source = new URL('../src/comfy-video-sqlite-attempt-ledger.ts', import.meta.url).href
const contractDigest = `sha256:${'a'.repeat(64)}`
const graphSha256 = 'b'.repeat(64)
const roots: Array<{ path: string, parent: string, uniqueId: string, dev: number, ino: number }> = []
const children: ChildProcess[] = []
const servers: Server[] = []

function storeFor(binding: ResidentAttempt): Pick<ComputeTaskStore, 'get'> {
  return { get: async (taskId: string, attempt: number) => taskId === binding.taskId && attempt === binding.attempt
    ? { status: 'EXECUTING', envelopeFingerprint: binding.envelopeFingerprint,
      idempotencyKey: binding.idempotencyKey, leaseExpiresAt: binding.leaseExpiresAt }
    : undefined } as unknown as Pick<ComputeTaskStore, 'get'>
}

function binding(): ResidentAttempt {
  return { taskId: 'ntfs-video-task-1', attempt: 1, leaseId: 'ntfs-lease-1',
    leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    idempotencyKey: 'ntfs-key-1', envelopeFingerprint: 'c'.repeat(64),
    capabilityId: 'video.render', capabilityVersion: 'v1', capabilityPluginDigest: 'd'.repeat(64) }
}

function childStoreCode(): string {
  return `const binding = JSON.parse(process.argv[2]);
    const store = { get: async (taskId, attempt) => taskId === binding.taskId && attempt === binding.attempt
      ? { status: 'EXECUTING', envelopeFingerprint: binding.envelopeFingerprint,
          idempotencyKey: binding.idempotencyKey, leaseExpiresAt: binding.leaseExpiresAt }
      : undefined };`
}

type RunningChild = {
  readonly process: ChildProcess
  readonly exit: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
  readonly output: () => string
  readonly error: () => string
  readonly waitFor: (marker: string) => Promise<void>
}

function runChild(code: string, args: string[]): RunningChild {
  const child = spawn(process.execPath,
    ['--experimental-transform-types', '--input-type=module', '-e', code, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  children.push(child)
  let output = ''
  let error = ''
  const waiters: Array<{ marker: string, resolve: () => void, reject: (error: Error) => void,
    timer: NodeJS.Timeout }> = []
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    for (const waiter of [...waiters]) {
      if (!output.includes(waiter.marker)) continue
      clearTimeout(waiter.timer)
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => { error += chunk.toString('utf8') })
  const exit = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`child exited before ${waiter.marker}: ${code}; ${error}`))
      }
      resolve({ code, signal })
    })
  })
  return { process: child, exit, output: () => output, error: () => error,
    waitFor: (marker) => output.includes(marker) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex(waiter => waiter.marker === marker && waiter.resolve === resolve)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`child did not print ${marker}; stdout=${output}; stderr=${error}`))
      }, 20_000)
      waiters.push({ marker, resolve, reject, timer })
    }) }
}

async function kill(child: RunningChild): Promise<{ code: number | null, signal: NodeJS.Signals | null }> {
  if (child.process.exitCode === null && !child.process.killed) child.process.kill('SIGKILL')
  return child.exit
}

function volumeAt(path: string): { FileSystem: string, DriveType: string, UniqueId: string } {
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$v=Get-Volume -FilePath $env:QIANSHOU_NTFS_TEST_PARENT -ErrorAction Stop; [pscustomobject]@{FileSystem=$v.FileSystem;DriveType=$v.DriveType.ToString();UniqueId=$v.UniqueId} | ConvertTo-Json -Compress"],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: { ...process.env, QIANSHOU_NTFS_TEST_PARENT: path } }).trim()
  return JSON.parse(raw) as { FileSystem: string, DriveType: string, UniqueId: string }
}

async function ntfsRoot(): Promise<{ root: string, volume: {
  fileSystem: string, driveType: string, uniqueIdSha256: string
} }> {
  const configured = process.env.QIANSHOU_WINDOWS_NTFS_TEST_ROOT!
  if (!isAbsolute(configured) || !/^[A-Za-z]:[\\/]/u.test(configured)) {
    throw new Error('QIANSHOU_WINDOWS_NTFS_TEST_ROOT must be an absolute local drive path')
  }
  const parent = await realpath(configured)
  const identified = volumeAt(parent)
  expect(identified.FileSystem).toBe('NTFS')
  expect(identified.DriveType).toBe('Fixed')
  expect(identified.UniqueId.length).toBeGreaterThan(0)
  const root = await mkdtemp(join(parent, 'comfy-video-ntfs-'))
  const named = await lstat(root)
  roots.push({ path: root, parent, uniqueId: identified.UniqueId, dev: named.dev, ino: named.ino })
  return { root, volume: { fileSystem: identified.FileSystem, driveType: identified.DriveType,
    uniqueIdSha256: createHash('sha256').update(identified.UniqueId).digest('hex') } }
}

async function size(path: string): Promise<number | null> {
  try { return (await stat(path)).size } catch { return null }
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20_000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

function witness(caseName: string, values: Record<string, unknown>): void {
  // This deliberately omits private graph, media, credentials, and absolute paths.
  console.info(`NTFS_LEDGER_WITNESS ${JSON.stringify({ case: caseName, ...values })}`)
}

async function fakePromptServer(holdResponse = false): Promise<{
  port: number, count: () => number, seen: Promise<void>
}> {
  let count = 0
  let notifySeen!: () => void
  const seen = new Promise<void>(resolve => { notifySeen = resolve })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/prompt') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    request.on('end', () => {
      count++
      notifySeen()
      if (!holdResponse) response.writeHead(200, { 'content-type': 'application/json' })
        .end('{"prompt_id":"cfae9e4d-7443-4e8d-8d44-32f89ab478a2"}')
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local server has no TCP port')
  expect(address.port).not.toBe(8793)
  expect(address.port).not.toBe(8194)
  return { port: address.port, count: () => count, seen }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && !child.killed) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }))
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }))
  for (const owned of roots.splice(0)) {
    const named = await lstat(owned.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!named) continue
    if (!named.isDirectory() || named.isSymbolicLink()
      || named.dev !== owned.dev || named.ino !== owned.ino) {
      throw new Error('NTFS test root identity changed before cleanup')
    }
    const [parent, target] = await Promise.all([realpath(owned.parent), realpath(owned.path)])
    const prefix = `${parent.replace(/[\\/]+$/u, '')}${sep}`.toLowerCase()
    if (!target.toLowerCase().startsWith(prefix)
      || volumeAt(target).UniqueId !== owned.uniqueId) {
      throw new Error('NTFS test root escaped its original parent or volume before cleanup')
    }
    await rm(owned.path, { recursive: true })
  }
})

describe.skipIf(!enabled)('Windows NTFS Comfy video one-shot ledger acceptance', () => {
  it('keeps the legacy JSON journal Windows refusal intact', async () => {
    const { root, volume } = await ntfsRoot()
    const task = binding()
    const legacy = new ComfyVideoAttemptLedger(join(root, 'legacy.json'), storeFor(task))
    await expect(legacy.reserve(task, contractDigest, graphSha256))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_DURABILITY_UNAVAILABLE')
    witness('legacy-guard', { ...volume, refusedBeforeJournalWrite: true })
  })

  it('creates the database once under concurrent first provision and recovers its first intent', async () => {
    const { root, volume } = await ntfsRoot()
    const path = join(root, 'private', 'attempts.sqlite')
    const code = `const { provisionComfyVideoSqliteAttemptLedger: provision } = await import(${JSON.stringify(source)});
      process.stdout.write('READY\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      try { await provision(process.argv[1]); process.stdout.write('PROVISIONED\\n'); }
      catch { process.stdout.write('REFUSED\\n'); }`
    const first = runChild(code, [path])
    const second = runChild(code, [path])
    await Promise.all([first.waitFor('READY'), second.waitFor('READY')])
    first.process.stdin!.end('GO\n')
    second.process.stdin!.end('GO\n')
    const exits = await Promise.all([first.exit, second.exit])
    expect(exits.every(exit => exit.code === 0)).toBe(true)
    const outcomes = [first.output(), second.output()]
    expect(outcomes.filter(output => output.includes('PROVISIONED'))).toHaveLength(1)
    expect(outcomes.filter(output => output.includes('REFUSED'))).toHaveLength(1)
    const checked = new DatabaseSync(path, { readOnly: true })
    try {
      expect(Number(checked.prepare('PRAGMA application_id').get()?.application_id)).toBe(0x51534356)
      expect(Number(checked.prepare('PRAGMA user_version').get()?.user_version)).toBe(1)
      expect(checked.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
      expect(checked.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
    } finally { checked.close() }
    const task = binding()
    const ledger = new ComfyVideoSqliteAttemptLedger(path, storeFor(task))
    expect(await ledger.recoverAtStartup()).toMatchObject({ state: 'none' })
    const reserved = await ledger.reserve(task, contractDigest, graphSha256)
    await ledger.beforePromptSubmit(reserved)
    const restarted = new ComfyVideoSqliteAttemptLedger(path, storeFor(task))
    expect(await restarted.recoverAtStartup()).toMatchObject({ state: 'unknown',
      record: { state: 'submitting', promptId: null } })
    witness('first-create', { ...volume, firstPid: first.process.pid, secondPid: second.process.pid,
      provisioned: 1, refused: 1, dbBytes: await size(path), recovered: 'unknown' })
  })

  it('refuses to reconstruct an interrupted first database creation', async () => {
    const { root, volume } = await ntfsRoot()
    const privateDir = join(root, 'interrupted-private')
    await mkdir(privateDir)
    const path = join(privateDir, 'attempts.sqlite')
    const task = binding()
    await expect(new ComfyVideoSqliteAttemptLedger(path, storeFor(task)).recoverAtStartup())
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_SQLITE_STORAGE_UNVERIFIED', status: 503 })
    await expect(provisionComfyVideoSqliteAttemptLedger(path))
      .rejects.toMatchObject({ code: 'COMPUTE_COMFY_VIDEO_SQLITE_STORAGE_UNVERIFIED', status: 503 })
    expect(await size(path)).toBeNull()
    witness('interrupted-first-create', { ...volume, dedicatedDirectoryExists: true,
      dbBytes: null, recoveryStatus: 503, reprovisionStatus: 503 })
  })

  it('allows only one process to reserve and POST the same task', async () => {
    const { root, volume } = await ntfsRoot()
    const path = join(root, 'private', 'attempts.sqlite')
    await provisionComfyVideoSqliteAttemptLedger(path)
    const task = binding()
    const server = await fakePromptServer()
    const code = `const { ComfyVideoSqliteAttemptLedger: Ledger } = await import(${JSON.stringify(source)});
      ${childStoreCode()}
      const ledger = new Ledger(process.argv[1], store);
      await ledger.recoverAtStartup();
      process.stdout.write('READY\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      try {
        const reserved = await ledger.reserve(binding, process.argv[3], process.argv[4]);
        await ledger.beforePromptSubmit(reserved);
        process.stdout.write('AUTHORIZED\\n');
        await fetch('http://127.0.0.1:' + process.argv[5] + '/prompt',
          { method: 'POST', body: '{}' });
      } catch { process.stdout.write('REFUSED\\n'); }`
    const args = [path, JSON.stringify(task), contractDigest, graphSha256, String(server.port)]
    const first = runChild(code, args)
    const second = runChild(code, args)
    await Promise.all([first.waitFor('READY'), second.waitFor('READY')])
    first.process.stdin!.end('GO\n')
    second.process.stdin!.end('GO\n')
    const exits = await Promise.all([first.exit, second.exit])
    expect(exits.every(exit => exit.code === 0)).toBe(true)
    expect([first.output(), second.output()].filter(output => output.includes('AUTHORIZED'))).toHaveLength(1)
    expect(server.count()).toBe(1)
    const reopened = new ComfyVideoSqliteAttemptLedger(path, storeFor(task))
    expect(await reopened.recoverAtStartup()).toMatchObject({ state: 'unknown' })
    witness('same-task-race', { ...volume, firstPid: first.process.pid, secondPid: second.process.pid,
      firstExit: exits[0]?.code, secondExit: exits[1]?.code, postCount: server.count(),
      dbBytes: await size(path), walBytes: await size(`${path}-wal`) })
  })

  it('does not send a second POST after a process dies with an unknown response', async () => {
    const { root, volume } = await ntfsRoot()
    const path = join(root, 'private', 'attempts.sqlite')
    await provisionComfyVideoSqliteAttemptLedger(path)
    const task = binding()
    const ledger = new ComfyVideoSqliteAttemptLedger(path, storeFor(task))
    await ledger.recoverAtStartup()
    const reserved = await ledger.reserve(task, contractDigest, graphSha256)
    const server = await fakePromptServer(true)
    const code = `const { ComfyVideoSqliteAttemptLedger: Ledger } = await import(${JSON.stringify(source)});
      ${childStoreCode()}
      const reserved = JSON.parse(process.argv[3]);
      const ledger = new Ledger(process.argv[1], store);
      await ledger.recoverAtStartup();
      await ledger.beforePromptSubmit(reserved);
      process.stdout.write('INTENT_COMMITTED\\n');
      await fetch('http://127.0.0.1:' + process.argv[4] + '/prompt',
        { method: 'POST', body: '{}' });`
    const client = runChild(code, [path, JSON.stringify(task), JSON.stringify(reserved), String(server.port)])
    await client.waitFor('INTENT_COMMITTED')
    await withTimeout(server.seen, 'fake /prompt POST')
    const killed = await kill(client)
    const restartCode = `const { ComfyVideoSqliteAttemptLedger: Ledger } = await import(${JSON.stringify(source)});
      ${childStoreCode()}
      const reserved = JSON.parse(process.argv[3]);
      const ledger = new Ledger(process.argv[1], store);
      const state = await ledger.recoverAtStartup();
      if (state.state !== 'unknown') process.exit(3);
      try { await ledger.beforePromptSubmit(reserved); process.exit(4); }
      catch { process.stdout.write('REPOST_BLOCKED\\n'); }`
    const restarted = runChild(restartCode, [path, JSON.stringify(task), JSON.stringify(reserved)])
    expect((await restarted.exit).code).toBe(0)
    expect(restarted.output()).toContain('REPOST_BLOCKED')
    expect(server.count()).toBe(1)
    witness('unknown-post', { ...volume, clientPid: client.process.pid, clientExit: killed.code,
      clientSignal: killed.signal, restartPid: restarted.process.pid, postCount: server.count(),
      dbBytes: await size(path), walBytes: await size(`${path}-wal`),
      shmBytes: await size(`${path}-shm`) })
  })

  it('recovers a committed intent from surviving WAL and SHM after killing the owning processes', async () => {
    const { root, volume } = await ntfsRoot()
    const path = join(root, 'private', 'attempts.sqlite')
    await provisionComfyVideoSqliteAttemptLedger(path)
    const task = binding()
    const ledger = new ComfyVideoSqliteAttemptLedger(path, storeFor(task))
    await ledger.recoverAtStartup()
    const reserved = await ledger.reserve(task, contractDigest, graphSha256)
    const readerCode = `const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN');
      db.prepare('SELECT count(*) AS total FROM attempts').get();
      process.stdout.write('READER_OPEN\\n');
      setInterval(() => {}, 1000);`
    const reader = runChild(readerCode, [path])
    await reader.waitFor('READER_OPEN')
    const writerCode = `const { ComfyVideoSqliteAttemptLedger: Ledger } = await import(${JSON.stringify(source)});
      ${childStoreCode()}
      const reserved = JSON.parse(process.argv[3]);
      const ledger = new Ledger(process.argv[1], store);
      await ledger.recoverAtStartup();
      await ledger.beforePromptSubmit(reserved);
      process.stdout.write('INTENT_COMMITTED\\n');
      setInterval(() => {}, 1000);`
    const writer = runChild(writerCode, [path, JSON.stringify(task), JSON.stringify(reserved)])
    await writer.waitFor('INTENT_COMMITTED')
    const walBefore = await size(`${path}-wal`)
    const shmBefore = await size(`${path}-shm`)
    expect(walBefore).not.toBeNull()
    expect(walBefore).toBeGreaterThan(0)
    expect(shmBefore).not.toBeNull()
    expect(shmBefore).toBeGreaterThan(0)
    const writerExit = await kill(writer)
    const readerExit = await kill(reader)
    const walAfterKill = await size(`${path}-wal`)
    const shmAfterKill = await size(`${path}-shm`)
    expect(walAfterKill).not.toBeNull()
    expect(walAfterKill).toBeGreaterThan(0)
    expect(shmAfterKill).not.toBeNull()
    expect(shmAfterKill).toBeGreaterThan(0)
    const mainOnlyPath = join(root, 'main-file-only.sqlite')
    await copyFile(path, mainOnlyPath)
    const mainOnly = new DatabaseSync(mainOnlyPath, { readOnly: true })
    let mainOnlyState: unknown
    try {
      const row = mainOnly.prepare('SELECT record_json FROM attempts ORDER BY seq DESC LIMIT 1').get()
      mainOnlyState = JSON.parse(String(row?.record_json)).state
      expect(mainOnlyState).toBe('reserved')
    } finally { mainOnly.close() }
    const restarted = new ComfyVideoSqliteAttemptLedger(path, storeFor(task))
    expect(await restarted.recoverAtStartup()).toMatchObject({ state: 'unknown',
      record: { state: 'submitting', promptId: null } })
    await expect(restarted.beforePromptSubmit(reserved)).rejects.toThrow()
    const checked = new DatabaseSync(path, { readOnly: true })
    try { expect(checked.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok') }
    finally { checked.close() }
    witness('wal-shm-recovery', { ...volume, readerPid: reader.process.pid, writerPid: writer.process.pid,
      readerExit: readerExit.code, writerExit: writerExit.code, dbBytes: await size(path),
      walBytesBeforeKill: walBefore, shmBytesBeforeKill: shmBefore,
      walBytesAfterKill: walAfterKill, shmBytesAfterKill: shmAfterKill,
      mainOnlyState, recovered: 'unknown', postCount: 0 })
  })

  it('rejects a later attempt for a task already submitted before another completed task', async () => {
    const { root, volume } = await ntfsRoot()
    const taskA = binding()
    const taskB: ResidentAttempt = { ...binding(), taskId: 'ntfs-video-task-2',
      idempotencyKey: 'ntfs-key-2', envelopeFingerprint: 'e'.repeat(64) }
    const retryA: ResidentAttempt = { ...binding(), attempt: 2,
      idempotencyKey: 'ntfs-key-3', envelopeFingerprint: 'f'.repeat(64) }
    const assignments = [taskA, taskB, retryA]
    const statuses = new Map<string, 'EXECUTING' | 'SETTLED'>([
      [`${taskA.taskId}:${taskA.attempt}`, 'EXECUTING'],
      [`${taskB.taskId}:${taskB.attempt}`, 'EXECUTING'],
      [`${retryA.taskId}:${retryA.attempt}`, 'EXECUTING'],
    ])
    const store = { get: async (taskId: string, attempt: number) => {
      const assigned = assignments.find(value => value.taskId === taskId && value.attempt === attempt)
      const status = statuses.get(`${taskId}:${attempt}`)
      return assigned && status ? { status, envelopeFingerprint: assigned.envelopeFingerprint,
        idempotencyKey: assigned.idempotencyKey, leaseExpiresAt: assigned.leaseExpiresAt } : undefined
    } } as unknown as Pick<ComputeTaskStore, 'get'>
    const path = join(root, 'private', 'attempts.sqlite')
    await provisionComfyVideoSqliteAttemptLedger(path)
    const ledger = new ComfyVideoSqliteAttemptLedger(path, store)
    await ledger.recoverAtStartup()
    const first = await ledger.reserve(taskA, contractDigest, graphSha256)
    await ledger.beforePromptSubmit(first)
    await ledger.recordPromptId(first, 'cfae9e4d-7443-4e8d-8d44-32f89ab478a2')
    await ledger.recordLocalResult(first, '1'.repeat(64))
    statuses.set(`${taskA.taskId}:${taskA.attempt}`, 'SETTLED')
    const second = await ledger.reserve(taskB, contractDigest, graphSha256)
    await ledger.beforePromptSubmit(second)
    await ledger.recordPromptId(second, 'e4a0a318-f0d0-4083-ae99-e645e4bcb4a5')
    await ledger.recordLocalResult(second, '2'.repeat(64))
    statuses.set(`${taskB.taskId}:${taskB.attempt}`, 'SETTLED')
    await expect(ledger.reserve(retryA, contractDigest, graphSha256)).rejects.toThrow()

    const unknownPath = join(root, 'private-unknown', 'attempts.sqlite')
    await provisionComfyVideoSqliteAttemptLedger(unknownPath)
    statuses.set(`${taskA.taskId}:${taskA.attempt}`, 'EXECUTING')
    const unknown = new ComfyVideoSqliteAttemptLedger(unknownPath, store)
    await unknown.recoverAtStartup()
    const unresolved = await unknown.reserve(taskA, contractDigest, graphSha256)
    await unknown.beforePromptSubmit(unresolved)
    await expect(unknown.reserve(retryA, contractDigest, graphSha256)).rejects.toThrow()
    witness('task-history', { ...volume, firstDbBytes: await size(path), unknownDbBytes: await size(unknownPath),
      priorTaskSubmitted: true, interveningTaskCompleted: true, laterAttemptRejected: true,
      unknownLaterAttemptRejected: true, postCount: 0 })
  })
})
