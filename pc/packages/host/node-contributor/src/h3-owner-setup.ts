/** Owner-scoped private V2 configuration and explicitly requested local trials. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { access, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { NATIVE_H3_RUNTIME_V2 } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { executeNativeProgram, type NativeProgramRunner } from './command-artifact.ts'
import { H3ExecutionCoordinator, type H3ExecutionIntent, type H3TrialTransaction } from './h3-execution-coordinator.ts'
import { consumeOwnedNativeH3ReviewExecutionPermit, readOwnedNativeH3ReviewExecutionPermit,
  type OwnedNativeH3ReviewExecutionPermit } from './native-h3-review.ts'
import { consumeOwnedH3ExecutionPermit, readOwnedH3ExecutionPermit,
  type OwnedH3ExecutionPermit } from './native-h3-publication.ts'
import { createH3VideoProviderV2, readH3ExecutionIdentityV2, readH3OwnerConfigV2,
  type H3OwnerConfigV2 } from './h3-video-v2.ts'
import { readH3BoundedFile, type NativeH3LocalIdentityV2 } from './h3-video.ts'
import type { H3OwnerInspectionId, H3OwnerManagedConfigState, H3OwnerSelfTestId,
  H3OwnerSelfTestRequest, H3OwnerSelfTestStatus, H3OwnerSetupInspectResult,
  H3OwnerSetupSaveRequest, H3OwnerSetupSaveResult, H3OwnerSetupSelection, H3OwnerSetupContextId } from './h3-owner-setup-types.ts'

/** Current normal login and physical profile, obtained from the owning Host services. */
export interface H3OwnerSetupScope { readonly ownerId: number; readonly profileDir: string }

/** Trusted Host composition; none of these execution or destination ports is a browser input. */
export interface H3OwnerSetupOptions {
  readonly homePath: string
  readonly runtimeDirectory: string
  readonly readScope: () => Promise<H3OwnerSetupScope | null>
  readonly assertIdle: () => Promise<void>
  /** Owning runtime validates the original admitted EXECUTING lease; trial idle checks are unchanged. */
  readonly assertAdmittedExecution?: (permit: OwnedH3ExecutionPermit) => Promise<void>
  /** Review authority is the original signed challenge; ordinary lease and trial idle paths stay separate. */
  readonly assertReviewedExecution?: (permit: OwnedNativeH3ReviewExecutionPermit) => Promise<void>
  readonly onSaved: (configPath: string, transaction: H3TrialTransaction) => Promise<void>
  /** Pause local intake until a trial has a confirmed outcome; unknown remains blocked. */
  readonly onTrialActivity?: (active: boolean) => void
  readonly fetchImpl?: typeof fetch
  readonly program?: NativeProgramRunner
}

interface Scope { ownerId: number; scopeId: string; root: string }
interface Pointer { schema: 'qianshou.h3-managed-owner.v2'; scopeId: string; revision: number; directory: string; configSha256: string }
interface Inspection { scope: Scope; selection: H3OwnerSetupSelection; facts: string; revision: number; expiresAt: number }
interface Running { controller: AbortController; done: Promise<void> }
/** Same normal DSH_HOME admission only; no owner, operation or filesystem data crosses this port. */
export interface H3OwnerTrialAdmission { readonly state: 'clear' | 'pending' | 'unknown' }
interface TrialPending {
  schema: 'qianshou.h3-owner-trial-guard.v1'
  state: 'pending' | 'unknown'
  scopeId: string
  revision: number
  operationId: H3OwnerSelfTestId
  configSha256: string
  startedAt: number
}
type TrialGuard = TrialPending | { schema: 'qianshou.h3-owner-trial-guard.v1'; state: 'clear' }
interface TrialRecord { value: TrialGuard; bytes: Buffer; stat: Stats }
const SELF_TEST_SHA = 'd6813c4753680c9c62b3b0ba19f6c1dfe21afaf5dcde3587820a407fbd58e53d'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PINNED = { 'video_generate.py': NATIVE_H3_RUNTIME_V2.entrySha256,
  'h3_runtime.py': NATIVE_H3_RUNTIME_V2.runtimeSha256, 'owner_self_test.py': SELF_TEST_SHA }
const SELECTION_KEYS = ['adapterBase', 'adapterOutputRoot', 'ffmpegPath', 'ffprobePath', 'firstFramePath', 'modelPath',
  'pythonPath', 'runtime', 'workflowPath']
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown): Buffer => Buffer.from(canonicalNativeH3ReviewJson(value))
function fail(code: string): never { throw new ComputeError(code, 409) }
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const identity = (value: Stats): string => [value.dev, value.ino, value.size, value.mtimeMs, value.nlink].join(':')
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b)

async function directory(path: string, create: boolean): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) fail('H3_SETUP_UNSAFE_PATH')
  let current = parse(path).root
  for (const piece of path.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, piece)
    try { if (create) await mkdir(current, { mode: 0o700 }) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(current), current)) {
      fail('H3_SETUP_UNSAFE_PATH')
    }
  }
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  await directory(path, create)
  const stat = await lstat(path)
  if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('H3_SETUP_UNSAFE_PATH')
}

async function readPrivate(path: string): Promise<Buffer> {
  await privateDirectory(dirname(path), false)
  const stat = await lstat(path)
  if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('H3_SETUP_UNSAFE_PATH')
  return readH3BoundedFile(path, 32 * 1024)
}

async function exclusive(path: string, bytes: Buffer): Promise<Stats> {
  await privateDirectory(dirname(path), false)
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync(); return await handle.stat() }
  finally { await handle.close() }
}

async function removeOwn(path: string, owned: Stats): Promise<void> {
  try { if (identity(await lstat(path)) === identity(owned)) await unlink(path) }
  catch (error) { if (!missing(error)) throw error }
}

async function replacePrivate(path: string, bytes: Buffer, expected: Buffer): Promise<void> {
  const temporary = join(dirname(path), '.write-' + randomUUID())
  const owned = await exclusive(temporary, bytes)
  try {
    if (!(await readPrivate(path)).equals(expected)) fail('H3_SETUP_REVISION_CONFLICT')
    await privateDirectory(dirname(path), false)
    await rename(temporary, path)
  } finally { await removeOwn(temporary, owned) }
}

function parsePointer(bytes: Buffer, scope: Scope): Pointer {
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('H3_SETUP_CONFIG_INVALID')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'configSha256,directory,revision,schema,scopeId'
    || row.schema !== 'qianshou.h3-managed-owner.v2' || row.scopeId !== scope.scopeId
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || typeof row.directory !== 'string' || !UUID.test(row.directory)
    || typeof row.configSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.configSha256)) fail('H3_SETUP_CONFIG_INVALID')
  return row as unknown as Pointer
}

function parseTrialOperation(bytes: Buffer, revision?: number): H3OwnerSelfTestStatus {
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('H3_SETUP_OPERATION_INVALID')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['operationId', 'revision', 'state', 'code', 'startedAt', 'finishedAt'].includes(key))
    || typeof row.operationId !== 'string' || !UUID.test(row.operationId)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || (revision !== undefined && row.revision !== revision)
    || !['pending', 'unknown', 'ready', 'failed'].includes(String(row.state))
    || !Number.isSafeInteger(row.startedAt) || Number(row.startedAt) <= 0
    || (row.state === 'pending' ? row.finishedAt !== undefined
      : !Number.isSafeInteger(row.finishedAt) || Number(row.finishedAt) < Number(row.startedAt))) {
    fail('H3_SETUP_OPERATION_INVALID')
  }
  const codes = { pending: 'H3_SETUP_SELF_TEST_PENDING', unknown: 'H3_SETUP_SELF_TEST_UNKNOWN',
    ready: 'H3_SETUP_SELF_TEST_VERIFIED', failed: 'H3_SETUP_SELF_TEST_FAILED' } as const
  if (row.code !== codes[row.state as H3OwnerSelfTestStatus['state']]) fail('H3_SETUP_OPERATION_INVALID')
  return row as unknown as H3OwnerSelfTestStatus
}

/** Current-owner setup controller. Reads and saves never generate, publish, or enable supply. */
export class H3OwnerSetup {
  private readonly pending = new Map<H3OwnerInspectionId, Inspection>()
  private readonly running = new Map<H3OwnerSelfTestId, Running>()
  private readonly contexts = new Map<H3OwnerSetupContextId, { scope: Scope; revision: number; expiresAt: number }>()
  private disposed = false
  private readonly program: NativeProgramRunner
  private readonly fetchImpl: typeof fetch
  private readonly coordinator: H3ExecutionCoordinator

  constructor(private readonly options: H3OwnerSetupOptions) {
    this.coordinator = new H3ExecutionCoordinator(options.homePath, () => this.requireTrialClear())
    this.program = options.program ?? executeNativeProgram
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Share the actual same-home coordinator and its mutex-aware legacy check with owning Host services.
   * @returns Existing coordination ports; no new mutex, browser permission or admission bypass.
   */
  coordinationPorts(): Readonly<{ coordinator: H3ExecutionCoordinator; assertClearWithinTransaction: () => Promise<void> }> {
    return Object.freeze({ coordinator: this.coordinator, assertClearWithinTransaction: () => this.requireTrialClear() })
  }

  private context(scope: Scope, revision: number): H3OwnerSetupContextId {
    for (const [id, value] of this.contexts) {
      if (value.expiresAt <= Date.now()) this.contexts.delete(id)
      else if (value.scope.scopeId === scope.scopeId && value.revision === revision) return id
    }
    if (this.contexts.size >= 64) fail('H3_SETUP_CONTEXT_LIMIT')
    const id = brandString<H3OwnerSetupContextId>(randomUUID())
    this.contexts.set(id, { scope, revision, expiresAt: Date.now() + 1_800_000 })
    return id
  }

  private commandContext(id: H3OwnerSetupContextId, revision: number): Scope {
    const context = this.contexts.get(id)
    if (!context || context.revision !== revision || context.expiresAt <= Date.now()) fail('H3_SETUP_CONTEXT_EXPIRED')
    return context.scope
  }

  private async scope(): Promise<Scope> {
    if (this.disposed) fail('H3_SETUP_DISPOSED')
    const value = await this.options.readScope()
    if (!value || !Number.isSafeInteger(value.ownerId) || value.ownerId <= 0 || !isAbsolute(value.profileDir)) {
      fail('H3_SETUP_LOGIN_REQUIRED')
    }
    const scopeId = sha(encode({ ownerId: value.ownerId, profileDir: normalize(value.profileDir) }))
    return { ownerId: value.ownerId, scopeId, root: join(this.options.homePath, 'qianshou-h3-owner', 'v2',
      String(value.ownerId), scopeId) }
  }

  private async current(scope: Scope): Promise<{ pointer: Pointer; bytes: Buffer; configPath: string } | null> {
    let bytes: Buffer
    try { bytes = await readPrivate(join(scope.root, 'current.json')) }
    catch (error) { if (missing(error)) return null; throw error }
    const pointer = parsePointer(bytes, scope)
    const configPath = join(scope.root, pointer.directory, 'owner.json')
    try {
      if (sha(await readPrivate(configPath)) !== pointer.configSha256) fail('H3_SETUP_CONFIG_CHANGED')
      await readH3OwnerConfigV2(configPath)
      return { pointer, bytes, configPath }
    } catch (error) { if (missing(error)) fail('H3_SETUP_CONFIG_CHANGED'); throw error }
  }

  private async assertCurrent(scope: Scope, revision?: number): Promise<void> {
    if ((await this.scope()).scopeId !== scope.scopeId) fail('H3_SETUP_OWNER_CHANGED')
    if (revision !== undefined && (await this.current(scope))?.pointer.revision !== revision) fail('H3_SETUP_REVISION_CONFLICT')
  }

  private async withLock<T>(scope: Scope, action: () => Promise<T>): Promise<T> {
    await privateDirectory(scope.root, true)
    const lockPath = join(scope.root, '.operation-lock')
    let lock: Stats
    try { lock = await exclusive(lockPath, encode({ id: randomUUID() })) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') fail('H3_SETUP_BUSY')
      throw error
    }
    try { return await action() }
    finally { await removeOwn(lockPath, lock) }
  }

  private trialRoot(): string { return join(this.options.homePath, 'qianshou-h3-owner') }

  private async syncPrivateDirectory(path: string): Promise<void> {
    // Windows file sync is available; directory handles are not exposed by Node there.
    if (process.platform === 'win32') return
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }

  private syncTrialDirectory(): Promise<void> { return this.syncPrivateDirectory(this.trialRoot()) }

  private async trialRecord(): Promise<TrialRecord | null> {
    const path = join(this.trialRoot(), 'trial-guard.json')
    let bytes: Buffer; let stat: Stats
    try {
      await privateDirectory(dirname(path), false)
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024
          || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
          fail('H3_SETUP_TRIAL_GUARD_INVALID')
        }
        const buffer = Buffer.alloc(32 * 1024 + 1)
        let used = 0
        while (used < buffer.length) {
          const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
          if (bytesRead === 0) break
          used += bytesRead
        }
        if (used > 32 * 1024) fail('H3_SETUP_TRIAL_GUARD_INVALID')
        bytes = buffer.subarray(0, used)
        if (identity(stat) !== identity(await handle.stat()) || identity(stat) !== identity(await lstat(path))) {
          fail('H3_SETUP_TRIAL_GUARD_INVALID')
        }
      } finally { await handle.close() }
    } catch (error) { if (missing(error)) return null; throw error }
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('H3_SETUP_TRIAL_GUARD_INVALID')
    const row = value as Record<string, unknown>
    if (row.schema !== 'qianshou.h3-owner-trial-guard.v1') fail('H3_SETUP_TRIAL_GUARD_INVALID')
    if (row.state === 'clear' && Object.keys(row).sort().join(',') === 'schema,state') {
      return { value: { schema: row.schema, state: 'clear' }, bytes, stat }
    }
    if (Object.keys(row).sort().join(',') !== 'configSha256,operationId,revision,schema,scopeId,startedAt,state'
      || !['pending', 'unknown'].includes(String(row.state))
      || typeof row.scopeId !== 'string' || !/^[0-9a-f]{64}$/u.test(row.scopeId)
      || typeof row.configSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.configSha256)
      || typeof row.operationId !== 'string' || !UUID.test(row.operationId)
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
      || !Number.isSafeInteger(row.startedAt) || Number(row.startedAt) < 1) fail('H3_SETUP_TRIAL_GUARD_INVALID')
    return { value: row as unknown as TrialPending, bytes, stat }
  }

  private async legacyUnsettled(): Promise<boolean> {
    const root = join(this.trialRoot(), 'v2')
    let count = 0
    const entries = async (path: string) => {
      await privateDirectory(path, false)
      const result = await readdir(path, { withFileTypes: true })
      count += result.length
      if (count > 4096) fail('H3_SETUP_TRIAL_GUARD_INVALID')
      return result
    }
    let owners
    try { owners = await entries(root) }
    catch (error) { if (missing(error)) return false; throw error }
    for (const owner of owners) {
      if (!owner.isDirectory() || !/^[1-9][0-9]*$/u.test(owner.name)
        || !Number.isSafeInteger(Number(owner.name))) fail('H3_SETUP_TRIAL_GUARD_INVALID')
      const ownerPath = join(root, owner.name)
      for (const scope of await entries(ownerPath)) {
        if (!scope.isDirectory() || !/^[0-9a-f]{64}$/u.test(scope.name)) fail('H3_SETUP_TRIAL_GUARD_INVALID')
        const scopePath = join(ownerPath, scope.name)
        for (const entry of await entries(scopePath)) {
          if (entry.name === '.operation-lock') return true
          if (entry.name === 'current.json') { await readPrivate(join(scopePath, entry.name)); continue }
          if (!entry.isDirectory() || !UUID.test(entry.name)) fail('H3_SETUP_TRIAL_GUARD_INVALID')
          let bytes: Buffer
          try { bytes = await readPrivate(join(scopePath, entry.name, 'self-test.json')) }
          catch (error) { if (missing(error)) continue; throw error }
          const operation = parseTrialOperation(bytes)
          if (operation.state === 'pending' || operation.state === 'unknown') return true
        }
      }
    }
    return false
  }

  private async trialAdmission(insideMutex: boolean): Promise<H3OwnerTrialAdmission> {
    if (!insideMutex) {
      try { await readPrivate(join(this.trialRoot(), '.trial-lock')); return { state: 'unknown' } }
      catch (error) { if (!missing(error)) throw error }
    }
    if (await this.coordinator.hasUnsettledExecution()) return { state: 'unknown' }
    const retained = await this.trialRecord()
    if (retained === null) return { state: await this.legacyUnsettled() ? 'unknown' : 'clear' }
    if (retained.value.state === 'clear') return { state: 'clear' }
    return { state: retained.value.state === 'pending' && this.running.has(retained.value.operationId)
      ? 'pending' : 'unknown' }
  }

  /** Read the durable trial gate shared by this normal DSH_HOME, regardless of account or profile.
   * @returns Clear, live pending or unresolved state; no private scope or operation information.
   */
  async readTrialAdmission(): Promise<H3OwnerTrialAdmission> {
    try {
      const result = await this.trialAdmission(false)
      if (result.state !== 'clear') this.options.onTrialActivity?.(true)
      return result
    } catch (error) {
      this.options.onTrialActivity?.(true)
      if (!(error instanceof Error)) throw error
      fail('H3_SETUP_TRIAL_GUARD_INVALID')
    }
  }

  /** Refuse new work unless the shared durable trial gate is clear.
   * @returns Completion only when no trial outcome remains unresolved in this DSH_HOME.
   */
  async assertTrialAdmission(): Promise<void> {
    const result = await this.readTrialAdmission()
    if (result.state !== 'clear') fail(result.state === 'pending'
      ? 'H3_SETUP_SELF_TEST_PENDING' : 'H3_SETUP_SELF_TEST_UNKNOWN')
  }

  private async withTrialLock<T>(action: (lock: H3TrialTransaction) => Promise<T>): Promise<T> {
    return this.coordinator.withTransaction(action)
  }

  private async requireTrialClear(): Promise<void> {
    const admission = await this.trialAdmission(true)
    if (admission.state !== 'clear') fail('H3_SETUP_SELF_TEST_UNSETTLED')
  }

  private async writeTrialGuard(lock: H3TrialTransaction, value: TrialGuard, expected: TrialRecord | null): Promise<TrialRecord> {
    await lock.assertOwned()
    const path = join(this.trialRoot(), 'trial-guard.json'); const bytes = encode(value)
    if (expected) {
      if (identity(await lstat(path)) !== identity(expected.stat)) fail('H3_SETUP_TRIAL_GUARD_INVALID')
      await replacePrivate(path, bytes, expected.bytes)
    } else await exclusive(path, bytes)
    await this.syncTrialDirectory()
    const result = await this.trialRecord()
    if (!result || !result.bytes.equals(bytes)) fail('H3_SETUP_TRIAL_GUARD_INVALID')
    return result
  }

  private async assertOwnedTrial(expected: TrialRecord): Promise<void> {
    const actual = await this.trialRecord()
    if (!actual || !actual.bytes.equals(expected.bytes) || identity(actual.stat) !== identity(expected.stat)) {
      fail('H3_SETUP_TRIAL_GUARD_INVALID')
    }
  }

  /** Reserve local work through fixed Host ports; this method is not a browser RPC or a registered executor.
   * @param intent - Host-measured execution and input fingerprints, separate from platform authority.
   * @param execute - Owning execution port entered only after the shared journal is durable.
   * @param verify - Owning terminal verifier returning the measured output hash.
   * @returns The local verified result; uncertain execution or commits remain blocked across restarts.
   */
  async runReservedExecution<T>(intent: H3ExecutionIntent, execute: () => Promise<T>,
    verify: (result: T) => Promise<string>): Promise<T> {
    const scope = await this.scope()
    await this.options.assertIdle(); await this.assertCurrent(scope)
    return this.coordinator.runReserved(intent, async () => {
      await this.assertCurrent(scope); await this.options.assertIdle()
      return execute()
    }, async (result) => {
      await this.assertCurrent(scope)
      const hash = await verify(result)
      await this.assertCurrent(scope)
      return hash
    })
  }

  /** Reserve only the factory's original admitted attempt, without mistaking that attempt for competing work.
   * @param permit - Single-use capability minted after published tuple and original lease validation.
   * @param execute - Fixed provider's privately retained raw runner, not a caller-selected program.
   * @param verify - Local output verifier; platform delivery and settlement remain separate.
   * @returns Verified local output, or retained unknown reservation after any uncertain execution.
   */
  async runAdmittedReservedExecution<T>(permit: OwnedH3ExecutionPermit, execute: () => Promise<T>,
    verify: (result: T) => Promise<string>): Promise<T> {
    const captured = readOwnedH3ExecutionPermit(permit)
    const assert = this.options.assertAdmittedExecution
    if (assert === undefined) fail('H3_NATIVE_SELECTION_INVALID')
    return consumeOwnedH3ExecutionPermit(permit, async () => {
      const scope = await this.scope()
      await assert(permit); await this.assertCurrent(scope); await this.assertTrialAdmission()
      return this.coordinator.runReserved({ runtime: captured.executionKind,
        bindingSha256: captured.bindingSha256, inputSha256: captured.inputSha256 }, async () => {
        await this.assertCurrent(scope); await assert(permit); await captured.assertCurrent()
        return execute()
      }, async (result) => {
        await this.assertCurrent(scope); await assert(permit); await captured.assertCurrent()
        const hash = await verify(result)
        await this.assertCurrent(scope); await assert(permit); await captured.assertCurrent()
        return hash
      })
    })
  }

  /** Reserve an original signed review through the shared mutex, including upload and nonce terminal commits.
   * @param permit - Single-use signed review capability from the actual challenge consumer.
   * @param execute - Owning review body with the fixed provider and dedicated upload lease.
   * @param verify - Terminal artifact fingerprint verifier; no platform approval is inferred.
   * @returns Verified review metadata, retaining unknown on any uncertain execution or commit.
   */
  async runReviewedReservedExecution<T>(permit: OwnedNativeH3ReviewExecutionPermit, execute: () => Promise<T>,
    verify: (result: T) => Promise<string>): Promise<T> {
    const captured = readOwnedNativeH3ReviewExecutionPermit(permit)
    const assert = this.options.assertReviewedExecution
    if (assert === undefined) fail('H3_REVIEW_EXECUTION_REFUSED')
    return consumeOwnedNativeH3ReviewExecutionPermit(permit, async () => {
      const scope = await this.scope()
      await assert(permit); await this.assertCurrent(scope); await this.assertTrialAdmission()
      return this.coordinator.runReserved({ runtime: captured.executionKind,
        bindingSha256: captured.bindingSha256, inputSha256: captured.inputSha256 }, async () => {
        await this.assertCurrent(scope); await assert(permit); await captured.assertCurrent()
        return execute()
      }, async (result) => {
        await this.assertCurrent(scope); await assert(permit); await captured.assertCurrent()
        const hash = await verify(result)
        await this.assertCurrent(scope); await assert(permit); await captured.assertCurrent()
        return hash
      })
    })
  }

  private async runtime(): Promise<Record<keyof typeof PINNED, Buffer>> {
    const files = {} as Record<keyof typeof PINNED, Buffer>
    for (const name of Object.keys(PINNED) as (keyof typeof PINNED)[]) {
      const bytes = await readH3BoundedFile(join(this.options.runtimeDirectory, name), 256 * 1024)
      if (sha(bytes) !== PINNED[name]) fail('H3_SETUP_RUNTIME_UNSUPPORTED')
      files[name] = bytes
    }
    return files
  }

  private async inspectFiles(selection: H3OwnerSetupSelection): Promise<string> {
    if (Object.keys(selection).sort().join(',') !== SELECTION_KEYS.join(',')) fail('H3_SETUP_SELECTION_INVALID')
    if (selection.runtime !== 'v2') fail('H3_SETUP_CANONICAL_UNSUPPORTED')
    const url = new URL(selection.adapterBase)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username
      || url.password || url.pathname !== '/' || url.search || url.hash) fail('H3_SETUP_ADAPTER_INVALID')
    const facts: Record<string, string> = {}
    await directory(selection.adapterOutputRoot, false)
    const output = await lstat(selection.adapterOutputRoot)
    facts.adapterOutputRoot = [output.dev, output.ino, output.uid].join(':')
    for (const key of ['pythonPath', 'ffmpegPath', 'ffprobePath', 'firstFramePath', 'workflowPath', 'modelPath'] as const) {
      const path = selection[key]
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('H3_SETUP_SELECTION_INVALID')
      await directory(dirname(path), false)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1) fail('H3_SETUP_FILE_INVALID')
      facts[key] = identity(stat)
      if (['pythonPath', 'ffmpegPath', 'ffprobePath'].includes(key)) await access(path, constants.X_OK)
    }
    const first = await readH3BoundedFile(selection.firstFramePath, 16 * 1024 * 1024)
    if (!first.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('H3_SETUP_FIRST_FRAME_INVALID')
    const workflow = await readH3BoundedFile(selection.workflowPath, 2 * 1024 * 1024)
    const value: unknown = JSON.parse(workflow.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('H3_SETUP_WORKFLOW_INVALID')
    await this.runtime()
    return sha(encode({ selection, facts, firstSha: sha(first), workflowSha: sha(workflow) }))
  }

  private async operation(current: { configPath: string; pointer: Pointer }): Promise<H3OwnerSelfTestStatus | null> {
    try {
      const path = join(dirname(current.configPath), 'self-test.json')
      const result = parseTrialOperation(await readPrivate(path), current.pointer.revision)
      if (result.state !== 'pending' || this.running.has(result.operationId)) return result
      // A terminal write can finish while the pending record is being read; confirm the actual record once.
      const latest = parseTrialOperation(await readPrivate(path), current.pointer.revision)
      if (latest.operationId !== result.operationId) fail('H3_SETUP_OPERATION_NOT_FOUND')
      return latest.state === 'pending' ? { ...latest, state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' } : latest
    } catch (error) { if (missing(error)) return null; throw error }
  }

  private async presentedOperation(current: { configPath: string; pointer: Pointer }): Promise<H3OwnerSelfTestStatus | null> {
    const operation = await this.operation(current)
    if (operation === null) return null
    if (operation.state === 'unknown') return operation
    if (this.running.has(operation.operationId)) {
      // Do not classify a still-live terminal commit from a mutex snapshot that may expire during the read.
      return { operationId: operation.operationId, revision: operation.revision,
        state: 'pending', code: 'H3_SETUP_SELF_TEST_PENDING', startedAt: operation.startedAt }
    }
    let admission: H3OwnerTrialAdmission
    try { admission = await this.readTrialAdmission() }
    catch (error) {
      if (!(error instanceof Error)) throw error
      return { ...operation, state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' }
    }
    if (admission.state === 'clear') return operation
    // Preserve the raw local evidence: this projection only says the shared environment remains unresolved.
    return { ...operation, state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' }
  }

  /** Read current authenticated configuration facts for an already running task's identity checks.
   * @returns Stable private scope, revision and configuration path; no readiness or new admission.
   */
  async readCurrentConfigIdentity(): Promise<H3OwnerManagedConfigState | null> {
    const scope = await this.scope(); const before = await this.current(scope)
    await this.assertCurrent(scope)
    const after = await this.current(scope)
    if (before === null ? after !== null : after === null || !after.bytes.equals(before.bytes)) {
      fail('H3_SETUP_REVISION_CONFLICT')
    }
    await this.assertCurrent(scope)
    return before ? { configPath: before.configPath, revision: before.pointer.revision, scopeId: scope.scopeId } : null
  }

  /** Observe current owner/profile revision, including changes between equal-byte configurations.
   * @returns Private provider state or null when this owner has not saved a configuration.
   */
  async resolveCurrentConfigState(): Promise<H3OwnerManagedConfigState | null> {
    await this.assertTrialAdmission()
    const scope = await this.scope(); const current = await this.current(scope)
    const operation = current ? await this.operation(current) : null
    if (operation?.state === 'pending' || operation?.state === 'unknown') {
      this.options.onTrialActivity?.(true)
      fail(operation.code)
    }
    await this.assertCurrent(scope); await this.assertTrialAdmission()
    return current ? { configPath: current.configPath, revision: current.pointer.revision, scopeId: scope.scopeId } : null
  }

  /** Resolve only the current owner's managed V2 configuration.
   * @returns Absolute private file path, or null without a saved configuration.
   */
  async resolveCurrentConfig(): Promise<string | null> { return (await this.resolveCurrentConfigState())?.configPath ?? null }

  /** Read current setup or inspect explicit local selections without commands or GPU requests.
   * @param selection - User-selected files; omitted to read first-screen state.
   * @param signal - Cancellation of read-only probes.
   * @returns Scoped state or a short-lived inspection that can be explicitly saved.
   */
  async inspect(selection?: H3OwnerSetupSelection, signal: AbortSignal = new AbortController().signal): Promise<H3OwnerSetupInspectResult> {
    signal.throwIfAborted()
    const scope = await this.scope(); const current = await this.current(scope)
    if (!selection) {
      const operation = current ? await this.presentedOperation(current) : null
      await this.assertCurrent(scope)
      return { contextId: this.context(scope, current?.pointer.revision ?? 0),
        kind: 'current', runtime: current ? 'v2' : null, revision: current?.pointer.revision ?? 0,
        configured: current !== null, state: operation?.state ?? (current ? 'saved' : 'unconfigured'),
        code: operation?.code ?? (current ? 'H3_SETUP_SAVED' : 'H3_SETUP_NOT_CONFIGURED'),
        ...(operation ? { operation } : {}) }
    }
    const facts = await this.inspectFiles(selection)
    let adapterAvailable = false
    try {
      const { pythonPath, ffmpegPath, ffprobePath, firstFramePath, workflowPath, modelPath, adapterBase } = selection
      const config: H3OwnerConfigV2 = { pythonPath, ffmpegPath, ffprobePath, firstFramePath, workflowPath, modelPath,
        adapterBase, schema: 'qianshou.h3-owner.v2', workflow: 'qs_new4',
        entryPath: join(this.options.runtimeDirectory, 'video_generate.py'), runtimePath: join(this.options.runtimeDirectory, 'h3_runtime.py'),
        selfTestReceiptPath: join(scope.root, 'not-executed.json'), outputRoot: selection.adapterOutputRoot }
      await readH3ExecutionIdentityV2(config, AbortSignal.any([signal, AbortSignal.timeout(15_000)]), this.fetchImpl)
      adapterAvailable = true
    } catch (error) { signal.throwIfAborted(); if (!(error instanceof Error)) throw error }
    await this.assertCurrent(scope)
    if (facts !== await this.inspectFiles(selection)) fail('H3_SETUP_FILES_CHANGED')
    const inspectionId = brandString<H3OwnerInspectionId>(randomUUID()); const expiresAt = Date.now() + 600_000
    for (const [id, value] of this.pending) if (value.expiresAt <= Date.now()) this.pending.delete(id)
    if (this.pending.size >= 16) fail('H3_SETUP_INSPECTION_LIMIT')
    this.pending.set(inspectionId, { scope, selection: { ...selection }, facts, revision: current?.pointer.revision ?? 0, expiresAt })
    return { contextId: this.context(scope, current?.pointer.revision ?? 0),
      kind: 'inspection', inspectionId, revision: current?.pointer.revision ?? 0, expiresAt,
      adapterAvailable, code: adapterAvailable ? 'H3_SETUP_INSPECTED' : 'H3_SETUP_ADAPTER_UNAVAILABLE' }
  }

  /** Save exact inspected files under a new private revision; never execute or grant supply.
   * @param request - Single-use inspection and expected current revision.
   * @param signal - Cancellation before durable publication.
   * @returns Saved revision only; provider paths remain internal.
   */
  async save(request: H3OwnerSetupSaveRequest, signal: AbortSignal): Promise<H3OwnerSetupSaveResult> {
    signal.throwIfAborted()
    const scope = await this.scope(); const inspection = this.pending.get(request.inspectionId)
    this.pending.delete(request.inspectionId)
    if (!inspection || inspection.scope.scopeId !== scope.scopeId || inspection.expiresAt <= Date.now()) fail('H3_SETUP_INSPECTION_EXPIRED')
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
      || request.expectedRevision !== inspection.revision) fail('H3_SETUP_REVISION_CONFLICT')
    if (inspection.facts !== await this.inspectFiles(inspection.selection)) fail('H3_SETUP_FILES_CHANGED')
    await this.options.assertIdle(); await this.assertCurrent(scope)
    return this.withTrialLock(async (lock) => {
      await this.requireTrialClear()
      return this.withLock(scope, async () => {
        await this.options.assertIdle(); await this.assertCurrent(scope)
        const before = await this.current(scope)
        if ((before?.pointer.revision ?? 0) !== request.expectedRevision) fail('H3_SETUP_REVISION_CONFLICT')
        if (before) {
          const operation = await this.operation(before)
          if (operation?.state === 'pending' || operation?.state === 'unknown') fail('H3_SETUP_SELF_TEST_UNSETTLED')
        }
        const runtime = await this.runtime(); const id = randomUUID(); const root = join(scope.root, id)
        await privateDirectory(root, true); await privateDirectory(join(root, 'trials'), true)
        for (const name of Object.keys(PINNED) as (keyof typeof PINNED)[]) await exclusive(join(root, name), runtime[name])
        const { pythonPath, ffmpegPath, ffprobePath, firstFramePath, workflowPath, modelPath, adapterBase } = inspection.selection
        const selection = { pythonPath, ffmpegPath, ffprobePath, firstFramePath, workflowPath, modelPath, adapterBase }
        const config: H3OwnerConfigV2 = { ...selection, schema: 'qianshou.h3-owner.v2', workflow: 'qs_new4',
          entryPath: join(root, 'video_generate.py'), runtimePath: join(root, 'h3_runtime.py'),
          selfTestReceiptPath: join(root, 'receipt.json'), outputRoot: inspection.selection.adapterOutputRoot }
        const configBytes = encode(config); const configPath = join(root, 'owner.json')
        await exclusive(configPath, configBytes)
        await this.assertCurrent(scope); signal.throwIfAborted()
        if (inspection.facts !== await this.inspectFiles(inspection.selection)) fail('H3_SETUP_FILES_CHANGED')
        const revision = request.expectedRevision + 1
        if (!Number.isSafeInteger(revision)) fail('H3_SETUP_REVISION_CONFLICT')
        const pointer: Pointer = { schema: 'qianshou.h3-managed-owner.v2', scopeId: scope.scopeId,
          revision, directory: id, configSha256: sha(configBytes) }
        const target = join(scope.root, 'current.json')
        await lock.assertOwned()
        if (before) await replacePrivate(target, encode(pointer), before.bytes)
        else await exclusive(target, encode(pointer))
        await this.assertCurrent(scope, revision)
        await this.options.onSaved(configPath, lock)
        await this.assertCurrent(scope, revision)
        return { contextId: this.context(scope, revision), state: 'saved', revision }
      })
    })
  }

  /** Run one explicitly requested five-second video; repeats reuse its durable operation.
   * @param request - Current revision and normal video description.
   * @param signal - Cancels only before starting; closing a browser never reruns a trial.
   * @returns Pending or retained state, without awaiting the whole GPU generation.
   */
  async startSelfTest(request: H3OwnerSelfTestRequest, signal: AbortSignal): Promise<H3OwnerSelfTestStatus> {
    // Capture the trusted context before asynchronous account reads can observe another login.
    const boundScope = this.commandContext(request.contextId, request.revision)
    signal.throwIfAborted()
    if (typeof request.prompt !== 'string' || !request.prompt.trim() || !request.prompt.isWellFormed()
      || Array.from(request.prompt).length > 7000) fail('H3_SETUP_PROMPT_INVALID')
    const scope = await this.scope()
    if (scope.scopeId !== boundScope.scopeId) fail('H3_SETUP_OWNER_CHANGED')
    const current = await this.current(scope)
    if (!current || current.pointer.revision !== request.revision) fail('H3_SETUP_REVISION_CONFLICT')
    const existing = await this.presentedOperation(current)
    if (existing) {
      if (existing.state === 'pending' || existing.state === 'unknown') this.options.onTrialActivity?.(true)
      await this.assertCurrent(scope, request.revision)
      return existing
    }
    await this.options.assertIdle(); await this.assertCurrent(scope, request.revision)
    const result = await this.withTrialLock(async (lock) => {
      await this.requireTrialClear()
      return this.withLock(scope, async () => {
        await this.options.assertIdle(); await this.assertCurrent(scope, request.revision)
        const retained = await this.operation(current)
        if (retained) {
          if (retained.state === 'pending' || retained.state === 'unknown') this.options.onTrialActivity?.(true)
          return retained
        }
        const root = dirname(current.configPath); const path = join(root, 'self-test.json')
        const status: H3OwnerSelfTestStatus = { operationId: brandString<H3OwnerSelfTestId>(randomUUID()),
          revision: request.revision, state: 'pending', code: 'H3_SETUP_SELF_TEST_PENDING', startedAt: Date.now() }
        const guard = await this.writeTrialGuard(lock, { schema: 'qianshou.h3-owner-trial-guard.v1', state: 'pending',
          scopeId: scope.scopeId, revision: status.revision, operationId: status.operationId,
          configSha256: current.pointer.configSha256, startedAt: status.startedAt }, await this.trialRecord())
        try { await exclusive(path, encode(status)) }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            const retained = await this.operation(current)
            if (retained) { this.options.onTrialActivity?.(true); return retained }
          }
          throw error
        }
        const controller = new AbortController()
        this.options.onTrialActivity?.(true)
        const done = this.runTrial(scope, current, status, guard, request.prompt, controller.signal)
        this.running.set(status.operationId, { controller, done })
        void done.then(() => { this.running.delete(status.operationId) }, () => { this.running.delete(status.operationId) })
        return status
      })
    })
    await this.assertCurrent(scope, request.revision)
    const presented = await this.presentedOperation(current)
    if (presented === null || presented.operationId !== result.operationId) fail('H3_SETUP_OPERATION_NOT_FOUND')
    return presented
  }

  private async runTrial(scope: Scope, current: { configPath: string; pointer: Pointer },
    initial: H3OwnerSelfTestStatus, guard: TrialRecord, prompt: string, signal: AbortSignal): Promise<void> {
    const path = join(dirname(current.configPath), 'self-test.json'); let started = false
    let state: H3OwnerSelfTestStatus['state'] = 'failed'
    try {
      await this.assertCurrent(scope, initial.revision)
      const config = await readH3OwnerConfigV2(current.configPath)
      const trialPath = join(dirname(current.configPath), 'owner_self_test.py')
      if (sha(await readH3BoundedFile(trialPath, 256 * 1024)) !== SELF_TEST_SHA) fail('H3_SETUP_RUNTIME_UNSUPPORTED')
      await this.inspectFiles({ runtime: 'v2', pythonPath: config.pythonPath, ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath, firstFramePath: config.firstFramePath, workflowPath: config.workflowPath,
        modelPath: config.modelPath, adapterBase: config.adapterBase, adapterOutputRoot: config.outputRoot })
      const output = join(dirname(current.configPath), 'trials', initial.operationId)
      await privateDirectory(output, true); await this.assertCurrent(scope, initial.revision)
      await this.assertOwnedTrial(guard)
      started = true
      await this.program(config.pythonPath, [trialPath, '--run-local-trial', '--config', current.configPath,
        '--prompt', prompt, '--output-directory', output], { signal, timeout: 1_500_000, maxBuffer: 64 * 1024,
        windowsHide: true, cwd: dirname(current.configPath), env: { PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP } })
      await this.assertCurrent(scope, initial.revision)
      await this.verifyBinding(initial.revision, initial.operationId)
      await this.assertCurrent(scope, initial.revision)
      await this.assertOwnedTrial(guard)
      state = 'ready'
    } catch (error) {
      // A killed Python process does not establish that a Comfy GPU job stopped.
      state = started ? 'unknown' : 'failed'
      if (!(error instanceof Error)) state = 'unknown'
    }
    const code = state === 'ready' ? 'H3_SETUP_SELF_TEST_VERIFIED'
      : state === 'unknown' ? 'H3_SETUP_SELF_TEST_UNKNOWN' : 'H3_SETUP_SELF_TEST_FAILED'
    let cleared: boolean
    try {
      cleared = await this.withTrialLock(async (lock) => {
        await this.assertOwnedTrial(guard)
        // Failed terminal commits retain this already synced exclusive mutex across restarts.
        lock.retain()
        // Commit scoped evidence first; a crash in either commit leaves the global gate blocked.
        await replacePrivate(path, encode({ ...initial, state, code, finishedAt: Date.now() }), encode(initial))
        await this.syncPrivateDirectory(dirname(path))
        const retained = guard.value
        if (retained.state === 'clear') fail('H3_SETUP_TRIAL_GUARD_INVALID')
        await this.writeTrialGuard(lock, state === 'unknown' ? { ...retained, state: 'unknown' }
          : { schema: 'qianshou.h3-owner-trial-guard.v1', state: 'clear' }, guard)
        lock.committed()
        return state !== 'unknown'
      })
    } catch (error) { if (!(error instanceof Error)) throw error; cleared = false }
    if (cleared && (await this.readTrialAdmission()).state === 'clear') this.options.onTrialActivity?.(false)
    else this.options.onTrialActivity?.(true)
  }

  /** Read only the current scoped operation; an abandoned pending operation is unknown, never retried.
   * @param operationId - Opaque id returned by an explicit trial start.
   * @returns Retained local state; no GPU request or platform mutation occurs.
   */
  async selfTestStatus(operationId: H3OwnerSelfTestId): Promise<H3OwnerSelfTestStatus> {
    const scope = await this.scope(); const current = await this.current(scope)
    const operation = current ? await this.presentedOperation(current) : null
    if (!operation || operation.operationId !== operationId) fail('H3_SETUP_OPERATION_NOT_FOUND')
    await this.assertCurrent(scope, operation.revision)
    return operation
  }

  /** Recheck actual local receipt, MP4, fixed sources and private identity before creating a draft.
   * @param revision - Current managed revision; old configurations cannot supply a new draft.
   * @param contextId - Host-issued context captured before any asynchronous login read.
   * @returns Verified local V2 binding only, without platform proof or authority.
   */
  async freshVerifiedBinding(revision: number, contextId: H3OwnerSetupContextId): Promise<NativeH3LocalIdentityV2> {
    const boundScope = this.commandContext(contextId, revision)
    const scope = await this.scope()
    if (scope.scopeId !== boundScope.scopeId) fail('H3_SETUP_OWNER_CHANGED')
    const current = await this.current(scope)
    if (!current || current.pointer.revision !== revision) fail('H3_SETUP_REVISION_CONFLICT')
    const operation = await this.operation(current)
    if (!operation || operation.state !== 'ready') fail('H3_SETUP_SELF_TEST_REQUIRED')
    await this.assertTrialAdmission()
    const result = await this.verifyBinding(revision, operation.operationId)
    await this.assertCurrent(scope, revision); await this.assertTrialAdmission()
    return result
  }

  private async verifyBinding(revision: number, operationId: H3OwnerSelfTestId): Promise<NativeH3LocalIdentityV2> {
    const scope = await this.scope(); const before = await this.current(scope)
    if (!before || before.pointer.revision !== revision) fail('H3_SETUP_REVISION_CONFLICT')
    const config = await readH3OwnerConfigV2(before.configPath)
    const receipt = JSON.parse((await readPrivate(config.selfTestReceiptPath)).toString('utf8')) as unknown
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) fail('H3_SETUP_SELF_TEST_REQUIRED')
    const videoPath = (receipt as Record<string, unknown>).videoPath
    if (typeof videoPath !== 'string' || !isAbsolute(videoPath)) fail('H3_SETUP_SELF_TEST_REQUIRED')
    await directory(dirname(videoPath), false)
    const workspace = join(dirname(before.configPath), 'trials', operationId)
    await privateDirectory(workspace, false)
    const offset = relative(await realpath(workspace), await realpath(videoPath))
    if (!offset || offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) fail('H3_SETUP_SELF_TEST_REQUIRED')
    const provider = createH3VideoProviderV2(before.configPath, this.fetchImpl, this.program)
    const result = await provider.nativeAuthorBindingV2()
    await this.assertCurrent(scope, revision)
    const after = await this.current(scope)
    if (!after || !after.bytes.equals(before.bytes)) fail('H3_SETUP_REVISION_CONFLICT')
    return result
  }

  /** Abort owned child processes, await their settlement and retain unknown GPU outcomes.
   * @returns Completion after all owned subprocess callbacks have settled.
   */
  async dispose(): Promise<void> {
    this.disposed = true; this.pending.clear(); this.contexts.clear()
    const tasks = [...this.running.values()]
    for (const task of tasks) task.controller.abort()
    await Promise.all(tasks.map(task => task.done))
  }
}
