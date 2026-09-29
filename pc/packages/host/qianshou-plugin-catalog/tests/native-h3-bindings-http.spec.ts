import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3DeviceProof, isVerifiedNativeH3DeviceProof, type NativeH3DeviceProof }
  from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { fetchNativeH3CatalogBindings, nativeH3AttestorKeys, parseNativeH3CatalogBindings }
  from '../src/native-h3-bindings-http.ts'

const pair = generateKeyPairSync('ed25519')
const rawKey = (pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
const enrolledKeys = nativeH3AttestorKeys({ 'unit-native-purpose': rawKey })
const binding = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'a'.repeat(64)}`, executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }
const proof: NativeH3DeviceProof = {
  schema: 'qianshou.native-h3-device-proof.v1', purpose: 'qianshou:native-h3-device-attestor',
  publication_id: '00000000-0000-4000-8000-000000000001', owner_id: 7, device_id: 'unit-worker',
  task_type: 'qianshou_h3_unit_v1', capability_id: 'video.render', contract_version: 'v1',
  contract_sha256: 'd'.repeat(64), artifact_digest: `sha256:${'e'.repeat(64)}`,
  source_digest: `sha256:${'e'.repeat(64)}`, config_digest: binding.ownerConfigDigest,
  challenge_nonce: 'unit-isolated-challenge', challenge_input_sha256: 'f'.repeat(64), challenge_result_sha256: '1'.repeat(64),
  result: 'pass', publication_status: 'approved', installation_state: 'installed', issued_at: 100, expires_at: 200,
}
function envelope(payload = proof) {
  return { key_id: 'unit-native-purpose', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3DeviceProof(payload)), pair.privateKey).toString('base64') }
}
function response() {
  return { schema: 'qianshou.native-h3-order-bindings.v1', owner_id: 7, worker_id: 'unit-worker', bindings: [{
    publication_id: proof.publication_id, owner_id: 7, device_id: 'unit-worker', task_type: proof.task_type,
    capability_id: 'video.render', input_kinds: ['inline'], output_kind: 'artifact_ref', contract_version: 'v1',
    input_contract: 'h3-prompt-fixed-frame.v1', result_strategy: 'external-media.v1',
    artifact_digest: proof.artifact_digest, source_digest: proof.source_digest,
    package_digest: proof.config_digest, config_digest: proof.config_digest,
    task_definition_sha256: '2'.repeat(64), contract_sha256: proof.contract_sha256,
    native_binding: binding, device_proof: envelope(),
  }] }
}
const expected = { ownerId: 7, workerId: 'unit-worker', enrolledKeys, now: 150 }

it('mints a process proof from the enrolled native-purpose signer and preserves distinct definition/contract hashes', () => {
  const [result] = parseNativeH3CatalogBindings(response(), expected)
  expect(result?.taskDefinitionSha256).toBe(`sha256:${'2'.repeat(64)}`)
  expect(result?.contractSha256).toBe('d'.repeat(64))
  expect(isVerifiedNativeH3DeviceProof(result?.deviceProof, proof, 150)).toBe(true)
  expect(isVerifiedNativeH3DeviceProof(JSON.parse(JSON.stringify(result?.deviceProof)) as unknown, proof, 150)).toBe(false)
  expect(isVerifiedNativeH3DeviceProof(result?.deviceProof, proof, 200)).toBe(false)
})

it.each(['owner', 'worker', 'key', 'purpose', 'expired', 'config', 'source', 'approval'])('rejects %s mismatches despite a valid looking response', (reason) => {
  const data = response()
  const row = data.bindings[0]!
  const options = { ...expected }
  if (reason === 'owner') options.ownerId = 8
  if (reason === 'worker') options.workerId = 'other-worker'
  if (reason === 'key') options.enrolledKeys = new Map()
  if (reason === 'purpose') row.device_proof = envelope({ ...proof, purpose: 'qianshou:sample-attestor' as NativeH3DeviceProof['purpose'] })
  if (reason === 'expired') options.now = 200
  if (reason === 'config') row.config_digest = `sha256:${'9'.repeat(64)}`
  if (reason === 'source') row.artifact_digest = `sha256:${'9'.repeat(64)}`
  if (reason === 'approval') row.device_proof = envelope({ ...proof, publication_status: 'review' as NativeH3DeviceProof['publication_status'] })
  expect(() => parseNativeH3CatalogBindings(data, options)).toThrow()
})

it('fetches owner-scoped metadata without caller owner_id, media or redirects', async () => {
  let observed: { url: string; init?: RequestInit } | undefined
  const result = await fetchNativeH3CatalogBindings({ origin: 'https://example.invalid', token: 'unit-token', ...expected,
    fetch: async (url, init) => {
      observed = { url: url instanceof Request ? url.url : url.toString(), ...(init === undefined ? {} : { init }) }
      return Response.json(response())
    } })
  expect(result).toHaveLength(1)
  expect(observed?.url).toBe('https://example.invalid/api/v8/task-adapter-publications/native-bindings?worker_id=unit-worker')
  expect(observed?.init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
  expect(observed?.init?.body).toBeUndefined()
})

it('does not request with no enrolled purpose keys and rejects oversized metadata', async () => {
  let requested = false
  const fetcher: typeof fetch = async () => { requested = true; return Response.json(response()) }
  expect(await fetchNativeH3CatalogBindings({ origin: 'https://example.invalid', token: 'unit-token', ...expected,
    enrolledKeys: new Map(), fetch: fetcher })).toEqual([])
  expect(requested).toBe(false)
  await expect(fetchNativeH3CatalogBindings({ origin: 'https://example.invalid', token: 'unit-token', ...expected,
    fetch: async () => new Response('x'.repeat(128 * 1024 + 1)) })).rejects.toThrow()
})

it('keeps another current provider when one signed row expires during the metadata request', async () => {
  const data = response()
  const stale = { ...proof, publication_id: '00000000-0000-4000-8000-000000000003',
    task_type: 'qianshou_h3_expired_unit_v1', expires_at: 150 }
  data.bindings.push({ ...data.bindings[0]!, publication_id: stale.publication_id,
    task_type: stale.task_type, device_proof: envelope(stale) })
  const result = await fetchNativeH3CatalogBindings({ origin: 'https://example.invalid', token: 'unit-token', ...expected,
    fetch: async () => Response.json(data) })
  expect(result.map(row => row.publicationId)).toEqual([proof.publication_id])
  expect(isVerifiedNativeH3DeviceProof(result[0]?.deviceProof, proof, expected.now)).toBe(true)
})

it('does not select an ambiguous duplicate native task even when both row signatures are valid', async () => {
  const data = response()
  const duplicate = { ...proof, publication_id: '00000000-0000-4000-8000-000000000004' }
  data.bindings.push({ ...data.bindings[0]!, publication_id: duplicate.publication_id, device_proof: envelope(duplicate) })
  expect(await fetchNativeH3CatalogBindings({ origin: 'https://example.invalid', token: 'unit-token', ...expected,
    fetch: async () => Response.json(data) })).toEqual([])
})

it.each(['python-v2', 'canonical'] as const)('reads exact22 %s bindings with separate current key/connection and refuses old revision or V1 response promotion', async (runtime) => {
  const { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL, nativeH3LogicalBindingSha256, parseNativeH3PortableExecutionBinding } = await import('../../compute-core/src/native-h3-binding.ts')
  const { canonicalNativeH3ReviewJson } = await import('../../compute-core/src/native-h3-review.ts')
  const publicV2 = parseNativeH3PortableExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2' as const, runtimeAbi: runtime === 'canonical' ? NATIVE_H3_RUNTIME_ABI_CANONICAL : NATIVE_H3_RUNTIME_ABI_V2,
    runtime: runtime === 'canonical' ? NATIVE_H3_RUNTIME_CANONICAL : NATIVE_H3_RUNTIME_V2, executionRecipeSha256: binding.executionRecipeSha256, modelSha256: binding.modelSha256,
    firstFrameSha256: '3'.repeat(64) })
  const payload = { ...proof, contract_version: 'v2', schema: 'qianshou.native-h3-device-proof.v2',
    purpose: 'qianshou:native-h3-device-attestor.v2', logical_binding_sha256: nativeH3LogicalBindingSha256(publicV2),
    local_owner_config_digest: binding.ownerConfigDigest, device_binding_revision: 1,
    challenge_nonce: Buffer.alloc(32, 8).toString('base64url') }
  const { config_digest: _unused, ...signedPayload } = payload
  const signed = { key_id: 'unit-native-purpose', payload: signedPayload,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(signedPayload)), pair.privateKey).toString('base64url') }
  const { config_digest: _old, ...baseRow } = response().bindings[0]!
  const row = { ...baseRow, contract_version: 'v2', native_binding: publicV2, logical_binding_sha256: payload.logical_binding_sha256,
    package_digest: `sha256:${payload.logical_binding_sha256}`, local_owner_config_digest: payload.local_owner_config_digest,
    device_binding_revision: 1, device_key_id: 'native-device', connection_id: '00000000-0000-4000-8000-000000000002', device_proof: signed }
  expect(Object.keys(row)).toHaveLength(22)
  const value = { schema: 'qianshou.native-h3-order-bindings.v2', owner_id: 7, worker_id: 'unit-worker', bindings: [row] }
  const options = { ...expected, bindingVersion: 2 as const }
  const [parsed] = parseNativeH3CatalogBindings(value, options)
  expect(parsed).toMatchObject({ connectionId: row.connection_id, deviceKeyId: row.device_key_id, deviceBindingRevision: 1 })
  expect(() => parseNativeH3CatalogBindings({ ...value, bindings: [{ ...row, device_binding_revision: 3 }] }, options)).toThrow()
  expect(() => parseNativeH3CatalogBindings(response(), options)).toThrow()
  for (const changedBinding of [
    { ...publicV2, runtimeAbi: 'unknown-native-runtime' },
    { ...publicV2, runtime: { ...publicV2.runtime, entrySha256: '0'.repeat(64) } },
    { ...publicV2, authorPolicyRef: 'must-not-authorize-software' },
  ]) {
    expect(() => parseNativeH3CatalogBindings({ ...value, bindings: [{ ...row, native_binding: changedBinding }] }, options)).toThrow()
  }
  for (const changedProof of [
    { ...signedPayload, purpose: 'qianshou:native-h3-device-attestor' },
    { ...signedPayload, expires_at: signedPayload.issued_at + 301 },
  ]) {
    const signedNegative = { ...signed, payload: changedProof,
      signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(changedProof)), pair.privateKey).toString('base64url') }
    expect(() => parseNativeH3CatalogBindings({ ...value, bindings: [{ ...row, device_proof: signedNegative }] }, options)).toThrow()
  }
  const requests: string[] = []
  expect(await fetchNativeH3CatalogBindings({ origin: 'https://example.invalid', token: 'unit-token', ...options,
    fetch: async (url) => { requests.push(url instanceof Request ? url.url : String(url)); return Response.json(value) } })).toHaveLength(1)
  expect(requests[0]).toContain('binding_version=2')
})
