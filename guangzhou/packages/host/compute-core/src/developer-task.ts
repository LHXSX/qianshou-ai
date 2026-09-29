/** Observed `DeveloperTaskCreateIn` fields for `POST /api/v8/developer/tasks`. */
import { ComputeError } from './errors.ts'
import type { ComputePlanRequest } from './protocol.ts'

/** Source-verified developer-task create path; never `POST /api/v8/workloads`. */
export const DEVELOPER_TASK_CREATE_PATH = '/api/v8/developer/tasks' as const
/** Observed `timeout_s` Field default on `DeveloperTaskCreateIn`. */
export const DEVELOPER_TASK_TIMEOUT_S = 300
/** Catalogue input kind used for a CEO conversation goal. */
export const DEVELOPER_TASK_INLINE_KIND = 'inline' as const

/** Catalogue row fields required to choose a legal developer-task input kind. */
export interface DeveloperTaskType {
  taskType: string
  acceptedInputKinds: readonly string[]
  defaultInputKind: string
}

/**
 * Exact JSON object sent to `create_developer_task`.
 * Field names, defaults and bounds are copied from `DeveloperTaskCreateIn`
 * (`platform_v8/api/v8/developer.py`). Extra keys must not be added: the server
 * fingerprints `model_dump` of the parsed body.
 */
export interface DeveloperTaskCreateBody {
  task_type: string
  input_kind: typeof DEVELOPER_TASK_INLINE_KIND
  input_ref: ''
  input_refs: []
  inline_input: string
  params: Record<string, never>
  name: ''
  budget: string
  timeout_s: typeof DEVELOPER_TASK_TIMEOUT_S
  max_shards: number
  auto_shard: boolean
  idempotency_key: string
  callback_url: ''
  callback_secret: ''
}

/** Convert integer CNY fen into the yuan decimal string the core Decimal field accepts.
 * @param budgetMinor - Nonnegative integer fen already admitted on the local draft.
 * @returns Two-fraction-digit yuan string with no floating-point conversion.
 */
export function yuanFromFen(budgetMinor: number): string {
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) throw new ComputeError('INVALID_COMPUTE_FIELD')
  return `${Math.trunc(budgetMinor / 100)}.${String(budgetMinor % 100).padStart(2, '0')}`
}

/** Build the developer-task body minus the idempotency key, for ledger fingerprinting.
 * @param request - Local approved plan request.
 * @param taskType - Catalogue row for `request.capabilityId`.
 * @returns Canonical fields the Host will POST, without `idempotency_key`.
 */
export function developerTaskIntentRequest(
  request: ComputePlanRequest,
  taskType: DeveloperTaskType,
): Omit<DeveloperTaskCreateBody, 'idempotency_key'> {
  if (taskType.taskType !== request.capabilityId) throw new ComputeError('COMPUTE_CAPABILITY_UNAVAILABLE', 409)
  if (!taskType.acceptedInputKinds.includes(DEVELOPER_TASK_INLINE_KIND)) {
    throw new ComputeError('COMPUTE_INPUT_KIND_UNSUPPORTED', 409)
  }
  const maxShards = request.maxNodes ?? 1
  return {
    task_type: request.capabilityId,
    input_kind: DEVELOPER_TASK_INLINE_KIND,
    input_ref: '',
    input_refs: [],
    inline_input: request.goal,
    params: {},
    name: '',
    budget: yuanFromFen(request.budgetMinor),
    timeout_s: DEVELOPER_TASK_TIMEOUT_S,
    max_shards: maxShards,
    auto_shard: maxShards > 1,
    callback_url: '',
    callback_secret: '',
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
