/** Published H3 reuses only the fixed native runner and exact signed device tuple. */
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { createHash } from 'node:crypto'
import type { NativeH3AdapterClaim } from '@deepseek-ai/dsh-compute-core/transport/edge-worker-session'
import { parseAnyNativeH3ContractBinding, parseAnyNativeH3Declaration, nativeH3DeclarationBinding,
  nativeH3PublicBindingDigest, nativeH3LogicalBindingSha256, NATIVE_H3_RUNTIME_ABI_CANONICAL, type AnyNativeH3ContractBinding,
  type AnyNativeH3Declaration as NativeH3Declaration } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { isVerifiedAnyNativeH3DeviceProof, type AnyNativeH3DeviceTuple as NativeH3DeviceTuple,
  type AnyVerifiedNativeH3DeviceProof as VerifiedNativeH3DeviceProof } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { isAdmittedNativeH3TaskLeaseV2, type NativeH3TaskLeaseV2 } from '@deepseek-ai/dsh-compute-core/native-h3-task-lease'
import type { ArtifactOrderAdapter } from './artifact-order.ts'
import type { createH3VideoProvider } from './h3-video.ts'
import type { createH3VideoProviderV2 } from './h3-video-v2.ts'
import type { createH3CanonicalProvider } from './h3-canonical-provider.ts'

/** Author selection records identities, never a platform approval or owner grant. */
export interface NativeH3LocalSelection {
  readonly declaration: NativeH3Declaration
  readonly sourceDigest: string
  readonly taskDefinitionSha256: string
  readonly localOwnerConfigDigest?: string
}

/** Catalog admission must supply a process-verified, still-current installed device proof. */
export interface NativeH3PublishedBinding extends NativeH3LocalSelection {
  readonly connectionId?: string
  readonly deviceKeyId?: string
  readonly publicationId: string
  /** Shanghai's TaskSpec snapshot SHA; distinct from the author JSON file SHA. */
  readonly contractSha256: string
  readonly deviceProof: VerifiedNativeH3DeviceProof
}

const adapters = new WeakSet<object>()
const claims = new WeakMap<object, NativeH3AdapterClaim>()
const claimCurrent = new WeakMap<object, () => boolean>()
const leaseExpectations = new WeakMap<object, { tuple: NativeH3DeviceTuple; connectionId: string; deviceKeyId: string }>()
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const HASH = /^[a-f0-9]{64}$/u
type PreparationProvider = Pick<ReturnType<typeof createH3VideoProvider>, 'nativeAuthorBinding'>
  & Partial<Pick<ReturnType<typeof createH3VideoProviderV2>, 'nativeAuthorBindingV2' | 'loadAndSelfTestV2'>>
  & Partial<Pick<ReturnType<typeof createH3CanonicalProvider>, 'nativeAuthorBindingCanonical' | 'loadAndSelfTestCanonical'>>
type Provider = PreparationProvider & Pick<ReturnType<typeof createH3VideoProvider>, 'loadAndSelfTest'>
type RunInput = Parameters<ArtifactOrderAdapter['run']>[0]
type RunResult = Awaited<ReturnType<ArtifactOrderAdapter['run']>>
const permitBrand = Symbol('owned native execution')
/** Single-use original factory capability; structural metadata cannot authorize local execution. */
export interface OwnedH3ExecutionPermit { readonly [permitBrand]: true }
interface PermitRecord {
  readonly runtime: ArtifactOrderAdapter
  readonly alias: ArtifactOrderAdapter
  readonly input: RunInput
  readonly lease: NativeH3TaskLeaseV2
  readonly executionKind: 'v2' | 'canonical'
  readonly bindingSha256: string
  readonly inputSha256: string
  readonly assertCurrent: () => Promise<void>
  state: 'issued' | 'executing' | 'terminal' | 'unknown'
}
const permits = new WeakMap<OwnedH3ExecutionPermit, PermitRecord>()
/** Owning Host port; it does not accept browser claims or replace the fixed runner. */
export type NativeH3PublishedExecutionPort = (permit: OwnedH3ExecutionPermit) => Promise<RunResult>

/** Read original execution facts for the owning Host admission, never mint a permit from metadata.
 * @param permit - Original single-use capability issued inside the published adapter factory.
 * @returns Captured runtime, input and authenticated lease while that operation is still active.
 */
export function readOwnedH3ExecutionPermit(permit: OwnedH3ExecutionPermit): Readonly<PermitRecord> {
  const record = permits.get(permit)
  if (!record || !['issued', 'executing'].includes(record.state)
    || !nativeH3AdapterMatchesLease(record.alias, record.lease) || record.input.nativeDeviceLease !== record.lease
    || createHash('sha256').update(record.input.recipeJson).digest('hex') !== record.inputSha256) invalid()
  return Object.freeze({ ...record })
}

/** Consume a factory capability once, retaining uncertainty after any failure.
 * @param permit - Original active execution capability, not a JSON copy or caller-generated token.
 * @param action - Owning reservation transaction; failed execution cannot be automatically repeated.
 * @returns The reservation's independently verified local result.
 */
export async function consumeOwnedH3ExecutionPermit<T>(permit: OwnedH3ExecutionPermit, action: () => Promise<T>): Promise<T> {
  const record = permits.get(permit)
  if (!record || record.state !== 'issued') invalid()
  readOwnedH3ExecutionPermit(permit)
  record.state = 'executing'
  try { const result = await action(); record.state = 'terminal'; return result }
  catch (error) { record.state = 'unknown'; throw error }
}

function invalid(): never { throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409) }

function sameBinding(a: AnyNativeH3ContractBinding | NativeH3Declaration,
  b: AnyNativeH3ContractBinding | NativeH3Declaration): boolean {
  return nativeH3PublicBindingDigest(a) === nativeH3PublicBindingDigest(b)
    && a.executionRecipeSha256 === b.executionRecipeSha256 && a.modelSha256 === b.modelSha256
}
async function localIdentity(provider: PreparationProvider, declaration: NativeH3Declaration) {
  if (declaration.schema === 'qianshou.native-h3-binding.v2') {
    if (declaration.runtimeAbi === NATIVE_H3_RUNTIME_ABI_CANONICAL) {
      if (provider.nativeAuthorBindingCanonical === undefined) invalid()
      const current = await provider.nativeAuthorBindingCanonical()
      if (!sameBinding(current.binding, declaration)) invalid()
      return { binding: current.binding, localOwnerConfigDigest: current.localOwnerConfigDigest }
    }
    if (provider.nativeAuthorBindingV2 === undefined) invalid()
    const current = await provider.nativeAuthorBindingV2()
    if (!sameBinding(current.binding, declaration)) invalid()
    return { binding: current.binding, localOwnerConfigDigest: current.localOwnerConfigDigest }
  }
  const binding = parseAnyNativeH3ContractBinding(await provider.nativeAuthorBinding())
  if (!sameBinding(binding, declaration)) invalid()
  return { binding }
}

/** Check current owner preparation before saving a declaration; this does not enable supply.
 * @param provider - The fixed local H3 provider with an actual adapter identity reader.
 * @param input - Exact public source and task contract identities prepared by the catalog.
 * @returns Validated local selection; publication and device approval remain independent.
 */
export async function selectNativeH3Binding(provider: PreparationProvider,
  input: unknown): Promise<NativeH3LocalSelection> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'declaration,sourceDigest,taskDefinitionSha256') invalid()
  const row = input as Record<string, unknown>
  if (typeof row.sourceDigest !== 'string' || !DIGEST.test(row.sourceDigest)
    || typeof row.taskDefinitionSha256 !== 'string' || !DIGEST.test(row.taskDefinitionSha256)) invalid()
  const declaration = parseAnyNativeH3Declaration(row.declaration)
  const current = await localIdentity(provider, declaration)
  return Object.freeze({ declaration, sourceDigest: row.sourceDigest,
    taskDefinitionSha256: row.taskDefinitionSha256,
    ...current.localOwnerConfigDigest === undefined ? {} : { localOwnerConfigDigest: current.localOwnerConfigDigest } })
}

function tuple(input: NativeH3PublishedBinding, ownerId: number, deviceId: string,
  localOwnerConfigDigest?: string): NativeH3DeviceTuple {
  const common = { publication_id: input.publicationId, owner_id: ownerId, device_id: deviceId,
    task_type: input.declaration.taskType, capability_id: 'video.render' as const,
    contract_sha256: input.contractSha256, artifact_digest: input.sourceDigest, source_digest: input.sourceDigest }
  if (input.declaration.schema === 'qianshou.native-h3-binding.v2') {
    if (input.deviceProof.payload.contract_version !== 'v2' || localOwnerConfigDigest === undefined) invalid()
    const binding = nativeH3DeclarationBinding(input.declaration)
    if ('ownerConfigDigest' in binding) invalid()
    return { ...common, contract_version: 'v2', logical_binding_sha256: nativeH3LogicalBindingSha256(binding),
      local_owner_config_digest: localOwnerConfigDigest,
      device_binding_revision: input.deviceProof.payload.device_binding_revision }
  }
  return { ...common, contract_version: 'v1', config_digest: input.declaration.ownerConfigDigest }
}

/** Build an exact task alias only after real local identity and signed platform proof agree.
 * @param provider - Fixed H3 execution provider; no submitted program can replace it.
 * @param initial - Publication source, contract and verified installed device proof.
 * @param identity - Current authenticated owner and acknowledged physical worker.
 * @param readCurrent - Rereads current approval/installation evidence before each execution.
 * @param now - Trusted current epoch seconds.
 * @param execute - Optional owning Host reservation port for admitted portable native tasks.
 * @returns A process-branded adapter sharing the ordinary lease-bound media upload path.
 */
export async function createPublishedNativeH3Adapter(provider: Provider, initial: NativeH3PublishedBinding,
  identity: { readonly ownerId: number; readonly deviceId: string; readonly connectionId?: string },
  readCurrent: () => Promise<NativeH3PublishedBinding | null>,
  now: () => number = () => Math.floor(Date.now() / 1000),
  execute?: NativeH3PublishedExecutionPort): Promise<ArtifactOrderAdapter> {
  if (!HASH.test(initial.contractSha256) || !initial.publicationId) invalid()
  const selected = await selectNativeH3Binding(provider, { declaration: initial.declaration,
    sourceDigest: initial.sourceDigest, taskDefinitionSha256: initial.taskDefinitionSha256 })
  const expected = tuple(initial, identity.ownerId, identity.deviceId, selected.localOwnerConfigDigest)
  if (!isVerifiedAnyNativeH3DeviceProof(initial.deviceProof, expected, now())) invalid()
  if (expected.contract_version === 'v2' && (!initial.deviceKeyId || !initial.connectionId
    || initial.connectionId !== identity.connectionId)) invalid()
  let currentProof = initial.deviceProof
  const runtime = selected.declaration.runtimeAbi === NATIVE_H3_RUNTIME_ABI_CANONICAL
    ? await provider.loadAndSelfTestCanonical?.() : expected.contract_version === 'v2'
      ? await provider.loadAndSelfTestV2?.() : await provider.loadAndSelfTest()
  if (runtime === null || runtime === undefined) invalid()
  const recheck = async (): Promise<void> => {
    const current = await readCurrent()
    if (current === null || current.sourceDigest !== selected.sourceDigest
      || current.taskDefinitionSha256 !== selected.taskDefinitionSha256
      || current.publicationId !== initial.publicationId || current.contractSha256 !== initial.contractSha256
      || current.declaration.taskType !== selected.declaration.taskType
      || current.deviceKeyId !== initial.deviceKeyId || current.connectionId !== initial.connectionId
      || !sameBinding(current.declaration, selected.declaration)
      || !isVerifiedAnyNativeH3DeviceProof(current.deviceProof, expected, now())) invalid()
    const actual = await localIdentity(provider, selected.declaration)
    if (expected.contract_version === 'v2' && actual.localOwnerConfigDigest !== expected.local_owner_config_digest) invalid()
    currentProof = current.deviceProof
    const claim = claims.get(adapter)
    if (claim !== undefined) claims.set(adapter, Object.freeze({ ...claim,
      device_proof_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(currentProof.payload)).digest('hex') }))
  }
  const adapter: ArtifactOrderAdapter = { ...runtime, taskType: selected.declaration.taskType,
    contractVersion: selected.declaration.contractVersion,
    artifactDigest: selected.sourceDigest, packageDigest: nativeH3PublicBindingDigest(selected.declaration),
    async run(input) {
      await recheck()
      if (expected.contract_version === 'v2' && !nativeH3AdapterMatchesLease(adapter, input.nativeDeviceLease)) invalid()
      let result: RunResult
      if (expected.contract_version === 'v2' && execute !== undefined) {
        if (!nativeH3AdapterMatchesLease(adapter, input.nativeDeviceLease)) invalid()
        const permit = Object.freeze({ [permitBrand]: true } as const)
        permits.set(permit, { runtime, alias: adapter, input: Object.freeze({ ...input }), lease: input.nativeDeviceLease,
          executionKind: selected.declaration.runtimeAbi === NATIVE_H3_RUNTIME_ABI_CANONICAL ? 'canonical' : 'v2',
          bindingSha256: nativeH3PublicBindingDigest(selected.declaration).slice(7),
          inputSha256: createHash('sha256').update(input.recipeJson).digest('hex'), assertCurrent: recheck, state: 'issued' })
        result = await execute(permit)
      } else result = await runtime.run(input)
      await recheck()
      if (expected.contract_version === 'v2' && !nativeH3AdapterMatchesLease(adapter, input.nativeDeviceLease)) invalid()
      return result
    } }
  adapters.add(adapter)
  if (expected.contract_version === 'v2' && initial.connectionId !== undefined && initial.deviceKeyId !== undefined) {
    leaseExpectations.set(adapter, { tuple: expected, connectionId: initial.connectionId, deviceKeyId: initial.deviceKeyId })
  }
  const commonClaim = { task_type: selected.declaration.taskType, capability_id: 'video.render' as const,
    input_kinds: Object.freeze(['inline'] as const), output_kind: 'artifact_ref' as const,
    artifact_digest: selected.sourceDigest, package_digest: nativeH3PublicBindingDigest(selected.declaration),
    installation_state: 'installed' as const, health: 'verified' as const, self_test: 'passed' as const,
    publication_id: initial.publicationId, contract_sha256: initial.contractSha256,
    device_proof_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(initial.deviceProof.payload)).digest('hex') }
  const binding = nativeH3DeclarationBinding(selected.declaration)
  if (expected.contract_version === 'v2') {
    if ('ownerConfigDigest' in binding) invalid()
    claims.set(adapter, Object.freeze({ ...commonClaim, contract_version: 'v2', native_binding: binding,
      local_owner_config_digest: expected.local_owner_config_digest, device_binding_revision: expected.device_binding_revision }))
  } else {
    if (!('ownerConfigDigest' in binding)) invalid()
    claims.set(adapter, Object.freeze({ ...commonClaim, contract_version: 'v1', native_binding: binding }))
  }
  claimCurrent.set(adapter, () => isVerifiedAnyNativeH3DeviceProof(currentProof, expected, now()))
  return Object.freeze(adapter)
}

/** Match an ordinary task's server-frozen device revision before and after the actual fixed runner.
 * @param adapter - Original native factory result; copies cannot own an ordinary native lease.
 * @param lease - Original credential read from the authenticated assignment's Host-owned lease map.
 * @returns Whether this exact owner/source/private revision/key/connection may execute that lease.
 */
export function nativeH3AdapterMatchesLease(adapter: unknown, lease: unknown): lease is NativeH3TaskLeaseV2 {
  if (typeof adapter !== 'object' || adapter === null || !adapters.has(adapter)
    || !isAdmittedNativeH3TaskLeaseV2(lease)) return false
  const expected = leaseExpectations.get(adapter)
  return expected !== undefined && Object.entries(expected.tuple).every(([key, value]) =>
    (lease as unknown as Record<string, unknown>)[key] === value)
    && lease.connection_id === expected.connectionId && lease.device_key_id === expected.deviceKeyId
}

/** Extract metadata only from the fixed factory's independently proven native adapter.
 * @param adapter - Process-owned adapter; structural copies carry no claim.
 * @returns The exact bounded server-checkable claim, or null for an unbranded value.
 */
export function nativeH3AdapterClaim(adapter: unknown): NativeH3AdapterClaim | null {
  return typeof adapter === 'object' && adapter !== null && claimCurrent.get(adapter)?.() === true
    ? claims.get(adapter) ?? null : null
}

/** Structural lookalikes cannot enter the dynamic native declaration channel.
 * @param value - Adapter returned by an optional catalog-backed provider.
 * @returns True only for a fixed H3 adapter minted in this process.
 */
export function isPublishedNativeH3Adapter(value: unknown): value is ArtifactOrderAdapter {
  return typeof value === 'object' && value !== null && adapters.has(value)
}
