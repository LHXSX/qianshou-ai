import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId, ComputeNodeId, ComputeTaskId, type NodeHeartbeatMessage, type NodeSession, type NodeTaskOfferMessage } from '@deepseek-ai/dsh-compute-core'
import { DispatchControlAdapter } from '../src/index.ts'

const heartbeat: NodeHeartbeatMessage = {
  version: 'qianshou.node.v1', nodeId: ComputeNodeId('adapter-node'), agentVersion: '1.0.0', sentAt: '2026-09-15T12:00:00.000Z',
  capabilities: [{ capabilityId: ComputeCapabilityId('image.generate'), version: '1.0.0', pluginDigest: 'a'.repeat(64) }], maxConcurrency: 1, runningTasks: 0,
}
const offer: NodeTaskOfferMessage = {
  type: 'task.offer', envelope: { version: 'qianshou.task.v1', taskId: ComputeTaskId('adapter-task'), capabilityId: ComputeCapabilityId('image.generate'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'x' }, deadlineAt: '2026-09-15T12:10:00.000Z', maxOutputBytes: 1024, idempotencyKey: 'adapter-idem' }, attempt: 1, leaseExpiresAt: '2026-09-15T12:05:00.000Z', receivedAt: '2026-09-15T12:00:00.000Z', signature: 's'.repeat(16),
}

function fakeSession() {
  const offers = new Set<(value: NodeTaskOfferMessage) => void | Promise<void>>()
  const calls: string[] = []
  const session: NodeSession = {
    sendHeartbeat: async () => { calls.push('heartbeat') },
    sendProgress: async () => { calls.push('progress') },
    sendReturn: async () => { calls.push('result') },
    onOffer: (handler) => { offers.add(handler); return () => offers.delete(handler) },
    close: async () => { calls.push('close') },
  }
  return { session, calls, emit: (value: NodeTaskOfferMessage) => { for (const handler of offers) void handler(value) } }
}

describe('DispatchControlAdapter', () => {
  it('binds handshake, capabilities, offers and control receipts to the injected session', async () => {
    const fake = fakeSession()
    let requestToken = ''
    const adapter = new DispatchControlAdapter({ connector: { connect: async (request) => { requestToken = request.accessToken; return fake.session } }, clock: () => '2026-09-15T12:00:00.000Z' })
    await expect(adapter.connect({ endpoint: 'local://dispatch', accessToken: 'ephemeral', heartbeat })).resolves.toMatchObject({ status: 'READY', attempt: 1 })
    expect(requestToken).toBe('ephemeral')
    const received: string[] = []
    const off = adapter.onTaskOffer((value) => { received.push(value.envelope.taskId) })
    fake.emit(offer)
    await Promise.resolve()
    await adapter.publishHeartbeat(heartbeat)
    await adapter.reportProgress({ type: 'task.progress', taskId: 'adapter-task', attempt: 1, sequence: 1, progress: 0.4, phase: 'render' })
    await adapter.reportResult({ type: 'task.return', taskId: 'adapter-task', attempt: 1, outputs: [{ name: 'result.png', bytes: 2, sha256: 'b'.repeat(64) }] })
    off()
    expect(received).toEqual(['adapter-task'])
    expect(fake.calls).toEqual(['heartbeat', 'progress', 'result'])
    await adapter.close()
    expect(fake.calls).toEqual(['heartbeat', 'progress', 'result', 'close'])
    expect(adapter.state().status).toBe('CLOSED')
  })

  it('does not retain the access token and fails closed after transport errors', async () => {
    const fake = fakeSession()
    const adapter = new DispatchControlAdapter({ connector: { connect: async () => fake.session }, clock: () => '2026-09-15T12:00:00.000Z' })
    await adapter.connect({ endpoint: 'local://dispatch', accessToken: 'secret-token', heartbeat })
    expect(JSON.stringify(adapter)).not.toContain('secret-token')
    fake.session.sendHeartbeat = async () => { throw new Error('socket lost') }
    await expect(adapter.publishHeartbeat(heartbeat)).rejects.toThrow('socket lost')
    expect(adapter.state()).toMatchObject({ status: 'DISCONNECTED', lastError: 'heartbeat:socket lost' })
    await expect(adapter.reportProgress({ type: 'task.progress', taskId: 'adapter-task', attempt: 1, sequence: 1, progress: 0, phase: 'queued' })).rejects.toThrow('COMPUTE_DISPATCH_NOT_READY')
  })

  it('rejects duplicate and post-close connections', async () => {
    const fake = fakeSession()
    const adapter = new DispatchControlAdapter({ connector: { connect: async () => fake.session }, clock: () => '2026-09-15T12:00:00.000Z' })
    await adapter.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
    await expect(adapter.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })).rejects.toThrow('COMPUTE_DISPATCH_ALREADY_CONNECTED')
    await adapter.close()
    await expect(adapter.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })).rejects.toThrow('COMPUTE_DISPATCH_CLOSED')
  })
})
