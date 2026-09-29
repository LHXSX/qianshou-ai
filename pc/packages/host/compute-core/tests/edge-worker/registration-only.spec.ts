import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeWorkerConnection, type EdgeWorkerOptions } from '../../src/edge-worker/connection.ts'
import { EdgeWorkerResidentSession } from '../../src/transport/edge-worker-session.ts'
import { ComputeNodeId, type NodeTaskOfferMessage } from '../../src/node-protocol.ts'
import { ComputeCapabilityId, ComputeTaskId } from '../../src/protocol.ts'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } from '../../src/native-h3-binding.ts'
import { FixtureWebSocketServer } from '../transport/fixture-ws-server.ts'

const servers: FixtureWebSocketServer[] = []
const connections: EdgeWorkerConnection[] = []
const sessions: EdgeWorkerResidentSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()))
  await Promise.all(connections.splice(0).map(connection => connection.close()))
  await Promise.all(servers.splice(0).map(server => server.close()))

})

const observation = {
  challengeNonce: 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b',
  inputDigest: `sha256:${'a'.repeat(64)}`, outputDigest: `sha256:${'b'.repeat(64)}`,
  runtimeDigest: `sha256:${'c'.repeat(64)}`, artifactDigest: `sha256:${'d'.repeat(64)}`,
}
const offer = {
  workload_id: 'workload-registration', shard_id: 'shard-registration', attempt: 0,
  task_type: 'word_count', runtime: 'python3', input_kind: 'inline', inline_input: 'untrusted',
  input_ref: '', input_refs: [], code_url: '', code_sha256: '', timeout_s: 60,
  verification_policy: 'semantic', execution_model: '', capability: '', capability_version: '',
  lease_token: 'test-lease',
}
function options(origin = 'http://127.0.0.1:18941'): EdgeWorkerOptions {
  return { origin, tokenProvider: () => 'test-token', expectedOwnerId: 167,
    name: 'test', clientBuild: 'source-test', os: 'test', arch: 'test',
    capabilities: { provided_capabilities: [], verified_task_adapters: [] },
    allowedTaskTypes: [], registrationOnly: true,
    handshakeTimeoutMs: 2_000, maxFrameBytes: 65_536, maxOutputBytes: 4096,
    readLoad: () => 0, onOffer: vi.fn(async () => undefined), onEvent: vi.fn() }
}
async function server(ownerId = 167, acknowledgeChallenge = true): Promise<FixtureWebSocketServer> {
  const fixture = await FixtureWebSocketServer.start({ script(frame, peer) {
    if (frame.type === 'hello') peer.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') peer.reply('auth_ok', { worker_id: 'worker-registration', owner_id: ownerId })
    if (frame.type === 'hb') peer.reply('hb_ack', {})
    if (frame.type === 'order_adapter_challenge_result' && acknowledgeChallenge) {
      peer.reply('order_adapter_challenge_ack', { challenge_nonce: frame.payload.challenge_nonce })
    }
  } })
  servers.push(fixture)
  return fixture
}

describe('authenticated empty dynamic registration over a real socket', () => {
  it('keeps withdrawn native load bounded by this authenticated session retained leases', async () => {
    const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const fixture = await FixtureWebSocketServer.start({ script(frame, peer) {
      if (frame.type === 'hello') peer.reply('welcome', { hb_interval_s: 60 })
      if (frame.type === 'auth') peer.reply('auth_ok', { worker_id: 'worker-registration', owner_id: 167,
        connection_id: connectionId })
      if (frame.type === 'hb') peer.reply('hb_ack', {})
      if (frame.type === 'native_h3_adapter_update') peer.reply('native_h3_adapter_update_ack', {
        request_id: frame.payload.request_id, connection_id: connectionId, status: 'accepted',
        task_types: (frame.payload.adapters as { task_type: string }[]).map(item => item.task_type),
      })
    } }); servers.push(fixture)
    const { origin, onOffer: _offer, onEvent: _event, readLoad: _load, ...config } = options(fixture.origin)
    let supply: 'paused' | 'running' = 'paused'
    const offers: NodeTaskOfferMessage[] = []
    const session = new EdgeWorkerResidentSession({ ...config, endpoint: origin, supply: () => supply,
      bridge: { toNodeOffer: (input, context) => ({ type: 'task.offer', attempt: input.attempt + 1,
        receivedAt: context.receivedAt, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), signature: 'fixture-signature',
        envelope: { version: 'qianshou.task.v1', taskId: ComputeTaskId(`${input.workloadId}.${input.shardId}`),
          capabilityId: ComputeCapabilityId('video.render'), capabilityVersion: 'v1', inputRefs: [], parameters: {},
          deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxOutputBytes: 4096,
          idempotencyKey: `${input.workloadId}:${input.shardId}` } }),
      toEdgeResult: () => ({ inlineOutputUtf8: 'fixture transport result', elapsedMs: 1 }) } })
    sessions.push(session); session.onOffer((input) => { offers.push(input) }); await session.open()
    const heartbeat = { version: 'qianshou.node.v1' as const, nodeId: ComputeNodeId('test-node'),
      agentVersion: 'test', sentAt: new Date().toISOString(), capabilities: [], maxConcurrency: 2, runningTasks: 1 }
    await expect(session.sendHeartbeat(heartbeat)).rejects.toThrow('EDGE_REGISTRATION_ONLY')
    await session.updateNativeH3Adapters({ requestId: '11111111-1111-4111-8111-111111111111', adapters: [{
      task_type: 'qianshou_h3_fixture_v1', capability_id: 'video.render', input_kinds: ['inline'], output_kind: 'artifact_ref',
      contract_version: 'v1', artifact_digest: 'sha256:' + 'a'.repeat(64), package_digest: 'sha256:' + 'b'.repeat(64),
      installation_state: 'installed', health: 'verified', self_test: 'passed',
      publication_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', contract_sha256: 'c'.repeat(64),
      device_proof_sha256: 'd'.repeat(64), native_binding: { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
        ownerConfigDigest: 'sha256:' + 'b'.repeat(64), executionRecipeSha256: 'e'.repeat(64), modelSha256: 'f'.repeat(64) },
    }] })
    supply = 'running'; await session.sendHeartbeat({ ...heartbeat, runningTasks: 0 })
    fixture.send('shard_assign', { ...offer, task_type: 'qianshou_h3_fixture_v1' })
    await vi.waitFor(() => { expect(offers).toHaveLength(1) })
    supply = 'paused'
    await session.updateNativeH3Adapters({ requestId: '22222222-2222-4222-8222-222222222222', adapters: [] })
    await session.sendHeartbeat(heartbeat)
    await vi.waitFor(() => { expect(fixture.frames.at(-1)?.payload).toMatchObject({ mode: 'paused', active_shards: 1 }) })
    await expect(session.sendHeartbeat({ ...heartbeat, runningTasks: 2 })).rejects.toThrow('EDGE_REGISTRATION_ONLY')
    await expect(session.sendHeartbeat({ ...heartbeat, capabilities: [{ capabilityId: ComputeCapabilityId('video.render'),
      version: 'v1', pluginDigest: 'a'.repeat(64) }] })).rejects.toThrow('EDGE_REGISTRATION_ONLY')
    supply = 'running'; await expect(session.sendHeartbeat(heartbeat)).rejects.toThrow('EDGE_REGISTRATION_ONLY'); supply = 'paused'
    fixture.send('shard_assign', { ...offer, task_type: 'qianshou_h3_fixture_v1', shard_id: 'new-shard' })
    await vi.waitFor(() => { expect(fixture.frames.find(frame => frame.type === 'shard_result'
      && frame.payload.shard_id === 'new-shard')?.payload).toMatchObject({ failure_class: 'EDGE_TASK_SCOPE_DENIED' }) })
    expect(offers).toHaveLength(1)
    const retained = offers[0]
    if (retained === undefined) throw new Error('Expected a real retained offer')
    await session.sendReturn({ type: 'task.return', taskId: retained.envelope.taskId, attempt: retained.attempt, outputs: [] })
    await expect(session.sendHeartbeat(heartbeat)).rejects.toThrow('EDGE_REGISTRATION_ONLY')
    await session.sendHeartbeat({ ...heartbeat, runningTasks: 0 })
    expect(session.state()).toBe('ready'); expect(fixture.connectionCount).toBe(1)
  })
  it('keeps static empty configuration closed and rejects an executable registration claim', () => {
    const { registrationOnly: _registration, ...staticEmpty } = options()
    expect(() => new EdgeWorkerConnection(staticEmpty)).toThrow('EDGE_WORKER_CONFIG_INVALID')
    expect(() => new EdgeWorkerConnection({ ...options(), allowedTaskTypes: ['word_count'] }))
      .toThrow('EDGE_WORKER_CONFIG_INVALID')
    for (const capabilities of [ {}, { provided_capabilities: ['text.transform'], verified_task_adapters: [] },
      { provided_capabilities: [], verified_task_adapters: [{ task_type: 'word_count' }] },
      { ...options().capabilities, protocol: 'legacy-executor' } ]) {
      expect(() => new EdgeWorkerConnection({ ...options(), capabilities })).toThrow('EDGE_WORKER_CONFIG_INVALID')
    }
  })

  it('authenticates the owner and records a challenge while every heartbeat is paused and every offer refused', async () => {
    const fixture = await server()
    const config = { ...options(fixture.origin), capabilities: { ...options().capabilities,
      gpu_count: 1, gpu_model: 'fixture RTX 5080', vram_mb: 16384,
      runtimes: ['python3'], software: ['python3'], supported_executors: ['native'] } }
    const connection = new EdgeWorkerConnection(config)
    connections.push(connection)
    await connection.connect()
    expect(config.onEvent).toHaveBeenCalledWith({ type: 'authenticated', workerId: 'worker-registration', ownerId: 167 })
    const hello = fixture.frames.find(frame => frame.type === 'hello')!
    // Measured metadata and legacy labels alone cannot activate any execution or lease scope.
    expect(hello.payload.capabilities).toEqual(config.capabilities)
    expect(hello.payload.capabilities).toMatchObject({ provided_capabilities: [], verified_task_adapters: [] })
    expect(hello.payload).not.toHaveProperty('registrationOnly')
    expect(hello.payload).not.toHaveProperty('registration_only')
    expect(() => { connection.updateMode('running') }).toThrow('EDGE_REGISTRATION_ONLY')
    connection.updateMode('paused')
    await connection.observeOrderAdapterChallenge(observation)
    expect(fixture.frames.find(frame => frame.type === 'order_adapter_challenge_result')?.payload)
      .toMatchObject({ challenge_nonce: observation.challengeNonce, artifact_digest: observation.artifactDigest })
    fixture.send('shard_assign', offer)
    await vi.waitFor(() => {
      expect(fixture.frames.some(frame => frame.type === 'shard_result'
        && frame.payload.failure_class === 'EDGE_TASK_SCOPE_DENIED')).toBe(true)
    })
    expect(config.onOffer).not.toHaveBeenCalled()
    expect(fixture.frames.filter(frame => frame.type === 'hb').every(frame => frame.payload.mode === 'paused')).toBe(true)
    expect(() => {
      connection.reportProgress({ workloadId: offer.workload_id, shardId: offer.shard_id,
        workerId: 'worker-registration', attempt: 0 }, 0.5)
    }).toThrow()
  })

  it('refuses another account and aborts a pending observation with the socket lifetime', async () => {
    const wrongOwner = await server(168)
    const denied = new EdgeWorkerConnection(options(wrongOwner.origin))
    connections.push(denied)
    await expect(denied.connect()).rejects.toThrow('EDGE_PROTOCOL_INVALID')
    const fixture = await server(167, false)
    const connection = new EdgeWorkerConnection(options(fixture.origin))
    connections.push(connection)
    const abort = new AbortController()
    await connection.connect(abort.signal)
    const pending = connection.observeOrderAdapterChallenge(observation)
    const rejected = expect(pending).rejects.toThrow('EDGE_ABORTED')
    abort.abort()
    await rejected
  })
  it('refuses an active running request at the resident seam without losing authenticated challenge access', async () => {
    const fixture = await server()
    const { origin, onOffer: _offer, onEvent: _event, readLoad: _load, ...config } = options(fixture.origin)
    let supply: 'running' | 'paused' = 'running'
    const bridge = { toNodeOffer: vi.fn(() => { throw new Error('no offer may cross registration') }),
      toEdgeResult: vi.fn(() => { throw new Error('no result may cross registration') }) }
    const session = new EdgeWorkerResidentSession({ ...config, endpoint: origin, supply: () => supply, bridge })
    sessions.push(session)
    await session.open()
    const heartbeat = { version: 'qianshou.node.v1' as const, nodeId: ComputeNodeId('test-node'),
      agentVersion: 'test', sentAt: new Date().toISOString(), capabilities: [], maxConcurrency: 1, runningTasks: 0 }
    await expect(session.sendHeartbeat(heartbeat)).rejects.toThrow('EDGE_REGISTRATION_ONLY')
    expect(session.state()).toBe('ready')
    await session.observeOrderAdapterChallenge(observation)
    supply = 'paused'
    await expect(session.sendHeartbeat({ ...heartbeat, runningTasks: 1 })).rejects.toThrow('EDGE_REGISTRATION_ONLY')
    await session.sendHeartbeat(heartbeat)
    expect(fixture.frames.filter(frame => frame.type === 'hb').every(frame => frame.payload.mode === 'paused')).toBe(true)
    fixture.send('shard_assign', offer)
    await vi.waitFor(() => {
      expect(fixture.frames.some(frame => frame.type === 'shard_result'
        && frame.payload.failure_class === 'EDGE_TASK_SCOPE_DENIED')).toBe(true)
    })
    expect(bridge.toNodeOffer).not.toHaveBeenCalled()
    expect(bridge.toEdgeResult).not.toHaveBeenCalled()
  })
})
