import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL,
  NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, nativeH3DeclarationBinding,
  nativeH3LogicalBindingSha256, nativeH3PublicBindingDigest, parseAnyNativeH3ContractBinding,
  parseAnyNativeH3Declaration, parseNativeH3CanonicalExecutionBinding, parseNativeH3ExecutionBindingV2,
  parseNativeH3DeclarationV2 } from '../src/native-h3-binding.ts'
import { canonicalNativeH3ReviewJson } from '../src/native-h3-review.ts'
import { verifyNativeH3PresenceChallengeV2, isVerifiedNativeH3PresenceChallengeV2 } from '../src/native-h3-presence.ts'
import type { NativeH3DeviceTupleV2 } from '../src/native-h3-v2-evidence.ts'

const canonical = { schema: 'qianshou.native-h3-execution-binding.v2',
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL,
  executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) }
const declaration = { ...canonical, schema: 'qianshou.native-h3-binding.v2', taskType: 'canonical_h3_sample_v1',
  capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v2',
  category: 'video', platformDispatchable: true }
const fixedV2 = { ...canonical, runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2 }

it('preserves distinct canonical and fixed V2 software identity through declaration and public digest', () => {
  const parsed = parseAnyNativeH3Declaration(declaration)
  const binding = nativeH3DeclarationBinding(parsed)
  expect(binding).toEqual(canonical)
  expect(Object.keys(binding)).toHaveLength(6)
  expect(Object.keys(parsed)).toHaveLength(13)
  expect(Object.isFrozen(binding)).toBe(true)
  expect(Object.isFrozen(binding.runtime)).toBe(true)
  expect(Object.isFrozen(parsed.inputKinds)).toBe(true)
  expect(nativeH3PublicBindingDigest(parsed)).toBe(nativeH3PublicBindingDigest(binding))
  expect(nativeH3LogicalBindingSha256(parseNativeH3ExecutionBindingV2(fixedV2)))
    .not.toBe(nativeH3LogicalBindingSha256(parseNativeH3CanonicalExecutionBinding(canonical)))
  expect(() => parseNativeH3ExecutionBindingV2(canonical)).toThrow('H3_NATIVE_BINDING_INVALID')
  expect(() => parseNativeH3DeclarationV2(declaration)).toThrow('H3_NATIVE_BINDING_INVALID')
  expect(() => parseNativeH3CanonicalExecutionBinding(fixedV2)).toThrow('H3_NATIVE_BINDING_INVALID')
})

it.each([
  { runtimeAbi: 'qianshou.order-runtime.native-h3.canonical.v2' },
  { runtime: NATIVE_H3_RUNTIME_V2 },
  { runtime: { ...NATIVE_H3_RUNTIME_CANONICAL, entrySha256: '0'.repeat(64) } },
  { runtime: { ...NATIVE_H3_RUNTIME_CANONICAL, runtimeSha256: '0'.repeat(64) } },
  { runtime: { ...NATIVE_H3_RUNTIME_CANONICAL, engine: 'h3' } },
  { runtime: { ...NATIVE_H3_RUNTIME_CANONICAL, program: 'private/script.py' } },
  { softwareApproved: true }, { ownerConfigDigest: 'sha256:' + 'd'.repeat(64) },
  { firstFrameSha256: 'sha256:' + 'c'.repeat(64) },
])('rejects mixed software, arbitrary source and author approval/config fields %j', (change) => {
  expect(() => parseAnyNativeH3ContractBinding({ ...canonical, ...change })).toThrow('H3_NATIVE_BINDING_INVALID')
  expect(() => parseAnyNativeH3Declaration({ ...declaration, ...change })).toThrow('H3_NATIVE_BINDING_INVALID')
})

it('keeps actual purpose signatures, current device tuple, TTL and process-owned presence credentials', () => {
  const binding = parseNativeH3CanonicalExecutionBinding(canonical)
  const now = 1790000000
  const tuple: NativeH3DeviceTupleV2 = { publication_id: 'canonical-fixture', owner_id: 167, device_id: 'device-A',
    task_type: declaration.taskType, capability_id: 'video.render', contract_version: 'v2', contract_sha256: 'd'.repeat(64),
    artifact_digest: 'sha256:' + 'e'.repeat(64), source_digest: 'sha256:' + 'e'.repeat(64),
    logical_binding_sha256: nativeH3LogicalBindingSha256(binding), local_owner_config_digest: 'sha256:' + 'f'.repeat(64),
    device_binding_revision: 1 }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keys = new Map([['purpose-fixture', publicKey]])
  const payload = { ...tuple, schema: 'qianshou.native-h3-presence-challenge.v2',
    purpose: 'qianshou:native-h3-presence-challenge.v2', challenge_nonce: Buffer.alloc(32, 1).toString('base64url'),
    native_binding: binding, sample_receipt_sha256: '3'.repeat(64), review_fingerprint: '4'.repeat(64),
    connection_id: 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193', device_key_id: 'device-fixture',
    issued_at: now, expires_at: now + 120 }
  const envelope = (value: unknown) => ({ key_id: 'purpose-fixture', payload: value,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(value)), privateKey).toString('base64url') })
  const credential = verifyNativeH3PresenceChallengeV2(envelope(payload), tuple, keys, now)
  expect(isVerifiedNativeH3PresenceChallengeV2(credential, tuple, now)).toBe(true)
  expect(isVerifiedNativeH3PresenceChallengeV2(JSON.parse(JSON.stringify(credential)), tuple, now)).toBe(false)
  expect(isVerifiedNativeH3PresenceChallengeV2(credential, tuple, now + 120)).toBe(false)
  expect(isVerifiedNativeH3PresenceChallengeV2(credential, { ...tuple, device_id: 'device-B' }, now)).toBe(false)
  expect(() => verifyNativeH3PresenceChallengeV2(envelope({ ...payload, native_binding: fixedV2 }), tuple, keys, now)).toThrow()
  expect(() => verifyNativeH3PresenceChallengeV2(envelope(payload), tuple, new Map(), now)).toThrow()
  expect(() => verifyNativeH3PresenceChallengeV2(envelope({ ...payload, expires_at: now + 121 }), tuple, keys, now)).toThrow()
})
