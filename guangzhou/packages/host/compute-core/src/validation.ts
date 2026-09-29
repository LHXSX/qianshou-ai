/** JSON admission for compute plans and core quotes, without network or billing effects. */
import {
  ComputeCapabilityId,
  ComputePlanId,
  ComputeQuoteId,
  ComputeTaskId,
  type ComputePlanConfirmation,
  type ComputePlanPublish,
  type ComputePlanRequest,
  type ComputeQuote,
  type ComputeTaskEnvelope,
} from './protocol.ts'

/** Maximum admitted identity length in UTF-16 code units. */
export const MAX_COMPUTE_ID_CHARS = 128
/** Maximum admitted planning goal length in UTF-16 code units. */
export const MAX_COMPUTE_GOAL_CHARS = 8_000
/** Request admission ceiling; this does not advertise hardware capacity or reserve nodes. */
export const MAX_COMPUTE_REQUEST_NODES = 64
/** Maximum number of staged references accepted by one local assignment. */
export const MAX_COMPUTE_TASK_INPUTS = 64
/** Maximum serialized task parameters accepted before a plugin sees them. */
export const MAX_COMPUTE_TASK_PARAMETER_BYTES = 131_072

function invalid(field: string): never {
  throw new TypeError(`INVALID_COMPUTE_FIELD: ${field}`)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('INVALID_COMPUTE_OBJECT')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    return invalid(field)
  }
  return value
}

function identity(value: unknown, field: string): string {
  const result = text(value, field, MAX_COMPUTE_ID_CHARS)
  if (result !== result.trim() || /[\u0000-\u001f\u007f]/u.test(result)) return invalid(field)
  return result
}

function minorAmount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(field)
  return value
}

function currency(value: unknown): 'CNY' {
  if (value !== 'CNY') return invalid('currency')
  return value
}

function nodeLimit(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_COMPUTE_REQUEST_NODES) {
    return invalid('maxNodes')
  }
  return value
}

function quoteExpiry(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return invalid('expiresAt')
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return invalid('expiresAt')
  return value
}

function taskDeadline(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return invalid('deadlineAt')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return invalid('deadlineAt')
  return value
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return invalid(field)
  return value
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value === 'string' || typeof value === 'boolean') return depth <= 12
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => jsonValue(item, depth + 1))
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    return entries.length <= 256 && entries.every(([key, item]) => identity(key, 'parameters') && jsonValue(item, depth + 1))
  }
  return false
}

/** Admit a scheduler assignment before it reaches a local capability plugin.
 * @param value - Untrusted wire JSON from the dispatch service.
 * @returns A versioned task envelope with bounded references and parameters.
 * @throws TypeError when the assignment is malformed or exceeds local limits.
 */
export function parseTaskEnvelope(value: unknown): ComputeTaskEnvelope {
  const item = record(value)
  if (item.version !== 'qianshou.task.v1') return invalid('version')
  const parameters = item.parameters
  if (!jsonValue(parameters) || JSON.stringify(parameters).length > MAX_COMPUTE_TASK_PARAMETER_BYTES) return invalid('parameters')
  if (!Array.isArray(item.inputRefs) || item.inputRefs.length > MAX_COMPUTE_TASK_INPUTS) return invalid('inputRefs')
  const inputRefs = item.inputRefs.map((input, index) => {
    const ref = record(input)
    const field = `inputRefs[${index}]`
    return {
      name: identity(ref.name, field + '.name'),
      bytes: minorAmount(ref.bytes, field + '.bytes'),
      sha256: sha256(ref.sha256, field + '.sha256'),
    }
  })
  const maxOutputBytes = item.maxOutputBytes
  if (typeof maxOutputBytes !== 'number' || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4_294_967_296) {
    return invalid('maxOutputBytes')
  }
  return Object.freeze({
    version: 'qianshou.task.v1',
    taskId: ComputeTaskId(identity(item.taskId, 'taskId')),
    capabilityId: ComputeCapabilityId(identity(item.capabilityId, 'capabilityId')),
    capabilityVersion: identity(item.capabilityVersion, 'capabilityVersion'),
    inputRefs: Object.freeze(inputRefs.map(input => Object.freeze(input))),
    parameters: deepFreeze(parameters),
    deadlineAt: taskDeadline(item.deadlineAt),
    maxOutputBytes,
    idempotencyKey: identity(item.idempotencyKey, 'idempotencyKey'),
  })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/**
 * Admit a bounded user plan without defaults or monetary conversion.
 * @param value - Untrusted JSON from a browser or model-facing tool.
 * @returns Only validated planning fields; no quote, reservation, or spending approval.
 * @throws TypeError when a required field is absent, unbounded, or invalid.
 */
export function parsePlanRequest(value: unknown): ComputePlanRequest {
  const item = record(value)
  return {
    capabilityId: ComputeCapabilityId(identity(item.capabilityId, 'capabilityId')),
    goal: text(item.goal, 'goal', MAX_COMPUTE_GOAL_CHARS),
    budgetMinor: minorAmount(item.budgetMinor, 'budgetMinor'),
    currency: currency(item.currency),
    maxNodes: nodeLimit(item.maxNodes),
  }
}

/** Host-issued plan identities written by `ComputeDraftStore`. */
const PLAN_ID = /^plan_[0-9a-f-]{36}$/u

/**
 * Admit a local draft confirmation without treating it as a quote or a submit.
 * @param value - Untrusted JSON from a browser conversation card.
 * @returns Only the stored plan identity and the owner decision.
 * @throws TypeError when the identity is not a host plan id or the decision is not approved/declined.
 */
export function parsePlanConfirmation(value: unknown): ComputePlanConfirmation {
  const item = record(value)
  const id = identity(item.id, 'id')
  if (!PLAN_ID.test(id)) invalid('id')
  if (item.decision !== 'approved' && item.decision !== 'declined') invalid('decision')
  return { id: ComputePlanId(id), decision: item.decision }
}

/**
 * Admit a local publish of one stored draft without treating extra JSON as a quote.
 * @param value - Untrusted `{ id }` from a conversation card or compute page.
 * @returns Only the stored plan identity.
 * @throws TypeError when the identity is not a host plan id.
 */
export function parsePlanPublish(value: unknown): ComputePlanPublish {
  const item = record(value)
  const id = identity(item.id, 'id')
  if (!PLAN_ID.test(id)) invalid('id')
  return { id: ComputePlanId(id) }
}

/**
 * Admit bounded core quote metadata without treating it as a spending authorization.
 * @param value - Untrusted quote JSON returned by the configured core provider.
 * @returns Only validated quote fields; the executor must verify ownership and expiry.
 * @throws TypeError for malformed fields, unsafe monetary precision, or invalid timestamps.
 */
export function parseQuote(value: unknown): ComputeQuote {
  const item = record(value)
  return {
    id: ComputeQuoteId(identity(item.id, 'id')),
    planId: ComputePlanId(identity(item.planId, 'planId')),
    currency: currency(item.currency),
    amountMinor: minorAmount(item.amountMinor, 'amountMinor'),
    expiresAt: quoteExpiry(item.expiresAt),
  }
}
