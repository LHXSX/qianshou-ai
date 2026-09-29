/** Admit owner-visible developer-task result JSON without downloading artifacts. */
import { ComputeError } from './errors.ts'
import { isArtifactContentType } from './artifact-content-type.ts'
import { ComputeWorkloadId, type ComputeWorkloadResult } from './protocol.ts'

const MAX_ARTIFACT_REF_CHARS = 2_048
const MAX_FILE_BYTES = 16_384
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const SHA = /^[a-f0-9]{64}(?![\s\S])/u
const CONTRACT_SHA = /^sha256:[a-f0-9]{64}(?![\s\S])/u
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const TASK_FILE_REFERENCE = /^qianshou-file:\/\/task\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/([a-f0-9]{64})$/u
const TASK_MEDIA_REFERENCE =
  /^qianshou-media:\/\/task\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([a-f0-9]{64})\.(png|jpe?g|webp|gif|mp4|webm|mov)$/u
const VERIFIED_MEDIA_TYPES: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}
const VIDEO_MEDIA_REFERENCE =
  /^qianshou-media:\/\/task\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[a-f0-9]{64}\.(mp4|webm|mov)$/u
const REVIEWED_VIDEO_INPUT_PREFIX = /^v8\/account-[1-9]\d*\/reviewed-video\/input\//u
const REVIEWED_VIDEO_INPUT_KEY = /^v8\/account-([1-9]\d*)\/reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg)$/u

function invalidResponse(): never {
  throw new ComputeError('CORE_INVALID_RESPONSE', 502)
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  return value as Record<string, unknown>
}

function statusText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalidResponse()
  }
  return value
}

function identityField(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value) || value === '.' || value === '..') {
    return invalidResponse()
  }
  return value
}

function inlineOutput(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.includes('\0')) return invalidResponse()
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new ComputeError('CORE_RESPONSE_TOO_LARGE', 502)
  return value
}

function artifactRef(value: unknown, taskId: string, status: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ARTIFACT_REF_CHARS || value.includes('\0')) {
    return invalidResponse()
  }
  if (value.startsWith('qianshou-media:') && TASK_MEDIA_REFERENCE.exec(value)?.[1] !== taskId) return invalidResponse()
  if (/^qianshou-file:/iu.test(value)) {
    const match = TASK_FILE_REFERENCE.exec(value)
    if (status !== 'DONE' || match?.[1] !== taskId || match[0] !== value) return invalidResponse()
  }
  return value
}

function outputs(payload: Record<string, unknown>, maxInlineBytes: number,
  taskId: string, status: string): Pick<ComputeWorkloadResult, 'inlineOutput' | 'artifactRef'> {
  const inlinePresent = payload.inline_output !== undefined && payload.inline_output !== null
  const refPresent = payload.output_ref !== undefined && payload.output_ref !== null
  if (inlinePresent && refPresent) return invalidResponse()
  return {
    inlineOutput: inlinePresent ? inlineOutput(payload.inline_output, maxInlineBytes) : null,
    artifactRef: refPresent ? artifactRef(payload.output_ref, taskId, status) : null,
  }
}

/**
 * Read the deliverable text out of the platform's developer-task `result` object.
 *
 * Why this exists: `GET /api/v8/developer/tasks/{id}/result` is *not* the flat
 * `WorkloadResult` form. It answers
 * `{ok, id, task_id, workload_id, status, result, summary, elapsed_ms, download_url}`,
 * and `result` is the capability executor's own payload — for `word_count` it is
 * `{status, schema_version, task_type, elapsed_ms, summary, result_lines, summary_text, …}`,
 * for `base64_decode` it is the same envelope with a `result`/`results` array of items.
 * Neither shape contains `inline_output` or `output_ref`, so reading only the canonical
 * fields reported `null` for a task that had in fact finished with a full payload —
 * the user paid, saw DONE, and could not open the deliverable.
 *
 * Every byte returned here is copied from the payload; nothing is synthesized. The
 * order is deliberate: machine-readable lines first (so the reported text can be
 * compared byte-for-byte with the expected result), the human caption only as the
 * last resort.
 * @param inner - The parsed `result` object of a developer-task response.
 * @param maxInlineBytes - UTF-8 byte ceiling shared with the canonical inline form.
 * @returns Deliverable text, or null when the payload carries no deliverable.
 */
function developerTaskInline(inner: Record<string, unknown>, maxInlineBytes: number): string | null {
  const lines = linesOf(inner.result_lines) ?? linesOf(inner.result) ?? linesOf(inner.results)
  if (lines !== null) return inlineOutput(lines.join('\n'), maxInlineBytes)
  const caption = inner.summary_text
  if (typeof caption === 'string' && caption.trim() !== '' && !caption.includes('\0')) {
    return inlineOutput(caption, maxInlineBytes)
  }
  return null
}

/** Render a result list as one line per entry; `null` when the key is not a usable list. */
function linesOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const lines: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.includes('\0')) return null
      lines.push(item)
      continue
    }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return null
    if (typeof item !== 'object' || Array.isArray(item)) return null
    // One platform item (for example `{value, error}`) becomes one line; keys are
    // sorted so the same payload always renders the same bytes.
    const entry = item as Record<string, unknown>
    lines.push(JSON.stringify(Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))))
  }
  return lines
}

/** Parse GET `/api/v8/developer/tasks/{id}/result` without following `/download`.
 *
 * Both documented response shapes are admitted: the flat `WorkloadResult`
 * (`inline_output` / `output_ref`, at the envelope level or nested in `result`)
 * and the developer-task envelope, whose `result` object is rendered by
 * {@link developerTaskInline}. Canonical fields always win, so a server that
 * starts sending them keeps taking the same path it takes today.
 * @param id - Workload identity used in the request path.
 * @param body - Untrusted JSON body.
 * @param maxInlineBytes - UTF-8 byte ceiling for `inline_output`.
 * @returns Owner-visible inline text or an artifact reference, never both.
 */
export function parseWorkloadResult(id: string, body: unknown, maxInlineBytes: number): ComputeWorkloadResult {
  if (!Number.isSafeInteger(maxInlineBytes) || maxInlineBytes < 1) return invalidResponse()
  const item = object(body)
  if (item.ok !== undefined && item.ok !== true) return invalidResponse()
  const identities = [identityField(item.id), identityField(item.workload_id), identityField(item.task_id)]
    .filter((value): value is string => value !== undefined)
  if (identities.length === 0 || identities.some(value => value !== id)) return invalidResponse()
  const status = statusText(item.status)
  // Envelope level first: `outputs` also rejects the forbidden both-present form.
  const canonical = outputs(item, maxInlineBytes, id, status)
  if (canonical.inlineOutput !== null || canonical.artifactRef !== null) return { id: ComputeWorkloadId(id), status, ...canonical }
  if (!('result' in item) || item.result === null) return { id: ComputeWorkloadId(id), status, inlineOutput: null, artifactRef: null }
  // A non-object `result` stays a protocol violation rather than being ignored.
  const inner = object(item.result)
  const nested = outputs(inner, maxInlineBytes, id, status)
  if (nested.inlineOutput !== null || nested.artifactRef !== null) return { id: ComputeWorkloadId(id), status, ...nested }
  return { id: ComputeWorkloadId(id), status, inlineOutput: developerTaskInline(inner, maxInlineBytes), artifactRef: null }
}

/** Read a frozen file delivery intent, never an independent verification proof. */
function frozenFileIntent(body: Record<string, unknown>): boolean {
  const spec = body.spec
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return false
  const requirements = (spec as Record<string, unknown>).requirements
  if (requirements === null || typeof requirements !== 'object' || Array.isArray(requirements)) return false
  const value = (requirements as Record<string, unknown>)._reviewed_task_contract
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const contract = value as Record<string, unknown>
  if (contract.result_strategy !== 'independent-file-bytes.v1' && !Object.hasOwn(contract, 'file_schema_sha256')) return false
  if ((spec as Record<string, unknown>).verification_policy !== 'artifact'
    || Object.keys(contract).sort().join(',') !== 'contract_sha256,contract_version,file_schema_sha256,output_kind,output_schema_sha256,result_strategy,schema'
    || contract.schema !== 'qianshou.reviewed-workload-contract.v1' || contract.contract_version !== 'v1'
    || contract.output_kind !== 'artifact_ref' || contract.result_strategy !== 'independent-file-bytes.v1'
    || typeof contract.contract_sha256 !== 'string' || !CONTRACT_SHA.test(contract.contract_sha256)
    || typeof contract.output_schema_sha256 !== 'string' || !CONTRACT_SHA.test(contract.output_schema_sha256)
    || typeof contract.file_schema_sha256 !== 'string' || !SHA.test(contract.file_schema_sha256)) return invalidResponse()
  return true
}

/** Ordinary workload orders expose artifact manifests on the owner detail route.
 * Bounded files become opaque requests for fresh owner-authorized attachment delivery;
 * metadata and DONE do not prove file verification. Frozen file intent takes priority
 * over media MIME. Existing media references keep their separate grant path.
 * @param id - Exact workload identity used in the owner detail request.
 * @param body - Untrusted owner-visible metadata, including any frozen file intent.
 * @param maxInlineBytes - UTF-8 ceiling for inline output.
 * @returns Text or an opaque reference without downloading or authorizing bytes.
 */
export function parseOwnedWorkloadResult(id: string, body: unknown, maxInlineBytes: number): ComputeWorkloadResult {
  const parsed = parseWorkloadResult(id, body, maxInlineBytes)
  if (parsed.status !== 'DONE' || parsed.artifactRef === null || !parsed.artifactRef.startsWith('{')) return parsed
  let manifest: unknown
  try { manifest = JSON.parse(parsed.artifactRef) as unknown } catch { return parsed }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return parsed
  const media = manifest as Record<string, unknown>
  if (media.schema !== 'artifact.v1') return parsed
  const ownerBody = object(body)
  const ownerId = ownerBody.owner_id
  const fileIntent = frozenFileIntent(ownerBody)
  const extension = VERIFIED_MEDIA_TYPES[String(media.content_type)]
  const shardId = identityField(media.shard_id)
  const resultId = identityField(media.result_id)
  if (!isArtifactContentType(media.content_type) || media.workload_id !== id
    || typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId < 1
    || media.account_id !== ownerId
    || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(media.sha256)
    || typeof media.size_bytes !== 'number' || !Number.isSafeInteger(media.size_bytes)
    || media.size_bytes < 0 || media.size_bytes > 2 * 1024 * 1024 * 1024
    || shardId === undefined || resultId === undefined
    || typeof media.filename !== 'string' || media.filename.length < 1 || media.filename.length > 200
    || /[\u0000-\u001f\u007f/\\]/u.test(media.filename)
    || typeof media.object_key !== 'string' || media.object_key.length > 1024
    || /[\u0000-\u001f\u007f]/u.test(media.object_key) || media.object_key.includes('..')
    || typeof media.object_version_id !== 'string'
    || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(media.object_version_id)
    || media.object_version_id.toLowerCase() === 'null') return invalidResponse()
  const prefix = `v8/account-${ownerId}/workload-${id}/shard-${shardId}/result/${resultId}/`
  const leaf = media.object_key.slice(prefix.length)
  if (!media.object_key.startsWith(prefix) || leaf.length < 1 || leaf.length > 180 || /[/\\]/u.test(leaf)) return invalidResponse()
  // File delivery is attachment-only, including HTML/SVG and any media MIME in a
  // frozen file contract. Ineligible metadata stays diagnostic, never downloadable.
  if (fileIntent) {
    if (media.size_bytes < 1 || media.size_bytes > MAX_FILE_BYTES
      || !UUID.test(id) || !UUID.test(shardId) || !UUID.test(resultId)) return parsed
    if (!SHA.test(media.sha256) || !FILE_NAME.test(media.filename) || media.filename.includes('..') || leaf !== media.filename) return invalidResponse()
    return { ...parsed, artifactRef: `qianshou-file://task/${id}/${media.sha256}` }
  }
  if (extension === undefined) return parsed
  if (media.size_bytes < 1 || media.size_bytes > 64 * 1024 * 1024) return invalidResponse()
  return { ...parsed, artifactRef: `qianshou-media://task/${id}/${media.sha256}.${extension}` }
}

/** A result that could become an Assistant video link needs its owner task contract.
 * @param result - Owner-visible result parsed from the core response.
 * @returns Whether the result could expose a video artifact reference.
 */
export function isVideoArtifactResult(result: ComputeWorkloadResult): boolean {
  const ref = result.artifactRef
  if (ref === null) return false
  if (VIDEO_MEDIA_REFERENCE.test(ref)) return true
  if (/\.(?:mp4|webm|mov)(?:[?#]|$)/iu.test(ref)) return true
  if (!ref.startsWith('{')) return false
  try {
    const value: unknown = JSON.parse(ref)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).schema === 'artifact.v1'
      && ['video/mp4', 'video/webm', 'video/quicktime'].includes(String((value as Record<string, unknown>).content_type))
  } catch { return false }
}

/** Classify from the same account's owner detail, never a task name or browser draft.
 * @param id - Expected workload identity.
 * @param body - Authenticated owner detail from the core.
 * @param accountId - Current authenticated account identity.
 * @param status - Status returned by the result endpoint.
 * @returns Reviewed or ordinary only after the detail is validated.
 */
export function ownedVideoResultKind(id: string, body: unknown, accountId: number,
  status: string): 'ordinary' | 'reviewed' {
  const invalid = (): never => { throw new ComputeError('CORE_VIDEO_RESULT_UNVERIFIED', 502) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid()
  const detail = body as Record<string, unknown>
  if (detail.id !== id || detail.owner_id !== accountId || detail.status !== status
    || !Number.isSafeInteger(accountId) || accountId < 1
    || detail.result === null || typeof detail.result !== 'object' || Array.isArray(detail.result)
    || detail.spec === null || typeof detail.spec !== 'object' || Array.isArray(detail.spec)) invalid()
  const spec = detail.spec as Record<string, unknown>
  if (typeof spec.task_type !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(spec.task_type)
    || typeof spec.input_kind !== 'string' || spec.input_kind.length > 64
    || !Array.isArray(spec.input_refs) || spec.input_refs.length > 1024
    || spec.input_refs.some(ref => typeof ref !== 'string' || ref.length > 2048)
    || typeof spec.verification_policy !== 'string' || spec.verification_policy.length > 64
    || spec.requirements === null || typeof spec.requirements !== 'object'
    || Array.isArray(spec.requirements)) invalid()
  const requirements = spec.requirements as Record<string, unknown>
  const contract = requirements._reviewed_task_contract
  const publication = requirements.reviewed_publication
  const firstFrame = requirements._reviewed_video_input_binding
  const reviewedInput = Array.isArray(spec.input_refs) && spec.input_refs.some(value =>
    typeof value === 'string' && REVIEWED_VIDEO_INPUT_PREFIX.test(value))
  if (contract === undefined && publication === undefined && firstFrame === undefined && !reviewedInput
    && spec.task_type !== 'owner_video_v1' && spec.verification_policy !== 'semantic') return 'ordinary'
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)
    || publication === null || typeof publication !== 'object' || Array.isArray(publication)
    || firstFrame === null || typeof firstFrame !== 'object' || Array.isArray(firstFrame)) invalid()
  const frozen = contract as Record<string, unknown>
  const selected = publication as Record<string, unknown>
  const input = firstFrame as Record<string, unknown>
  const file = input.file
  const refs = spec.input_refs
  if (contract === undefined || publication === undefined || firstFrame === undefined
    || frozen.schema !== 'qianshou.reviewed-workload-contract.v1'
    || frozen.result_strategy !== 'external-media.v1' || frozen.output_kind !== 'artifact_ref'
    || selected.schema !== 'qianshou.reviewed-publication-selection.v1'
    || Object.keys(selected).sort().join(',') !== 'artifact_digest,contract_sha256,publication_id,schema'
    || input.schema !== 'qianshou.reviewed-video-input-binding.v1'
    || input.account_id !== accountId || input.task_type !== spec.task_type
    || spec.input_kind !== 'multi_file' || !Array.isArray(refs) || refs.length !== 1
    || typeof refs[0] !== 'string' || REVIEWED_VIDEO_INPUT_KEY.exec(refs[0])?.[1] !== String(accountId)
    || file === null || typeof file !== 'object' || Array.isArray(file)
    || (file as Record<string, unknown>).objectKey !== refs[0]
    || typeof (file as Record<string, unknown>).objectVersionId !== 'string'
    || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(String((file as Record<string, unknown>).objectVersionId))
    || typeof (file as Record<string, unknown>).sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(String((file as Record<string, unknown>).sha256))
    || !['image/png', 'image/jpeg'].includes(String((file as Record<string, unknown>).contentType))
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(String(frozen.publication_id))
    || frozen.publication_id !== selected.publication_id
    || !/^sha256:[a-f0-9]{64}$/u.test(String(frozen.artifact_digest))
    || frozen.artifact_digest !== selected.artifact_digest
    || !/^sha256:[a-f0-9]{64}$/u.test(String(frozen.contract_sha256))
    || frozen.contract_sha256 !== selected.contract_sha256
    || !/^sha256:[a-f0-9]{64}$/u.test(String(frozen.package_digest))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(input.file_sha256))
    || spec.verification_policy !== 'semantic') invalid()
  return 'reviewed'
}
