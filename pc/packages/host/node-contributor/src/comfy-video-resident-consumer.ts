/** Opt-in cross-platform consumer for one signed, reviewed Comfy video resident assignment. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { MAX_EDGE_VIDEO_FILE_BYTES } from '@deepseek-ai/dsh-compute-core/edge-worker/artifact-upload-file'
import type { EdgeArtifactManifest } from '@deepseek-ai/dsh-compute-core/src/edge-worker/types.ts'
import type { EdgeTaskIdentity } from '@deepseek-ai/dsh-compute-core'
import type { ComputeResidentAttemptExecution, ComputeResidentResultConsumer,
  ComputeResidentWorkspace } from '@deepseek-ai/dsh-compute-core/resident'
import type { ComfyVideoRunInput } from './comfy-video-runner.ts'
import { runResidentComfyVideoAttempt, type ResidentComfyVideoBridgePorts,
  type ReviewedComfyVideoInstallation, type ReviewedComfyVideoPublication,
  type ComfyVideoRuntimeSelection } from './comfy-video-resident-bridge.ts'

const HASH = /^[0-9a-f]{64}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SLOT = /^[a-z][a-z0-9_]{0,31}$/u
/** Current Shanghai reviewed-video declaration; larger projects must use multiple scene results. */
const MIN_REVIEWED_VIDEO_RESULT_BYTES = 1 * 1024 * 1024
const MAX_REVIEWED_VIDEO_RESULT_BYTES = 64 * 1024 * 1024

/** A versioned object selected by the authenticated order, never by buyer JSON or a URL. */
export interface SignedComfyVideoFirstFrame {
  readonly slot: string
  readonly bucket: string
  readonly objectKey: string
  readonly objectVersionId: string
  readonly contentType: 'image/png' | 'image/jpeg'
  readonly sizeBytes: number
  readonly sha256: string
}

/** Output of an independent order-signature and current-lease verifier supplied by the Host. */
export interface SignedComfyVideoOrder {
  readonly identity: EdgeTaskIdentity
  readonly orderId: string
  readonly productId: string
  readonly publicationId: string
  readonly artifactDigest: string
  readonly contractSha256: string
  readonly approvedContractDigest: string
  readonly customerAccountId: number
  readonly ownerAccountId: number
  readonly maxOutputBytes: number
  readonly leaseExpiresAt: string
  /** Exact Shanghai-signed, versioned GET URL for the frozen first frame. */
  readonly inputGetUrl: string
  readonly values: Readonly<Record<string, string | number>>
  readonly firstFrame: SignedComfyVideoFirstFrame
}

/** The media read must carry the exact storage identity as well as the bytes returned. */
export interface VersionedComfyVideoObject extends SignedComfyVideoFirstFrame {
  readonly bytes: Uint8Array
}

/** Authenticated Edge connection owns presign, one PUT, Shanghai complete and artifact provenance. */
export interface ResidentComfyVideoFileUploadPort {
  /** Resolve the original authenticated Edge tuple, not the incremented resident attempt. */
  readonly edgeIdentityOf: (execution: ComputeResidentAttemptExecution) => EdgeTaskIdentity
  readonly uploadAuthenticatedResult: (execution: ComputeResidentAttemptExecution,
    input: { readonly sourcePath: string
      readonly expectedBytes: number
      readonly expectedSha256: string
      readonly resultId: string },
    signal: AbortSignal) => Promise<EdgeArtifactManifest>
  readonly remember: (taskId: string, attempt: number, artifact: EdgeArtifactManifest, elapsedMs: number) => void
}

/** Only the trusted Host implements these ports from its authenticated worker session. */
export interface ResidentComfyVideoConsumerPorts {
  readonly bridge: ResidentComfyVideoBridgePorts
  readonly fileUpload: ResidentComfyVideoFileUploadPort
  /** A signed platform order, checked against this exact live worker lease. */
  readonly readSignedOrder: (execution: ComputeResidentAttemptExecution,
    signal: AbortSignal) => Promise<SignedComfyVideoOrder>
  /** Read only the pinned bucket/key/version under the same authenticated order. */
  readonly readVersionedFirstFrame: (execution: ComputeResidentAttemptExecution,
    firstFrame: SignedComfyVideoFirstFrame, signal: AbortSignal) => Promise<VersionedComfyVideoObject>
  /** Owner account comes from the authenticated Host session. */
  readonly ownerAccountId: () => Promise<number>
  /** Runtime paths and port come from trusted local process discovery. */
  readonly runtime: () => Promise<ComfyVideoRuntimeSelection>
}

/** The candidate cannot advertise itself; a future deployment must explicitly enable it. */
export interface ResidentComfyVideoConsumerOptions {
  readonly enabled?: boolean
  readonly ports: ResidentComfyVideoConsumerPorts
}

function invalid(code = 'COMPUTE_COMFY_VIDEO_ORDER_INVALID', status = 409): never {
  throw new ComputeError(code, status)
}

function reviewedResultId(order: SignedComfyVideoOrder): string {
  const identity = order.identity
  const bytes = createHash('sha256').update('qianshou.reviewed-video-result.v1\0')
    .update([order.orderId, identity.workerId, identity.workloadId,
      identity.shardId, String(identity.attempt)].join('\0')).digest().subarray(0, 16)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6) // UUIDv8: deterministic exact-attempt result id.
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function safeKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 1024
    && !/[\u0000-\u001f\u007f\\]/u.test(key) && !key.startsWith('/') && !key.includes('://')
    && key.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function exactFrame(expected: SignedComfyVideoFirstFrame, actual: SignedComfyVideoFirstFrame): boolean {
  return actual.slot === expected.slot && actual.bucket === expected.bucket
    && actual.objectKey === expected.objectKey && actual.objectVersionId === expected.objectVersionId
    && actual.contentType === expected.contentType && actual.sizeBytes === expected.sizeBytes
    && actual.sha256 === expected.sha256
}
function exactOrder(expected: SignedComfyVideoOrder, actual: SignedComfyVideoOrder): boolean {
  return record(actual) && record(actual.identity) && record(actual.values) && record(actual.firstFrame)
    && expected.identity.workerId === actual.identity.workerId
    && expected.identity.workloadId === actual.identity.workloadId
    && expected.identity.shardId === actual.identity.shardId
    && expected.identity.attempt === actual.identity.attempt
    && expected.orderId === actual.orderId && expected.productId === actual.productId
    && expected.publicationId === actual.publicationId
    && expected.artifactDigest === actual.artifactDigest
    && expected.contractSha256 === actual.contractSha256
    && expected.approvedContractDigest === actual.approvedContractDigest
    && expected.customerAccountId === actual.customerAccountId
    && expected.ownerAccountId === actual.ownerAccountId
    && expected.maxOutputBytes === actual.maxOutputBytes
    && expected.leaseExpiresAt === actual.leaseExpiresAt
    && expected.inputGetUrl === actual.inputGetUrl
    && Object.keys(expected.values).length === Object.keys(actual.values).length
    && Object.entries(expected.values).every(([name, value]) => actual.values[name] === value)
    && exactFrame(expected.firstFrame, actual.firstFrame)
}
function sameApproval(reviewed: ReviewedComfyVideoInstallation,
  current: ReviewedComfyVideoPublication | null): asserts current is ReviewedComfyVideoPublication {
  if (current?.status !== 'approved' || current.publicationId !== reviewed.publicationId
    || current.ownerAccountId !== reviewed.ownerAccountId
    || current.taskType !== reviewed.publicContract.taskType
    || current.artifactDigest !== reviewed.artifactDigest
    || current.contractSha256 !== reviewed.contractSha256
    || current.approvedContractDigest !== reviewed.approvedContractDigest) invalid()
}

/** Verify one versioned first frame and construct only the reviewed graph's declared values.
 * @param execution - Started, signed resident assignment with the frozen input reference.
 * @param reviewed - Installed publication and public input slots.
 * @param order - Independently verified order projection.
 * @param read - Lease-scoped storage read that returns the observed object identity.
 * @param signal - Attempt cancellation.
 * @returns Values for the private graph, with copied and SHA-checked image bytes.
 */
export async function stageReviewedComfyVideoValues(execution: ComputeResidentAttemptExecution,
  reviewed: ReviewedComfyVideoInstallation, order: SignedComfyVideoOrder,
  read: ResidentComfyVideoConsumerPorts['readVersionedFirstFrame'],
  signal: AbortSignal): Promise<ComfyVideoRunInput['values']> {
  signal.throwIfAborted()
  const slots = reviewed.publicContract.inputSlots
  const images = slots.filter(slot => slot.kind === 'artifact_ref')
  if (!record(order) || !record(order.identity) || !record(order.firstFrame)
    || !record(order.values)) invalid()
  const first = order.firstFrame
  const parameters = execution.task.parameters
  if (!record(parameters)) invalid()
  const frozenValues = parameters.values
  if (!UUID.test(order.orderId) || !UUID.test(order.productId)
    || parameters.taskType !== reviewed.publicContract.taskType
    || execution.task.capabilityId !== reviewed.publicContract.capabilityId
    || execution.task.capabilityVersion !== reviewed.capabilityVersion
    || execution.attempt.taskId !== execution.task.taskId
    || execution.attempt.idempotencyKey !== execution.task.idempotencyKey
    || execution.attempt.capabilityPluginDigest !== reviewed.packageDigest
    || parameters.orderId !== order.orderId || parameters.productId !== order.productId
    || parameters.publicationId !== order.publicationId
    || parameters.artifactDigest !== order.artifactDigest
    || parameters.contractSha256 !== order.contractSha256
    || parameters.approvedContractDigest !== order.approvedContractDigest
    || parameters.ownerAccountId !== order.ownerAccountId
    || parameters.customerAccountId !== order.customerAccountId
    || !record(parameters.edgeIdentity)
    || parameters.edgeIdentity.workerId !== order.identity.workerId
    || parameters.edgeIdentity.workloadId !== order.identity.workloadId
    || parameters.edgeIdentity.shardId !== order.identity.shardId
    || parameters.edgeIdentity.attempt !== order.identity.attempt
    || !record(frozenValues)
    || Object.keys(frozenValues).length !== Object.keys(order.values).length
    || Object.entries(order.values).some(([name, value]) => frozenValues[name] !== value)
    || !Number.isSafeInteger(order.identity.attempt) || order.identity.attempt < 0
    || order.maxOutputBytes !== execution.task.maxOutputBytes
    || order.leaseExpiresAt !== execution.task.deadlineAt
    || order.leaseExpiresAt !== execution.attempt.leaseExpiresAt
    || !record(parameters.firstFrame) || !exactFrame(order.firstFrame,
    parameters.firstFrame as unknown as SignedComfyVideoFirstFrame)
    || !Number.isSafeInteger(order.ownerAccountId) || order.ownerAccountId !== reviewed.ownerAccountId
    || !Number.isSafeInteger(order.customerAccountId) || order.customerAccountId < 1
    || !UUID.test(order.publicationId) || order.publicationId !== reviewed.publicationId
    || !DIGEST.test(order.artifactDigest) || order.artifactDigest !== reviewed.artifactDigest
    || !DIGEST.test(order.contractSha256) || order.contractSha256 !== reviewed.contractSha256
    || !DIGEST.test(order.approvedContractDigest)
    || order.approvedContractDigest !== reviewed.approvedContractDigest
    || images.length !== 1 || images[0]?.name !== first.slot
    || !SLOT.test(first.slot) || !/^[A-Za-z0-9._-]{1,128}$/u.test(first.bucket)
    || !safeKey(first.objectKey) || !VERSION.test(first.objectVersionId)
    || first.objectVersionId.toLowerCase() === 'null'
    || first.contentType !== images[0].mimeType
    || !Number.isSafeInteger(first.sizeBytes) || first.sizeBytes < 8
    || first.sizeBytes > Math.min(images[0].maxBytes, 16 * 1024 * 1024)
    || !HASH.test(first.sha256)
    || execution.task.inputRefs.length !== 1
    || execution.task.inputRefs[0]?.name !== first.slot
    || execution.task.inputRefs[0].bytes !== first.sizeBytes
    || execution.task.inputRefs[0].sha256 !== first.sha256
    || Object.keys(order.values).length !== slots.length - 1
    || !slots.every(slot => slot.kind === 'artifact_ref' || Object.hasOwn(order.values, slot.name))) invalid()
  for (const slot of slots) {
    if (slot.kind === 'artifact_ref') continue
    const value = order.values[slot.name]
    if (slot.kind === 'text' && (typeof value !== 'string' || !value.isWellFormed()
      || Buffer.byteLength(value, 'utf8') > slot.maxUtf8Bytes)
      || slot.kind === 'integer' && (!Number.isSafeInteger(value)
        || (value as number) < slot.min || (value as number) > slot.max)) invalid()
  }
  const observed = await read(execution, first, signal)
  signal.throwIfAborted()
  if (!exactFrame(first, observed) || !(observed.bytes instanceof Uint8Array)
    || observed.bytes.byteLength !== first.sizeBytes) invalid('COMPUTE_COMFY_VIDEO_INPUT_VERSION_MISMATCH')
  const bytes = Buffer.from(observed.bytes)
  if (createHash('sha256').update(bytes).digest('hex') !== first.sha256) {
    invalid('COMPUTE_COMFY_VIDEO_INPUT_VERSION_MISMATCH')
  }
  return Object.freeze({ ...order.values,
    [first.slot]: Object.freeze({ mimeType: first.contentType, sha256: first.sha256, bytes }) })
}

async function assertOutputFileReady(workspace: ComputeResidentWorkspace,
  result: Awaited<ReturnType<typeof runResidentComfyVideoAttempt>>): Promise<void> {
  if (result.path !== join(workspace.path, 'result.mp4')
    || result.bytes < MIN_REVIEWED_VIDEO_RESULT_BYTES
    || result.bytes > MAX_EDGE_VIDEO_FILE_BYTES || !HASH.test(result.sha256)
    || await realpath(result.path) !== result.path) invalid('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED')
  const before = await lstat(result.path)
  if (!before.isFile() || before.isSymbolicLink() || before.size !== result.bytes) {
    invalid('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED')
  }
  const handle = await open(result.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const header = Buffer.alloc(12)
  let headerBytes = 0
  let opened: Awaited<ReturnType<typeof handle.stat>>
  let closed: Awaited<ReturnType<typeof handle.stat>>
  try {
    opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) invalid('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED')
    while (headerBytes < header.length) {
      const { bytesRead } = await handle.read(header, headerBytes, header.length - headerBytes, headerBytes)
      if (bytesRead === 0) invalid('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED')
      headerBytes += bytesRead
    }
    closed = await handle.stat()
  } finally { await handle.close() }
  const after = await lstat(result.path)
  if (headerBytes !== header.length || !after.isFile() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    || closed.dev !== before.dev || closed.ino !== before.ino || closed.size !== before.size
    || closed.mtimeMs !== before.mtimeMs || closed.ctimeMs !== before.ctimeMs
    || header.toString('ascii', 4, 8) !== 'ftyp') {
    invalid('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED')
  }
}

function matchUpload(artifact: EdgeArtifactManifest, order: SignedComfyVideoOrder,
  result: Awaited<ReturnType<typeof runResidentComfyVideoAttempt>>): void {
  if (artifact.account_id !== order.customerAccountId
    || artifact.filename !== 'result.mp4' || artifact.content_type !== 'video/mp4'
    || artifact.size_bytes !== result.bytes || artifact.sha256 !== result.sha256
    || !VERSION.test(artifact.object_version_id) || artifact.object_version_id.toLowerCase() === 'null'
    || !safeKey(artifact.object_key)
    || !artifact.object_key.startsWith(`v8/account-${order.customerAccountId}/`)) {
    invalid('COMPUTE_COMFY_VIDEO_UPLOAD_MISMATCH')
  }
}

/** Verify the owned MP4 then use one signed, lease-bound streaming PUT.
 * The uploader hashes the entire unchanged file before presign and while streaming it. A lost PUT
 * response remains unknown; this function never retries or falls back to the small byte uploader.
 * @param workspace - Current resident attempt's private workspace.
 * @param result - Already probed local output from the reviewed Comfy runner.
 * @param order - Independently verified signed customer order.
 * @param execution - Original admitted attempt, used to bind the authenticated upload lease.
 * @param port - Host session's required current-lease and presign provider.
 * @param signal - Combined resident cancellation.
 * @returns Exact immutable object version produced by the sole signed PUT.
 */
export async function uploadVerifiedComfyVideoOutput(workspace: ComputeResidentWorkspace,
  result: Awaited<ReturnType<typeof runResidentComfyVideoAttempt>>,
  order: SignedComfyVideoOrder, execution: ComputeResidentAttemptExecution,
  port: ResidentComfyVideoFileUploadPort, signal: AbortSignal): Promise<EdgeArtifactManifest> {
  signal.throwIfAborted()
  if (result.bytes > execution.task.maxOutputBytes || result.bytes > MAX_REVIEWED_VIDEO_RESULT_BYTES) {
    invalid('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED')
  }
  await assertOutputFileReady(workspace, result)
  const expected = port.edgeIdentityOf(execution)
  signal.throwIfAborted()
  if (order.identity.workerId !== expected.workerId || order.identity.workloadId !== expected.workloadId
    || order.identity.shardId !== expected.shardId || order.identity.attempt !== expected.attempt) {
    invalid('COMPUTE_COMFY_VIDEO_UPLOAD_MISMATCH')
  }
  const artifact = await port.uploadAuthenticatedResult(execution, { sourcePath: result.path,
    expectedBytes: result.bytes, expectedSha256: result.sha256,
    resultId: reviewedResultId(order) }, signal)
  matchUpload(artifact, order, result)
  return artifact
}

/** Build a disabled-by-default consumer; no production Edge offer route calls it yet.
 * @param options - Host-controlled activation, review, storage and existing lease upload ports.
 * @returns A resident consumer that refuses before GPU unless every input is pinned.
 */
export function createResidentComfyVideoConsumer(options: ResidentComfyVideoConsumerOptions): ComputeResidentResultConsumer {
  return { async consume({ execution, workspace, signal }) {
    if (options.enabled !== true) invalid('COMPUTE_COMFY_VIDEO_CONSUMER_DISABLED', 503)
    if (!record(options.ports.fileUpload)
      || typeof options.ports.fileUpload.edgeIdentityOf !== 'function'
      || typeof options.ports.fileUpload.uploadAuthenticatedResult !== 'function'
      || typeof options.ports.fileUpload.remember !== 'function') {
      invalid('COMPUTE_COMFY_VIDEO_FILE_UPLOAD_UNAVAILABLE', 503)
    }
    const lifetime = AbortSignal.any([signal, execution.signal])
    lifetime.throwIfAborted()
    const reviewed = await options.ports.bridge.readCurrentInstallation()
    if (reviewed === null || reviewed.publicContract.limits.maxOutputBytes > MAX_EDGE_VIDEO_FILE_BYTES
      || reviewed.publicContract.limits.maxOutputBytes > MAX_REVIEWED_VIDEO_RESULT_BYTES) {
      invalid('COMPUTE_COMFY_VIDEO_INSTALLATION_UNAVAILABLE', 503)
    }
    const signed = await options.ports.readSignedOrder(execution, lifetime)
    if (!record(signed) || !record(signed.values) || !record(signed.firstFrame)) invalid()
    const order: SignedComfyVideoOrder = { ...signed, values: Object.freeze({ ...signed.values }),
      firstFrame: Object.freeze({ ...signed.firstFrame }) }
    const ownerAccountId = await options.ports.ownerAccountId()
    if (ownerAccountId !== reviewed.ownerAccountId) invalid()
    const values = await stageReviewedComfyVideoValues(execution, reviewed, order,
      options.ports.readVersionedFirstFrame, lifetime)
    const runtime = await options.ports.runtime()
    lifetime.throwIfAborted()
    const started = Date.now()
    await execution.reportProgress(0, 'started')
    const result = await runResidentComfyVideoAttempt({ ownerAccountId, execution, reviewed,
      values, port: runtime.port, ffprobePath: runtime.ffprobePath, workspacePath: workspace.path },
    options.ports.bridge)
    const currentOrder = await options.ports.readSignedOrder(execution, lifetime)
    if (!exactOrder(order, currentOrder)) invalid()
    const currentInstallation = await options.ports.bridge.readCurrentInstallation()
    if (currentInstallation === null || currentInstallation.ownerAccountId !== reviewed.ownerAccountId
      || currentInstallation.publicationId !== reviewed.publicationId
      || currentInstallation.artifactDigest !== reviewed.artifactDigest
      || currentInstallation.contractSha256 !== reviewed.contractSha256
      || currentInstallation.approvedContractDigest !== reviewed.approvedContractDigest
      || currentInstallation.draftId !== reviewed.draftId
      || currentInstallation.graphSha256 !== reviewed.graphSha256
      || currentInstallation.packageDigest !== reviewed.packageDigest
      || currentInstallation.dependencyManifestSha256 !== reviewed.dependencyManifestSha256
      || currentInstallation.runnerSourceSha256 !== reviewed.runnerSourceSha256
      || currentInstallation.capabilityVersion !== reviewed.capabilityVersion
      || currentInstallation.allowedClassTypes.length !== reviewed.allowedClassTypes.length
      || currentInstallation.allowedClassTypes.some((type, index) => type !== reviewed.allowedClassTypes[index])) invalid()
    const publication = await options.ports.bridge.readCurrentPublication(reviewed.publicationId, lifetime)
    sameApproval(reviewed, publication)
    await options.ports.bridge.assertOrderPublication(execution, publication, lifetime)
    await options.ports.bridge.assertOrderOwnership(execution, ownerAccountId, lifetime)
    await options.ports.bridge.assertTaskValues(execution, values, lifetime)
    if (Date.parse(execution.attempt.leaseExpiresAt) <= Date.now()
      || Date.parse(execution.task.deadlineAt) <= Date.now()) invalid()
    lifetime.throwIfAborted()
    const artifact = await uploadVerifiedComfyVideoOutput(workspace, result, order, execution,
      options.ports.fileUpload, lifetime)
    options.ports.fileUpload.remember(execution.task.taskId, execution.attempt.attempt,
      artifact, Math.max(0, Date.now() - started))
    await execution.reportProgress(1, 'done')
    return { outputs: Object.freeze([{ name: 'result.mp4', bytes: result.bytes, sha256: result.sha256 }]) }
  } }
}
