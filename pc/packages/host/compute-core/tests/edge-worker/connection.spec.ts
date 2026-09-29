import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspect } from 'node:util'
import { createHash } from 'node:crypto'
import { EdgeWorkerConnection, type EdgeWorkerOptions } from '../../src/edge-worker/connection.ts'
import type { EdgeTaskOffer } from '../../src/edge-worker/types.ts'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_V2, nativeH3LogicalBindingSha256 } from '../../src/native-h3-binding.ts'

class FixtureSocket extends EventTarget {
  static OPEN = 1
  static latest: FixtureSocket
  /** 平台 `welcome` 里是否带 hb_timeout_s：带 ⇒ 用它做 ack 截止；不带 ⇒ 退回 3 × 心跳周期。 */
  static timeoutSeconds: number | undefined
  /** 平台 `welcome.hb_interval_s`（生产实测 15）。 */
  static intervalSeconds = 15
  /** 置 true 后 fixture 不再回 hb_ack —— 对端「半死不回」。 */
  static muteHeartbeatAcks = false
  static connectionId: string | undefined
  readyState = 1
  sent: { type: string; payload: Record<string, unknown> }[] = []
  constructor() { super(); FixtureSocket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
  send(data: string) {
    const frame = JSON.parse(data) as { type: string; payload: Record<string, unknown> }; this.sent.push(frame)
    if (frame.type === 'hello') this.reply('welcome', {
      hb_interval_s: FixtureSocket.intervalSeconds,
      ...(FixtureSocket.timeoutSeconds === undefined ? {} : { hb_timeout_s: FixtureSocket.timeoutSeconds }),
    })
    if (frame.type === 'auth') this.reply('auth_ok', { worker_id: 'worker-1', owner_id: 2,
      ...(FixtureSocket.connectionId === undefined ? {} : { connection_id: FixtureSocket.connectionId }) })
    if (frame.type === 'hb' && !FixtureSocket.muteHeartbeatAcks) this.reply('hb_ack', {})
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  reply(type: string, payload: Record<string, unknown>) { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ v: '8.0', type, payload }) }))) }
}
const payload = { workload_id: 'workload-1', shard_id: 'shard-1', attempt: 0, task_type: 'word_count', runtime: 'python3', input_kind: 'inline',
  inline_input: 'untrusted task data', input_ref: '', input_refs: [], code_url: 'https://untrusted.example/script.py', code_sha256: '',
  timeout_s: 60, verification_policy: 'semantic', execution_model: '', capability: '', capability_version: '', lease_token: 'fixture-private-lease' }
function setup(extra: Partial<EdgeWorkerOptions> = {}) {
  const onOffer = vi.fn(async (_offer: EdgeTaskOffer, _signal: AbortSignal) => {})
  const onEvent = vi.fn()
  const connection = new EdgeWorkerConnection({ origin: 'http://127.0.0.1:18941', tokenProvider: () => 'fixture-token', expectedOwnerId: 2,
    name: 'test', clientBuild: 'test', os: 'test', arch: 'test', capabilities: {}, allowedTaskTypes: ['word_count'],
    handshakeTimeoutMs: 1000, maxFrameBytes: 65536, maxOutputBytes: 4096, readLoad: () => 0, onOffer, onEvent, ...extra })
  return { connection, onOffer, onEvent }
}
function reviewedVideoUpdate(connectionId: string) {
  const requestId = '44444444-4444-4444-8444-444444444444'
  const publicationId = '55555555-5555-4555-8555-555555555555'
  const digest = `sha256:${'a'.repeat(64)}`
  const probe = Buffer.from(JSON.stringify({ schema: 'qianshou.reviewed-video-host-probe.v1',
    worker_id: 'worker-1', connection_id: connectionId, owner_account_id: 2,
    publication_id: publicationId, device_key_id: 'device-1', task_type: 'reviewed_video_v1',
    capability_id: 'video.render', input_kind: 'multi_file', output_kind: 'artifact_ref',
    approved_contract_digest: digest }), 'utf8')
  return { request_id: requestId, publication_id: publicationId,
    worker_id: 'worker-1', connection_id: connectionId, device_key_id: 'device-1',
    probe_payload_b64u: probe.toString('base64url'),
    device_signature_b64u: Buffer.alloc(64, 1).toString('base64url'),
    sample_attestation: { key_id: 'guangzhou-1',
      payload: { schema: 'qianshou.reviewed-video-sample-attestation.v1',
        purpose: 'qianshou.reviewed-video-sample-attestation.v1',
        probe_sha256: `sha256:${createHash('sha256').update(probe).digest('hex')}`,
        task_type: 'reviewed_video_v1', device_key_id: 'device-1' },
      signature: Buffer.alloc(64, 2).toString('base64url') } }
}
beforeEach(() => {
  vi.stubGlobal('WebSocket', FixtureSocket)
  FixtureSocket.timeoutSeconds = undefined
  FixtureSocket.intervalSeconds = 15
  FixtureSocket.muteHeartbeatAcks = false
  FixtureSocket.connectionId = undefined
})
afterEach(() => vi.unstubAllGlobals())
describe('audited Edge worker transport', () => {
  it('requires an explicit reviewed-video protocol and accepts only the exact same-socket ACK', async () => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    const withoutCapability = setup().connection
    await withoutCapability.connect()
    const request = reviewedVideoUpdate(FixtureSocket.connectionId)
    expect(() => withoutCapability.updateReviewedVideoAdapter(request)).toThrow('EDGE_REVIEWED_VIDEO_UPDATE_INVALID')
    await withoutCapability.close()

    const { connection, onOffer } = setup({ protocolCapabilities: ['reviewed-video-supply.v1'] })
    await connection.connect()
    try {
      connection.updateMode('running')
      expect(connection.reviewedVideoAdapterTaskType()).toBeNull()
      FixtureSocket.latest.reply('shard_assign', { ...payload,
        task_type: 'reviewed_video_v1', shard_id: 'reviewed-before-ack' })
      await vi.waitFor(() => { expect(FixtureSocket.latest.sent.some(frame => frame.type === 'shard_result'
        && frame.payload.failure_class === 'EDGE_TASK_SCOPE_DENIED')).toBe(true) })
      expect(onOffer).not.toHaveBeenCalled()
      const pending = connection.updateReviewedVideoAdapter(request)
      expect(FixtureSocket.latest.sent.at(-1)).toEqual({ v: '8.0', type: 'reviewed_video_adapter_update',
        payload: { request_id: request.request_id, publication_id: request.publication_id,
          worker_id: request.worker_id, connection_id: request.connection_id, device_key_id: request.device_key_id,
          probe_payload_b64u: request.probe_payload_b64u,
          device_signature_b64u: request.device_signature_b64u,
          sample_attestation: request.sample_attestation } })
      FixtureSocket.latest.reply('reviewed_video_adapter_update_ack', {
        request_id: '11111111-1111-4111-8111-111111111111', connection_id: request.connection_id,
        status: 'accepted', publication_id: request.publication_id,
        task_type: 'reviewed_video_v1', approved_contract_digest: `sha256:${'a'.repeat(64)}` })
      FixtureSocket.latest.reply('reviewed_video_adapter_update_ack', {
        request_id: request.request_id, connection_id: request.connection_id,
        status: 'accepted', publication_id: request.publication_id,
        task_type: 'reviewed_video_v1', approved_contract_digest: `sha256:${'a'.repeat(64)}` })
      await expect(pending).resolves.toMatchObject({ status: 'accepted', request_id: request.request_id })
      expect(connection.nativeH3AdapterTaskTypes()).toEqual([])
      expect(connection.reviewedVideoAdapterTaskType()).toBe('reviewed_video_v1')
      FixtureSocket.latest.reply('shard_assign', { ...payload,
        task_type: 'reviewed_video_v1', shard_id: 'reviewed-after-ack' })
      await vi.waitFor(() => { expect(onOffer).toHaveBeenCalledOnce() })
    } finally { await connection.close() }
  })
  it.each(['rejected', 'wrong-connection', 'wrong-contract'] as const)(
    'refuses a reviewed-video %s ACK without granting task scope', async (failure) => {
      FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
      const { connection } = setup({ protocolCapabilities: ['reviewed-video-supply.v1'] })
      await connection.connect()
      try {
        const request = reviewedVideoUpdate(FixtureSocket.connectionId)
        const pending = connection.updateReviewedVideoAdapter(request)
        const rejected = expect(pending).rejects.toThrow('EDGE_REVIEWED_VIDEO_UPDATE_REJECTED')
        FixtureSocket.latest.reply('reviewed_video_adapter_update_ack', {
          request_id: request.request_id,
          connection_id: failure === 'wrong-connection' ? '11111111-1111-4111-8111-111111111111' : request.connection_id,
          status: failure === 'rejected' ? 'rejected' : 'accepted', publication_id: request.publication_id,
          task_type: 'reviewed_video_v1',
          approved_contract_digest: `sha256:${(failure === 'wrong-contract' ? 'b' : 'a').repeat(64)}` })
        await rejected
        expect(connection.nativeH3AdapterTaskTypes()).toEqual([])
        expect(connection.reviewedVideoAdapterTaskType()).toBeNull()
      } finally { await connection.close() }
    })
  it('synchronizes exactly sixteen-field v2 claims and witnesses config CAS on the same socket', async () => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    const { connection } = setup()
    try {
      await connection.connect()
      const nativeBinding = { schema: 'qianshou.native-h3-execution-binding.v2' as const,
        runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
        executionRecipeSha256: 'e'.repeat(64), modelSha256: 'f'.repeat(64), firstFrameSha256: 'c'.repeat(64) }
      const claim = { task_type: 'qianshou_h3_fixture_v2', capability_id: 'video.render' as const,
        input_kinds: ['inline'] as const, output_kind: 'artifact_ref' as const, contract_version: 'v2' as const,
        artifact_digest: 'sha256:' + 'a'.repeat(64), package_digest: 'sha256:' + nativeH3LogicalBindingSha256(nativeBinding),
        installation_state: 'installed' as const, health: 'verified' as const, self_test: 'passed' as const,
        publication_id: '4a7a9f87-2a56-4a96-ae33-490e2f39971f', contract_sha256: 'c'.repeat(64),
        device_proof_sha256: 'd'.repeat(64), native_binding: nativeBinding,
        local_owner_config_digest: 'sha256:' + '9'.repeat(64), device_binding_revision: 1 }
      expect(Object.keys(claim)).toHaveLength(16)
      const requestId = '11111111-1111-4111-8111-111111111111'
      const pending = connection.updateNativeH3Adapters({ requestId, adapters: [claim] })
      const frame = FixtureSocket.latest.sent.at(-1)
      expect(frame?.type).toBe('native_h3_adapter_update')
      expect(Buffer.byteLength(JSON.stringify(frame?.payload))).toBeLessThanOrEqual(32 * 1024)
      expect(connection.nativeH3AdapterTaskTypes()).toEqual([])
      FixtureSocket.latest.reply('native_h3_adapter_update_ack', { request_id: requestId,
        connection_id: FixtureSocket.connectionId, status: 'accepted', task_types: [claim.task_type] })
      await pending
      expect(connection.nativeH3AdapterTaskTypes()).toEqual([claim.task_type])
      expect(() => connection.updateNativeH3Adapters({ requestId, adapters: [{ ...claim, device_binding_revision: 0 }] })).toThrow()
      expect(() => connection.updateNativeH3Adapters({ requestId, adapters: Array.from({ length: 17 }, (_, n) =>
        ({ ...claim, task_type: `qianshou_h3_fixture_${n}_v2` })) })).toThrow()
      const signature = Buffer.alloc(64, 1).toString('base64url')
      const witnessed = connection.observeNativeH3DeviceConfigProof({ challengeId: requestId, signature })
      expect(FixtureSocket.latest.sent.at(-1)).toEqual({ v: '8.0', type: 'native_h3_device_config_proof',
        payload: { challenge_id: requestId, signature } })
      FixtureSocket.latest.reply('native_h3_device_config_proof_ack', { challenge_id: requestId })
      await witnessed
    } finally { await connection.close() }
  })
  it('admits fixed native metadata only after the same UUID socket accepts the exact request and task set', async () => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    const { connection, onOffer } = setup()
    await connection.connect()
    const requestId = '4a7a9f87-2a56-4a96-ae33-490e2f39971f'
    const claim = { task_type: 'qianshou_h3_fixture_v1', capability_id: 'video.render' as const,
      input_kinds: ['inline'] as const, output_kind: 'artifact_ref' as const, contract_version: 'v1' as const,
      artifact_digest: `sha256:${'a'.repeat(64)}`, package_digest: `sha256:${'b'.repeat(64)}`,
      installation_state: 'installed' as const, health: 'verified' as const, self_test: 'passed' as const,
      publication_id: requestId, contract_sha256: 'c'.repeat(64), device_proof_sha256: 'd'.repeat(64),
      native_binding: { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
        ownerConfigDigest: `sha256:${'b'.repeat(64)}`, executionRecipeSha256: 'e'.repeat(64), modelSha256: 'f'.repeat(64) } }
    let accepted = false
    const pending = connection.updateNativeH3Adapters({ requestId, adapters: [claim] }).then(() => { accepted = true })
    expect(connection.nativeH3AdapterTaskTypes()).toEqual([])
    FixtureSocket.latest.reply('native_h3_adapter_update_ack', { request_id: '11111111-1111-4111-8111-111111111111',
      connection_id: FixtureSocket.connectionId, status: 'accepted', task_types: [claim.task_type] })
    await new Promise(resolve => setImmediate(resolve)); expect(accepted).toBe(false)
    FixtureSocket.latest.reply('native_h3_adapter_update_ack', { request_id: requestId,
      connection_id: FixtureSocket.connectionId, status: 'accepted', task_types: [claim.task_type] })
    await pending
    expect(connection.nativeH3AdapterTaskTypes()).toEqual([claim.task_type])
    connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...payload, task_type: claim.task_type })
    await new Promise(resolve => setImmediate(resolve)); expect(onOffer).toHaveBeenCalledOnce()
    const withdrawal = connection.updateNativeH3Adapters({ requestId, adapters: [] })
    expect(connection.nativeH3AdapterTaskTypes()).toEqual([])
    FixtureSocket.latest.reply('native_h3_adapter_update_ack', { request_id: requestId,
      connection_id: FixtureSocket.connectionId, status: 'accepted', task_types: [] })
    await withdrawal
    FixtureSocket.latest.reply('shard_assign', { ...payload, shard_id: 'generic-after-withdrawal' })
    await new Promise(resolve => setImmediate(resolve)); expect(onOffer).toHaveBeenCalledTimes(2)
    await connection.close()
  })

  it.each(['rejected', 'wrong-socket', 'wrong-task-set'] as const)('refuses native update %s without activating stale scope', async (failure) => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    const { connection } = setup(); await connection.connect()
    const requestId = '4a7a9f87-2a56-4a96-ae33-490e2f39971f'
    const pending = connection.updateNativeH3Adapters({ requestId, adapters: [] })
    const rejected = expect(pending).rejects.toThrow('EDGE_NATIVE_ADAPTER_UPDATE_REJECTED')
    FixtureSocket.latest.reply('native_h3_adapter_update_ack', { request_id: requestId,
      connection_id: failure === 'wrong-socket' ? '11111111-1111-4111-8111-111111111111' : FixtureSocket.connectionId,
      status: failure === 'rejected' ? 'rejected' : 'accepted',
      task_types: failure === 'wrong-task-set' ? ['qianshou_h3_fixture_v1'] : [] })
    await rejected; expect(connection.nativeH3AdapterTaskTypes()).toEqual([]); await connection.close()
  })

  it('bounds native update waiters and drains disconnect with the original ten-second deadline', async () => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    vi.useFakeTimers(); let connection: EdgeWorkerConnection | undefined
    try {
      connection = setup().connection
      const connected = connection.connect(); await vi.advanceTimersByTimeAsync(60); await connected
      const first = connection.updateNativeH3Adapters({ requestId: '11111111-1111-4111-8111-111111111111', adapters: [] })
      const timedOut = expect(first).rejects.toThrow('EDGE_NATIVE_ADAPTER_UPDATE_ACK_TIMEOUT')
      await vi.advanceTimersByTimeAsync(10_000); await timedOut
      const active = connection
      const pending = Array.from({ length: 8 }, (_, index) => active.updateNativeH3Adapters({
        requestId: `11111111-1111-4111-8111-11111111111${index}`, adapters: [] }).catch((error: unknown) => String(error)))
      expect(() => connection?.updateNativeH3Adapters({ requestId: '99999999-9999-4999-8999-999999999999', adapters: [] }))
        .toThrow('EDGE_CHALLENGE_OBSERVATION_BUSY')
      await connection.close()
      for (const outcome of await Promise.all(pending)) expect(outcome).toContain('EDGE_CLOSED')
    } finally { await connection?.close(); vi.useRealTimers() }
  })
  it('witnesses presence only on the actual ready UUID socket and only with the matching presence ACK', async () => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    const { connection } = setup()
    expect(connection.acknowledgedConnectionId()).toBeNull()
    await connection.connect()
    expect(connection.acknowledgedConnectionId()).toBe(FixtureSocket.connectionId)
    const challengeNonce = Buffer.alloc(32, 1).toString('base64url')
    const signature = Buffer.alloc(64, 1).toString('base64url')
    let observed = false
    const pending = connection.observeNativeH3DevicePresence({ challengeNonce, signature }).then(() => { observed = true })
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'native_h3_device_presence',
      payload: { challenge_nonce: challengeNonce, signature } })
    FixtureSocket.latest.reply('native_h3_device_key_proof_ack', { challenge_id: '4a7a9f87-2a56-4a96-ae33-490e2f39971f' })
    await new Promise(resolve => setImmediate(resolve))
    expect(observed).toBe(false)
    FixtureSocket.latest.reply('native_h3_device_presence_ack', { challenge_nonce: challengeNonce })
    await pending
    expect(observed).toBe(true)
    await connection.close()
    expect(connection.acknowledgedConnectionId()).toBeNull()
  })
  it('retains legacy ordinary handshakes without granting presence authority and refuses invalid UUID metadata', async () => {
    const legacy = setup().connection
    await legacy.connect()
    expect(legacy.acknowledgedConnectionId()).toBeNull()
    expect(() => legacy.observeNativeH3DevicePresence({ challengeNonce: Buffer.alloc(32, 1).toString('base64url'),
      signature: Buffer.alloc(64, 1).toString('base64url') })).toThrow('EDGE_NOT_CONNECTED')
    await legacy.close()
    FixtureSocket.connectionId = 'untrusted-connection'
    const invalid = setup().connection
    await expect(invalid.connect()).rejects.toThrow('EDGE_PROTOCOL_INVALID')
    await invalid.close()
  })
  it('bounds pending presence observations and drains them on disconnect without unhandled rejections', async () => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    const { connection } = setup()
    await connection.connect()
    const signature = Buffer.alloc(64, 1).toString('base64url')
    expect(() => connection.observeNativeH3DevicePresence({ challengeNonce: 'not-a-uuid', signature }))
      .toThrow('EDGE_NATIVE_DEVICE_PRESENCE_INVALID')
    const pending = Array.from({ length: 8 }, (_, index) => connection.observeNativeH3DevicePresence({
      challengeNonce: Buffer.alloc(32, index + 1).toString('base64url'), signature }).catch((error: unknown) => String(error)))
    expect(() => connection.observeNativeH3DevicePresence({ challengeNonce: Buffer.alloc(32, 9).toString('base64url'), signature }))
      .toThrow('EDGE_CHALLENGE_OBSERVATION_BUSY')
    await connection.close()
    for (const outcome of await Promise.all(pending)) expect(outcome).toContain('EDGE_CLOSED')
  })
  it('keeps the presence acknowledgment deadline at ten seconds', async () => {
    FixtureSocket.connectionId = 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193'
    vi.useFakeTimers()
    let connection: EdgeWorkerConnection | undefined
    try {
      connection = setup().connection
      const connected = connection.connect()
      await vi.advanceTimersByTimeAsync(60)
      await connected
      const pending = connection.observeNativeH3DevicePresence({ challengeNonce: Buffer.alloc(32, 1).toString('base64url'),
        signature: Buffer.alloc(64, 1).toString('base64url') })
      const rejection = expect(pending).rejects.toThrow('EDGE_NATIVE_DEVICE_PRESENCE_ACK_TIMEOUT')
      await vi.advanceTimersByTimeAsync(10_000)
      await rejection
    } finally {
      await connection?.close()
      vi.useRealTimers()
    }
  })
  it('observes only the exact native device-key proof ack on the authenticated worker connection', async () => {
    const { connection } = setup(); await connection.connect()
    const challengeId = '4a7a9f87-2a56-4a96-ae33-490e2f39971f'
    const signature = Buffer.alloc(64, 1).toString('base64url')
    let observed = false
    const pending = connection.observeNativeH3DeviceKeyProof({ challengeId, signature })
      .then(() => { observed = true })
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'native_h3_device_key_proof',
      payload: { challenge_id: challengeId, signature } })
    FixtureSocket.latest.reply('order_adapter_challenge_ack', { challenge_nonce: challengeId })
    await new Promise(resolve => setImmediate(resolve))
    expect(observed).toBe(false)
    FixtureSocket.latest.reply('native_h3_device_key_proof_ack', { challenge_id: challengeId })
    await pending
    expect(observed).toBe(true)
    await connection.close()
  })
  it('rejects malformed device proofs and drains pending enrollment on disconnect', async () => {
    const { connection } = setup(); await connection.connect()
    const challengeId = '4a7a9f87-2a56-4a96-ae33-490e2f39971f'
    expect(() => connection.observeNativeH3DeviceKeyProof({ challengeId, signature: 'not-a-signature' }))
      .toThrow('EDGE_NATIVE_DEVICE_PROOF_INVALID')
    const pending = connection.observeNativeH3DeviceKeyProof({ challengeId,
      signature: Buffer.alloc(64, 1).toString('base64url') })
    const rejection = expect(pending).rejects.toThrow('EDGE_CLOSED')
    await connection.close()
    await rejection
  })
  it('accepts only a matching Shanghai challenge ack on the authenticated socket', async () => {
    const { connection } = setup(); await connection.connect()
    const challengeNonce = 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b'
    const digest = `sha256:${'a'.repeat(64)}`
    const pending = connection.observeOrderAdapterChallenge({ challengeNonce,
      inputDigest: digest, outputDigest: digest, runtimeDigest: digest, artifactDigest: digest })
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'order_adapter_challenge_result',
      payload: { challenge_nonce: challengeNonce, input_digest: digest } })
    FixtureSocket.latest.reply('order_adapter_challenge_ack', { challenge_nonce: challengeNonce })
    await expect(pending).resolves.toBeUndefined()
    await connection.close()
  })
  it('fails a pending challenge when the authenticated socket closes', async () => {
    const { connection } = setup(); await connection.connect()
    const digest = `sha256:${'a'.repeat(64)}`
    const pending = connection.observeOrderAdapterChallenge({
      challengeNonce: 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b',
      inputDigest: digest, outputDigest: digest, runtimeDigest: digest, artifactDigest: digest })
    await connection.close()
    await expect(pending).rejects.toThrow('EDGE_CLOSED')
  })
  it('starts paused and uses the real hello/auth/hb frame names', async () => {
    const { connection, onEvent } = setup(); await connection.connect()
    expect(FixtureSocket.latest.sent.map(frame => frame.type)).toEqual(['hello', 'auth', 'hb'])
    expect(FixtureSocket.latest.sent[2]?.payload.mode).toBe('paused')
    expect(onEvent).toHaveBeenCalledWith({ type: 'authenticated', workerId: 'worker-1', ownerId: 2 }); await connection.close()
  })
  it('never puts the server token in the offer or treats codeUrl as an executable request', async () => {
    const { connection, onOffer } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...payload, runtime_api: '2.0',
      reviewed_video_order: { schema: 'candidate.v1' } })
    await vi.waitFor(() =>{  expect(onOffer).toHaveBeenCalledOnce() })
    const offer = onOffer.mock.calls[0]![0]
    expect(offer.attempt).toBe(0); expect(offer.capability).toBe(''); expect(offer.codeUrl).toBe(payload.code_url)
    expect(offer.runtimeApi).toBe('2.0')
    expect(offer.reviewedVideoOrder).toEqual({ schema: 'candidate.v1' })
    expect(offer.leaseTokenSha256).toBe(createHash('sha256').update(payload.lease_token).digest('hex'))
    expect(JSON.stringify(offer)).not.toContain('fixture-private-lease')
    expect(inspect(connection, { depth: null })).not.toContain('fixture-private-lease')
    await connection.close()
  })
  it('binds progress and raw result bytes to the authenticated worker and original attempt', async () => {
    const { connection, onOffer } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', payload); await vi.waitFor(() =>{  expect(onOffer).toHaveBeenCalledOnce() })
    const offer = onOffer.mock.calls[0]![0]; connection.reportProgress(offer, .5)
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'shard_progress', payload: { shard_id: 'shard-1', attempt: 0, lease_token: 'fixture-private-lease', pct: .5 } })
    expect(() => connection.complete({ ...offer, attempt: 1 }, { inlineOutputUtf8: 'bad', elapsedMs: 1 })).toThrow('EDGE_LEASE_NOT_ACTIVE')
    expect(connection.complete(offer, { inlineOutputUtf8: '真实字节\n', elapsedMs: 12 })).toEqual({ state: 'sent-awaiting-verification' })
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'shard_result', payload: { worker_id: 'worker-1', workload_id: 'workload-1', attempt: 0, inline_output: '真实字节\n', lease_token: 'fixture-private-lease' } })
    expect(() => connection.complete(offer, { inlineOutputUtf8: 'repeat', elapsedMs: 1 })).toThrow('EDGE_LEASE_NOT_ACTIVE')
    FixtureSocket.latest.reply('shard_assign', payload); await new Promise(resolve => setTimeout(resolve, 0))
    expect(onOffer).toHaveBeenCalledOnce(); await connection.close()
  })
  it.each([-1, 0.5])('rejects invalid attempts at the network boundary', async (attempt) => {
    const { connection, onOffer, onEvent } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...payload, attempt })
    await vi.waitFor(() =>{  expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_PROTOCOL_INVALID' }) })
    expect(onOffer).not.toHaveBeenCalled(); await connection.close()
  })
  it('does not guess an attempt for a legacy cancel and drains the aborted session callback', async () => {
    let completed = false
    const { connection, onEvent } = setup({ onOffer: async (_offer, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { completed = true; resolve() }, { once: true })
    }) })
    await connection.connect(); connection.updateMode('running'); FixtureSocket.latest.reply('shard_assign', payload)
    await new Promise(resolve => setTimeout(resolve, 0)); FixtureSocket.latest.reply('shard_cancel', { shard_id: 'shard-1', reason: 'test' })
    await vi.waitFor(() =>{  expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_CANCEL_RECONCILIATION_REQUIRED' }) })
    await connection.close(); expect(completed).toBe(true)
  })
  it('requires the expected authenticated owner', async () => {
    const { connection, onOffer } = setup({ expectedOwnerId: 3 })
    await expect(connection.connect()).rejects.toThrow('EDGE_PROTOCOL_INVALID'); expect(onOffer).not.toHaveBeenCalled(); await connection.close()
  })
  it('refuses an unadvertised task scope with a coded frame and never invokes an executor', async () => {
    const { connection, onOffer, onEvent } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...payload, task_type: 'shell' })
    await vi.waitFor(() =>{  expect(FixtureSocket.latest.sent.some(frame => frame.type === 'shard_result')).toBe(true) })
    // 拒绝必须带稳定码，而且**不**拆掉整条会话：线上实测「回帧后立刻关连接」会让平台把分片退回
    // PENDING、worker_id 清空、error 为空——原因被丢掉，分片还留在队列里。
    expect(FixtureSocket.latest.sent.at(-1)).toEqual({
      v: '8.0', type: 'shard_result', payload: {
        shard_id: 'shard-1', workload_id: 'workload-1', worker_id: 'worker-1', attempt: 0,
        lease_token: 'fixture-private-lease', ok: false,
        error: 'EDGE_TASK_SCOPE_DENIED: task type shell is not advertised by this node',
        failure_class: 'EDGE_TASK_SCOPE_DENIED',
      },
    })
    expect(onOffer).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_TASK_SCOPE_DENIED' })
    // 会话仍然可用：同一连接上的下一次派单照常受理。
    FixtureSocket.latest.reply('shard_assign', payload)
    await vi.waitFor(() =>{  expect(onOffer).toHaveBeenCalledOnce() })
    await connection.close()
  })
  it('refuses each out-of-scope assignment instead of guessing an executor', async () => {
    const { connection, onOffer } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...payload, task_type: 'shell', shard_id: 'shard-2' })
    FixtureSocket.latest.reply('shard_assign', { ...payload, task_type: 'shell', shard_id: 'shard-3' })
    await vi.waitFor(() =>{  expect(FixtureSocket.latest.sent.filter(frame => frame.type === 'shard_result')).toHaveLength(2) })
    expect(FixtureSocket.latest.sent.filter(frame => frame.type === 'shard_result').map(frame => frame.payload.shard_id))
      .toEqual(['shard-2', 'shard-3'])
    expect(onOffer).not.toHaveBeenCalled(); await connection.close()
  })
  it('refuses an assignment that arrives while local supply is paused, with a stable code', async () => {
    const { connection, onOffer } = setup(); await connection.connect()
    // 没有调用 updateMode('running') ⇒ 本地供给仍是 paused。
    FixtureSocket.latest.reply('shard_assign', payload)
    await vi.waitFor(() =>{  expect(FixtureSocket.latest.sent.some(frame => frame.type === 'shard_result')).toBe(true) })
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({
      type: 'shard_result',
      payload: { ok: false, failure_class: 'EDGE_SUPPLY_WITHDRAWN', shard_id: 'shard-1' },
    })
    expect(onOffer).not.toHaveBeenCalled(); await connection.close()
  })
  it('refuses nonlocal origins and missing credentials before networking', async () => {
    expect(() => setup({ origin: 'https://production.example' })).toThrow('SUPPLY_CONFIG_INVALID')
    const { connection } = setup({ tokenProvider: () => undefined })
    await expect(connection.connect()).rejects.toThrow('EDGE_AUTH_REQUIRED'); await connection.close()
  })
  it('admits an HTTPS origin only when loopbackOnly is false', () => {
    expect(() => setup({ origin: 'https://qianshousuanli.com', loopbackOnly: false })).not.toThrow()
    expect(() => setup({ origin: 'https://qianshousuanli.com', loopbackOnly: true })).toThrow('SUPPLY_CONFIG_INVALID')
  })
  // 看门狗只在「发过 hb 之后」计时，所以用例用生产里另一条也会发 hb 的路径
  // （`updateMode`，即 owner 供给开关翻转）把时刻钉死，不依赖 interval 与 fake timers 的细节。
  it('closes a live session when the peer stops answering heartbeats within the server-stated window', async () => {
    // 平台 `welcome` 实测给的是 hb_interval_s=15 / hb_timeout_s=45。
    FixtureSocket.timeoutSeconds = 45
    vi.useFakeTimers()
    try {
      const { connection, onEvent } = setup({ handshakeTimeoutMs: 600_000 })
      const connected = connection.connect()
      await vi.advanceTimersByTimeAsync(60)
      await connected
      // 第一拍心跳由 auth_ok 触发且 fixture 回了 ack：这一刻不得误判超时。
      expect(FixtureSocket.latest.sent.filter(frame => frame.type === 'hb')).toHaveLength(1)
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      // 一个健康会话可以随便翻供给开关：ack 及时回来 ⇒ 不得被误杀。
      connection.updateMode('running')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      // 对端自此变哑：hb 照发、ack 一个不回 ⇒ 到 hb_timeout_s 必须自己关链。
      FixtureSocket.muteHeartbeatAcks = true
      connection.updateMode('paused')
      await vi.advanceTimersByTimeAsync(44_000)
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      expect(() =>{  connection.updateMode('running') }).toThrow('EDGE_HEARTBEAT_TIMEOUT')
      await connection.close()
    } finally { vi.useRealTimers() }
  })
  it('takes the ack deadline from welcome.hb_timeout_s instead of a locally invented window', async () => {
    // 服务端说 1 秒 ⇒ 就按 1 秒判。本地若自己发明一个窗口（例如 3 × 心跳周期 = 45 秒），
    // 这里的 5 秒是**不会**关链的，本用例会红。
    FixtureSocket.timeoutSeconds = 1
    vi.useFakeTimers()
    try {
      const { connection, onEvent } = setup({ handshakeTimeoutMs: 600_000 })
      const connected = connection.connect()
      await vi.advanceTimersByTimeAsync(60)
      await connected
      FixtureSocket.muteHeartbeatAcks = true
      connection.updateMode('running')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      await connection.close()
    } finally { vi.useRealTimers() }
  })
  it('still bounds the ack deadline when welcome omits hb_timeout_s', async () => {
    // 老服务端/被裁过的 welcome：没有 hb_timeout_s ⇒ 退回 3 × hb_interval_s（15s ⇒ 45s），
    // 既不能没有上界，也不能把手里的 15 秒错当成截止。
    vi.useFakeTimers()
    try {
      const { connection, onEvent } = setup({ handshakeTimeoutMs: 600_000 })
      const connected = connection.connect()
      await vi.advanceTimersByTimeAsync(60)
      await connected
      FixtureSocket.muteHeartbeatAcks = true
      connection.updateMode('running')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(15_100)
      expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_HEARTBEAT_TIMEOUT' })
      await connection.close()
    } finally { vi.useRealTimers() }
  })
})

it.each([false, true])('uses authenticated seller lease identity independently of a different buyer account (wrong seller=%s)', async (wrongSeller) => {
  FixtureSocket.connectionId = '11111111-1111-4111-8111-111111111111'
  const taskType = 'qianshou_h3_fixture_v2'
  const { connection, onOffer } = setup({ allowedTaskTypes: [taskType] })
  try {
    await connection.connect(); connection.updateMode('running')
    const lease = { schema: 'qianshou.native-h3-task-lease.v2', publication_id: '22222222-2222-4222-8222-222222222222',
      owner_id: wrongSeller ? 3 : 2, device_id: 'worker-1', task_type: taskType, capability_id: 'video.render', contract_version: 'v2',
      contract_sha256: 'a'.repeat(64), artifact_digest: 'sha256:' + 'b'.repeat(64), source_digest: 'sha256:' + 'b'.repeat(64),
      logical_binding_sha256: 'c'.repeat(64), local_owner_config_digest: 'sha256:' + 'd'.repeat(64), device_binding_revision: 1,
      connection_id: FixtureSocket.connectionId, device_key_id: 'native-device', workload_id: '33333333-3333-4333-8333-333333333333',
      shard_id: '44444444-4444-4444-8444-444444444444', attempt: 1 }
    FixtureSocket.latest.reply('shard_assign', { ...payload, task_type: taskType, workload_id: lease.workload_id,
      shard_id: lease.shard_id, attempt: 1, account_id: 99, native_device_lease: lease })
    await new Promise(resolve => setImmediate(resolve))
    if (wrongSeller) expect(onOffer).not.toHaveBeenCalled()
    else {
      expect(onOffer).toHaveBeenCalledOnce()
      expect(onOffer.mock.calls[0]?.[0].nativeDeviceLease).toMatchObject({ owner_id: 2, device_binding_revision: 1 })
      expect(connection.acknowledgedConnectionId()).toBe(FixtureSocket.connectionId)
    }
  } finally { await connection.close() }
})
