/** Version-pinned first-frame staging for an already admitted resident video attempt. */
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import type { ComputeTaskEnvelope } from '@deepseek-ai/dsh-compute-core/protocol'
import type { ComputeResidentAttemptExecution, ResidentRuntimeConfig } from '@deepseek-ai/dsh-compute-core/resident'
import { stageReviewedComfyVideoValues, type ResidentComfyVideoConsumerPorts } from './comfy-video-resident-consumer.ts'

/** Reuse the consumer's independent signed-order and versioned object readers. */
export function createComfyVideoFirstFrameSource(ports: Pick<ResidentComfyVideoConsumerPorts,
  'bridge' | 'readSignedOrder' | 'readVersionedFirstFrame'>): NonNullable<ResidentRuntimeConfig['inputSource']> {
  return {
    async open(execution: ComputeResidentAttemptExecution, task: ComputeTaskEnvelope,
      input: ComputeTaskEnvelope['inputRefs'][number], signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      signal.throwIfAborted()
      const admitted = execution.task
      const expected = admitted.inputRefs[0]
      if (admitted.inputRefs.length !== 1 || task.taskId !== admitted.taskId
        || task.idempotencyKey !== admitted.idempotencyKey
        || task.capabilityId !== admitted.capabilityId
        || task.capabilityVersion !== admitted.capabilityVersion
        || task.inputRefs.length !== 1 || expected === undefined
        || task.inputRefs[0]?.name !== expected.name || task.inputRefs[0].bytes !== expected.bytes
        || task.inputRefs[0].sha256 !== expected.sha256
        || input.name !== expected.name || input.bytes !== expected.bytes
        || input.sha256 !== expected.sha256) {
        throw new ComputeError('COMPUTE_COMFY_VIDEO_INPUT_BINDING_INVALID', 409)
      }
      const reviewed = await ports.bridge.readCurrentInstallation()
      if (reviewed === null) throw new ComputeError('COMPUTE_COMFY_VIDEO_INSTALLATION_UNAVAILABLE', 503)
      const publication = await ports.bridge.readCurrentPublication(reviewed.publicationId, signal)
      if (publication?.status !== 'approved' || publication.publicationId !== reviewed.publicationId
        || publication.ownerAccountId !== reviewed.ownerAccountId
        || publication.taskType !== reviewed.publicContract.taskType
        || publication.artifactDigest !== reviewed.artifactDigest
        || publication.contractSha256 !== reviewed.contractSha256
        || publication.approvedContractDigest !== reviewed.approvedContractDigest) {
        throw new ComputeError('COMPUTE_COMFY_VIDEO_PUBLICATION_UNAVAILABLE', 503)
      }
      await ports.bridge.assertOrderPublication(execution, publication, signal)
      await ports.bridge.assertOrderOwnership(execution, reviewed.ownerAccountId, signal)
      const order = await ports.readSignedOrder(execution, signal)
      const values = await stageReviewedComfyVideoValues(execution, reviewed, order,
        ports.readVersionedFirstFrame, signal)
      const image = values[expected.name]
      if (image === null || typeof image !== 'object' || !(image.bytes instanceof Uint8Array)) {
        throw new ComputeError('COMPUTE_COMFY_VIDEO_INPUT_BINDING_INVALID', 409)
      }
      const bytes = Buffer.from(image.bytes)
      signal.throwIfAborted()
      return new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes)
        controller.close()
      } })
    },
  }
}
