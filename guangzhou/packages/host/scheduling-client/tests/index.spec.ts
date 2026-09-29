import { describe, expect, it, vi } from 'vitest'
import { createComputeApiClient } from '@deepseek-ai/dsh-host-compute-api'
import { ComputeCapabilityId, ComputeNodeId, ComputeTaskId, type NodeHeartbeatMessage, type NodeTaskOfferMessage } from '@deepseek-ai/dsh-compute-core'
import { SchedulingClient, SCHEDULING_CONTROL_VERSION, type SchedulingRevokeNotice, type SchedulingSession } from '../src/index.ts'

const heartbeat: NodeHeartbeatMessage = { version: 'qianshou.node.v1', nodeId: ComputeNodeId('node-a'), agentVersion: '1.0.0', sentAt: '2026-09-15T12:00:00.000Z', capabilities: [{ capabilityId: ComputeCapabilityId('image.generate'), version: '1.0.0', pluginDigest: 'a'.repeat(64) }], maxConcurrency: 1, runningTasks: 0 }
const offer: NodeTaskOfferMessage = { type: 'task.offer', envelope: { version: 'qianshou.task.v1', taskId: ComputeTaskId('task-a'), capabilityId: ComputeCapabilityId('image.generate'), capabilityVersion: '1.0.0', inputRefs: [], parameters: {}, deadlineAt: '2026-09-15T12:10:00.000Z', maxOutputBytes: 1024, idempotencyKey: 'idem' }, attempt: 1, leaseExpiresAt: '2026-09-15T12:05:00.000Z', receivedAt: '2026-09-15T12:00:00.000Z', signature: 's'.repeat(16) }

function fake() {
  const frames: unknown[] = []
  const offers = new Set<(value: NodeTaskOfferMessage) => void | Promise<void>>()
  const revokes = new Set<(value: SchedulingRevokeNotice) => void | Promise<void>>()
  const session: SchedulingSession = {
    send: async (frame) => { frames.push(frame) },
    onOffer: (handler) => { offers.add(handler); return () => { offers.delete(handler) } },
    onRevoke: (handler) => {
      revokes.add(handler)
      return () => { revokes.delete(handler) }
    },
    close: vi.fn(async () => {}),
  }
  return { frames, session, emit: () => { for (const handler of offers) Promise.resolve(handler(offer)).catch(() => {}) } }
}

describe('SchedulingClient', () => {
  it('connects, publishes heartbeat, accepts idempotently and exposes offers', async () => {
    const f = fake(); const client = new SchedulingClient({ transport: { connect: async () => f.session } })
    await client.connect({ endpoint: 'local://dispatch', accessToken: 'ephemeral', heartbeat }); const seen: string[] = []; client.onTaskOffer((o) => { seen.push(o.envelope.taskId) }); f.emit()
    await client.heartbeat(heartbeat); await client.accept('task-a', 1, 'lease-a', 'idem-a'); await client.accept('task-a', 1, 'lease-a', 'idem-a')
    expect(seen).toEqual(['task-a']); expect(f.frames).toHaveLength(2); expect(f.frames[0]).toMatchObject({ version: SCHEDULING_CONTROL_VERSION, type: 'node.heartbeat' }); expect(f.frames[1]).toMatchObject({ type: 'task.accept', taskId: 'task-a' })
  })
  it('rejects conflicting decisions and unsafe reasons', async () => {
    const f = fake(); const client = new SchedulingClient({ transport: { connect: async () => f.session } }); await client.connect({ endpoint: 'local://dispatch', accessToken: 'x', heartbeat })
    await client.accept('task-a', 1, 'lease-a', 'idem-a'); await expect(client.reject('task-a', 1, 'lease-a', 'idem-a', 'too late')).rejects.toThrow('SCHEDULING_DECISION_CONFLICT'); await expect(client.reject('task-b', 1, 'lease-b', 'idem-b', '')).rejects.toThrow('SCHEDULING_REASON_INVALID')
  })
  it('keeps API catalogue reads separate and fails when absent', async () => {
    const f = fake(); const api = { me: vi.fn(async () => ({ id: 'n' })), taskTypes: vi.fn(async () => ({ items: [] })), workloads: vi.fn(async () => []), workload: vi.fn(), shards: vi.fn(), result: vi.fn() }
    const client = new SchedulingClient({ transport: { connect: async () => f.session }, api }); await client.connect({ endpoint: 'local://dispatch', accessToken: 'x', heartbeat }); await expect(client.readCatalogue()).resolves.toMatchObject({ identity: { id: 'n' } }); await client.close(); await expect(client.heartbeat(heartbeat)).rejects.toThrow('SCHEDULING_CLIENT_NOT_READY')
  })
  it('preserves the HTTP workload array in catalogue reads without a node connection', async () => {
    const requests: string[] = []
    const responses: Record<string, unknown> = {
      '/api/v8/auth/me': { id: 42 },
      '/api/v8/developer/task-types': { ok: true, items: [], total: 0 },
      '/api/v8/workloads': [{ id: 'w-1', status: 'RUNNING' }],
    }
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'fixture', maxResponseBytes: 1024, fetch: async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : input).pathname
      requests.push(pathname)
      return new Response(JSON.stringify(responses[pathname]), { status: 200 })
    } })
    const connect = vi.fn()
    const client = new SchedulingClient({ transport: { connect }, api })
    await expect(client.readCatalogue()).resolves.toEqual({ identity: { id: 42 }, taskTypes: { ok: true, items: [], total: 0 }, workloads: [{ id: 'w-1', status: 'RUNNING' }] })
    expect(requests.sort()).toEqual(Object.keys(responses).sort())
    expect(connect).not.toHaveBeenCalled()
    expect(client.status()).toBe('DISCONNECTED')
  })
})
