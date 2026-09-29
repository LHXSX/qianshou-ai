/**
 * Real-socket acceptance for the resident edge transport.
 *
 * Every case here goes through a real TCP socket, a real HTTP `Upgrade`
 * handshake, the real audited subprotocol negotiation and real masked client
 * frames served by `fixture-ws-server.ts`. Nothing stubs `WebSocket`: the client
 * side is the runtime's own global `WebSocket`, and the server side is built
 * from Node built-ins only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId } from '../../src/protocol.ts'
import { ComputeNodeId, type NodeHeartbeatMessage, type NodeTaskOfferMessage } from '../../src/node-protocol.ts'
import {
  EdgeWorkerResidentConnector,
  EdgeWorkerTransportError,
  type EdgeSessionBridge,
  type EdgeWorkerSessionOptions,
} from '../../src/transport/edge-worker-session.ts'
import { FixtureWebSocketServer, type FixtureFrame, type FixtureServerContext } from './fixture-ws-server.ts'

/** Audited server script: welcome, auth_ok and hb_ack, nothing else. */
function auditedScript(frame: FixtureFrame, context: FixtureServerContext): void {
  if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-15T12:00:00.000Z' })
  if (frame.type === 'auth') context.reply('auth_ok', { worker_id: 'worker-edge-1', owner_id: 7, reconnect: false })
  if (frame.type === 'hb') context.reply('hb_ack', {})
}

/** One `shard_assign` payload with every field `parseOffer` requires. */
function assignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workload_id: 'workload-1', shard_id: 'shard-1', attempt: 0, task_type: 'word_count', runtime: 'node',
    input_kind: 'inline', inline_input: 'real task bytes', input_ref: '', input_refs: [],
    code_url: 'http://127.0.0.1/untrusted.py', code_sha256: '', timeout_s: 60,
    verification_policy: 'semantic', execution_model: '', capability: 'word.count', capability_version: '1.0.0',
    lease_token: 'server-issued-lease-token', ...overrides,
  }
}

/**
 * Test-owned bridge. The edge frame carries no signature and no output bytes, so
 * this fixture — standing in for the deployment — owns both decisions.
 */
function bridge(overrides: Partial<EdgeSessionBridge> = {}): EdgeSessionBridge {
  return {
    toNodeOffer: (offer, context) => {
      const deadline = new Date(Date.parse(context.receivedAt) + offer.timeoutSeconds * 1000).toISOString()
      return {
        type: 'task.offer',
        envelope: {
          version: 'qianshou.task.v1',
          taskId: ComputeTaskId(`${offer.workloadId}.${offer.shardId}`),
          capabilityId: ComputeCapabilityId(offer.capability),
          capabilityVersion: offer.capabilityVersion,
          inputRefs: [],
          parameters: { inlineInput: offer.inlineInput, taskType: offer.taskType, runtime: offer.runtime },
          deadlineAt: deadline,
          maxOutputBytes: 4096,
          idempotencyKey: `${offer.workerId}:${offer.workloadId}:${offer.shardId}:${offer.attempt}`,
        },
        attempt: offer.attempt + 1,
        leaseExpiresAt: deadline,
        receivedAt: context.receivedAt,
        signature: 'bridge-owned-signature-0001',
      }
    },
    toEdgeResult: message => ({ inlineOutputUtf8: `result:${message.taskId}:${message.outputs.length}`, elapsedMs: 12 }),
    ...overrides,
  }
}

function options(endpoint: string | null, extra: Partial<EdgeWorkerSessionOptions> = {}): EdgeWorkerSessionOptions {
  return {
    endpoint,
    tokenProvider: () => 'socket-fixture-token',
    expectedOwnerId: 7,
    name: 'socket-fixture',
    clientBuild: 'test-build',
    os: 'test-os',
    arch: 'test-arch',
    capabilities: { runtime: 'node' },
    allowedTaskTypes: ['word_count'],
    handshakeTimeoutMs: 2000,
    maxFrameBytes: 65_536,
    maxOutputBytes: 4096,
    supply: () => 'running',
    bridge: bridge(),
    ...extra,
  }
}

function heartbeat(runningTasks = 1): NodeHeartbeatMessage {
  return {
    version: 'qianshou.node.v1',
    nodeId: ComputeNodeId('node-edge-1'),
    agentVersion: 'agent-0.1.0',
    sentAt: new Date().toISOString(),
    capabilities: [],
    maxConcurrency: 2,
    runningTasks,
  }
}

const servers: FixtureWebSocketServer[] = []
async function start(scriptOptions: Parameters<typeof FixtureWebSocketServer.start>[0] = {}): Promise<FixtureWebSocketServer> {
  const server = await FixtureWebSocketServer.start(scriptOptions)
  servers.push(server)
  return server
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

describe('resident edge transport over a real socket', () => {
  it('negotiates the audited subprotocol and sends hello/auth/hb on the wire', async () => {
    const server = await start({ script: auditedScript })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const session = await connector.connect(new AbortController().signal)
    await vi.waitFor(() =>{  expect(server.frames.map(frame => frame.type)).toEqual(['hello', 'auth', 'hb']) })
    expect(server.protocolsRequested[0]).toBe('edgecompute.v8')
    expect(server.frames[0]?.raw.v).toBe('8.0')
    expect(server.frames[0]?.payload.client_version).toBe('8.0.0')
    expect(server.frames[1]?.payload.access_token).toBe('socket-fixture-token')
    expect(server.frames[2]?.payload).toMatchObject({ mode: 'paused', active_shards: 0, throttle_pct: 0 })
    await session.close()
  })

  it('carries a real offer, progress and inline result across the socket', async () => {
    const server = await start({
      script: (frame, context) => {
        auditedScript(frame, context)
        if (frame.type === 'hb' && frame.payload.mode === 'running') context.reply('shard_assign', assignment())
      },
    })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const session = await connector.connect(new AbortController().signal)
    const offers: NodeTaskOfferMessage[] = []
    session.onOffer((offer) => { offers.push(offer) })

    // One real heartbeat: the adapter republishes the audited `hb` frame with the
    // owner's mode and the load observed from the node-protocol heartbeat.
    await session.sendHeartbeat(heartbeat(1))
    await vi.waitFor(() =>{  expect(offers).toHaveLength(1) })
    await vi.waitFor(() =>{  expect(server.frames.filter(frame => frame.type === 'hb')).toHaveLength(2) })
    expect(server.frames.at(-1)?.payload).toMatchObject({ mode: 'running', load: 0.5, active_shards: 0, throttle_pct: 100 })

    const offer = offers[0]
    expect(offer?.attempt).toBe(1)
    expect(offer?.envelope.taskId).toBe('workload-1.shard-1')
    expect(offer?.signature).toBe('bridge-owned-signature-0001')
    // The lease token is the server's private credential and must not leak into
    // the offer the runtime receives.
    expect(JSON.stringify(offer)).not.toContain('server-issued-lease-token')

    await session.sendProgress({ type: 'task.progress', taskId: 'workload-1.shard-1', attempt: 1, sequence: 1, progress: 0.5, phase: 'run' })
    await vi.waitFor(() =>{  expect(server.frames.at(-1)).toMatchObject({
      type: 'shard_progress',
      payload: { shard_id: 'shard-1', attempt: 0, lease_token: 'server-issued-lease-token', pct: 0.5 },
    }) })

    await session.sendReturn({
      type: 'task.return', taskId: 'workload-1.shard-1', attempt: 1,
      outputs: [{ name: 'out.txt', bytes: 12, sha256: 'a'.repeat(64) }],
    })
    await vi.waitFor(() =>{  expect(server.frames.at(-1)).toMatchObject({
      type: 'shard_result',
      payload: {
        shard_id: 'shard-1', workload_id: 'workload-1', worker_id: 'worker-edge-1', attempt: 0,
        lease_token: 'server-issued-lease-token', ok: true, inline_output: 'result:workload-1.shard-1:1', elapsed_ms: 12,
      },
    }) })
    await session.close()
  })

  it('classifies a real auth refusal as TRANSPORT_AUTH_FAILED', async () => {
    const server = await start({
      script: (frame, context) => { if (frame.type === 'hello') context.reply('err', { code: 'AUTH_INVALID' }) },
    })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const failure = await connector.connect(new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(EdgeWorkerTransportError)
    expect(failure).toMatchObject({ code: 'TRANSPORT_AUTH_FAILED', edgeReason: 'EDGE_SERVER_REJECTED' })
  })

  it('classifies a real unsupported frame version as TRANSPORT_PROTOCOL_INVALID', async () => {
    const server = await start({
      script: (frame, context) => {
        if (frame.type === 'hello') context.sendRaw(JSON.stringify({ v: '9.0', type: 'welcome', payload: { hb_interval_s: 15 } }))
      },
    })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const failure = await connector.connect(new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'TRANSPORT_PROTOCOL_INVALID', edgeReason: 'EDGE_PROTOCOL_INVALID' })
  })

  it('classifies a refused TCP connection as TRANSPORT_NETWORK_FAILED', async () => {
    const closed = await start()
    const origin = closed.origin
    await closed.close()
    const connector = new EdgeWorkerResidentConnector(options(origin))
    const failure = await connector.connect(new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'TRANSPORT_NETWORK_FAILED', edgeReason: 'EDGE_CONNECTION_FAILED' })
  })

  it('reports a peer drop to onDisconnect with the classified code', async () => {
    const server = await start({ script: auditedScript })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const session = await connector.connect(new AbortController().signal)
    const reasons: (string | undefined)[] = []
    const closed = new Promise<void>((resolve) => { session.onDisconnect((reason) => { reasons.push(reason); resolve() }) })
    await vi.waitFor(() =>{  expect(server.frames.map(frame => frame.type)).toEqual(['hello', 'auth', 'hb']) })
    server.destroyLatest()
    await closed
    expect(reasons).toEqual(['TRANSPORT_NETWORK_FAILED'])
  })

  it('refuses every send after close instead of reporting a false success', async () => {
    const server = await start({ script: auditedScript })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const session = await connector.connect(new AbortController().signal)
    await session.close()
    await expect(session.sendHeartbeat(heartbeat())).rejects.toMatchObject({ code: 'TRANSPORT_SESSION_CLOSED' })
  })

  it('never reports progress for a task and attempt it did not deliver', async () => {
    const server = await start({ script: auditedScript })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const session = await connector.connect(new AbortController().signal)
    await expect(session.sendProgress({ type: 'task.progress', taskId: 'workload-1.shard-1', attempt: 1, sequence: 1, progress: 0.5, phase: 'run' }))
      .rejects.toMatchObject({ code: 'TRANSPORT_LEASE_NOT_ACTIVE' })
    await session.close()
  })

  it('opens no socket at all when the endpoint is absent', async () => {
    const connector = new EdgeWorkerResidentConnector(options(null))
    await expect(connector.connect(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSPORT_NOT_CONFIGURED',
      state: 'not-configured',
    })
  })

  it('refuses structurally before any socket work when the bridge is absent', async () => {
    const withoutBridge: EdgeWorkerSessionOptions = { ...options('http://127.0.0.1:1') }
    delete (withoutBridge as { bridge?: unknown }).bridge
    const connector = new EdgeWorkerResidentConnector(withoutBridge)
    await expect(connector.connect(new AbortController().signal)).rejects.toMatchObject({ code: 'TRANSPORT_BRIDGE_REQUIRED' })
  })

  it('refuses a non-loopback origin before any socket work', async () => {
    const connector = new EdgeWorkerResidentConnector(options('https://production.example'))
    await expect(connector.connect(new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSPORT_CONFIG_INVALID',
      edgeReason: 'SUPPLY_CONFIG_INVALID',
    })
  })

  it('honours an already-aborted signal without opening a socket', async () => {
    const connector = new EdgeWorkerResidentConnector(options('http://127.0.0.1:1'))
    const controller = new AbortController()
    controller.abort()
    await expect(connector.connect(controller.signal)).rejects.toMatchObject({ code: 'TRANSPORT_ABORTED' })
  })

  it('uses the fixture subprotocol echo as the only reason the handshake can succeed', async () => {
    const server = await start({ script: auditedScript, echoSubprotocol: false })
    const connector = new EdgeWorkerResidentConnector(options(server.origin))
    const failure = await connector.connect(new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    )
    // The WHATWG WebSocket client exposes no reason for a failed handshake, so a
    // refused subprotocol is observationally a connection failure. The test
    // pins the current behaviour instead of claiming a finer classification.
    expect(failure).toMatchObject({ code: 'TRANSPORT_NETWORK_FAILED' })
    expect(server.protocolsRequested).toEqual(['edgecompute.v8'])
    expect(server.protocolsEchoed).toEqual([undefined])
  })

  it('fails closed when the bridge refuses an authenticated offer', async () => {
    const server = await start({
      script: (frame, context) => {
        auditedScript(frame, context)
        if (frame.type === 'hb' && frame.payload.mode === 'running') context.reply('shard_assign', assignment())
      },
    })
    const connector = new EdgeWorkerResidentConnector(options(server.origin, {
      bridge: bridge({ toNodeOffer: () => ({ refuse: 'LOCAL_TASK_TYPE_DENIED' }) }),
    }))
    const session = await connector.connect(new AbortController().signal)
    const reasons: (string | undefined)[] = []
    const refused = new Promise<void>((resolve) => { session.onDisconnect((reason) => { reasons.push(reason); resolve() }) })
    await session.sendHeartbeat(heartbeat())
    await refused
    expect(reasons).toEqual(['TRANSPORT_OFFER_REFUSED'])
    expect(session.failure()).toMatchObject({ code: 'TRANSPORT_OFFER_REFUSED', edgeReason: 'EDGE_OFFER_REFUSED:LOCAL_TASK_TYPE_DENIED' })
  })
})
