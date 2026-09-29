/** Browser-safe compute planning and receipt types; drafts do not authorize spending. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PlanFileInput } from './plan-file-input.ts'

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

/** The three task fan-out modes defined by qianshou/task/v1. */
export type ComputeFanOutKind = 'triage' | 'batch' | 'anchor'
/** How a task's pieces are differentiated and what remains shared. */
export interface ComputeFanOutSpec {
  readonly kind: ComputeFanOutKind
  readonly bind: string
  readonly shared: string
}
/** How fan-out pieces are joined before a result can be accepted. */
export interface ComputeJoinSpec {
  readonly kind: 'collect' | 'reduce'
  readonly arity: number
  readonly verifier: string
}
/** Human-confirmed consistency reference for anchor fan-out. */
export interface ComputeAnchorSpec {
  readonly id: string
  readonly status: 'draft' | 'confirmed'
  readonly confirmedBy?: string
  readonly confirmedAt?: number
}

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
  /** Optional semantic fan-out. Omitted means the legacy single-shard task. */
  fanOut?: ComputeFanOutSpec
  /** Required with fanOut; settlement must wait for the declared join. */
  join?: ComputeJoinSpec
  /** Required for `fanOut.kind=anchor`; draft anchors never dispatch. */
  anchor?: ComputeAnchorSpec
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
  /** Bounded scalar fields from the reviewed Shanghai task form; absent for older plans. */
  params?: Readonly<Record<string, string | number | boolean>>
  /** Completed owner uploads; byte materialization belongs to the assigned PC. */
  fileInput?: PlanFileInput
  /** Buyer-confirmed reviewed video publication; checked against live catalog at plan, quote and submit. */
  expectedVideoReview?: Readonly<{
    publicationId: string
    approvedContractDigest: string
    artifactDigest: string
    contractSha256: string
  }>
  /** Exact public product chosen by this buyer, never inferred from task type. */
  expectedProduct?: Readonly<{ productId: string; publicationId: string; ownerId: number; version: string }>
  budgetMinor: number
  currency: 'CNY'
  /** Requested concurrency ceiling, or null to leave selection to the scheduler. */
  maxNodes: number | null
}

/** Owner decision on a local draft; this is not a quote acceptance or a workload submit. */
export type ComputePlanAuthorization = 'pending' | 'approved' | 'declined'

/** Local confirmation of one displayed, short-lived quote; the Host never forwards this to a core. */
export interface ComputePlanConfirmation {
  id: ComputePlanId
  decision: Exclude<ComputePlanAuthorization, 'pending'>
  /** Required for approval, omitted when declining. */
  quoteId?: string
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
  /** Central-server workload creation instant; absent on older receipts. */
  createdAt?: string
  /** Present only after reading the same task's authenticated shard receipts. */
  executionStage?: 'waiting' | 'executing' | 'checking'
}

/** Owner-visible result observation; never settlement or downloaded artifact bytes. */
export interface ComputeWorkloadResult {
  id: ComputeWorkloadId
  status: string
  inlineOutput: string | null
  artifactRef: string | null
}

/** One ledger row a cancellation is reported with; copied from the scheduler, never recomputed. */
export interface ComputeWorkloadLedgerRow {
  readonly type: string
  readonly amount: string
  readonly note: string
  readonly createdAt: string
}

/** Refund facts for one workload, read from the owner ledger after a cancellation.
 *
 * `null` in {@link ComputeWorkloadCancellation} means the ledger could not be read — it never means
 * "no refund happened". The balance projection is deliberately not used: it lags the ledger.
 */
export interface ComputeWorkloadRefundEvidence {
  readonly refundMinor: number
  readonly rows: readonly ComputeWorkloadLedgerRow[]
}

/** Answer to a cancellation request: terminal state plus what the ledger shows for this workload. */
export interface ComputeWorkloadCancellation {
  readonly id: ComputeWorkloadId
  /** Terminal state the scheduler reports (`CANCELLED`, or whatever it decided instead). */
  readonly state: string
  /** True when the workload was already terminal before this request — the idempotent repeat. */
  readonly alreadyTerminal: boolean
  readonly ledger: ComputeWorkloadRefundEvidence | null
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
