import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
const { WebSocket, WebSocketServer } = createRequire(new URL('../../../../packages/host/remote-devices/package.json', import.meta.url))('ws')
import { parseEnrollment, frpcConfig, readEnrollment, verifyResources } from '../config.mjs'
import { startDeviceGateway } from '../gateway.mjs'
import { connectionStatus, readFrpcStatus } from '../process.mjs'
import { enrollmentStore } from '../store.mjs'
import { RelayService } from '../service.mjs'
import { registerRelayIpc } from '../ipc.mjs'

const enrollment = { version: 1, endpoint: 'https://203.0.113.20:24443', controllerId: 'qs-' + 'a'.repeat(24), token: 'b'.repeat(64) }
const directory = async t => { const path = await mkdtemp(join(tmpdir(), 'qianshou-relay-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => server.close(resolve))
function secureStorage() {
  const key = randomBytes(32)
  return { isEncryptionAvailable: () => true,
    encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]) },
    decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  }
}

test('registration fixes endpoint/owner format and rejects credential-bearing URLs or arbitrary routes', () => {
  assert.equal(parseEnrollment(enrollment).endpoint, enrollment.endpoint)
  for (const value of [null, {}, { ...enrollment, endpoint: 'https://attacker.example' }, { ...enrollment, endpoint: enrollment.endpoint + '/api' }, { ...enrollment, controllerId: 'someone-else' }, { ...enrollment, proxies: [] }, { ...enrollment, token: 'short' }]) assert.throws(() => parseEnrollment(value), /INVALID_ENROLLMENT/u)
  const config = frpcConfig(enrollment, { ca: '/bundle/public-ca.pem', gatewayPort: 40001, adminPort: 40002, adminPassword: 'ephemeral-status-only' })
  assert.deepEqual(config.proxies, [{ name: 'devices', type: 'http', localIP: '127.0.0.1', localPort: 40001, customDomains: ['203.0.113.20'], locations: ['/qianshou-device'] }])
  assert.equal(config.transport.tls.trustedCaFile, '/bundle/public-ca.pem')
  assert.equal(config.webServer.addr, '127.0.0.1')
  assert.equal(config.loginFailExit, false)
})

test('bounded native import and authenticated encryption preserve a private registration', async t => {
  const dir = await directory(t), source = join(dir, 'input.json')
  await writeFile(source, JSON.stringify(enrollment))
  assert.equal((await readEnrollment(source)).controllerId, enrollment.controllerId)
  await writeFile(source, ' '.repeat(8193))
  await assert.rejects(readEnrollment(source), /INVALID_ENROLLMENT/u)
  const crypto = secureStorage(), store = enrollmentStore(join(dir, 'private'), crypto)
  assert.equal(await store.load(), undefined)
  await store.save(enrollment)
  const bytes = await readFile(join(dir, 'private', 'registration.bin'))
  assert.equal(bytes.includes(Buffer.from(enrollment.token)), false)
  assert.equal((await store.load()).controllerId, enrollment.controllerId)
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'private', 'registration.bin'))).mode & 0o777, 0o600)
  await assert.rejects(enrollmentStore(join(dir, 'private'), { ...crypto, isEncryptionAvailable: () => false }).load(), /SECURE_STORAGE_UNAVAILABLE/u)
  await assert.rejects(enrollmentStore(join(dir, 'weak'), { ...crypto, getSelectedStorageBackend: () => 'basic_text' }).save(enrollment), /SECURE_STORAGE_UNAVAILABLE/u)
})

test('resource validation checks target and both resource hashes before execution', async t => {
  const dir = await directory(t), hash = value => createHash('sha256').update(value).digest('hex')
  await writeFile(join(dir, 'frpc'), 'fixture')
  await writeFile(join(dir, 'isrg-roots.pem'), 'public-ca')
  const manifest = { version: 1, frpcVersion: '0.71.0', platform: 'darwin', arch: 'arm64', binary: { file: 'frpc', sha256: hash('fixture') }, ca: { file: 'isrg-roots.pem', sha256: hash('public-ca') } }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
  assert.equal((await verifyResources(dir, 'darwin', 'arm64')).binary, join(dir, 'frpc'))
  await assert.rejects(verifyResources(dir, 'win32', 'x64'), /INVALID_RELAY_RESOURCES/u)
  await writeFile(join(dir, 'isrg-roots.pem'), 'changed-ca')
  await assert.rejects(verifyResources(dir, 'darwin', 'arm64'), /INVALID_RELAY_RESOURCES/u)
})

test('gateway forwards only the exact native WebSocket and drains open connections', async t => {
  let ordinary = 0
  const target = createServer((_req, res) => { ordinary++; res.end('PRIVATE_API') })
  const ws = new WebSocketServer({ noServer: true })
  target.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, client => client.on('message', data => client.send(data))))
  const targetPort = await listen(target), gateway = await startDeviceGateway(targetPort)
  t.after(async () => { for (const client of ws.clients) client.terminate(); await close(target) })
  for (const path of ['/', '/api/qianshou/devices', '/qianshou-device/extra', '/qianshou-device?token=example']) assert.equal((await fetch(`http://127.0.0.1:${gateway.port}${path}`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/qianshou-device`)).status, 426)
  const rejected = new WebSocket(`ws://127.0.0.1:${gateway.port}/qianshou-device`, { origin: 'https://untrusted.example' })
  assert.match(await new Promise(resolve => rejected.on('error', error => resolve(error.message))), /403/u)
  const client = new WebSocket(`ws://127.0.0.1:${gateway.port}/qianshou-device`)
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
  const message = new Promise(resolve => client.once('message', data => resolve(data.toString())))
  client.send('native-device-frame')
  assert.equal(await message, 'native-device-frame')
  assert.equal(ordinary, 0)
  const ended = new Promise(resolve => client.once('close', resolve))
  await gateway.close(); await ended
  await assert.rejects(fetch(`http://127.0.0.1:${gateway.port}/api`))
})

test('status requires the observed route, local target and server vhost address', async t => {
  const route = { name: 'devices', type: 'http', status: 'running', err: '', local_addr: '127.0.0.1:41234', remote_addr: '203.0.113.20:17441' }
  assert.equal(connectionStatus({}, enrollment, 41234), 'connecting')
  assert.equal(connectionStatus({ http: [route] }, enrollment, 41234), 'online')
  for (const change of [{ remote_addr: 'evil.example:17441' }, { local_addr: '127.0.0.1:1' }, { err: 'registration failed' }, { type: 'tcp' }]) assert.equal(connectionStatus({ http: [{ ...route, ...change }] }, enrollment, 41234), 'error')
  const server = createServer((req, res) => { assert.equal(req.url, '/api/status'); assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('qianshou:test').toString('base64')); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ http: [route] })) })
  t.after(() => close(server))
  const port = await listen(server)
  assert.equal((await readFrpcStatus(port, 'test')).http[0].status, 'running')
})

test('service begins off, encrypts import, serializes shutdown and never starts after close', async t => {
  const dir = await directory(t), source = join(dir, 'import.json')
  await writeFile(source, JSON.stringify(enrollment))
  const service = new RelayService({ directory: join(dir, 'private'), resourcesDirectory: new URL('../resources', import.meta.url).pathname, backendPort: 40000, secureStorage: secureStorage(), start: async () => ({ status: async () => 'online', stop: async () => { stopped++; await new Promise(resolve => setTimeout(resolve, 20)) } }) })
  let stopped = 0
  assert.equal((await service.status()).enabled, false)
  await service.importFile(source)
  assert.equal((await service.status()).phase, 'disabled')
  assert.equal((await service.setEnabled(true)).phase, 'online')
  await assert.rejects(service.importFile(source), /RELAY_DISABLE_BEFORE_IMPORT/u)
  const closing = service.close()
  await assert.rejects(service.setEnabled(true), /RELAY_UNAVAILABLE/u)
  await closing
  assert.equal(stopped, 1)
  assert.equal((await service.status()).enabled, false)
  assert.deepEqual(await readdir(join(dir, 'private')), ['registration.bin'])
})

test('native IPC rejects untrusted senders and exposes no file or arbitrary command argument', async () => {
  const handlers = new Map(), actions = [], status = { configured: false, enabled: false, phase: 'unconfigured', endpoint: null, error: null }
  const dispose = registerRelayIpc({ ipcMain: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key) }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/native-selected.json'] }) }, window: {}, trusted: event => event.trusted, ready: () => true, importTitle: 'fixture',
    relay: { status: async () => status, importFile: async path => { actions.push(path); return status }, setEnabled: async enabled => { if (typeof enabled !== 'boolean') throw new Error('INVALID_RELAY_ACTION'); actions.push(enabled); return status } } })
  assert.deepEqual(await handlers.get('qianshou:relay-import')({}, '/attacker.json'), { ok: false, error: 'UNTRUSTED_SENDER' })
  await handlers.get('qianshou:relay-import')({ trusted: true }, '/attacker.json')
  assert.deepEqual(actions, ['/native-selected.json'])
  assert.equal((await handlers.get('qianshou:relay-enable')({ trusted: true }, 'shell command')).ok, false)
  dispose(); assert.equal(handlers.size, 0)
})
