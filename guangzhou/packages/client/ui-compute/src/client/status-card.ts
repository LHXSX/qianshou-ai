/** Versioned, provider-neutral task card projection for human-facing surfaces. */
import type { ComputeCapability, ComputeQuote } from '@deepseek-ai/dsh-compute-core/protocol'
import type { ComputeTaskState } from '@deepseek-ai/dsh-compute-core/task-state'

/** Wire identifier for the card projection; this is metadata only. */
export const COMPUTE_TASK_CARD_PROTOCOL = 'qianshou.task-card.v1' as const
/** Literal version of serialized card metadata. */
export type ComputeTaskCardProtocol = typeof COMPUTE_TASK_CARD_PROTOCOL

/** Presentation phase derived from observed control-plane state; completed requires settlement. */
export type ComputeTaskCardPhase =
  | 'capability' | 'planning' | 'quoted' | 'awaiting_authorization' | 'submitting'
  | 'running' | 'returned' | 'paused' | 'offline' | 'completed' | 'error'
/** Reported capability availability, preserving absence of evidence. */
export type ComputeTaskCardAvailability = 'available' | 'unavailable' | 'unknown'
/** Quote availability at the card's observation time. */
export type ComputeTaskCardQuoteStatus = 'none' | 'available' | 'expired'
/** Reported authorization state; rendering does not grant approval. */
export type ComputeTaskCardAuthorization = 'not_required' | 'required' | 'approved' | 'declined'
/** Submission projection that keeps existing tasks separate from new candidates. */
export type ComputeTaskCardSubmission = 'not_ready' | 'ready' | 'submitted' | 'rejected'
/** Progress presentation; returned output waits for acceptance rather than becoming complete. */
export type ComputeTaskCardProgressStatus = 'not_started' | 'running' | 'waiting' | 'complete' | 'blocked'
/** Observed result availability, independently of financial settlement. */
export type ComputeTaskCardResultStatus = 'none' | 'pending' | 'available' | 'unavailable'

/** Source-reported error retained in card metadata. */
export interface ComputeTaskCardError { code: string; message: string }
/** Complete versioned card projection; all authority remains with its source services. */
export interface ComputeTaskCard {
  protocol: ComputeTaskCardProtocol
  cardId: string
  title: string
  capability: { id: string | null; name: string | null; availability: ComputeTaskCardAvailability; reason: string | null }
  parallel: { recommended: boolean; availableNodes: number | null; rationale: string }
  quote: { status: ComputeTaskCardQuoteStatus; quoteId: string | null; amountMinor: number | null; currency: 'CNY' | null; expiresAt: string | null }
  authorization: ComputeTaskCardAuthorization
  submission: ComputeTaskCardSubmission
  progress: { status: ComputeTaskCardProgressStatus; fraction: number | null }
  result: { status: ComputeTaskCardResultStatus }
  phase: ComputeTaskCardPhase
  error: ComputeTaskCardError | null
  updatedAt: string
}

/** Explicit observations used to project a card without requests or side effects. */
export interface ComputeTaskCardInput {
  cardId: string
  title: string
  capability?: ComputeCapability | null
  parallel?: { recommended: boolean; availableNodes: number | null; rationale: string }
  quote?: ComputeQuote | null
  authorization?: ComputeTaskCardAuthorization
  submission?: Exclude<ComputeTaskCardSubmission, 'not_ready'>
  task?: ComputeTaskState | null
  error?: ComputeTaskCardError | null
  updatedAt: string
}

/**
 * Project validated control-plane facts without side effects.
 * An existing task cannot become ready for submission again; only SETTLED means completed.
 * @param input - Observed capability, quote, authorization and task facts with their timestamp.
 * @returns An immutable presentation card; throws when input fields fail projection validation.
 */
export function projectComputeTaskCard(input: ComputeTaskCardInput): ComputeTaskCard {
  validateInput(input)
  const capability = input.capability
  const availability: ComputeTaskCardAvailability = capability === undefined || capability === null
    ? 'unknown' : capability.available ? 'available' : 'unavailable'
  const quoteStatus = quoteStatusAt(input.quote, input.updatedAt)
  const authorization = input.authorization ?? (quoteStatus === 'available' ? 'required' : 'not_required')
  const task = input.task
  const submission = task ? 'submitted' : input.submission ?? (authorization === 'approved' && quoteStatus === 'available' ? 'ready' : 'not_ready')
  const taskStatus = task?.status
  const terminalFailure = taskStatus === 'FAILED' || taskStatus === 'REVOKED' || taskStatus === 'EXPIRED' || taskStatus === 'REFUSED'
  const resultStatus: ComputeTaskCardResultStatus = taskStatus === 'RETURNED' || taskStatus === 'SETTLED' ? 'available'
    : terminalFailure ? 'unavailable' : task ? 'pending' : 'none'
  const progress = task ? { status: progressStatus(taskStatus, terminalFailure), fraction: task.progress }
    : { status: 'not_started' as const, fraction: null }
  const phase = cardPhase({ input, capability, quoteStatus, authorization, submission, taskStatus, terminalFailure })
  const quote = input.quote
  return Object.freeze({
    protocol: COMPUTE_TASK_CARD_PROTOCOL,
    cardId: input.cardId,
    title: input.title,
    capability: Object.freeze({
      id: capability?.id ?? null, name: capability?.name ?? null, availability,
      reason: capability?.unavailableReason ?? null,
    }),
    parallel: Object.freeze(input.parallel ?? {
      recommended: false, availableNodes: null, rationale: 'No node availability was reported.',
    }),
    quote: Object.freeze({
      status: quoteStatus, quoteId: quote?.id ?? null, amountMinor: quote?.amountMinor ?? null,
      currency: quote?.currency ?? null, expiresAt: quote?.expiresAt ?? null,
    }),
    authorization,
    submission,
    progress: Object.freeze(progress),
    result: Object.freeze({ status: resultStatus }),
    phase,
    error: input.error ? Object.freeze({ ...input.error }) : null,
    updatedAt: input.updatedAt,
  })
}

function progressStatus(status: ComputeTaskState['status'] | undefined, terminalFailure: boolean): ComputeTaskCardProgressStatus {
  if (status === 'SETTLED') return 'complete'
  if (status === 'RETURNED') return 'waiting'
  if (terminalFailure || status === 'OFFLINE' || status === 'PAUSED') return 'blocked'
  if (status === 'EXECUTING' || status === 'UPLOADING') return 'running'
  return 'not_started'
}

function cardPhase(input: {
  input: ComputeTaskCardInput
  capability: ComputeCapability | null | undefined
  quoteStatus: ComputeTaskCardQuoteStatus
  authorization: ComputeTaskCardAuthorization
  submission: ComputeTaskCardSubmission
  taskStatus: ComputeTaskState['status'] | undefined
  terminalFailure: boolean
}): ComputeTaskCardPhase {
  if (input.input.error || input.terminalFailure) return 'error'
  if (input.taskStatus === 'SETTLED') return 'completed'
  if (input.taskStatus === 'RETURNED') return 'returned'
  if (input.taskStatus === 'PAUSED') return 'paused'
  if (input.taskStatus === 'OFFLINE') return 'offline'
  if (input.taskStatus === 'EXECUTING' || input.taskStatus === 'UPLOADING') return 'running'
  if (input.taskStatus === 'ACCEPTED' || input.taskStatus === 'OFFERED' || input.submission === 'submitted') return 'submitting'
  if (input.authorization === 'required') return 'awaiting_authorization'
  if (input.quoteStatus === 'available') return 'quoted'
  return input.capability ? 'planning' : 'capability'
}

/**
 * Validate cached or event-delivered fields and lifecycle consistency.
 * Returns the same object or throws INVALID_COMPUTE_TASK_CARD; it does not authorize execution or verify the source's claims.
 * @param value - Untrusted cached or delivered card metadata.
 * @returns The same card object after field and lifecycle-consistency validation.
 */
export function parseComputeTaskCard(value: unknown): ComputeTaskCard {
  if (!isRecord(value) || value.protocol !== COMPUTE_TASK_CARD_PROTOCOL || !text(value.cardId) || !text(value.title)
    || !timestamp(value.updatedAt) || !validCapability(value.capability) || !validParallel(value.parallel)
    || !validQuote(value.quote, value.updatedAt) || !validProgress(value.progress) || !validError(value.error)
    || !isRecord(value.result) || !oneOf(value.result.status, ['none', 'pending', 'available', 'unavailable'])
    || !oneOf(value.authorization, ['not_required', 'required', 'approved', 'declined'])
    || !oneOf(value.submission, ['not_ready', 'ready', 'submitted', 'rejected'])
    || !oneOf(value.phase, ['capability', 'planning', 'quoted', 'awaiting_authorization', 'submitting', 'running', 'returned', 'paused', 'offline', 'completed', 'error'])) throw new Error('INVALID_COMPUTE_TASK_CARD')
  const card = value as unknown as ComputeTaskCard
  if (!consistentLifecycle(card)) throw new Error('INVALID_COMPUTE_TASK_CARD')
  return card
}

function validCapability(value: unknown): boolean {
  return isRecord(value) && nullableText(value.id) && nullableText(value.name) && nullableText(value.reason)
    && oneOf(value.availability, ['available', 'unavailable', 'unknown'])
}
function validParallel(value: unknown): boolean {
  return isRecord(value) && typeof value.recommended === 'boolean' && text(value.rationale)
    && (value.availableNodes === null || nonnegativeInteger(value.availableNodes))
}
function validQuote(value: unknown, at: string): boolean {
  if (!isRecord(value)) return false
  if (value.status === 'none') return value.quoteId === null && value.amountMinor === null && value.currency === null && value.expiresAt === null
  return oneOf(value.status, ['available', 'expired']) && text(value.quoteId) && nonnegativeInteger(value.amountMinor)
    && value.currency === 'CNY' && timestamp(value.expiresAt)
    && (value.status === 'available') === (Date.parse(value.expiresAt) > Date.parse(at))
}
function validProgress(value: unknown): boolean {
  return isRecord(value) && oneOf(value.status, ['not_started', 'running', 'waiting', 'complete', 'blocked'])
    && (value.fraction === null || typeof value.fraction === 'number' && Number.isFinite(value.fraction) && value.fraction >= 0 && value.fraction <= 1)
}
function validError(value: unknown): boolean {
  return value === null || isRecord(value) && text(value.code) && text(value.message)
}
function consistentLifecycle(card: ComputeTaskCard): boolean {
  if (card.error !== null && card.phase !== 'error') return false
  if (card.submission === 'ready' && (card.result.status !== 'none' || card.progress.status !== 'not_started' || card.progress.fraction !== null)) return false
  switch (card.phase) {
    case 'returned':
      return card.submission === 'submitted' && card.progress.status === 'waiting' && card.result.status === 'available'
    case 'completed':
      return card.submission === 'submitted' && card.progress.status === 'complete' && card.result.status === 'available'
    case 'paused': case 'offline':
      return card.submission === 'submitted' && card.progress.status === 'blocked' && card.result.status === 'pending'
    case 'running':
      return card.submission === 'submitted' && card.progress.status === 'running' && card.result.status === 'pending'
    case 'submitting':
      return card.submission === 'submitted'
    default:
      return true
  }
}

function quoteStatusAt(quote: ComputeQuote | null | undefined, at: string): ComputeTaskCardQuoteStatus {
  if (!quote) return 'none'
  return Date.parse(quote.expiresAt) > Date.parse(at) ? 'available' : 'expired'
}
function validateInput(input: ComputeTaskCardInput): void {
  if (!text(input.cardId) || !text(input.title) || !timestamp(input.updatedAt)) throw new Error('INVALID_COMPUTE_TASK_CARD_INPUT')
  if (input.error !== undefined && input.error !== null && (!text(input.error.code) || !text(input.error.message))) throw new Error('INVALID_COMPUTE_TASK_CARD_INPUT')
  if (input.parallel && !validParallel(input.parallel)) throw new Error('INVALID_COMPUTE_TASK_CARD_INPUT')
}
function oneOf(value: unknown, choices: readonly string[]): boolean { return typeof value === 'string' && choices.includes(value) }
function nonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function nullableText(value: unknown): boolean { return value === null || text(value) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value) }
function timestamp(value: unknown): value is string {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
