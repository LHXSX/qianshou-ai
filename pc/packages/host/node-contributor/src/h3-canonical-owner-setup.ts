/** Independently managed canonical configuration and two explicit, retained local trials. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, parse } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL,
  nativeH3PublicBindingDigest, parseNativeH3CanonicalExecutionBinding } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { H3ExecutionCoordinator, type H3TrialTransaction } from './h3-execution-coordinator.ts'
import { H3_CANONICAL_SOURCE_MANIFEST_SHA256, readH3CanonicalOwnerConfig,
  type NativeH3LocalIdentityCanonical } from './h3-canonical-provider.ts'
import { canonicalH3Endpoint, parseH3CanonicalIdentity, type H3CanonicalIdentity } from './h3-canonical-protocol.ts'
import { parseH3OwnerRuntimeIdentity, type H3OwnerRuntimeIdentity } from './h3-owner-witness.ts'
import { readH3CanonicalIdentity, readH3OwnerRuntimeIdentity, readH3WitnessedJob,
  readH3WitnessedMedia } from './h3-canonical-transport.ts'
import { runH3CanonicalExecution, type H3CanonicalRunOptions } from './h3-canonical-runner.ts'
import { readH3BoundedFile } from './h3-video.ts'
import type { H3CanonicalInspectionId, H3CanonicalManagedConfigState, H3CanonicalSetupContextId,
  H3CanonicalSetupInspectResult, H3CanonicalSetupSaveRequest, H3CanonicalSetupSaveResult,
  H3CanonicalSetupSelection, H3CanonicalSetupSummary, H3CanonicalTrialId, H3CanonicalTrialRequest,
  H3CanonicalTrialStatus, H3CanonicalVerifiedBindingRequest } from './h3-canonical-owner-setup-types.ts'

/** Authenticated owner and actual profile supplied by normal Host account services. */
export interface H3CanonicalSetupScope { readonly ownerId: number; readonly profileDir: string }

/** Fixed Host composition; paths, execution ports and authority are never browser inputs. */
export interface H3CanonicalOwnerSetupOptions {
  readonly homePath: string
  readonly coordinator: H3ExecutionCoordinator
  readonly readScope: () => Promise<H3CanonicalSetupScope | null>
  readonly readAdmission: () => Promise<{ readonly state: 'clear' | 'pending' | 'unknown' }>
  /** Validate legacy/trial state while the actual shared short mutex is already held. */
  readonly assertClearWithinTransaction: () => Promise<void>
  readonly assertIdle: () => Promise<void>
  readonly externalConfigActive: () => boolean
  /** Commit the active variant under this original mutex; failure retains the unresolved lock. */
  readonly onSaved: (state: H3CanonicalManagedConfigState, transaction: H3TrialTransaction) => Promise<void>
  readonly onTrialActivity?: (active: boolean) => void
  readonly runOptions?: H3CanonicalRunOptions
}

interface Scope {
  ownerId: number
  scopeId: string
  root: string
}
interface Pointer {
  schema: 'qianshou.h3-managed-owner.canonical.v1'
  scopeId: string
  revision: number
  directory: string
  configSha256: string
}
interface Current {
  scope: Scope
  pointer: Pointer
  pointerBytes: Buffer
  configPath: string
}
interface Measurement {
  identity: H3CanonicalIdentity
  owner: H3OwnerRuntimeIdentity
  frame: Buffer
}
interface Snapshot {
  schema: 'qianshou.h3-canonical-snapshot.v1'
  identity: H3CanonicalIdentity
  owner: H3OwnerRuntimeIdentity
  firstFrameSha256: string
}
interface Trial extends H3CanonicalTrialStatus {
  schema: 'qianshou.h3-canonical-trial.v1'
  seed: 1 | 2
  configSha256: string
  inputSha256: string
  ownerRuntimeWitnessSha256: string
  jobId?: string
  outputSha256?: string
}
interface Context {
  scope: Scope
  revision: number
  expiresAt: number
}
interface Inspection extends Context {
  selection: Required<H3CanonicalSetupSelection>
  measurementSha256: string
}
interface Running {
  controller: AbortController
  done: Promise<void>
}
const HASH = /^[0-9a-f]{64}$/u
/** Standard canonical service port; the legacy V2 service keeps its separate endpoint. */
export const H3_CANONICAL_DEFAULT_ADAPTER_BASE = 'http://127.0.0.1:8791'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown): Buffer => Buffer.from(canonicalNativeH3ReviewJson(value))
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const statId = (stat: Stats): string => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':')
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b)
const validSample = (value: unknown): value is 1 | 2 => value === 1 || value === 2
function fail(code: string): never { throw new ComputeError(code, 409) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('H3_CANONICAL_MANAGED_INVALID')
  return value as Record<string, unknown>
}

async function directory(path: string, create: boolean, privatePath = false): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) fail('H3_SETUP_UNSAFE_PATH')
  let current = parse(path).root
  for (const piece of path.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, piece)
    if (create) {
      try { await mkdir(current, { mode: 0o700 }) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(current), current)) fail('H3_SETUP_UNSAFE_PATH')
  }
  const stat = await lstat(path)
  if (privatePath && process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('H3_SETUP_UNSAFE_PATH')
}

async function syncDirectory(path: string): Promise<void> {
  // Node directory handles cannot be fsynced on Windows; file fsync and ownership CAS still apply.
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function readPrivate(path: string): Promise<Buffer> {
  await directory(dirname(path), false, true)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('H3_SETUP_UNSAFE_PATH')
  return readH3BoundedFile(path, 32 * 1024)
}

function parsePrivate(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (!encode(value).equals(bytes)) fail('H3_CANONICAL_MANAGED_INVALID')
  return object(value)
}

async function exclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await syncDirectory(dirname(path))
}

async function compareWrite(path: string, bytes: Buffer, expected: Buffer | null): Promise<void> {
  const temporary = join(dirname(path), '.canonical-write-' + randomUUID())
  await exclusive(temporary, bytes)
  const stat = await lstat(temporary)
  try {
    let current: Buffer | null = null
    try { current = await readPrivate(path) } catch (error) { if (!missing(error)) throw error }
    if (expected === null ? current !== null : current === null || !current.equals(expected)) fail('H3_SETUP_REVISION_CONFLICT')
    await rename(temporary, path); await syncDirectory(dirname(path))
    if (!(await readPrivate(path)).equals(bytes)) fail('H3_CANONICAL_MANAGED_INVALID')
  } finally {
    let named: Stats | undefined
    try { named = await lstat(temporary) } catch (error) { if (!missing(error)) throw error }
    if (named && statId(named) === statId(stat) && (await readPrivate(temporary)).equals(bytes)) await unlink(temporary)
  }
}

/** Owner/profile-scoped canonical onboarding; neither a local trial nor its receipt grants supply. */
export class H3CanonicalOwnerSetup {
  private readonly contexts = new Map<H3CanonicalSetupContextId, Context>()
  private readonly inspections = new Map<H3CanonicalInspectionId, Inspection>()
  private readonly running = new Map<H3CanonicalTrialId, Running>()
  private disposed = false

  /** Capture fixed Host ports; construction performs no reads or execution.
   * @param options - Trusted normal home, account, shared reservation and idle/admission services.
   */
  constructor(private readonly options: H3CanonicalOwnerSetupOptions) {
    if (!isAbsolute(options.homePath) || options.homePath.includes('\0')) fail('H3_SETUP_UNSAFE_PATH')
  }

  private async scope(): Promise<Scope> {
    if (this.disposed) fail('H3_SETUP_DISPOSED')
    const current = await this.options.readScope()
    if (current === null || !Number.isSafeInteger(current.ownerId) || current.ownerId < 1) fail('H3_SETUP_AUTH_REQUIRED')
    await directory(current.profileDir, false)
    const scopeId = sha(encode({ ownerId: current.ownerId, profileDir: normalize(current.profileDir) }))
    return { ownerId: current.ownerId, scopeId,
      root: join(this.options.homePath, 'qianshou-h3-owner', 'canonical', String(current.ownerId), scopeId) }
  }

  private async assertCurrent(scope: Scope): Promise<void> {
    const after = await this.scope()
    if (after.scopeId !== scope.scopeId || after.ownerId !== scope.ownerId) fail('H3_SETUP_IDENTITY_CHANGED')
  }

  private writable(): void {
    if (this.options.externalConfigActive()) fail('H3_SETUP_EXTERNAL_CONFIG_ACTIVE')
  }

  private async clear(): Promise<void> {
    const admission = await this.options.readAdmission()
    if (admission.state !== 'clear') fail(admission.state === 'pending' ? 'H3_SETUP_SELF_TEST_PENDING' : 'H3_SETUP_SELF_TEST_UNKNOWN')
  }

  private context(scope: Scope, revision: number): H3CanonicalSetupContextId {
    const id = brandString<H3CanonicalSetupContextId>(randomUUID())
    if (this.contexts.size >= 128) this.contexts.delete(this.contexts.keys().next().value ?? id)
    this.contexts.set(id, { scope, revision, expiresAt: Date.now() + 30 * 60_000 })
    return id
  }

  private capture(id: H3CanonicalSetupContextId, revision: number): Context {
    const context = this.contexts.get(id)
    if (context === undefined || context.revision !== revision || Date.now() > context.expiresAt) fail('H3_SETUP_CONTEXT_INVALID')
    return context
  }

  private async current(scope: Scope): Promise<Current | null> {
    let bytes: Buffer
    try { bytes = await readPrivate(join(scope.root, 'current.json')) }
    catch (error) { if (missing(error)) return null; throw error }
    const row = parsePrivate(bytes)
    if (Object.keys(row).sort().join(',') !== 'configSha256,directory,revision,schema,scopeId'
      || row.schema !== 'qianshou.h3-managed-owner.canonical.v1' || row.scopeId !== scope.scopeId
      || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
      || typeof row.directory !== 'string' || !UUID.test(row.directory)
      || typeof row.configSha256 !== 'string' || !HASH.test(row.configSha256)) fail('H3_CANONICAL_MANAGED_INVALID')
    const pointer = row as unknown as Pointer
    const configPath = join(scope.root, pointer.directory, 'owner.json')
    if (sha(await readPrivate(configPath)) !== pointer.configSha256) fail('H3_CANONICAL_MANAGED_INVALID')
    const config = await readH3CanonicalOwnerConfig(configPath)
    if (config.selfTestPath !== join(dirname(configPath), 'self-test.json')
      || config.firstFramePath !== join(dirname(configPath), 'first.png')) fail('H3_CANONICAL_MANAGED_INVALID')
    return { scope, pointer, pointerBytes: bytes, configPath }
  }

  private async revision(context: Context): Promise<Current> {
    await this.assertCurrent(context.scope)
    const current = await this.current(context.scope)
    if (current === null || current.pointer.revision !== context.revision) fail('H3_SETUP_REVISION_CONFLICT')
    return current
  }

  private async measure(selection: Required<H3CanonicalSetupSelection>, signal: AbortSignal): Promise<Measurement> {
    canonicalH3Endpoint(selection.adapterBase, { kind: 'identity' })
    await directory(dirname(selection.firstFramePath), false)
    const frame = await readH3BoundedFile(selection.firstFramePath, 16 * 1024 * 1024)
    if (frame.length <= 8 || !frame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      fail('H3_CANONICAL_FIRST_FRAME_INVALID')
    }
    const identity = await readH3CanonicalIdentity(selection.adapterBase, { timeoutMs: 15_000, signal })
    if (identity.sourceManifestSha256 !== H3_CANONICAL_SOURCE_MANIFEST_SHA256) fail('H3_CANONICAL_SOFTWARE_UNSUPPORTED')
    const owner = await readH3OwnerRuntimeIdentity(selection.adapterBase, identity, { timeoutMs: 15_000, signal })
    if (!(await readH3BoundedFile(selection.firstFramePath, 16 * 1024 * 1024)).equals(frame)) fail('H3_OWNER_CONFIGURATION_CHANGED')
    return { identity, owner, frame }
  }

  private snapshot(measured: Measurement): Snapshot {
    return { schema: 'qianshou.h3-canonical-snapshot.v1', identity: measured.identity,
      owner: measured.owner, firstFrameSha256: sha(measured.frame) }
  }

  private async fresh(current: Current, signal: AbortSignal): Promise<Measurement> {
    const config = await readH3CanonicalOwnerConfig(current.configPath)
    const measured = await this.measure(config, signal)
    const bytes = await readPrivate(join(dirname(current.configPath), 'snapshot.json'))
    const saved = parsePrivate(bytes)
    if (Object.keys(saved).sort().join(',') !== 'firstFrameSha256,identity,owner,schema'
      || saved.schema !== 'qianshou.h3-canonical-snapshot.v1') fail('H3_CANONICAL_MANAGED_INVALID')
    // Reparse persisted wire fields through the actual strict protocol, never caller-selected hashes.
    const identity = parseH3CanonicalIdentity(saved.identity)
    const owner = parseH3OwnerRuntimeIdentity(saved.owner, identity)
    if (!encode(this.snapshot(measured)).equals(encode({ ...saved, identity, owner }))) fail('H3_EXECUTION_IDENTITY_CHANGED')
    const after = await this.current(current.scope)
    if (after === null || !after.pointerBytes.equals(current.pointerBytes)) fail('H3_SETUP_REVISION_CONFLICT')
    await this.assertCurrent(current.scope)
    return measured
  }

  private async trial(current: Current, sample: 1 | 2): Promise<Trial | null> {
    let bytes: Buffer
    try { bytes = await readPrivate(join(dirname(current.configPath), `trial-${sample}.json`)) }
    catch (error) { if (missing(error)) return null; throw error }
    const row = parsePrivate(bytes)
    const terminal = row.state === 'ready'
    const keys = 'code,configSha256,inputSha256,operationId,ownerRuntimeWitnessSha256,revision,sample,schema,seed,startedAt,state'
    const readyKeys = 'code,configSha256,finishedAt,inputSha256,jobId,operationId,outputSha256,ownerRuntimeWitnessSha256,revision,sample,schema,seed,startedAt,state'
    const codes = { pending: 'H3_CANONICAL_TRIAL_PENDING', unknown: 'H3_CANONICAL_TRIAL_UNKNOWN', ready: 'H3_CANONICAL_TRIAL_VERIFIED' } as const
    if (Object.keys(row).sort().join(',') !== (terminal ? readyKeys : keys)
      || row.schema !== 'qianshou.h3-canonical-trial.v1' || row.revision !== current.pointer.revision
      || row.sample !== sample || row.seed !== sample || row.configSha256 !== current.pointer.configSha256
      || typeof row.operationId !== 'string' || !UUID.test(row.operationId)
      || !['pending', 'unknown', 'ready'].includes(String(row.state))
      || row.code !== codes[row.state as keyof typeof codes]
      || !Number.isSafeInteger(row.startedAt) || Number(row.startedAt) < 1
      || typeof row.inputSha256 !== 'string' || !HASH.test(row.inputSha256)
      || typeof row.ownerRuntimeWitnessSha256 !== 'string' || !HASH.test(row.ownerRuntimeWitnessSha256)
      || terminal && (typeof row.jobId !== 'string' || !Number.isSafeInteger(row.finishedAt)
        || Number(row.finishedAt) < Number(row.startedAt) || typeof row.outputSha256 !== 'string' || !HASH.test(row.outputSha256))) {
      fail('H3_CANONICAL_MANAGED_INVALID')
    }
    if (terminal) canonicalH3Endpoint(H3_CANONICAL_DEFAULT_ADAPTER_BASE, { kind: 'poll', jobId: String(row.jobId) })
    return row as unknown as Trial
  }

  private async presented(trial: Trial): Promise<H3CanonicalTrialStatus> {
    const status = { operationId: trial.operationId, revision: trial.revision, sample: trial.sample,
      startedAt: trial.startedAt }
    if (this.running.has(trial.operationId)) return { ...status, state: 'pending', code: 'H3_CANONICAL_TRIAL_PENDING' }
    if (trial.state !== 'ready' || (await this.options.readAdmission()).state !== 'clear') {
      return { ...status, state: 'unknown', code: 'H3_CANONICAL_TRIAL_UNKNOWN' }
    }
    if (trial.finishedAt === undefined) fail('H3_CANONICAL_MANAGED_INVALID')
    return { ...status, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED', finishedAt: trial.finishedAt }
  }

  /** Read current state or inspect an explicit PNG; neither action submits a generation.
   * @param selection - PNG plus optional advanced loopback address and negative text.
   * @returns A redacted current state or short-lived selection inspection.
   */
  async inspect(selection?: H3CanonicalSetupSelection): Promise<H3CanonicalSetupInspectResult> {
    const scope = await this.scope()
    const current = await this.current(scope)
    const revision = current?.pointer.revision ?? 0
    const contextId = this.context(scope, revision)
    if (selection === undefined) {
      const samples: H3CanonicalTrialStatus[] = []
      if (current !== null) for (const sample of [1, 2] as const) {
        const operation = await this.trial(current, sample)
        if (operation !== null) samples.push(await this.presented(operation))
      }
      const admission = current === null ? 'clear' : (await this.options.readAdmission()).state
      await this.assertCurrent(scope)
      const state = current === null ? 'unconfigured' : samples.some(item => item.state === 'unknown') ? 'unknown'
        : samples.some(item => item.state === 'pending') ? 'pending' : admission !== 'clear' ? 'unknown'
          : samples.length === 2 ? 'ready' : 'saved'
      const codes = { unconfigured: 'H3_CANONICAL_NOT_CONFIGURED', saved: 'H3_CANONICAL_SAVED', pending: 'H3_CANONICAL_TRIAL_PENDING',
        unknown: 'H3_CANONICAL_TRIAL_UNKNOWN', ready: 'H3_CANONICAL_TRIAL_VERIFIED' } as const
      return { kind: 'current', contextId, runtime: current === null ? null : 'canonical', configured: current !== null,
        revision, state, code: codes[state], samples } satisfies H3CanonicalSetupSummary
    }
    this.writable()
    if (Object.keys(selection).some(key => !['firstFramePath', 'adapterBase', 'negative'].includes(key))
      || !isAbsolute(selection.firstFramePath) || !(selection.negative ?? '').isWellFormed()
      || Array.from(selection.negative ?? '').length > 3000) fail('H3_SETUP_SELECTION_INVALID')
    const resolved = { firstFramePath: selection.firstFramePath, adapterBase: selection.adapterBase ?? H3_CANONICAL_DEFAULT_ADAPTER_BASE,
      negative: selection.negative ?? '' }
    const measured = await this.measure(resolved, new AbortController().signal)
    await this.assertCurrent(scope)
    const inspectionId = brandString<H3CanonicalInspectionId>(randomUUID())
    const expiresAt = Date.now() + 5 * 60_000
    if (this.inspections.size >= 128) this.inspections.delete(this.inspections.keys().next().value ?? inspectionId)
    this.inspections.set(inspectionId, { scope, revision, expiresAt, selection: resolved,
      measurementSha256: sha(encode(this.snapshot(measured))) })
    return { kind: 'inspection', contextId, inspectionId, revision, expiresAt, code: 'H3_CANONICAL_INSPECTED' }
  }

  /** Save only a consumed inspection with current authority and a shared-mutex revision CAS.
   * @param request - Host-issued inspection and expected revision, with no caller owner or destination.
   * @returns A new canonical context after durable managed publication of the private pointer.
   */
  async save(request: H3CanonicalSetupSaveRequest): Promise<H3CanonicalSetupSaveResult> {
    const inspection = this.inspections.get(request.inspectionId)
    if (inspection === undefined || request.expectedRevision !== inspection.revision || Date.now() > inspection.expiresAt) {
      fail('H3_SETUP_INSPECTION_INVALID')
    }
    this.inspections.delete(request.inspectionId)
    this.writable(); await this.assertCurrent(inspection.scope); await this.clear(); await this.options.assertIdle()
    const state = await this.options.coordinator.withTransaction(async (transaction) => {
      await this.options.assertClearWithinTransaction(); await this.options.assertIdle(); this.writable()
      await this.assertCurrent(inspection.scope)
      const before = await this.current(inspection.scope)
      if ((before?.pointer.revision ?? 0) !== request.expectedRevision) fail('H3_SETUP_REVISION_CONFLICT')
      const measured = await this.measure(inspection.selection, new AbortController().signal)
      if (sha(encode(this.snapshot(measured))) !== inspection.measurementSha256) fail('H3_EXECUTION_IDENTITY_CHANGED')
      await this.assertCurrent(inspection.scope)
      await directory(inspection.scope.root, true, true)
      const name = randomUUID(); const root = join(inspection.scope.root, name)
      await mkdir(root, { mode: 0o700 }); await syncDirectory(inspection.scope.root)
      const configPath = join(root, 'owner.json')
      const config = { schema: 'qianshou.h3-owner.canonical.v1', adapterBase: inspection.selection.adapterBase,
        firstFramePath: join(root, 'first.png'), negative: inspection.selection.negative, selfTestPath: join(root, 'self-test.json') }
      await exclusive(config.firstFramePath, measured.frame)
      const bytes = encode(config)
      await exclusive(configPath, bytes); await exclusive(join(root, 'snapshot.json'), encode(this.snapshot(measured)))
      await this.assertCurrent(inspection.scope); await this.options.assertIdle(); this.writable()
      const revision = request.expectedRevision + 1
      if (!Number.isSafeInteger(revision)) fail('H3_SETUP_REVISION_CONFLICT')
      const pointer: Pointer = { schema: 'qianshou.h3-managed-owner.canonical.v1', scopeId: inspection.scope.scopeId,
        revision, directory: name, configSha256: sha(bytes) }
      await transaction.assertOwned(); transaction.retain()
      await compareWrite(join(inspection.scope.root, 'current.json'), encode(pointer), before?.pointerBytes ?? null)
      const saved = { configPath, scopeId: inspection.scope.scopeId, revision }
      await this.assertCurrent(inspection.scope); await transaction.assertOwned()
      await this.options.onSaved(saved, transaction)
      await this.assertCurrent(inspection.scope); this.writable(); await transaction.assertOwned(); transaction.committed()
      return saved
    })
    await this.assertCurrent(inspection.scope); this.writable()
    return { contextId: this.context(inspection.scope, state.revision), state: 'saved', revision: state.revision }
  }

  private async verifyTrial(current: Current, measured: Measurement, trial: Trial, signal: AbortSignal): Promise<void> {
    if (trial.state !== 'ready' || trial.ownerRuntimeWitnessSha256 !== measured.owner.ownerRuntimeWitnessSha256
      || trial.jobId === undefined) fail('H3_CANONICAL_TWO_TRIALS_REQUIRED')
    const config = await readH3CanonicalOwnerConfig(current.configPath)
    const expected = { adapterBase: config.adapterBase, jobId: trial.jobId, identity: measured.identity,
      owner: measured.owner, comfyFfmpegSha256: measured.owner.comfyFfmpegSha256,
      deliveryFfmpegSha256: measured.owner.deliveryFfmpegSha256 }
    const options = { timeoutMs: 15_000, signal }
    const completed = await readH3WitnessedJob(expected, options)
    const media = await readH3WitnessedMedia(expected, completed, options)
    if (sha(media) !== trial.outputSha256) fail('H3_EXECUTION_IDENTITY_CHANGED')
  }

  /** Start only one explicitly selected sample; retained uncertainty never resubmits a POST.
   * @param request - Current opaque context/revision and sample 1 or 2 with a bounded ordinary prompt.
   * @returns Durable pending or retained local sample state, independent of platform approval.
   */
  async startSelfTest(request: H3CanonicalTrialRequest): Promise<H3CanonicalTrialStatus> {
    const context = this.capture(request.contextId, request.revision)
    this.writable()
    if (!validSample(request.sample) || !request.prompt.isWellFormed()
      || Array.from(request.prompt.trim()).length < 1 || Array.from(request.prompt.trim()).length > 7000) fail('H3_CANONICAL_INPUT_INVALID')
    const current = await this.revision(context)
    const retained = await this.trial(current, request.sample)
    if (retained !== null) {
      const status = await this.presented(retained)
      await this.revision(context); this.writable(); return status
    }
    await this.clear(); await this.options.assertIdle()
    const measured = await this.fresh(current, new AbortController().signal)
    const first = await this.trial(current, 1)
    if (request.sample === 2 && (first === null || first.state !== 'ready')) fail('H3_CANONICAL_FIRST_TRIAL_REQUIRED')
    const operationId = brandString<H3CanonicalTrialId>(randomUUID())
    const operation: Trial = { schema: 'qianshou.h3-canonical-trial.v1', operationId,
      revision: request.revision, sample: request.sample, seed: request.sample, state: 'pending',
      code: 'H3_CANONICAL_TRIAL_PENDING', startedAt: Date.now(), configSha256: current.pointer.configSha256,
      inputSha256: sha(encode({ prompt: request.prompt.trim(), seed: request.sample })),
      ownerRuntimeWitnessSha256: measured.owner.ownerRuntimeWitnessSha256 }
    const operationPath = join(dirname(current.configPath), `trial-${request.sample}.json`)
    const controller = new AbortController()
    let ready: (value: H3CanonicalTrialStatus) => void = () => {}
    let rejected: (error: unknown) => void = () => {}
    const lifecycle = { entered: false, notified: false }
    const started = new Promise<H3CanonicalTrialStatus>((resolve, reject) => { ready = resolve; rejected = reject })
    const execution = this.options.coordinator.runReserved({ runtime: 'canonical',
      bindingSha256: nativeH3PublicBindingDigest(this.binding(current, measured).binding).slice(7), inputSha256: operation.inputSha256 },
    async () => {
      await this.revision(context); await this.options.assertIdle(); this.writable()
      await exclusive(operationPath, encode(operation))
      const workspace = join(dirname(current.configPath), operationId)
      await mkdir(workspace, { mode: 0o700 }); await syncDirectory(dirname(current.configPath))
      lifecycle.entered = true; this.options.onTrialActivity?.(true)
      ready({ operationId, revision: request.revision, sample: request.sample,
        state: 'pending', code: 'H3_CANONICAL_TRIAL_PENDING', startedAt: operation.startedAt })
      lifecycle.notified = true
      const config = await readH3CanonicalOwnerConfig(current.configPath)
      return runH3CanonicalExecution({ adapterBase: config.adapterBase, identity: measured.identity,
        owner: measured.owner, firstFrame: measured.frame, negative: config.negative,
        assertCurrent: async (signal) => {
          this.writable(); await this.revision(context); await this.fresh(current, signal); this.writable()
        } },
      { prompt: request.prompt, seed: request.sample, workspacePath: workspace, signal: controller.signal }, this.options.runOptions)
    }, async (result) => {
      await this.revision(context); await this.fresh(current, controller.signal)
      if (first?.jobId === result.jobId) fail('H3_CANONICAL_INDEPENDENT_TRIAL_REQUIRED')
      const terminal: Trial = { ...operation, state: 'ready', code: 'H3_CANONICAL_TRIAL_VERIFIED',
        finishedAt: Date.now(), jobId: result.jobId, outputSha256: result.sha256 }
      await compareWrite(operationPath, encode(terminal), encode(operation))
      if (request.sample === 2) {
        if (first === null) fail('H3_CANONICAL_FIRST_TRIAL_REQUIRED')
        await this.verifyTrial(current, measured, first, controller.signal)
        await this.verifyTrial(current, measured, terminal, controller.signal)
        await this.revision(context); await this.fresh(current, controller.signal)
        await exclusive(join(dirname(current.configPath), 'self-test.json'), encode({ schema: 'qianshou.h3-self-test.canonical.v1',
          configSha256: current.pointer.configSha256, ownerRuntimeWitnessSha256: measured.owner.ownerRuntimeWitnessSha256,
          jobId: result.jobId }))
      }
      return result.sha256
    })
    const done = (async () => {
      try { await execution }
      catch (error) {
        if (!lifecycle.notified) rejected(error)
        if (lifecycle.entered) {
          try {
            const raw = await this.trial(current, request.sample)
            if (raw?.state === 'pending') await compareWrite(operationPath,
              encode({ ...operation, state: 'unknown', code: 'H3_CANONICAL_TRIAL_UNKNOWN' }), encode(operation))
          } catch { /* Original durable evidence and shared unresolved reservation are retained. */ }
        }
      } finally {
        this.running.delete(operationId)
        if (lifecycle.entered && (await this.options.readAdmission()).state === 'clear') this.options.onTrialActivity?.(false)
      }
    })()
    this.running.set(operationId, { controller, done })
    // Observe internal settlement even when a retained admission callback fails; status remains fail-closed.
    void done.catch(() => {})
    return started
  }

  /** Read a scoped retained operation without a retry, POST or private path response.
   * @param operationId - Original local sample id issued by this canonical namespace.
   * @returns Conservative current state; raw terminal evidence is preserved while the shared environment is unresolved.
   */
  async selfTestStatus(operationId: H3CanonicalTrialId): Promise<H3CanonicalTrialStatus> {
    const scope = await this.scope(); const current = await this.current(scope)
    if (current !== null) for (const sample of [1, 2] as const) {
      const operation = await this.trial(current, sample)
      if (operation?.operationId === operationId) {
        const result = await this.presented(operation); await this.assertCurrent(scope); return result
      }
    }
    fail('H3_SETUP_OPERATION_NOT_FOUND')
  }

  private binding(current: Current, measured: Measurement): NativeH3LocalIdentityCanonical {
    const binding = parseNativeH3CanonicalExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2',
      runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL,
      executionRecipeSha256: measured.identity.executionRecipeSha256, modelSha256: measured.identity.modelSha256,
      firstFrameSha256: sha(measured.frame) })
    return { binding, localOwnerConfigDigest: 'sha256:' + sha(encode({ configSha256: current.pointer.configSha256,
      ownerConfigDigest: measured.owner.ownerConfigDigest, firstFrameSha256: binding.firstFrameSha256,
      executionRecipeSha256: binding.executionRecipeSha256, modelSha256: binding.modelSha256 })) }
  }

  /** Reverify both actual independent local jobs before a Host draft consumer receives a binding.
   * @param request - Current Host-issued context/revision; no caller identity or approval fields.
   * @returns Fresh canonical public binding and private configuration digest, without publishing or granting supply.
   */
  async freshVerifiedCanonicalBinding(request: H3CanonicalVerifiedBindingRequest): Promise<NativeH3LocalIdentityCanonical> {
    const context = this.capture(request.contextId, request.revision)
    this.writable()
    const current = await this.revision(context); await this.clear()
    const measured = await this.fresh(current, new AbortController().signal)
    const first = await this.trial(current, 1), second = await this.trial(current, 2)
    if (first === null || second === null || first.state !== 'ready' || second.state !== 'ready'
      || first.jobId === second.jobId || first.operationId === second.operationId || first.seed === second.seed) {
      fail('H3_CANONICAL_TWO_TRIALS_REQUIRED')
    }
    const signal = new AbortController().signal
    await this.verifyTrial(current, measured, first, signal); await this.verifyTrial(current, measured, second, signal)
    await this.fresh(current, new AbortController().signal); await this.revision(context); await this.clear(); this.writable()
    return this.binding(current, measured)
  }

  /** Read pure identity facts for an existing task; this never grants admission or sample readiness.
   * @returns Current canonical namespace/configuration facts, or null when this owner has no managed canonical configuration.
   */
  async readCurrentConfigIdentity(): Promise<H3CanonicalManagedConfigState | null> {
    const scope = await this.scope(); const current = await this.current(scope)
    await this.assertCurrent(scope)
    return current === null ? null : { configPath: current.configPath, scopeId: scope.scopeId, revision: current.pointer.revision }
  }

  /** Resolve new-work configuration only after the same-home shared admission is confirmed clear.
   * @returns Current managed facts for the fixed provider, without replacing independent platform proof.
   */
  async resolveCurrentConfigState(): Promise<H3CanonicalManagedConfigState | null> {
    await this.clear(); const current = await this.readCurrentConfigIdentity(); await this.clear(); return current
  }

  /** Abort local observation and await settlement; uncertainty and durable reservation are never cleared. */
  async dispose(): Promise<void> {
    this.disposed = true
    const operations = [...this.running.values()]
    for (const operation of operations) operation.controller.abort()
    await Promise.allSettled(operations.map(operation => operation.done))
    this.contexts.clear(); this.inspections.clear()
  }
}
