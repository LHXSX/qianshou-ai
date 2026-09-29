import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { H3ExecutionCoordinator, type H3ExecutionIntent, type H3TrialTransaction } from '../src/h3-execution-coordinator.ts'
import { H3OwnerSetup } from '../src/h3-owner-setup.ts'

const source = new URL('../src/h3-execution-coordinator.ts', import.meta.url).href
const project = fileURLToPath(new URL('../../../../', import.meta.url))
const intent: H3ExecutionIntent = { runtime: 'canonical', bindingSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64) }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
const children: { process: ChildProcessWithoutNullStreams; closed: Promise<void> }[] = []
const setups: H3OwnerSetup[] = []
const gates: (() => void)[] = []
const running: Promise<void>[] = []

afterEach(async () => {
  vi.doUnmock('node:fs/promises'); vi.resetModules()
  for (const child of children.splice(0)) {
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill()
    await child.closed
  }
  for (const finish of gates.splice(0)) finish()
  await Promise.all(running.splice(0))
  for (const setup of setups.splice(0)) await setup.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function home(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'h3-execution-coordinator-'))
  roots.push(root)
  return root
}

function setup(root: string, owner: () => number = () => 167): H3OwnerSetup {
  const result = new H3OwnerSetup({ homePath: root, runtimeDirectory: join(root, 'unused-runtime'),
    readScope: async () => ({ ownerId: owner(), profileDir: root }), assertIdle: async () => {},
    onSaved: async () => {}, program: async () => { throw new Error('No GPU/program port is allowed in this fixture') } })
  setups.push(result)
  return result
}

function gate() {
  let resolve: () => void = () => { throw new Error('gate not initialized') }
  const promise = new Promise<void>((accept) => { resolve = accept })
  gates.push(resolve)
  return { promise, resolve }
}

function observe<T>(promise: Promise<T>): Promise<T> {
  running.push(promise.then(() => {}, () => {}))
  return promise
}

function childRow(line: string): { state: string; code?: string } {
  const value: unknown = JSON.parse(line)
  if (value === null || typeof value !== 'object' || !('state' in value) || typeof value.state !== 'string') {
    throw new Error('Invalid owned CPU child event')
  }
  if ('code' in value) {
    if (typeof value.code !== 'string') throw new Error('Invalid owned CPU child error')
    return { state: value.state, code: value.code }
  }
  return { state: value.state }
}

function child(root: string, runtime: H3ExecutionIntent['runtime']) {
  const script = `
    import { createInterface } from 'node:readline';
    import { createHash } from 'node:crypto';
    import { H3ExecutionCoordinator } from ${JSON.stringify(source)};
    const input = createInterface({input:process.stdin})[Symbol.asyncIterator]();
    const emit = (row) => process.stdout.write(JSON.stringify(row)+'\\n');
    const coordinator = new H3ExecutionCoordinator(${JSON.stringify(root)}, async()=>{});
    emit({state:'ready'}); await input.next();
    try {
      await coordinator.runReserved(${JSON.stringify({ ...intent, runtime })}, async()=>{
        emit({state:'executed'}); await input.next(); return 'CPU fixture output';
      }, async result=>createHash('sha256').update(result).digest('hex'));
      emit({state:'completed'});
    } catch(error) { emit({state:'rejected',code:error.code}); }
    process.stdin.destroy();
  `
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', script], {
    cwd: project, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  process.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8') })
  const closed = new Promise<void>((resolve, reject) => {
    process.once('error', reject)
    process.once('close', (code, signal) => {
      if (code !== 0 && signal === null) reject(new Error(`CPU child exited ${code}: ${stderr}`))
      else resolve()
    })
  })
  // Observe a rejection immediately even if cleanup later has to terminate the owned child.
  void closed.catch(() => {})
  children.push({ process, closed })
  const rows: { state: string; code?: string }[] = []
  const waiting: { state: string; resolve: () => void; reject: (error: Error) => void }[] = []
  const reader = createInterface({ input: process.stdout })
  reader.on('line', (line) => {
    const row = childRow(line); rows.push(row)
    for (const listener of waiting.filter(value => value.state === row.state)) {
      waiting.splice(waiting.indexOf(listener), 1); listener.resolve()
    }
  })
  const settle = () => {
    for (const listener of waiting.splice(0)) listener.reject(new Error(`CPU child closed before ${listener.state}: ${stderr}`))
  }
  void closed.then(settle, settle)
  const wait = (state: string): Promise<void> => {
    if (rows.some(row => row.state === state)) return Promise.resolve()
    if (process.exitCode !== null || process.signalCode !== null) return Promise.reject(new Error(`CPU child already closed before ${state}`))
    return new Promise((resolve, reject) => { waiting.push({ state, resolve, reject }) })
  }
  return { process, closed, rows, wait, send: () => { process.stdin.write('continue\n') } }
}

it('two actual Node processes share one wx reservation across V2/canonical and only the winner executes', async () => {
  const root = await home()
  const a = child(root, 'v2'); const b = child(root, 'canonical')
  await Promise.all([a.wait('ready'), b.wait('ready')])
  a.send(); b.send()
  const winner = await Promise.any([a.wait('executed').then(() => a), b.wait('executed').then(() => b)])
  await Promise.any([a.wait('rejected'), b.wait('rejected')])
  expect([...a.rows, ...b.rows].filter(row => row.state === 'executed')).toHaveLength(1)
  expect([...a.rows, ...b.rows].filter(row => row.code === 'H3_SETUP_BUSY')).toHaveLength(1)
  const pending: unknown = JSON.parse(await readFile(join(root, 'qianshou-h3-owner', 'execution-reservation.json'), 'utf8'))
  expect(pending).toMatchObject({ state: 'pending', bindingSha256: intent.bindingSha256, inputSha256: intent.inputSha256 })
  expect(await setup(root).readTrialAdmission()).toEqual({ state: 'unknown' })
  winner.send(); await Promise.all([a.closed, b.closed])
  expect([...a.rows, ...b.rows].filter(row => row.state === 'executed')).toHaveLength(1)
  expect(JSON.parse(await readFile(join(root, 'qianshou-h3-owner', 'execution-reservation.json'), 'utf8')))
    .toMatchObject({ state: 'completed', outputSha256: sha('CPU fixture output') })
  await expect(readFile(join(root, 'qianshou-h3-owner', '.trial-lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await setup(root).readTrialAdmission()).toEqual({ state: 'clear' })
})

it('an actual killed process leaves pending evidence and a fresh process cannot execute or clean it', async () => {
  const root = await home(); const a = child(root, 'canonical')
  await a.wait('ready'); a.send(); await a.wait('executed')
  const path = join(root, 'qianshou-h3-owner', '.trial-lock'); const lock = await readFile(path)
  const journalPath = join(dirname(path), 'execution-reservation.json'); const pending = await readFile(journalPath)
  a.process.kill(); await a.closed
  const b = child(root, 'v2')
  await b.wait('ready'); b.send(); await b.closed
  expect(b.rows).toContainEqual({ state: 'rejected', code: 'H3_SETUP_BUSY' })
  expect(b.rows.some(row => row.state === 'executed')).toBe(false)
  expect(await setup(root, () => 168).readTrialAdmission()).toEqual({ state: 'unknown' })
  expect(await readFile(path)).toEqual(lock); expect(await readFile(journalPath)).toEqual(pending)
})

it('the Host seam rechecks actual auth before terminal confirmation and retains an owner change as unknown', async () => {
  const root = await home(); let owner = 167
  const controller = setup(root, () => owner); const entered = gate(); const finish = gate()
  const execute = vi.fn(async () => { entered.resolve(); await finish.promise; return 'CPU result' })
  const verify = vi.fn(async (result: string) => sha(result))
  const result = observe(controller.runReservedExecution(intent, execute, verify))
  const rejection = expect(result).rejects.toMatchObject({ code: 'H3_SETUP_OWNER_CHANGED' })
  await entered.promise; owner = 168; finish.resolve(); await rejection
  expect(execute).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled()
  expect(await setup(root, () => 168).readTrialAdmission()).toEqual({ state: 'unknown' })
  expect(JSON.parse(await readFile(join(root, 'qianshou-h3-owner', 'execution-reservation.json'), 'utf8')))
    .toMatchObject({ state: 'unknown' })
})

it('an old V2 clear record cannot release an active new reservation or admit another short transaction', async () => {
  const root = await home(); const coordinator = new H3ExecutionCoordinator(root, async () => {})
  const entered = gate(); const finish = gate()
  const running = observe(coordinator.runReserved(intent,
    async () => { entered.resolve(); await finish.promise; return 'output' }, async result => sha(result)))
  await entered.promise
  const path = join(root, 'qianshou-h3-owner', '.trial-lock'); const bytes = await readFile(path)
  await writeFile(join(dirname(path), 'trial-guard.json'), JSON.stringify({ schema: 'qianshou.h3-owner-trial-guard.v1',
    state: 'clear' }), { mode: 0o600 })
  const action = vi.fn(async () => {})
  await expect(new H3ExecutionCoordinator(root, async () => {}).withTransaction(action)).rejects.toMatchObject({ code: 'H3_SETUP_BUSY' })
  await expect(setup(root).assertTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(action).not.toHaveBeenCalled(); expect(await readFile(path)).toEqual(bytes)
  finish.resolve(); await running
})

it.each(['pending', 'unknown'])('old V2 %s blocks a new reserved execution without rewriting the old schema', async (state) => {
  const root = await home(); const privateRoot = join(root, 'qianshou-h3-owner'); await mkdir(privateRoot, { mode: 0o700 })
  const path = join(privateRoot, 'trial-guard.json')
  const bytes = Buffer.from(JSON.stringify({ schema: 'qianshou.h3-owner-trial-guard.v1', state,
    scopeId: 'a'.repeat(64), revision: 1, operationId: '00000000-0000-4000-8000-000000000001',
    configSha256: 'b'.repeat(64), startedAt: 1 }))
  await writeFile(path, bytes, { mode: 0o600 })
  const execute = vi.fn(async () => 'output')
  await expect(setup(root).runReservedExecution(intent, execute, async result => sha(result))).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNSETTLED' })
  expect(execute).not.toHaveBeenCalled(); expect(await readFile(path)).toEqual(bytes)
  await expect(readFile(join(privateRoot, 'execution-reservation.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['execute', 'verify'])('a %s failure retains unknown and never calls the execution port on restart', async (boundary) => {
  const root = await home(); const coordinator = new H3ExecutionCoordinator(root, async () => {})
  const execute = vi.fn(async () => { if (boundary === 'execute') throw new Error('CPU execution uncertain'); return 'output' })
  await expect(coordinator.runReserved(intent, execute, async () => { throw new Error('CPU terminal uncertain') })).rejects.toThrow('uncertain')
  const before = await readFile(join(root, 'qianshou-h3-owner', '.trial-lock'))
  const next = vi.fn(async () => 'next')
  await expect(new H3ExecutionCoordinator(root, async () => {}).runReserved(intent, next, async result => sha(result)))
    .rejects.toMatchObject({ code: 'H3_SETUP_BUSY' })
  expect(next).not.toHaveBeenCalled(); expect(execute).toHaveBeenCalledOnce()
  expect(await readFile(join(root, 'qianshou-h3-owner', '.trial-lock'))).toEqual(before)
})

it.each(['same-inode', 'replacement'])('foreign %s mutex bytes are preserved rather than removed by terminal cleanup', async (boundary) => {
  const root = await home(); const coordinator = new H3ExecutionCoordinator(root, async () => {})
  const entered = gate(); const finish = gate()
  const result = observe(coordinator.runReserved(intent,
    async () => { entered.resolve(); await finish.promise; return 'output' }, async result => sha(result)))
  const rejection = expect(result).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  await entered.promise
  const path = join(root, 'qianshou-h3-owner', '.trial-lock'); const inode = (await lstat(path)).ino
  if (boundary === 'replacement') await unlink(path)
  const foreign = Buffer.from('foreign mutex mutation, never owned by the old token')
  await writeFile(path, foreign, { mode: 0o600 })
  if (boundary === 'same-inode') expect((await lstat(path)).ino).toBe(inode)
  finish.resolve(); await rejection
  expect(await readFile(path)).toEqual(foreign)
  expect(await setup(root).readTrialAdmission()).toEqual({ state: 'unknown' })
})

it('short V2 transaction tokens assert same-fd bytes and retain foreign mutations on cleanup', async () => {
  const root = await home(); const coordinator = new H3ExecutionCoordinator(root, async () => {})
  const path = join(root, 'qianshou-h3-owner', '.trial-lock')
  await expect(coordinator.withTransaction(async (transaction) => {
    expect(Object.keys(transaction).sort()).toEqual(['assertOwned', 'committed', 'retain'])
    await transaction.assertOwned()
    await writeFile(path, 'foreign bytes', { mode: 0o600 })
    await transaction.assertOwned()
  })).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  expect(await readFile(path, 'utf8')).toBe('foreign bytes')
})

it('a completed old short transaction token cannot release or inspect a newer reservation', async () => {
  const root = await home(); const coordinator = new H3ExecutionCoordinator(root, async () => {})
  let previous: H3TrialTransaction | undefined
  await coordinator.withTransaction(async (transaction) => { previous = transaction })
  if (!previous) throw new Error('missing owned transaction fixture')
  const entered = gate(); const finish = gate()
  const result = observe(coordinator.runReserved(intent, async () => { entered.resolve(); await finish.promise; return 'output' },
    async value => sha(value)))
  await entered.promise
  const path = join(root, 'qianshou-h3-owner', '.trial-lock'); const bytes = await readFile(path)
  await expect(previous.assertOwned()).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  expect(() => previous?.committed()).toThrow('H3_SETUP_TRIAL_GUARD_INVALID')
  expect(await readFile(path)).toEqual(bytes)
  finish.resolve(); await result
})

it('a newly verified explicit reservation uses a fresh operation and mutex nonce after a completed predecessor', async () => {
  const root = await home(); const coordinator = new H3ExecutionCoordinator(root, async () => {})
  const nonces: string[] = []; const operations: string[] = []
  const execute = vi.fn(async () => {
    nonces.push(await readFile(join(root, 'qianshou-h3-owner', '.trial-lock'), 'utf8'))
    operations.push(await readFile(join(root, 'qianshou-h3-owner', 'execution-reservation.json'), 'utf8'))
    return 'CPU verified output'
  })
  await coordinator.runReserved(intent, execute, async value => sha(value))
  await coordinator.runReserved({ ...intent, runtime: 'v2' }, execute, async value => sha(value))
  expect(execute).toHaveBeenCalledTimes(2)
  expect(nonces[0]).not.toBe(nonces[1]); expect(operations[0]).not.toBe(operations[1])
  expect(await setup(root).readTrialAdmission()).toEqual({ state: 'clear' })
})

async function faultCoordinator(root: string, boundary: string) {
  const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let journals = 0; let directories = 0; let failures = 0
  vi.doMock('node:fs/promises', () => ({ ...filesystem, async open(...args: Parameters<typeof filesystem.open>) {
    const path = String(args[0]); const handle = await filesystem.open(...args)
    const journal = path.includes('.execution-write-')
    if (journal) journals++
    const ordinal = journals
    const originalWrite = handle.writeFile.bind(handle); const originalSync = handle.sync.bind(handle)
    if (path === join(root, 'qianshou-h3-owner')) directories++
    const directoryOrdinal = directories
    const fail = () => { failures++; throw Object.assign(new Error('test-owned durable EIO'), { code: 'EIO' }) }
    handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
      if (boundary === 'partial-pending-write' && journal && ordinal === 1 && failures === 0) {
        await originalWrite('partial pending'); return fail()
      }
      return originalWrite(...values)
    }
    handle.sync = async () => {
      const targeted = boundary === 'mutex-sync' && path.endsWith('.trial-lock')
        || boundary === 'pending-sync' && journal && ordinal === 1
        || boundary === 'terminal-sync' && journal && ordinal === 2
        || boundary === 'pending-directory' && path === join(root, 'qianshou-h3-owner') && directoryOrdinal === 2
        || boundary === 'terminal-directory' && path === join(root, 'qianshou-h3-owner') && directoryOrdinal === 3
        || boundary === 'release-directory' && path === join(root, 'qianshou-h3-owner') && directoryOrdinal === 4
      if (targeted && failures === 0) return fail()
      return originalSync()
    }
    return handle
  } }))
  vi.resetModules()
  const { H3ExecutionCoordinator: ActualCoordinator } = await import('../src/h3-execution-coordinator.ts')
  return { coordinator: new ActualCoordinator(root, async () => {}), failures: () => failures }
}

it.each(['mutex-sync', 'partial-pending-write', 'pending-sync', 'terminal-sync'])(
  'retains a restart-blocking marker after actual %s failure', async (boundary) => {
    const root = await home(); const faulty = await faultCoordinator(root, boundary)
    const execute = vi.fn(async () => 'CPU output')
    await expect(faulty.coordinator.runReserved(intent, execute, async result => sha(result))).rejects.toMatchObject({ code: 'EIO' })
    expect(faulty.failures()).toBe(1)
    expect(execute).toHaveBeenCalledTimes(boundary === 'terminal-sync' ? 1 : 0)
    expect(await readFile(join(root, 'qianshou-h3-owner', '.trial-lock'))).not.toHaveLength(0)
    expect(await setup(root, () => 168).readTrialAdmission()).toEqual({ state: 'unknown' })
    const next = vi.fn(async () => 'next')
    await expect(new H3ExecutionCoordinator(root, async () => {}).runReserved(intent, next, async result => sha(result)))
      .rejects.toMatchObject({ code: 'H3_SETUP_BUSY' })
    expect(next).not.toHaveBeenCalled()
  })

it.skipIf(process.platform === 'win32').each(['pending-directory', 'terminal-directory', 'release-directory'])(
  'retains a restart-blocking marker after POSIX %s fsync failure', async (boundary) => {
    const root = await home(); const faulty = await faultCoordinator(root, boundary)
    const execute = vi.fn(async () => 'CPU output')
    await expect(faulty.coordinator.runReserved(intent, execute, async result => sha(result))).rejects.toMatchObject({ code: 'EIO' })
    expect(faulty.failures()).toBe(1); expect(execute).toHaveBeenCalledTimes(boundary === 'pending-directory' ? 0 : 1)
    expect(await readFile(join(root, 'qianshou-h3-owner', '.trial-lock'))).not.toHaveLength(0)
    expect(await setup(root, () => 168).readTrialAdmission()).toEqual({ state: 'unknown' })
  })

it('strictly rejects malformed/oversized journal evidence without deleting it or executing a port', async () => {
  const root = await home(); const privateRoot = join(root, 'qianshou-h3-owner'); await mkdir(privateRoot, { mode: 0o700 })
  const bytes = Buffer.alloc(4097, 65); const path = join(privateRoot, 'execution-reservation.json')
  await writeFile(path, bytes, { mode: 0o600 }); const execute = vi.fn(async () => 'output')
  await expect(new H3ExecutionCoordinator(root, async () => {}).runReserved(intent, execute, async result => sha(result)))
    .rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  expect(execute).not.toHaveBeenCalled(); expect(await readFile(path)).toEqual(bytes)
  await expect(setup(root).readTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
})

it('contradictory duplicate state keys cannot turn pending owned journal bytes into completed admission', async () => {
  const root = await home(); const privateRoot = join(root, 'qianshou-h3-owner'); await mkdir(privateRoot, { mode: 0o700 })
  const path = join(privateRoot, 'execution-reservation.json')
  const completed = JSON.stringify({ schema: 'qianshou.h3-execution-reservation.v1',
    operationId: '00000000-0000-4000-8000-000000000001', ...intent, startedAt: 1,
    state: 'completed', finishedAt: 2, outputSha256: 'c'.repeat(64) })
  const bytes = Buffer.from(completed.replace('"state":"completed"', '"state":"pending","state":"completed"'))
  await writeFile(path, bytes, { mode: 0o600 })
  const controller = setup(root); const execute = vi.fn(async () => 'output')
  await expect(controller.readTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  await expect(controller.runReservedExecution(intent, execute, async result => sha(result)))
    .rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  expect(execute).not.toHaveBeenCalled(); expect(await readFile(path)).toEqual(bytes)
})

it('unknown journal evidence stays blocking even when its old marker is absent', async () => {
  const root = await home(); const privateRoot = join(root, 'qianshou-h3-owner'); await mkdir(privateRoot, { mode: 0o700 })
  const path = join(privateRoot, 'execution-reservation.json')
  const bytes = Buffer.from(JSON.stringify({ schema: 'qianshou.h3-execution-reservation.v1',
    operationId: '00000000-0000-4000-8000-000000000001', ...intent, startedAt: 1, state: 'unknown' }))
  await writeFile(path, bytes, { mode: 0o600 }); const execute = vi.fn(async () => 'output')
  await expect(setup(root).runReservedExecution(intent, execute, async result => sha(result)))
    .rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(execute).not.toHaveBeenCalled(); expect(await readFile(path)).toEqual(bytes)
  expect(await setup(root).readTrialAdmission()).toEqual({ state: 'unknown' })
})
