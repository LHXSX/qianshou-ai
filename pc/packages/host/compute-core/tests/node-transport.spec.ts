import { describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { ComputeNodeId, type NodeHeartbeatMessage, type NodeTaskOfferMessage } from '../src/node-protocol.ts'
import { createNodeTransportConnector, type NodeTransport, type NodeTransportInbound, type NodeTransportOutbound } from '../src/node-transport.ts'

const heartbeat: NodeHeartbeatMessage = {
  version: 'qianshou.node.v1', nodeId: ComputeNodeId('node-transport'), agentVersion: '1.0.0', sentAt: '2026-09-14T12:00:00.000Z',
  capabilities: [{ capabilityId: ComputeCapabilityId('image'), version: '1.0.0', pluginDigest: 'a'.repeat(64) }], maxConcurrency: 2, runningTasks: 0,
}
const envelope: ComputeTaskEnvelope = { version: 'qianshou.task.v1', taskId: ComputeTaskId('transport-task'), capabilityId: ComputeCapabilityId('image'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'x' }, deadlineAt: '2026-09-14T12:10:00.000Z', maxOutputBytes: 1000, idempotencyKey: 'transport-idem' }

class FakeTransport implements NodeTransport {
  readonly sent: NodeTransportOutbound[] = []
  private messages = new Set<(frame: NodeTransportInbound) => void | Promise<void>>()
  private closes = new Set<(reason?: string) => void>()
  closed = false
  async send(frame: NodeTransportOutbound): Promise<void> {
    this.sent.push(frame)
    if (frame.type === 'auth') queueMicrotask(() => { this.emit({ type: 'auth.accepted' }) })
  }
  onMessage(handler: (frame: NodeTransportInbound) => void | Promise<void>): () => void {
    this.messages.add(handler)
    return () => this.messages.delete(handler)
  }
  onClose(handler: (reason?: string) => void): () => void { this.closes.add(handler); return () => this.closes.delete(handler) }
  async close(): Promise<void> { this.closed = true; for (const handler of this.closes) handler('closed') }
  emit(frame: NodeTransportInbound): void { for (const handler of this.messages) void handler(frame) }
}

describe('node transport adapter', () => {
  it('rejects malformed runtime values with transport errors', async () => {
    expect(() => createNodeTransportConnector(null as never, { authTimeoutMs: 1000, maxPendingOffers: 4 }))
      .toThrow('COMPUTE_NODE_TRANSPORT_FACTORY_INVALID')
    const connector = createNodeTransportConnector({ open: async () => new FakeTransport() }, { authTimeoutMs: 1000, maxPendingOffers: 4 })
    await expect(connector.connect(null as never)).rejects.toThrow('COMPUTE_NODE_CONNECT_REQUEST_INVALID')
  })

  it('authenticates once, routes validated offers, and keeps token out of session state', async () => {
    const transport = new FakeTransport()
    const connector = createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 4 })
    const session = await connector.connect({ endpoint: 'https://dispatch.invalid/node', accessToken: 'ephemeral-secret', heartbeat })
    expect(transport.sent[0]).toMatchObject({ type: 'auth', endpoint: 'https://dispatch.invalid/node', accessToken: 'ephemeral-secret' })
    expect(JSON.stringify(session)).not.toContain('ephemeral-secret')
    const received: NodeTaskOfferMessage[] = []
    session.onOffer((offer) => { received.push(offer) })
    transport.emit({ type: 'task.offer', offer: { type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'signed-' + 'a'.repeat(20) } })
    await Promise.resolve()
    expect(received[0]?.envelope.taskId).toBe('transport-task')
    transport.emit({ type: 'task.offer', offer: { type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: 'bad', receivedAt: 'bad', signature: 'short' } })
    await Promise.resolve()
    expect(received).toHaveLength(1)
    expect(transport.closed).toBe(true)
    transport.emit({ type: 'task.offer', offer: { type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'signed-' + 'a'.repeat(20) } })
    await Promise.resolve()
    expect(received).toHaveLength(1)
  })

  it('uses the same transport seam for heartbeat, progress, and result manifest', async () => {
    const transport = new FakeTransport()
    const session = await createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 4 }).connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
    await session.sendHeartbeat(heartbeat)
    await expect(session.sendProgress(null as never)).rejects.toThrow('COMPUTE_NODE_PROGRESS_INVALID')
    await expect(session.sendReturn({ taskId: 'transport-task', attempt: 1, outputs: [null] } as never))
      .rejects.toThrow('COMPUTE_NODE_RETURN_INVALID')
    await session.sendProgress({ type: 'task.progress', taskId: 'transport-task', attempt: 1, sequence: 1, progress: 0.5, phase: 'render' })
    await session.sendReturn({ type: 'task.return', taskId: 'transport-task', attempt: 1, outputs: [{ name: 'result.png', bytes: 10, sha256: 'b'.repeat(64), path: '/private/should-not-cross' } as never] })
    await session.sendHeartbeat({ ...heartbeat, debug: { localPath: '/private/should-not-cross' } } as never)
    expect(transport.sent.map(frame => frame.type)).toEqual(['auth', 'heartbeat', 'task.progress', 'task.return', 'heartbeat'])
    expect(JSON.stringify(transport.sent)).not.toContain('should-not-cross')
    await session.close('done')
    expect(transport.closed).toBe(true)
    await expect(session.sendHeartbeat(heartbeat)).rejects.toThrow('COMPUTE_NODE_SESSION_CLOSED')
  })

  it('fails closed when the authenticated service rejects the handshake', async () => {
    const transport = new FakeTransport()
    transport.send = async (frame) => {
      transport.sent.push(frame)
      if (frame.type === 'auth') queueMicrotask(() => { transport.emit({ type: 'error', code: 'AUTH_DENIED' }) })
    }
    const connector = createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 4 })
    await expect(connector.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })).rejects.toThrow('AUTH_DENIED')
    expect(transport.closed).toBe(true)
  })

  it('times out a hanging auth send and observes a late send rejection', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      let rejectSend!: (error: Error) => void
      let started!: () => void
      const sendStarted = new Promise<void>((resolve) => { started = resolve })
      transport.send = async (frame) => {
        transport.sent.push(frame)
        if (frame.type === 'auth') {
          started()
          await new Promise<void>((_resolve, reject) => { rejectSend = reject })
        }
      }
      const connector = createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 4 })
      const pending = connector.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
      await sendStarted
      const rejection = expect(pending).rejects.toThrow('COMPUTE_NODE_AUTH_TIMEOUT')
      await vi.advanceTimersByTimeAsync(1000)
      await rejection
      rejectSend(new Error('late auth send failure'))
      await Promise.resolve()
      expect(transport.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out when auth is acknowledged but the send never settles', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      let started!: () => void
      const sendStarted = new Promise<void>((resolve) => { started = resolve })
      transport.send = async (frame) => {
        transport.sent.push(frame)
        if (frame.type === 'auth') {
          transport.emit({ type: 'auth.accepted' })
          started()
          await new Promise<void>(() => {})
        }
      }
      const connector = createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 4 })
      const pending = connector.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
      await sendStarted
      const rejection = expect(pending).rejects.toThrow('COMPUTE_NODE_AUTH_TIMEOUT')
      await vi.advanceTimersByTimeAsync(1000)
      await rejection
      expect(transport.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts promptly while auth send hangs and observes a late send rejection', async () => {
    const transport = new FakeTransport()
    let rejectSend!: (error: Error) => void
    let started!: () => void
    const sendStarted = new Promise<void>((resolve) => { started = resolve })
    transport.send = async (frame) => {
      transport.sent.push(frame)
      if (frame.type === 'auth') {
        started()
        await new Promise<void>((_resolve, reject) => { rejectSend = reject })
      }
    }
    const connector = createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 4 })
    const controller = new AbortController()
    const pending = connector.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat }, controller.signal)
    await sendStarted
    const rejection = expect(pending).rejects.toThrow('COMPUTE_NODE_CONNECT_ABORTED')
    controller.abort()
    await rejection
    rejectSend(new Error('late auth send failure'))
    await Promise.resolve()
    expect(transport.closed).toBe(true)
  })

  it('does not send auth when the factory resolves after cancellation', async () => {
    const transport = new FakeTransport()
    let release!: () => void
    const opened = new Promise<NodeTransport>((resolve) => { release = () => { resolve(transport) } })
    const connector = createNodeTransportConnector({ open: async () => opened }, { authTimeoutMs: 1000, maxPendingOffers: 4 })
    const controller = new AbortController()
    const pending = connector.connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat }, controller.signal)
    const rejection = expect(pending).rejects.toThrow('COMPUTE_NODE_CONNECT_ABORTED')
    controller.abort()
    release()
    await rejection
    expect(transport.sent).toEqual([])
    expect(transport.closed).toBe(true)
  })

  it('buffers authenticated offers until the first consumer subscribes', async () => {
    const transport = new FakeTransport()
    transport.send = async (frame) => {
      transport.sent.push(frame)
      if (frame.type === 'auth') {
        transport.emit({ type: 'auth.accepted' })
        transport.emit({ type: 'task.offer', offer: { type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'signed-' + 'a'.repeat(20) } })
      }
    }
    const session = await createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 2 }).connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
    const received: NodeTaskOfferMessage[] = []
    session.onOffer((offer) => { received.push(offer) })
    await Promise.resolve()
    expect(received).toHaveLength(1)
  })

  it('drains queued offers in transport order while a consumer is delayed', async () => {
    const transport = new FakeTransport()
    const session = await createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 4 }).connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
    const received: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    session.onOffer(async (offer) => { received.push(offer.envelope.taskId); await gate })
    const makeOffer = (taskId: string): NodeTaskOfferMessage => ({ type: 'task.offer', envelope: { ...envelope, taskId } as ComputeTaskEnvelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'signed-' + 'a'.repeat(20) })
    transport.emit({ type: 'task.offer', offer: makeOffer('ordered-1') })
    transport.emit({ type: 'task.offer', offer: makeOffer('ordered-2') })
    await Promise.resolve()
    expect(received).toEqual(['ordered-1'])
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received).toEqual(['ordered-1', 'ordered-2'])
  })

  it('closes a session when an offer consumer fails instead of dropping silently', async () => {
    const transport = new FakeTransport()
    const session = await createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 2 }).connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
    session.onOffer(() => { throw new Error('consumer failed') })
    transport.emit({ type: 'task.offer', offer: { type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'signed-' + 'a'.repeat(20) } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(transport.closed).toBe(true)
    await expect(session.sendHeartbeat(heartbeat)).rejects.toThrow('COMPUTE_NODE_SESSION_CLOSED')
  })

  it.each([false, true])('waits for an in-flight consumer on close, including remote close: %s', async (remoteClosed) => {
    const transport = new FakeTransport()
    const session = await createNodeTransportConnector({ open: async () => transport }, { authTimeoutMs: 1000, maxPendingOffers: 2 }).connect({ endpoint: 'local://dispatch', accessToken: 'token', heartbeat })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    session.onOffer(async () => { await gate })
    transport.emit({ type: 'task.offer', offer: { type: 'task.offer', envelope, attempt: 1, leaseExpiresAt: '2026-09-14T12:05:00.000Z', receivedAt: '2026-09-14T12:00:00.000Z', signature: 'signed-' + 'a'.repeat(20) } })
    await Promise.resolve()
    if (remoteClosed) await transport.close()
    let finished = false
    const closing = session.close('test').then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    release()
    await closing
    expect(finished).toBe(true)
    expect(transport.closed).toBe(true)
  })
})
