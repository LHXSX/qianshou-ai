import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_V2, nativeH3LogicalBindingSha256,
  parseNativeH3ExecutionBindingV2, parseNativeH3DeclarationV2, nativeH3PublicBindingDigest } from '../src/native-h3-binding.ts'
import { canonicalNativeH3ReviewJson } from '../src/native-h3-review.ts'
import { verifyNativeH3DeviceProofV2, isVerifiedNativeH3DeviceProofV2 } from '../src/native-h3-device-proof.ts'
import { verifyNativeH3ReviewChallengeV2 } from '../src/native-h3-review.ts'
import { verifyNativeH3PresenceChallengeV2 } from '../src/native-h3-presence.ts'
import { verifyNativeH3V2Evidence, type NativeH3DeviceTupleV2 } from '../src/native-h3-v2-evidence.ts'

const now = 1790000000
const binding = parseNativeH3ExecutionBindingV2({ schema: 'qianshou.native-h3-execution-binding.v2',
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
  executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) })
const tuple: NativeH3DeviceTupleV2 = { publication_id: 'pub-fixture', owner_id: 167, device_id: 'device-A',
  task_type: 'qianshou_h3_fixture_v2', capability_id: 'video.render', contract_version: 'v2',
  contract_sha256: 'd'.repeat(64), artifact_digest: 'sha256:' + 'e'.repeat(64), source_digest: 'sha256:' + 'e'.repeat(64),
  logical_binding_sha256: nativeH3LogicalBindingSha256(binding), local_owner_config_digest: 'sha256:' + 'f'.repeat(64),
  device_binding_revision: 1 }
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const keys = new Map([['issuer-fixture', publicKey]])
const nonce = Buffer.alloc(32, 1).toString('base64url')
const proof = { ...tuple, schema: 'qianshou.native-h3-device-proof.v2', purpose: 'qianshou:native-h3-device-attestor.v2',
  challenge_nonce: nonce, challenge_input_sha256: '1'.repeat(64), challenge_result_sha256: '2'.repeat(64),
  result: 'pass', publication_status: 'approved', installation_state: 'installed', issued_at: now, expires_at: now + 300 }
function envelope(payload: unknown) { return { key_id: 'issuer-fixture', payload,
  signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), privateKey).toString('base64url') } }

it('has exactly six portable identity fields and canonical ordering without private paths', () => {
  expect(Object.keys(binding)).toHaveLength(6)
  const reverse = Object.fromEntries(Object.entries(binding).reverse())
  expect(nativeH3LogicalBindingSha256(parseNativeH3ExecutionBindingV2(reverse))).toBe(tuple.logical_binding_sha256)
  expect(nativeH3PublicBindingDigest(binding)).toBe('sha256:' + tuple.logical_binding_sha256)
  expect(() => parseNativeH3ExecutionBindingV2({ ...binding, ownerConfigDigest: tuple.local_owner_config_digest })).toThrow()
})
it('requires an explicit v2 author declaration and refuses mixed generations', () => {
  const { schema: _schema, ...identity } = binding
  const declaration = { ...identity, schema: 'qianshou.native-h3-binding.v2', taskType: tuple.task_type,
    capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
    contractVersion: 'v2', category: 'video', platformDispatchable: true }
  expect(Object.keys(parseNativeH3DeclarationV2(declaration))).toHaveLength(13)
  expect(() => parseNativeH3DeclarationV2({ ...declaration, contractVersion: 'v1' })).toThrow()
  expect(() => parseNativeH3DeclarationV2({ ...declaration, ownerConfigDigest: tuple.local_owner_config_digest })).toThrow()
})
it('mints a process-owned exact 22-field device proof for one current local revision', () => {
  const verified = verifyNativeH3DeviceProofV2(envelope(proof), tuple, keys, now)
  expect(Object.keys(verified.payload)).toHaveLength(22)
  expect(isVerifiedNativeH3DeviceProofV2(verified, tuple, now)).toBe(true)
  expect(isVerifiedNativeH3DeviceProofV2(JSON.parse(JSON.stringify(verified)), tuple, now)).toBe(false)
  expect(isVerifiedNativeH3DeviceProofV2(verified, tuple, now + 300)).toBe(false)
})
it.each(Object.keys(tuple))('rejects another expected tuple field %s even with a real signature', (key) => {
  const value = key === 'owner_id' || key === 'device_binding_revision' ? 222 : 'changed'
  expect(() => verifyNativeH3DeviceProofV2(envelope(proof), { ...tuple, [key]: value }, keys, now)).toThrow()
})
it('does not transfer A evidence to B or revive an old revision after paths change back', () => {
  const credential = verifyNativeH3DeviceProofV2(envelope(proof), tuple, keys, now)
  expect(isVerifiedNativeH3DeviceProofV2(credential, { ...tuple, device_id: 'device-B' }, now)).toBe(false)
  expect(isVerifiedNativeH3DeviceProofV2(credential, { ...tuple, device_binding_revision: 3 }, now)).toBe(false)
  expect(isVerifiedNativeH3DeviceProofV2(credential, { ...tuple, local_owner_config_digest: 'sha256:' + '9'.repeat(64) }, now)).toBe(false)
})
it.each([
  { expires_at: now + 301 }, { device_binding_revision: 0 }, { device_binding_revision: 1.5 },
  { schema: 'qianshou.native-h3-device-proof.v1' }, { purpose: 'qianshou:native-h3-device-attestor' },
  { config_digest: tuple.local_owner_config_digest }, { challenge_nonce: 'unknown-nonce' },
])('refuses signed malformed or v1 evidence %j', (change) => {
  expect(() => verifyNativeH3DeviceProofV2(envelope({ ...proof, ...change }), tuple, keys, now)).toThrow()
})
it('requires enrolled purpose keys rather than an envelope public key', () => {
  expect(() => verifyNativeH3DeviceProofV2(envelope(proof), tuple, new Map(), now)).toThrow()
  expect(() => verifyNativeH3DeviceProofV2({ ...envelope(proof), publicKey }, tuple, keys, now)).toThrow()
})
it('verifies an actual v2 input hash and rejects changed prompts or a copied v1 nonce plan', () => {
  const input = { prompt: '真实五秒样例', seconds: 5 }
  const payload = { ...tuple, schema: 'qianshou.native-h3-review-challenge.v2',
    purpose: 'qianshou:native-h3-review-challenge.v2', challenge_nonce: nonce, challenge_input: input,
    challenge_input_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(input)).digest('hex'),
    issued_at: now, expires_at: now + 900 }
  expect(Object.keys(verifyNativeH3ReviewChallengeV2(envelope(payload), tuple, keys, now).payload)).toHaveLength(19)
  expect(() => verifyNativeH3ReviewChallengeV2(envelope({ ...payload, challenge_input: { ...input, prompt: 'changed' } }), tuple, keys, now)).toThrow()
  expect(() => verifyNativeH3ReviewChallengeV2(envelope({ ...payload, schema: 'qianshou.native-h3-review-challenge.v1' }), tuple, keys, now)).toThrow()
})
it('binds presence to logical execution plus the device-local revision, without changing the public source', () => {
  const payload = { ...tuple, schema: 'qianshou.native-h3-presence-challenge.v2',
    purpose: 'qianshou:native-h3-presence-challenge.v2', challenge_nonce: nonce, native_binding: binding,
    sample_receipt_sha256: '3'.repeat(64), review_fingerprint: '4'.repeat(64),
    connection_id: 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193', device_key_id: 'device-fixture',
    issued_at: now, expires_at: now + 120 }
  expect(Object.keys(verifyNativeH3PresenceChallengeV2(envelope(payload), tuple, keys, now).payload)).toHaveLength(22)
  expect(() => verifyNativeH3PresenceChallengeV2(envelope({ ...payload,
    native_binding: { ...binding, firstFrameSha256: '9'.repeat(64) } }), tuple, keys, now)).toThrow()
})
it('admits a 21-field same-socket CAS plan and refuses unknown revision jumps', () => {
  const payload = { ...tuple, schema: 'qianshou.native-h3-device-config-enrollment.v2',
    purpose: 'qianshou:native-h3-device-config-enrollment.v2', nonce,
    challenge_id: '11111111-1111-4111-8111-111111111111', key_id: 'device-fixture',
    connection_id: 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193', expected_revision: 0, issued_at: now, expires_at: now + 300 }
  expect(Object.keys(verifyNativeH3V2Evidence(envelope(payload), tuple, keys, now, 'config').payload)).toHaveLength(21)
  expect(() => verifyNativeH3V2Evidence(envelope({ ...payload, expected_revision: 6 }), tuple, keys, now, 'config')).toThrow()
  expect(() => verifyNativeH3V2Evidence(envelope({ ...payload, expires_at: now + 301 }), tuple, keys, now, 'config')).toThrow()
})

it('keeps both published schema runtime constraints aligned with actual independently shipped V2 bytes and refuses the V1 generation', async () => {
  type RuntimeSpec = { properties: {
    runtimeAbi: { const: string }
    runtime: { properties: Record<'engine' | 'version' | 'entrySha256' | 'runtimeSha256', { const: string }> }
  } }
  const schemaPath = new URL('../../../../contracts/v2/native-h3-binding.schema.json', import.meta.url)
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as RuntimeSpec & { $defs: { contractBinding: RuntimeSpec } }
  const entry = await readFile(new URL('../../node-contributor/runtime/h3-v2/video_generate.py', import.meta.url))
  const runtime = await readFile(new URL('../../node-contributor/runtime/h3-v2/h3_runtime.py', import.meta.url))
  const actual = { engine: 'h3', version: 'h3-runtime-v2', entrySha256: createHash('sha256').update(entry).digest('hex'),
    runtimeSha256: createHash('sha256').update(runtime).digest('hex') }
  for (const spec of [schema, schema.$defs.contractBinding]) {
    expect(spec.properties.runtimeAbi.const).toBe(NATIVE_H3_RUNTIME_ABI_V2)
    const constrained = Object.fromEntries(Object.entries(spec.properties.runtime.properties).map(([key, value]) => [key, value.const]))
    expect(constrained).toEqual(actual)
    expect(constrained).toEqual(NATIVE_H3_RUNTIME_V2)
  }
  const authored = { ...binding, runtimeAbi: schema.$defs.contractBinding.properties.runtimeAbi.const, runtime: actual }
  expect(parseNativeH3ExecutionBindingV2(authored)).toEqual(binding)
  const { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } = await import('../src/native-h3-binding.ts')
  expect(() => parseNativeH3ExecutionBindingV2({ ...authored, runtimeAbi: NATIVE_H3_RUNTIME_ABI })).toThrow()
  expect(() => parseNativeH3ExecutionBindingV2({ ...authored, runtime: NATIVE_H3_RUNTIME })).toThrow()
  expect(() => parseNativeH3DeclarationV2({ ...authored, schema: 'qianshou.native-h3-binding.v2', taskType: tuple.task_type,
    capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v1', category: 'video',
    platformDispatchable: true })).toThrow()
})
