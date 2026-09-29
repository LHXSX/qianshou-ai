/** Exercise the peer's update fence with delayed real approval/save promises and controllable transport events. */
import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceId, JobId, RemoteJob, WorkspaceId } from '@deepseek-ai/dsh-host-remote-devices/protocol'
import { CompanionPeer, type PeerOptions } from '../src/peer.ts'

interface TestSocket extends EventEmitter { readyState: number; sent: string[]; close(): void }
const transport = vi.hoisted(() => ({ sockets: [] as TestSocket[] }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: class Socket extends EventEmitter {
    static readonly OPEN = 1
    readyState = 1
    readonly sent: string[] = []
    constructor() { super(); transport.sockets.push(this) }
    send(value: string) { this.sent.push(value) }
    close() { this.readyState = 3 }
  } }
})

const peers: CompanionPeer[] = []
afterEach(() => { for (const peer of peers.splice(0)) peer.stop(); transport.sockets.splice(0) })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { resolve, promise }
}
function job(id = 'job'): RemoteJob {
  return { id: id as JobId, deviceId: 'device' as DeviceId, workspaceId: 'workspace' as WorkspaceId,
    kind: 'read', payload: { path: 'result.txt' }, status: 'awaiting-approval', output: '',
    createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z' }
}
function create(options: Partial<PeerOptions> = {}, paired = true) {
  const peer = new CompanionPeer({ endpoint: 'ws://127.0.0.1:9999', ...(paired ? { credential: { deviceId: 'device' as DeviceId, token: 'fake-token' } } : {}),
    hello: { name: 'test', platform: 'darwin', arch: 'arm64', workspaces: [{ id: 'workspace' as WorkspaceId, name: 'test', path: '/test' }] },
    saveCredential: async () => {}, saveJobs: async () => {}, changed: () => {}, executor: async () => 'done', ...options })
  peers.push(peer)
  peer.connect()
  return { peer, socket: transport.sockets.at(-1)! }
}
function message(socket: TestSocket, value: unknown) { socket.emit('message', Buffer.from(JSON.stringify(value))) }
async function authenticate(socket: TestSocket) { socket.emit('open'); message(socket, { type: 'authenticated' }); await tick() }

describe('companion update quiescence', () => {
  it('counts accepted transport messages before their processing microtask starts', async () => {
    const { peer, socket } = create()
    await authenticate(socket)
    expect(peer.updateBusy()).toBe(false)
    message(socket, { type: 'heartbeat' })
    expect(peer.updateBusy()).toBe(true)
    expect(() => { peer.prepareUpdate() }).toThrow('UPDATE_BUSY')
    await tick()
    expect(peer.updateBusy()).toBe(false)
  })

  it('does not interrupt execution or a delayed terminal save to acquire an update fence', async () => {
    const execution = deferred()
    const terminalSave = deferred()
    let executionSignal: AbortSignal | undefined
    const { peer, socket } = create({ executor: async (_job, _workspace, signal) => {
      executionSignal = signal; await execution.promise; return 'done'
    }, saveJobs: async (jobs) => { if (jobs[0]?.status === 'completed') await terminalSave.promise } })
    await authenticate(socket)
    message(socket, { type: 'job', job: job() }); await tick()
    const running = peer.approve('job'); await tick()
    expect(peer.updateBusy()).toBe(true)
    expect(() => { peer.prepareUpdate() }).toThrow('UPDATE_BUSY')
    expect(executionSignal?.aborted).toBe(false)
    peer.cancelUpdate()
    expect(executionSignal?.aborted).toBe(false)
    execution.resolve(); await tick()
    expect(peer.snapshot().jobs[0]?.status).toBe('completed')
    expect(peer.updateBusy()).toBe(true)
    expect(() => { peer.prepareUpdate() }).toThrow('UPDATE_BUSY')
    terminalSave.resolve(); await running
    expect(peer.updateBusy()).toBe(false)
    expect(executionSignal?.aborted).toBe(false)
  })

  it('waits for pairing credentials and queued job persistence before becoming idle', async () => {
    const credentials = deferred()
    const saving = deferred()
    const { peer, socket } = create({ code: 'fake-code',
      saveCredential: () => credentials.promise, saveJobs: () => saving.promise }, false)
    socket.emit('open')
    message(socket, { type: 'paired', deviceId: 'device', token: 'fake-token' })
    message(socket, { type: 'job', job: job() })
    await tick()
    expect(peer.updateBusy()).toBe(true)
    expect(() => { peer.prepareUpdate() }).toThrow('UPDATE_BUSY')
    credentials.resolve(); await tick()
    expect(peer.updateBusy()).toBe(true)
    expect(() => { peer.prepareUpdate() }).toThrow('UPDATE_BUSY')
    saving.resolve(); await tick()
    expect(peer.snapshot().jobs[0]?.status).toBe('awaiting-approval')
    expect(() => { peer.prepareUpdate() }).toThrow('UPDATE_BUSY')
    await peer.reject('job')
    expect(peer.updateBusy()).toBe(false)
  })

  it('blocks approvals and transport work while prepared, then resumes the connection after cancellation', async () => {
    const { peer, socket } = create()
    await authenticate(socket)
    peer.prepareUpdate()
    await expect(peer.approve('job')).rejects.toThrow('UPDATE_PREPARING')
    expect(() => { peer.connect() }).toThrow('UPDATE_PREPARING')
    message(socket, { type: 'job', job: job() }); await tick()
    expect(peer.snapshot().jobs).toEqual([])
    peer.cancelUpdate()
    expect(transport.sockets).toHaveLength(2)
    await authenticate(transport.sockets[1]!)
    expect(peer.snapshot().connected).toBe(true)
  })

  it('ignores retired socket close/error/messages after cancellation reconnects and starts new work', async () => {
    const running = deferred()
    let signal: AbortSignal | undefined
    const { peer, socket: old } = create({ executor: async (_job, _workspace, currentSignal) => {
      signal = currentSignal; await running.promise; return 'finished'
    } })
    await authenticate(old)
    peer.prepareUpdate(); peer.cancelUpdate()
    const current = transport.sockets[1]!
    await authenticate(current)
    message(current, { type: 'job', job: job('new-work') }); await tick()
    const task = peer.approve('new-work'); await tick()
    old.emit('error', new Error('old transport failed'))
    old.emit('close', 1000, Buffer.from('old closed'))
    message(old, { type: 'cancel', jobId: 'new-work' })
    await tick()
    expect(peer.snapshot().connected).toBe(true)
    expect(peer.snapshot().error).toBeNull()
    expect(signal?.aborted).toBe(false)
    expect(transport.sockets).toHaveLength(2)
    running.resolve(); await task
    expect(peer.snapshot().jobs[0]?.status).toBe('completed')
  })
})
