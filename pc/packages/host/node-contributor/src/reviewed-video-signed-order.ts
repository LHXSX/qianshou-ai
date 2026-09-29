/** Verify one Shanghai-signed video order carried by an authenticated Edge assignment. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { ComputeError, type ReviewedVideoOfferPort,
  type ReviewedVideoOfferProof } from '@deepseek-ai/dsh-compute-core'
import type { EdgeTaskOffer } from '@deepseek-ai/dsh-compute-core/src/edge-worker/types.ts'
import type { ComputeResidentAttemptExecution } from '@deepseek-ai/dsh-compute-core/resident'
import type { SignedComfyVideoOrder } from './comfy-video-resident-consumer.ts'

const WIRE_SCHEMA = 'qianshou.reviewed-video-order.v1'
const PAYLOAD_SCHEMA = 'qianshou.reviewed-video-order-payload.v1'
const DOMAIN = Buffer.from(WIRE_SCHEMA + '\0', 'utf8')
const MAX_PAYLOAD_BYTES = 32 * 1024
const B64 = /^[A-Za-z0-9_-]+$/u
const HASH = /^[0-9a-f]{64}$/u
const SHA_DIGEST = /^sha256:([0-9a-f]{64})$/u
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u

type JsonRecord = Record<string, unknown>
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: JsonRecord, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length
    && expected.every(name => Object.hasOwn(value, name))
}
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]))
  }
  if (!record(left) || !record(right)) return false
  const names = Object.keys(left)
  return names.length === Object.keys(right).length
    && names.every(name => Object.hasOwn(right, name) && sameJson(left[name], right[name]))
}
function decode(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxBytes * 4 / 3) + 4
    || !B64.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length <= maxBytes && bytes.toString('base64url') === value ? bytes : null
}
function packageHash(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (HASH.test(value)) return value
  return SHA_DIGEST.exec(value)?.[1] ?? null
}
function assignmentOf(offer: EdgeTaskOffer): JsonRecord {
  return {
    worker_id: offer.workerId, workload_id: offer.workloadId, shard_id: offer.shardId,
    attempt: offer.attempt, task_type: offer.taskType, runtime: offer.runtime,
    input_kind: offer.inputKind, input_ref: offer.inputRef, input_refs: offer.inputRefs,
    inline_input: offer.inlineInput, params: offer.params ?? {},
    code_url: offer.codeUrl, code_sha256: offer.codeSha256, timeout_s: offer.timeoutSeconds,
    verification_policy: offer.verificationPolicy, execution_model: offer.executionModel,
    runtime_api: offer.runtimeApi ?? '', capability: offer.capability,
    capability_version: offer.capabilityVersion,
    lease_token_sha256: offer.leaseTokenSha256 ?? '',
  }
}
function firstFrameOf(raw: JsonRecord): ReviewedVideoOfferProof['firstFrame'] | null {
  if (!keys(raw, ['slot', 'bucket', 'object_key', 'object_version_id',
    'content_type', 'size_bytes', 'sha256'])) return null
  return { slot: raw.slot as string, bucket: raw.bucket as string,
    objectKey: raw.object_key as string, objectVersionId: raw.object_version_id as string,
    contentType: raw.content_type as 'image/png' | 'image/jpeg',
    sizeBytes: raw.size_bytes as number, sha256: raw.sha256 as string }
}
function parseManifest(params: JsonRecord, proof: ReviewedVideoOfferProof): boolean {
  if (typeof params.prompt !== 'string' || typeof params.input_manifest !== 'string'
    || params.prompt !== proof.values.prompt || !record(params._reviewed_video_input)) return false
  const worker = params._reviewed_video_input
  const first = proof.firstFrame
  if (!keys(worker, ['schema', 'bucket', 'objectKey', 'objectVersionId',
    'sha256', 'bytes', 'contentType', 'getUrl'])
    || worker.schema !== 'qianshou.reviewed-video-worker-input.v1'
    || worker.bucket !== first.bucket || worker.objectKey !== first.objectKey
    || worker.objectVersionId !== first.objectVersionId || worker.sha256 !== first.sha256
    || worker.bytes !== first.sizeBytes || worker.contentType !== first.contentType
    || worker.getUrl !== proof.inputGetUrl) return false
  let manifest: unknown
  try { manifest = JSON.parse(params.input_manifest) as unknown } catch { return false }
  if (!record(manifest) || manifest.schema !== 'qianshou.uploaded-inputs.v1'
    || !Array.isArray(manifest.files) || manifest.files.length !== 1
    || !record(manifest.files[0])) return false
  const file = manifest.files[0]
  if (file.objectKey !== first.objectKey || file.objectVersionId !== first.objectVersionId
    || file.sha256 !== first.sha256 || file.bytes !== first.sizeBytes
    || file.contentType !== first.contentType) return false
  return Object.entries(proof.values).every(([name, value]) => params[name] === value)
}
function taskIdOf(offer: EdgeTaskOffer): string {
  const joined = `${offer.workloadId}.${offer.shardId}`
  return joined.length <= 128 ? joined
    : createHash('sha256').update(`${offer.workloadId}\0${offer.shardId}`).digest('hex')
}
function attemptKey(taskId: string, attempt: number, expiresAt: string): string {
  return `${taskId}\0${attempt}\0${expiresAt}`
}

export interface SignedReviewedVideoOfferPort extends ReviewedVideoOfferPort {
  /** Read exactly the previously verified order for this signed resident attempt. */
  readSignedOrder(execution: ComputeResidentAttemptExecution,
    signal: AbortSignal): Promise<SignedComfyVideoOrder>
}

/** Pin the platform's Ed25519 SPKI public keys before enabling this route. */
export function createSignedReviewedVideoOfferPort(options: {
  readonly taskType: string
  readonly publicKeys: Readonly<Record<string, string | KeyObject>>
}): SignedReviewedVideoOfferPort {
  const keysById = new Map<string, KeyObject>()
  for (const [id, raw] of Object.entries(options.publicKeys)) {
    if (!KEY_ID.test(id)) throw new ComputeError('COMPUTE_REVIEWED_VIDEO_KEY_INVALID')
    const key = typeof raw === 'string' ? createPublicKey(raw) : raw
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new ComputeError('COMPUTE_REVIEWED_VIDEO_KEY_INVALID')
    }
    keysById.set(id, key)
  }
  if (keysById.size === 0) throw new ComputeError('COMPUTE_REVIEWED_VIDEO_KEY_REQUIRED')
  const admitted = new Map<string, SignedComfyVideoOrder>()
  return {
    taskType: options.taskType,
    verifyOffer(offer, context) {
      if (offer.taskType !== options.taskType) return null
      const wire = offer.reviewedVideoOrder
      if (!record(wire) || !keys(wire, ['schema', 'key_id', 'payload_b64u', 'signature_b64u'])
        || wire.schema !== WIRE_SCHEMA || !KEY_ID.test(String(wire.key_id))) return null
      const publicKey = keysById.get(String(wire.key_id))
      const payloadBytes = decode(wire.payload_b64u, MAX_PAYLOAD_BYTES)
      const signature = decode(wire.signature_b64u, 64)
      if (publicKey === undefined || payloadBytes === null || signature?.length !== 64
        || !verify(null, Buffer.concat([DOMAIN, payloadBytes]), publicKey, signature)) return null
      let payload: unknown
      const payloadText = payloadBytes.toString('utf8')
      if (!Buffer.from(payloadText, 'utf8').equals(payloadBytes)) return null
      try { payload = JSON.parse(payloadText) as unknown } catch { return null }
      if (!record(payload) || !keys(payload, ['schema', 'assignment', 'order'])
        || payload.schema !== PAYLOAD_SCHEMA || !record(payload.assignment)
        || !sameJson(payload.assignment, assignmentOf(offer)) || !record(payload.order)
        || context.workerId !== offer.workerId || !HASH.test(offer.leaseTokenSha256 ?? '')
        || offer.inputKind !== 'multi_file' || offer.verificationPolicy !== 'semantic'
        || offer.executionModel !== 'runtime_v2' || offer.runtimeApi !== '2.0'
        || offer.inputRefs.length !== 1 || offer.inputRef !== offer.inputRefs[0]) return null
      const order = payload.order
      if (!keys(order, ['order_id', 'product_id', 'publication_id', 'owner_account_id',
        'customer_account_id', 'task_type', 'capability_version', 'package_digest',
        'artifact_digest', 'contract_sha256', 'approved_contract_digest',
        'max_output_bytes', 'lease_expires_at', 'values', 'first_frame', 'input_get_url'])
        || !record(order.values) || !record(order.first_frame)) return null
      const normalizedPackageHash = packageHash(order.package_digest)
      if (normalizedPackageHash === null) return null
      const firstFrame = firstFrameOf(order.first_frame)
      if (firstFrame === null || order.input_get_url !== offer.inputRef) return null
      const proof: ReviewedVideoOfferProof = {
        identity: { workerId: offer.workerId, workloadId: offer.workloadId,
          shardId: offer.shardId, attempt: offer.attempt },
        orderId: order.order_id as string, productId: order.product_id as string,
        publicationId: order.publication_id as string,
        ownerAccountId: order.owner_account_id as number,
        customerAccountId: order.customer_account_id as number,
        taskType: order.task_type as string,
        capabilityVersion: order.capability_version as string,
        packageDigest: normalizedPackageHash,
        artifactDigest: order.artifact_digest as string,
        contractSha256: order.contract_sha256 as string,
        approvedContractDigest: order.approved_contract_digest as string,
        maxOutputBytes: order.max_output_bytes as number,
        leaseExpiresAt: order.lease_expires_at as string,
        inputGetUrl: order.input_get_url,
        values: order.values as Record<string, string | number>,
        firstFrame,
      }
      if (!parseManifest(offer.params ?? {}, proof)) return null
      const key = attemptKey(taskIdOf(offer), offer.attempt + 1, proof.leaseExpiresAt)
      if (!admitted.has(key) && admitted.size >= 8192) {
        for (const [oldKey, oldOrder] of admitted) {
          if (Date.parse(oldOrder.leaseExpiresAt) <= Date.now()) admitted.delete(oldKey)
        }
        if (admitted.size >= 8192) return null
      }
      admitted.set(key, Object.freeze({
        identity: Object.freeze({ ...proof.identity }), orderId: proof.orderId,
        productId: proof.productId, publicationId: proof.publicationId,
        artifactDigest: proof.artifactDigest, contractSha256: proof.contractSha256,
        approvedContractDigest: proof.approvedContractDigest,
        ownerAccountId: proof.ownerAccountId, customerAccountId: proof.customerAccountId,
        maxOutputBytes: proof.maxOutputBytes, leaseExpiresAt: proof.leaseExpiresAt,
        inputGetUrl: proof.inputGetUrl,
        values: Object.freeze({ ...proof.values }), firstFrame: Object.freeze({ ...proof.firstFrame }),
      }))
      return proof
    },
    readSignedOrder(execution, signal) {
      signal.throwIfAborted()
      const order = admitted.get(attemptKey(execution.task.taskId, execution.attempt.attempt,
        execution.attempt.leaseExpiresAt))
      if (order === undefined) throw new ComputeError('COMPUTE_REVIEWED_VIDEO_ORDER_UNAVAILABLE', 503)
      return Promise.resolve(order)
    },
  }
}
