/** Opt-in composition of the reviewed video offer, first-frame and result ports. */
import { ComputeError, createInlineEdgeBinding, type InlineEdgeBinding } from '@deepseek-ai/dsh-compute-core'
import type { EdgeWorkerResidentSession } from '@deepseek-ai/dsh-compute-core/src/transport/edge-worker-session.ts'
import type { ComputeResidentResultConsumer, ResidentRuntimeConfig } from '@deepseek-ai/dsh-compute-core/resident'
import { createComfyVideoFirstFrameSource } from './comfy-video-first-frame-source.ts'
import { createResidentComfyVideoConsumer,
  type ResidentComfyVideoConsumerPorts } from './comfy-video-resident-consumer.ts'
import { createReviewedVideoFirstFrameReader } from './reviewed-video-first-frame-reader.ts'
import type { SignedReviewedVideoOfferPort } from './reviewed-video-signed-order.ts'

export interface ReviewedComfyVideoResidentRouteOptions {
  /** Explicit activation after independent installation, runtime, owner and server ACK checks. */
  readonly enabled?: boolean
  readonly nodeId: string
  readonly offer: SignedReviewedVideoOfferPort
  /** Product Host passes the binding already used by its authenticated Edge connector. */
  readonly binding?: InlineEdgeBinding
  readonly ports: Omit<ResidentComfyVideoConsumerPorts,
    'fileUpload' | 'readSignedOrder' | 'readVersionedFirstFrame'>
  /** Resolve the current authenticated Edge socket after connector construction. */
  readonly edgeSession?: () => Pick<EdgeWorkerResidentSession, 'uploadReviewedVideoFile'> | null
  /** Fixed trusted COS origin, configured by Host rather than buyer/order params. */
  readonly storageOrigin?: URL
  /** Fixed Shanghai control and dedicated evidence COS endpoint and bucket. */
  readonly controlOrigin?: URL
  readonly evidenceEndpoint?: URL
  readonly evidenceBucket?: string
  /** Injectable transport only for bounded first-frame tests. */
  readonly firstFrameFetch?: typeof fetch
  /** Deterministic local HMAC key only for a bounded test fixture. */
  readonly sessionKey?: Buffer
}

export interface ReviewedComfyVideoResidentRoute {
  readonly binding: InlineEdgeBinding
  readonly inputSource: ResidentRuntimeConfig['inputSource']
  readonly resultConsumer: ComputeResidentResultConsumer
}

/** No old `task-adapters.v1` claim is generated here; Shanghai must ACK a new reviewed-video claim. */
export function createReviewedComfyVideoResidentRoute(
  options: ReviewedComfyVideoResidentRouteOptions,
): ReviewedComfyVideoResidentRoute {
  const enabled = options.enabled === true
  let readVersionedFirstFrame: ResidentComfyVideoConsumerPorts['readVersionedFirstFrame'] =
    () => Promise.reject(new ComputeError('COMPUTE_COMFY_VIDEO_CONSUMER_DISABLED', 503))
  if (enabled) {
    if (typeof options.edgeSession !== 'function' || options.storageOrigin === undefined
      || options.controlOrigin === undefined || options.evidenceEndpoint === undefined
      || options.evidenceBucket === undefined) {
      throw new ComputeError('COMPUTE_COMFY_VIDEO_EDGE_SESSION_UNAVAILABLE', 503)
    }
    readVersionedFirstFrame = createReviewedVideoFirstFrameReader({
      controlOrigin: options.controlOrigin, evidenceEndpoint: options.evidenceEndpoint,
      evidenceBucket: options.evidenceBucket,
      readSignedOrder: (execution, signal) => options.offer.readSignedOrder(execution, signal),
      ...(options.firstFrameFetch === undefined ? {} : { fetch: options.firstFrameFetch }),
    })
  }
  const binding = options.binding ?? createInlineEdgeBinding({ nodeId: options.nodeId,
    allowedTaskTypes: enabled ? [options.offer.taskType] : [],
    maxOutputBytes: 4096,
    ...(enabled ? { reviewedVideo: options.offer } : {}),
    ...(options.sessionKey === undefined ? {} : { sessionKey: options.sessionKey }),
  })
  const ports: ResidentComfyVideoConsumerPorts = { ...options.ports,
    readSignedOrder: (execution, signal) => options.offer.readSignedOrder(execution, signal),
    readVersionedFirstFrame,
    fileUpload: {
      edgeIdentityOf: execution => binding.edgeIdentityOf(execution.task.taskId,
        execution.attempt.attempt, execution.attempt.leaseExpiresAt),
      uploadAuthenticatedResult: async (execution, input, signal) => {
        const provider = options.edgeSession
        const session = provider === undefined ? null : provider()
        if (session === null || options.storageOrigin === undefined) {
          throw new ComputeError('COMPUTE_COMFY_VIDEO_EDGE_SESSION_UNAVAILABLE', 503)
        }
        return session.uploadReviewedVideoFile(execution.task.taskId, execution.attempt.attempt,
          { ...input, storageOrigin: options.storageOrigin }, signal)
      },
      remember: (taskId, attempt, artifact, elapsedMs) => {
        binding.rememberReviewedArtifact(taskId, attempt, artifact, elapsedMs)
      } } }
  return {
    binding,
    inputSource: enabled ? createComfyVideoFirstFrameSource(ports) : undefined,
    resultConsumer: createResidentComfyVideoConsumer({ enabled, ports }),
  }
}
