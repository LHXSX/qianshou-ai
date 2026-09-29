/** Explicit opt-in, real public relay transport test; no user profile, microphone, or LLM. */
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { DeviceCoordinator } from '../src/coordinator.ts'
import { CompanionPeer, type PeerCredential } from '../../../../apps/qianshou-companion/src/peer.ts'
import type { WorkspaceId } from '../src/protocol.ts'

const enrollmentPath = process.env.QIANSHOU_RELAY_ENROLLMENT
const binary = process.env.QIANSHOU_RELAY_FRPC
const ca = process.env.QIANSHOU_RELAY_CA

describe.skipIf(!enrollmentPath || !binary || !ca)('live Guangzhou dedicated relay', () => {
  it('rejects unregistered routes and pairs the approved finite-task channel through verified public TLS', async () => {
    const enrollment = JSON.parse(await readFile(enrollmentPath!, 'utf8')) as { endpoint: string; controllerId: string; token: string }
    const endpoint = new URL(enrollment.endpoint)
    const directory = await mkdtemp(join(tmpdir(), 'qianshou-public-relay-'))
    const coordinator = await DeviceCoordinator.open(join(directory, 'devices.json'))
    const server = createServer((_request, response) => { response.writeHead(404).end() })
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/qianshou-device') return void socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      coordinator.upgrade(request, socket, head)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('MISSING_TEST_PORT')
    let child: ChildProcess | undefined
    let peer: CompanionPeer | undefined
    const report: Record<string, unknown> = { endpoint: endpoint.origin, startedAt: new Date().toISOString(), source: 'real-production-device-classes', externalLlmCalls: 0 }
    const stop = async (): Promise<void> => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        await exited
      }
      child = undefined
    }
    type RelayStatus = { http?: { status: string }[]; tcp?: { status: string }[] }
    type RelayRun = { status: () => Promise<RelayStatus>; exited: Promise<unknown> }
    const start = async (change: Record<string, unknown> = {}): Promise<RelayRun> => {
      await stop()
      const listener = createServer()
      await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
      const admin = listener.address()
      if (!admin || typeof admin === 'string') throw new Error('MISSING_ADMIN_PORT')
      await new Promise<void>(resolve => listener.close(() => { resolve() }))
      const config = {
        user: enrollment.controllerId, serverAddr: endpoint.hostname, serverPort: Number(endpoint.port),
        loginFailExit: true,
        auth: { method: 'token', token: enrollment.token, additionalScopes: ['HeartBeats', 'NewWorkConns'] },
        transport: { protocol: 'wss', poolCount: 0, tls: { enable: true, serverName: endpoint.hostname, trustedCaFile: ca } },
        webServer: { addr: '127.0.0.1', port: admin.port, user: 'test', password: 'ephemeral-isolated-test' },
        log: { to: 'console', level: 'error', disablePrintColor: true },
        proxies: [{ name: 'devices', type: 'http', localIP: '127.0.0.1', localPort: address.port,
          customDomains: [endpoint.hostname], locations: ['/qianshou-device'] }], ...change,
      }
      const path = join(directory, 'frpc.json')
      await writeFile(path, JSON.stringify(config), { mode: 0o600 })
      child = spawn(binary!, ['-c', path], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: directory } })
      const exited = once(child, 'exit')
      return { exited, status: async () => {
        const response = await fetch(`http://127.0.0.1:${admin.port}/api/status`, { headers: { Authorization: 'Basic ' + Buffer.from('test:ephemeral-isolated-test').toString('base64') } })
        if (!response.ok) throw new Error('ADMIN_STATUS_UNAVAILABLE')
        return await response.json() as { http?: { status: string }[]; tcp?: { status: string }[] }
      } }
    }
    const rawFailure = (frame?: unknown, origin?: string): Promise<string> => new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint.origin.replace('https:', 'wss:') + '/qianshou-device', origin ? { origin } : {})
      socket.on('open', () => { if (frame) socket.send(JSON.stringify(frame)) })
      socket.on('close', (code) => { resolve(`CLOSED_${code}`) })
      socket.on('error', (error) => { resolve(error.message) })
      socket.on('message', () => { socket.terminate(); reject(new Error('UNAUTHENTICATED_MESSAGE_ACCEPTED')) })
    })
    try {
      const unauthorized = await start({ auth: { method: 'token', token: 'wrong-registration', additionalScopes: ['HeartBeats', 'NewWorkConns'] } })
      expect((await unauthorized.exited as unknown[])[0]).not.toBe(0)
      report.invalidRegistrationRejected = true
      const identity = await start({ user: 'qs-unregistered-controller' })
      expect((await identity.exited as unknown[])[0]).not.toBe(0)
      report.forgedControllerRejected = true
      const forged = await start({ proxies: [{ name: 'devices', type: 'tcp', localIP: '127.0.0.1', localPort: address.port, remotePort: 65535 }] })
      await expect.poll(async () => (await forged.status()).tcp?.[0]?.status, { timeout: 15_000 }).toBe('start error')
      report.arbitraryTcpRejected = true
      const valid = await start()
      await expect.poll(async () => (await valid.status()).http?.[0]?.status, { timeout: 15_000 }).toBe('running')
      report.verifiedTlsRegistration = true
      report.validRouteStatus = (await valid.status()).http
      for (const path of ['/', '/api/qianshou/devices', '/api/qianshou/pairings', '/qianshou-device/extra']) {
        expect((await fetch(endpoint.origin + path)).status).toBe(404)
      }
      expect((await fetch(endpoint.origin + '/qianshou-device')).status).toBe(426)
      report.nonDeviceHttpRejected = true
      const hello = { name: 'Relay acceptance fixture', platform: process.platform, arch: process.arch, workspaces: [{ id: 'workspace' as WorkspaceId, name: 'isolated-test', path: directory }] }
      expect(await rawFailure({ type: 'pair', code: 'wrong-pairing', hello })).toBe('CLOSED_4002')
      expect(await rawFailure({ type: 'auth', deviceId: 'forged', token: 'wrong-device-token', hello })).toBe('CLOSED_4002')
      expect(await rawFailure(undefined, 'https://malicious.invalid')).toContain('403')
      expect(await rawFailure()).toBe('CLOSED_4001')
      report.wrongPairingDeviceTokenOriginAndMissingAuthRejected = true
      let credential: PeerCredential | undefined
      peer = new CompanionPeer({ endpoint: endpoint.origin, code: coordinator.pairing().code, hello,
        changed: () => {}, saveCredential: async (value) => { credential = value }, saveJobs: async () => {} })
      peer.connect()
      await expect.poll(() => peer?.snapshot().connected, { timeout: 10_000 }).toBe(true)
      const job = await coordinator.submit({ deviceId: credential!.deviceId, workspaceId: 'workspace', kind: 'write', payload: { path: 'relay-receipt.txt', content: 'approved-through-guangzhou-public-tls' } })
      await expect.poll(() => peer?.snapshot().jobs.length, { timeout: 10_000 }).toBe(1)
      await expect(readFile(join(directory, 'relay-receipt.txt'), 'utf8')).rejects.toThrow()
      await peer.approve(job.id)
      await expect.poll(() => coordinator.snapshot().jobs[0]?.status, { timeout: 10_000 }).toBe('completed')
      expect(await readFile(join(directory, 'relay-receipt.txt'), 'utf8')).toBe('approved-through-guangzhou-public-tls')
      report.approvalRequiredAndResultReturned = true
      await coordinator.revoke(credential!.deviceId)
      await expect.poll(() => peer?.snapshot().connected, { timeout: 10_000 }).toBe(false)
      report.liveRevocation = true
      report.completedAt = new Date().toISOString()
      if (process.env.QIANSHOU_RELAY_RECEIPT) await writeFile(process.env.QIANSHOU_RELAY_RECEIPT, JSON.stringify(report, null, 2) + '\n')
    } finally {
      peer?.stop()
      await stop()
      await coordinator.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
      await rm(directory, { recursive: true, force: true })
    }
  }, 90_000)
})
