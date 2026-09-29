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
import { ResidentNodeRuntime } from '../../src/resident/runtime.ts'
import type { ResidentRuntimeConfig } from '../../src/resident/types.ts'
import {
  EdgeWorkerResidentConnector,
  EdgeWorkerTransportError,
  type EdgeSessionBridge,
  type EdgeWorkerSessionOptions,
} from '../../src/transport/edge-worker-session.ts'
import { createInlineEdgeBinding } from '../../src/transport/inline-edge-bridge.ts'
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
  it('reconnects an idle runtime and sends a fresh Hello snapshot on the second socket', async () => {
    const server = await start({ script: auditedScript })
    let digest = `sha256:${'a'.repeat(64)}`
    const adapter = () => ({
      task_type: 'word_count', capability_id: 'word.count', input_kinds: ['inline'],
      output_kind: 'inline_json', contract_version: 'v1', artifact_digest: digest,
      installation_state: 'builtin', health: 'verified', self_test: 'passed',
    })
    const config = {
      nodeId: 'node-edge-1', agentVersion: 'agent-0.1.0',
      policy: {
        mode: 'BACKGROUND_ONLY', maxConcurrency: 1, maxCpuPercent: 80, maxGpuPercent: 80,
        maxTemperatureC: 85, minDiskFreeBytes: 1_000, allowWhileUserActive: false,
      },
      observer: { snapshot: async () => ({ snapshot: {}, heartbeat: heartbeat(0) }) },
      capabilities: { listCapabilities: () => [] },
      connector: {
        connect: (signal: AbortSignal) => new EdgeWorkerResidentConnector(options(server.origin, {
          capabilities: { runtime: 'node', verified_task_adapters: [adapter()] },
          protocolCapabilities: ['assignment-token.v1', 'task-adapters.v1'],
        })).connect(signal),
      },
      port: { verifyOffer: async () => ({ accepted: false }), advertise: async () => undefined },
      workspace: { createWorkspace: async () => ({ close: async () => undefined }) },
      resultConsumer: { consume: async () => ({ outputs: [] }) },
    } as unknown as ResidentRuntimeConfig
    const runtime = new ResidentNodeRuntime(config)
    try {
      await runtime.start()
      await vi.waitFor(() => { expect(server.frames.filter(frame => frame.type === 'hello')).toHaveLength(1) })
      digest = `sha256:${'b'.repeat(64)}`
      await expect(runtime.refreshSessionWhenIdle()).resolves.toBe('refreshed')
      await vi.waitFor(() => { expect(server.frames.filter(frame => frame.type === 'hello')).toHaveLength(2) })
      const hellos = server.frames.filter(frame => frame.type === 'hello')
      expect(hellos.map(frame => frame.connection)).toEqual([0, 1])
      expect(hellos.map(frame => (frame.payload.capabilities as { verified_task_adapters: { artifact_digest: string }[] }).verified_task_adapters[0]?.artifact_digest))
        .toEqual([`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`])
      expect(hellos[1]?.payload.protocol_capabilities).toContain('task-adapters.v1')
    } finally {
      await runtime.stop('test teardown')
    }
  })

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

  it('closes a real socket whose peer stops acknowledging heartbeats, with a classified reason', async () => {
    // 服务端在 `welcome` 里自己声明 hb_timeout_s=1：此后一个 hb_ack 都不回（平台侧被杀的
    // 网关进程 / 半死 socket 就是这个形状）。节点必须按这个窗口关链，让上层重连，
    // 而不是抱着一条「写得进、读不回」的会话继续等派单。
    const server = await start({
      script: (frame, context) => {
        if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 15, hb_timeout_s: 1 })
        if (frame.type === 'auth') context.reply('auth_ok', { worker_id: 'worker-edge-1', owner_id: 7, welcome_back: false })
      },
    })
    const connector = new EdgeWorkerResidentConnector(options(server.origin, { clock: () => Date.now() }))
    const session = await connector.connect(new AbortController().signal)
    const disconnect = new Promise<string | undefined>((resolve) => { session.onDisconnect(reason => resolve(reason)) })
    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(60)
      await session.sendHeartbeat(heartbeat())
      await vi.advanceTimersByTimeAsync(1_100)
      expect(await disconnect).toBe('TRANSPORT_NETWORK_FAILED')
      expect(session.failure()).toEqual({ code: 'TRANSPORT_NETWORK_FAILED', edgeReason: 'EDGE_HEARTBEAT_TIMEOUT' })
    } finally { vi.useRealTimers() }
    await session.close()
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

  it('returns remembered inline bytes over a real socket instead of inventing them from the task id', async () => {
    const sessionKey = Buffer.alloc(32, 5)
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1',
      allowedTaskTypes: ['word_count'],
      maxOutputBytes: 4096,
      sessionKey,
    })
    const server = await start({
      script: (frame, context) => {
        auditedScript(frame, context)
        if (frame.type === 'hb' && frame.payload.mode === 'running') context.reply('shard_assign', assignment())
      },
    })
    const connector = new EdgeWorkerResidentConnector(options(server.origin, { bridge: binding.bridge }))
    const session = await connector.connect(new AbortController().signal)
    const offers: NodeTaskOfferMessage[] = []
    session.onOffer((offer) => { offers.push(offer) })
    await session.sendHeartbeat(heartbeat(1))
    await vi.waitFor(() => { expect(offers).toHaveLength(1) })
    const mapped = offers[0]
    expect(mapped?.signature).toMatch(/^[a-f0-9]{64}$/u)
    expect(mapped?.signature).not.toBe('bridge-owned-signature-0001')
    binding.rememberResult(mapped!.envelope.taskId, '真实回传\n', 19)
    await session.sendReturn({
      type: 'task.return', taskId: mapped!.envelope.taskId, attempt: mapped!.attempt,
      outputs: [{ name: 'result.txt', bytes: 13, sha256: 'a'.repeat(64) }],
    })
    await vi.waitFor(() => { expect(server.frames.at(-1)?.type).toBe('shard_result') })
    expect(server.frames.at(-1)?.payload).toMatchObject({
      inline_output: '真实回传\n', elapsed_ms: 19, lease_token: 'server-issued-lease-token',
    })
    await session.close()
  })

  it('uploads one media object directly and returns only its lease-bound artifact.v1 reference', async () => {
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['bar_chart_svg_v1'],
      maxOutputBytes: 4096, artifactTaskType: 'bar_chart_svg_v1',
      artifactMaxOutputBytes: 16 * 1024 * 1024,
    })
    const server = await start({ script: (frame, context) => {
      auditedScript(frame, context)
      if (frame.type === 'hb' && frame.payload.mode === 'running') context.reply('shard_assign', assignment({
        task_type: 'bar_chart_svg_v1', capability: 'video.render',
        inline_input: '{"kind":"bar_chart_svg_v1"}', params: { output_format: 'mp4' },
      }))
    } })
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      if (calls.length === 1) {
        const posted = JSON.parse(String(init?.body))
        expect(posted).toMatchObject({ shard_id: 'shard-1', worker_id: 'worker-edge-1',
          lease_token: 'server-issued-lease-token', content_type: 'video/mp4' })
        expect(String(init?.body)).not.toContain('ftyp')
        return Response.json({ schema_version: 'artifact.v1', method: 'PUT',
          object_key: `v8/account-42/workload-workload-1/shard-shard-1/result/${posted.result_id}/result.mp4`,
          upload_url: 'https://oss.example.test/put?signature=opaque',
          headers: { 'content-type': 'video/mp4',
            'x-amz-checksum-sha256': Buffer.from(posted.sha256, 'hex').toString('base64') },
          expires_at: Math.floor(Date.now() / 1000) + 600 })
      }
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'oss-version-1' } })
    }
    const connector = new EdgeWorkerResidentConnector(options(server.origin, {
      bridge: binding.bridge, allowedTaskTypes: ['bar_chart_svg_v1'], artifactFetch: fetcher,
    }))
    const session = await connector.connect(new AbortController().signal)
    const offers: NodeTaskOfferMessage[] = []
    session.onOffer(offer => { offers.push(offer) })
    await session.sendHeartbeat(heartbeat(1))
    await vi.waitFor(() => expect(offers).toHaveLength(1))
    const offered = offers[0]!
    expect(offered.envelope.capabilityId).toBe('video.render')
    expect(offered.envelope.parameters).toMatchObject({ taskParams: { output_format: 'mp4' } })
    const bytes = Buffer.from('0000ftyp-media-byte-fixture')
    const manifest = await session.uploadArtifact(offered.envelope.taskId, offered.attempt,
      { filename: 'result.mp4', contentType: 'video/mp4', bytes })
    expect(manifest.account_id).toBe(42)
    expect(manifest.object_version_id).toBe('oss-version-1')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toContain('oss.example.test')
    expect(new Headers(calls[1]?.init.headers).has('authorization')).toBe(false)
    expect(Buffer.from(calls[1]?.init.body as Buffer)).toEqual(bytes)
    binding.rememberArtifact(offered.envelope.taskId, manifest, 19)
    await session.sendReturn({ type: 'task.return', taskId: offered.envelope.taskId,
      attempt: offered.attempt, outputs: [{ name: 'result.mp4', bytes: bytes.length,
        sha256: manifest.sha256 }] })
    await vi.waitFor(() => expect(server.frames.at(-1)?.type).toBe('shard_result'))
    const returned = server.frames.at(-1)?.payload
    expect(returned).toMatchObject({ artifact: manifest, output_ref: JSON.stringify(manifest),
      lease_token: 'server-issued-lease-token', ok: true, elapsed_ms: 19 })
    expect(returned).not.toHaveProperty('inline_output')
    await session.close()
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

  it('reports a bridge refusal on the wire and keeps the session usable', async () => {
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
    session.onDisconnect((reason) => { reasons.push(reason) })
    await session.sendHeartbeat(heartbeat())
    // 线上实测：回帧后立刻关连接会让平台丢掉拒绝原因（分片退回 PENDING、error 为空），
    // 所以这里断言「一帧带稳定码的拒绝」+「会话仍然活着」。
    await vi.waitFor(() => expect(server.frames.filter(frame => frame.type === 'shard_result')).toHaveLength(1))
    const refusal = server.frames.find(frame => frame.type === 'shard_result')!
    expect(refusal.payload).toMatchObject({
      ok: false,
      failure_class: 'EDGE_OFFER_REFUSED_LOCAL_TASK_TYPE_DENIED',
      shard_id: 'shard-1',
      lease_token: 'server-issued-lease-token',
    })
    expect(String(refusal.payload.error)).toContain('LOCAL_TASK_TYPE_DENIED')
    expect(reasons).toEqual([])
    expect(session.state()).toBe('ready')
    expect(session.failure()).toBeNull()
    // 会话还能继续发心跳（没有进入 failed/closed）。
    await session.sendHeartbeat(heartbeat())
    await session.close()
  })
})
