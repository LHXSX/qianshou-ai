/** One PC task card for a device-first route preview and an optional local receipt.
 *
 * The card is a projection. It does not call a model, open a lease, charge an
 * account, or authorize a runner. `executionAuthorized` and `dispatchable`
 * stay false so a cloud hand-off or an owner gate cannot be replayed as a grant.
 */
import { ComputeError } from './errors.ts'
import { AGENT_ROUTER_VERSION, type AgentRouterPath, type AgentRouterReasonCode } from './agent-router.ts'
import { parseLocalExecutionReceipt } from './local-execution-admission.ts'

export const PC_TASK_SURFACE_VERSION = 'qianshou.pc-task-surface.v1' as const

export type PcTaskPhase = 'awaiting-owner' | 'local-preview' | 'cloud-preview' | 'deferred' | 'local-observed'
export type PcTaskNextAction = 'confirm-owner' | 'admit-local' | 'hand-off-cloud' | 'wait' | 'none'
export type PcOwnerGate = 'unavailable' | 'pending' | 'approved' | 'denied'

export interface PcTaskReceiptView {
  readonly taskId: string
  readonly nodeId: string
  readonly status: 'completed'
}

export interface PcTaskSurface {
  readonly version: typeof PC_TASK_SURFACE_VERSION
  readonly intentId: string
  readonly path: AgentRouterPath
  readonly phase: PcTaskPhase
  readonly executionAuthorized: false
  readonly dispatchable: false
  readonly reasons: readonly AgentRouterReasonCode[]
  readonly nextAction: PcTaskNextAction
  readonly receipt: PcTaskReceiptView | null
}

const REASONS = new Set<AgentRouterReasonCode>([
  'LOCAL_PREFERRED_FOR_REALTIME', 'LOCAL_PREFERRED_FOR_PRIVACY', 'LOCAL_SELECTED_OFFLINE',
  'CLOUD_REQUIRED_FOR_COMPLEXITY', 'CLOUD_REQUIRED_FOR_CROSS_APP', 'CLOUD_AUTHORIZATION_REQUIRED',
  'CLOUD_UNAVAILABLE', 'LOCAL_UNAVAILABLE', 'NETWORK_UNAVAILABLE', 'LOCAL_FALLBACK_SELECTED',
  'NETWORK_DEGRADED', 'USER_DECISION_REQUIRED', 'NO_EXECUTION_PATH',
])

/**
 * Project one device-first decision onto the shared PC task card.
 * @param input - Untrusted route decision, the current owner gate, and an optional local receipt.
 * @returns A frozen card. An approved gate selects the next action only.
 */
export function projectPcTaskSurface(input: {
  readonly decision: unknown
  readonly ownerAuthorization: PcOwnerGate
  readonly taskId?: string
  readonly receipt?: unknown
}): PcTaskSurface {
  const decision = parseDecision(input.decision)
  if (!['unavailable', 'pending', 'approved', 'denied'].includes(input.ownerAuthorization)) throw invalid()
  const approved = input.ownerAuthorization === 'approved'
  const base = {
    version: PC_TASK_SURFACE_VERSION,
    intentId: decision.intentId,
    path: decision.path,
    executionAuthorized: false as const,
    dispatchable: false as const,
    reasons: decision.reasons,
  }
  if (decision.path === 'defer') {
    if (input.receipt !== undefined) throw mismatch()
    return freeze({ ...base, phase: 'deferred', nextAction: 'wait', receipt: null })
  }
  if (decision.path === 'ask_user') {
    if (input.receipt !== undefined) throw mismatch()
    return freeze({ ...base, phase: 'awaiting-owner', nextAction: 'confirm-owner', receipt: null })
  }
  if (decision.path === 'cloud') {
    if (input.receipt !== undefined) throw mismatch()
    return freeze(approved
      ? { ...base, phase: 'cloud-preview', nextAction: 'hand-off-cloud', receipt: null }
      : { ...base, phase: 'awaiting-owner', nextAction: 'confirm-owner', receipt: null })
  }
  if (!approved) {
    if (input.receipt !== undefined) throw mismatch()
    return freeze({ ...base, phase: 'awaiting-owner', nextAction: 'confirm-owner', receipt: null })
  }
  if (input.receipt === undefined) return freeze({ ...base, phase: 'local-preview', nextAction: 'admit-local', receipt: null })
  const receipt = parseLocalExecutionReceipt(input.receipt)
  if (!token(input.taskId) || receipt.taskId !== input.taskId) throw mismatch()
  return freeze({
    ...base,
    phase: 'local-observed',
    nextAction: 'none',
    receipt: { taskId: receipt.taskId, nodeId: receipt.nodeId, status: 'completed' },
  })
}

function parseDecision(value: unknown): { intentId: string; path: AgentRouterPath; reasons: readonly AgentRouterReasonCode[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (item.version !== AGENT_ROUTER_VERSION || item.executionAuthorized !== false || !token(item.intentId)) throw invalid()
  if (item.lease !== undefined || item.charge !== undefined || item.billing !== undefined) throw invalid()
  if (!Array.isArray(item.reasons) || item.reasons.some(reason => typeof reason !== 'string' || !REASONS.has(reason as AgentRouterReasonCode))) throw invalid()
  const path = item.path
  const status = item.status
  const target = item.target
  const consistent = (path === 'local' && status === 'ready' && target === 'local')
    || (path === 'cloud' && status === 'ready' && target === 'cloud')
    || (path === 'ask_user' && status === 'awaiting-authorization' && target === null)
    || (path === 'defer' && status === 'no-route' && target === null)
  if (!consistent) throw invalid()
  return { intentId: item.intentId, path, reasons: Object.freeze([...item.reasons]) as readonly AgentRouterReasonCode[] }
}

function token(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) }
function invalid(): ComputeError { return new ComputeError('COMPUTE_PC_TASK_SURFACE_INVALID', 422) }
function mismatch(): ComputeError { return new ComputeError('COMPUTE_PC_TASK_SURFACE_RECEIPT_MISMATCH', 409) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  }
  return value
}
