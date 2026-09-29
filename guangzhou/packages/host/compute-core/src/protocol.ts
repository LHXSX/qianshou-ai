/** Browser-safe compute planning and receipt types; drafts do not authorize spending. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of an advertised execution capability. */
export type ComputeCapabilityId = Branded<'qianshou-compute-capability-id'>
/** Host-issued identity of a planning draft. */
export type ComputePlanId = Branded<'qianshou-compute-plan-id'>
/** Core-issued identity of one immutable quote. */
export type ComputeQuoteId = Branded<'qianshou-compute-quote-id'>
/** Core-issued identity of a submitted workload. */
export type ComputeWorkloadId = Branded<'qianshou-compute-workload-id'>
/** Core-issued identity of one passively assigned local task. */
export type ComputeTaskId = Branded<'qianshou-compute-task-id'>

/**
 * Brand a provider-owned or validated capability identity.
 * @param value - Identity issued by a trusted provider or admitted by JSON validation.
 * @returns The unchanged capability identity with its nominal type.
 */
export function ComputeCapabilityId(value: string): ComputeCapabilityId {
  return value as ComputeCapabilityId
}

/**
 * Brand a host-owned or validated plan identity.
 * @param value - Identity issued by the host or admitted by JSON validation.
 * @returns The unchanged plan identity with its nominal type.
 */
export function ComputePlanId(value: string): ComputePlanId {
  return value as ComputePlanId
}

/**
 * Brand a core-owned or validated quote identity.
 * @param value - Identity issued by the core or admitted by JSON validation.
 * @returns The unchanged quote identity with its nominal type.
 */
export function ComputeQuoteId(value: string): ComputeQuoteId {
  return value as ComputeQuoteId
}

/**
 * Brand a core-owned or validated workload identity.
 * @param value - Identity issued by the core or admitted by JSON validation.
 * @returns The unchanged workload identity with its nominal type.
 */
export function ComputeWorkloadId(value: string): ComputeWorkloadId {
  return value as ComputeWorkloadId
}

/** Brand a scheduler-issued task identity after envelope validation.
 * @param value - Validated task identity.
 * @returns The unchanged task identity with its nominal type.
 */
export function ComputeTaskId(value: string): ComputeTaskId { return value as ComputeTaskId }

/** Versioned assignment envelope understood by the unified agent executor. */
export interface ComputeTaskEnvelope {
  version: 'qianshou.task.v1'
  taskId: ComputeTaskId
  capabilityId: ComputeCapabilityId
  capabilityVersion: string
  inputRefs: readonly { name: string; bytes: number; sha256: string }[]
  parameters: unknown
  deadlineAt: string
  maxOutputBytes: number
  idempotencyKey: string
}

/** Configuration and separately negotiated core operations, without credentials. */
export interface ComputeConnectionState {
  configured: boolean
  capabilities: {
    workloadRead: boolean
    quoting: boolean
    submission: boolean
  }
  message: string
}

/** Capability metadata; installation does not imply availability or contribution consent. */
export interface ComputeCapability {
  id: ComputeCapabilityId
  name: string
  description: string
  delivery: 'remote' | 'local' | 'contributor'
  available: boolean
  unavailableReason?: string
}

/** User planning constraints; the budget is an integer number of CNY minor units (fen). */
export interface ComputePlanRequest {
  capabilityId: ComputeCapabilityId
  goal: string
  budgetMinor: number
  currency: 'CNY'
  /** Requested concurrency ceiling, or null to leave selection to the scheduler. */
  maxNodes: number | null
}

/** Owner decision on a local draft; this is not a quote acceptance or a workload submit. */
export type ComputePlanAuthorization = 'pending' | 'approved' | 'declined'

/** Local confirmation of one stored draft; the Host never forwards this to a core. */
export interface ComputePlanConfirmation {
  id: ComputePlanId
  decision: Exclude<ComputePlanAuthorization, 'pending'>
}

/** Local publish of one approved draft; the Host POSTs the observed developer-task route. */
export interface ComputePlanPublish {
  id: ComputePlanId
}

/** Local planning receipt; quote null means no price exists. */
export interface ComputePlanDraft {
  id: ComputePlanId
  request: ComputePlanRequest
  status: 'draft'
  createdAt: string
  quote: null
  authorization: ComputePlanAuthorization
  /** Core-issued workload identity after a successful developer-task publish; otherwise null. */
  workloadId: ComputeWorkloadId | null
  reason: string
}

/** Sanitized workload receipt; the core owns status and result availability. */
export interface ComputeWorkloadSummary {
  id: ComputeWorkloadId
  status: string
  progress: number | null
  resultAvailable: boolean
}

/** Core quote metadata; parsing alone proves neither authenticity nor authorization. */
export interface ComputeQuote {
  id: ComputeQuoteId
  planId: ComputePlanId
  currency: 'CNY'
  /** Total amount in CNY minor units (fen), without floating-point yuan conversion. */
  amountMinor: number
  /** UTC ISO 8601 timestamp with millisecond precision. */
  expiresAt: string
}
