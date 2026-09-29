import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } from '../src/native-h3-binding.ts'
import type { NativeH3DeviceTuple } from '../src/native-h3-device-proof.ts'
import { canonicalNativeH3ReviewJson } from '../src/native-h3-review.ts'
import { isVerifiedNativeH3PresenceChallenge, verifyNativeH3PresenceChallenge,
  type NativeH3PresenceChallenge } from '../src/native-h3-presence.ts'

const now = 1_790_000_000
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const keys = new Map([['presence-purpose', publicKey]])
const tuple: NativeH3DeviceTuple = { publication_id: 'presence-fixture', owner_id: 167, device_id: 'physical-fixture',
  task_type: 'author_h3_fixture_v1', capability_id: 'video.render', contract_version: 'v1', contract_sha256: 'f'.repeat(64),
  artifact_digest: `sha256:${'d'.repeat(64)}`, source_digest: `sha256:${'d'.repeat(64)}`, config_digest: `sha256:${'a'.repeat(64)}` }
const payload: NativeH3PresenceChallenge = { ...tuple, schema: 'qianshou.native-h3-presence-challenge.v1',
  purpose: 'qianshou:native-h3-presence-challenge', challenge_nonce: Buffer.alloc(32, 1).toString('base64url'),
  native_binding: { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
    ownerConfigDigest: tuple.config_digest, executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) },
  sample_receipt_sha256: '1'.repeat(64), review_fingerprint: '2'.repeat(64),
  connection_id: 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193', device_key_id: 'enrolled-device-key',
  issued_at: now - 1, expires_at: now + 119 }
function envelope(value: unknown = payload) {
  return { key_id: 'presence-purpose', payload: value,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(value)), privateKey).toString('base64url') }
}

it('verifies an exact twenty-field purpose challenge and rejects copied or expired credentials', () => {
  const credential = verifyNativeH3PresenceChallenge(envelope(), tuple, keys, now)
  expect(Object.keys(credential.payload)).toHaveLength(20)
  expect(Object.isFrozen(credential.payload.native_binding)).toBe(true)
  expect(isVerifiedNativeH3PresenceChallenge(credential, tuple, now)).toBe(true)
  expect(isVerifiedNativeH3PresenceChallenge(JSON.parse(JSON.stringify(credential)), tuple, now)).toBe(false)
  expect(isVerifiedNativeH3PresenceChallenge(credential, tuple, payload.expires_at)).toBe(false)
})

it.each(Object.keys(tuple))('rejects an altered expected tuple field %s', (key) => {
  const altered = { ...tuple, [key]: key === 'owner_id' ? 222 : 'changed' }
  expect(() => verifyNativeH3PresenceChallenge(envelope(), altered, keys, now)).toThrow('H3_PRESENCE_CHALLENGE_INVALID')
})

it.each([
  { expires_at: now + 120 }, { connection_id: 'payload-cannot-mint-a-connection' },
  { purpose: 'qianshou:native-h3-device-attestor' }, { schema: 'qianshou.native-h3-review-challenge.v1' },
  { sample_receipt_sha256: 'sha256:' + '1'.repeat(64) }, { private_path: '/owner/private' },
  { native_binding: { ...payload.native_binding, ownerConfigDigest: `sha256:${'9'.repeat(64)}` } },
])('rejects signed but invalid presence metadata %j', (change) => {
  expect(() => verifyNativeH3PresenceChallenge(envelope({ ...payload, ...change }), tuple, keys, now))
    .toThrow('H3_PRESENCE_CHALLENGE_INVALID')
})

it('accepts only explicitly enrolled purpose keys, with no request-key fallback', () => {
  expect(() => verifyNativeH3PresenceChallenge(envelope(), tuple, new Map(), now)).toThrow('H3_PRESENCE_CHALLENGE_INVALID')
  expect(() => verifyNativeH3PresenceChallenge({ ...envelope(), publicKey }, tuple, keys, now))
    .toThrow('H3_PRESENCE_CHALLENGE_INVALID')
})
