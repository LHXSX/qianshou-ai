/**
 * Wire-boundary coverage: a response is published only when every field is
 * present, well-typed, and consistent with the state definitions the Host
 * controller derives. An unknown activity fact must survive as `null`.
 */
import { describe, expect, it } from 'vitest'
import { hostError, INVALID_SUPPLY_RESPONSE, parsePolicy, parseSupplySnapshot } from '../src/client/wire.ts'
import { blockedJson } from './fixtures.client.ts'

const clone = (value: unknown = blockedJson): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>

function rejected(mutate: (value: Record<string, unknown>) => void): boolean {
  const value = clone()
  mutate(value)
  try { parseSupplySnapshot(value); return false }
  catch (error) { return error instanceof Error && error.message === INVALID_SUPPLY_RESPONSE }
}

describe('supply snapshot wire contract', () => {
  it('accepts a real observation and publishes fresh frozen objects', () => {
    const snapshot = parseSupplySnapshot({ ...clone(), unexpected: 'dropped' })
    expect(snapshot.version).toBe('qianshou.local-supply.v1')
    expect(snapshot.eligibility.state).toBe('blocked')
    expect(snapshot.activity).toEqual({ idleSeconds: 12, foregroundTaskActive: true, voiceActive: null })
    expect(snapshot.ownerPolicy.nodeRates).toEqual([
      { localServiceId: 'tool-ffmpeg', amountMinor: 250, unit: 'per-image', currency: 'CNY' },
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.ownerPolicy.enabledServiceIds)).toBe(true)
    expect(Object.isFrozen(snapshot.hardware.gpus)).toBe(true)
    expect('unexpected' in snapshot).toBe(false)
    expect('unexpected' in snapshot.hardware).toBe(false)
  })

  it('keeps every unknown activity fact unknown instead of defaulting it', () => {
    const snapshot = parseSupplySnapshot(clone())
    expect(snapshot.activity.voiceActive).toBeNull()
    expect(snapshot.activity.voiceActive).not.toBe(false)
    expect(snapshot.hardware.gpus[0]?.memoryBytes).toBeNull()
  })

  it.each([
    ['version', (value: Record<string, unknown>) => { value.version = 'qianshou.local-supply.v2' }],
    ['observedAt', (value: Record<string, unknown>) => { value.observedAt = '2026-09-15 10:00' }],
    ['observedAt offset', (value: Record<string, unknown>) => { value.observedAt = '2026-09-15T10:00:00.000+08:00' }],
    ['observedAt impossible calendar date', (value: Record<string, unknown>) => { value.observedAt = '2026-13-45T99:99:99.000Z' }],
    ['eligibility', (value: Record<string, unknown>) => { value.eligibility = null }],
    ['eligibility.state', (value: Record<string, unknown>) => { (value.eligibility as Record<string, unknown>).state = 'idle' }],
    ['eligibility.reasons', (value: Record<string, unknown>) => { (value.eligibility as Record<string, unknown>).reasons = 'OWNER_DISABLED' }],
    ['empty reason code', (value: Record<string, unknown>) => { (value.eligibility as Record<string, unknown>).reasons = [''] }],
    ['control character in a reason', (value: Record<string, unknown>) => { (value.eligibility as Record<string, unknown>).reasons = ['OWNER\u0000DISABLED'] }],
    ['advertisingState', (value: Record<string, unknown>) => { value.advertisingState = 'advertised' }],
    ['advertisedCapabilityIds', (value: Record<string, unknown>) => { value.advertisedCapabilityIds = {} }],
    ['ownerPolicy', (value: Record<string, unknown>) => { value.ownerPolicy = null }],
    ['policy mode', (value: Record<string, unknown>) => { (value.ownerPolicy as Record<string, unknown>).mode = 'on' }],
    ['maxConcurrency zero', (value: Record<string, unknown>) => { (value.ownerPolicy as Record<string, unknown>).maxConcurrency = 0 }],
    ['maxConcurrency fraction', (value: Record<string, unknown>) => { (value.ownerPolicy as Record<string, unknown>).maxConcurrency = 1.5 }],
    ['negative memory floor', (value: Record<string, unknown>) => { (value.ownerPolicy as Record<string, unknown>).minFreeMemoryBytes = -1 }],
    ['negative idle threshold', (value: Record<string, unknown>) => { (value.ownerPolicy as Record<string, unknown>).minIdleSeconds = -1 }],
    ['duplicate enabled ids', (value: Record<string, unknown>) => { (value.ownerPolicy as Record<string, unknown>).enabledServiceIds = ['tool-ffmpeg', 'tool-ffmpeg'] }],
    ['enabled ids not an array', (value: Record<string, unknown>) => { (value.ownerPolicy as Record<string, unknown>).enabledServiceIds = 'tool-ffmpeg' }],
    ['rate for a disabled service', (value: Record<string, unknown>) => {
      (value.ownerPolicy as Record<string, unknown>).nodeRates = [{ localServiceId: 'tool-gone', amountMinor: 1, unit: 'per-image', currency: 'CNY' }]
    }],
    ['rate amount below zero', (value: Record<string, unknown>) => {
      (value.ownerPolicy as Record<string, unknown>).nodeRates = [{ localServiceId: 'tool-ffmpeg', amountMinor: -1, unit: 'per-image', currency: 'CNY' }]
    }],
    ['rate without a unit', (value: Record<string, unknown>) => {
      (value.ownerPolicy as Record<string, unknown>).nodeRates = [{ localServiceId: 'tool-ffmpeg', amountMinor: 1, unit: '', currency: 'CNY' }]
    }],
    ['rate currency case', (value: Record<string, unknown>) => {
      (value.ownerPolicy as Record<string, unknown>).nodeRates = [{ localServiceId: 'tool-ffmpeg', amountMinor: 1, unit: 'per-image', currency: 'cny' }]
    }],
    ['duplicate rate services', (value: Record<string, unknown>) => {
      (value.ownerPolicy as Record<string, unknown>).nodeRates = [
        { localServiceId: 'tool-ffmpeg', amountMinor: 1, unit: 'per-image', currency: 'CNY' },
        { localServiceId: 'tool-ffmpeg', amountMinor: 2, unit: 'per-image', currency: 'CNY' },
      ]
    }],
    ['hardware', (value: Record<string, unknown>) => { value.hardware = {} }],
    ['hardware not an object', (value: Record<string, unknown>) => { value.hardware = null }],
    ['logicalCores zero', (value: Record<string, unknown>) => { (value.hardware as Record<string, unknown>).logicalCores = 0 }],
    ['gpu entry', (value: Record<string, unknown>) => { (value.hardware as Record<string, unknown>).gpus = [{ name: 'GPU', vendor: null, memoryBytes: -1 }] }],
    ['probe error entry', (value: Record<string, unknown>) => { (value.hardware as Record<string, unknown>).probeErrors = [7] }],
    ['localServices', (value: Record<string, unknown>) => { value.localServices = [{ id: 'tool-ffmpeg' }] }],
    ['duplicate service ids', (value: Record<string, unknown>) => {
      const service = { id: 'tool-ffmpeg', kind: 'tool', name: 'ffmpeg', version: null, verification: 'verified', reason: null }
      value.localServices = [service, service]
    }],
    ['service verification', (value: Record<string, unknown>) => {
      value.localServices = [{ id: 'tool-ffmpeg', kind: 'tool', name: 'ffmpeg', version: null, verification: 'maybe', reason: null }]
    }],
    ['service kind', (value: Record<string, unknown>) => {
      value.localServices = [{ id: 'tool-ffmpeg', kind: 'binary', name: 'ffmpeg', version: null, verification: 'verified', reason: null }]
    }],
    ['activity', (value: Record<string, unknown>) => { value.activity = { idleSeconds: -1, foregroundTaskActive: null, voiceActive: null } }],
    ['foreground flag type', (value: Record<string, unknown>) => { value.activity = { idleSeconds: 1, foregroundTaskActive: 'yes', voiceActive: null } }],
  ])('rejects a snapshot whose %s is not contract-valid', (_field, mutate) => {
    expect(rejected(mutate)).toBe(true)
  })

  it.each([
    ['disabled without an off policy', (value: Record<string, unknown>) => { (value.eligibility as Record<string, unknown>).state = 'disabled' }],
    ['ready while reasons remain', (value: Record<string, unknown>) => { (value.eligibility as Record<string, unknown>).state = 'ready' }],
    ['blocked with an empty reason list', (value: Record<string, unknown>) => {
      (value.eligibility as Record<string, unknown>).reasons = []
    }],
    ['advertising while blocked', (value: Record<string, unknown>) => { value.advertisingState = 'advertising' }],
    ['off policy that claims readiness', (value: Record<string, unknown>) => {
      (value.ownerPolicy as Record<string, unknown>).mode = 'off'
    }],
  ])('rejects a self-contradictory snapshot: %s', (_case, mutate) => {
    expect(rejected(mutate)).toBe(true)
  })

  it('accepts a disabled snapshot and a ready snapshot', () => {
    const disabled = clone()
    ;(disabled.ownerPolicy as Record<string, unknown>).mode = 'off'
    ;(disabled.eligibility as Record<string, unknown>).state = 'disabled'
    ;(disabled.advertisingState as unknown) = 'not-connected'
    expect(parseSupplySnapshot(disabled).eligibility.state).toBe('disabled')
    const ready = clone()
    ;(ready.ownerPolicy as Record<string, unknown>).mode = 'allowed'
    ;(ready.eligibility as Record<string, unknown>).state = 'ready'
    ;(ready.eligibility as Record<string, unknown>).reasons = []
    ;(ready.advertisingState as unknown) = 'advertising'
    expect(parseSupplySnapshot(ready).advertisingState).toBe('advertising')
  })

  it('bounds unbounded arrays instead of rendering them', () => {
    expect(rejected((value) => {
      (value.ownerPolicy as Record<string, unknown>).enabledServiceIds = Array.from({ length: 129 }, (_, index) => `tool-${index}`)
    })).toBe(true)
    expect(rejected((value) => {
      (value.ownerPolicy as Record<string, unknown>).nodeRates = Array.from({ length: 129 }, () => (
        { localServiceId: 'tool-ffmpeg', amountMinor: 1, unit: 'per-image', currency: 'CNY' }))
    })).toBe(true)
    expect(rejected((value) => { (value.eligibility as Record<string, unknown>).reasons = Array.from({ length: 65 }, () => 'OWNER_DISABLED') })).toBe(true)
    expect(rejected((value) => { value.advertisedCapabilityIds = Array.from({ length: 513 }, () => 'tool-ffmpeg') })).toBe(true)
    expect(rejected((value) => { (value.hardware as Record<string, unknown>).gpus = Array.from({ length: 65 }, () => ({ name: 'GPU', vendor: null, memoryBytes: null })) })).toBe(true)
    expect(rejected((value) => { value.localServices = Array.from({ length: 513 }, (_, index) => ({ id: `tool-${index}`, kind: 'tool', name: 'tool', version: null, verification: 'verified', reason: null })) })).toBe(true)
    expect(rejected((value) => { (value.hardware as Record<string, unknown>).probeErrors = Array.from({ length: 65 }, () => 'GPU_PROBE_UNAVAILABLE') })).toBe(true)
  })

  it('validates a policy on its own for the empty-list boundary', () => {
    expect(parsePolicy({ mode: 'off', maxConcurrency: 1, minFreeMemoryBytes: 0, minIdleSeconds: 0, enabledServiceIds: [], nodeRates: [] }))
      .toEqual({ mode: 'off', maxConcurrency: 1, minFreeMemoryBytes: 0, minIdleSeconds: 0, enabledServiceIds: [], nodeRates: [] })
    expect(() => parsePolicy(null)).toThrow(INVALID_SUPPLY_RESPONSE)
  })

  it('reads structured Host errors and never renders a raw body', () => {
    const structured = hostError({ error: { code: 'SUPPLY_POLICY_INVALID', message: 'SUPPLY_POLICY_INVALID' } }, 400)
    expect(structured.name).toBe('SUPPLY_POLICY_INVALID')
    expect(structured.message).toBe('SUPPLY_POLICY_INVALID')
    const unauthorized = hostError(null, 401)
    expect(unauthorized.name).toBe('AUTH_REQUIRED')
    expect(unauthorized.message).toBe('HTTP_401')
    expect(hostError('<html>Unavailable</html>', 503).name).toBe('REQUEST_FAILED')
    expect(hostError({ error: { code: 42, message: '' } }, 403).name).toBe('AUTH_REQUIRED')
  })
})
