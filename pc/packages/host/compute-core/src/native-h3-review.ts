/** Independently signed H3 author challenges can run before public approval, never as buyer leases. */
import { createHash, type KeyObject, verify } from 'node:crypto'
import { ComputeError } from './errors.ts'
import type { NativeH3DeviceTuple } from './native-h3-device-proof.ts'

/** The fixed public input contains no model, workflow, path or endpoint overrides. */
export interface NativeH3ReviewInput {
  readonly prompt: string
  readonly seconds: 5
  readonly seed?: number
}

/** Pre-approval challenge purpose is independent of published installed-device proof. */
export interface NativeH3ReviewChallenge extends NativeH3DeviceTuple {
  readonly schema: 'qianshou.native-h3-review-challenge.v1'
  readonly purpose: 'qianshou:native-h3-review-challenge'
  readonly challenge_nonce: string
  readonly challenge_input: NativeH3ReviewInput
  readonly challenge_input_sha256: string
  readonly issued_at: number
  readonly expires_at: number
}

/** The verifier registry rejects JSON copies and unsigned challenge inputs. */
export interface VerifiedNativeH3ReviewChallenge {
  readonly payload: NativeH3ReviewChallenge
}

/** Immutable object-store result from the dedicated review-sample upload lease. */
export interface NativeH3ReviewArtifact {
  readonly schema: 'artifact.v1'
  readonly object_key: string
  readonly object_version_id: string
  readonly filename: 'result.mp4'
  readonly size_bytes: number
  readonly content_type: 'video/mp4'
  readonly sha256: string
  readonly result_id: string
}

/** Device signs these eighteen metadata fields after a real run and direct lease-bound upload. */
export interface NativeH3ReviewExecution extends NativeH3DeviceTuple {
  readonly schema: 'qianshou.native-h3-review-execution.v1'
  readonly purpose: 'qianshou:native-h3-review-execution'
  readonly challenge_nonce: string
  readonly challenge_input_sha256: string
  readonly challenge_result_sha256: string
  readonly artifact: NativeH3ReviewArtifact
  readonly issued_at: number
  readonly expires_at: number
}

const admitted = new WeakSet<object>()
const TUPLE_KEYS = ['publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id', 'contract_version',
  'contract_sha256', 'artifact_digest', 'source_digest', 'config_digest'] as const
const KEYS = [...TUPLE_KEYS, 'schema', 'purpose', 'challenge_nonce', 'challenge_input',
  'challenge_input_sha256', 'issued_at', 'expires_at']
const HASH = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
function invalid(): never { throw new ComputeError('H3_REVIEW_CHALLENGE_INVALID', 401) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Canonical bytes for the challenge, input and execution metadata signatures.
 * @param value - Metadata composed of JSON objects, safe integers and Unicode strings.
 * @returns UTF-8 JSON text with ASCII-sorted keys and no whitespace.
 */
export function canonicalNativeH3ReviewJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string' && value.isWellFormed()) return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalNativeH3ReviewJson).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalNativeH3ReviewJson(entry)}`).join(',')}}`
  return invalid()
}

function current(payload: NativeH3ReviewChallenge, expected: NativeH3DeviceTuple, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 1 && payload.issued_at <= now + 30 && payload.expires_at > now
    && TUPLE_KEYS.every(key => payload[key] === expected[key])
}

/** Verify a bounded independent review challenge against an enrolled purpose key.
 * @param envelope - Signed challenge envelope from the authenticated review issuer.
 * @param expected - Exact current publication, owner, ACK device, source and contract tuple.
 * @param keys - Keys already enrolled for the independent review-challenge purpose.
 * @param now - Current epoch seconds.
 * @returns A process-local credential usable by the fixed review runner only.
 */
export function verifyNativeH3ReviewChallenge(envelope: unknown, expected: NativeH3DeviceTuple,
  keys: ReadonlyMap<string, KeyObject>, now: number): VerifiedNativeH3ReviewChallenge {
  const outer = object(envelope)
  if (Object.keys(outer).length !== 3 || !bounded(outer.key_id, 128)
    || typeof outer.signature !== 'string' || !/^(?:[A-Za-z0-9+/]{86}==|[A-Za-z0-9_-]{86})$/u.test(outer.signature)) invalid()
  const item = object(outer.payload)
  if (Object.keys(item).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(item, key))) invalid()
  const input = object(item.challenge_input)
  if (Object.keys(input).some(key => !['prompt', 'seconds', 'seed'].includes(key))
    || typeof input.prompt !== 'string' || !input.prompt.isWellFormed() || !input.prompt.trim()
    || Array.from(input.prompt).length > 7000 || input.seconds !== 5
    || input.seed !== undefined && (!Number.isSafeInteger(input.seed) || Number(input.seed) < 1
      || Number(input.seed) > 2147483647)
    || Buffer.byteLength(canonicalNativeH3ReviewJson(input), 'utf8') > 32 * 1024
    || item.schema !== 'qianshou.native-h3-review-challenge.v1'
    || item.purpose !== 'qianshou:native-h3-review-challenge'
    || !bounded(item.publication_id, 128) || !bounded(item.device_id, 256)
    || !Number.isSafeInteger(item.owner_id) || Number(item.owner_id) < 1
    || typeof item.task_type !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(item.task_type)
    || item.capability_id !== 'video.render' || item.contract_version !== 'v1'
    || typeof item.contract_sha256 !== 'string' || !HASH.test(item.contract_sha256)
    || ![item.artifact_digest, item.source_digest, item.config_digest]
      .every(value => typeof value === 'string' && DIGEST.test(value))
    || item.artifact_digest !== item.source_digest || !bounded(item.challenge_nonce, 256)
    || typeof item.challenge_input_sha256 !== 'string' || !HASH.test(item.challenge_input_sha256)
    || createHash('sha256').update(canonicalNativeH3ReviewJson(input)).digest('hex') !== item.challenge_input_sha256
    || !Number.isSafeInteger(item.issued_at) || !Number.isSafeInteger(item.expires_at)
    || Number(item.issued_at) < 1 || Number(item.expires_at) <= Number(item.issued_at)
    || Number(item.expires_at) - Number(item.issued_at) > 900) invalid()
  const payload = Object.freeze({ ...item,
    challenge_input: Object.freeze({ ...input }) }) as unknown as NativeH3ReviewChallenge
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

/** Recheck owner/device identities and deadline before and after native execution.
 * @param value - Candidate process-issued review credential.
 * @param expected - Current authenticated exact tuple.
 * @param now - Current epoch seconds.
 * @returns True for a current credential from this module instance.
 */
export function isVerifiedNativeH3ReviewChallenge(value: unknown,
  expected: NativeH3DeviceTuple, now: number): value is VerifiedNativeH3ReviewChallenge {
  return typeof value === 'object' && value !== null && admitted.has(value)
    && current((value as VerifiedNativeH3ReviewChallenge).payload, expected, now)
}

// V2 is an explicit adjacent protocol, never a reinterpretation of the v1 verifier.
export type { NativeH3DeviceTupleV2, NativeH3ReviewChallengeV2, VerifiedNativeH3ReviewChallengeV2 } from './native-h3-v2-evidence.ts'
import { verifyNativeH3V2Evidence, isVerifiedNativeH3V2Evidence,
  type NativeH3DeviceTupleV2, type VerifiedNativeH3ReviewChallengeV2 } from './native-h3-v2-evidence.ts'

/** Verify explicitly versioned v2 review evidence against the current private configuration revision.
 * @param envelope - Signed v2 envelope; v1 proofs and request-provided keys are refused.
 * @param expected - Current authenticated public binding and server-owned device revision.
 * @param keys - Operator-enrolled Ed25519 purpose keys.
 * @param now - Current epoch seconds.
 * @returns Process-issued v2 credential.
 */
export function verifyNativeH3ReviewChallengeV2(envelope: unknown, expected: NativeH3DeviceTupleV2,
  keys: ReadonlyMap<string, KeyObject>, now: number): VerifiedNativeH3ReviewChallengeV2 {
  return verifyNativeH3V2Evidence(envelope, expected, keys, now, 'review') as VerifiedNativeH3ReviewChallengeV2
}

/** Recheck a process-owned v2 review capability against fresh local revision and time.
 * @param value - Original process verifier result.
 * @param expected - Current authenticated tuple and device revision.
 * @param now - Current epoch seconds.
 * @returns Whether the capability is still current; serialized copies fail.
 */
export function isVerifiedNativeH3ReviewChallengeV2(value: unknown, expected: NativeH3DeviceTupleV2,
  now: number): value is VerifiedNativeH3ReviewChallengeV2 {
  return isVerifiedNativeH3V2Evidence(value, expected, now, 'review')
}

export type { NativeH3ReviewExecutionV2 } from './native-h3-v2-evidence.ts'

import type { AnyNativeH3DeviceTuple } from './native-h3-device-proof.ts'
/** Explicit adjacent generations; serialized copies carry no execution authority. */
export type AnyVerifiedNativeH3ReviewChallenge = VerifiedNativeH3ReviewChallenge | VerifiedNativeH3ReviewChallengeV2
/** Verify the immutable task's declared generation without promoting old evidence.
 * @param envelope - Purpose-signed untrusted envelope.
 * @param expected - Exact current owner/device/source and revision tuple.
 * @param keys - Operator-enrolled purpose keys.
 * @param now - Current epoch seconds.
 * @returns A process-owned versioned credential.
 */
export function verifyAnyNativeH3ReviewChallenge(envelope: unknown, expected: AnyNativeH3DeviceTuple,
  keys: ReadonlyMap<string, KeyObject>, now: number): AnyVerifiedNativeH3ReviewChallenge {
  return expected.contract_version === 'v2' ? verifyNativeH3ReviewChallengeV2(envelope, expected, keys, now)
    : verifyNativeH3ReviewChallenge(envelope, expected, keys, now)
}
/** Recheck original evidence against a fresh versioned expectation.
 * @param value - Original verifier result.
 * @param expected - Current device tuple; revision comes from the server head.
 * @param now - Current epoch seconds.
 * @returns Whether the same process capability is current.
 */
export function isVerifiedAnyNativeH3ReviewChallenge(value: unknown, expected: AnyNativeH3DeviceTuple,
  now: number): value is AnyVerifiedNativeH3ReviewChallenge {
  return expected.contract_version === 'v2' ? isVerifiedNativeH3ReviewChallengeV2(value, expected, now)
    : isVerifiedNativeH3ReviewChallenge(value, expected, now)
}

/** Actual device executions remain explicitly versioned. */
export type AnyNativeH3ReviewExecution = NativeH3ReviewExecution | import('./native-h3-v2-evidence.ts').NativeH3ReviewExecutionV2
