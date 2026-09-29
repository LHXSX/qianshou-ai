import { describe, expect, it } from 'vitest'
import { planAgentRoute, type AgentRouterIntent } from '../src/agent-router.ts'
import { LOCAL_EXECUTION_RECEIPT_VERSION } from '../src/local-execution-admission.ts'
import { projectPcTaskSurface } from '../src/pc-task-surface.ts'

const intent = (overrides: Partial<AgentRouterIntent> = {}): AgentRouterIntent => ({
  version: 'qianshou.agent-router.v1', intentId: 'intent-1', interaction: 'realtime', complexity: 'simple', privacy: 'private', network: 'online', requiresCrossApp: false,
  requiredCapabilities: ['intent.classify'], localAvailable: true, cloudAvailable: true, cloudAuthorization: 'pending', allowLocalFallback: false,
  ...overrides,
})

const receipt = {
  version: LOCAL_EXECUTION_RECEIPT_VERSION, approvalId: 'approval-1', executionId: 'execution-1', taskId: 'task-1', attempt: 1, nodeId: 'node-1', status: 'completed',
  startedAt: '2026-09-22T00:00:00.000Z', completedAt: '2026-09-22T00:00:01.000Z', result: { ref: 'artifact://task-1' },
}

describe('PC task surface', () => {
  it('keeps a private local path waiting for the owner and does not authorize execution', () => {
    const surface = projectPcTaskSurface({ decision: planAgentRoute({ intent: intent() }), ownerAuthorization: 'pending' })
    expect(surface).toMatchObject({ version: 'qianshou.pc-task-surface.v1', path: 'local', phase: 'awaiting-owner', nextAction: 'confirm-owner', executionAuthorized: false, dispatchable: false, receipt: null })
  })

  it('offers local admission only after the owner approves, still without an execution grant', () => {
    const surface = projectPcTaskSurface({ decision: planAgentRoute({ intent: intent() }), ownerAuthorization: 'approved' })
    expect(surface).toMatchObject({ path: 'local', phase: 'local-preview', nextAction: 'admit-local', executionAuthorized: false, dispatchable: false, receipt: null })
  })

  it('projects an approved complex cloud path as a hand-off and refuses a local receipt', () => {
    const decision = planAgentRoute({ intent: intent({ complexity: 'complex', requiresCrossApp: true, privacy: 'shared', cloudAuthorization: 'approved' }) })
    const surface = projectPcTaskSurface({ decision, ownerAuthorization: 'approved' })
    expect(surface).toMatchObject({ path: 'cloud', phase: 'cloud-preview', nextAction: 'hand-off-cloud', executionAuthorized: false, dispatchable: false, receipt: null })
    expect(surface.reasons).toContain('CLOUD_REQUIRED_FOR_CROSS_APP')
    expect(() => projectPcTaskSurface({ decision, ownerAuthorization: 'approved', taskId: 'task-1', receipt })).toThrow('COMPUTE_PC_TASK_SURFACE_RECEIPT_MISMATCH')
  })

  it('holds a cloud preview when the owner gate is no longer approved', () => {
    const decision = planAgentRoute({ intent: intent({ complexity: 'complex', privacy: 'shared', cloudAuthorization: 'approved' }) })
    expect(projectPcTaskSurface({ decision, ownerAuthorization: 'denied' })).toMatchObject({ path: 'cloud', phase: 'awaiting-owner', nextAction: 'confirm-owner', executionAuthorized: false })
  })

  it('asks the owner and defers offline work without a receipt', () => {
    expect(projectPcTaskSurface({
      decision: planAgentRoute({ intent: intent({ complexity: 'complex', requiresCrossApp: true, privacy: 'shared' }) }),
      ownerAuthorization: 'pending',
    })).toMatchObject({ path: 'ask_user', phase: 'awaiting-owner', nextAction: 'confirm-owner' })
    expect(projectPcTaskSurface({
      decision: planAgentRoute({ intent: intent({ network: 'offline', localAvailable: false }) }),
      ownerAuthorization: 'unavailable',
    })).toMatchObject({ path: 'defer', phase: 'deferred', nextAction: 'wait', executionAuthorized: false })
  })

  it('shows a bound local receipt without its result payload', () => {
    const surface = projectPcTaskSurface({ decision: planAgentRoute({ intent: intent() }), ownerAuthorization: 'approved', taskId: 'task-1', receipt })
    expect(surface).toMatchObject({ phase: 'local-observed', nextAction: 'none', executionAuthorized: false, receipt: { taskId: 'task-1', nodeId: 'node-1', status: 'completed' } })
    expect(surface.receipt).not.toHaveProperty('result')
    expect(() => projectPcTaskSurface({ decision: planAgentRoute({ intent: intent() }), ownerAuthorization: 'pending', taskId: 'task-1', receipt })).toThrow('COMPUTE_PC_TASK_SURFACE_RECEIPT_MISMATCH')
    expect(() => projectPcTaskSurface({ decision: planAgentRoute({ intent: intent() }), ownerAuthorization: 'approved', taskId: 'other-task', receipt })).toThrow('COMPUTE_PC_TASK_SURFACE_RECEIPT_MISMATCH')
  })

  it('rejects a forged execution grant and a receipt that carries a lease', () => {
    const decision = { ...planAgentRoute({ intent: intent() }), executionAuthorized: true }
    expect(() => projectPcTaskSurface({ decision, ownerAuthorization: 'approved' })).toThrow('COMPUTE_PC_TASK_SURFACE_INVALID')
    expect(() => projectPcTaskSurface({
      decision: planAgentRoute({ intent: intent() }), ownerAuthorization: 'approved', taskId: 'task-1', receipt: { ...receipt, lease: 'lease-1' },
    })).toThrow('COMPUTE_EXECUTION_RECEIPT_INVALID')
  })
})
