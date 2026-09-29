/** Opt-in, same-socket reviewed Comfy supply review. No proof means no update frame. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { comfyVideoPublicContractDigest } from '@deepseek-ai/dsh-compute-core/comfy-video-public-contract'
import type { ReviewedVideoAdapterAck, ReviewedVideoAdapterUpdate,
  ReviewedVideoSampleAttestation } from '@deepseek-ai/dsh-compute-core/src/edge-worker/reviewed-video-supply-contract.ts'
import type { ReviewedComfyVideoInstallation, ReviewedComfyVideoPublication }
  from './comfy-video-resident-bridge.ts'

const PROBE_SCHEMA = 'qianshou.reviewed-video-host-probe.v1'
const SAMPLE_SCHEMA = 'qianshou.reviewed-video-sample-attestation.v1'
const HASH = /^[0-9a-f]{64}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/u
const ID = /^[A-Za-z0-9_.:-]{1,128}$/u
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const MAX_PROBE_BYTES = 16 * 1024

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function canonical(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as { readonly [key: string]: Json }
  return `{${Object.keys(object).sort().map((key) => {
    const item = object[key]
    if (item === undefined) fail()
    return `${JSON.stringify(key)}:${canonical(item)}`
  }).join(',')}}`
}
function fail(): never { throw new ComputeError('COMPUTE_REVIEWED_VIDEO_SUPPLY_PROOF_INVALID', 409) }
function seconds(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail()
  return parsed / 1000
}
function b64(value: unknown, size?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) fail()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value || size !== undefined && decoded.length !== size) fail()
  return decoded
}

export interface ReviewedVideoSampleIdentity {
  readonly attempt_id: string
  readonly prompt_id: string
  readonly input_bucket: string
  readonly input_object_key: string
  readonly input_object_version_id: string
  readonly input_sha256: string
  readonly input_bytes: number
  readonly output_bucket: string
  readonly output_object_key: string
  readonly output_object_version_id: string
  readonly output_sha256: string
  readonly output_bytes: number
  readonly completed_at: string
}
export interface ReviewedVideoRuntimeWitness {
  readonly comfy_version: string
  readonly comfy_process_sha256: string
  readonly ffprobe_sha256: string
  readonly gpu_model: string
  readonly vram_mb: number
}
/** Every row comes from Host-owned readers, not buyer params or the Comfy graph. */
export interface ReviewedVideoSupplySnapshot {
  readonly workerId: string
  readonly connectionId: string
  readonly deviceKeyId: string
  readonly ownerAccountId: number
  readonly ownerConsentRevision: number
  readonly installation: ReviewedComfyVideoInstallation
  readonly publication: ReviewedComfyVideoPublication
  readonly localTest: ReviewedVideoSampleIdentity
  readonly runtime: ReviewedVideoRuntimeWitness
}
export type { ReviewedVideoAdapterAck, ReviewedVideoAdapterUpdate, ReviewedVideoSampleAttestation }
export interface ReviewedVideoSupplyPorts {
  /** Each read must independently recheck approved install, actual process and retained sample. */
  readonly readCurrent: (signal: AbortSignal) => Promise<ReviewedVideoSupplySnapshot | null>
  /** The device-private Ed25519 key must belong to the current Shanghai-enrolled worker. */
  readonly signDevice: (keyId: string, content: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>
  /** Guangzhou's independently signed, exact-version sample; absent means no submission. */
  readonly readSampleAttestation: (probeSha256: string,
    signal: AbortSignal) => Promise<ReviewedVideoSampleAttestation | null>
  /** Authenticated WebSocket call; only a current-socket ACK counts. */
  readonly sendUpdate: (update: ReviewedVideoAdapterUpdate,
    signal: AbortSignal) => Promise<ReviewedVideoAdapterAck>
}

function validSample(sample: ReviewedVideoSampleIdentity, now: number,
  maxInputBytes: number, maxOutputBytes: number): boolean {
  return record(sample) && UUID.test(sample.attempt_id) && UUID.test(sample.prompt_id)
    && [sample.input_bucket, sample.output_bucket].every(value => typeof value === 'string' && ID.test(value))
    && [sample.input_object_key, sample.output_object_key].every(value => typeof value === 'string'
      && value.startsWith('v8/account-') && value.length <= 1024 && !value.includes('..') && !value.includes('\\'))
    && [sample.input_object_version_id, sample.output_object_version_id].every(value =>
      typeof value === 'string' && ID.test(value) && value.toLowerCase() !== 'null')
    && HASH.test(sample.input_sha256) && HASH.test(sample.output_sha256)
    && Number.isSafeInteger(sample.input_bytes) && sample.input_bytes > 0 && sample.input_bytes <= maxInputBytes
    && Number.isSafeInteger(sample.output_bytes) && sample.output_bytes > 0 && sample.output_bytes <= maxOutputBytes
    && seconds(sample.completed_at) <= now
}
function payloadOf(snapshot: ReviewedVideoSupplySnapshot, now: number): Record<string, Json> {
  const { installation, publication, localTest, runtime } = snapshot
  if (!record(snapshot) || !record(installation) || !record(publication)
    || !record(localTest) || !record(runtime)) fail()
  const publicationStatus: unknown = Reflect.get(publication, 'status')
  const firstFrameSlot = installation.publicContract.inputSlots.find(slot => slot.kind === 'artifact_ref')
  if (!ID.test(snapshot.workerId)
    || !UUID.test(snapshot.connectionId) || !KEY_ID.test(snapshot.deviceKeyId)
    || !Number.isSafeInteger(snapshot.ownerAccountId) || snapshot.ownerAccountId < 1
    || !Number.isSafeInteger(snapshot.ownerConsentRevision) || snapshot.ownerConsentRevision < 1
    || publicationStatus !== 'approved' || publication.ownerAccountId !== snapshot.ownerAccountId
    || installation.ownerAccountId !== snapshot.ownerAccountId
    || publication.publicationId !== installation.publicationId || !UUID.test(publication.publicationId)
    || publication.taskType !== installation.publicContract.taskType
    || publication.artifactDigest !== installation.artifactDigest || !DIGEST.test(publication.artifactDigest)
    || publication.contractSha256 !== installation.contractSha256 || !DIGEST.test(publication.contractSha256)
    || publication.approvedContractDigest !== installation.approvedContractDigest
    || !DIGEST.test(publication.approvedContractDigest)
    || comfyVideoPublicContractDigest(installation.publicContract) !== installation.approvedContractDigest
    || installation.graphSha256 !== installation.publicContract.graph.sha256
    || installation.runnerSourceSha256 !== installation.publicContract.runner.sourceSha256
    || installation.dependencyManifestSha256 !== installation.publicContract.dependencyManifestSha256
    || !HASH.test(installation.packageDigest) || !HASH.test(installation.graphSha256)
    || !HASH.test(installation.runnerSourceSha256) || !HASH.test(installation.dependencyManifestSha256)
    || firstFrameSlot === undefined
    || !validSample(localTest, now, firstFrameSlot.maxBytes,
      installation.publicContract.limits.maxOutputBytes)
    || typeof runtime.comfy_version !== 'string'
    || !ID.test(runtime.comfy_version) || typeof runtime.gpu_model !== 'string'
    || !ID.test(runtime.gpu_model) || !HASH.test(runtime.comfy_process_sha256)
    || !HASH.test(runtime.ffprobe_sha256) || !Number.isSafeInteger(runtime.vram_mb)
    || runtime.vram_mb < 1) fail()
  return { schema: PROBE_SCHEMA, worker_id: snapshot.workerId, connection_id: snapshot.connectionId,
    owner_account_id: snapshot.ownerAccountId, publication_id: publication.publicationId,
    task_type: publication.taskType, capability_id: 'video.render',
    capability_version: installation.capabilityVersion, input_kind: 'multi_file',
    output_kind: 'artifact_ref', artifact_digest: installation.artifactDigest,
    package_digest: `sha256:${installation.packageDigest}`, contract_sha256: installation.contractSha256,
    approved_contract_digest: installation.approvedContractDigest, graph_sha256: installation.graphSha256,
    runner_source_sha256: installation.runnerSourceSha256,
    dependency_manifest_sha256: installation.dependencyManifestSha256,
    device_key_id: snapshot.deviceKeyId, owner_consent_revision: snapshot.ownerConsentRevision,
    local_test: { attempt_id: localTest.attempt_id, prompt_id: localTest.prompt_id,
      input_bucket: localTest.input_bucket, input_object_key: localTest.input_object_key,
      input_object_version_id: localTest.input_object_version_id, input_sha256: localTest.input_sha256,
      input_bytes: localTest.input_bytes, output_bucket: localTest.output_bucket,
      output_object_key: localTest.output_object_key, output_object_version_id: localTest.output_object_version_id,
      output_sha256: localTest.output_sha256, output_bytes: localTest.output_bytes,
      completed_at: localTest.completed_at },
    runtime: { comfy_version: runtime.comfy_version, comfy_process_sha256: runtime.comfy_process_sha256,
      ffprobe_sha256: runtime.ffprobe_sha256, gpu_model: runtime.gpu_model, vram_mb: runtime.vram_mb },
    issued_at: new Date(now * 1000).toISOString(), expires_at: new Date((now + 120) * 1000).toISOString() }
}
/** A local review preview only; it is not a platform-admitted capability or an upload permission. */
export function createReviewedVideoHostProbe(snapshot: ReviewedVideoSupplySnapshot, now: number): {
  readonly payload: Readonly<Record<string, Json>>
  readonly payloadBytes: Buffer
  readonly sha256: string
} {
  if (!Number.isSafeInteger(now) || now < 1) fail()
  const payload = payloadOf(snapshot, now)
  const payloadBytes = Buffer.from(canonical(payload), 'utf8')
  if (payloadBytes.length > MAX_PROBE_BYTES) fail()
  return { payload, payloadBytes, sha256: createHash('sha256').update(payloadBytes).digest('hex') }
}
function verifySample(attestation: ReviewedVideoSampleAttestation, payload: Record<string, Json>,
  hash: string, publicKeys: Readonly<Record<string, KeyObject>>, now: number): void {
  if (!record(attestation) || Object.keys(attestation).sort().join(',') !== 'key_id,payload,signature'
    || !KEY_ID.test(attestation.key_id) || !record(attestation.payload)) fail()
  const key = publicKeys[attestation.key_id]
  const signed = attestation.payload
  if (Object.keys(signed).sort().join(',') !==
    'approved_contract_digest,artifact_digest,connection_id,contract_sha256,dependency_manifest_sha256,device_key_id,expires_at,graph_sha256,issued_at,local_test,owner_account_id,owner_consent_revision,package_digest,probe_sha256,publication_id,purpose,result,runner_source_sha256,schema,task_type,worker_id') fail()
  if (key?.type !== 'public' || key.asymmetricKeyType !== 'ed25519'
    || signed.schema !== SAMPLE_SCHEMA || signed.purpose !== SAMPLE_SCHEMA || signed.result !== 'pass'
    || signed.probe_sha256 !== `sha256:${hash}`
    || signed.publication_id !== payload.publication_id
    || signed.owner_account_id !== payload.owner_account_id
    || signed.worker_id !== payload.worker_id || signed.connection_id !== payload.connection_id
    || signed.task_type !== payload.task_type || signed.device_key_id !== payload.device_key_id
    || signed.artifact_digest !== payload.artifact_digest || signed.package_digest !== payload.package_digest
    || signed.contract_sha256 !== payload.contract_sha256
    || signed.approved_contract_digest !== payload.approved_contract_digest
    || signed.graph_sha256 !== payload.graph_sha256
    || signed.runner_source_sha256 !== payload.runner_source_sha256
    || signed.dependency_manifest_sha256 !== payload.dependency_manifest_sha256
    || signed.owner_consent_revision !== payload.owner_consent_revision
    || canonical(signed.local_test as Json) !== canonical(payload.local_test as Json)
    || typeof signed.issued_at !== 'string' || typeof signed.expires_at !== 'string') fail()
  const issued = seconds(signed.issued_at)
  const expires = seconds(signed.expires_at)
  if (issued > now + 30 || expires <= now || expires - issued > 300) fail()
  const bytes = Buffer.from(SAMPLE_SCHEMA + '\0' + canonical(signed as Json), 'utf8')
  if (!verify(null, bytes, key, b64(attestation.signature, 64))) fail()
}

/** Sign one current, genuinely witnessed review request. No ACK means no advertised supply. */
export async function submitReviewedVideoSupplyUpdate(options: {
  readonly requestId: string
  readonly attestorPublicKeys: Readonly<Record<string, string | KeyObject>>
  readonly ports: ReviewedVideoSupplyPorts
  readonly signal: AbortSignal
  readonly now?: () => number
}): Promise<ReviewedVideoAdapterAck> {
  if (!UUID.test(options.requestId) || Object.keys(options.attestorPublicKeys).length === 0) fail()
  const now = Math.floor((options.now ?? Date.now)() / 1000)
  const initial = await options.ports.readCurrent(options.signal)
  if (initial === null) fail()
  const { payload, payloadBytes, sha256: hash } = createReviewedVideoHostProbe(initial, now)
  const keys = Object.fromEntries(Object.entries(options.attestorPublicKeys)
    .map(([id, key]) => [id, typeof key === 'string' ? createPublicKey(key) : key]))
  const attestation = await options.ports.readSampleAttestation(hash, options.signal)
  if (attestation === null) fail()
  verifySample(attestation, payload, hash, keys, now)
  const deviceSignature = await options.ports.signDevice(initial.deviceKeyId,
    Buffer.concat([Buffer.from(PROBE_SCHEMA + '\0', 'utf8'), payloadBytes]), options.signal)
  if (!(deviceSignature instanceof Uint8Array) || deviceSignature.byteLength !== 64) fail()
  const beforeSend = await options.ports.readCurrent(options.signal)
  if (beforeSend === null || canonical(payloadOf(beforeSend, now)) !== canonical(payload)) fail()
  options.signal.throwIfAborted()
  const update = { request_id: options.requestId, publication_id: initial.installation.publicationId,
    worker_id: initial.workerId, connection_id: initial.connectionId, device_key_id: initial.deviceKeyId,
    probe_payload_b64u: payloadBytes.toString('base64url'),
    device_signature_b64u: Buffer.from(deviceSignature).toString('base64url'),
    sample_attestation: attestation }
  const ack = await options.ports.sendUpdate(update, options.signal)
  if (!record(ack) || ack.request_id !== options.requestId || ack.connection_id !== initial.connectionId
    || ack.status !== 'accepted' || ack.publication_id !== initial.installation.publicationId
    || ack.task_type !== initial.publication.taskType
    || ack.approved_contract_digest !== initial.installation.approvedContractDigest) fail()
  const afterAck = await options.ports.readCurrent(options.signal)
  if (afterAck === null || canonical(payloadOf(afterAck, now)) !== canonical(payload)) fail()
  return ack
}
