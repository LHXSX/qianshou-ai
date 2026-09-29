/** Account-scoped native provider metadata; no media or private configuration crosses this route. */
import { createPublicKey, type KeyObject } from 'node:crypto'
import { parseNativeH3ContractBinding, parseNativeH3Declaration, parseNativeH3PortableExecutionBinding,
  parseAnyNativeH3Declaration, nativeH3LogicalBindingSha256,
  type AnyNativeH3Declaration as NativeH3Declaration }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { verifyNativeH3DeviceProof, verifyNativeH3DeviceProofV2, type AnyVerifiedNativeH3DeviceProof as VerifiedNativeH3DeviceProof }
  from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { CatalogFailure } from './registry.ts'

/** A real process-issued proof accompanies each current provider binding. */
export interface NativeH3CatalogBinding {
  readonly deviceKeyId?: string
  readonly connectionId?: string
  readonly localOwnerConfigDigest?: string
  readonly deviceBindingRevision?: number
  readonly declaration: NativeH3Declaration
  readonly publicationId: string
  readonly sourceDigest: string
  readonly taskDefinitionSha256: string
  readonly contractSha256: string
  readonly deviceProof: VerifiedNativeH3DeviceProof
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const SHA = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const ROW_KEYS = ['publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id', 'input_kinds',
  'output_kind', 'contract_version', 'input_contract', 'result_strategy', 'artifact_digest', 'package_digest',
  'source_digest', 'config_digest', 'contract_sha256', 'task_definition_sha256', 'native_binding', 'device_proof']

function invalid(): never { throw new CatalogFailure('order-platform-contract') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}

/** Decode explicitly enrolled Ed25519 purpose keys for native H3 proof verification.
 * @param keys - Key IDs mapped to canonical base64url-encoded 32-byte public keys.
 * @returns Validated public keys indexed by their enrolled IDs.
 */
export function nativeH3AttestorKeys(keys: Readonly<Record<string, string>>): ReadonlyMap<string, KeyObject> {
  const enrolled = new Map<string, KeyObject>()
  if (Object.keys(keys).length > 32) invalid()
  for (const [id, encoded] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(id) || !/^[A-Za-z0-9_-]{43}$/u.test(encoded)) invalid()
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.length !== 32 || bytes.toString('base64url') !== encoded) invalid()
    enrolled.set(id, createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]),
      format: 'der', type: 'spki' }))
  }
  return enrolled
}

/** Validate an authenticated binding response against its owner, worker and signed source tuple.
 * @param value - The platform response containing at most sixteen binding rows.
 * @param input - Expected identity, trusted attestor keys, epoch seconds and invalid-row policy.
 * @returns Verified bindings, excluding ambiguous task types and optionally invalid individual rows.
 */
export function parseNativeH3CatalogBindings(value: unknown,
  input: { ownerId: number
    workerId: string
    enrolledKeys: ReadonlyMap<string, KeyObject>
    now: number
    bindingVersion?: 2
    isolateInvalidRows?: boolean }): NativeH3CatalogBinding[] {
  if (input.bindingVersion === 2) return parseV2Bindings(value, input)
  try {
    const response = record(value)
    exact(response, ['schema', 'owner_id', 'worker_id', 'bindings'])
    if (response.schema !== 'qianshou.native-h3-order-bindings.v1'
      || response.owner_id !== input.ownerId || response.worker_id !== input.workerId
      || !Array.isArray(response.bindings) || response.bindings.length > 16) invalid()
    const seen = new Set<string>()
    const ambiguous = new Set<string>()
    const bindings = response.bindings.flatMap((value): NativeH3CatalogBinding[] => {
      try {
        const row = record(value)
        exact(row, ROW_KEYS)
        if (typeof row.task_type === 'string' && seen.has(row.task_type)) ambiguous.add(row.task_type)
        if (row.owner_id !== input.ownerId || row.device_id !== input.workerId
        || typeof row.publication_id !== 'string' || !UUID.test(row.publication_id)
        || typeof row.task_type !== 'string' || seen.has(row.task_type)
        || row.capability_id !== 'video.render' || row.output_kind !== 'artifact_ref' || row.contract_version !== 'v1'
        || !Array.isArray(row.input_kinds) || row.input_kinds.length !== 1 || row.input_kinds[0] !== 'inline'
        || row.input_contract !== 'h3-prompt-fixed-frame.v1' || row.result_strategy !== 'external-media.v1'
        || typeof row.artifact_digest !== 'string' || typeof row.package_digest !== 'string'
        || typeof row.source_digest !== 'string' || typeof row.config_digest !== 'string'
        || ![row.artifact_digest, row.package_digest, row.source_digest, row.config_digest].every(value => DIGEST.test(value))
        || row.artifact_digest !== row.source_digest || row.package_digest !== row.config_digest
        || typeof row.contract_sha256 !== 'string' || !SHA.test(row.contract_sha256)
        || typeof row.task_definition_sha256 !== 'string' || !SHA.test(row.task_definition_sha256)) invalid()
        const binding = parseNativeH3ContractBinding(row.native_binding)
        if (binding.ownerConfigDigest !== row.config_digest) invalid()
        const declaration = parseNativeH3Declaration({ ...binding, schema: 'qianshou.native-h3-binding.v1',
          taskType: row.task_type, capabilityId: 'video.render', category: 'video', inputKinds: ['inline'],
          outputKind: 'artifact_ref', contractVersion: 'v1', platformDispatchable: true })
        const deviceProof = verifyNativeH3DeviceProof(row.device_proof, {
          publication_id: row.publication_id, owner_id: input.ownerId, device_id: input.workerId,
          task_type: row.task_type, capability_id: 'video.render', contract_version: 'v1',
          contract_sha256: row.contract_sha256, artifact_digest: row.artifact_digest,
          source_digest: row.source_digest, config_digest: row.config_digest,
        }, input.enrolledKeys, input.now)
        seen.add(row.task_type)
        return [{ declaration, publicationId: row.publication_id, sourceDigest: row.source_digest,
          taskDefinitionSha256: `sha256:${row.task_definition_sha256}`, contractSha256: row.contract_sha256, deviceProof }]
      } catch {
        if (!input.isolateInvalidRows) return invalid()
        return []
      }
    })
    return bindings.filter(binding => !ambiguous.has(binding.declaration.taskType))
  } catch { return invalid() }
}

/** Fetch current approved bindings with native purpose keys rather than installation keys.
 * @param input - Control origin, current account token and worker, attestor keys and optional clock/fetch.
 * @returns Verified current bindings, or an empty list when no attestor keys are configured.
 */
export async function fetchNativeH3CatalogBindings(input: {
  origin: string
  token: string
  ownerId: number
  workerId: string
  enrolledKeys: ReadonlyMap<string, KeyObject>
  now?: number
  bindingVersion?: 2
  fetch?: typeof fetch
}): Promise<NativeH3CatalogBinding[]> {
  let origin: URL
  try { origin = new URL(input.origin) } catch { return invalid() }
  const local = ['127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')
    || !input.token || /[\r\n]/u.test(input.token)
    || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(input.workerId)
    || !Number.isSafeInteger(input.ownerId) || input.ownerId < 1) invalid()
  if (input.enrolledKeys.size === 0) return []
  const url = new URL('/api/v8/task-adapter-publications/native-bindings', origin)
  url.searchParams.set('worker_id', input.workerId)
  if (input.bindingVersion === 2) url.searchParams.set('binding_version', '2')
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(url, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { accept: 'application/json', authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(15_000) })
  } catch { throw new CatalogFailure('order-platform-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Never expose remote error bodies or credentials. */ }
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    throw new CatalogFailure(response.status === 404 ? 'order-platform-route-unavailable' : 'order-platform-unavailable')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) invalid()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 128 * 1024) invalid()
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }
  catch { return invalid() }
  return parseNativeH3CatalogBindings(value, { ...input, now: input.now ?? Math.floor(Date.now() / 1000),
    isolateInvalidRows: true })
}

function parseV2Bindings(value: unknown, input: { ownerId: number
  workerId: string
  enrolledKeys: ReadonlyMap<string, KeyObject>
  now: number
  isolateInvalidRows?: boolean }): NativeH3CatalogBinding[] {
  const response = record(value)
  exact(response, ['schema', 'owner_id', 'worker_id', 'bindings'])
  if (response.schema !== 'qianshou.native-h3-order-bindings.v2' || response.owner_id !== input.ownerId
    || response.worker_id !== input.workerId || !Array.isArray(response.bindings) || response.bindings.length > 16) invalid()
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  const values = response.bindings.flatMap((value): NativeH3CatalogBinding[] => {
    try {
      const row = record(value)
      exact(row, [...ROW_KEYS.filter(key => key !== 'config_digest'), 'logical_binding_sha256',
        'local_owner_config_digest', 'device_binding_revision', 'device_key_id', 'connection_id'])
      if (typeof row.task_type === 'string' && seen.has(row.task_type)) ambiguous.add(row.task_type)
      if (row.owner_id !== input.ownerId || row.device_id !== input.workerId || row.contract_version !== 'v2'
        || typeof row.publication_id !== 'string' || !UUID.test(row.publication_id)
        || typeof row.task_type !== 'string' || seen.has(row.task_type) || row.capability_id !== 'video.render'
        || row.output_kind !== 'artifact_ref' || !Array.isArray(row.input_kinds)
        || row.input_kinds.length !== 1 || row.input_kinds[0] !== 'inline'
        || row.input_contract !== 'h3-prompt-fixed-frame.v1' || row.result_strategy !== 'external-media.v1'
        || ![row.artifact_digest, row.package_digest, row.source_digest, row.local_owner_config_digest]
          .every(value => typeof value === 'string' && DIGEST.test(value))
        || row.artifact_digest !== row.source_digest
        || ![row.contract_sha256, row.task_definition_sha256, row.logical_binding_sha256]
          .every(value => typeof value === 'string' && SHA.test(value))
        || typeof row.device_key_id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(row.device_key_id)
        || typeof row.connection_id !== 'string' || !UUID.test(row.connection_id)
        || !Number.isSafeInteger(row.device_binding_revision) || Number(row.device_binding_revision) < 1) invalid()
      const binding = parseNativeH3PortableExecutionBinding(row.native_binding)
      const logical = nativeH3LogicalBindingSha256(binding)
      if (logical !== row.logical_binding_sha256 || row.package_digest !== `sha256:${logical}`) invalid()
      const declaration = parseAnyNativeH3Declaration({ ...binding, schema: 'qianshou.native-h3-binding.v2',
        taskType: row.task_type, capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
        contractVersion: 'v2', category: 'video', platformDispatchable: true })
      const deviceProof = verifyNativeH3DeviceProofV2(row.device_proof, { publication_id: row.publication_id,
        owner_id: input.ownerId, device_id: input.workerId, task_type: row.task_type, capability_id: 'video.render',
        contract_version: 'v2', contract_sha256: row.contract_sha256 as string, artifact_digest: row.artifact_digest as string,
        source_digest: row.source_digest as string, logical_binding_sha256: logical,
        local_owner_config_digest: row.local_owner_config_digest as string,
        device_binding_revision: row.device_binding_revision as number }, input.enrolledKeys, input.now)
      seen.add(row.task_type)
      return [{ declaration, publicationId: row.publication_id, sourceDigest: row.source_digest as string,
        taskDefinitionSha256: `sha256:${row.task_definition_sha256 as string}`, contractSha256: row.contract_sha256 as string,
        localOwnerConfigDigest: row.local_owner_config_digest as string,
        deviceBindingRevision: row.device_binding_revision as number, deviceKeyId: row.device_key_id,
        connectionId: row.connection_id, deviceProof }]
    } catch {
      if (!input.isolateInvalidRows) invalid()
      return []
    }
  })
  return values.filter(value => !ambiguous.has(value.declaration.taskType))
}
