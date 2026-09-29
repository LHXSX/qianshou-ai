/** Read only the Shanghai-signed, exact-version first frame from a fixed evidence endpoint. */
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { readPinnedVideoFirstFrame } from '@deepseek-ai/dsh-compute-core/edge-worker/artifact-read'
import type { ComputeResidentAttemptExecution } from '@deepseek-ai/dsh-compute-core/resident'
import type { SignedComfyVideoFirstFrame, SignedComfyVideoOrder,
  VersionedComfyVideoObject } from './comfy-video-resident-consumer.ts'

function validOrigin(url: URL): boolean {
  return url.protocol === 'https:' && (url.port === '' || url.port === '443')
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
}

/** `evidenceEndpoint` is the configured COS endpoint, without the bucket prefix. */
export function createReviewedVideoFirstFrameReader(options: {
  readonly controlOrigin: URL
  readonly evidenceEndpoint: URL
  readonly evidenceBucket: string
  readonly readSignedOrder: (execution: ComputeResidentAttemptExecution,
    signal: AbortSignal) => Promise<SignedComfyVideoOrder>
  readonly fetch?: typeof fetch
}): (execution: ComputeResidentAttemptExecution, firstFrame: SignedComfyVideoFirstFrame,
  signal: AbortSignal) => Promise<VersionedComfyVideoObject> {
  if (!validOrigin(options.controlOrigin) || !validOrigin(options.evidenceEndpoint)
    || options.controlOrigin.hostname === options.evidenceEndpoint.hostname
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(options.evidenceBucket)) {
    throw new ComputeError('COMPUTE_COMFY_VIDEO_EVIDENCE_ENDPOINT_INVALID', 503)
  }
  return async (execution, firstFrame, signal) => {
    signal.throwIfAborted()
    const order = await options.readSignedOrder(execution, signal)
    const expected = order.firstFrame
    if (expected.slot !== firstFrame.slot || expected.bucket !== firstFrame.bucket
      || expected.objectKey !== firstFrame.objectKey
      || expected.objectVersionId !== firstFrame.objectVersionId
      || expected.sha256 !== firstFrame.sha256 || expected.sizeBytes !== firstFrame.sizeBytes
      || expected.contentType !== firstFrame.contentType
      || expected.bucket !== options.evidenceBucket) {
      throw new ComputeError('COMPUTE_COMFY_VIDEO_FIRST_FRAME_MISMATCH', 409)
    }
    const expiresAt = Math.floor(Date.parse(order.leaseExpiresAt) / 1000)
    const pinned = { objectKey: expected.objectKey,
      objectVersionId: expected.objectVersionId, sha256: expected.sha256,
      sizeBytes: expected.sizeBytes, contentType: expected.contentType }
    const result = await readPinnedVideoFirstFrame({
      coreOrigin: options.controlOrigin,
      trustedStorageHostname: options.evidenceEndpoint.hostname,
      trustedStorageBucket: options.evidenceBucket,
      buyerAccountId: order.customerAccountId,
      pinned, maxBytes: 16 * 1024 * 1024,
      authorize: () => Promise.resolve({ ...pinned, url: order.inputGetUrl, expiresAt }),
      signal, ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    return { ...expected, bytes: result.bytes }
  }
}
