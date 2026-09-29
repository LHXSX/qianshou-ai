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
const image = (now = start) => ({ mode: 'image', adapter: 'qwen-image-api', status: 'ready', model: { id: 'qwen-image-2.1-int8-convrot', version: '2.1', sha256: null }, workflow: { id: 'qianshou-qwen-image21-text-to-image', version: null, sha256: null }, observedAt: new Date(now).toISOString() })
const video = (now = start) => ({ mode: 'video', adapter: 'local-video', status: 'unavailable', model: null, workflow: null, observedAt: new Date(now).toISOString() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qs-local-api-')); let now = start
  const store = new MediaNodeStore({ path: join(dir, 'nodes.sqlite'), heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 180000, clock: () => now })
  const reg = { deviceId: 'mac-fixture', deviceToken: randomBytes(32).toString('base64url'), adapterVersion: '1.0.0', capabilityRevision: 'empty-1', capabilities: [], maxConcurrency: 1 }
  const epoch = store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch
  const channel = () => store.channel(reg.deviceId, reg.deviceToken, epoch, 0)
  const heartbeat = () => store.heartbeat(reg.deviceId, reg.deviceToken, { connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 })
  channel(); heartbeat()
  const report = (revision = 'snapshot-1', observations = [image(), video()]) => ({ deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision: revision, observations })
  const result = (probe, observation = image(now)) => ({ deviceId: reg.deviceId, connectionEpoch: epoch, requestId: probe.requestId, observation })
  return { store, reg, epoch, channel, heartbeat, report, result, advance(ms) { now += ms }, now() { return now }, cleanup() { rmSync(dir, { recursive: true, force: true }) }, close() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('old channel and admin response retain their original keys until local observations are registered', () => {
  const f = fixture()
  try {
    assert.equal('apiProbes' in f.channel(), false)
    assert.equal('localServices' in f.store.adminList().nodes[0], false)
    const report = f.report(); const ack = f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, report)
    assert.deepEqual(ack, { ok: true, deviceId: f.reg.deviceId, connectionEpoch: f.epoch, observationRevision: 'snapshot-1' })
    f.advance(5000)
    assert.deepEqual(f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, report), ack)
    const probe = f.channel().apiProbes[0]
    assert.equal(probe.mode, 'image'); assert.equal(probe.kind, 'metadata'); assert.equal(probe.epoch, f.epoch)
    assert.equal(Date.parse(probe.expiresAt), start + 95000)
    assert.equal(f.channel().apiProbes[0].requestId, probe.requestId)
    assert.deepEqual(f.channel().tasks, []); assert.equal(f.channel().sequence, 0)
    const node = f.store.directory()[0]
    assert.deepEqual(node.media_profiles, []); assert.equal(node.freeSlots, 0); assert.equal(node.media_exchange_ready, false)
    assert.equal(f.store.adminList().nodes[0].localServices[1].status, 'unavailable')
  } finally { f.close() }
})

test('snapshots are closed, private-field-free, immutable and withdrawn modes cannot be revived by old retries', () => {
  const f = fixture()
  try {
    for (const mutate of [p => { p.origin = 'http://127.0.0.1:8190' }, p => { p.adapter = '127.0.0.1' }, p => { p.model.id = 'localhost' }, p => { p.model.path = '/private/model' }, p => { p.workflow.version = '../private' }, p => { p.model.sha256 = 'secret' }, p => { p.model = null }]) {
      const body = f.report(); mutate(body.observations[0])
      assert.throws(() => f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, body), /LOCAL_API_METADATA/)
    }
    assert.throws(() => f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, f.report('duplicate', [image(), image()])), /LOCAL_API_METADATA/)
    assert.throws(() => f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, f.report('old', [image(start - 60001)])), /LOCAL_API_OBSERVATION_STALE/)
    const body = f.report(); f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, body)
    const probe = f.channel().apiProbes[0]
    assert.throws(() => f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, f.report('snapshot-1', [video()])), /LOCAL_API_REVISION_CONFLICT/)
    f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, f.report('withdraw-2', []))
    assert.deepEqual(f.channel().apiProbes, []); assert.deepEqual(f.store.adminList().nodes[0].localServices, [])
    assert.throws(() => f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, f.result(probe)), /LOCAL_API_PROBE_SCOPE_INVALID/)
    assert.throws(() => f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, body), /LOCAL_API_REVISION_CONFLICT/)
  } finally { f.close() }
})

test('only the delivered original challenge can produce an immutable, time-bounded confirmation', () => {
  const f = fixture()
  try {
    f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, f.report())
    assert.throws(() => f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, f.result({ requestId: randomUUID() })), /LOCAL_API_PROBE_SCOPE_INVALID/)
    const probe = f.channel().apiProbes[0]; const body = f.result(probe)
    const ack = f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, body)
    assert.deepEqual(ack, { ok: true, deviceId: f.reg.deviceId, connectionEpoch: f.epoch, requestId: probe.requestId, status: 'confirmed', confirmedAt: new Date(start).toISOString() })
    assert.deepEqual(f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, body), ack)
    assert.throws(() => f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, { ...body, observation: { ...body.observation, status: 'unknown' } }), /LOCAL_API_PROBE_CONFLICT/)
    assert.equal(f.store.adminList().nodes[0].localServices[0].probe.state, 'confirmed')
    f.advance(5000); assert.deepEqual(f.channel().apiProbes, [])
    f.advance(55000); const renewed = f.channel().apiProbes[0]
    assert.notEqual(renewed.requestId, probe.requestId)
    f.advance(90000)
    assert.equal(f.store.adminList().nodes[0].localServices[0].probe.state, 'expired')
    assert.throws(() => f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, f.result(renewed)), /LOCAL_API_PROBE_EXPIRED/)
    assert.equal(f.store.adminList().nodes[0].totalTasks, 0)
    assert.equal(f.store.adminList().nodes[0].settledTasks, 0)
  } finally { f.close() }
})

test('probe confirmation remains bound to the reported model and workflow when local discovery changes', () => {
  const f = fixture()
  try {
    f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, f.report())
    const probe = f.channel().apiProbes[0]
    const base = f.result(probe)
    for (const observation of [
      { ...base.observation, model: { ...base.observation.model, id: 'different-model' } },
      { ...base.observation, workflow: { ...base.observation.workflow, id: 'different-workflow' } },
      { ...base.observation, model: { ...base.observation.model, version: '3.0' } },
    ]) assert.throws(() => f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, { ...base, observation }), /LOCAL_API_PROBE_SCOPE_INVALID/)
    assert.equal(f.store.adminList().nodes[0].localServices[0].probe.state, 'pending')
    const refined = { ...base.observation,
      model: { ...base.observation.model, sha256: 'a'.repeat(64) },
      workflow: { ...base.observation.workflow, sha256: 'b'.repeat(64), version: '1.0' } }
    assert.equal(f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, { ...base, observation: refined }).status, 'confirmed')
    const service = f.store.adminList().nodes[0].localServices[0]
    assert.equal(service.model.sha256, 'a'.repeat(64))
    assert.equal(service.workflow.version, '1.0')
  } finally { f.close() }
})

test('reconnect and authorization withdrawal invalidate API receipts without granting or cancelling task leases', () => {
  const f = fixture()
  try {
    f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, f.report()); const probe = f.channel().apiProbes[0]
    const ref = randomUUID(); const preview = f.store.adminPreview(f.reg.deviceId, 'pause', ref)
    f.store.adminApply(f.reg.deviceId, 'pause', ref, '1', 'fixture pause', preview.preview.before)
    assert.deepEqual(f.channel().apiProbes, [])
    assert.throws(() => f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, f.result(probe)), /LOCAL_API_PROBE_SCOPE_INVALID/)
    assert.equal(f.store.adminList().nodes[0].localServices[0].status, 'unknown')
    const next = f.store.reconnect(f.reg.deviceId, f.reg.deviceToken, f.reg.capabilityRevision)
    assert.equal('apiProbes' in f.store.channel(f.reg.deviceId, f.reg.deviceToken, next.connectionEpoch, 0), false)
    assert.equal('localServices' in f.store.adminList().nodes[0], false)
    assert.throws(() => f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, f.result(probe)), /CONNECTION_EPOCH_STALE/)
  } finally { f.close() }
})

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}` }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
test('real HTTP and SQLite roundtrip reads only local metadata and keeps task cursors and paid capabilities empty', async () => {
  const f = fixture(); const calls = []
  const local = createServer((req, res) => {
    calls.push([req.method, req.url]); res.setHeader('content-type', 'application/json')
    if (req.method !== 'GET') { res.writeHead(405); res.end('{}'); return }
    const data = { '/health': { ok: true }, '/v1/models': { models: [image().model] }, '/v1/workflows': { workflows: [image().workflow] } }[req.url]
    if (!data) res.writeHead(404); res.end(JSON.stringify(data ?? {}))
  })
  const localOrigin = await listen(local)
  const routes = createMediaNodeRoutes({ store: f.store, verifyAccount: async () => null, dispatchToken: async () => undefined, maxLongPollRequests: 2 })
  const server = createServer((req, res) => { const route = routes.routes.find(p => p.path === req.url); if (!route) { res.writeHead(404); res.end(); return }; void route.handler(req, res) })
  const origin = await listen(server)
  const post = async (path, body, token = f.reg.deviceToken, extra = {}) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    assert.equal((await post('/v1/nodes/api-observations', f.report(), 'wrong-token')).status, 401)
    assert.equal((await post('/v1/nodes/api-observations', f.report(), f.reg.deviceToken, { origin: 'https://untrusted.invalid' })).status, 403)
    assert.equal((await post('/v1/nodes/api-observations', f.report())).status, 200)
    const channel = (await post('/v1/nodes/channel', { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, afterSequence: 0, waitMs: 25000 })).body
    assert.equal(channel.apiProbes.length, 1); assert.equal(channel.sequence, 0); assert.deepEqual(channel.tasks, [])
    for (const path of ['/health', '/v1/models', '/v1/workflows']) assert.equal((await fetch(localOrigin + path)).status, 200)
    const ack = await post('/v1/nodes/api-probe-result', f.result(channel.apiProbes[0]))
    assert.equal(ack.status, 200); assert.equal(ack.body.status, 'confirmed')
    assert.deepEqual((await post('/v1/nodes/api-probe-result', f.result(channel.apiProbes[0]))).body, ack.body)
    assert.deepEqual(calls, [['GET', '/health'], ['GET', '/v1/models'], ['GET', '/v1/workflows']])
    const node = f.store.adminList().nodes[0]
    assert.equal(node.localServices[0].probe.state, 'confirmed')
    assert.equal(node.localServices[1].status, 'unavailable'); assert.equal(node.totalTasks, 0)
    const projection = JSON.stringify(node)
    assert.equal(projection.includes(f.reg.deviceToken), false); assert.equal(projection.includes(localOrigin), false)
    assert.deepEqual(f.store.directory()[0].media_profiles, []); assert.equal(f.store.directory()[0].freeSlots, 0)
  } finally { await routes.close(); await close(server); await close(local); f.cleanup() }
})

test('another Windows account registers, confirms one local API and appears automatically without a task grant', async () => {
  const f = fixture()
  const ownerToken = 'windows-account-fixture-token'
  const reg = { deviceId: 'windows-5080-fixture', deviceToken: randomBytes(32).toString('base64url'),
    adapterVersion: '1.0.0', capabilityRevision: 'windows-empty-1', capabilities: [], maxConcurrency: 1 }
  const routes = createMediaNodeRoutes({ store: f.store, verifyAccount: async request =>
    request.headers.get('authorization') === `Bearer ${ownerToken}` ? { accountId: '222', username: '222222' } : null,
  dispatchToken: async () => undefined, maxLongPollRequests: 2 })
  const server = createServer((req, res) => { const route = routes.routes.find(p => p.path === req.url)
    if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  const origin = await listen(server)
  const post = async (path, token, body) => { const response = await fetch(origin + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() } }
  try {
    const registration = await post('/v1/nodes/register', ownerToken, reg)
    assert.equal(registration.status, 200)
    const epoch = registration.body.connectionEpoch
    const channel = body => post('/v1/nodes/channel', reg.deviceToken, { deviceId: reg.deviceId,
      connectionEpoch: epoch, afterSequence: 0, waitMs: 0, ...body })
    assert.equal((await channel()).status, 200)
    assert.equal((await post('/v1/nodes/heartbeat', reg.deviceToken, { deviceId: reg.deviceId,
      connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: 0,
      runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 })).status, 200)
    const observed = { ...image(), adapter: 'comfyui', workflow: { id: 'comfy-pilot-image-154f7d6133fe0276',
      sha256: '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be', version: '1' } }
    assert.equal((await post('/v1/nodes/api-observations', reg.deviceToken, { deviceId: reg.deviceId,
      connectionEpoch: epoch, observationRevision: 'windows-1', observations: [observed] })).status, 200)
    const probe = (await channel()).body.apiProbes[0]
    assert.equal((await post('/v1/nodes/api-probe-result', reg.deviceToken, { deviceId: reg.deviceId,
      connectionEpoch: epoch, requestId: probe.requestId, observation: observed })).body.status, 'confirmed')
    const admin = f.store.adminList().nodes.find(node => node.deviceId === reg.deviceId)
    assert.equal(admin.username, '222222'); assert.equal(admin.online, true)
    assert.equal(admin.localServices[0].probe.state, 'confirmed')
    const directory = f.store.researchDirectory(randomUUID()).nodes.find(node => node.deviceId === reg.deviceId)
    assert.equal(directory.ownerId, '222'); assert.equal(directory.localServices[0].availableForTrial, false)
    assert.equal(JSON.stringify(admin).includes(reg.deviceToken), false)
    assert.equal(f.store.directory().find(node => node.deviceId === reg.deviceId).media_exchange_ready, false)
  } finally { await routes.close(); await close(server); f.cleanup() }
})
