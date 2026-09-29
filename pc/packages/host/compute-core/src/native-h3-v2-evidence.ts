/** Explicit v2 device evidence separates portable execution from current private configuration. */
import { createHash, type KeyObject, verify } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { nativeH3LogicalBindingSha256, parseNativeH3PortableExecutionBinding,
  type NativeH3PortableExecutionBinding } from './native-h3-binding.ts'
import { canonicalNativeH3ReviewJson, type NativeH3ReviewArtifact, type NativeH3ReviewInput } from './native-h3-review.ts'

/** Current device revision is server-owned and is not part of the public source inventory. */
export interface NativeH3DeviceTupleV2 {
  readonly publication_id: string
  readonly owner_id: number
  readonly device_id: string
  readonly task_type: string
  readonly capability_id: 'video.render'
  readonly contract_version: 'v2'
  readonly contract_sha256: string
  readonly artifact_digest: string
  readonly source_digest: string
  readonly logical_binding_sha256: string
  readonly local_owner_config_digest: string
  readonly device_binding_revision: number
}
/** Independently attested installed device proof, bound to one local revision. */
export interface NativeH3DeviceProofV2 extends NativeH3DeviceTupleV2 {
  readonly schema: 'qianshou.native-h3-device-proof.v2'
  readonly purpose: 'qianshou:native-h3-device-attestor.v2'
  readonly challenge_nonce: string
  readonly challenge_input_sha256: string
  readonly challenge_result_sha256: string
  readonly result: 'pass'
  readonly publication_status: 'approved'
  readonly installation_state: 'installed'
  readonly issued_at: number
  readonly expires_at: number
}
/** Each independently issued GPU sample binds the current private configuration revision. */
export interface NativeH3ReviewChallengeV2 extends NativeH3DeviceTupleV2 {
  readonly schema: 'qianshou.native-h3-review-challenge.v2'
  readonly purpose: 'qianshou:native-h3-review-challenge.v2'
  readonly challenge_nonce: string
  readonly challenge_input: NativeH3ReviewInput
  readonly challenge_input_sha256: string
  readonly issued_at: number
  readonly expires_at: number
}
/** Device-signed actual uploaded sample metadata; neither approval nor a buyer lease. */
export interface NativeH3ReviewExecutionV2 extends NativeH3DeviceTupleV2 {
  readonly schema: 'qianshou.native-h3-review-execution.v2'
  readonly purpose: 'qianshou:native-h3-review-execution.v2'
  readonly challenge_nonce: string
  readonly challenge_input_sha256: string
  readonly challenge_result_sha256: string
  readonly artifact: NativeH3ReviewArtifact
  readonly issued_at: number
  readonly expires_at: number
}
/** Fresh connection presence does not reuse the sample's old connection or execute a GPU job. */
export interface NativeH3PresenceChallengeV2 extends NativeH3DeviceTupleV2 {
  readonly schema: 'qianshou.native-h3-presence-challenge.v2'
  readonly purpose: 'qianshou:native-h3-presence-challenge.v2'
  readonly challenge_nonce: string
  readonly native_binding: NativeH3PortableExecutionBinding
  readonly sample_receipt_sha256: string
  readonly review_fingerprint: string
  readonly connection_id: string
  readonly device_key_id: string
  readonly issued_at: number
  readonly expires_at: number
}
/** CAS plan requires proof on the same authenticated worker socket before registration. */
export interface NativeH3DeviceConfigChallengeV2 extends NativeH3DeviceTupleV2 {
  readonly schema: 'qianshou.native-h3-device-config-enrollment.v2'
  readonly purpose: 'qianshou:native-h3-device-config-enrollment.v2'
  readonly challenge_id: string
  readonly nonce: string
  readonly key_id: string
  readonly connection_id: string
  readonly expected_revision: number
  readonly issued_at: number
  readonly expires_at: number
}
/** Process-issued credential; JSON copies are never capabilities. */
export interface VerifiedNativeH3DeviceProofV2 { readonly payload: NativeH3DeviceProofV2 }
/** Process-issued isolated-sample permission. */
export interface VerifiedNativeH3ReviewChallengeV2 { readonly payload: NativeH3ReviewChallengeV2 }
/** Process-issued current-presence permission. */
export interface VerifiedNativeH3PresenceChallengeV2 { readonly payload: NativeH3PresenceChallengeV2 }
/** Process-issued configuration CAS plan. */
export interface VerifiedNativeH3DeviceConfigChallengeV2 { readonly payload: NativeH3DeviceConfigChallengeV2 }

export const NATIVE_H3_V2_TUPLE_KEYS = ['publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id',
  'contract_version', 'contract_sha256', 'artifact_digest', 'source_digest', 'logical_binding_sha256',
  'local_owner_config_digest', 'device_binding_revision'] as const
const RAW = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const NONCE = /^[A-Za-z0-9_-]{43}$/u
const credentials = new WeakSet<object>()
type Payload = NativeH3DeviceProofV2 | NativeH3ReviewChallengeV2 | NativeH3PresenceChallengeV2 | NativeH3DeviceConfigChallengeV2
type Credential = VerifiedNativeH3DeviceProofV2 | VerifiedNativeH3ReviewChallengeV2
  | VerifiedNativeH3PresenceChallengeV2 | VerifiedNativeH3DeviceConfigChallengeV2
type Kind = 'proof' | 'review' | 'presence' | 'config'
const shapes = {
  proof: { schema: 'qianshou.native-h3-device-proof.v2', purpose: 'qianshou:native-h3-device-attestor.v2',
    ttl: 300, extra: ['challenge_nonce', 'challenge_input_sha256', 'challenge_result_sha256', 'result',
      'publication_status', 'installation_state'] },
  review: { schema: 'qianshou.native-h3-review-challenge.v2', purpose: 'qianshou:native-h3-review-challenge.v2',
    ttl: 900, extra: ['challenge_nonce', 'challenge_input', 'challenge_input_sha256'] },
  presence: { schema: 'qianshou.native-h3-presence-challenge.v2', purpose: 'qianshou:native-h3-presence-challenge.v2',
    ttl: 120, extra: ['challenge_nonce', 'native_binding', 'sample_receipt_sha256', 'review_fingerprint',
      'connection_id', 'device_key_id'] },
  config: { schema: 'qianshou.native-h3-device-config-enrollment.v2', purpose: 'qianshou:native-h3-device-config-enrollment.v2',
    ttl: 300, extra: ['challenge_id', 'nonce', 'key_id', 'connection_id', 'expected_revision'] },
} as const
function invalid(): never { throw new ComputeError('H3_V2_EVIDENCE_INVALID', 401) }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)
}
function nonce(value: unknown): boolean {
  return typeof value === 'string' && NONCE.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value
}
function parseTuple(item: Record<string, unknown>): void {
  if (!text(item.publication_id, 128) || !text(item.device_id, 256)
    || !Number.isSafeInteger(item.owner_id) || Number(item.owner_id) < 1
    || typeof item.task_type !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(item.task_type)
    || item.capability_id !== 'video.render' || item.contract_version !== 'v2'
    || ![item.contract_sha256, item.logical_binding_sha256].every(value => typeof value === 'string' && RAW.test(value))
    || ![item.artifact_digest, item.source_digest, item.local_owner_config_digest]
      .every(value => typeof value === 'string' && DIGEST.test(value))
    || item.artifact_digest !== item.source_digest || !Number.isSafeInteger(item.device_binding_revision)
    || Number(item.device_binding_revision) < 1) invalid()
}
function current(payload: Payload, expected: NativeH3DeviceTupleV2, now: number): boolean {
  return Number.isSafeInteger(now) && now > 0 && payload.issued_at <= now + 30 && payload.expires_at > now
    && NATIVE_H3_V2_TUPLE_KEYS.every(key => payload[key] === expected[key])
}
function parse(value: unknown, kind: Kind): Payload {
  const item = { ...record(value) }
  const shape = shapes[kind]
  const keys = [...NATIVE_H3_V2_TUPLE_KEYS, 'schema', 'purpose', 'issued_at', 'expires_at', ...shape.extra]
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))
    || item.schema !== shape.schema || item.purpose !== shape.purpose
    || !Number.isSafeInteger(item.issued_at) || !Number.isSafeInteger(item.expires_at)
    || Number(item.issued_at) < 1 || Number(item.expires_at) <= Number(item.issued_at)
    || Number(item.expires_at) - Number(item.issued_at) > shape.ttl) invalid()
  parseTuple(item)
  if (kind !== 'config' && !nonce(item.challenge_nonce)) invalid()
  if (kind === 'proof' && (item.result !== 'pass' || item.publication_status !== 'approved'
    || item.installation_state !== 'installed' || ![item.challenge_input_sha256, item.challenge_result_sha256]
    .every(value => typeof value === 'string' && RAW.test(value)))) invalid()
  if (kind === 'review') {
    const input = record(item.challenge_input)
    if (Object.keys(input).some(key => !['prompt', 'seconds', 'seed'].includes(key))
      || typeof input.prompt !== 'string' || !input.prompt.isWellFormed() || !input.prompt.trim()
      || Array.from(input.prompt).length > 7000 || input.seconds !== 5
      || input.seed !== undefined && (!Number.isSafeInteger(input.seed) || Number(input.seed) < 1 || Number(input.seed) > 2147483647)
      || Buffer.byteLength(canonicalNativeH3ReviewJson(input)) > 32 * 1024
      || typeof item.challenge_input_sha256 !== 'string' || !RAW.test(item.challenge_input_sha256)
      || createHash('sha256').update(canonicalNativeH3ReviewJson(input)).digest('hex') !== item.challenge_input_sha256) invalid()
    item.challenge_input = Object.freeze({ ...input })
  }
  if (kind === 'presence') {
    const binding = parseNativeH3PortableExecutionBinding(item.native_binding)
    if (nativeH3LogicalBindingSha256(binding) !== item.logical_binding_sha256
      || typeof item.connection_id !== 'string' || !UUID.test(item.connection_id)
      || !text(item.device_key_id, 128)
      || ![item.sample_receipt_sha256, item.review_fingerprint]
        .every(value => typeof value === 'string' && RAW.test(value))) invalid()
    item.native_binding = binding
  }
  if (kind === 'config' && (!nonce(item.nonce) || typeof item.challenge_id !== 'string' || !UUID.test(item.challenge_id)
    || typeof item.connection_id !== 'string' || !UUID.test(item.connection_id) || !text(item.key_id, 128)
    || !Number.isSafeInteger(item.expected_revision) || Number(item.expected_revision) < 0
    || ![Number(item.expected_revision), Number(item.expected_revision) + 1].includes(Number(item.device_binding_revision)))) invalid()
  return Object.freeze({ ...item }) as unknown as Payload
}
/** Verify exact v2 evidence without accepting v1 schemas or client-supplied trust roots.
 * @param envelope - Bounded signed envelope from a purpose-specific issuer.
 * @param expected - Current owner/device/public identity and server-owned local revision.
 * @param keys - Operator-enrolled Ed25519 keys for this purpose.
 * @param now - Current epoch seconds.
 * @param kind - The explicitly requested evidence kind.
 * @returns A process-owned immutable credential.
 */
export function verifyNativeH3V2Evidence(envelope: unknown, expected: NativeH3DeviceTupleV2,
  keys: ReadonlyMap<string, KeyObject>, now: number, kind: Kind): Credential {
  const outer = record(envelope)
  if (Object.keys(outer).sort().join(',') !== 'key_id,payload,signature' || !text(outer.key_id, 128)
    || typeof outer.signature !== 'string' || !/^(?:[A-Za-z0-9+/]{86}==|[A-Za-z0-9_-]{86})$/u.test(outer.signature)) invalid()
  const payload = parse(outer.payload, kind)
  const key = keys.get(outer.key_id)
  const encoding = outer.signature.endsWith('==') ? 'base64' : 'base64url'
  const signature = Buffer.from(outer.signature, encoding)
  if (!current(payload, expected, now) || key?.asymmetricKeyType !== 'ed25519'
    || signature.length !== 64 || signature.toString(encoding) !== outer.signature
    || !verify(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), key, signature)) invalid()
  const credential = Object.freeze({ payload })
  credentials.add(credential)
  return credential as Credential
}
/** Recheck version, current tuple and TTL before using a process-issued v2 credential.
 * @param value - The original verifier result; JSON copies are refused.
 * @param expected - Fresh owner/device identity and local revision.
 * @param now - Current epoch seconds.
 * @param kind - Expected evidence kind.
 * @returns Whether the original capability still matches this exact revision.
 */
export function isVerifiedNativeH3V2Evidence(value: unknown, expected: NativeH3DeviceTupleV2,
  now: number, kind: Kind): value is Credential {
  return typeof value === 'object' && value !== null && credentials.has(value)
    && (value as Credential).payload.schema === shapes[kind].schema
    && current((value as Credential).payload, expected, now)
}
