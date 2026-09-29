import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { MediaNodeStore, parseMediaNodeRegistration } from '../src/media-node-store.ts'
import { createMediaNodeRoutes } from '../src/media-node-http.ts'

const start = Date.parse('2030-01-01T00:00:00.000Z')
const observation = (time = start) => ({ mode: 'image', adapter: 'comfyui', status: 'ready', model: { id: 'qwen-image-2.1-int8-convrot', sha256: null, version: '2.1' }, workflow: { id: 'comfy-pilot-image-154f7d6133fe0276', sha256: '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be', version: '1' }, observedAt: new Date(time).toISOString() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qs-research-directory-')); let now = start
  const store = new MediaNodeStore({ path: join(dir, 'nodes.sqlite'), heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 180000, clock: () => now })
  const reg = { deviceId: 'mac-fixture', deviceToken: randomBytes(32).toString('base64url'), capabilityRevision: 'empty-1', adapterVersion: '1.0.0', capabilities: [], maxConcurrency: 1 }
  const epoch = store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch
  const heartbeat = () => store.heartbeat(reg.deviceId, reg.deviceToken, { connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 })
  store.channel(reg.deviceId, reg.deviceToken, epoch, 0); heartbeat()
  let revision = 'report-1'
  const report = (observationRevision = 'report-1', observations = [observation(now)]) => { revision = observationRevision; return store.apiObservations(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision, observations }) }
  const resources = () => store.researchExecution(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision: revision, mode: 'image', idle: true, resourceAllowed: true })
  const confirm = () => { const p = store.channel(reg.deviceId, reg.deviceToken, epoch, 0).apiProbes[0]; store.apiProbeResult(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, requestId: p.requestId, observation: observation(now) }); resources() }
  return { dir, store, reg, epoch, report, confirm, heartbeat, advance(ms) { now += ms }, cleanup() { rmSync(dir, { recursive: true, force: true }) }, close() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('probe-confirmed research readiness uses existing owner/device metadata without a worker or formal profile', () => {
  const f = fixture()
  try {
    let nonce = randomUUID(); let response = f.store.researchDirectory(nonce)
    assert.equal(response.nonce, nonce); assert.equal(response.schema, 'qianshou.research-api-directory.v1')
    assert.equal(response.dispatchAuthority, 'none'); assert.equal(response.formalQualification, 'not_evaluated')
    assert.deepEqual(response.nodes[0].localServices, [])
    f.report(); response = f.store.researchDirectory(randomUUID())
    assert.equal(response.nodes[0].localServices[0].modeGrant, 'reported')
    assert.equal(response.nodes[0].localServices[0].availableForTrial, false)
    f.confirm(); response = f.store.researchDirectory(randomUUID())
    assert.equal(response.nodes[0].localServices[0].availableForTrial, true)
    assert.deepEqual(f.store.directory()[0].media_profiles, []); assert.equal(f.store.directory()[0].freeSlots, 0)
    assert.equal(f.store.adminList().nodes[0].totalTasks, 0)
    f.advance(120000); f.heartbeat()
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].localServices[0].availableForTrial, false)
    f.report('withdraw-2', [])
    assert.deepEqual(f.store.researchDirectory(randomUUID()).nodes[0].localServices, [])
  } finally { f.close() }
})

test('reconnect, heartbeat expiry and server pause cannot retain trial availability', () => {
  const f = fixture()
  try {
    f.report(); f.confirm(); f.advance(180000)
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].online, false)
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].localServices[0].availableForTrial, false)
    f.heartbeat(); f.report('report-2'); f.confirm()
    const ref = randomUUID(); const preview = f.store.adminPreview(f.reg.deviceId, 'pause', ref)
    f.store.adminApply(f.reg.deviceId, 'pause', ref, '1', 'fixture pause', preview.preview.before)
    const paused = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(paused.authorization, 'paused'); assert.equal(paused.localServices[0].availableForTrial, false)
    const next = f.store.reconnect(f.reg.deviceId, f.reg.deviceToken, f.reg.capabilityRevision)
    const replaced = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(replaced.connectionEpoch, next.connectionEpoch); assert.deepEqual(replaced.localServices, [])
  } finally { f.close() }
})

test('a different discovered image workflow is visible after confirmation but not offered to the fixed trial dispatcher', () => {
  const f = fixture()
  try {
    const other = { ...observation(), model: { id: 'local-image-model', sha256: null, version: '1' },
      workflow: { id: 'local-image-workflow', sha256: null, version: '1' } }
    f.report('other-1', [other])
    const probe = f.store.channel(f.reg.deviceId, f.reg.deviceToken, f.epoch, 0).apiProbes[0]
    f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, { deviceId: f.reg.deviceId,
      connectionEpoch: f.epoch, requestId: probe.requestId, observation: other })
    f.store.researchExecution(f.reg.deviceId, f.reg.deviceToken, { deviceId: f.reg.deviceId,
      connectionEpoch: f.epoch, observationRevision: 'other-1', mode: 'image', idle: true, resourceAllowed: true })
    const node = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(node.localServices[0].probe.state, 'confirmed')
    assert.equal(node.localServices[0].model.id, 'local-image-model')
    assert.equal(node.localServices[0].availableForTrial, false)
    assert.equal(f.store.adminList().nodes[0].localServices[0].model.id, 'local-image-model')
  } finally { f.close() }
})

test('bounded directory keeps at most 128 nodes and excludes an address disguised as a device identifier', () => {
  const f = fixture()
  try {
    const long = 'a'.repeat(128)
    for (let index = 0; index < 129; index += 1) {
      const reg = { ...f.reg, deviceId: `node-${String(index).padStart(3, '0')}`, deviceToken: randomBytes(32).toString('base64url') }
      const epoch = f.store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch
      const metadata = { ...observation(), adapter: long, model: { id: long, sha256: 'a'.repeat(64), version: long }, workflow: { id: long, sha256: 'b'.repeat(64), version: long } }
      f.store.apiObservations(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision: 'report-1', observations: [metadata, { ...metadata, mode: 'video' }] })
    }
    const directory = f.store.researchDirectory(randomUUID())
    assert.equal(directory.nodes.length, 128); assert.equal(directory.truncated, true)
    assert(Buffer.byteLength(JSON.stringify(directory)) < 512 * 1024)
    f.store.register('167', parseMediaNodeRegistration({ ...f.reg, deviceId: '127.0.0.1', deviceToken: randomBytes(32).toString('base64url') }))
    assert.equal(f.store.researchDirectory(randomUUID()).nodes.some(n => n.deviceId === '127.0.0.1'), false)
  } finally { f.close() }
})

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}` }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
test('real HTTP research read identity is independent of node, dispatch and admin authority and returns only metadata', async () => {
  const f = fixture(); const readToken = randomBytes(32).toString('base64url'); const dispatchToken = randomBytes(32).toString('base64url'); const adminToken = randomBytes(32).toString('base64url')
  const routes = createMediaNodeRoutes({ store: f.store, verifyAccount: async () => null, maxLongPollRequests: 2, dispatchToken: async () => dispatchToken, researchDirectoryToken: async () => readToken,
    adminControl: { keyId: 'admin', audience: 'admin', scopes: ['nodes.read'], token: async () => adminToken } })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (!route) { res.writeHead(404); res.end(); return }; void route.handler(req, res) })
  const base = await listen(server)
  const post = async (path, token, body, headers = {}) => { const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') } }
  try {
    f.report(); f.confirm(); const path = '/internal/media/research/nodes'
    for (const token of [undefined, f.reg.deviceToken, dispatchToken, adminToken]) assert.equal((await post(path, token, { nonce: randomUUID() })).status, 401)
    for (const body of [{}, { nonce: 'not-a-uuid' }, { nonce: randomUUID(), ownerId: '168' }, { nonce: randomUUID(), token: 'leak' }]) assert.equal((await post(path, readToken, body)).status, 400)
    assert.equal((await post(path, readToken, { nonce: randomUUID() }, { origin: 'https://untrusted.invalid' })).status, 403)
    const nonce = randomUUID(); const result = await post(path, readToken, { nonce })
    assert.equal(result.status, 200); assert.equal(result.cache, 'no-store'); assert.equal(result.body.nonce, nonce)
    assert.deepEqual(Object.keys(result.body).sort(), ['dispatchAuthority','formalQualification','generatedAt','nodes','nonce','ok','schema','truncated'].sort())
    assert.deepEqual(Object.keys(result.body.nodes[0]).sort(), ['authorization','connectionEpoch','deviceId','execution','lastHeartbeatAt','localServices','online','ownerId'].sort())
    assert.equal(result.body.nodes[0].localServices[0].availableForTrial, true)
    assert.equal(JSON.stringify(result.body).includes(f.reg.deviceToken), false); assert.equal(JSON.stringify(result.body).includes(readToken), false)
    assert.equal((await post('/internal/media/nodes', readToken, {})).status, 401)
    assert.equal((await post('/internal/media/dispatch', readToken, {})).status, 401)
    assert.equal((await post('/internal/media/settlement', readToken, {})).status, 401)
    assert.equal((await post('/internal/media/admin/list', readToken, {})).status, 401)
    assert.equal(f.store.adminList().nodes[0].totalTasks, 0)
  } finally { await routes.close(); await close(server); f.cleanup() }
})
