import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, parseNativeH3ContractBinding,
  parseNativeH3Declaration } from '../src/native-h3-binding.ts'
import { canonicalNativeH3DeviceProof, isVerifiedNativeH3DeviceProof, verifyNativeH3DeviceProof,
  type NativeH3DeviceProof, type NativeH3DeviceTuple } from '../src/native-h3-device-proof.ts'

const binding = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'a'.repeat(64)}`, executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }
const declaration = { ...binding, schema: 'qianshou.native-h3-binding.v1', taskType: 'author_h3_video_v1',
  capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v1',
  category: 'video', platformDispatchable: true }
const tuple: NativeH3DeviceTuple = { publication_id: 'published-h3', owner_id: 167, device_id: 'physical-win-worker',
  task_type: 'author_h3_video_v1', capability_id: 'video.render', contract_version: 'v1',
  contract_sha256: 'd'.repeat(64), artifact_digest: `sha256:${'e'.repeat(64)}`,
  source_digest: `sha256:${'e'.repeat(64)}`, config_digest: binding.ownerConfigDigest }
const now = 1_790_000_000
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const keys = new Map([['enrolled-device-attestor', publicKey]])
const proof: NativeH3DeviceProof = { ...tuple, schema: 'qianshou.native-h3-device-proof.v1',
  purpose: 'qianshou:native-h3-device-attestor', challenge_nonce: '独立样单-nonce',
  challenge_input_sha256: 'f'.repeat(64), challenge_result_sha256: '1'.repeat(64), result: 'pass',
  publication_status: 'approved', installation_state: 'installed', issued_at: now - 10, expires_at: now + 290 }

function envelope(payload: NativeH3DeviceProof = proof) {
  return { key_id: 'enrolled-device-attestor', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3DeviceProof(payload)), privateKey).toString('base64') }
}

it('locks exactly five contract identities and thirteen declaration fields without private paths', () => {
  const parsed = parseNativeH3Declaration(declaration)
  expect(parsed.runtime).toEqual(NATIVE_H3_RUNTIME)
  expect(Object.keys(parsed)).toHaveLength(13)
  expect(parseNativeH3ContractBinding(binding)).toEqual(binding)
  expect(Object.isFrozen(parsed)).toBe(true)
  expect(Object.isFrozen(parsed.inputKinds)).toBe(true)
  expect(() => parseNativeH3Declaration({ ...declaration, pythonPath: '/private/python' })).toThrow('H3_NATIVE_BINDING_INVALID')
})

it.each([
  { modelSha256: '' }, { executionRecipeSha256: `sha256:${'b'.repeat(64)}` },
  { ownerConfigDigest: 'a'.repeat(64) }, { outputKind: 'inline_json' }, { category: 'text' },
  { inputKinds: ['inline', 'single_file'] }, { taskType: '../shell' },
  { runtime: { ...NATIVE_H3_RUNTIME, entrySha256: '0'.repeat(64) } },
  { runtime: { ...NATIVE_H3_RUNTIME, program: '/private/python' } },
])('rejects mutable runtime, missing actual identities and buyer-controlled binding fields %j', (override) => {
  expect(() => parseNativeH3Declaration({ ...declaration, ...override })).toThrow('H3_NATIVE_BINDING_INVALID')
})

it('verifies a purpose-enrolled Ed25519 signature and refuses serialized credentials', () => {
  const credential = verifyNativeH3DeviceProof(envelope(), tuple, keys, now)
  expect(isVerifiedNativeH3DeviceProof(credential, tuple, now)).toBe(true)
  expect(isVerifiedNativeH3DeviceProof(JSON.parse(JSON.stringify(credential)), tuple, now)).toBe(false)
  expect(isVerifiedNativeH3DeviceProof(credential, tuple, proof.expires_at)).toBe(false)
  expect(isVerifiedNativeH3DeviceProof(credential, { ...tuple, device_id: 'another-pc' }, now)).toBe(false)
})

it.each(Object.keys(tuple))('rejects a changed expected tuple field %s even with a valid signature', (key) => {
  const changed = { ...tuple, [key]: key === 'owner_id' ? 222 : 'changed' }
  expect(() => verifyNativeH3DeviceProof(envelope(), changed, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
})

it('rejects signatures from request-supplied keys, tampering and pre-approval sample purposes', () => {
  expect(() => verifyNativeH3DeviceProof({ ...envelope(), publicKey }, tuple, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
  expect(() => verifyNativeH3DeviceProof(envelope(), tuple, new Map(), now)).toThrow('H3_DEVICE_PROOF_INVALID')
  expect(() => verifyNativeH3DeviceProof({ ...envelope(), payload: { ...proof, owner_id: 222 } },
    { ...tuple, owner_id: 222 }, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
  expect(() => verifyNativeH3DeviceProof({ ...envelope(), payload: { ...proof,
    purpose: 'qianshou:native-h3-review-challenge' } }, tuple, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
  expect(() => verifyNativeH3DeviceProof({ ...envelope(), payload: { ...proof, approved: true } },
    tuple, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
})

it('rejects expired or excessively long receipts without removing the current-time gate', () => {
  expect(() => verifyNativeH3DeviceProof(envelope(), tuple, keys, proof.expires_at)).toThrow('H3_DEVICE_PROOF_INVALID')
  expect(() => verifyNativeH3DeviceProof(envelope({ ...proof, expires_at: proof.issued_at + 301 }),
    tuple, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
  expect(() => verifyNativeH3DeviceProof(envelope({ ...proof, issued_at: now + 31 }),
    tuple, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
})

it('accepts exactly 300 seconds and rejects a correctly signed 301-second device proof', () => {
  const boundary = { ...proof, issued_at: now, expires_at: now + 300 }
  const credential = verifyNativeH3DeviceProof(envelope(boundary), tuple, keys, now)
  expect(isVerifiedNativeH3DeviceProof(credential, tuple, now + 299)).toBe(true)
  expect(isVerifiedNativeH3DeviceProof(credential, tuple, now + 300)).toBe(false)
  expect(() => verifyNativeH3DeviceProof(envelope({ ...boundary, expires_at: now + 301 }),
    tuple, keys, now)).toThrow('H3_DEVICE_PROOF_INVALID')
})
