import { describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { planRoute, type RouterNodeOffer } from '../src/router.ts'
import { admitLocalExecution, issueLocalExecutionApproval, parseLocalExecutionApproval, parseLocalExecutionReceipt, runAuthorizedLocalTask } from '../src/local-execution-admission.ts'

const now = '2026-09-21T00:00:00.000Z'
const expires = '2026-09-21T00:10:00.000Z'
const digest = 'a'.repeat(64)
const offer: RouterNodeOffer = {
  offerId: 'offer-h3-zming', nodeId: 'mac-owner-1', capabilityId: 'image.generate', capabilityVersion: '1.0.0', pluginDigest: digest,
  modelIds: ['h3', 'z-ming'], platform: 'darwin-arm64', vramBytes: 16 * 1024 ** 3, dataScopes: ['task-inputs'], privacy: 'private', health: 'ok', available: true, ownerAuthorized: true,
  observedAt: now, expiresAt: expires, runningTasks: 0, queueDepth: 0, maxConcurrency: 1, estimatedLatencyMs: 1000, priceMinor: 0, currency: 'CNY', successRate: 1,
}
const plan = planRoute({
  now,
  intent: { version: 'qianshou.intent.v1', intentId: 'intent-commerce-1', capabilityId: 'image.generate', requiredModelIds: ['h3', 'z-ming'], dataScope: 'task-inputs', privacy: 'private', ownerAuthorization: 'approved', budgetMinor: 0, currency: 'CNY', deadlineAt: expires, idempotencyKey: 'workflow-commerce-1' },
  offers: [offer],
})
const task: ComputeTaskEnvelope = {
  version: 'qianshou.task.v1', taskId: ComputeTaskId('task-commerce-1'), capabilityId: ComputeCapabilityId('image.generate'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'product' }, deadlineAt: expires, maxOutputBytes: 1024, idempotencyKey: 'workflow-commerce-1',
}

describe('local execution admission', () => {
  it('requires a ready route and explicit owner approval before minting an approval', () => {
    expect(() => issueLocalExecutionApproval({ plan, ownerAuthorization: 'pending', approvalId: 'approval-1', executionId: 'execution-1', taskId: 'task-commerce-1', workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1', idempotencyKey: 'workflow-commerce-1', issuedAt: now, expiresAt: expires })).toThrow('COMPUTE_OWNER_AUTHORIZATION_REQUIRED')
    expect(() => issueLocalExecutionApproval({ plan: { ...plan, status: 'no-route', selected: null }, ownerAuthorization: 'approved', approvalId: 'approval-1', executionId: 'execution-1', taskId: 'task-commerce-1', workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1', idempotencyKey: 'workflow-commerce-1', issuedAt: now, expiresAt: expires })).toThrow('COMPUTE_ROUTE_NOT_EXECUTABLE')
  })

  it('binds the approval to the task, node and plugin digest', () => {
    const approval = issueLocalExecutionApproval({ plan, ownerAuthorization: 'approved', approvalId: 'approval-1', executionId: 'execution-1', taskId: 'task-commerce-1', workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1', idempotencyKey: 'workflow-commerce-1', issuedAt: now, expiresAt: expires })
    expect(parseLocalExecutionApproval(approval)).toEqual(approval)
    expect(admitLocalExecution({ approval, task, now: '2026-09-21T00:01:00.000Z', localNodeId: 'mac-owner-1', pluginDigest: digest }).approval.executionAuthorized).toBe(true)
    expect(() => admitLocalExecution({ approval, task, now, localNodeId: 'other-node', pluginDigest: digest })).toThrow('COMPUTE_EXECUTION_NODE_MISMATCH')
    expect(() => parseLocalExecutionApproval({ ...approval, executionAuthorized: false })).toThrow('COMPUTE_EXECUTION_APPROVAL_INVALID')
  })

  it('runs only after admission and returns a result receipt without paths or lease side effects', async () => {
    const approval = issueLocalExecutionApproval({ plan, ownerAuthorization: 'approved', approvalId: 'approval-1', executionId: 'execution-1', taskId: 'task-commerce-1', workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1', idempotencyKey: 'workflow-commerce-1', issuedAt: now, expiresAt: expires })
    const run = vi.fn(async () => ({ artifactRef: `sha256:${'b'.repeat(64)}` }))
    const receipt = await runAuthorizedLocalTask({ runner: { run: <T>() => run() as Promise<T> }, approval, task, request: {} as never, now: '2026-09-21T00:01:00.000Z', completedAt: '2026-09-21T00:02:00.000Z', localNodeId: 'mac-owner-1', pluginDigest: digest })
    expect(run).toHaveBeenCalledOnce()
    expect(receipt).toMatchObject({ version: 'qianshou.local-execution-receipt.v1', status: 'completed', taskId: 'task-commerce-1', nodeId: 'mac-owner-1', result: { artifactRef: expect.stringMatching(/^sha256:/u) } })
    expect(JSON.stringify(receipt)).not.toContain('lease')
    expect(parseLocalExecutionReceipt(receipt)).toEqual(receipt)
    expect(() => parseLocalExecutionReceipt({ ...receipt, lease: { id: 'should-not-cross' } })).toThrow('COMPUTE_EXECUTION_RECEIPT_INVALID')
    expect(() => parseLocalExecutionReceipt({ ...receipt, completedAt: '2026-09-21T00:01:00.000Z' })).not.toThrow()
  })

  it('refuses expired approval before touching the runner', async () => {
    const approval = issueLocalExecutionApproval({ plan, ownerAuthorization: 'approved', approvalId: 'approval-1', executionId: 'execution-1', taskId: 'task-commerce-1', workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1', idempotencyKey: 'workflow-commerce-1', issuedAt: now, expiresAt: expires })
    const run = vi.fn(async () => 'should-not-run')
    await expect(runAuthorizedLocalTask({ runner: { run: <T>() => run() as Promise<T> }, approval, task, request: {} as never, now: expires, localNodeId: 'mac-owner-1', pluginDigest: digest })).rejects.toThrow('COMPUTE_EXECUTION_APPROVAL_EXPIRED')
    expect(run).not.toHaveBeenCalled()
  })

  it('validates the task envelope before touching the runner', async () => {
    const approval = issueLocalExecutionApproval({ plan, ownerAuthorization: 'approved', approvalId: 'approval-1', executionId: 'execution-1', taskId: 'task-commerce-1', workflowId: 'workflow-commerce-1', intentId: 'intent-commerce-1', idempotencyKey: 'workflow-commerce-1', issuedAt: now, expiresAt: expires })
    const run = vi.fn(async () => 'should-not-run')
    await expect(runAuthorizedLocalTask({ runner: { run: <T>() => run() as Promise<T> }, approval, task: { ...task, deadlineAt: 'bad' } as ComputeTaskEnvelope, request: {} as never, now: '2026-09-21T00:01:00.000Z', localNodeId: 'mac-owner-1', pluginDigest: digest })).rejects.toThrow('INVALID_COMPUTE_FIELD: deadlineAt')
    expect(run).not.toHaveBeenCalled()
  })
})
