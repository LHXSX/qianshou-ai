/** A paused Shanghai heartbeat: the phone can see this computer, and assigned work is refused. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkerPresence } from '../src/presence.ts'
import type { PresenceSocket } from '../src/presence.ts'

const TOKEN = 'fixture-access-token'
const ACCOUNT = 'acct-1'

class FakeSocket implements PresenceSocket {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = 3; this.emit('close', {}) }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open', {}) }
  receive(type: string, payload: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify({ v: '8.0', type, payload }) })
  }
  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const directories: string[] = []
const presences: WorkerPresence[] = []
afterEach(async () => {
  for (const presence of presences.splice(0)) await presence.stop('stopped')
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function started() {
  const directory = await mkdtemp(join(tmpdir(), 'qianshou-presence-'))
  directories.push(directory)
  const sockets: FakeSocket[] = []
  const presence = new WorkerPresence({
    accountOrigin: 'https://qianshousuanli.com',
    windowOrigin: 'https://pc.qianshousuanli.com',
    workerIdPath: join(directory, 'worker-id.json'),
    token: () => Promise.resolve(TOKEN),
    accountId: () => ACCOUNT,
    os: 'darwin',
    arch: 'arm64',
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    now: () => 1_700_000_000_000,
  })
  presences.push(presence)
  presence.start()
  await until(() => sockets[0] !== undefined)
  const socket = sockets[0]
  if (socket === undefined) throw new Error('socket was not opened')
  socket.open()
  return { presence, sockets, directory, socket }
}

function frame(socket: FakeSocket, index: number): { type: string; payload: Record<string, unknown> } {
  return JSON.parse(socket.sent[index] ?? '{}') as { type: string; payload: Record<string, unknown> }
}

describe('worker presence', () => {
  it('announces the window, heartbeats paused, and refuses an assignment', async () => {
    const { presence, socket, directory } = await started()
    expect(frame(socket, 0)).toMatchObject({
      type: 'hello',
      payload: { os: 'darwin', capabilities: { window_origin: 'https://pc.qianshousuanli.com', os: 'darwin' } },
    })
    expect(frame(socket, 0).payload).not.toHaveProperty('worker_id')
    socket.receive('welcome', { hb_interval_s: 15 })
    expect(frame(socket, 1)).toMatchObject({ type: 'auth', payload: { access_token: TOKEN } })
    socket.receive('auth_ok', { worker_id: 'worker-7', owner_id: ACCOUNT })
    await until(() => presence.id() === 'worker-7')
    expect(presence.id()).toBe('worker-7')
    expect(frame(socket, 2)).toMatchObject({ type: 'hb', payload: { mode: 'paused', active_shards: 0, throttle_pct: 0 } })
    expect(JSON.parse(await readFile(join(directory, 'worker-id.json'), 'utf8'))).toEqual({ version: 1, workerId: 'worker-7', accountId: ACCOUNT })
    socket.receive('shard_assign', { shard_id: 'sh-1', workload_id: 'wl-1', attempt: 1, lease_token: 'lease-1' })
    expect(frame(socket, 3)).toMatchObject({ type: 'shard_result', payload: { ok: false, failure_class: 'EDGE_SUPPLY_WITHDRAWN', lease_token: 'lease-1' } })
  })

  it('reuses the acknowledged worker id and does not keep a foreign owner', async () => {
    const first = await started()
    first.socket.receive('welcome', { hb_interval_s: 15 })
    first.socket.receive('auth_ok', { worker_id: 'worker-7', owner_id: ACCOUNT })
    await until(() => first.presence.id() === 'worker-7')
    const sockets: FakeSocket[] = []
    const again = new WorkerPresence({
      accountOrigin: 'https://qianshousuanli.com',
      windowOrigin: 'https://pc.qianshousuanli.com',
      workerIdPath: join(first.directory, 'worker-id.json'),
      token: () => Promise.resolve(TOKEN),
      accountId: () => ACCOUNT,
      openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    })
    presences.push(again)
    again.start()
    await until(() => sockets[0] !== undefined)
    const socket = sockets[0]
    if (socket === undefined) throw new Error('reconnect did not open')
    socket.open()
    expect(frame(socket, 0).payload.worker_id).toBe('worker-7')
    socket.receive('welcome', { hb_interval_s: 15 })
    socket.receive('auth_ok', { worker_id: 'worker-7', owner_id: 'someone-else' })
    await Promise.resolve()
    expect(again.status().lastFailure).toBe('PC_WINDOW_OWNER_CHANGED')
    expect(again.status().registration).toBe('disconnected')
  })
})

async function until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ready()) return
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
  throw new Error('presence did not become ready')
}
