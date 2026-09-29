import { describe, expect, it } from 'vitest'
import { parseMobileCapabilityHeartbeat, parseMobileSyncAck, parseMobileSyncRequest, parseObservabilityEvent, MOBILE_SYNC_VERSION, OBSERVABILITY_EVENT_VERSION } from '../src/index.ts'
const identity = { kind: 'agent' as const, id: 'agent-main' }
const capability = { capabilityId: 'image.generate' as never, version: '1.0.0', pluginDigest: 'a'.repeat(64), available: true }
const heartbeat = { version: MOBILE_SYNC_VERSION, identity, platform: 'ios', agentVersion: '1.0.0', sequence: 1, sentAt: '2026-09-15T01:02:03.000Z', surface: 'foreground', acceptance: 'autonomous', capabilities: [capability], maxConcurrency: 2, runningTasks: 0, cursor: 'cursor-1' }
describe('mobile sync contract', () => {
  it('parses bounded provider-neutral heartbeat', () => { expect(parseMobileCapabilityHeartbeat(heartbeat).platform).toBe('ios') })
  it('rejects duplicate capabilities and invalid capacity', () => {
    expect(() => parseMobileCapabilityHeartbeat({ ...heartbeat, capabilities: [capability, capability] })).toThrow('MOBILE_HEARTBEAT_INVALID')
    expect(() => parseMobileCapabilityHeartbeat({ ...heartbeat, runningTasks: 3 })).toThrow('MOBILE_HEARTBEAT_INVALID')
  })
  it('parses sync request with bounded page size', () => { expect(parseMobileSyncRequest({ version: MOBILE_SYNC_VERSION, identity, cursor: 'c', limit: 20 }).limit).toBe(20) })
  it('parses sync acknowledgements and rejects invalid revisions', () => {
    const parsed = parseMobileSyncAck({ version: MOBILE_SYNC_VERSION, identity, cursor: 'c2', revision: 4, heartbeat })
    expect(parsed.revision).toBe(4)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(() => parseMobileSyncAck({ version: MOBILE_SYNC_VERSION, identity, cursor: 'c2', revision: -1, heartbeat })).toThrow('MOBILE_SYNC_ACK_INVALID')
  })
})
describe('observability contract', () => {
  it('accepts scalar redacted attributes only', () => { expect(parseObservabilityEvent({ version: OBSERVABILITY_EVENT_VERSION, eventId: 'e1', type: 'task.progress', severity: 'info', source: identity, occurredAt: heartbeat.sentAt, attributes: { phase: 'render', progress: 0.5 } }).attributes.phase).toBe('render') })
  it('rejects secret, path and media attributes', () => {
    for (const key of ['token', 'workspacePath', 'mediaBytes']) expect(() => parseObservabilityEvent({ version: OBSERVABILITY_EVENT_VERSION, eventId: 'e1', type: 'x', severity: 'info', source: identity, occurredAt: heartbeat.sentAt, attributes: { [key]: 'x' } })).toThrow('OBSERVABILITY_EVENT_INVALID')
  })
  it('bounds attribute count and payload size', () => {
    const attrs = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, true]))
    expect(() => parseObservabilityEvent({ version: OBSERVABILITY_EVENT_VERSION, eventId: 'e1', type: 'x', severity: 'info', source: identity, occurredAt: heartbeat.sentAt, attributes: attrs })).toThrow('OBSERVABILITY_EVENT_INVALID')
  })
})
