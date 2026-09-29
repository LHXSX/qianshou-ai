/** Owner-approved local execution admission and result receipt.
 *
 * This is the seam between a route preview and the already-existing local task
 * runner. It does not create a lease, charge an account, contact Shanghai or
 * load a plugin. A production dispatcher must still provide its own verified
 * lease before calling a node; this module only binds the local owner decision
 * to one exact task, node, capability and plugin digest.
 */
import { ComputeError } from './errors.ts'
import type { ComputeLocalTaskRequest, ComputeLocalTaskRunner } from './local-task-runner.ts'
import type { RouterPlan } from './router.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import { parseTaskEnvelope } from './validation.ts'

export const LOCAL_EXECUTION_APPROVAL_VERSION = 'qianshou.local-execution-approval.v1' as const
export const LOCAL_EXECUTION_RECEIPT_VERSION = 'qianshou.local-execution-receipt.v1' as const

export interface LocalExecutionApproval {
  readonly version: typeof LOCAL_EXECUTION_APPROVAL_VERSION
  readonly approvalId: string
  readonly executionId: string
  readonly taskId: string
  readonly attempt: number
  readonly workflowId: string
  readonly intentId: string
  readonly idempotencyKey: string
  readonly ownerAuthorization: 'approved'
  readonly routeStatus: 'ready'
  readonly executionAuthorized: true
  readonly nodeId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly pluginDigest: string
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface LocalExecutionApprovalInput {
  readonly plan: RouterPlan
  readonly ownerAuthorization: 'approved' | 'pending' | 'denied'
  readonly approvalId: string
  readonly executionId: string
  readonly taskId: string
  readonly attempt?: number
  readonly workflowId: string
  readonly intentId: string
  readonly idempotencyKey: string
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface LocalExecutionAdmission {
  readonly approval: LocalExecutionApproval
  readonly admittedAt: string
}

export interface LocalExecutionReceipt<T> {
  readonly version: typeof LOCAL_EXECUTION_RECEIPT_VERSION
  readonly approvalId: string
  readonly executionId: string
  readonly taskId: string
  readonly attempt: number
  readonly nodeId: string
  readonly status: 'completed'
  readonly startedAt: string
  readonly completedAt: string
  /** Result-consumer output; the caller must keep it free of local paths/bytes. */
  readonly result: T
}

/**
 * Parse a local execution receipt received by a PC surface.
 *
 * This is deliberately a shape parser only: it proves that the receipt is a
 * bounded local-completion observation, not that a remote lease, billing row,
 * or model output is authentic. Binding it to the approved task remains the
 * caller's responsibility through `admitLocalExecution`.
 */
export function parseLocalExecutionReceipt<T = unknown>(value: unknown): LocalExecutionReceipt<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_EXECUTION_RECEIPT_INVALID', 422)
  const item = value as Record<string, unknown>
  if (item.version !== LOCAL_EXECUTION_RECEIPT_VERSION || item.status !== 'completed'
    || !token(item.approvalId) || !token(item.executionId) || !token(item.taskId) || !token(item.nodeId)
    || !Number.isSafeInteger(item.attempt) || (item.attempt as number) < 1
    || typeof item.startedAt !== 'string' || typeof item.completedAt !== 'string'
    || !Object.prototype.hasOwnProperty.call(item, 'result')) throw new ComputeError('COMPUTE_EXECUTION_RECEIPT_INVALID', 422)
  try { timestamp(item.startedAt); timestamp(item.completedAt) } catch { throw new ComputeError('COMPUTE_EXECUTION_RECEIPT_INVALID', 422) }
  if (Date.parse(item.completedAt) < Date.parse(item.startedAt)) throw new ComputeError('COMPUTE_EXECUTION_RECEIPT_INVALID', 422)
  if (Object.prototype.hasOwnProperty.call(item, 'lease') || Object.prototype.hasOwnProperty.call(item, 'charge') || Object.prototype.hasOwnProperty.call(item, 'billing')) {
    throw new ComputeError('COMPUTE_EXECUTION_RECEIPT_INVALID', 422)
  }
  return freeze({
    version: LOCAL_EXECUTION_RECEIPT_VERSION,
    approvalId: item.approvalId,
    executionId: item.executionId,
    taskId: item.taskId,
    attempt: item.attempt as number,
    nodeId: item.nodeId,
    status: 'completed',
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    result: item.result as T,
  })
}

/** Mint a local approval from a ready route plan after an explicit owner decision. */
export function issueLocalExecutionApproval(input: LocalExecutionApprovalInput): LocalExecutionApproval {
  if (input.ownerAuthorization !== 'approved') throw new ComputeError('COMPUTE_OWNER_AUTHORIZATION_REQUIRED', 409)
  const selected = input.plan?.selected
  if (input.plan?.status !== 'ready' || selected === null || selected === undefined) throw new ComputeError('COMPUTE_ROUTE_NOT_EXECUTABLE', 409)
  if (input.plan.version !== 'qianshou.route.v1' || input.plan.intentId !== input.intentId) throw new ComputeError('COMPUTE_ROUTE_PLAN_INVALID', 422)
  const attempt = input.attempt ?? 1
  if (!token(input.approvalId) || !token(input.executionId) || !token(input.taskId) || !token(input.workflowId) || !token(input.intentId) || !token(input.idempotencyKey)) throw new ComputeError('COMPUTE_EXECUTION_APPROVAL_INVALID', 422)
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new ComputeError('COMPUTE_EXECUTION_APPROVAL_INVALID', 422)
  timestamp(input.issuedAt); timestamp(input.expiresAt)
  if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) throw new ComputeError('COMPUTE_EXECUTION_APPROVAL_INVALID', 422)
  if (!token(selected.nodeId) || !token(selected.capabilityId) || !token(selected.capabilityVersion) || !digest(selected.pluginDigest)) throw new ComputeError('COMPUTE_ROUTE_PLAN_INVALID', 422)
  return freeze({
    version: LOCAL_EXECUTION_APPROVAL_VERSION,
    approvalId: input.approvalId,
    executionId: input.executionId,
    taskId: input.taskId,
    attempt,
    workflowId: input.workflowId,
    intentId: input.intentId,
    idempotencyKey: input.idempotencyKey,
    ownerAuthorization: 'approved',
    routeStatus: 'ready',
    executionAuthorized: true,
    nodeId: selected.nodeId,
    capabilityId: selected.capabilityId,
    capabilityVersion: selected.capabilityVersion,
    pluginDigest: selected.pluginDigest,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  })
}

/** Validate an untrusted approval before any local runner is touched. */
export function parseLocalExecutionApproval(value: unknown): LocalExecutionApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (item.version !== LOCAL_EXECUTION_APPROVAL_VERSION || item.ownerAuthorization !== 'approved' || item.routeStatus !== 'ready' || item.executionAuthorized !== true
    || !token(item.approvalId) || !token(item.executionId) || !token(item.taskId) || !token(item.workflowId) || !token(item.intentId) || !token(item.idempotencyKey)
    || !Number.isSafeInteger(item.attempt) || (item.attempt as number) < 1 || !token(item.nodeId) || !token(item.capabilityId) || !token(item.capabilityVersion)
    || !digest(item.pluginDigest) || typeof item.issuedAt !== 'string' || typeof item.expiresAt !== 'string') throw invalid()
  timestamp(item.issuedAt); timestamp(item.expiresAt)
  if (Date.parse(item.expiresAt) <= Date.parse(item.issuedAt)) throw invalid()
  return freeze({ ...item, attempt: item.attempt } as LocalExecutionApproval)
}

/** Bind approval evidence to the exact local task and node. */
export function admitLocalExecution(input: {
  readonly approval: unknown
  readonly task: ComputeTaskEnvelope
  readonly now: string
  readonly localNodeId: string
  readonly pluginDigest: string
}): LocalExecutionAdmission {
  const approval = parseLocalExecutionApproval(input.approval)
  const task = parseTaskEnvelope(input.task)
  timestamp(input.now)
  if (!token(input.localNodeId) || !digest(input.pluginDigest)) throw new ComputeError('COMPUTE_LOCAL_EXECUTION_CONTEXT_INVALID', 422)
  if (Date.parse(approval.expiresAt) <= Date.parse(input.now) || Date.parse(task.deadlineAt) <= Date.parse(input.now)) throw new ComputeError('COMPUTE_EXECUTION_APPROVAL_EXPIRED', 409)
  if (String(task.taskId) !== approval.taskId || task.capabilityId !== approval.capabilityId || task.capabilityVersion !== approval.capabilityVersion || task.idempotencyKey !== approval.idempotencyKey) throw new ComputeError('COMPUTE_EXECUTION_BINDING_MISMATCH', 409)
  if (input.localNodeId !== approval.nodeId || input.pluginDigest !== approval.pluginDigest) throw new ComputeError('COMPUTE_EXECUTION_NODE_MISMATCH', 409)
  return Object.freeze({ approval, admittedAt: input.now })
}

/** Run an already-admitted local task and return a lifecycle receipt. */
export async function runAuthorizedLocalTask<T>(input: {
  readonly runner: Pick<ComputeLocalTaskRunner, 'run'>
  readonly approval: unknown
  readonly task: ComputeTaskEnvelope
  readonly request: ComputeLocalTaskRequest<T>
  readonly now: string
  readonly localNodeId: string
  readonly pluginDigest: string
  readonly completedAt?: string
}): Promise<LocalExecutionReceipt<T>> {
  const admission = admitLocalExecution({ approval: input.approval, task: input.task, now: input.now, localNodeId: input.localNodeId, pluginDigest: input.pluginDigest })
  const result = await input.runner.run(input.task, input.request)
  const completedAt = input.completedAt ?? new Date().toISOString()
  timestamp(completedAt)
  if (Date.parse(completedAt) < Date.parse(admission.admittedAt)) throw new ComputeError('COMPUTE_EXECUTION_RECEIPT_INVALID', 422)
  return Object.freeze({ version: LOCAL_EXECUTION_RECEIPT_VERSION, approvalId: admission.approval.approvalId, executionId: admission.approval.executionId, taskId: admission.approval.taskId, attempt: admission.approval.attempt, nodeId: admission.approval.nodeId, status: 'completed', startedAt: admission.admittedAt, completedAt, result })
}

function token(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function timestamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw invalid()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw invalid()
  return parsed
}
function invalid(): ComputeError { return new ComputeError('COMPUTE_EXECUTION_APPROVAL_INVALID', 422) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child) } return value }
