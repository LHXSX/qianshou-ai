import { describe, expect, it } from 'vitest'
import {
  planRoute,
  QIANSHOU_INTENT_VERSION,
  type RouterIntent,
  type RouterNodeOffer,
} from '../src/router.ts'

const NOW = '2026-09-20T10:00:00.000Z'
const DIGEST = 'a'.repeat(64)

function intent(overrides: Partial<RouterIntent> = {}): RouterIntent {
  return {
    version: QIANSHOU_INTENT_VERSION,
    intentId: 'intent-1',
    capabilityId: 'image.generate',
    requiredModelIds: ['h3', 'z-ming'],
    dataScope: 'task-inputs',
    privacy: 'private',
    ownerAuthorization: 'approved',
    budgetMinor: 1000,
    currency: 'CNY',
    deadlineAt: '2026-09-20T10:05:00.000Z',
    idempotencyKey: 'idem-1',
    ...overrides,
  }
}

function offer(overrides: Partial<RouterNodeOffer> = {}): RouterNodeOffer {
  return {
    offerId: 'offer-win-gpu-1',
    nodeId: 'win-gpu-1',
    capabilityId: 'image.generate',
    capabilityVersion: '1.0.0',
    pluginDigest: DIGEST,
    health: 'ok',
    available: true,
    ownerAuthorized: true,
    platform: 'win32',
    modelIds: ['h3', 'z-ming'],
    vramBytes: 24 * 1024 ** 3,
    dataScopes: ['task-inputs'],
    privacy: 'private',
    queueDepth: 0,
    maxConcurrency: 2,
    runningTasks: 0,
    estimatedLatencyMs: 5000,
    priceMinor: 300,
    currency: 'CNY',
    successRate: 0.98,
    observedAt: NOW,
    expiresAt: '2026-09-20T10:01:00.000Z',
    ...overrides,
  }
}

describe('planRoute', () => {
  it('selects a private owner-authorized H3/z-ming node and exposes a stable score', () => {
    const result = planRoute({ now: NOW, intent: intent(), offers: [offer()] })
    expect(result.status).toBe('ready')
    expect(result.selected?.nodeId).toBe('win-gpu-1')
    expect(result.selected?.score).toBeGreaterThan(0)
    expect(result.selected?.scoreBreakdown.privacy).toBe(1000)
  })

  it('fails closed for pending owner approval without inspecting offers', () => {
    const result = planRoute({ now: NOW, intent: intent({ ownerAuthorization: 'pending' }), offers: [offer()] })
    expect(result.status).toBe('awaiting-authorization')
    expect(result.selected).toBeNull()
  })

  it('keeps rejection reasons for capability, model, privacy and budget failures', () => {
    const result = planRoute({
      now: NOW,
      intent: intent(),
      offers: [
        offer({ nodeId: 'wrong-cap', capabilityId: 'llm.generate.local' }),
        offer({ nodeId: 'wrong-model', modelIds: ['h3'] }),
        offer({ nodeId: 'shared-node', privacy: 'shared' }),
        offer({ nodeId: 'expensive', priceMinor: 1001 }),
      ],
    })
    expect(result.status).toBe('no-route')
    expect(result.rejections.map(item => item.code)).toEqual([
      'CAPABILITY_MISMATCH',
      'MODEL_UNAVAILABLE',
      'PRIVACY_MISMATCH',
      'BUDGET_EXCEEDED',
    ])
  })

  it('ranks healthy low-latency offers deterministically and bounds candidates', () => {
    const result = planRoute({
      now: NOW,
      intent: intent({ requiredModelIds: [] }),
      offers: [offer({ nodeId: 'slow', estimatedLatencyMs: 30_000 }), offer({ nodeId: 'fast', estimatedLatencyMs: 1_000 })],
      maxCandidates: 1,
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.selected?.nodeId).toBe('fast')
  })

  it('returns expired before considering a live offer', () => {
    const result = planRoute({
      now: '2026-09-20T10:06:00.000Z',
      intent: intent(),
      offers: [offer()],
    })
    expect(result.status).toBe('expired')
  })

  it('rejects malformed untrusted offer data with a stable code', () => {
    expect(() => planRoute({ now: NOW, intent: intent(), offers: [{ ...offer(), modelIds: undefined } as never] })).toThrow('COMPUTE_ROUTE_OFFER_INVALID')
  })
})
