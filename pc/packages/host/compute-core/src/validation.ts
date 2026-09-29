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
  type ComputeAnchorSpec,
  type ComputeFanOutSpec,
  type ComputeJoinSpec,
} from './protocol.ts'
import { parsePlanFileInput } from './plan-file-input.ts'

/** Maximum admitted identity length in UTF-16 code units. */
export const MAX_COMPUTE_ID_CHARS = 128
/** Maximum admitted planning goal length in UTF-16 code units. */
export const MAX_COMPUTE_GOAL_CHARS = 8_000
/** A plan never carries file bytes or nested job parameters. */
export const MAX_COMPUTE_PLAN_PARAMS_BYTES = 16_384
/** Request admission ceiling; this does not advertise hardware capacity or reserve nodes. */
export const MAX_COMPUTE_REQUEST_NODES = 64
/** Maximum number of staged references accepted by one local assignment. */
export const MAX_COMPUTE_TASK_INPUTS = 64
/** Maximum serialized task parameters accepted before a plugin sees them. */
export const MAX_COMPUTE_TASK_PARAMETER_BYTES = 131_072
/** Maximum number of pieces a single fan-out join may wait for. */
export const MAX_COMPUTE_FAN_OUT_ARITY = 10_000

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

function parseFanOut(value: unknown): ComputeFanOutSpec {
  const item = record(value)
  const kind = item.kind
  if (kind !== 'triage' && kind !== 'batch' && kind !== 'anchor') return invalid('fanOut.kind')
  return Object.freeze({
    kind,
    bind: identity(item.bind, 'fanOut.bind'),
    shared: identity(item.shared, 'fanOut.shared'),
  })
}

function parseJoin(value: unknown): ComputeJoinSpec {
  const item = record(value)
  const kind = item.kind
  if (kind !== 'collect' && kind !== 'reduce') return invalid('join.kind')
  const arity = item.arity
  if (typeof arity !== 'number' || !Number.isSafeInteger(arity) || arity < 1 || arity > MAX_COMPUTE_FAN_OUT_ARITY) {
    return invalid('join.arity')
  }
  return Object.freeze({
    kind,
    arity,
    verifier: identity(item.verifier, 'join.verifier'),
  })
}

function parseAnchor(value: unknown): ComputeAnchorSpec {
  const item = record(value)
  const status = item.status
  if (status !== 'draft' && status !== 'confirmed') return invalid('anchor.status')
  const out: ComputeAnchorSpec = {
    id: identity(item.id, 'anchor.id'),
    status,
  }
  if (item.confirmed_by !== undefined || item.confirmedBy !== undefined) {
    const confirmedBy = item.confirmed_by ?? item.confirmedBy
    Object.assign(out, { confirmedBy: identity(confirmedBy, 'anchor.confirmedBy') })
  }
  if (item.confirmed_at !== undefined || item.confirmedAt !== undefined) {
    const confirmedAt = item.confirmed_at ?? item.confirmedAt
    if (typeof confirmedAt !== 'number' || !Number.isSafeInteger(confirmedAt) || confirmedAt < 0) return invalid('anchor.confirmedAt')
    Object.assign(out, { confirmedAt })
  }
  return Object.freeze(out)
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
  const hasFanOut = item.fanOut !== undefined
  const hasJoin = item.join !== undefined
  const hasAnchor = item.anchor !== undefined
  // A fan-out without a join has no safe settlement boundary. Keep the
  // legacy single-shard envelope compatible, but fail closed on partial specs.
  if (hasFanOut !== hasJoin) return invalid('fanOut/join')
  const fanOut = hasFanOut ? parseFanOut(item.fanOut) : undefined
  const join = hasJoin ? parseJoin(item.join) : undefined
  const anchor = hasAnchor ? parseAnchor(item.anchor) : undefined
  if (fanOut?.kind === 'anchor' && anchor === undefined) return invalid('anchor')
  if (fanOut?.kind !== 'anchor' && anchor !== undefined) return invalid('anchor')
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
    ...(fanOut === undefined ? {} : { fanOut }),
    ...(join === undefined ? {} : { join }),
    ...(anchor === undefined ? {} : { anchor }),
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
 * Preserve the selected platform task_type exactly; a new marketplace task
 * must not require a desktop release just to add a static reverse mapping.
 * @param value - Untrusted JSON from a browser or model-facing tool.
 * @returns Only validated planning fields; no quote, reservation, or spending approval.
 * @throws TypeError when a required field is absent, unbounded, or invalid.
 */
export function parsePlanRequest(value: unknown): ComputePlanRequest {
  const item = record(value)
  const raw = identity(item.capabilityId, 'capabilityId')
  let expectedVideoReview: ComputePlanRequest['expectedVideoReview']
  if (item.expectedVideoReview !== undefined) {
    const expectation = record(item.expectedVideoReview)
    if (Object.keys(expectation).sort().join(',') !== 'approvedContractDigest,artifactDigest,contractSha256,publicationId'
      || typeof expectation.publicationId !== 'string'
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(expectation.publicationId)
      || typeof expectation.approvedContractDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(expectation.approvedContractDigest)
      || typeof expectation.artifactDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(expectation.artifactDigest)
      || typeof expectation.contractSha256 !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(expectation.contractSha256)) invalid('expectedVideoReview')
    expectedVideoReview = { publicationId: expectation.publicationId,
      approvedContractDigest: expectation.approvedContractDigest,
      artifactDigest: expectation.artifactDigest, contractSha256: expectation.contractSha256 }
  }
  let expectedProduct: ComputePlanRequest['expectedProduct']
  if (item.expectedProduct !== undefined) {
    const selected = record(item.expectedProduct)
    if (Object.keys(selected).sort().join(',') !== 'ownerId,productId,publicationId,version'
      || typeof selected.productId !== 'string'
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(selected.productId)
      || typeof selected.publicationId !== 'string'
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(selected.publicationId)
      || typeof selected.ownerId !== 'number' || !Number.isSafeInteger(selected.ownerId) || selected.ownerId < 1
      || typeof selected.version !== 'string' || selected.version.length < 1 || selected.version.length > 40) {
      invalid('expectedProduct')
    }
    expectedProduct = { productId: selected.productId, publicationId: selected.publicationId,
      ownerId: selected.ownerId, version: selected.version }
  }
  if (expectedVideoReview !== undefined && expectedProduct !== undefined
    && expectedProduct.publicationId !== expectedVideoReview.publicationId) invalid('expectedProduct')
  let params: Record<string, string | number | boolean> | undefined
  if (item.params !== undefined) {
    const source = record(item.params)
    const keys = Object.keys(source)
    if (keys.length > 32) invalid('params')
    params = Object.create(null) as Record<string, string | number | boolean>
    for (const key of keys.sort()) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) || key === 'constructor' || key === 'prototype') invalid('params')
      const entry = source[key]
      if (typeof entry === 'string' && entry.length <= MAX_COMPUTE_GOAL_CHARS && !entry.includes('\0')) params[key] = entry
      else if (typeof entry === 'number' && Number.isFinite(entry)) params[key] = entry
      else if (typeof entry === 'boolean') params[key] = entry
      else invalid('params')
    }
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') > MAX_COMPUTE_PLAN_PARAMS_BYTES) invalid('params')
  }
  return {
    capabilityId: ComputeCapabilityId(raw),
    goal: text(item.goal, 'goal', MAX_COMPUTE_GOAL_CHARS),
    ...(params === undefined ? {} : { params }),
    ...(item.fileInput === undefined ? {} : { fileInput: parsePlanFileInput(item.fileInput) }),
    ...(expectedVideoReview === undefined ? {} : { expectedVideoReview }),
    ...(expectedProduct === undefined ? {} : { expectedProduct }),
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
  const quoteId = item.quoteId
  if (quoteId !== undefined && (typeof quoteId !== 'string' || !/^quote_[0-9a-f-]{36}$/u.test(quoteId))) invalid('quoteId')
  return { id: ComputePlanId(id), decision: item.decision,
    ...(quoteId === undefined ? {} : { quoteId: quoteId as string }) }
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
