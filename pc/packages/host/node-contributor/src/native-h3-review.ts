/** Owner review samples run the fixed H3 adapter and send media only to a dedicated upload lease. */
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { ComputeError, verifyTaskOutputs } from '@deepseek-ai/dsh-compute-core'
import { canonicalNativeH3ReviewJson, isVerifiedAnyNativeH3ReviewChallenge,
  type NativeH3ReviewArtifact, type AnyNativeH3ReviewExecution,
  type AnyVerifiedNativeH3ReviewChallenge } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { nativeH3ExpectedDeviceTuple } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import type { createH3VideoProvider } from './h3-video.ts'
import type { createH3VideoProviderV2 } from './h3-video-v2.ts'
import type { createH3CanonicalProvider } from './h3-canonical-provider.ts'
import type { ArtifactOrderAdapter } from './artifact-order.ts'
import { NATIVE_H3_RUNTIME_ABI_CANONICAL, nativeH3PublicBindingDigest } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { prepareH3OrderInput, readH3BoundedFile } from './h3-video.ts'
import { selectNativeH3Binding, type NativeH3LocalSelection } from './native-h3-publication.ts'

/** Host-only port carries a signed review challenge and an already bound upload lease. */
export interface NativeH3ReviewRequest {
  readonly selection: NativeH3LocalSelection
  readonly publicationId: string
  readonly contractSha256: string
  readonly challenge: AnyVerifiedNativeH3ReviewChallenge
  readonly signal: AbortSignal
  /** V2 requires a fresh authoritative head check before GPU and each delivery boundary. */
  readonly assertBindingCurrent?: () => Promise<void>
  upload(input: {
    readonly filename: 'result.mp4'
    readonly contentType: 'video/mp4'
    readonly bytes: Uint8Array
    readonly sha256: string
  }, signal: AbortSignal): Promise<unknown>
}

const consumed = new Map<string, number>()
const MAX_OUTPUT = 16 * 1024 * 1024
type Provider = Pick<ReturnType<typeof createH3VideoProvider>, 'loadAndSelfTest' | 'nativeAuthorBinding'>
  & Partial<Pick<ReturnType<typeof createH3VideoProviderV2>, 'nativeAuthorBindingV2' | 'loadAndSelfTestV2'>>
  & Partial<Pick<ReturnType<typeof createH3CanonicalProvider>, 'nativeAuthorBindingCanonical' | 'loadAndSelfTestCanonical'>>
function invalid(): never { throw new ComputeError('H3_REVIEW_EXECUTION_REFUSED', 409) }

const reviewPermitBrand = Symbol('owned native review execution')
/** Original purpose-verified review capability; ordinary leases and JSON cannot mint it. */
export interface OwnedNativeH3ReviewExecutionPermit { readonly [reviewPermitBrand]: true }
interface ReviewPermitRecord {
  readonly request: NativeH3ReviewRequest
  readonly ownerId: number
  readonly deviceId: string
  readonly runtime: ArtifactOrderAdapter
  readonly input: Parameters<ArtifactOrderAdapter['run']>[0]
  readonly executionKind: 'v2' | 'canonical'
  readonly bindingSha256: string
  readonly inputSha256: string
  readonly assertCurrent: () => Promise<void>
  state: 'issued' | 'executing' | 'terminal' | 'unknown'
}
const reviewPermits = new WeakMap<OwnedNativeH3ReviewExecutionPermit, ReviewPermitRecord>()
/** Owning reservation port; the body preserves nonce claims, direct upload and terminal verification. */
export type NativeH3ReviewExecutionPort = (permit: OwnedNativeH3ReviewExecutionPermit,
  execute: () => Promise<AnyNativeH3ReviewExecution>) => Promise<AnyNativeH3ReviewExecution>

/** Read only the original review's captured facts, never authorize structural metadata.
 * @param permit - Capability minted after exact signed challenge and fresh source validation.
 * @returns Immutable facts while the owning operation remains active.
 */
export function readOwnedNativeH3ReviewExecutionPermit(permit: OwnedNativeH3ReviewExecutionPermit): Readonly<ReviewPermitRecord> {
  const record = reviewPermits.get(permit)
  if (!record || !['issued', 'executing'].includes(record.state)
    || createHash('sha256').update(record.input.recipeJson).digest('hex') !== record.inputSha256) invalid()
  return Object.freeze({ ...record })
}

/** Consume a review capability once; uncertainty never grants another execution.
 * @param permit - Original active purpose-bound capability.
 * @param action - Owning durable reservation transaction.
 * @returns The independently checked review metadata.
 */
export async function consumeOwnedNativeH3ReviewExecutionPermit<T>(permit: OwnedNativeH3ReviewExecutionPermit,
  action: () => Promise<T>): Promise<T> {
  const record = reviewPermits.get(permit)
  if (!record || record.state !== 'issued') invalid()
  readOwnedNativeH3ReviewExecutionPermit(permit)
  record.state = 'executing'
  try { const result = await action(); record.state = 'terminal'; return result }
  catch (error) { record.state = 'unknown'; throw error }
}


function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right)
}
function ownedDirectory(stat: Stats, privateMode: boolean): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === 'win32'
    || (typeof process.getuid !== 'function' || stat.uid === process.getuid())
      && (stat.mode & (privateMode ? 0o077 : 0o022)) === 0)
}
function ownedClaim(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (process.platform === 'win32'
    || (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && (stat.mode & 0o777) === 0o600)
}
const CLAIM_CHALLENGE_KEYS = ['publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id',
  'contract_version', 'contract_sha256', 'artifact_digest', 'source_digest', 'config_digest', 'schema',
  'purpose', 'challenge_nonce', 'challenge_input', 'challenge_input_sha256', 'issued_at', 'expires_at']
function boundedClaimText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value.isWellFormed()
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
function expiredCompletedClaim(value: unknown, name: string, now: number): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'challenge,challenge_sha256,schema,state'
    || !['qianshou.native-h3-review-claim.v1', 'qianshou.native-h3-review-claim.v2'].includes(String(item.schema))
    || item.state !== 'completed'
    || item.challenge === null || typeof item.challenge !== 'object' || Array.isArray(item.challenge)) return false
  const challenge = item.challenge as Record<string, unknown>
  const v2 = item.schema === 'qianshou.native-h3-review-claim.v2'
  const keys = v2 ? [...CLAIM_CHALLENGE_KEYS.filter(key => key !== 'config_digest'),
    'logical_binding_sha256', 'local_owner_config_digest', 'device_binding_revision'] : CLAIM_CHALLENGE_KEYS
  if (Object.keys(challenge).length !== keys.length
    || keys.some(key => !Object.hasOwn(challenge, key))
    || challenge.schema !== (v2 ? 'qianshou.native-h3-review-challenge.v2' : 'qianshou.native-h3-review-challenge.v1')
    || challenge.purpose !== (v2 ? 'qianshou:native-h3-review-challenge.v2' : 'qianshou:native-h3-review-challenge')
    || !Number.isSafeInteger(challenge.owner_id) || Number(challenge.owner_id) < 1
    || !boundedClaimText(challenge.device_id, 256) || !boundedClaimText(challenge.publication_id, 128)
    || !boundedClaimText(challenge.challenge_nonce, 256)
    || typeof challenge.task_type !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(challenge.task_type)
    || challenge.capability_id !== 'video.render' || challenge.contract_version !== (v2 ? 'v2' : 'v1')
    || ![challenge.contract_sha256, challenge.challenge_input_sha256, item.challenge_sha256]
      .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))
    || ![challenge.artifact_digest, challenge.source_digest,
      v2 ? challenge.local_owner_config_digest : challenge.config_digest]
      .every(value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value))
    || v2 && (typeof challenge.logical_binding_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(challenge.logical_binding_sha256)
      || !Number.isSafeInteger(challenge.device_binding_revision) || Number(challenge.device_binding_revision) < 1)
    || challenge.artifact_digest !== challenge.source_digest
    || !Number.isSafeInteger(challenge.issued_at) || Number(challenge.issued_at) < 1
    || !Number.isSafeInteger(challenge.expires_at) || Number(challenge.expires_at) <= Number(challenge.issued_at)
    || Number(challenge.expires_at) - Number(challenge.issued_at) > 900
    || !Number.isSafeInteger(now) || Number(challenge.expires_at) > now - 300
    || challenge.challenge_input === null || typeof challenge.challenge_input !== 'object'
    || Array.isArray(challenge.challenge_input)) return false
  const input = challenge.challenge_input as Record<string, unknown>
  if (Object.keys(input).some(key => !['prompt', 'seconds', 'seed'].includes(key))
    || typeof input.prompt !== 'string' || !input.prompt.isWellFormed() || !input.prompt.trim()
    || Array.from(input.prompt).length > 7000 || input.seconds !== 5
    || input.seed !== undefined && (!Number.isSafeInteger(input.seed) || Number(input.seed) < 1
      || Number(input.seed) > 2147483647)) return false
  const canonicalInput = canonicalNativeH3ReviewJson(input)
  const challengeHash = createHash('sha256').update(canonicalNativeH3ReviewJson(challenge)).digest('hex')
  const key = `${Number(challenge.owner_id)}\0${challenge.device_id}\0${challenge.publication_id}\0${challenge.challenge_nonce}`
  return Buffer.byteLength(canonicalInput) <= 32 * 1024 && challengeHash === item.challenge_sha256
    && createHash('sha256').update(canonicalInput).digest('hex') === challenge.challenge_input_sha256
    && `${createHash('sha256').update(key).digest('hex')}.json` === name
}

async function clearExpiredCompletedClaim(path: string, name: string, now: number,
  assertDirectories: () => Promise<void>): Promise<boolean> {
  try {
    const original = await lstat(path)
    if (!ownedClaim(original)) return false
    const bytes = await readH3BoundedFile(path, 64 * 1024)
    const item = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    if (!expiredCompletedClaim(item, name, now)) return false
    await assertDirectories()
    const current = await lstat(path)
    if (!ownedClaim(current) || original.dev !== current.dev || original.ino !== current.ino
      || original.size !== current.size || original.mtimeMs !== current.mtimeMs) return false
    await unlink(path)
    return true
  } catch { return false }
}

/** Persist the nonce before GPU execution; uncertain outcomes never release this claim. */
async function claimReviewNonce(root: string, key: string, challenge: AnyVerifiedNativeH3ReviewChallenge,
  now: number): Promise<() => Promise<void>> {
  const parent = await lstat(root)
  if (!ownedDirectory(parent, false) || !samePath(root, await realpath(root))) invalid()
  const directory = join(root, 'native-h3-review-claims')
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) {
    if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) invalid()
  }
  const directoryStat = await lstat(directory)
  if (!ownedDirectory(directoryStat, true) || !samePath(directory, await realpath(directory))) invalid()
  const stableDirectories = async (): Promise<void> => {
    const currentParent = await lstat(root)
    const currentDirectory = await lstat(directory)
    if (!ownedDirectory(currentParent, false) || !ownedDirectory(currentDirectory, true)
      || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino
      || currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino
      || !samePath(root, await realpath(root)) || !samePath(directory, await realpath(directory))) invalid()
  }
  await stableDirectories()
  const entries = await opendir(directory)
  let visited = 0
  let retained = 0
  for await (const entry of entries) {
    if (++visited > 1024 || !entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) invalid()
    if (!await clearExpiredCompletedClaim(join(directory, entry.name), entry.name, now, stableDirectories)) retained++
  }
  if (retained >= 1024) invalid()
  const path = join(directory, `${createHash('sha256').update(key).digest('hex')}.json`)
  const value = { schema: challenge.payload.contract_version === 'v2' ? 'qianshou.native-h3-review-claim.v2'
    : 'qianshou.native-h3-review-claim.v1', state: 'claimed',
  challenge: challenge.payload,
  challenge_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(challenge.payload)).digest('hex') }
  const metadata = Buffer.from(canonicalNativeH3ReviewJson(value))
  if (metadata.length > 64 * 1024) invalid()
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, flags, 0o600) } catch { return invalid() }
  let written: Stats
  try {
    await handle.writeFile(metadata)
    await handle.sync()
    written = await handle.stat()
    const currentFile = await lstat(path)
    if (!written.isFile() || currentFile.isSymbolicLink() || !currentFile.isFile()
      || written.dev !== currentFile.dev || written.ino !== currentFile.ino || written.size !== metadata.length
      || (process.platform !== 'win32' && ((written.mode & 0o077) !== 0
        || typeof process.getuid === 'function' && written.uid !== process.getuid()))) invalid()
    await stableDirectories()
  } finally { await handle.close() }
  if (process.platform !== 'win32') {
    for (const [path, expected] of [[directory, directoryStat], [root, parent]] as const) {
      const descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const stat = await descriptor.stat()
        if (stat.dev !== expected.dev || stat.ino !== expected.ino || !ownedDirectory(stat, path === directory)) invalid()
        await descriptor.sync()
      } finally { await descriptor.close() }
    }
  }
  await stableDirectories()
  // Keep even a partial or failed claim. Recovery requires a newly issued nonce.
  return async () => {
    await stableDirectories()
    const current = await lstat(path)
    if (!ownedClaim(current) || current.dev !== written.dev || current.ino !== written.ino) invalid()
    const output = Buffer.from(canonicalNativeH3ReviewJson({ ...value, state: 'completed' }))
    const descriptor = await open(path, constants.O_WRONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    try {
      const stat = await descriptor.stat()
      if (!ownedClaim(stat) || stat.dev !== written.dev || stat.ino !== written.ino) invalid()
      await descriptor.writeFile(output)
      await descriptor.truncate(output.length)
      await descriptor.sync()
      await stableDirectories()
      const after = await lstat(path)
      if (!ownedClaim(after) || after.dev !== written.dev || after.ino !== written.ino) invalid()
    } finally { await descriptor.close() }
  }
}

/** Execute one independently issued challenge before approval, without making a buyer order.
 * @param provider - Fixed native H3 runner and actual private configuration checker.
 * @param request - Purpose-verified challenge and dedicated direct media upload port.
 * @param identity - Current authenticated owner/device reader; no caller-supplied identity is trusted.
 * @param workspaceRoot - Trusted contributor workspace directory, never a buyer input path.
 * @param now - Trusted epoch seconds used to enforce the signed challenge deadline.
 * @param executionPort - Private Host reservation composition; canonical execution requires this port.
 * @param runOwned - Privately retained provider runner, invoked only inside the original reservation.
 * @returns Unsigned execution metadata for the enrolled device signer and independent reviewer.
 */
export async function runNativeH3ReviewChallenge(provider: Provider, request: NativeH3ReviewRequest,
  identity: () => Promise<{ ownerId: number; deviceId: string } | null>, workspaceRoot: string,
  now: () => number = () => Math.floor(Date.now() / 1000), executionPort?: NativeH3ReviewExecutionPort,
  runOwned?: (permit: OwnedNativeH3ReviewExecutionPermit) => ReturnType<ArtifactOrderAdapter['run']>): Promise<AnyNativeH3ReviewExecution> {
  request.signal.throwIfAborted()
  const selected = await selectNativeH3Binding(provider, { declaration: request.selection.declaration,
    sourceDigest: request.selection.sourceDigest, taskDefinitionSha256: request.selection.taskDefinitionSha256 })
  const owner = await identity()
  if (owner === null || !/^[a-f0-9]{64}$/u.test(request.contractSha256)) invalid()
  const v2 = selected.declaration.contractVersion === 'v2'
  if (v2 && (request.assertBindingCurrent === undefined || request.challenge.payload.contract_version !== 'v2'
    || selected.localOwnerConfigDigest === undefined)) invalid()
  const tuple = nativeH3ExpectedDeviceTuple(selected.declaration, { publicationId: request.publicationId,
    ownerId: owner.ownerId, deviceId: owner.deviceId, contractSha256: request.contractSha256,
    sourceDigest: selected.sourceDigest }, request.challenge.payload.contract_version === 'v2'
    && selected.localOwnerConfigDigest !== undefined ? { localOwnerConfigDigest: selected.localOwnerConfigDigest,
      deviceBindingRevision: request.challenge.payload.device_binding_revision } : undefined)
  if (!isVerifiedAnyNativeH3ReviewChallenge(request.challenge, tuple, now())) invalid()
  const challenge = request.challenge.payload
  const key = `${owner.ownerId}\0${owner.deviceId}\0${request.publicationId}\0${challenge.challenge_nonce}`
  for (const [nonce, expiry] of consumed) if (expiry <= now()) consumed.delete(nonce)
  if (consumed.has(key) || consumed.size >= 1024) invalid()
  const check = async (): Promise<void> => {
    const current = await identity()
    if (current?.ownerId !== owner.ownerId || current.deviceId !== owner.deviceId
      || !isVerifiedAnyNativeH3ReviewChallenge(request.challenge, tuple, now())) invalid()
    const fresh = await selectNativeH3Binding(provider, { declaration: request.selection.declaration,
      sourceDigest: request.selection.sourceDigest, taskDefinitionSha256: request.selection.taskDefinitionSha256 })
    if (fresh.localOwnerConfigDigest !== selected.localOwnerConfigDigest) invalid()
    if (v2) await request.assertBindingCurrent?.()
  }
  const canonical = selected.declaration.runtimeAbi === NATIVE_H3_RUNTIME_ABI_CANONICAL
  if (canonical && (executionPort === undefined || runOwned === undefined)) invalid()
  if ((executionPort === undefined) !== (runOwned === undefined)) invalid()
  const adapter = canonical ? await provider.loadAndSelfTestCanonical?.()
    : v2 ? await provider.loadAndSelfTestV2?.() : await provider.loadAndSelfTest()
  if (adapter === null || adapter === undefined) invalid()
  const remainingMs = (challenge.expires_at - now()) * 1000
  if (remainingMs <= 0) invalid()
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(remainingMs)])
  if (!isAbsolute(workspaceRoot)) invalid()
  await mkdir(workspaceRoot, { recursive: true })
  const root = await realpath(workspaceRoot)
  if (!samePath(workspaceRoot, root)) invalid()
  const workspace = await mkdtemp(join(root, 'native-h3-review-'))
  try {
    await check()
    const { prompt, ...params } = challenge.challenge_input
    const input = Object.freeze({ ...prepareH3OrderInput(prompt, params), workspacePath: workspace, signal })
    let permit: OwnedNativeH3ReviewExecutionPermit | undefined
    if (v2 && executionPort !== undefined) {
      permit = Object.freeze({ [reviewPermitBrand]: true as const })
      reviewPermits.set(permit, { request, ownerId: owner.ownerId, deviceId: owner.deviceId, runtime: adapter, input,
        executionKind: canonical ? 'canonical' : 'v2', bindingSha256: nativeH3PublicBindingDigest(selected.declaration).slice(7),
        inputSha256: createHash('sha256').update(input.recipeJson).digest('hex'), assertCurrent: check, state: 'issued' })
    }
    const execute = async (): Promise<AnyNativeH3ReviewExecution> => {
      await check()
      // Mark before execution, so an uncertain GPU/upload outcome never retries the same nonce.
      const completeClaim = await claimReviewNonce(root, key, request.challenge, now())
      consumed.set(key, challenge.expires_at)
      signal.throwIfAborted()
      const output = permit === undefined ? await adapter.run(input) : await (runOwned === undefined ? invalid() : runOwned(permit))
      if (output.filename !== 'result.mp4' || output.contentType !== 'video/mp4') invalid()
      const bytes = await readH3BoundedFile(output.path, MAX_OUTPUT)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await verifyTaskOutputs(workspace, { outputs: [{ name: 'result.mp4', path: output.path,
        bytes: bytes.length, sha256 }] }, MAX_OUTPUT, signal)
      await check()
      signal.throwIfAborted()
      const uploaded = await request.upload({ filename: 'result.mp4', contentType: 'video/mp4', bytes, sha256 }, signal)
      if (uploaded === null || typeof uploaded !== 'object' || Array.isArray(uploaded)) invalid()
      const artifact = uploaded as Record<string, unknown>
      if (Object.keys(artifact).sort().join(',') !== 'content_type,filename,object_key,object_version_id,result_id,schema,sha256,size_bytes'
        || artifact.schema !== 'artifact.v1' || artifact.filename !== 'result.mp4' || artifact.content_type !== 'video/mp4'
        || artifact.size_bytes !== bytes.length || artifact.sha256 !== sha256
        || typeof artifact.object_version_id !== 'string' || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(artifact.object_version_id)
        || artifact.object_version_id.toLowerCase() === 'null'
        || typeof artifact.result_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(artifact.result_id)
        || typeof artifact.object_key !== 'string' || artifact.object_key.length < 1 || artifact.object_key.length > 1024
        || /[\u0000-\u001f\u007f]/u.test(artifact.object_key) || artifact.object_key.includes('://') || artifact.object_key.includes('\\')
        || artifact.object_key.startsWith('/') || artifact.object_key.split('/').some(part => part === '..')) invalid()
      await check()
      const issued = now()
      const reference: NativeH3ReviewArtifact = { schema: 'artifact.v1', object_key: artifact.object_key,
        object_version_id: artifact.object_version_id, filename: 'result.mp4', content_type: 'video/mp4',
        size_bytes: bytes.length, sha256, result_id: artifact.result_id }
      const commonExecution = { challenge_nonce: challenge.challenge_nonce,
        challenge_input_sha256: challenge.challenge_input_sha256,
        challenge_result_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(reference)).digest('hex'),
        artifact: Object.freeze(reference), issued_at: issued, expires_at: Math.min(challenge.expires_at, issued + 300) }
      const execution: AnyNativeH3ReviewExecution = tuple.contract_version === 'v2'
        ? Object.freeze({ ...tuple, ...commonExecution, schema: 'qianshou.native-h3-review-execution.v2',
          purpose: 'qianshou:native-h3-review-execution.v2' })
        : Object.freeze({ ...tuple, ...commonExecution, schema: 'qianshou.native-h3-review-execution.v1',
          purpose: 'qianshou:native-h3-review-execution' })
      await completeClaim()
      return execution
    }
    if (permit !== undefined && executionPort !== undefined) return await executionPort(permit, execute)
    return await execute()
  } finally { await rm(workspace, { recursive: true, force: true }) }
}
