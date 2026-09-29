import { describe, expect, it } from 'vitest'
import { planAgentRoute, type AgentRouterIntent } from '../src/agent-router.ts'

const intent = (overrides: Partial<AgentRouterIntent> = {}): AgentRouterIntent => ({
  version: 'qianshou.agent-router.v1', intentId: 'intent-1', interaction: 'realtime', complexity: 'simple', privacy: 'private', network: 'online', requiresCrossApp: false,
  requiredCapabilities: ['intent.classify'], localModelIds: ['edge-3b'], localAvailable: true, cloudAvailable: true, cloudAuthorization: 'pending', allowLocalFallback: false,
  ...overrides,
})

describe('device-first Agent Router', () => {
  it('keeps simple private realtime work local and never authorizes execution', () => {
    const decision = planAgentRoute({ intent: intent() })
    expect(decision).toMatchObject({ path: 'local', target: 'local', status: 'ready', executionAuthorized: false })
    expect(decision.reasons).toContain('LOCAL_PREFERRED_FOR_REALTIME')
  })

  it('sends approved complex cross-app work to cloud as a hand-off target', () => {
    const decision = planAgentRoute({ intent: intent({ complexity: 'complex', requiresCrossApp: true, privacy: 'shared', cloudAuthorization: 'approved' }) })
    expect(decision).toMatchObject({ path: 'cloud', target: 'cloud', status: 'ready', fallbackTarget: 'local', executionAuthorized: false })
    expect(decision.reasons).toContain('CLOUD_REQUIRED_FOR_CROSS_APP')
  })

  it('asks the owner before sending complex work to cloud', () => {
    const decision = planAgentRoute({ intent: intent({ complexity: 'complex', requiresCrossApp: true, privacy: 'shared' }) })
    expect(decision).toMatchObject({ path: 'ask_user', target: null, status: 'awaiting-authorization' })
    expect(decision.reasons).toContain('USER_DECISION_REQUIRED')
  })

  it('uses local execution offline and defers when no local runtime exists', () => {
    expect(planAgentRoute({ intent: intent({ network: 'offline' }) })).toMatchObject({ path: 'local', target: 'local' })
    expect(planAgentRoute({ intent: intent({ network: 'offline', localAvailable: false }) })).toMatchObject({ path: 'defer', target: null, status: 'no-route' })
  })

  it('allows an explicit local fallback when cloud is unavailable', () => {
    const decision = planAgentRoute({ intent: intent({ complexity: 'complex', privacy: 'shared', cloudAvailable: false, allowLocalFallback: true }) })
    expect(decision).toMatchObject({ path: 'local', target: 'local', status: 'ready' })
    expect(decision.reasons).toContain('LOCAL_FALLBACK_SELECTED')
  })

  it('rejects malformed intent metadata', () => {
    expect(() => planAgentRoute({ intent: intent({ version: 'wrong' as AgentRouterIntent['version'] }) })).toThrow('COMPUTE_AGENT_ROUTER_INTENT_INVALID')
  })
})
