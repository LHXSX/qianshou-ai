/** Host-only reservations shared by H3 versions in one normal DSH_HOME. */
import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, normalize, parse } from 'node:path'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'

const LIMIT = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const HASH = /^[0-9a-f]{64}$/u
const identity = (stat: Stats): string => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':')
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b)
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))
function invalid(): never { throw new ComputeError('H3_SETUP_TRIAL_GUARD_INVALID', 409) }

/** Internal short-transaction capability; no path, nonce or release flag is accepted from a caller. */
export interface H3TrialTransaction {
  /** Check the original open file, pathname and immutable nonce bytes. */
  assertOwned(): Promise<void>
  /** Keep the mutex if subsequent durable commits cannot be confirmed. */
  retain(): void
  /** Permit cleanup only after the owning short transaction committed every required record. */
  committed(): void
}

/** Local reservation fingerprints; these are not a device proof or a platform completion. */
export interface H3ExecutionIntent {
  readonly runtime: 'v2' | 'canonical'
  readonly bindingSha256: string
  readonly inputSha256: string
}

interface Mutex {
  handle: FileHandle
  stat: Stats
  bytes: Buffer
  directory: Stats
}
interface Journal {
  schema: 'qianshou.h3-execution-reservation.v1'
  operationId: string
  runtime: 'v2' | 'canonical'
  bindingSha256: string
  inputSha256: string
  startedAt: number
  state: 'pending' | 'unknown' | 'completed'
  finishedAt?: number
  outputSha256?: string
}
interface Record { value: Journal; bytes: Buffer; stat: Stats }

function ownedFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && (!process.getuid
    || stat.uid === process.getuid() && (stat.mode & 0o077) === 0)
}

/** Private filesystem owner; callers must supply the actual normal Harness home, never a client path. */
export class H3ExecutionCoordinator {
  private readonly root: string
  private readonly mutexPath: string
  private readonly journalPath: string

  /** Construct an internal coordinator without reading files or executing work.
   * @param homePath - Trusted absolute normal DSH_HOME.
   * @param requireClear - Owning Host check of old trial/legacy state while this coordinator holds the mutex.
   */
  constructor(homePath: string, private readonly requireClear: () => Promise<void>) {
    if (!isAbsolute(homePath) || homePath.includes('\0')) invalid()
    this.root = join(homePath, 'qianshou-h3-owner')
    this.mutexPath = join(this.root, '.trial-lock')
    this.journalPath = join(this.root, 'execution-reservation.json')
  }

  private async directory(create: boolean): Promise<Stats> {
    let path = parse(this.root).root
    for (const part of this.root.slice(path.length).split(/[\\/]/u).filter(Boolean)) {
      path = join(path, part)
      if (create) {
        try { await mkdir(path, { mode: 0o700 }) }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        }
      }
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(path), path)) invalid()
    }
    const stat = await lstat(this.root)
    if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) invalid()
    return stat
  }

  private async syncDirectory(): Promise<void> {
    // Node cannot sync a directory handle on Windows; file sync remains required there.
    if (process.platform === 'win32') return
    const handle = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }

  private async bytes(handle: FileHandle): Promise<Buffer> {
    const result = Buffer.alloc(LIMIT + 1)
    let used = 0
    while (used < result.length) {
      const { bytesRead } = await handle.read(result, used, result.length - used, used)
      if (bytesRead === 0) break
      used += bytesRead
    }
    if (used > LIMIT) invalid()
    return result.subarray(0, used)
  }

  private async read(path: string): Promise<{ bytes: Buffer; stat: Stats }> {
    await this.directory(false)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!ownedFile(stat) || stat.size > LIMIT) invalid()
      const bytes = await this.bytes(handle)
      const named = await lstat(path)
      if (named.isSymbolicLink() || identity(stat) !== identity(named)
        || identity(stat) !== identity(await handle.stat()) || bytes.length !== stat.size) invalid()
      return { bytes, stat }
    } finally { await handle.close() }
  }

  private async journal(): Promise<Record | null> {
    let raw: { bytes: Buffer; stat: Stats }
    try { raw = await this.read(this.journalPath) }
    catch (error) { if (missing(error)) return null; throw error }
    let parsed: unknown
    try { parsed = JSON.parse(raw.bytes.toString('utf8')) } catch { return invalid() }
    // Only bytes produced by the owning writer are evidence: JSON.parse alone collapses duplicate keys.
    if (!encode(parsed).equals(raw.bytes)) invalid()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid()
    const row = parsed as { [key: string]: unknown }
    const keys = 'bindingSha256,inputSha256,operationId,runtime,schema,startedAt,state'
    const expected = row.state === 'completed' ? 'bindingSha256,finishedAt,inputSha256,operationId,outputSha256,runtime,schema,startedAt,state' : keys
    if (Object.keys(row).sort().join(',') !== expected || row.schema !== 'qianshou.h3-execution-reservation.v1'
      || typeof row.operationId !== 'string' || !UUID.test(row.operationId)
      || (row.runtime !== 'v2' && row.runtime !== 'canonical')
      || typeof row.bindingSha256 !== 'string' || !HASH.test(row.bindingSha256)
      || typeof row.inputSha256 !== 'string' || !HASH.test(row.inputSha256)
      || !Number.isSafeInteger(row.startedAt) || Number(row.startedAt) < 1
      || !['pending', 'unknown', 'completed'].includes(String(row.state))) invalid()
    if (row.state === 'completed' && (!Number.isSafeInteger(row.finishedAt) || Number(row.finishedAt) < Number(row.startedAt)
      || typeof row.outputSha256 !== 'string' || !HASH.test(row.outputSha256))) invalid()
    return { ...raw, value: parsed as Journal }
  }

  /** Observe retained local execution metadata without starting work or removing a mutex.
   * @returns True for a pending/unknown reservation; malformed or linked records fail closed.
   */
  async hasUnsettledExecution(): Promise<boolean> {
    const record = await this.journal()
    return record !== null && record.value.state !== 'completed'
  }

  private async acquire(): Promise<Mutex> {
    const directory = await this.directory(true)
    let handle: FileHandle
    try {
      handle = await open(this.mutexPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new ComputeError('H3_SETUP_BUSY', 409)
      throw error
    }
    const bytes = encode({ schema: 'qianshou.h3-trial-mutex.v1', nonce: randomUUID() })
    try {
      await handle.writeFile(bytes); await handle.sync(); await this.syncDirectory()
      const stat = await handle.stat()
      if (!ownedFile(stat)) invalid()
      const lock = { handle, stat, bytes, directory }
      await this.assertOwned(lock)
      return lock
    } catch (error) {
      // A partially written or unsynced exclusive file is retained for unknown admission.
      await handle.close()
      throw error
    }
  }

  private async assertOwned(lock: Mutex): Promise<void> {
    const directory = await this.directory(false)
    const named = await lstat(this.mutexPath)
    if (directory.dev !== lock.directory.dev || directory.ino !== lock.directory.ino
      || named.isSymbolicLink() || !ownedFile(named) || identity(named) !== identity(lock.stat)
      || identity(await lock.handle.stat()) !== identity(lock.stat)
      || !(await this.bytes(lock.handle)).equals(lock.bytes)) invalid()
    if (identity(await lstat(this.mutexPath)) !== identity(lock.stat)) invalid()
  }

  private async release(lock: Mutex): Promise<void> {
    await this.assertOwned(lock)
    await unlink(this.mutexPath)
    try { await this.syncDirectory() }
    catch (error) {
      // Failed unlink durability leaves an exclusive unresolved marker, never an automatic retry.
      let replacement: FileHandle | undefined
      try {
        replacement = await open(this.mutexPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await replacement.writeFile(lock.bytes); await replacement.sync()
      } catch { /* A foreign replacement or a partial marker is preserved. */ }
      finally { await replacement?.close() }
      throw error
    }
  }

  /** Run an existing short V2 transaction under the shared mutex without changing its record sequence.
   * @param action - Owning Host transaction; retain before ambiguous durable commits, committed after all succeed.
   * @returns The transaction result after ownership-checked cleanup, or its failure with retained metadata.
   */
  async withTransaction<T>(action: (transaction: H3TrialTransaction) => Promise<T>): Promise<T> {
    const lock = await this.acquire()
    const lifecycle = { release: true, active: true }
    const assertActive = () => { if (!lifecycle.active) invalid() }
    const transaction: H3TrialTransaction = Object.freeze({
      assertOwned: async () => { assertActive(); await this.assertOwned(lock) },
      retain: () => { assertActive(); lifecycle.release = false },
      committed: () => { assertActive(); lifecycle.release = true },
    })
    try {
      if (await this.hasUnsettledExecution()) throw new ComputeError('H3_SETUP_SELF_TEST_UNKNOWN', 409)
      return await action(transaction)
    } finally {
      lifecycle.active = false
      try { if (lifecycle.release) await this.release(lock) } finally { await lock.handle.close() }
    }
  }

  private async writeJournal(lock: Mutex, value: Journal, expected: Record | null): Promise<Record> {
    await this.assertOwned(lock)
    const bytes = encode(value)
    const temporary = join(this.root, '.execution-write-' + randomUUID())
    const handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let written: Stats | undefined
    try {
      await handle.writeFile(bytes); await handle.sync(); written = await handle.stat()
      const current = await this.journal()
      if (expected === null ? current !== null : current === null || identity(current.stat) !== identity(expected.stat)
        || !current.bytes.equals(expected.bytes)) invalid()
      await this.assertOwned(lock)
      await rename(temporary, this.journalPath)
      await this.syncDirectory()
      const after = await this.journal()
      if (after === null || !after.bytes.equals(bytes)) invalid()
      return after
    } finally {
      try {
        if (written !== undefined) {
          let named: Stats | undefined
          try { named = await lstat(temporary) } catch (error) { if (!missing(error)) throw error }
          if (named && identity(named) === identity(written) && (await this.bytes(handle)).equals(bytes)) await unlink(temporary)
        }
      } finally { await handle.close() }
    }
  }

  /** Reserve one local execution; this is not registered as a canonical or ordinary-task executor.
   * @param intent - Host-captured input and execution-binding fingerprints.
   * @param execute - Fixed Host execution port, entered only after pending metadata is synced.
   * @param verify - Fixed Host terminal verifier returning the measured output hash, never a caller success flag.
   * @returns The verified local result after terminal metadata commits; any uncertainty retains the mutex.
   */
  async runReserved<T>(intent: H3ExecutionIntent, execute: () => Promise<T>, verify: (result: T) => Promise<string>): Promise<T> {
    const lock = await this.acquire()
    let release = true
    let record: Record | null = null
    try {
      record = await this.journal()
      if (record !== null && record.value.state !== 'completed') throw new ComputeError('H3_SETUP_SELF_TEST_UNKNOWN', 409)
      await this.requireClear()
      const pending: Journal = { schema: 'qianshou.h3-execution-reservation.v1', operationId: randomUUID(),
        runtime: intent.runtime, bindingSha256: intent.bindingSha256, inputSha256: intent.inputSha256,
        startedAt: Date.now(), state: 'pending' }
      // Even a partial journal commit must leave a marker before an execution can be attempted.
      release = false
      record = await this.writeJournal(lock, pending, record)
      const result = await execute()
      const outputSha256 = await verify(result)
      if (!HASH.test(outputSha256)) invalid()
      record = await this.writeJournal(lock, { ...pending, state: 'completed', finishedAt: Date.now(), outputSha256 }, record)
      release = true
      return result
    } catch (error) {
      if (!release && record !== null && record.value.state === 'pending') {
        try { await this.writeJournal(lock, { ...record.value, state: 'unknown' }, record) }
        catch { /* Original pending/partial metadata and the mutex remain unresolved. */ }
      }
      throw error
    } finally {
      try { if (release) await this.release(lock) } finally { await lock.handle.close() }
    }
  }
}
