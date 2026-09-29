import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspect } from 'node:util'
import { EdgeWorkerConnection, type EdgeWorkerOptions } from '../../src/edge-worker/connection.ts'
import type { EdgeTaskOffer } from '../../src/edge-worker/types.ts'

class FixtureSocket extends EventTarget {
  static OPEN = 1
  static latest: FixtureSocket
  readyState = 1
  sent: { type: string; payload: Record<string, unknown> }[] = []
  constructor() { super(); FixtureSocket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
  send(data: string) {
    const frame = JSON.parse(data); this.sent.push(frame)
    if (frame.type === 'hello') this.reply('welcome', { hb_interval_s: 15 })
    if (frame.type === 'auth') this.reply('auth_ok', { worker_id: 'worker-1', owner_id: 2 })
    if (frame.type === 'hb') this.reply('hb_ack', {})
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
beforeEach(() => vi.stubGlobal('WebSocket', FixtureSocket))
afterEach(() => vi.unstubAllGlobals())
describe('audited Edge worker transport', () => {
  it('starts paused and uses the real hello/auth/hb frame names', async () => {
    const { connection, onEvent } = setup(); await connection.connect()
    expect(FixtureSocket.latest.sent.map(frame => frame.type)).toEqual(['hello', 'auth', 'hb'])
    expect(FixtureSocket.latest.sent[2]?.payload.mode).toBe('paused')
    expect(onEvent).toHaveBeenCalledWith({ type: 'authenticated', workerId: 'worker-1', ownerId: 2 }); await connection.close()
  })
  it('never puts the server token in the offer or treats codeUrl as an executable request', async () => {
    const { connection, onOffer } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', payload); await vi.waitFor(() => expect(onOffer).toHaveBeenCalledOnce())
    const offer = onOffer.mock.calls[0]![0]
    expect(offer.attempt).toBe(0); expect(offer.capability).toBe(''); expect(offer.codeUrl).toBe(payload.code_url)
    expect(JSON.stringify(offer)).not.toContain('lease'); expect(inspect(connection, { depth: null })).not.toContain('fixture-private-lease')
    await connection.close()
  })
  it('binds progress and raw result bytes to the authenticated worker and original attempt', async () => {
    const { connection, onOffer } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', payload); await vi.waitFor(() => expect(onOffer).toHaveBeenCalledOnce())
    const offer = onOffer.mock.calls[0]![0]; connection.reportProgress(offer, .5)
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'shard_progress', payload: { shard_id: 'shard-1', attempt: 0, lease_token: 'fixture-private-lease', pct: .5 } })
    expect(() => connection.complete({ ...offer, attempt: 1 }, { inlineOutputUtf8: 'bad', elapsedMs: 1 })).toThrow('EDGE_LEASE_NOT_ACTIVE')
    expect(connection.complete(offer, { inlineOutputUtf8: '真实字节\n', elapsedMs: 12 })).toEqual({ state: 'sent-awaiting-verification' })
    expect(FixtureSocket.latest.sent.at(-1)).toMatchObject({ type: 'shard_result', payload: { worker_id: 'worker-1', workload_id: 'workload-1', attempt: 0, inline_output: '真实字节\n', lease_token: 'fixture-private-lease' } })
    expect(() => connection.complete(offer, { inlineOutputUtf8: 'repeat', elapsedMs: 1 })).toThrow('EDGE_LEASE_NOT_ACTIVE')
    FixtureSocket.latest.reply('shard_assign', payload); await new Promise(resolve => setTimeout(resolve, 0))
    expect(onOffer).toHaveBeenCalledOnce(); await connection.close()
  })
  it.each([-1, 0.5])('rejects invalid attempts at the network boundary', async attempt => {
    const { connection, onOffer, onEvent } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...payload, attempt })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_PROTOCOL_INVALID' }))
    expect(onOffer).not.toHaveBeenCalled(); await connection.close()
  })
  it('does not guess an attempt for a legacy cancel and drains the aborted session callback', async () => {
    let completed = false
    const { connection, onEvent } = setup({ onOffer: async (_offer, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => { completed = true; resolve() }, { once: true })
    }) })
    await connection.connect(); connection.updateMode('running'); FixtureSocket.latest.reply('shard_assign', payload)
    await new Promise(resolve => setTimeout(resolve, 0)); FixtureSocket.latest.reply('shard_cancel', { shard_id: 'shard-1', reason: 'test' })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_CANCEL_RECONCILIATION_REQUIRED' }))
    await connection.close(); expect(completed).toBe(true)
  })
  it('requires the expected authenticated owner', async () => {
    const { connection, onOffer } = setup({ expectedOwnerId: 3 })
    await expect(connection.connect()).rejects.toThrow('EDGE_PROTOCOL_INVALID'); expect(onOffer).not.toHaveBeenCalled(); await connection.close()
  })
  it('rejects unsupported task scope without invoking any executor', async () => {
    const { connection, onOffer, onEvent } = setup(); await connection.connect(); connection.updateMode('running')
    FixtureSocket.latest.reply('shard_assign', { ...payload, task_type: 'shell' })
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: 'closed', reason: 'EDGE_TASK_SCOPE_DENIED' }))
    expect(onOffer).not.toHaveBeenCalled(); await connection.close()
  })
  it('refuses nonlocal origins and missing credentials before networking', async () => {
    expect(() => setup({ origin: 'https://production.example' })).toThrow('SUPPLY_CONFIG_INVALID')
    const { connection } = setup({ tokenProvider: () => undefined })
    await expect(connection.connect()).rejects.toThrow('EDGE_AUTH_REQUIRED'); await connection.close()
  })
})
