import { isAdmittedNativeH3TaskLeaseV2, type NativeH3TaskLeaseV2 } from '../native-h3-task-lease.ts'
/**
 * Process-local HMAC translation from an authenticated Edge `shard_assign`
 * frame into a signed resident offer.
 *
 * Edge frames carry no assignment signature. This module never invents a
 * Shanghai signature: it signs `assignmentFingerprint` with a key that never
 * leaves this process, and the matching verifier is the only one that accepts
 * that MAC. File-shaped inputs require a separately enabled reviewed order
 * proof; legacy inline tasks and `code_url` downloads remain closed to them.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { capabilityIdIfRegistered } from '../developer-task.ts'
import { ComputeError } from '../errors.ts'
import { assignmentFingerprint, type ComputeTaskSignatureVerifier } from '../envelope-security.ts'
import { COMPUTE_NODE_LEASE_VERSION, parseNodeTaskLease, type NodeTaskLease } from '../node-lease.ts'
import { ComputeNodeId, parseNodeTaskOffer } from '../node-protocol.ts'
import { ComputeCapabilityId, ComputeTaskId } from '../protocol.ts'
import { MAX_COMPUTE_TASK_PARAMETER_BYTES } from '../validation.ts'
import type { EdgeSessionBridge } from './edge-worker-session.ts'
import type { EdgeTaskIdentity, EdgeTaskOffer } from '../edge-worker/types.ts'
import type { EdgeArtifactManifest } from '../edge-worker/types.ts'

/** Protocol id hashed into the advertised plugin digest for inline isolated sessions. */
export const ISOLATED_INLINE_SESSION_PROTOCOL = 'qianshou.isolated-inline-session.v1' as const
/** Capability version advertised for the inline isolated-session runner. */
export const ISOLATED_INLINE_SESSION_VERSION = '1.0.0' as const
/** SHA-256 hex digest of {@link ISOLATED_INLINE_SESSION_PROTOCOL}. */
export const ISOLATED_INLINE_SESSION_DIGEST = createHash('sha256').update(ISOLATED_INLINE_SESSION_PROTOCOL).digest('hex')

/** Immutable platform order facts verified by a Host port for this exact authenticated offer. */
export interface ReviewedVideoOfferProof {
  readonly identity: EdgeTaskIdentity
  readonly orderId: string
  readonly productId: string
  readonly publicationId: string
  readonly artifactDigest: string
  readonly contractSha256: string
  readonly approvedContractDigest: string
  readonly ownerAccountId: number
  readonly customerAccountId: number
  readonly taskType: string
  readonly capabilityVersion: string
  readonly packageDigest: string
  readonly maxOutputBytes: number
  readonly leaseExpiresAt: string
  /** Exact short-lived GET URL carried in this signed WS attempt; never used as the media reader. */
  readonly inputGetUrl: string
  /** Values selected from the reviewed public contract's non-file slots. */
  readonly values: Readonly<Record<string, string | number>>
  readonly firstFrame: {
    readonly slot: string
    readonly bucket: string
    readonly objectKey: string
    readonly objectVersionId: string
    readonly contentType: 'image/png' | 'image/jpeg'
    readonly sizeBytes: number
    readonly sha256: string
  }
}

/** Disabled unless a Host supplies a signature-verifying immutable-order lookup. */
export interface ReviewedVideoOfferPort {
  readonly taskType: string
  readonly verifyOffer: (offer: EdgeTaskOffer, context: { readonly receivedAt: string
    readonly workerId: string }) => ReviewedVideoOfferProof | null
}

/** Owner-supplied limits for one process-local inline Edge binding. */
export interface InlineEdgeBindingOptions {
  /** Node identity written onto local leases; must match the resident runtime. */
  readonly nodeId: string
  /** Task types this process will admit; anything else is refused before signing. */
  readonly allowedTaskTypes: readonly string[]
  /** Byte ceiling copied onto the envelope and checked again on the inline result. */
  readonly maxOutputBytes: number
  /** Exact capability id of an already verified dynamic runtime for this session. */
  readonly capabilityIdForTaskType?: (taskType: string) => string | undefined
  /** File providers are selected from independent device receipts for this session. */
  readonly fileTaskTypeAllowed?: (taskType: string) => boolean
  /** Exact opt-in media task; its local capability is video.render. */
  readonly artifactTaskType?: 'bar_chart_svg_v1'
  /** Exact native media tasks whose verified adapters are bound to this session. */
  readonly artifactTaskTypes?: readonly string[]
  readonly artifactMaxOutputBytes?: number
  /** Separate reviewed-video offer path; never widens the legacy inline path. */
  readonly reviewedVideo?: ReviewedVideoOfferPort
  /** Optional 32-byte HMAC key; omitted keys are generated with `randomBytes(32)`. */
  readonly sessionKey?: Buffer
}

/** Remembered UTF-8 bytes for one local task identity. */
interface RememberedResult {
  readonly text: string
  readonly elapsedMs: number
}

interface RememberedArtifact {
  readonly artifact: EdgeArtifactManifest
  readonly elapsedMs: number
}

/**
 * Lease payload handed out out-of-band to the local verifier.
 *
 * Why the digest is carried here and not only in the signature: the verifier
 * recomputes `assignmentFingerprint` from the wire offer, and that fingerprint
 * includes `capabilityPluginDigest` whenever it is non-empty. The wire frame
 * carries no digest field, so the only place the verifier can read it from is
 * this payload. `parseNodeTaskLease` deliberately keeps only the lease's own
 * fields, so returning its result alone loses the digest and every signature
 * check fails closed — the whole offer is then dropped without a trace.
 */
export type InlineEdgeLease = NodeTaskLease & { readonly capabilityPluginDigest: string; readonly nativeDeviceLease?: NativeH3TaskLeaseV2 }

/** Process-local HMAC bridge, verifier, lease source and result memory. */
export interface InlineEdgeBinding {
  readonly bridge: EdgeSessionBridge
  readonly verifySignature: ComputeTaskSignatureVerifier
  /** Change the exact transport allowlist only after the owner gate is closed and attempts drain. */
  updateAllowedTaskTypes(taskTypes: readonly string[]): void
  /** Return the lease stored when the matching offer was translated. */
  leaseOf(taskId: string, attempt: number, expiresAt: string): InlineEdgeLease
  /** Original authenticated Edge tuple; Edge and resident attempt numbers differ by one. */
  edgeIdentityOf(taskId: string, attempt: number, expiresAt: string): EdgeTaskIdentity
  /** Store UTF-8 bytes the Edge result frame must send; never invents bytes from a task id. */
  rememberResult(taskId: string, text: string, elapsedMs: number): void
  /** Remember only the manifest of an already uploaded result; the socket verifies upload provenance. */
  rememberArtifact(taskId: string, artifact: EdgeArtifactManifest, elapsedMs: number): void
  /** Reviewed video results must be keyed by the exact admitted resident attempt. */
  rememberReviewedArtifact(taskId: string, attempt: number, artifact: EdgeArtifactManifest, elapsedMs: number): void
  readonly digest: typeof ISOLATED_INLINE_SESSION_DIGEST
}

/**
 * Build a process-local HMAC Edge bridge for inline offers and optional reviewed video.
 * @param options - Node identity, allowed task types, output ceiling and optional HMAC key.
 * @returns Bridge, verifier, lease lookup and result memory that share one key.
 */
export function createInlineEdgeBinding(options: InlineEdgeBindingOptions): InlineEdgeBinding {
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(options.nodeId)) throw new ComputeError('COMPUTE_CONTRIBUTOR_NODE_ID_INVALID')
  if (options.reviewedVideo !== undefined
    && (!/^[A-Za-z0-9._-]{1,128}$/u.test(options.reviewedVideo.taskType)
      || typeof options.reviewedVideo.verifyOffer !== 'function'
      || options.artifactTaskType === options.reviewedVideo.taskType
      || options.artifactTaskTypes?.includes(options.reviewedVideo.taskType))) {
    throw new ComputeError('COMPUTE_REVIEWED_VIDEO_PORT_INVALID')
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new ComputeError('COMPUTE_INLINE_OUTPUT_LIMIT_INVALID')
  }
  if ((options.artifactTaskType !== undefined || (options.artifactTaskTypes?.length ?? 0) > 0)
    && (!Number.isSafeInteger(options.artifactMaxOutputBytes)
    || (options.artifactMaxOutputBytes ?? 0) < 1
    || (options.artifactMaxOutputBytes ?? 0) > 16 * 1024 * 1024)) {
    throw new ComputeError('COMPUTE_ARTIFACT_OUTPUT_LIMIT_INVALID')
  }
  let allowed = freezeAllowed(options.allowedTaskTypes)
  const sessionKey = options.sessionKey === undefined ? randomBytes(32) : copyKey(options.sessionKey)
  const leases = new Map<string, InlineEdgeLease>()
  const edgeIdentities = new Map<string, EdgeTaskIdentity>()
  const results = new Map<string, RememberedResult>()
  const artifacts = new Map<string, RememberedArtifact>()
  const reviewedAttempts = new Set<string>()
  const reviewedTaskIds = new Set<string>()
  const reviewedArtifacts = new Map<string, RememberedArtifact>()
  const verifySignature: ComputeTaskSignatureVerifier = (fingerprint, signature) => {
    if (!/^[a-f0-9]{64}$/u.test(signature)) return false
    const expected = createHmac('sha256', sessionKey).update(fingerprint).digest()
    const given = Buffer.from(signature, 'hex')
    return timingSafeEqual(given, expected)
  }
  const bridge: EdgeSessionBridge = {
    toNodeOffer(offer, context) {
      const reviewedVideoPort = options.reviewedVideo
      const reviewedVideo = offer.taskType === reviewedVideoPort?.taskType
      let videoProof: ReviewedVideoOfferProof | null = null
      if (reviewedVideo) {
        if (!allowed.has(offer.taskType)) return { refuse: 'TASK_TYPE_DENIED' }
        if (offer.reviewedVideoOrder === undefined) return { refuse: 'REVIEWED_VIDEO_ORDER_UNAVAILABLE' }
        try { videoProof = reviewedVideoPort?.verifyOffer(offer, context) ?? null }
        catch { return { refuse: 'REVIEWED_VIDEO_ORDER_UNAVAILABLE' } }
      }
      const refuse = reviewedVideo
        ? refuseReviewedVideoOffer(offer, allowed, videoProof, context)
        : refuseOffer(offer, allowed)
      if (refuse !== undefined) return { refuse }
      const proof = videoProof
      if (offer.fileContract === undefined && options.fileTaskTypeAllowed?.(offer.taskType) === true) return { refuse: 'FILE_CONTRACT_MISSING' }
      if (offer.fileContract !== undefined && options.fileTaskTypeAllowed?.(offer.taskType) !== true) return { refuse: 'FILE_RUNTIME_UNAVAILABLE' }
      if (offer.nativeDeviceLease !== undefined && (!isAdmittedNativeH3TaskLeaseV2(offer.nativeDeviceLease)
        || offer.nativeDeviceLease.device_id !== offer.workerId || offer.nativeDeviceLease.workload_id !== offer.workloadId
        || offer.nativeDeviceLease.shard_id !== offer.shardId || offer.nativeDeviceLease.attempt !== offer.attempt
        || offer.nativeDeviceLease.task_type !== offer.taskType)) return { refuse: 'NATIVE_DEVICE_LEASE_INVALID' }
      const attempt = offer.attempt + 1
      if (attempt > 1_000_000) return { refuse: 'ATTEMPT_OUT_OF_RANGE' }
      const deadlineAt = proof?.leaseExpiresAt ?? deadlineOf(context.receivedAt, offer.timeoutSeconds)
      if (deadlineAt === undefined) return { refuse: 'DEADLINE_INVALID' }
      const taskId = boundedTaskId(offer.workloadId, offer.shardId)
      const idempotencyKey = createHash('sha256')
        .update(`${offer.workerId}\0${offer.workloadId}\0${offer.shardId}\0${offer.attempt}`)
        .digest('hex')
      const envelope = {
        version: 'qianshou.task.v1' as const,
        taskId: ComputeTaskId(taskId),
        // 注册表内落地名收成语义 id。未登记的 offer.taskType 仍原样封进 capabilityId，
        // 避免未知类型被抛成 COMPUTE_CAPABILITY_UNAVAILABLE。不做前缀或模糊匹配。
        capabilityId: proof !== null || offer.taskType === options.artifactTaskType || options.artifactTaskTypes?.includes(offer.taskType)
          ? ComputeCapabilityId('video.render')
          : ComputeCapabilityId(options.capabilityIdForTaskType?.(offer.taskType)
            ?? capabilityIdIfRegistered(offer.taskType) ?? offer.taskType),
        capabilityVersion: proof?.capabilityVersion ?? ISOLATED_INLINE_SESSION_VERSION,
        inputRefs: proof === null ? [] : [{ name: proof.firstFrame.slot,
          bytes: proof.firstFrame.sizeBytes, sha256: proof.firstFrame.sha256 }],
        parameters: proof === null ? {
          taskType: offer.taskType,
          inlineInput: offer.inlineInput,
          runtime: offer.runtime,
          ...(offer.nativeDeviceLease === undefined ? {} : { nativeDeviceLease: offer.nativeDeviceLease }),
          ...(offer.fileContract === undefined ? {} : { fileContract: offer.fileContract }),
          ...(Object.keys(offer.params ?? {}).length === 0 ? {} : { taskParams: offer.params }),
        } : {
          taskType: proof.taskType, orderId: proof.orderId, productId: proof.productId,
          publicationId: proof.publicationId, artifactDigest: proof.artifactDigest,
          contractSha256: proof.contractSha256, approvedContractDigest: proof.approvedContractDigest,
          ownerAccountId: proof.ownerAccountId, customerAccountId: proof.customerAccountId,
          edgeIdentity: proof.identity, firstFrame: proof.firstFrame, values: proof.values,
        },
        deadlineAt,
        maxOutputBytes: proof !== null ? proof.maxOutputBytes
          : offer.fileContract !== undefined ? 16 * 1024
            : offer.taskType === options.artifactTaskType || options.artifactTaskTypes?.includes(offer.taskType)
              ? options.artifactMaxOutputBytes ?? 0 : options.maxOutputBytes,
        idempotencyKey,
      }
      const assignment = {
        envelope,
        attempt,
        capabilityPluginDigest: proof?.packageDigest ?? ISOLATED_INLINE_SESSION_DIGEST,
        leaseExpiresAt: deadlineAt,
        receivedAt: context.receivedAt,
      }
      let fingerprint: string
      try { fingerprint = assignmentFingerprint(assignment) } catch { return { refuse: 'ENVELOPE_INVALID' } }
      const signature = createHmac('sha256', sessionKey).update(fingerprint).digest('hex')
      const parsed = parseNodeTaskOffer({
        type: 'task.offer',
        envelope,
        attempt,
        leaseExpiresAt: deadlineAt,
        receivedAt: context.receivedAt,
        signature,
      })
      const leaseId = createHash('sha256')
        .update(`lease\0${offer.workloadId}\0${offer.shardId}\0${offer.attempt}`)
        .digest('hex')
      const lease = Object.freeze({
        ...parseNodeTaskLease({
          version: COMPUTE_NODE_LEASE_VERSION,
          leaseId,
          taskId: parsed.envelope.taskId,
          attempt: parsed.attempt,
          ownerNodeId: ComputeNodeId(options.nodeId),
          issuedAt: context.receivedAt,
          expiresAt: deadlineAt,
          idempotencyKey,
        }),
        capabilityPluginDigest: proof?.packageDigest ?? ISOLATED_INLINE_SESSION_DIGEST,
        ...(offer.nativeDeviceLease === undefined ? {} : { nativeDeviceLease: offer.nativeDeviceLease }),
      })
      leases.set(leaseKey(parsed.envelope.taskId, parsed.attempt), lease)
      edgeIdentities.set(leaseKey(parsed.envelope.taskId, parsed.attempt), Object.freeze({
        workerId: offer.workerId, workloadId: offer.workloadId,
        shardId: offer.shardId, attempt: offer.attempt,
      }))
      if (proof !== null) {
        reviewedAttempts.add(leaseKey(parsed.envelope.taskId, parsed.attempt))
        reviewedTaskIds.add(parsed.envelope.taskId)
      }
      return parsed
    },
    toEdgeResult(message) {
      if (reviewedTaskIds.has(message.taskId)) {
        const reviewed = reviewedArtifacts.get(leaseKey(message.taskId, message.attempt))
        return reviewed === undefined ? { refuse: 'RESULT_ATTEMPT_UNAVAILABLE' }
          : { artifact: reviewed.artifact, elapsedMs: reviewed.elapsedMs }
      }
      const artifact = artifacts.get(message.taskId)
      if (artifact !== undefined) return { artifact: artifact.artifact, elapsedMs: artifact.elapsedMs }
      const remembered = results.get(message.taskId)
      if (remembered === undefined) return { refuse: 'RESULT_BYTES_UNAVAILABLE' }
      if (Buffer.byteLength(remembered.text) > options.maxOutputBytes) return { refuse: 'RESULT_TOO_LARGE' }
      return { inlineOutputUtf8: remembered.text, elapsedMs: remembered.elapsedMs }
    },
  }
  return {
    bridge,
    verifySignature,
    updateAllowedTaskTypes(taskTypes) { allowed = freezeAllowed(taskTypes) },
    leaseOf(taskId, attempt, expiresAt) {
      const lease = leases.get(leaseKey(taskId, attempt))
      if (lease === undefined || lease.expiresAt !== expiresAt) {
        throw new ComputeError('COMPUTE_INLINE_LEASE_UNKNOWN', 404)
      }
      return lease
    },
    edgeIdentityOf(taskId, attempt, expiresAt) {
      const key = leaseKey(taskId, attempt)
      const lease = leases.get(key)
      const identity = edgeIdentities.get(key)
      if (lease === undefined || lease.expiresAt !== expiresAt || identity === undefined) {
        throw new ComputeError('COMPUTE_INLINE_LEASE_UNKNOWN', 404)
      }
      return identity
    },
    rememberResult(taskId, text, elapsedMs) {
      if (typeof taskId !== 'string' || taskId.length === 0 || typeof text !== 'string'
        || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
        throw new ComputeError('COMPUTE_INLINE_RESULT_INVALID')
      }
      results.set(taskId, { text, elapsedMs })
    },
    rememberArtifact(taskId, artifact, elapsedMs) {
      if (typeof taskId !== 'string' || taskId.length === 0 || artifact?.schema !== 'artifact.v1'
        || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
        throw new ComputeError('COMPUTE_ARTIFACT_RESULT_INVALID')
      }
      artifacts.set(taskId, { artifact, elapsedMs })
    },
    rememberReviewedArtifact(taskId, attempt, artifact, elapsedMs) {
      const key = leaseKey(taskId, attempt)
      const identity = edgeIdentities.get(key)
      if (!reviewedAttempts.has(key) || identity === undefined || artifact?.schema !== 'artifact.v1'
        || artifact.workload_id !== identity.workloadId || artifact.shard_id !== identity.shardId
        || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
        throw new ComputeError('COMPUTE_REVIEWED_VIDEO_RESULT_INVALID')
      }
      reviewedArtifacts.set(key, { artifact, elapsedMs })
    },
    digest: ISOLATED_INLINE_SESSION_DIGEST,
  }
}

function freezeAllowed(value: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length > 64) throw new ComputeError('COMPUTE_INLINE_TASK_TYPES_INVALID')
  const allowed = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(item) || allowed.has(item)) {
      throw new ComputeError('COMPUTE_INLINE_TASK_TYPES_INVALID')
    }
    allowed.add(item)
  }
  return allowed
}

function copyKey(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new ComputeError('COMPUTE_INLINE_SESSION_KEY_INVALID')
  return Buffer.from(value)
}

function refuseOffer(offer: EdgeTaskOffer, allowed: ReadonlySet<string>): string | undefined {
  if (!allowed.has(offer.taskType)) return 'TASK_TYPE_DENIED'
  if (offer.inputKind !== 'inline') return 'INPUT_KIND_UNSUPPORTED'
  if (offer.inputRef.length > 0 || offer.inputRefs.length > 0) return 'FILE_INPUT_UNSUPPORTED'
  if (offer.inlineInput === null || offer.inlineInput.trim() === '') return 'INLINE_INPUT_MISSING'
  const parameters = JSON.stringify({
    taskType: offer.taskType,
    inlineInput: offer.inlineInput,
    runtime: offer.runtime,
    ...(offer.nativeDeviceLease === undefined ? {} : { nativeDeviceLease: offer.nativeDeviceLease }),
    ...(offer.fileContract === undefined ? {} : { fileContract: offer.fileContract }),
    ...(Object.keys(offer.params ?? {}).length === 0 ? {} : { taskParams: offer.params }),
  })
  if (parameters.length > MAX_COMPUTE_TASK_PARAMETER_BYTES) return 'INLINE_INPUT_TOO_LARGE'
  return undefined
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const HASH = /^[0-9a-f]{64}$/u
const VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u
const SLOT = /^[a-z][a-z0-9_]{0,31}$/u
function safeObjectKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024
    && !/[\u0000-\u001f\u007f\\]/u.test(key) && !key.startsWith('/') && !key.includes('://')
    && key.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function signedGetUrl(value: unknown, version: string): boolean {
  if (typeof value !== 'string' || value.length < 12 || value.length > 8192) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      && url.hash === '' && url.searchParams.get('versionId') === version
  } catch { return false }
}

/** An authenticated Edge offer still needs a separate exact, platform-signed order proof. */
function refuseReviewedVideoOffer(offer: EdgeTaskOffer, allowed: ReadonlySet<string>,
  proof: ReviewedVideoOfferProof | null,
  context: { readonly receivedAt: string; readonly workerId: string }): string | undefined {
  if (!allowed.has(offer.taskType)) return 'TASK_TYPE_DENIED'
  if (proof === null || typeof proof !== 'object' || proof.identity === null
    || typeof proof.identity !== 'object') return 'REVIEWED_VIDEO_ORDER_UNAVAILABLE'
  const frame = proof.firstFrame
  const latestDeadline = deadlineOf(context.receivedAt, offer.timeoutSeconds)
  if (context.workerId !== offer.workerId || proof.identity.workerId !== offer.workerId
    || proof.identity.workloadId !== offer.workloadId
    || proof.identity.shardId !== offer.shardId || proof.identity.attempt !== offer.attempt
    || proof.taskType !== offer.taskType || !UUID.test(proof.orderId) || !UUID.test(proof.productId)
    || !UUID.test(proof.publicationId) || !DIGEST.test(proof.artifactDigest)
    || !DIGEST.test(proof.contractSha256) || !DIGEST.test(proof.approvedContractDigest)
    || !Number.isSafeInteger(proof.ownerAccountId) || proof.ownerAccountId < 1
    || !Number.isSafeInteger(proof.customerAccountId) || proof.customerAccountId < 1
    || !VERSION.test(proof.capabilityVersion) || !HASH.test(proof.packageDigest)
    || !Number.isSafeInteger(proof.maxOutputBytes) || proof.maxOutputBytes < 12
    || proof.maxOutputBytes > 2 * 1024 * 1024 * 1024
    || latestDeadline === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(proof.leaseExpiresAt)
    || Date.parse(proof.leaseExpiresAt) <= Date.parse(context.receivedAt)
    || Date.parse(proof.leaseExpiresAt) > Date.parse(latestDeadline)
    || frame === null || typeof frame !== 'object' || !SLOT.test(frame.slot)
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(frame.bucket)
    || !safeObjectKey(frame.objectKey) || !VERSION.test(frame.objectVersionId)
    || frame.objectVersionId.toLowerCase() === 'null'
    || (frame.contentType !== 'image/png' && frame.contentType !== 'image/jpeg')
    || !Number.isSafeInteger(frame.sizeBytes) || frame.sizeBytes < 8 || frame.sizeBytes > 16 * 1024 * 1024
    || !HASH.test(frame.sha256) || !signedGetUrl(proof.inputGetUrl, frame.objectVersionId)
    || proof.values === null || typeof proof.values !== 'object' || Array.isArray(proof.values)
    || Object.keys(proof.values).length === 0
    || Object.values(proof.values).some(value => typeof value !== 'string' && !Number.isSafeInteger(value))) {
    return 'REVIEWED_VIDEO_ORDER_INVALID'
  }
  if (offer.inputKind !== 'multi_file' || offer.inlineInput !== null
    || offer.inputRefs.length !== 1 || offer.inputRefs[0] !== proof.inputGetUrl
    || offer.inputRef !== proof.inputGetUrl
    || offer.executionModel !== 'runtime_v2' || offer.runtimeApi !== '2.0'
    || offer.verificationPolicy !== 'semantic'
    || offer.nativeDeviceLease !== undefined || offer.fileContract !== undefined
    || offer.params === undefined || offer.params === null || typeof offer.params !== 'object'
    || !('prompt' in offer.params) || !('input_manifest' in offer.params)
    || typeof offer.params._reviewed_video_input !== 'object'
    || offer.params._reviewed_video_input === null) return 'REVIEWED_VIDEO_OFFER_MISMATCH'
  return undefined
}

function boundedTaskId(workloadId: string, shardId: string): string {
  const joined = `${workloadId}.${shardId}`
  if (joined.length <= 128) return joined
  return createHash('sha256').update(`${workloadId}\0${shardId}`).digest('hex')
}

function deadlineOf(receivedAt: string, timeoutSeconds: number): string | undefined {
  const received = Date.parse(receivedAt)
  if (!Number.isFinite(received) || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) return undefined
  const deadline = new Date(received + timeoutSeconds * 1000)
  if (!Number.isFinite(deadline.getTime())) return undefined
  const iso = deadline.toISOString()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(iso)) return undefined
  return iso
}

function leaseKey(taskId: string, attempt: number): string {
  return `${taskId}\u0000${attempt}`
}
