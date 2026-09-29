import { describe, expect, it } from 'vitest'
import { ComputeNodeId } from '@deepseek-ai/dsh-compute-core/node-protocol'
import { PlatformDirectory, parsePlatformEvent, registrationFromNodeHeartbeat, type PlatformParticipantRegistration } from '../src/index.ts'

const registration = (id = 'node-a'): PlatformParticipantRegistration => ({
  identity: { kind: 'node', id: ComputeNodeId(id) }, agentVersion: 'agent-1',
  capabilities: [{ capabilityId: 'image.generate' as never, version: '1.0.0', pluginDigest: 'a'.repeat(64), available: true }],
  maxConcurrency: 2, runningTasks: 0, lastSeenAt: '2026-09-15T00:00:00.000Z',
})

describe('PlatformDirectory', () => {
  it('registers snapshots, updates heartbeats, and disposes only its revision', () => {
    const directory = new PlatformDirectory()
    const dispose = directory.register(registration())
    expect(directory.snapshot()[0]?.key).toBe('node\u0000node-a')
    const next = directory.heartbeat({ kind: 'node', id: ComputeNodeId('node-a') }, { capabilities: registration().capabilities, maxConcurrency: 2, runningTasks: 1, lastSeenAt: '2026-09-15T00:00:01.000Z' })
    expect(next.runningTasks).toBe(1)
    dispose()
    expect(directory.snapshot()).toEqual([])
  })

  it('does not let an old disposer remove a replacement registration', () => {
    const directory = new PlatformDirectory()
    const first = directory.register(registration())
    directory.register({ ...registration(), agentVersion: 'agent-2' })
    first()
    expect(directory.snapshot()[0]?.agentVersion).toBe('agent-2')
  })

  it('isolates listener errors and publishes a frozen parsed event', () => {
    const directory = new PlatformDirectory()
    const seen: string[] = []
    directory.onEvent(() => { throw new Error('observer') })
    directory.onEvent(event => seen.push(event.type))
    const event = directory.publish({ version: 'qianshou.platform.event.v1', eventId: 'evt-1', type: 'node.ready', source: { kind: 'node', id: 'node-a' }, sequence: 0, sentAt: '2026-09-15T00:00:00.000Z', data: { ok: true } })
    expect(event.type).toBe('node.ready')
    expect(Object.isFrozen(event)).toBe(true)
    expect(seen).toEqual(['node.ready'])
  })

  it('rejects malformed and oversized event data', () => {
    expect(() => parsePlatformEvent({ version: 'qianshou.platform.event.v1', eventId: 'evt', type: 'x', source: { kind: 'node', id: 'node-a' }, sequence: -1, sentAt: '2026-09-15T00:00:00.000Z', data: null })).toThrow('PLATFORM_EVENT_INVALID')
    expect(() => parsePlatformEvent({ version: 'qianshou.platform.event.v1', eventId: 'evt', type: 'x', source: { kind: 'node', id: 'node-a' }, sequence: 0, sentAt: '2026-09-15T00:00:00.000Z', data: Number.NaN })).toThrow('PLATFORM_EVENT_INVALID')
    expect(() => parsePlatformEvent({ version: 'qianshou.platform.event.v1', eventId: 'evt', type: 'x', source: { kind: 'node', id: 'node-a' }, sequence: 0, sentAt: '2026-09-15T00:00:00.000Z', data: 'x'.repeat(300_000) })).toThrow('PLATFORM_EVENT_DATA_TOO_LARGE')
  })

  it('converts an existing node heartbeat without exposing paths or secrets', () => {
    const registration = registrationFromNodeHeartbeat({ nodeId: ComputeNodeId('node-a'), agentVersion: 'agent-1', sentAt: '2026-09-15T00:00:00.000Z', capabilities: [{ capabilityId: 'image.generate' as never, version: '1.0.0', pluginDigest: 'a'.repeat(64) }], maxConcurrency: 2, runningTasks: 2 })
    expect(registration.identity).toEqual({ kind: 'node', id: 'node-a' })
    expect(registration.capabilities[0]?.available).toBe(false)
    expect(registration).not.toHaveProperty('path')
  })

  it('reports unknown heartbeat targets and duplicate capabilities loudly', () => {
    const directory = new PlatformDirectory()
    expect(() => directory.heartbeat({ kind: 'node', id: ComputeNodeId('missing') }, registration())).toThrow('PLATFORM_PARTICIPANT_NOT_FOUND')
    expect(() => directory.register({ ...registration(), capabilities: [...registration().capabilities, ...registration().capabilities] })).toThrow('PLATFORM_REGISTRATION_INVALID')
  })
})
