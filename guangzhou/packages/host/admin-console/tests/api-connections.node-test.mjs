import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { MediaNodeStore, parseMediaNodeRegistration } from '../../model-gateway/src/media-node-store.ts'
import { createMediaNodeRoutes } from '../../model-gateway/src/media-node-http.ts'
import { createAdminService, API_PREFIX } from '../src/server.ts'
import { can, permissionOf } from '../src/rbac.ts'
import { createApiPlatformMetadata } from '../src/api-connections-platform.ts'

const serviceKey = randomBytes(32).toString('base64url')
const refName = 'QS_MEDIA_NODE_ADMIN_KEY'
const cap = { profile_id: 'image-fixture', profile_version: 1, model_sha256: 'a'.repeat(64), workflow_sha256: 'b'.repeat(64), validation_receipt_sha256: 'c'.repeat(64) }
const registration = id => ({ deviceId: id, deviceToken: randomBytes(32).toString('base64url'), adapterVersion: '1.0.0', capabilityRevision: 'revision-1', capabilities: [cap], maxConcurrency: 1 })
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
async function harness({ scope = 'all', permissions, configured = true, probeMode = 'normal', integrationFlags, emptyPresence = false, decorateLocal = false, invalidLocal = false, hardwarePatch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qs-api-connections-')); const home = join(dir, 'home')
  await mkdir(home); await mkdir(join(dir, 'web')); await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  ' + refName + ': ' + serviceKey + '\n', { mode: 0o600 })
  const store = new MediaNodeStore({ path: join(dir, 'nodes.sqlite'), heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 30000 })
  const reg = registration('owned-node'); const foreign = registration('other-node')
  if (emptyPresence) reg.capabilities = []
  const epoch = store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch
  store.register('168', parseMediaNodeRegistration(foreign))
  store.channel(reg.deviceId, reg.deviceToken, epoch, 0)
  store.heartbeat(reg.deviceId, reg.deviceToken, { connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: emptyPresence ? 0 : 1, runningAttemptIds: [], freeVramMb: 10000, availableSeconds: 60 })
  const routes = createMediaNodeRoutes({ store, verifyAccount: async r => r.headers.get('authorization') === 'Bearer fixture-account-private' ? { accountId: '167' } : null, dispatchToken: async () => undefined, maxLongPollRequests: 8,
    adminControl: { keyId: 'node-admin', audience: 'node-console', scopes: ['nodes.read', 'nodes.manage'], token: async () => serviceKey } })
  let gatewayCalls = 0; let unknownApply = false; const probeRequests = []
  const gateway = createServer((req, res) => {
    const url = new URL(req.url, 'http://local'); const route = routes.routes.find(r => r.path === url.pathname)
    if (!route) { res.writeHead(404); res.end(); return }
    if (req.url.includes('/internal/media/admin/')) gatewayCalls++
    if (url.pathname === '/v1/nodes/probe') {
      probeRequests.push({ headers: req.headers, nonce: url.searchParams.get('nonce') })
      if (probeMode === 'timeout') return
      if (probeMode === '401' || probeMode === '503') { res.writeHead(Number(probeMode), { 'cache-control': 'no-store' }); res.end('{}'); return }
      if (probeMode !== 'normal') {
        const body = { schema: 'qianshou.media-gateway-probe.v1', service: 'qianshou-guangzhou-media', nonce: url.searchParams.get('nonce'), time: Math.floor(Date.now() / 1000) }
        if (probeMode === 'stale') body.time -= 120
        if (probeMode === 'nonce') body.nonce = randomUUID()
        if (probeMode === 'extra') body.authorization = 'active'
        res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return
      }
    }
    void route.handler(req, res)
  })
  await listen(gateway); const base = 'http://127.0.0.1:' + gateway.address().port
  const service = createAdminService({ dataDir: dir, webRoot: join(dir, 'web'), origin: 'https://admin.test', accountBaseUrl: 'https://shanghai.test', dshHome: home, tiersPath: join(dir, 'missing.ts'), trustProxy: false,
    ...(configured ? { apiConnections: { baseUrl: base, keyId: 'node-admin', credentialRef: refName, audience: 'node-console' } } : {}),
    apiConnectionsPlatform: { probeTimeoutMs: 100 },
    fetch: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/auth/login')) return Response.json({ access_token: 'fixture-account-private', refresh_token: 'fixture-refresh-private', account: { id: '167', username: 'admin' } })
      if (url.endsWith('/auth/me')) return Response.json({ account: { id: '167', username: 'admin' } })
      if (url.startsWith('https://app.qianshousuanli.com/v1/nodes/probe?')) return fetch(base + new URL(url).pathname + new URL(url).search, init)
      const response = await fetch(input, init)
      if (unknownApply && url.endsWith('/internal/media/admin/apply')) { unknownApply = false; await response.body.cancel(); throw new Error('fixture lost response after commit') }
      if (url.endsWith('/internal/media/admin/list') && (integrationFlags !== undefined || decorateLocal || invalidLocal || hardwarePatch !== undefined)) {
        const result = await response.json()
        for (const n of result.nodes ?? []) for (const service of n.localServices ?? []) {
          if (decorateLocal) { service.privateOrigin = 'http://127.0.0.1:8189'; service.token = 'private-upstream-token'; service.model.path = '/private/model'; service.probe.credential = 'private-probe-token' }
          if (invalidLocal) service.model.id = 'http://127.0.0.1/model'
        }
        if (hardwarePatch !== undefined) for (const n of result.nodes ?? []) n.deviceInfo = { ...n.deviceInfo, ...hardwarePatch }
        return Response.json({ ...result, ...(integrationFlags === undefined ? {} : { integration: integrationFlags }) })
      }
      return response
    } })
  const roleId = permissions ? 'node-test' : 'super-admin'
  await service.components.admins.save({ version: 1, admins: [{ accountId: '167', displayName: 'admin', roleId, scope, enabled: true, createdAt: 0, createdBy: 'fixture' }] })
  if (permissions) await service.components.roles.save({ version: 1, roles: [{ id: roleId, name: roleId, kind: 'custom', surface: 'ai-admin', description: '', permissions, scopeDefault: scope }] })
  const admin = createServer((req, res) => { void service.handle(req, res) }); await listen(admin)
  let cookie = ''
  const api = async (path, body = {}) => {
    const response = await fetch('http://127.0.0.1:' + admin.address().port + API_PREFIX + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://admin.test', cookie }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') }
  }
  cookie = (await api('/session/login', { username: 'admin', password: 'fixture' })).cookie ?? ''
  return { api, base, store, reg, foreign, epoch, dir, home, service, probeRequests,
    loseNextApply: () => { unknownApply = true }, calls: () => gatewayCalls,
    cleanup: async () => { await close(admin); await close(gateway); await routes.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('fresh public probe is anonymous, no-store, exact nonce/time only and never authorizes a node', async () => {
  const h = await harness()
  try {
    const nonce = randomUUID(); const response = await fetch(h.base + '/v1/nodes/probe?nonce=' + nonce)
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
    const p = await response.json(); assert.deepEqual(Object.keys(p).sort(), ['schema', 'service', 'nonce', 'time'].sort())
    assert.equal(p.nonce, nonce); assert.equal(p.schema, 'qianshou.media-gateway-probe.v1'); assert(Math.abs(p.time - Date.now() / 1000) < 3)
    for (const suffix of ['', '?nonce=x', '?nonce=' + nonce + '&nonce=' + nonce, '?nonce=' + nonce + '&ownerId=167', '?nonce=' + nonce.toUpperCase()]) assert.equal((await fetch(h.base + '/v1/nodes/probe' + suffix)).status, 400)
    assert.equal((await fetch(h.base + '/v1/nodes/probe?nonce=' + nonce, { method: 'POST' })).status, 405)
    assert.equal(h.calls(), 0)
  } finally { await h.cleanup() }
})

test('authorization state and audit survive gateway restart; paused supply refuses new dispatch and resume requires a new epoch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-node-admin-restart-')); const path = join(dir, 'nodes.sqlite')
  let store = new MediaNodeStore({ path, heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 30000 })
  const reg = registration('durable-node')
  try {
    const epoch = store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch
    const ref = randomUUID(); const preview = store.adminPreview(reg.deviceId, 'pause', ref).preview
    store.adminApply(reg.deviceId, 'pause', ref, '167', '管理员暂停供给', preview.before)
    assert.equal(store.adminDetail(reg.deviceId).node.authorization, 'paused')
    const resumeRef = randomUUID(); const resume = store.adminPreview(reg.deviceId, 'resume', resumeRef).preview
    store.adminApply(reg.deviceId, 'resume', resumeRef, '167', '管理员恢复供给', resume.before)
    assert.equal(store.adminDetail(reg.deviceId).node.connectionEpoch, epoch + 1)
    assert.throws(() => store.channel(reg.deviceId, reg.deviceToken, epoch, 0), /CONNECTION_EPOCH_STALE/)
    const old = store.adminPreview(reg.deviceId, 'pause', randomUUID()).preview
    const revokeRef = randomUUID(); const revoke = store.adminPreview(reg.deviceId, 'revoke', revokeRef).preview
    store.adminApply(reg.deviceId, 'revoke', revokeRef, '167', '管理员吊销授权', revoke.before)
    assert.throws(() => store.adminApply(reg.deviceId, 'pause', randomUUID(), '167', '并发操作拒绝', old.before), /DEVICE_AUTHORIZATION_REVOKED/)
    store.close(); store = new MediaNodeStore({ path, heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 30000 })
    const detail = store.adminDetail(reg.deviceId); assert.equal(detail.node.authorization, 'revoked'); assert.equal(detail.audit.length, 3)
    assert.throws(() => store.reconnect(reg.deviceId, reg.deviceToken, reg.capabilityRevision), /DEVICE_AUTHORIZATION_REVOKED/)
    assert.equal(store.adminCheck(revokeRef, '167').recorded, true)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('console RBAC and real self scope filter SQLite nodes; projection never exposes credentials', async () => {
  assert.equal(permissionOf('apiConnections.manage').highRisk, true)
  const h = await harness({ scope: 'self', permissions: ['apiConnections.read'] })
  try {
    const result = await h.api('/api-connections/list'); assert.equal(result.status, 200)
    assert.deepEqual(result.body.nodes.map(n => n.deviceId), ['owned-node']); assert.equal(result.body.total, 1)
    assert.equal(result.body.nodes[0].settledTasks, 0); assert.deepEqual(result.body.nodes[0].modes, [])
    assert.equal((await h.api('/api-connections/detail', { deviceId: 'other-node' })).status, 404)
    assert.equal((await h.api('/api-connections/preflight', { deviceId: 'owned-node', action: 'pause', ref: randomUUID() })).status, 403)
    assert(!JSON.stringify(result.body).includes(h.reg.deviceToken)); assert(!JSON.stringify(result.body).includes(serviceKey))
  } finally { await h.cleanup() }
})

test('preflight/apply binds target/action/state, persists audit and recovers unknown commit by original ref', async () => {
  const h = await harness()
  try {
    const ref = randomUUID(); const draft = { deviceId: 'owned-node', action: 'pause', ref }
    const pre = await h.api('/api-connections/preflight', draft); assert.equal(pre.status, 200)
    assert.equal(h.store.adminDetail('owned-node').node.authorization, 'active')
    const token = pre.body.confirm.token
    assert.equal((await h.api('/api-connections/apply', { ...draft, deviceId: 'other-node', token, reason: '测试暂停原因' })).status, 409)
    h.loseNextApply()
    const applied = await h.api('/api-connections/apply', { ...draft, token, reason: '测试暂停原因' }); assert.equal(applied.status, 502); assert.equal(applied.body.code, 'api_connections_outcome_unknown')
    const checked = await h.api('/api-connections/check', { ref }); assert.equal(checked.status, 200); assert.equal(checked.body.recorded, true); assert.equal(checked.body.result.authorization, 'paused')
    const details = (await h.api('/api-connections/detail', { deviceId: 'owned-node' })).body
    assert.equal(details.audit.length, 1); assert.equal(details.audit[0].operatorAccountId, '167'); assert.equal(details.audit[0].ref, ref)
    assert.equal((await h.api('/api-connections/check', { ref: randomUUID() })).body.recorded, false)
    const audit = await readFile(join(h.dir, 'audit.jsonl'), 'utf8'); assert(audit.includes(ref)); assert(!audit.includes(serviceKey))
    await chmod(join(h.home, '.credentials.yaml'), 0o644); assert.equal((await h.api('/api-connections/list')).status, 503)
  } finally { await h.cleanup() }
})

test('revoke is durable, refuses old device credentials and keeps original unfinished task without false settlement', async () => {
  const h = await harness()
  try {
    const task = { deviceId: 'owned-node', taskId: 'task-existing', attemptId: 'attempt-existing', leaseEpoch: 1, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), quoteId: 'quote-existing', authorizationId: 'auth-existing',
      envelope: { spec: { task_type: 'image_generate', media_input: { capability: 'image', mode: 'text_to_image', prompt: 'fixture image', negative_prompt: '', quality: 'fast', orientation: 'square', seconds: null, assets: [], profile_id: cap.profile_id, profile_version: 1 } } } }
    h.store.dispatch(task); assert.equal(h.store.adminDetail('owned-node').node.totalTasks, 1)
    const draft = { deviceId: 'owned-node', action: 'revoke', ref: randomUUID() }; const pre = await h.api('/api-connections/preflight', draft)
    assert.equal((await h.api('/api-connections/apply', { ...draft, token: pre.body.confirm.token, reason: '用户要求吊销节点' })).status, 200)
    assert.throws(() => h.store.reconnect('owned-node', h.reg.deviceToken, h.reg.capabilityRevision), /DEVICE_AUTHORIZATION_REVOKED/)
    assert.throws(() => h.store.register('167', parseMediaNodeRegistration(h.reg)), /DEVICE_AUTHORIZATION_REVOKED/)
    const details = h.store.adminDetail('owned-node'); assert.equal(details.node.activeTasks, 1); assert.equal(details.node.settledTasks, 0); assert.equal(details.tasks[0].stage, 'leased')
    assert.equal((await h.api('/api-connections/preflight', { ...draft, action: 'resume', ref: randomUUID() })).status, 409)
    const before = { deviceId: 'owned-node', authorization: 'active', connectionEpoch: h.epoch }
    const original = h.store.adminApply('owned-node', 'revoke', draft.ref, '167', '用户要求吊销节点', before)
    assert.equal(original.ref, draft.ref)
    assert.throws(() => h.store.adminApply('owned-node', 'revoke', draft.ref, '167', '改变原因必须拒绝', before), /MEDIA_ADMIN_IDEMPOTENCY_CONFLICT/)
  } finally { await h.cleanup() }
})

test('list probes the public entrance freshly without credentials; absent runtime flags remain unknown and empty-capability presence stays visible', async () => {
  const h = await harness({ scope: 'self', emptyPresence: true })
  try {
    const first = (await h.api('/api-connections/list')).body
    const second = (await h.api('/api-connections/list')).body
    assert.equal(first.total, 1); assert.equal(first.nodes[0].online, true); assert.deepEqual(first.nodes[0].modes, [])
    assert.equal(first.integration.probe, 'reachable'); assert.equal(first.integration.publicBaseUrl, 'https://app.qianshousuanli.com')
    assert.match(first.integration.checkedAt, /^\d{4}-\d\d-\d\dT/u)
    for (const key of ['deviceChannel', 'metadata', 'exchange', 'dispatch', 'readiness']) assert.equal(first.integration[key], 'unknown')
    assert.equal(second.integration.probe, 'reachable'); assert.equal(h.probeRequests.length, 2)
    assert.notEqual(h.probeRequests[0].nonce, h.probeRequests[1].nonce)
    for (const p of h.probeRequests) { assert.equal(p.headers.authorization, undefined); assert.equal(p.headers.cookie, undefined); assert.equal(p.headers.origin, undefined); assert.equal(p.headers['x-qianshou-service-key-id'], undefined) }
    assert.equal(h.store.directory()[0].freeSlots, 0)
    assert(!JSON.stringify(first).includes(h.base)); assert(!JSON.stringify(first).includes(h.reg.deviceToken))
  } finally { await h.cleanup() }
})

test('only allowlisted runtime flags are diagnostic; private URLs/refs and a claimed ready state never cross the projection', async () => {
  const h = await harness({ integrationFlags: { deviceChannelConfigured: true, metadataConfigured: true, exchangeConfigured: false, dispatchConfigured: 'true', readiness: 'ready', privateOrigin: 'http://private.invalid', credentialRef: 'PRIVATE_SECRET_REF', token: serviceKey } })
  try {
    const { integration } = (await h.api('/api-connections/list')).body
    assert.equal(integration.deviceChannel, 'configured'); assert.equal(integration.metadata, 'configured'); assert.equal(integration.exchange, 'unavailable')
    assert.equal(integration.dispatch, 'unknown'); assert.equal(integration.readiness, 'unknown')
    assert.deepEqual(Object.keys(integration).sort(), ['schema', 'checkedAt', 'publicBaseUrl', 'probePath', 'probe', 'deviceChannel', 'metadata', 'exchange', 'dispatch', 'readiness', 'code'].sort())
    const text = JSON.stringify(integration); assert(!text.includes('private.invalid')); assert(!text.includes('PRIVATE_SECRET_REF')); assert(!text.includes(serviceKey))
  } finally { await h.cleanup() }
})

test('guide uses the existing read permission and current scope; unconfigured private management never invents nodes or blocks public protocol download', async () => {
  const h = await harness({ scope: 'self', permissions: ['apiConnections.read'], configured: false })
  try {
    const before = h.calls(); const result = await h.api('/api-connections/guide')
    assert.equal(result.status, 200); assert.equal(h.calls(), before)
    assert.equal(result.body.guide.scope, 'self'); assert.equal(result.body.guide.schema, 'qianshou.external-node-guide.v1')
    assert.equal(result.body.guide.version, '2026-09-29.2'); assert.equal(result.body.integration.probe, 'reachable')
    assert(result.body.guide.markdown.includes('Host 自动登记')); assert(result.body.guide.rules.some(r => r.includes('Unknown execution')))
    assert(!JSON.stringify(result.body).includes(serviceKey)); assert(!JSON.stringify(result.body).includes(h.reg.deviceToken)); assert(!JSON.stringify(result.body).includes(h.base))
    assert.equal((await h.api('/api-connections/guide', { ownerId: '168' })).status, 400)
    assert.equal((await h.api('/api-connections/list')).status, 503)
    assert.equal((await h.api('/api-connections/preflight', { deviceId: h.reg.deviceId, action: 'pause', ref: randomUUID() })).status, 403)
    assert.equal(h.store.adminDetail(h.reg.deviceId).audit.length, 0)
  } finally { await h.cleanup() }
  const denied = await harness({ permissions: ['account.read'] })
  try { assert.equal((await denied.api('/api-connections/guide')).status, 403); assert.equal(denied.probeRequests.length, 0) }
  finally { await denied.cleanup() }
})

test('documented registration/channel/heartbeat bodies exercise the actual HTTP store and do not qualify or dispatch a presence device', async () => {
  const h = await harness({ scope: 'self' })
  try {
    const guide = (await h.api('/api-connections/guide')).body.guide
    const reg = { ...registration(randomUUID()), capabilities: [] }
    const nodePost = async (path, token, body) => {
      const r = await fetch(h.base + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json() }
    }
    const documented = guide.routes.find(r => r.path === '/v1/nodes/register')
    assert.deepEqual(Object.keys(reg).sort(), [...documented.bodyFields].sort()); assert.equal(documented.authentication, 'account_bearer')
    const registered = await nodePost(documented.path, 'fixture-account-private', reg); assert.equal(registered.status, 200)
    const epoch = registered.body.connectionEpoch; const heart = { deviceId: reg.deviceId, connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 }
    assert.equal((await nodePost('/v1/nodes/heartbeat', reg.deviceToken, heart)).status, 409)
    const channel = { deviceId: reg.deviceId, connectionEpoch: epoch, afterSequence: 0, waitMs: 0 }
    assert.deepEqual(Object.keys(channel).sort(), [...guide.routes.find(r => r.path === '/v1/nodes/channel').bodyFields].sort())
    assert.deepEqual((await nodePost('/v1/nodes/channel', reg.deviceToken, channel)).body.tasks, [])
    assert.equal((await nodePost('/v1/nodes/heartbeat', reg.deviceToken, heart)).status, 200)
    const node = (await h.api('/api-connections/list')).body.nodes.find(n => n.deviceId === reg.deviceId)
    assert.equal(node.online, true); assert.equal(node.ownerId, '167'); assert.deepEqual(node.modes, []); assert.equal(node.totalTasks, 0)
    const directory = h.store.directory().find(n => n.deviceId === reg.deviceId); assert.equal(directory.freeSlots, 0); assert.equal(directory.media_exchange_ready, false)
    assert.equal((await nodePost('/v1/media/devices/qualification', 'fixture-account-private', { nonce: randomUUID(), deviceId: reg.deviceId, workerId: 'existing-worker' })).status, 503)
  } finally { await h.cleanup() }
})

for (const probeMode of ['401', '503', 'timeout', 'stale', 'nonce', 'extra']) test('public probe ' + probeMode + ' cannot report reachable, qualified or an authorized channel', async () => {
  const h = await harness({ probeMode })
  try {
    const r = await h.api('/api-connections/list'); assert.equal(r.status, 200)
    assert.equal(r.body.integration.probe, 'unavailable'); assert.equal(r.body.integration.code, 'gateway_probe_unavailable')
    assert.equal(r.body.integration.readiness, 'unknown'); assert.equal(r.body.integration.deviceChannel, 'unknown'); assert.equal(r.body.total, 2)
  } finally { await h.cleanup() }
})

test('bootstrap rejects private/path/credential URLs and invalid timeout; oversized public response is unavailable without exposing its contents', async () => {
  for (const publicBaseUrl of ['http://127.0.0.1', 'https://127.0.0.1', 'https://name:secret@app.qianshousuanli.com', 'https://app.qianshousuanli.com/private', 'https://app.qianshousuanli.com?token=secret']) assert.throws(() => createApiPlatformMetadata({ config: { publicBaseUrl } }), /PUBLIC_ORIGIN_INVALID/u)
  assert.throws(() => createApiPlatformMetadata({ config: { probeTimeoutMs: 0 } }), /PROBE_TIMEOUT_INVALID/u)
  const platform = createApiPlatformMetadata({ fetch: async () => new Response('secret'.repeat(1000), { headers: { 'cache-control': 'no-store' } }) })
  const r = await platform.observe(); assert.equal(r.probe, 'unavailable'); assert(!JSON.stringify(r).includes('secret'))
})

const localObservation = () => ({ mode: 'image', adapter: 'qianshou_image', status: 'ready',
  model: { id: 'qwen-image-2.1-int8-convrot', sha256: null, version: '2.1' },
  workflow: { id: 'qianshou-qwen-image21-text-to-image', sha256: null, version: null }, observedAt: new Date().toISOString() })
test('console projects actual metadata challenge confirmation while discarding private API transport fields and preserving zero-capacity presence', async () => {
  const h = await harness({ emptyPresence: true, scope: 'self', decorateLocal: true })
  try {
    const observation = localObservation()
    h.store.apiObservations(h.reg.deviceId, h.reg.deviceToken, { deviceId: h.reg.deviceId, connectionEpoch: h.epoch,
      observationRevision: 'metadata-fixture-v1', observations: [observation] })
    const channel = h.store.channel(h.reg.deviceId, h.reg.deviceToken, h.epoch, 0)
    assert.equal(channel.apiProbes.length, 1)
    const request = channel.apiProbes[0]
    assert(Date.parse(request.expiresAt) > Date.now() + 80000)
    h.store.apiProbeResult(h.reg.deviceId, h.reg.deviceToken, { deviceId: h.reg.deviceId, connectionEpoch: h.epoch,
      requestId: request.requestId, observation })
    const result = await h.api('/api-connections/list'); assert.equal(result.status, 200)
    const node = result.body.nodes[0]; assert.deepEqual(node.modes, []); assert.equal(node.activeTasks, 0)
    assert.equal(node.localServices[0].probe.state, 'confirmed'); assert.equal(node.localServices[0].model.sha256, null)
    assert.deepEqual(Object.keys(node.localServices[0]).sort(), ['mode', 'adapter', 'status', 'model', 'workflow', 'observedAt', 'registration', 'probe'].sort())
    assert(!JSON.stringify(node).match(/private-upstream|private-probe|privateOrigin|127\.0|\/private\//u))
    const detail = await h.api('/api-connections/detail', { deviceId: h.reg.deviceId }); assert.equal(detail.status, 200)
    assert.equal(detail.body.node.localServices[0].probe.state, 'confirmed')
    assert.equal(h.store.directory()[0].freeSlots, 0)
    h.store.reconnect(h.reg.deviceId, h.reg.deviceToken, h.reg.capabilityRevision)
    const fresh = await h.api('/api-connections/list'); assert.equal(fresh.status, 200)
    assert.equal(fresh.body.nodes[0].localServices, undefined)
  } finally { await h.cleanup() }
})
test('unsafe model identifiers fail closed and the versioned guide puts zero-fee metadata before paid qualification', async () => {
  const h = await harness({ emptyPresence: true, invalidLocal: true })
  try {
    h.store.apiObservations(h.reg.deviceId, h.reg.deviceToken, { deviceId: h.reg.deviceId, connectionEpoch: h.epoch,
      observationRevision: 'metadata-fixture-v1', observations: [localObservation()] })
    assert.equal((await h.api('/api-connections/list')).status, 502)
    const { guide } = (await h.api('/api-connections/guide')).body
    assert.equal(guide.version, '2026-09-29.2')
    assert.deepEqual(guide.routes.find(r => r.path === '/v1/nodes/api-observations').bodyFields,
      ['deviceId', 'connectionEpoch', 'observationRevision', 'observations'])
    assert(guide.rules.some(r => r.includes('Zero-fee API discovery')))
    assert(guide.markdown.includes('此步骤无需审核材料'))
  } finally { await h.cleanup() }
})


test('admin list and detail show only verified account name and bounded device hardware while old missing evidence stays null', async () => {
  const h = await harness({ emptyPresence: true })
  try {
    let listed = await h.api('/api-connections/list')
    const initial = listed.body.nodes.find(n => n.deviceId === h.reg.deviceId)
    assert.equal(initial.username, null); assert.equal(initial.deviceInfo, null)
    const hardware = { os: 'darwin', osVersion: '26.0', arch: 'arm64', deviceName: null, cpu: 'Apple M5', gpu: 'Apple M5', memoryMb: 32768, vramMb: null }
    h.store.accountIdentity('167', h.reg.deviceId, 'Verified account')
    h.store.deviceInfo(h.reg.deviceId, h.reg.deviceToken, { deviceId: h.reg.deviceId, connectionEpoch: h.epoch, deviceInfo: hardware })
    listed = await h.api('/api-connections/list'); assert.equal(listed.status, 200)
    const node = listed.body.nodes.find(n => n.deviceId === h.reg.deviceId)
    assert.equal(node.username, 'Verified account'); assert.deepEqual(node.deviceInfo, hardware)
    assert.equal(node.connectionEpoch, h.epoch); assert.deepEqual(node.modes, [])
    const detail = await h.api('/api-connections/detail', { deviceId: h.reg.deviceId }); assert.equal(detail.status, 200)
    assert.deepEqual(detail.body.node.deviceInfo, hardware); assert.equal(detail.body.node.username, 'Verified account')
    assert.equal(JSON.stringify(listed.body).includes(h.reg.deviceToken), false)
  } finally { await h.cleanup() }
})

test('admin rejects private fields or unsafe hardware labels rather than forwarding an upstream credential or endpoint', async () => {
  for (const patch of [{ token: 'private' }, { deviceName: '127.0.0.1' }, { gpu: 'http://private' }, { cpu: '/private/model' }, { memoryMb: '32768' }]) {
    const h = await harness({ hardwarePatch: patch })
    try {
      h.store.deviceInfo(h.reg.deviceId, h.reg.deviceToken, { deviceId: h.reg.deviceId, connectionEpoch: h.epoch, deviceInfo: { os: 'win32', osVersion: null, arch: 'x64', deviceName: 'Test PC', cpu: null, gpu: null, memoryMb: null, vramMb: null } })
      const response = await h.api('/api-connections/list'); assert.equal(response.status, 502)
      assert.equal(response.body.code, 'api_connections_unavailable'); assert.equal(JSON.stringify(response.body).includes('private'), false)
    } finally { await h.cleanup() }
  }
})
