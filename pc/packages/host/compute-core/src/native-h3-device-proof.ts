/** Purpose-scoped published H3 evidence; author self-tests cannot mint this credential. */
import { type KeyObject, verify } from 'node:crypto'
import { ComputeError } from './errors.ts'

/** Exact tuple locked by the platform publication, task contract and installed device. */
export interface NativeH3DeviceTuple {
  readonly publication_id: string
  readonly owner_id: number
  readonly device_id: string
  readonly task_type: string
  readonly capability_id: 'video.render'
  readonly contract_version: 'v1'
  readonly contract_sha256: string
  readonly artifact_digest: string
  readonly source_digest: string
  readonly config_digest: string
}

/** Published device proof is distinct from the independent pre-approval sample proof. */
export interface NativeH3DeviceProof extends NativeH3DeviceTuple {
  readonly schema: 'qianshou.native-h3-device-proof.v1'
  readonly purpose: 'qianshou:native-h3-device-attestor'
  readonly challenge_nonce: string
  readonly challenge_input_sha256: string
  readonly challenge_result_sha256: string
  readonly result: 'pass'
  readonly publication_status: 'approved'
  readonly installation_state: 'installed'
  readonly issued_at: number
  readonly expires_at: number
}

/** Immutable process-local evidence minted only after signature and tuple validation. */
export interface VerifiedNativeH3DeviceProof {
  readonly payload: NativeH3DeviceProof
}

const credentials = new WeakSet<object>()
const RAW = /^[0-9a-f]{64}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const TASK = /^[a-z][a-z0-9_]{2,63}$/u
const TUPLE_KEYS = ['publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id',
  'contract_version', 'contract_sha256', 'artifact_digest', 'source_digest', 'config_digest'] as const
const PROOF_KEYS = [...TUPLE_KEYS, 'schema', 'purpose', 'challenge_nonce', 'challenge_input_sha256',
  'challenge_result_sha256', 'result', 'publication_status', 'installation_state', 'issued_at', 'expires_at']

function invalid(): never { throw new ComputeError('H3_DEVICE_PROOF_INVALID', 401) }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Canonical signature bytes match the metadata-only platform attestor format.
 * @param value - The already validated proof payload.
 * @returns UTF-8 JSON with ASCII-sorted keys, unescaped Unicode and no whitespace.
 */
export function canonicalNativeH3DeviceProof(value: NativeH3DeviceProof): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
}

function parse(value: unknown): NativeH3DeviceProof {
  const item = object(value)
  exact(item, PROOF_KEYS)
  if (item.schema !== 'qianshou.native-h3-device-proof.v1'
    || item.purpose !== 'qianshou:native-h3-device-attestor'
    || !bounded(item.publication_id, 128) || !bounded(item.device_id, 256)
    || !Number.isSafeInteger(item.owner_id) || Number(item.owner_id) < 1
    || typeof item.task_type !== 'string' || !TASK.test(item.task_type)
    || item.capability_id !== 'video.render' || item.contract_version !== 'v1'
    || ![item.contract_sha256, item.challenge_input_sha256, item.challenge_result_sha256]
      .every(value => typeof value === 'string' && RAW.test(value))
    || ![item.artifact_digest, item.source_digest, item.config_digest]
      .every(value => typeof value === 'string' && DIGEST.test(value))
    || item.artifact_digest !== item.source_digest || !bounded(item.challenge_nonce, 256)
    || item.result !== 'pass' || item.publication_status !== 'approved' || item.installation_state !== 'installed'
    || !Number.isSafeInteger(item.issued_at) || !Number.isSafeInteger(item.expires_at)
    || Number(item.issued_at) < 1 || Number(item.expires_at) <= Number(item.issued_at)
    || Number(item.expires_at) - Number(item.issued_at) > 300) invalid()
  return Object.freeze(item) as unknown as NativeH3DeviceProof
}

function current(payload: NativeH3DeviceProof, expected: NativeH3DeviceTuple, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 1 && payload.issued_at <= now + 30 && payload.expires_at > now
    && TUPLE_KEYS.every(key => payload[key] === expected[key])
}

/** Verify against keys enrolled for this purpose, never keys supplied by the proof.
 * @param envelope - Untrusted key_id/payload/signature envelope from the platform.
 * @param expected - Current authenticated owner, device and immutable contract tuple.
 * @param enrolledKeys - Trusted Ed25519 keys already enrolled for this proof purpose.
 * @param now - Current epoch seconds, read again by consumers before every execution.
 * @returns A process-local credential; serialized lookalikes are never admitted.
 */
export function verifyNativeH3DeviceProof(envelope: unknown, expected: NativeH3DeviceTuple,
  enrolledKeys: ReadonlyMap<string, KeyObject>, now: number): VerifiedNativeH3DeviceProof {
  const item = object(envelope)
  exact(item, ['key_id', 'payload', 'signature'])
  if (!bounded(item.key_id, 128) || typeof item.signature !== 'string'
    || !/^(?:[A-Za-z0-9+/]{86}==|[A-Za-z0-9_-]{86})$/u.test(item.signature)) invalid()
  const key = enrolledKeys.get(item.key_id)
  if (key === undefined || key.asymmetricKeyType !== 'ed25519') invalid()
  const payload = parse(item.payload)
  if (!current(payload, expected, now)) invalid()
  const encoding = item.signature.endsWith('==') ? 'base64' : 'base64url'
  const signature = Buffer.from(item.signature, encoding)
  if (signature.length !== 64 || signature.toString(encoding) !== item.signature
    || !verify(null, Buffer.from(canonicalNativeH3DeviceProof(payload), 'utf8'), key, signature)) invalid()
  const credential = Object.freeze({ payload })
  credentials.add(credential)
  return credential
}

/** Recheck a process-issued credential against the current tuple and time.
 * @param value - Candidate credential returned by an authenticated catalog provider.
 * @param expected - Current device/owner and selected publication identities.
 * @param now - Current epoch seconds.
 * @returns True only for a still-current credential minted by this module instance.
 */
export function isVerifiedNativeH3DeviceProof(value: unknown,
  expected: NativeH3DeviceTuple, now: number): value is VerifiedNativeH3DeviceProof {
  return typeof value === 'object' && value !== null && credentials.has(value)
    && current((value as VerifiedNativeH3DeviceProof).payload, expected, now)
}

// V2 is an explicit adjacent protocol, never a reinterpretation of the v1 verifier.
export type { NativeH3DeviceTupleV2, NativeH3DeviceProofV2, VerifiedNativeH3DeviceProofV2 } from './native-h3-v2-evidence.ts'
import { verifyNativeH3V2Evidence, isVerifiedNativeH3V2Evidence,
  type NativeH3DeviceTupleV2, type VerifiedNativeH3DeviceProofV2 } from './native-h3-v2-evidence.ts'

/** Verify explicitly versioned v2 proof evidence against the current private configuration revision.
 * @param envelope - Signed v2 envelope; v1 proofs and request-provided keys are refused.
 * @param expected - Current authenticated public binding and server-owned device revision.
 * @param keys - Operator-enrolled Ed25519 purpose keys.
 * @param now - Current epoch seconds.
 * @returns Process-issued v2 credential.
 */
export function verifyNativeH3DeviceProofV2(envelope: unknown, expected: NativeH3DeviceTupleV2,
  keys: ReadonlyMap<string, KeyObject>, now: number): VerifiedNativeH3DeviceProofV2 {
  return verifyNativeH3V2Evidence(envelope, expected, keys, now, 'proof') as VerifiedNativeH3DeviceProofV2
}

/** Recheck a process-owned v2 proof capability against fresh local revision and time.
 * @param value - Original process verifier result.
 * @param expected - Current authenticated tuple and device revision.
 * @param now - Current epoch seconds.
 * @returns Whether the capability is still current; serialized copies fail.
 */
export function isVerifiedNativeH3DeviceProofV2(value: unknown, expected: NativeH3DeviceTupleV2,
  now: number): value is VerifiedNativeH3DeviceProofV2 {
  return isVerifiedNativeH3V2Evidence(value, expected, now, 'proof')
}

/** Adjacent proof generations, with no optional fields shared across signatures. */
export type AnyNativeH3DeviceTuple = NativeH3DeviceTuple | NativeH3DeviceTupleV2
/** Process-branded proof of one explicitly versioned device binding. */
export type AnyVerifiedNativeH3DeviceProof = VerifiedNativeH3DeviceProof | VerifiedNativeH3DeviceProofV2
/** Verify the generation required by the immutable task contract.
 * @param envelope - Untrusted purpose-signed proof envelope.
 * @param expected - Exact current tuple; contract version chooses the verifier.
 * @param keys - Trusted attestor keys.
 * @param now - Current epoch seconds.
 * @returns Versioned process-issued proof without promoting old evidence.
 */
export function verifyAnyNativeH3DeviceProof(envelope: unknown, expected: AnyNativeH3DeviceTuple,
  keys: ReadonlyMap<string, KeyObject>, now: number): AnyVerifiedNativeH3DeviceProof {
  return expected.contract_version === 'v2'
    ? verifyNativeH3DeviceProofV2(envelope, expected, keys, now)
    : verifyNativeH3DeviceProof(envelope, expected, keys, now)
}
/** Recheck only the generation required by the current contract.
 * @param value - Original process-issued capability.
 * @param expected - Current owner/device/revision tuple.
 * @param now - Current epoch seconds.
 * @returns Whether that exact versioned capability is current.
 */
export function isVerifiedAnyNativeH3DeviceProof(value: unknown, expected: AnyNativeH3DeviceTuple,
  now: number): value is AnyVerifiedNativeH3DeviceProof {
  return expected.contract_version === 'v2'
    ? isVerifiedNativeH3DeviceProofV2(value, expected, now)
    : isVerifiedNativeH3DeviceProof(value, expected, now)
}

import { nativeH3LogicalBindingSha256, nativeH3DeclarationBinding,
  type AnyNativeH3Declaration } from './native-h3-binding.ts'
/** Construct an expected tuple, never a verified capability or locally assigned revision.
 * @param declaration - Exact public declaration selected from the immutable source.
 * @param identity - Authenticated owner/device and publication/source/contract identities.
 * @param local - Current private digest and the revision read from the authoritative device head.
 * @returns An explicit generation-specific expectation for a purpose verifier.
 */
export function nativeH3ExpectedDeviceTuple(declaration: AnyNativeH3Declaration,
  identity: { publicationId: string; ownerId: number; deviceId: string; contractSha256: string; sourceDigest: string },
  local?: { localOwnerConfigDigest: string; deviceBindingRevision: number }): AnyNativeH3DeviceTuple {
  const common = { publication_id: identity.publicationId, owner_id: identity.ownerId, device_id: identity.deviceId,
    task_type: declaration.taskType, capability_id: 'video.render' as const, contract_sha256: identity.contractSha256,
    artifact_digest: identity.sourceDigest, source_digest: identity.sourceDigest }
  if (declaration.schema === 'qianshou.native-h3-binding.v2') {
    const binding = nativeH3DeclarationBinding(declaration)
    if ('ownerConfigDigest' in binding || local === undefined
      || !/^sha256:[a-f0-9]{64}$/u.test(local.localOwnerConfigDigest)
      || !Number.isSafeInteger(local.deviceBindingRevision) || local.deviceBindingRevision < 1) invalid()
    return { ...common, contract_version: 'v2', logical_binding_sha256: nativeH3LogicalBindingSha256(binding),
      local_owner_config_digest: local.localOwnerConfigDigest, device_binding_revision: local.deviceBindingRevision }
  }
  return { ...common, contract_version: 'v1', config_digest: declaration.ownerConfigDigest }
}
