/** Platform-reviewed public video slot declaration; raw workflow bytes stay owner-private. */
import { ComputeError } from './errors.ts'
import { comfyVideoPublicContractDigest, parseComfyVideoPublicContract,
  type ComfyVideoPublicContract } from './comfy-video-public-contract.ts'

/** A reviewed public declaration with an explicit first-frame meaning. */
export interface ReviewedVideoTaskInput {
  readonly schema: 'qianshou.reviewed-video-task-input.v1'
  readonly publicationId: string
  readonly approvedContractDigest: string
  readonly publicContract: ComfyVideoPublicContract
  readonly firstFrameSlot: string
  readonly promptSlot: string
  readonly firstFrameManifestParam: 'input_manifest'
  readonly firstFrameManifestIndex: 0
  readonly promptParam: 'prompt'
  readonly mimeType: 'image/png' | 'image/jpeg'
  readonly maxBytes: number
  readonly maxPromptUtf8Bytes: number
}

function invalid(): never { throw new ComputeError('COMPUTE_VIDEO_REVIEW_INPUT_INVALID', 409) }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

/** Accept only a current reviewed public contract explicitly naming its first-frame slot.
 * @param value - Untrusted Shanghai task-type metadata.
 * @param taskType - Exact task type of the surrounding catalogue row.
 * @returns Bounded public slot metadata; never a workflow graph or local model path.
 */
export function parseReviewedVideoTaskInput(value: unknown, taskType: string): ReviewedVideoTaskInput {
  const row = record(value)
  if (Object.keys(row).sort().join(',') !== [
    'approved_contract_digest', 'first_frame_slot', 'first_frame_source', 'prompt_param',
    'prompt_slot', 'public_contract', 'publication_id', 'schema', 'status',
  ].sort().join(',') || row.schema !== 'qianshou.reviewed-video-task-input.v1'
    || row.status !== 'approved'
    || typeof row.publication_id !== 'string'
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(row.publication_id)
    || typeof row.approved_contract_digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(row.approved_contract_digest)
    || row.first_frame_slot !== 'first_frame'
    || row.prompt_slot !== 'prompt' || row.prompt_param !== 'prompt') invalid()
  const source = record(row.first_frame_source)
  if (Object.keys(source).sort().join(',') !== 'index,kind,parameter'
    || source.kind !== 'uploaded_input_manifest' || source.parameter !== 'input_manifest'
    || source.index !== 0) invalid()
  const contract = parseComfyVideoPublicContract(row.public_contract)
  const images = contract.inputSlots.filter(slot => slot.kind === 'artifact_ref')
  const image = images[0]
  const prompt = contract.inputSlots.find(slot => slot.name === row.prompt_slot)
  if (contract.taskType !== taskType
    || comfyVideoPublicContractDigest(contract) !== row.approved_contract_digest
    || images.length !== 1 || image?.name !== row.first_frame_slot
    || prompt?.kind !== 'text' || prompt.name === image.name) invalid()
  return Object.freeze({ schema: 'qianshou.reviewed-video-task-input.v1',
    publicationId: row.publication_id, approvedContractDigest: row.approved_contract_digest,
    publicContract: contract, firstFrameSlot: image.name, promptSlot: prompt.name,
    firstFrameManifestParam: 'input_manifest', firstFrameManifestIndex: 0, promptParam: 'prompt',
    mimeType: image.mimeType, maxBytes: image.maxBytes,
    maxPromptUtf8Bytes: prompt.maxUtf8Bytes })
}
