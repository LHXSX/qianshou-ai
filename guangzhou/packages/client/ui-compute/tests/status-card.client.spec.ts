import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId, ComputePlanId, ComputeQuoteId, ComputeTaskId } from '@deepseek-ai/dsh-compute-core/protocol'
import type { ComputeTaskState } from '@deepseek-ai/dsh-compute-core/task-state'
import { COMPUTE_TASK_CARD_PROTOCOL, parseComputeTaskCard, projectComputeTaskCard } from '../src/client/status-card.ts'

const at = '2026-09-15T12:00:00.000Z'
const capability = { id: ComputeCapabilityId('image.generate'), name: 'Image generation', description: 'local', delivery: 'local' as const, available: true }
const task = (status: ComputeTaskState['status'], progress = 0): ComputeTaskState => ({
  taskId: ComputeTaskId('task_1'), attempt: 1, envelopeFingerprint: 'a'.repeat(64), idempotencyKey: 'idem_1', status,
  leaseExpiresAt: '2026-09-15T13:00:00.000Z', progress, updatedAt: at,
})

describe('provider-neutral task card projection', () => {
  it('projects capability and parallel recommendation before pricing exists', () => {
    const card = projectComputeTaskCard({ cardId: 'plan-card-1', title: 'Make ten images', capability, parallel: { recommended: true, availableNodes: 4, rationale: 'Four compatible idle nodes.' }, updatedAt: at })
    expect(card).toMatchObject({ protocol: COMPUTE_TASK_CARD_PROTOCOL, phase: 'planning', authorization: 'not_required', submission: 'not_ready', quote: { status: 'none' }, progress: { status: 'not_started', fraction: null }, result: { status: 'none' } })
    expect(card.parallel).toEqual({ recommended: true, availableNodes: 4, rationale: 'Four compatible idle nodes.' })
    expect(Object.isFrozen(card)).toBe(true)
    expect(Object.isFrozen(card.capability)).toBe(true)
  })
  it('waits for explicit authorization of a local draft without inventing a quote', () => {
    const card = projectComputeTaskCard({
      cardId: 'plan-card-auth', title: 'Batch ten photos', capability, authorization: 'required', updatedAt: at,
    })
    expect(card).toMatchObject({
      phase: 'awaiting_authorization', authorization: 'required', submission: 'not_ready', quote: { status: 'none' },
    })
    expect(parseComputeTaskCard(card)).toBe(card)
  })
  it('shows quote and waits for explicit authorization without implying submission', () => {
    const card = projectComputeTaskCard({ cardId: 'plan-card-2', title: 'Queued', capability, quote: { id: ComputeQuoteId('quote_1'), planId: ComputePlanId('plan_1'), currency: 'CNY', amountMinor: 1200, expiresAt: '2026-09-15T12:10:00.000Z' }, updatedAt: at })
    expect(card).toMatchObject({ phase: 'awaiting_authorization', quote: { status: 'available', amountMinor: 1200 }, authorization: 'required', submission: 'not_ready' })
  })
  it('maps active and terminal task states to progress and result fields', () => {
    expect(projectComputeTaskCard({ cardId: 'task-card', title: 'Running', capability, task: task('EXECUTING', 0.45), updatedAt: at })).toMatchObject({ phase: 'running', progress: { status: 'running', fraction: 0.45 }, result: { status: 'pending' } })
    expect(projectComputeTaskCard({ cardId: 'task-card', title: 'Done', capability, task: task('SETTLED', 1), updatedAt: at })).toMatchObject({ phase: 'completed', progress: { status: 'complete', fraction: 1 }, result: { status: 'available' } })
    expect(projectComputeTaskCard({ cardId: 'task-card', title: 'Failed', capability, task: task('FAILED', 0.2), updatedAt: at })).toMatchObject({ phase: 'error', progress: { status: 'blocked' }, result: { status: 'unavailable' } })
  })
  it('keeps a returned result awaiting a core decision until settlement or failure', () => {
    const project = (status: ComputeTaskState['status']) => projectComputeTaskCard({ cardId: 'task-card', title: 'Review result', capability, task: task(status, 1), submission: 'ready', updatedAt: at })
    expect(project('RETURNED')).toMatchObject({ phase: 'returned', submission: 'submitted', progress: { status: 'waiting', fraction: 1 }, result: { status: 'available' } })
    expect(project('SETTLED')).toMatchObject({ phase: 'completed', submission: 'submitted', progress: { status: 'complete' } })
    expect(project('FAILED')).toMatchObject({ phase: 'error', result: { status: 'unavailable' } })
  })
  it.each(['PAUSED', 'OFFLINE'] as const)('preserves %s and accumulated progress without offering the task again', (status) => {
    const paused = projectComputeTaskCard({ cardId: 'task-card', title: 'Recoverable task', capability, task: task(status, 0.45), submission: 'ready', updatedAt: at })
    expect(paused).toMatchObject({ phase: status.toLowerCase(), submission: 'submitted', progress: { status: 'blocked', fraction: 0.45 }, result: { status: 'pending' } })
    expect(parseComputeTaskCard(paused)).toBe(paused)
    expect(projectComputeTaskCard({ cardId: 'task-card', title: 'Resumed', capability, task: task('EXECUTING', 0.45), updatedAt: at })).toMatchObject({ phase: 'running', submission: 'submitted' })
  })
  it('does not treat a task as new work when an older quote still says ready', () => {
    for (const status of ['OFFERED', 'ACCEPTED', 'EXECUTING', 'UPLOADING', 'RETURNED', 'SETTLED', 'PAUSED', 'OFFLINE', 'FAILED', 'REVOKED', 'EXPIRED', 'REFUSED'] as const) {
      const card = projectComputeTaskCard({ cardId: 'task-card', title: 'Existing work', capability, task: task(status), submission: 'ready', updatedAt: at })
      expect(card.submission, status).toBe('submitted')
      expect(parseComputeTaskCard(card), status).toBe(card)
    }
  })
  it('rejects malformed nested card data while preserving free-task readiness and zero boundaries', () => {
    const card = projectComputeTaskCard({ cardId: 'free-card', title: 'Free task', capability, submission: 'ready', parallel: { recommended: false, availableNodes: 0, rationale: 'No idle nodes.' }, updatedAt: at })
    expect(parseComputeTaskCard(JSON.parse(JSON.stringify(card)))).toEqual(card)
    for (const invalid of [
      { phase: 'settlement-approved' }, { authorization: 'yes' }, { submission: 'execute' },
      { capability: { ...card.capability, availability: 'online' } },
      { capability: { ...card.capability, reason: 42 } },
      { parallel: { ...card.parallel, availableNodes: -1 } },
      { parallel: { ...card.parallel, recommended: 'true' } },
      { quote: { ...card.quote, amountMinor: 500 } },
      { progress: { status: 'running', fraction: 1.01 } },
      { progress: { status: 'running', fraction: Number.NaN } },
      { result: { status: 'settled' } }, { error: { code: 'MISSING_MESSAGE' } },
    ]) expect(() => parseComputeTaskCard({ ...card, ...invalid })).toThrow('INVALID_COMPUTE_TASK_CARD')
  })
  it('rejects inconsistent cached lifecycle and quote claims', () => {
    const returned = projectComputeTaskCard({ cardId: 'task-card', title: 'Returned', capability, task: task('RETURNED', 1), updatedAt: at })
    expect(() => parseComputeTaskCard({ ...returned, submission: 'ready' })).toThrow('INVALID_COMPUTE_TASK_CARD')
    expect(() => parseComputeTaskCard({ ...returned, phase: 'completed' })).toThrow('INVALID_COMPUTE_TASK_CARD')
    const quoted = projectComputeTaskCard({ cardId: 'quote-card', title: 'Free quote', capability, quote: { id: ComputeQuoteId('quote_1'), planId: ComputePlanId('plan_1'), currency: 'CNY', amountMinor: 0, expiresAt: '2026-09-15T12:10:00.000Z' }, updatedAt: at })
    expect(parseComputeTaskCard(quoted)).toBe(quoted)
    for (const invalid of [{ status: 'expired' }, { expiresAt: at }, { expiresAt: 'not-a-date' }, { amountMinor: -1 }, { amountMinor: 0.01 }, { amountMinor: Number.MAX_SAFE_INTEGER + 1 }, { currency: 'USD' }, { quoteId: null }]) {
      expect(() => parseComputeTaskCard({ ...quoted, quote: { ...quoted.quote, ...invalid } })).toThrow('INVALID_COMPUTE_TASK_CARD')
    }
  })
  it('rejects negative node observations at the projection boundary', () => {
    expect(() => projectComputeTaskCard({ cardId: 'task-card', title: 'Invalid observation', parallel: { recommended: true, availableNodes: -1, rationale: 'Invalid count.' }, updatedAt: at })).toThrow('INVALID_COMPUTE_TASK_CARD_INPUT')
  })
  it('preserves explicit error and rejects malformed card payloads', () => {
    const card = projectComputeTaskCard({ cardId: 'error-card', title: 'Error', capability: { ...capability, available: false, unavailableReason: 'offline' }, error: { code: 'NODE_OFFLINE', message: 'No compatible node' }, updatedAt: at })
    expect(card).toMatchObject({ phase: 'error', error: { code: 'NODE_OFFLINE' }, capability: { availability: 'unavailable', reason: 'offline' } })
    expect(parseComputeTaskCard(card)).toBe(card)
    expect(() => parseComputeTaskCard({ ...card, protocol: 'other' })).toThrow('INVALID_COMPUTE_TASK_CARD')
  })
})
