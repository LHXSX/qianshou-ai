/** A short-lived presence challenge renews an independently reviewed native binding without GPU execution. */
import { type KeyObject, verify } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { parseNativeH3ContractBinding, type NativeH3ContractBinding } from './native-h3-binding.ts'
import type { NativeH3DeviceTuple } from './native-h3-device-proof.ts'
import { canonicalNativeH3ReviewJson } from './native-h3-review.ts'

/** The issuer binds the current socket and prior independent sample to the exact installed recipe. */
export interface NativeH3PresenceChallenge extends NativeH3DeviceTuple {
  readonly schema: 'qianshou.native-h3-presence-challenge.v1'
  readonly purpose: 'qianshou:native-h3-presence-challenge'
  readonly challenge_nonce: string
  readonly native_binding: NativeH3ContractBinding
  readonly sample_receipt_sha256: string
  readonly review_fingerprint: string
  readonly connection_id: string
  readonly device_key_id: string
  readonly issued_at: number
  readonly expires_at: number
}

/** Only the purpose verifier can mint this process-local challenge credential. */
export interface VerifiedNativeH3PresenceChallenge {
  readonly payload: NativeH3PresenceChallenge
}

const admitted = new WeakSet<object>()
const TUPLE = ['publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id', 'contract_version',
  'contract_sha256', 'artifact_digest', 'source_digest', 'config_digest'] as const
const KEYS = [...TUPLE, 'schema', 'purpose', 'challenge_nonce', 'native_binding', 'sample_receipt_sha256',
  'review_fingerprint', 'connection_id', 'device_key_id', 'issued_at', 'expires_at']
const HASH = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const NONCE = /^[A-Za-z0-9_-]{43}$/u
function invalid(): never { throw new ComputeError('H3_PRESENCE_CHALLENGE_INVALID', 401) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)
}
function current(payload: NativeH3PresenceChallenge, expected: NativeH3DeviceTuple, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 1 && payload.issued_at <= now + 30 && payload.expires_at > now
    && TUPLE.every(key => payload[key] === expected[key])
}

/** Verify a current presence plan using an explicitly enrolled presence-challenge purpose key.
 * @param envelope - Signed issuer envelope; request-supplied keys are refused.
 * @param expected - Current authenticated publication, owner, ACK-device and source tuple.
 * @param keys - Trusted keys explicitly enrolled for this challenge purpose.
 * @param now - Current epoch seconds.
 * @returns A process-local credential; it is neither a published device proof nor an approval.
 */
export function verifyNativeH3PresenceChallenge(envelope: unknown, expected: NativeH3DeviceTuple,
  keys: ReadonlyMap<string, KeyObject>, now: number): VerifiedNativeH3PresenceChallenge {
  const outer = object(envelope)
  if (Object.keys(outer).sort().join(',') !== 'key_id,payload,signature' || !bounded(outer.key_id, 128)
    || typeof outer.signature !== 'string' || !/^(?:[A-Za-z0-9+/]{86}==|[A-Za-z0-9_-]{86})$/u.test(outer.signature)) invalid()
  const item = object(outer.payload)
  if (Object.keys(item).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(item, key))) invalid()
  let binding: NativeH3ContractBinding
  try { binding = parseNativeH3ContractBinding(item.native_binding) }
  catch { invalid() }
  if (item.schema !== 'qianshou.native-h3-presence-challenge.v1'
    || item.purpose !== 'qianshou:native-h3-presence-challenge'
    || !bounded(item.publication_id, 128) || !bounded(item.device_id, 256)
    || !Number.isSafeInteger(item.owner_id) || Number(item.owner_id) < 1
    || typeof item.task_type !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(item.task_type)
    || item.capability_id !== 'video.render' || item.contract_version !== 'v1'
    || typeof item.contract_sha256 !== 'string' || !HASH.test(item.contract_sha256)
    || ![item.artifact_digest, item.source_digest, item.config_digest]
      .every(value => typeof value === 'string' && DIGEST.test(value))
    || item.artifact_digest !== item.source_digest || item.config_digest !== binding.ownerConfigDigest
    || typeof item.challenge_nonce !== 'string' || !NONCE.test(item.challenge_nonce)
    || Buffer.from(item.challenge_nonce, 'base64url').toString('base64url') !== item.challenge_nonce
    || typeof item.connection_id !== 'string' || !UUID.test(item.connection_id)
    || typeof item.device_key_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(item.device_key_id)
    || ![item.sample_receipt_sha256, item.review_fingerprint].every(value => typeof value === 'string' && HASH.test(value))
    || !Number.isSafeInteger(item.issued_at) || !Number.isSafeInteger(item.expires_at)
    || Number(item.issued_at) < 1 || Number(item.expires_at) <= Number(item.issued_at)
    || Number(item.expires_at) - Number(item.issued_at) > 120) invalid()
  const payload = Object.freeze({ ...item, native_binding: binding }) as unknown as NativeH3PresenceChallenge
  const key = keys.get(outer.key_id)
  const encoding = outer.signature.endsWith('==') ? 'base64' : 'base64url'
  const signature = Buffer.from(outer.signature, encoding)
  if (!current(payload, expected, now) || key?.asymmetricKeyType !== 'ed25519'
    || signature.length !== 64 || signature.toString(encoding) !== outer.signature
    || !verify(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), key, signature)) invalid()
  const credential = Object.freeze({ payload })
  admitted.add(credential)
  return credential
}

/** Recheck the current authenticated tuple and short deadline without accepting serialized copies.
 * @param value - Candidate purpose-verified presence challenge.
 * @param expected - Exact current publication, owner and ACK-device tuple.
 * @param now - Current epoch seconds.
 * @returns True only for a credential minted by this verifier in the current process.
 */
export function isVerifiedNativeH3PresenceChallenge(value: unknown,
  expected: NativeH3DeviceTuple, now: number): value is VerifiedNativeH3PresenceChallenge {
  return typeof value === 'object' && value !== null && admitted.has(value)
    && current((value as VerifiedNativeH3PresenceChallenge).payload, expected, now)
}

// V2 is an explicit adjacent protocol, never a reinterpretation of the v1 verifier.
export type { NativeH3DeviceTupleV2, NativeH3PresenceChallengeV2, VerifiedNativeH3PresenceChallengeV2 } from './native-h3-v2-evidence.ts'
import { verifyNativeH3V2Evidence, isVerifiedNativeH3V2Evidence,
  type NativeH3DeviceTupleV2, type VerifiedNativeH3PresenceChallengeV2 } from './native-h3-v2-evidence.ts'

/** Verify explicitly versioned v2 presence evidence against the current private configuration revision.
 * @param envelope - Signed v2 envelope; v1 proofs and request-provided keys are refused.
 * @param expected - Current authenticated public binding and server-owned device revision.
 * @param keys - Operator-enrolled Ed25519 purpose keys.
 * @param now - Current epoch seconds.
 * @returns Process-issued v2 credential.
 */
export function verifyNativeH3PresenceChallengeV2(envelope: unknown, expected: NativeH3DeviceTupleV2,
  keys: ReadonlyMap<string, KeyObject>, now: number): VerifiedNativeH3PresenceChallengeV2 {
  return verifyNativeH3V2Evidence(envelope, expected, keys, now, 'presence') as VerifiedNativeH3PresenceChallengeV2
}

/** Recheck a process-owned v2 presence capability against fresh local revision and time.
 * @param value - Original process verifier result.
 * @param expected - Current authenticated tuple and device revision.
 * @param now - Current epoch seconds.
 * @returns Whether the capability is still current; serialized copies fail.
 */
export function isVerifiedNativeH3PresenceChallengeV2(value: unknown, expected: NativeH3DeviceTupleV2,
  now: number): value is VerifiedNativeH3PresenceChallengeV2 {
  return isVerifiedNativeH3V2Evidence(value, expected, now, 'presence')
}

export type { NativeH3DeviceConfigChallengeV2, VerifiedNativeH3DeviceConfigChallengeV2 } from './native-h3-v2-evidence.ts'
import type { VerifiedNativeH3DeviceConfigChallengeV2 } from './native-h3-v2-evidence.ts'
/** Verify a same-socket v2 configuration CAS before signing its independent device witness.
 * @param envelope - Signed exact twenty-one-field operator plan.
 * @param expected - Current owner/device, public source and proposed local revision.
 * @param keys - Explicitly enrolled challenge-purpose keys.
 * @param now - Current epoch seconds.
 * @returns Original process-issued CAS plan; unknown or v1 plans are refused.
 */
export function verifyNativeH3DeviceConfigChallengeV2(envelope: unknown, expected: NativeH3DeviceTupleV2,
  keys: ReadonlyMap<string, KeyObject>, now: number): VerifiedNativeH3DeviceConfigChallengeV2 {
  return verifyNativeH3V2Evidence(envelope, expected, keys, now, 'config') as VerifiedNativeH3DeviceConfigChallengeV2
}
/** Recheck a configuration CAS credential against the current device revision.
 * @param value - Original process-issued plan.
 * @param expected - Exact proposed tuple, never a locally guessed revision.
 * @param now - Current epoch seconds.
 * @returns Whether this process capability remains valid.
 */
export function isVerifiedNativeH3DeviceConfigChallengeV2(value: unknown, expected: NativeH3DeviceTupleV2,
  now: number): value is VerifiedNativeH3DeviceConfigChallengeV2 {
  return isVerifiedNativeH3V2Evidence(value, expected, now, 'config')
}

import type { AnyNativeH3DeviceTuple } from './native-h3-device-proof.ts'
/** Explicit adjacent generations; serialized copies carry no execution authority. */
export type AnyVerifiedNativeH3PresenceChallenge = VerifiedNativeH3PresenceChallenge | VerifiedNativeH3PresenceChallengeV2
/** Verify the immutable task's declared generation without promoting old evidence.
 * @param envelope - Purpose-signed untrusted envelope.
 * @param expected - Exact current owner/device/source and revision tuple.
 * @param keys - Operator-enrolled purpose keys.
 * @param now - Current epoch seconds.
 * @returns A process-owned versioned credential.
 */
export function verifyAnyNativeH3PresenceChallenge(envelope: unknown, expected: AnyNativeH3DeviceTuple,
  keys: ReadonlyMap<string, KeyObject>, now: number): AnyVerifiedNativeH3PresenceChallenge {
  return expected.contract_version === 'v2' ? verifyNativeH3PresenceChallengeV2(envelope, expected, keys, now)
    : verifyNativeH3PresenceChallenge(envelope, expected, keys, now)
}
/** Recheck original evidence against a fresh versioned expectation.
 * @param value - Original verifier result.
 * @param expected - Current device tuple; revision comes from the server head.
 * @param now - Current epoch seconds.
 * @returns Whether the same process capability is current.
 */
export function isVerifiedAnyNativeH3PresenceChallenge(value: unknown, expected: AnyNativeH3DeviceTuple,
  now: number): value is AnyVerifiedNativeH3PresenceChallenge {
  return expected.contract_version === 'v2' ? isVerifiedNativeH3PresenceChallengeV2(value, expected, now)
    : isVerifiedNativeH3PresenceChallenge(value, expected, now)
}
