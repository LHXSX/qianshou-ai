/** Observed `DeveloperTaskCreateIn` fields for `POST /api/v8/developer/tasks`. */
import { CAPABILITY_BY_TASK_TYPE, LEGACY_TASK_TYPES_BY_CAPABILITY, PREFERRED_LANDING_BY_CAPABILITY } from './capability-registry.ts'
import { ComputeError } from './errors.ts'
import { ComputeCapabilityId, type ComputePlanId, type ComputePlanRequest } from './protocol.ts'
import { admitInlineTaskParams, type TaskFormMetadata, type TaskScalar } from './task-form.ts'
import { parsePlanFileInput } from './plan-file-input.ts'
import type { ReviewedVideoTaskInput } from './reviewed-video-task-input.ts'
import type { ReviewedPublicationSelection } from './reviewed-publication-selection.ts'

/** Source-verified developer-task create path; never `POST /api/v8/workloads`. */
export const DEVELOPER_TASK_CREATE_PATH = '/api/v8/developer/tasks' as const
/** Read-only final-spec quote. Its opaque ticket must stay in the Host. */
export const DEVELOPER_TASK_ESTIMATE_PATH = '/api/v8/developer/tasks/estimate' as const
/** Observed owner result read; never `/download` and never `GET /api/v8/workloads/{id}/result`. */
export const DEVELOPER_TASK_RESULT_SUFFIX = '/result' as const

/** Bound GET path for one developer-task result.
 * @param id - Core-issued workload identity already admitted by the caller.
 * @returns `/api/v8/developer/tasks/{id}/result` with the identity encoded as a path segment.
 */
export function developerTaskResultPath(id: string): string {
  return DEVELOPER_TASK_CREATE_PATH + '/' + encodeURIComponent(id) + DEVELOPER_TASK_RESULT_SUFFIX
}
/** Observed `timeout_s` Field default on `DeveloperTaskCreateIn`. */
export const DEVELOPER_TASK_TIMEOUT_S = 300
/** Catalogue input kind used for a CEO conversation goal. */
export const DEVELOPER_TASK_INLINE_KIND = 'inline' as const

/** Catalogue row fields required to choose a legal developer-task input kind. */
export interface DeveloperTaskType extends Partial<TaskFormMetadata> {
  taskType: string
  acceptedInputKinds: readonly string[]
  defaultInputKind: string
  runtimes?: readonly string[]
  description?: string
  category?: string
  /** Null means the platform did not declare required params; Host fails closed. */
  requiredParams?: readonly string[] | null
  /** Semantic id when `taskType` is in the registry; omitted for unknown names. */
  capabilityId?: ComputeCapabilityId
  /** Live platform-reviewed first-frame and prompt meaning, absent for legacy task types. */
  reviewedVideoInput?: ReviewedVideoTaskInput
  /** Exact independently reviewed publication selected by the platform. */
  reviewedPublication?: ReviewedPublicationSelection
}

/**
 * Exact JSON object sent to `create_developer_task`.
 * Field names, defaults and bounds are copied from `DeveloperTaskCreateIn`
 * (`platform_v8/api/v8/developer.py`). The Host adds only the server-issued
 * `quote_token` and confirmed server budget after the final-spec preview.
 */
export interface DeveloperTaskCreateBody {
  task_type: string
  input_kind: typeof DEVELOPER_TASK_INLINE_KIND | 'multi_file'
  input_ref: ''
  input_refs: string[]
  inline_input: string | null
  params: Record<string, TaskScalar>
  name: ''
  budget: string
  /** Null before estimate; Shanghai-issued ticket only after explicit owner confirmation. */
  quote_token: string | null
  timeout_s: number
  max_shards: number
  auto_shard: boolean
  idempotency_key: string
  callback_url: ''
  callback_secret: ''
  /** Included in both estimate and create so the server never substitutes another seller. */
  reviewed_publication?: ReviewedPublicationSelection
  /** Buyer-selected listing, validated and locked again by Shanghai. */
  selected_product?: { product_id: string; publication_id: string; owner_id: number; version: string }
}

/** Only these quote facts may leave the Host for an explicit owner confirmation UI. */
export interface DeveloperTaskQuoteView {
  planId: ComputePlanId
  capabilityId: ComputeCapabilityId
  quoteId: string
  taskType: string
  name: string
  goal: string
  inputKind: 'inline' | 'multi_file'
  timeoutSeconds: number
  maxShards: number
  autoShard: boolean
  currency: 'CNY'
  requestedBudget: string
  recommendedBudget: string
  expiresAt: number
  balanceEnough: boolean
  priceBasis: string
  settingsVersion: string
  billingMode: 'server_price' | 'client_budget'
}

/** Private response from Shanghai; the ticket and final spec must never be serialized to a renderer. */
export interface DeveloperTaskEstimate {
  readonly recommendedBudget: string
  readonly requestedBudget: string
  readonly expiresAt: number
  readonly balanceEnough: boolean
  readonly priceBasis: string
  readonly settingsVersion: string
  readonly billingMode: DeveloperTaskQuoteView['billingMode']
  readonly name: string
  readonly quoteToken: string
}

/** Convert integer CNY fen into the yuan decimal string the core Decimal field accepts.
 * @param budgetMinor - Nonnegative integer fen already admitted on the local draft.
 * @returns Two-fraction-digit yuan string with no floating-point conversion.
 */
export function yuanFromFen(budgetMinor: number): string {
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) throw new ComputeError('INVALID_COMPUTE_FIELD')
  return `${Math.trunc(budgetMinor / 100)}.${String(budgetMinor % 100).padStart(2, '0')}`
}

/** Platform `task_type` names a local capability id may be published as.
 * The id itself is always accepted: today every `ComputeCapabilityId` is a platform
 * `task_type` verbatim. Semantic names add the `legacy_task_types` the registry records.
 * @param capabilityId - Local capability id from an approved plan.
 * @returns The id plus its registry legacy task types; only the id when the registry has no row.
 */
export function publishableTaskTypes(capabilityId: ComputeCapabilityId): readonly string[] {
  return [capabilityId, ...(LEGACY_TASK_TYPES_BY_CAPABILITY[capabilityId] ?? [])]
}

/**
 * Semantic capability that owns one platform `task_type` or semantic name.
 * @param taskType - Edge or catalogue `task_type`, or a registry capability name.
 * @returns The owning `ComputeCapabilityId`.
 * @throws {ComputeError} `COMPUTE_CAPABILITY_UNAVAILABLE` when the name is not in the registry map.
 */
export function capabilityIdForTaskType(taskType: string): ComputeCapabilityId {
  const capability = CAPABILITY_BY_TASK_TYPE[taskType]
  if (capability === undefined) {
    throw new ComputeError('COMPUTE_CAPABILITY_UNAVAILABLE', 409, `task_type "${taskType}" has no semantic capability`)
  }
  return ComputeCapabilityId(capability)
}

/**
 * Semantic id when the name is in the reverse map; `undefined` when it is not.
 * Use this on catalogue rows that must keep names the reverse map does not own.
 * @param taskType - Edge or catalogue `task_type`, or a registry capability name.
 * @returns The owning capability, or `undefined` when the name is not in the registry map.
 */
export function capabilityIdIfRegistered(taskType: string): ComputeCapabilityId | undefined {
  try {
    return capabilityIdForTaskType(taskType)
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'COMPUTE_CAPABILITY_UNAVAILABLE') return undefined
    throw error
  }
}

/**
 * Platform `task_type` to send when the caller named a capability or a landing.
 * Registry names land on the first listed `legacy_task_types` spelling so Shanghai
 * TASK_REGISTRY does not receive a contract id (`get_spec("media.transcode")` is `__default__`).
 * Sorted legacy lists stay a separate artifact; they must not pick the POST name.
 * Names absent from the reverse map stay verbatim.
 * @param taskType - Semantic id or recorded platform `task_type`.
 * @returns The first-listed registry landing, the semantic id when it has none, or the original name.
 */
export function preferredLandingTaskType(taskType: string): string {
  try {
    const id = capabilityIdForTaskType(taskType)
    return PREFERRED_LANDING_BY_CAPABILITY[id] ?? id
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'COMPUTE_CAPABILITY_UNAVAILABLE') return taskType
    throw error
  }
}

/**
 * Catalogue row the Host will POST as `task_type`.
 * Prefers a registry legacy landing that the core catalogue actually lists, so a semantic
 * id such as `media.transcode` does not go out as `__default__` on the platform.
 * @param capabilityId - Local capability id from an approved plan.
 * @param catalogue - Rows from `GET /api/v8/developer/task-types`.
 * @returns The first matching row, legacy names before the semantic id; `undefined` if none.
 */
export function landingTaskType(
  capabilityId: ComputeCapabilityId,
  catalogue: readonly DeveloperTaskType[],
): DeveloperTaskType | undefined {
  const accepted = publishableTaskTypes(capabilityId)
  const preferred = PREFERRED_LANDING_BY_CAPABILITY[capabilityId] ?? capabilityId
  const rest = accepted.filter(name => name !== preferred)
  for (const id of [preferred, ...rest]) {
    const row = catalogue.find(item => item.taskType === id)
    if (row !== undefined) return row
  }
  return undefined
}

function assertMixedVideoInput(request: ComputePlanRequest, taskType: DeveloperTaskType,
  files: ReturnType<typeof parsePlanFileInput> | undefined): void {
  if (taskType.reviewedVideoInput !== undefined && files === undefined) {
    throw new ComputeError('COMPUTE_VIDEO_MIXED_INPUT_INVALID', 409)
  }
  if (request.expectedVideoReview !== undefined
    && (files === undefined || taskType.capabilityId !== 'video.render')) {
    throw new ComputeError('COMPUTE_VIDEO_REVIEW_UNEXPECTED', 409)
  }
  if (files === undefined || taskType.capabilityId !== 'video.render') return
  const image = files.files[0]
  const prompt = request.params?.prompt
  const fields = taskType.paramsSchema?.properties
  const review = taskType.reviewedVideoInput
  const publication = taskType.reviewedPublication
  if (request.expectedVideoReview === undefined) throw new ComputeError('COMPUTE_VIDEO_MIXED_INPUT_INVALID', 409)
  if (review === undefined || publication === undefined) throw new ComputeError('COMPUTE_VIDEO_REVIEW_CHANGED', 409)
  if (review.publicContract.taskType !== taskType.taskType
    || review.publicContract.capabilityId !== taskType.capabilityId
    || review.firstFrameSlot !== 'first_frame' || review.promptSlot !== 'prompt'
    || review.firstFrameManifestParam !== 'input_manifest' || review.firstFrameManifestIndex !== 0
    || review.promptParam !== 'prompt'
    || files.files.length !== 1 || image === undefined
    || image.contentType !== 'image/png' && image.contentType !== 'image/jpeg'
    || image.contentType !== review.mimeType || image.bytes > review.maxBytes
    || !/^v8\/account-[1-9]\d{0,15}\/reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg)$/u.test(image.objectKey)
    || image.filename !== (image.contentType === 'image/png' ? 'frame.png' : 'frame.jpg')
    || image.objectVersionId === undefined
    || typeof prompt !== 'string' || !prompt.isWellFormed() || !prompt.trim()
    || Buffer.byteLength(prompt, 'utf8') > Math.min(8192, review.maxPromptUtf8Bytes)
    || request.goal !== prompt
    || taskType.formReady !== true || !taskType.requiredParams?.includes('input_manifest')
    || !taskType.requiredParams.includes('prompt')
    || fields?.prompt?.type !== 'string' || fields.input_manifest?.type !== 'string'
    || !taskType.paramsSchema?.required.includes('prompt')
    || !taskType.paramsSchema.required.includes('input_manifest')) {
    throw new ComputeError('COMPUTE_VIDEO_MIXED_INPUT_INVALID', 409)
  }
  if (review.publicationId !== request.expectedVideoReview.publicationId
    || review.approvedContractDigest !== request.expectedVideoReview.approvedContractDigest
    || publication.publication_id !== review.publicationId
    || request.expectedProduct !== undefined
      && request.expectedProduct.publicationId !== review.publicationId
    || publication.artifact_digest !== request.expectedVideoReview.artifactDigest
    || publication.contract_sha256 !== request.expectedVideoReview.contractSha256) {
    throw new ComputeError('COMPUTE_VIDEO_REVIEW_CHANGED', 409)
  }
}

/** Build the developer-task body minus the idempotency key, for ledger fingerprinting.
 * @param request - Local approved plan request.
 * @param taskType - Catalogue row already admitted as a publishable landing of `request.capabilityId`.
 * @returns Canonical fields the Host will POST, without `idempotency_key`.
 * @throws {ComputeError} `COMPUTE_CAPABILITY_UNAVAILABLE` naming the capability when the row is
 *   neither the id itself nor one of its registry legacy task types.
 */
export function developerTaskIntentRequest(
  request: ComputePlanRequest,
  taskType: DeveloperTaskType,
): Omit<DeveloperTaskCreateBody, 'idempotency_key'> {
  const accepted = publishableTaskTypes(request.capabilityId)
  const reviewedVideo = taskType.reviewedVideoInput !== undefined
    && taskType.capabilityId === 'video.render'
    && taskType.reviewedVideoInput.publicContract.taskType === taskType.taskType
    && request.capabilityId === taskType.taskType
  if (!accepted.includes(taskType.taskType) && !reviewedVideo) {
    throw new ComputeError('COMPUTE_CAPABILITY_UNAVAILABLE', 409, `capability "${request.capabilityId}" has no task_type "${taskType.taskType}" (accepted: ${accepted.join(', ')})`)
  }
  const files = request.fileInput === undefined ? undefined : parsePlanFileInput(request.fileInput)
  const inputKind = files === undefined ? DEVELOPER_TASK_INLINE_KIND : 'multi_file'
  if (!taskType.acceptedInputKinds.includes(inputKind)) {
    throw new ComputeError('COMPUTE_INPUT_KIND_UNSUPPORTED', 409)
  }
  assertMixedVideoInput(request, taskType, files)
  const supplied = { ...request.params }
  if (files !== undefined && Object.hasOwn(taskType.paramsSchema?.properties ?? {}, 'input_manifest')) {
    if (Object.hasOwn(supplied, 'input_manifest')) throw new ComputeError('COMPUTE_INPUT_PARAMS_INVALID', 409)
    supplied.input_manifest = JSON.stringify({ schema: 'qianshou.uploaded-inputs.v1', files: files.files })
  }
  const params = admitInlineTaskParams(supplied, taskType.requiredParams, {
    formSchemaVersion: taskType.formSchemaVersion ?? null,
    formReady: taskType.formReady === true,
    inputSchema: taskType.inputSchema ?? null,
    paramsSchema: taskType.paramsSchema ?? null,
  })
  const maxShards = request.maxNodes ?? 1
  return {
    // The platform TASK_REGISTRY has 70 legacy names and 0 of the 22 contract
    // ids (`get_spec("media.transcode")` is `__default__` with empty software).
    // The catalogue landing is the name the dispatcher actually filters on.
    task_type: taskType.taskType,
    input_kind: inputKind,
    input_ref: '',
    input_refs: files?.files.map(file => file.objectKey) ?? [],
    inline_input: files === undefined ? request.goal : null,
    params,
    name: '',
    budget: yuanFromFen(request.budgetMinor),
    quote_token: null,
    timeout_s: taskType.reviewedVideoInput?.publicContract.limits.timeoutSeconds
      ?? DEVELOPER_TASK_TIMEOUT_S,
    max_shards: maxShards,
    auto_shard: maxShards > 1,
    callback_url: '',
    callback_secret: '',
    ...(reviewedVideo && taskType.reviewedPublication !== undefined
      ? { reviewed_publication: taskType.reviewedPublication } : {}),
    ...(request.expectedProduct === undefined ? {} : { selected_product: {
      product_id: request.expectedProduct.productId,
      publication_id: request.expectedProduct.publicationId,
      owner_id: request.expectedProduct.ownerId,
      version: request.expectedProduct.version,
    } }),
  }
}

/** Bind a derived idempotency key onto the canonical developer-task fields.
 * @param fields - Intent request returned by {@link developerTaskIntentRequest}.
 * @param idempotencyKey - 1–128 character key from {@link deriveSubmissionIdempotencyKey}.
 * @returns The complete POST JSON object.
 */
export function developerTaskCreateBody(
  fields: Omit<DeveloperTaskCreateBody, 'idempotency_key'>,
  idempotencyKey: string,
): DeveloperTaskCreateBody {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
    throw new ComputeError('COMPUTE_SUBMISSION_INTENT_INVALID')
  }
  return { ...fields, idempotency_key: idempotencyKey }
}
