import { describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId } from '@deepseek-ai/dsh-compute-core/protocol'
import { projectComputeTaskCard } from '@deepseek-ai/dsh-client-ui-compute/client/status-card'
import { MOBILE_SYNC_VERSION, type MobileCapabilityHeartbeat } from '@deepseek-ai/dsh-host-platform-observability-contract'
import type { PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'
import { MobileAgentShell, type MobileAuthPort } from '../src/index.ts'

const at = '2026-09-15T02:03:04.000Z'
const identity: PlatformIdentity = { kind: 'agent', id: 'agent-mobile' as never }
const capability = { capabilityId: ComputeCapabilityId('image.generate'), version: '1.0.0', pluginDigest: 'a'.repeat(64), available: true }

function auth(state: MobileAuthPort['state'] extends () => infer S ? S : never = 'authenticated'): MobileAuthPort {
  return { methods: [{ id: 'oauth', label: 'Sign in' }], state: () => state, begin: vi.fn(), logout: vi.fn() }
}

function shell(overrides: Partial<ConstructorParameters<typeof MobileAgentShell>[0]> = {}): MobileAgentShell {
  return new MobileAgentShell({
    identity, platform: 'ios', agentVersion: '1.0.0', maxConcurrency: 2,
    auth: auth(), capabilities: () => [capability], sync: { sync: vi.fn() },
    policy: { enabled: true, requireForeground: true, maxConcurrentTasks: 1, acceptWithoutQuote: true },
    now: () => at, ...overrides,
  })
}

function card(overrides: Partial<Parameters<typeof projectComputeTaskCard>[0]> = {}): ReturnType<typeof projectComputeTaskCard> {
  return projectComputeTaskCard({ cardId: 'card-1', title: 'Generate', capability: { id: capability.capabilityId, name: 'Image', description: 'image', delivery: 'contributor', available: true }, submission: 'ready', updatedAt: at, ...overrides })
}

describe('MobileAgentShell', () => {
  it('builds an autonomous heartbeat from capabilities and OS state', () => {
    const instance = shell()
    const heartbeat = instance.createHeartbeat()
    expect(heartbeat).toMatchObject({ version: MOBILE_SYNC_VERSION, platform: 'ios', sequence: 1, surface: 'foreground', acceptance: 'autonomous', runningTasks: 0, cursor: 'start' })
    expect(Object.isFrozen(heartbeat)).toBe(true)
    expect(Object.isFrozen(heartbeat.capabilities[0])).toBe(true)
  })

  it('holds background and unauthenticated cards under explicit policy', () => {
    const instance = shell()
    instance.setSurface('background')
    expect(instance.receiveTaskCard(card())).toEqual({ cardId: 'card-1', disposition: 'hold', reason: 'background' })
    const signedOut = shell({ auth: auth('signed-out') })
    expect(signedOut.receiveTaskCard(card())).toEqual({ cardId: 'card-1', disposition: 'hold', reason: 'auth-required' })
  })

  it('accepts a policy-approved card without invoking execution or push APIs', () => {
    const instance = shell()
    expect(instance.receiveTaskCard(card())).toEqual({ cardId: 'card-1', disposition: 'accept', reason: 'accepted' })
    expect(instance.snapshot().lastDecision?.disposition).toBe('accept')
  })

  it('requires authorization for quoted cards and enforces capacity', () => {
    const quoted = card({ quote: { id: 'quote-1' as never, planId: 'plan-1' as never, currency: 'CNY', amountMinor: 10, expiresAt: '2026-09-15T03:00:00.000Z' } })
    const instance = shell()
    expect(instance.receiveTaskCard(quoted)).toEqual({ cardId: 'card-1', disposition: 'hold', reason: 'authorization-required' })
    const accepted = shell()
    accepted.markTaskStarted()
    expect(accepted.receiveTaskCard(card())).toEqual({ cardId: 'card-1', disposition: 'hold', reason: 'at-capacity' })
    expect(() => { accepted.markTaskStarted() }).toThrow('MOBILE_TASK_CAPACITY_REACHED')
    accepted.markTaskFinished()
    expect(() => { accepted.markTaskFinished() }).toThrow('MOBILE_TASK_NOT_RUNNING')
  })

  it('syncs through a supplied adapter and rejects a stale or foreign acknowledgement', async () => {
    const instance = shell()
    const heartbeat: MobileCapabilityHeartbeat = { ...instance.createHeartbeat(), sequence: 1 }
    const sync = vi.fn(async () => ({ version: MOBILE_SYNC_VERSION, identity, cursor: 'cursor-2', revision: 2, heartbeat }))
    const connected = shell({ sync: { sync } })
    await expect(connected.sync(20)).resolves.toMatchObject({ cursor: 'cursor-2', revision: 2 })
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'start', limit: 20 }), expect.objectContaining({ sequence: 1 }))
    const foreign = shell({ sync: { sync: vi.fn(async () => ({ version: MOBILE_SYNC_VERSION, identity: { kind: 'agent', id: 'other' }, cursor: 'c', revision: 1, heartbeat })) } })
    await expect(foreign.sync(20)).rejects.toThrow('MOBILE_SYNC_ACK_STALE')
  })
})
