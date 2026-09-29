/** Two real loopback WebSocket ends exercise local approval, ownership, replay, and revocation without remote machines. */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { DeviceCoordinator } from '../src/coordinator.ts'
import { CompanionPeer, type PeerCredential } from '../../../../apps/qianshou-companion/src/peer.ts'
import type { RemoteJob, WorkspaceId } from '../src/protocol.ts'

let root: string
let coordinator: DeviceCoordinator
let server: ReturnType<typeof createServer>
let endpoint: string
let peer: CompanionPeer | undefined
let credential: PeerCredential | undefined
let jobs: RemoteJob[]

beforeEach(async () => {
  peer = undefined
  root = await mkdtemp(join(tmpdir(), 'qianshou-duplex-'))
  coordinator = await DeviceCoordinator.open(join(root, 'devices.json'))
  server = createServer()
  server.on('upgrade', (request, socket, head) => coordinator.upgrade(request, socket, head))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MISSING_PORT')
  endpoint = `ws://127.0.0.1:${address.port}`
  credential = undefined; jobs = []
})
afterEach(async () => {
  peer?.stop()
  await coordinator.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

const hello = () => ({ name: 'Test companion', platform: process.platform, arch: process.arch, workspaces: [{ id: 'workspace' as WorkspaceId, name: 'test', path: root }] })
async function pair(): Promise<void> {
  const code = coordinator.pairing().code
  peer = new CompanionPeer({ endpoint, code, hello: hello(), changed: () => {}, saveCredential: async value => { credential = value }, saveJobs: async value => { jobs = structuredClone(value) } })
  peer.connect()
  await expect.poll(() => peer?.snapshot().connected).toBe(true)
}

describe('Qianshou device duplex', () => {
  it('refuses task submission before persistence or peer delivery and counts approval until terminal receipt', async () => {
    await pair()
    const request = { deviceId: credential!.deviceId, workspaceId: 'workspace', kind: 'list', payload: { path: '.' } }
    const before = await readFile(join(root, 'devices.json'), 'utf8')
    const remove = coordinator.admission.register(() => { throw new Error('held') })
    await expect(coordinator.submit(request)).rejects.toThrow('held')
    expect(await readFile(join(root, 'devices.json'), 'utf8')).toBe(before)
    expect(peer!.snapshot().jobs).toEqual([])
    expect(coordinator.admission.pending).toBe(0)
    remove()
    const submitting = coordinator.submit(request)
    expect(coordinator.admission.pending).toBe(1)
    const job = await submitting
    expect(coordinator.admission.pending).toBe(0)
    expect(coordinator.activeCount).toBe(1)
    await expect.poll(() => peer?.snapshot().jobs.length).toBe(1)
    await peer!.approve(job.id)
    await expect.poll(() => coordinator.activeCount).toBe(0)
  })

  it('pairs once, waits for local approval, executes a file write and retains only a credential digest on the controller', async () => {
    await pair()
    const device = coordinator.snapshot().devices[0]!
    const job = await coordinator.submit({ deviceId: device.id, workspaceId: 'workspace', kind: 'write', payload: { path: 'receipt.txt', content: 'paired-and-approved' } })
    await expect.poll(() => peer?.snapshot().jobs.length).toBe(1)
    await expect(readFile(join(root, 'receipt.txt'), 'utf8')).rejects.toThrow()
    await peer!.approve(job.id)
    await expect.poll(() => coordinator.snapshot().jobs[0]?.status).toBe('completed')
    expect(await readFile(join(root, 'receipt.txt'), 'utf8')).toBe('paired-and-approved')
    expect(await readFile(join(root, 'devices.json'), 'utf8')).not.toContain(credential!.token)
    expect(jobs[0]?.status).toBe('completed')
  })
  it('cancels a locally approved running process and sends a terminal receipt', async () => {
    await pair()
    const job = await coordinator.submit({ deviceId: credential!.deviceId, workspaceId: 'workspace', kind: 'command', payload: { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60' } })
    await expect.poll(() => peer?.snapshot().jobs.length).toBe(1)
    const run = peer!.approve(job.id)
    await expect.poll(() => coordinator.snapshot().jobs[0]?.status).toBe('running')
    await coordinator.cancel(job.id)
    await run
    await expect.poll(() => coordinator.snapshot().jobs[0]?.status).toBe('cancelled')
  })
  it('rejects unapproved workspace jobs and revokes a live identity', async () => {
    await pair()
    await expect(coordinator.submit({ deviceId: credential!.deviceId, workspaceId: 'other', kind: 'list', payload: { path: '.' } })).rejects.toThrow('WORKSPACE_NOT_APPROVED')
    await coordinator.revoke(credential!.deviceId)
    await expect.poll(() => peer?.snapshot().connected).toBe(false)
    expect(coordinator.snapshot().devices).toEqual([])
  })
  it('rejects a browser-origin upgrade before a device session exists', async () => {
    const socket = new WebSocket(endpoint, { origin: 'http://malicious.example' })
    const failure = await new Promise<string>(resolve => { socket.on('error', error => resolve(error.message)) })
    expect(failure).toContain('403')
    expect(coordinator.snapshot().devices).toEqual([])
  })
  it('consumes a pairing code once and rejects a revoked credential', async () => {
    const code = coordinator.pairing().code
    const raw = async (frame: unknown): Promise<{ socket: WebSocket; first: Record<string, unknown> }> => {
      const socket = new WebSocket(endpoint)
      const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on('open', () => socket.send(JSON.stringify(frame)))
        socket.on('message', value => resolve(JSON.parse(value.toString())))
        socket.on('close', value => reject(new Error(`CLOSED_${value}`)))
        socket.on('error', reject)
      })
      return { socket, first }
    }
    const paired = await raw({ type: 'pair', code, hello: hello() })
    await expect(raw({ type: 'pair', code, hello: hello() })).rejects.toThrow('CLOSED_4002')
    await coordinator.revoke(paired.first.deviceId as string)
    await expect(raw({ type: 'auth', deviceId: paired.first.deviceId, token: paired.first.token, hello: hello() })).rejects.toThrow('CLOSED_4002')
  })
  it('reconnects an approval queue without executing it and preserves a local rejection receipt', async () => {
    await pair()
    const job = await coordinator.submit({ deviceId: credential!.deviceId, workspaceId: 'workspace', kind: 'write', payload: { path: 'never.txt', content: 'must-not-run' } })
    await expect.poll(() => jobs.length).toBe(1)
    peer!.stop()
    await expect.poll(() => coordinator.snapshot().devices[0]?.connected).toBe(false)
    peer = new CompanionPeer({ endpoint, credential: credential!, hello: hello(), jobs, changed: () => {}, saveCredential: async () => {}, saveJobs: async value => { jobs = structuredClone(value) } })
    peer.connect()
    await expect.poll(() => coordinator.snapshot().jobs[0]?.status).toBe('interrupted')
    await expect(readFile(join(root, 'never.txt'), 'utf8')).rejects.toThrow()
    expect(peer.snapshot().jobs.filter(item => item.id === job.id)).toHaveLength(1)
  })
  it('returns an explicit rejected result for an unapproved task', async () => {
    await pair()
    const job = await coordinator.submit({ deviceId: credential!.deviceId, workspaceId: 'workspace', kind: 'command', payload: { command: 'echo should-not-run' } })
    await expect.poll(() => peer?.snapshot().jobs.length).toBe(1)
    await peer!.reject(job.id)
    await expect.poll(() => coordinator.snapshot().jobs[0]?.status).toBe('rejected')
    expect(coordinator.snapshot().jobs[0]?.output).toBe('')
  })
})
