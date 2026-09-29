import { describe, expect, it } from 'vitest'
import { COMMERCE_IMAGE_WORKFLOW_VERSION, planCommerceImageWorkflow } from '../src/commerce-image-workflow.ts'
import type { RouterNodeOffer } from '../src/router.ts'

const offer: RouterNodeOffer = {
  offerId: 'offer-commerce', nodeId: 'win-commerce', capabilityId: 'image.generate', capabilityVersion: '1.0.0', pluginDigest: 'a'.repeat(64),
  health: 'ok', available: true, ownerAuthorized: true, platform: 'win32', modelIds: ['z-image-test-only'], vramBytes: 24 * 1024 ** 3, dataScopes: ['task-inputs'], privacy: 'private',
  queueDepth: 0, maxConcurrency: 1, runningTasks: 0, estimatedLatencyMs: 10_000, priceMinor: 300, currency: 'CNY', successRate: 0.9,
  observedAt: '2026-09-20T10:00:00.000Z', expiresAt: '2026-09-20T10:05:00.000Z',
}

describe('commerce image workflow', () => {
  const input = { workflowId: 'commerce-1', intentId: 'intent-commerce-1', now: '2026-09-20T10:00:00.000Z',
    deadlineAt: '2026-09-20T10:04:00.000Z', budgetMinor: 1000, currency: 'CNY' as const,
    ownerAuthorization: 'approved' as const, privacy: 'private' as const,
    requiredModelIds: ['z-image-test-only'], offers: [offer] }

  it('routes a node with only the reviewed image model and never authorizes execution', () => {
    const result = planCommerceImageWorkflow(input)
    expect(result.version).toBe(COMMERCE_IMAGE_WORKFLOW_VERSION)
    expect(result.version).toBe('qianshou.workflow.commerce-image.v2')
    expect(result.steps[0]?.requiredModelIds).toEqual(['z-image-test-only'])
    expect(result.status).toBe('ready')
    expect(result.steps[0]?.plan.selected?.nodeId).toBe('win-commerce')
    expect(result.executionAuthorized).toBe(false)
  })

  it('refuses an offer missing one model required by a different reviewed recipe', () => {
    const result = planCommerceImageWorkflow({ ...input, requiredModelIds: ['z-image-test-only', 'other-model'] })
    expect(result.status).toBe('no-route')
    expect(result.steps[0]?.plan.rejections[0]?.code).toBe('MODEL_UNAVAILABLE')
  })

  it('preserves pending owner authorization as a non-executing state', () => {
    const result = planCommerceImageWorkflow({ ...input, ownerAuthorization: 'pending' })
    expect(result.status).toBe('awaiting-authorization')
    expect(result.executionAuthorized).toBe(false)
  })

  it('rejects absent, empty, malformed, duplicated or excessive recipe model requirements', () => {
    for (const requiredModelIds of [undefined, [], ['bad model'], ['z-image-test-only', 'z-image-test-only'],
      Array.from({ length: 17 }, (_, index) => `model-${index}`)]) {
      expect(() => planCommerceImageWorkflow({ ...input, requiredModelIds } as typeof input))
        .toThrow('COMPUTE_COMMERCE_WORKFLOW_INVALID')
    }
  })

  it('keeps the route preview tied to a snapshot of the recipe models', () => {
    const requiredModelIds = ['z-image-test-only']
    const result = planCommerceImageWorkflow({ ...input, requiredModelIds })
    requiredModelIds.push('other-model')
    expect(result.steps[0]?.requiredModelIds).toEqual(['z-image-test-only'])
  })
})
