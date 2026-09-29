import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeWorkerConnection } from '../../src/edge-worker/connection.ts'
import { FixtureWebSocketServer } from './fixture-ws-server.ts'

const servers: FixtureWebSocketServer[] = []
const workers: EdgeWorkerConnection[] = []

async function connectedWorker(clock = Date.now()) {
  const server = await FixtureWebSocketServer.start({ script: (frame, context) => {
    if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 3600, hb_timeout_s: 3600 })
    if (frame.type === 'auth') context.reply('auth_ok', { worker_id: 'worker-1', owner_id: 7 })
    if (frame.type === 'hb') context.reply('hb_ack', {})
  } })
  servers.push(server)
  const onOffer = vi.fn(async () => {})
  const worker = new EdgeWorkerConnection({
    origin: server.origin, tokenProvider: () => 'fixture-token', expectedOwnerId: 7,
    name: 'fixture', clientBuild: 'fixture', os: 'test', arch: 'test',
    capabilities: {}, allowedTaskTypes: ['word_count'], handshakeTimeoutMs: 2000,
    maxFrameBytes: 65536, maxOutputBytes: 4096, readLoad: () => 0,
    clock: () => clock, onOffer, onEvent: () => {},
  })
  workers.push(worker)
  await worker.connect()
  return { server, worker, onOffer }
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close()
  for (const server of servers.splice(0)) await server.close()
})

describe('marketplace control over a real worker WebSocket', () => {
  it('rejects a publisher-declared signed bundle with a matching negative receipt and keeps the worker live', async () => {
    const { server, worker, onOffer } = await connectedWorker()
    const controlId = 'a'.repeat(32)
    server.send('control', {
      control_id: controlId, action: 'install_app', expires_at_ms: Date.now() + 60_000,
      params: { slug: 'untrusted-app', bundle: {
        script_bundle_url: 'https://untrusted.example/plugin.tgz',
        sha256: 'f'.repeat(64), signed: true,
      } },
    })
    await vi.waitFor(() => expect(server.frames.some(frame => frame.type === 'control_result')).toBe(true))
    expect(server.frames.find(frame => frame.type === 'control_result')).toMatchObject({
      raw: { v: '8.0' },
      payload: {
        control_id: controlId, action: 'install_app', ok: false,
        detail: expect.stringContaining('APP_PACKAGE_VERIFICATION_UNAVAILABLE'), elapsed_ms: 0,
      },
    })
    expect(onOffer).not.toHaveBeenCalled()
    expect(worker.observe().stage).toBe('ready')
    await worker.close()
  })

  it('fails closed for uninstall and expired install; malformed IDs cannot impersonate a receipt', async () => {
    const { server, worker } = await connectedWorker(10_000)
    server.send('control', { control_id: 'b'.repeat(32), action: 'uninstall_app', params: { slug: 'old-app' }, expires_at_ms: 20_000 })
    server.send('control', { control_id: 'c'.repeat(32), action: 'install_app', params: {}, expires_at_ms: 1 })
    server.send('control', { control_id: '../forged', action: 'install_app', params: {}, expires_at_ms: 20_000 })
    server.send('control', { control_id: 'd'.repeat(32), action: 'clear_cache', params: {}, expires_at_ms: 20_000 })
    await vi.waitFor(() => expect(server.frames.filter(frame => frame.type === 'control_result')).toHaveLength(2))
    expect(server.frames.filter(frame => frame.type === 'control_result').map(frame => frame.payload)).toEqual([
      { control_id: 'b'.repeat(32), action: 'uninstall_app', ok: false,
        detail: expect.stringContaining('APP_UNINSTALL_EXECUTOR_UNAVAILABLE'), elapsed_ms: 0 },
      { control_id: 'c'.repeat(32), action: 'install_app', ok: false,
        detail: expect.stringContaining('APP_CONTROL_EXPIRED'), elapsed_ms: 0 },
    ])
    expect(worker.observe().stage).toBe('ready')
    await worker.close()
  })
})
