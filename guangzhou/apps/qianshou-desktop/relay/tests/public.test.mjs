/** Explicit WAN acceptance: isolated coordinator, production relay runtime, real companion protocol. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { createRequire } from 'node:module'
import { RelayService } from '../service.mjs'
const { WebSocket } = createRequire(new URL('../../../../packages/host/remote-devices/package.json', import.meta.url))('ws')
const registrationPath = process.env.QIANSHOU_RELAY_ENROLLMENT
const until = async predicate => { const deadline = Date.now() + 20000; while (!await predicate()) { if (Date.now() > deadline) throw new Error('RELAY_ACCEPTANCE_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 150)) } }

test('desktop sidecar registers the verified route, pairs an approved companion and drains on disable', { skip: !registrationPath, timeout: 60000 }, async () => {
  const { DeviceCoordinator } = await import('../../../../packages/host/remote-devices/src/coordinator.ts')
  const { CompanionPeer } = await import('../../../qianshou-companion/src/peer.ts')
  const directory = await mkdtemp(join(tmpdir(), 'qianshou-desktop-wan-'))
  const key = randomBytes(32)
  const secureStorage = { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  }
  const coordinator = await DeviceCoordinator.open(join(directory, 'coordinator.json'))
  let ordinary = 0
  const server = createServer((_request, response) => { ordinary++; response.end('PRIVATE_BACKEND') })
  server.on('upgrade', (request, socket, head) => coordinator.upgrade(request, socket, head))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const privateDirectory = join(directory, 'relay')
  const service = new RelayService({ directory: privateDirectory, resourcesDirectory: new URL('../resources', import.meta.url).pathname, backendPort: server.address().port, secureStorage })
  let peer
  const report = { startedAt: new Date().toISOString(), liveUserBackendAccessed: false, externalLlmCalls: 0, credentialEncryption: 'isolated AES fixture; Electron OS vault acceptance separate' }
  try {
    assert.equal((await service.status()).enabled, false)
    await service.importFile(registrationPath)
    assert.equal((await service.status()).phase, 'disabled')
    await service.setEnabled(true)
    await until(async () => (await service.status()).phase === 'online')
    const status = await service.status()
    assert.deepEqual(Object.keys(status).sort(), ['configured', 'enabled', 'endpoint', 'error', 'phase'])
    report.endpoint = status.endpoint
    report.actualFrpcStatusOnline = true
    for (const path of ['/api/qianshou/devices', '/api/qianshou/pairings', '/qianshou-device/extra']) assert.equal((await fetch(status.endpoint + path)).status, 404)
    // The public ingress rejects query-bearing requests before the local gateway.
    assert.equal((await fetch(status.endpoint + '/qianshou-device?extra=1')).status, 400)
    assert.equal((await fetch(status.endpoint + '/qianshou-device')).status, 426)
    assert.equal(ordinary, 0)
    const wrong = new WebSocket(status.endpoint.replace('https:', 'wss:') + '/qianshou-device', { origin: 'https://untrusted.example' })
    assert.match(await new Promise(resolve => wrong.once('error', error => resolve(error.message))), /403/u)
    report.privateApisAndBrowserOriginRejected = true
    let credential
    const hello = { name: 'Isolated desktop relay acceptance', platform: process.platform, arch: process.arch, workspaces: [{ id: 'fixture', name: 'isolated-workspace', path: directory }] }
    peer = new CompanionPeer({ endpoint: status.endpoint, code: coordinator.pairing().code, hello,
      changed: () => {}, saveCredential: async value => { credential = value }, saveJobs: async () => {} })
    peer.connect()
    await until(() => peer.snapshot().connected)
    const job = await coordinator.submit({ deviceId: credential.deviceId, workspaceId: 'fixture', kind: 'write', payload: { path: 'approved-result.txt', content: 'desktop-sidecar-approved-result' } })
    await until(() => peer.snapshot().jobs.length === 1)
    await assert.rejects(readFile(join(directory, 'approved-result.txt')))
    await peer.approve(job.id)
    await until(() => coordinator.snapshot().jobs[0].status === 'completed')
    assert.equal(await readFile(join(directory, 'approved-result.txt'), 'utf8'), 'desktop-sidecar-approved-result')
    report.explicitApprovalAndActualFileResult = true
    await service.setEnabled(false)
    await until(() => !peer.snapshot().connected)
    assert.equal((await service.status()).phase, 'disabled')
    assert.deepEqual(await readdir(privateDirectory), ['registration.bin'])
    report.disabledConnectionAndTemporarySecretsRemoved = true
    peer.stop()
    await service.setEnabled(true)
    await until(async () => (await service.status()).phase === 'online')
    await service.close()
    assert.deepEqual(await readdir(privateDirectory), ['registration.bin'])
    const reopened = new RelayService({ directory: privateDirectory, resourcesDirectory: new URL('../resources', import.meta.url).pathname, backendPort: server.address().port, secureStorage })
    assert.equal((await reopened.status()).phase, 'disabled')
    await reopened.close()
    report.reenableShutdownAndRestartOff = true
    report.completedAt = new Date().toISOString()
    if (process.env.QIANSHOU_RELAY_RECEIPT) await writeFile(process.env.QIANSHOU_RELAY_RECEIPT, JSON.stringify(report, null, 2) + '\n')
  } finally {
    peer?.stop()
    await service.close()
    await coordinator.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
