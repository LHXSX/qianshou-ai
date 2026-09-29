/** Classify a video request using the current account's Shanghai owner detail. */

const SHA = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u
const INPUT_KEY = /^v8\/account-([1-9]\d*)\/reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg)$/u
const INPUT_PREFIX = /^v8\/account-[1-9]\d*\/reviewed-video\/input\//u
const TASK_TYPE = /^[A-Za-z0-9._-]{1,128}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function reviewedResultMatches(result: Record<string, unknown>, taskId: string,
  accountId: number, assetId: string): boolean {
  if (typeof result.output_ref !== 'string' || result.inline_output != null) return false
  let parsed: unknown
  try { parsed = JSON.parse(result.output_ref) as unknown } catch { return false }
  if (!record(parsed)) return false
  const manifest = parsed
  const shardId = manifest.shard_id
  const resultId = manifest.result_id
  const filename = manifest.filename
  if (manifest.schema !== 'artifact.v1' || manifest.workload_id !== taskId
    || manifest.account_id !== accountId || manifest.sha256 !== assetId
    || manifest.content_type !== 'video/mp4' || filename !== 'result.mp4'
    || typeof shardId !== 'string' || !ID.test(shardId)
    || typeof resultId !== 'string' || !ID.test(resultId)
    || typeof manifest.object_version_id !== 'string' || !VERSION.test(manifest.object_version_id)
    || manifest.object_version_id.toLowerCase() === 'null'
    || typeof manifest.size_bytes !== 'number' || !Number.isSafeInteger(manifest.size_bytes)
    || manifest.size_bytes < 1 || manifest.size_bytes > 64 * 1024 * 1024) return false
  return manifest.object_key === `v8/account-${accountId}/workload-${taskId}/shard-${shardId}/result/${resultId}/result.mp4`
}

/** The frozen review markers must agree before any reviewed MP4 reaches Guangzhou.
 * @param taskId - Workload identity in the opaque media reference.
 * @param assetId - SHA-256 asset identity in the opaque media reference.
 * @param type - Requested media extension from that reference.
 * @param detailBody - Authenticated Shanghai owner workload detail.
 * @param identityBody - Current Shanghai account identity.
 * @returns The verified task kind, or null when the detail cannot authorize a video read.
 */
export function ownedResultVideoKind(taskId: string, assetId: string, type: string,
  detailBody: unknown, identityBody: unknown): 'ordinary' | 'reviewed' | null {
  if (!record(identityBody) || identityBody.ok !== true || !record(identityBody.account)) return null
  const accountId = identityBody.account.id
  if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 1
    || !record(detailBody) || detailBody.id !== taskId || detailBody.owner_id !== accountId
    || detailBody.status !== 'DONE' || !record(detailBody.result) || !record(detailBody.spec)) return null
  const spec = detailBody.spec
  if (typeof spec.task_type !== 'string' || !TASK_TYPE.test(spec.task_type)
    || typeof spec.input_kind !== 'string' || spec.input_kind.length > 64
    || !Array.isArray(spec.input_refs) || spec.input_refs.length > 1024
    || spec.input_refs.some(ref => typeof ref !== 'string' || ref.length > 2048)
    || typeof spec.verification_policy !== 'string' || spec.verification_policy.length > 64
    || !record(spec.requirements)) return null
  const requirements = spec.requirements
  const contract = requirements._reviewed_task_contract
  const publication = requirements.reviewed_publication
  const firstFrame = requirements._reviewed_video_input_binding
  const reviewedInput = spec.input_refs.some(ref => INPUT_PREFIX.test(ref as string))
  if (contract === undefined && publication === undefined && firstFrame === undefined && !reviewedInput) {
    return spec.task_type === 'owner_video_v1' || spec.verification_policy === 'semantic' ? null : 'ordinary'
  }
  if (!record(contract) || !record(publication) || !record(firstFrame)
    || !record(firstFrame.file)) return null
  const file = firstFrame.file
  if (contract.schema !== 'qianshou.reviewed-workload-contract.v1'
    || contract.result_strategy !== 'external-media.v1' || contract.output_kind !== 'artifact_ref'
    || publication.schema !== 'qianshou.reviewed-publication-selection.v1'
    || Object.keys(publication).sort().join(',') !== 'artifact_digest,contract_sha256,publication_id,schema'
    || firstFrame.schema !== 'qianshou.reviewed-video-input-binding.v1'
    || firstFrame.account_id !== accountId || firstFrame.task_type !== spec.task_type
    || spec.input_kind !== 'multi_file' || spec.input_refs.length !== 1
    || INPUT_KEY.exec(spec.input_refs[0] as string)?.[1] !== String(accountId)
    || file.objectKey !== spec.input_refs[0]
    || typeof file.objectVersionId !== 'string' || !VERSION.test(file.objectVersionId)
    || file.objectVersionId.toLowerCase() === 'null'
    || typeof file.sha256 !== 'string' || !SHA.test(file.sha256)
    || !['image/png', 'image/jpeg'].includes(String(file.contentType))
    || typeof contract.publication_id !== 'string' || !UUID.test(contract.publication_id)
    || contract.publication_id !== publication.publication_id
    || typeof contract.artifact_digest !== 'string' || !DIGEST.test(contract.artifact_digest)
    || contract.artifact_digest !== publication.artifact_digest
    || typeof contract.contract_sha256 !== 'string' || !DIGEST.test(contract.contract_sha256)
    || contract.contract_sha256 !== publication.contract_sha256
    || typeof contract.package_digest !== 'string' || !DIGEST.test(contract.package_digest)
    || typeof firstFrame.file_sha256 !== 'string' || !DIGEST.test(firstFrame.file_sha256)
    || spec.verification_policy !== 'semantic') return null
  if (type !== 'mp4' || !reviewedResultMatches(detailBody.result, taskId, accountId, assetId)) return null
  return 'reviewed'
}
