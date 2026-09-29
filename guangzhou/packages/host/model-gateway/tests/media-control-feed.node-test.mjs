import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaNodeStore, parseMediaNodeRegistration } from '../src/media-node-store.ts'
import { createMediaNodeRoutes } from '../src/media-node-http.ts'
import { canonicalMediaJson, mediaResultRevision, verifyMediaResultVerdict } from '../src/media-result-contract.ts'

const key = () => { const k = generateKeyPairSync('ed25519'); return { ...k, pem: k.publicKey.export({ format: 'pem', type: 'spki' }) } }
const signed = (payload, keyId, k) => ({ key_id: keyId, payload, signature: sign(null, Buffer.from(canonicalMediaJson(payload)), k.privateKey).toString('base64url') })
const cap = { profile_id: 'h3-fast', profile_version: 1, model_sha256: 'a'.repeat(64), workflow_sha256: 'b'.repeat(64), validation_receipt_sha256: 'c'.repeat(64) }
const registration = () => ({ deviceId: 'node-a', deviceToken: randomBytes(32).toString('base64url'), adapterVersion: '1', capabilityRevision: 'rev-a', capabilities: [cap], maxConcurrency: 1 })
function order(k, now) {
  const task = { deviceId: 'node-a', taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 1,
    leaseExpiresAt: new Date((now + 60) * 1000).toISOString(), quoteId: 'd'.repeat(64), authorizationId: 'authorization-a',
    envelope: { schema: 'qianshou.formal-media-order.v1', accountId: 123, plan_sha256: 'e'.repeat(64),
      spec: { task_type: 'video_generate', media_input: { capability: 'video', mode: 'text_to_video', prompt: 'fixture',
        negative_prompt: '', quality: 'fast', orientation: 'landscape', seconds: 5, assets: [], profile_id: cap.profile_id, profile_version: 1 } } } }
  task.envelope.authorization = signed({ schema: 'qianshou.formal-media-authorization.v1', purpose: 'qianshou:formal-media-authorization',
    taskId: task.taskId, attemptId: task.attemptId, deviceId: task.deviceId, leaseEpoch: task.leaseEpoch, leaseExpiresAt: task.leaseExpiresAt,
    accountId: 123, ownerId: '7', plan_sha256: task.envelope.plan_sha256, quoteId: task.quoteId, authorizationId: task.authorizationId,
    price: { currency: 'CNY', total_yuan: '0.25', profile_id: cap.profile_id, profile_version: 1, price_version: 1, price_unit: 'second', units: 5 },
    issued_at: now, expires_at: now + 60 }, 'shanghai-authorization', k)
  return task
}
function verdict(k, task, now) {
  const identity = { schema: 'qianshou.formal-media-result.v1', purpose: 'qianshou:formal-media-result', taskId: task.taskId,
    attemptId: task.attemptId, deviceId: task.deviceId, ownerId: '123', leaseEpoch: 1, plan_sha256: task.envelope.plan_sha256,
    profile_id: cap.profile_id, profile_version: 1, status: 'verified', assetId: 'result-a', reason: null,
    file: { object_key: 'v8/account-123/workload-task-a/shard-attempt-a/result/result-a/result.mp4', object_version_id: 'version-a',
      sha256: 'f'.repeat(64), size_bytes: 1000, content_type: 'video/mp4', width: 1344, height: 768, fps_num: 24, fps_den: 1, seconds_ms: 5000 } }
  const revision = mediaResultRevision(identity)
  return signed({ ...identity, resultRevision: revision, billableResultRevision: revision, issued_at: now, expires_at: now + 60 }, 'guangzhou-result', k)
}
function online(store, reg) {
  const r = store.register('7', parseMediaNodeRegistration(reg))
  store.channel(reg.deviceId, reg.deviceToken, r.connectionEpoch, 0)
  store.heartbeat(reg.deviceId, reg.deviceToken, { connectionEpoch: r.connectionEpoch, capabilityRevision: reg.capabilityRevision,
    freeSlots: 1, runningAttemptIds: [], freeVramMb: 16000, availableSeconds: 300 })
  return r.connectionEpoch
}

test('formal authorization verifies buyer, contributor, frozen price and exact lease before dispatch', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-formal-control-')); const a = key(); const now = Math.floor(Date.now() / 1000)
  const store = new MediaNodeStore({ path: join(directory, 'nodes.sqlite'), heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300,
    clock: () => now * 1000, orderAuthorizationPublicKeys: { 'shanghai-authorization': a.pem } })
  try {
    online(store, registration()); const task = order(a, now)
    const unsigned = structuredClone(task); delete unsigned.envelope.authorization
    assert.throws(() => store.dispatch(unsigned), /MEDIA_RESULT_INVALID/)
    const wrong = structuredClone(task); wrong.envelope.accountId = 7
    assert.throws(() => store.dispatch(wrong), /SHANGHAI_AUTHORIZATION_BINDING_INVALID/)
    const changed = structuredClone(task); changed.envelope.authorization.payload.price.total_yuan = '0.00'
    assert.throws(() => store.dispatch(changed), /SHANGHAI_AUTHORIZATION_INVALID/)
    assert.equal(store.dispatch(task).duplicate, false)
    assert.equal(store.dispatch(task).duplicate, true)
    assert.equal(store.directory()[0].media_exchange_ready, false)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('global event pages, verified results and committed settlement persist and replay without execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-formal-feed-')); const a = key(); const v = key(); const now = Math.floor(Date.now() / 1000)
  const path = join(directory, 'nodes.sqlite'); const options = { path, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300,
    clock: () => now * 1000, orderAuthorizationPublicKeys: { 'shanghai-authorization': a.pem } }
  let store = new MediaNodeStore(options)
  try {
    const reg = registration(); const epoch = online(store, reg); const task = order(a, now); store.dispatch(task)
    const event = { connectionEpoch: epoch, taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1, sequence: 1, stage: 'awaiting_settlement', percent: 100 }
    store.event(reg.deviceId, reg.deviceToken, event); store.event(reg.deviceId, reg.deviceToken, event)
    assert.equal(store.taskStatus(task.taskId, task.attemptId).task.stage, 'awaiting_settlement')
    assert.throws(() => store.ackEvents('consumer', 1), /MEDIA_EVENT_ACK_INVALID/)
    assert.throws(() => store.readEvents('consumer', 1, 10), /MEDIA_EVENT_CURSOR_INVALID/)
    const read = store.readEvents('consumer', 0, 1); assert.equal(read.events.length, 1); assert.equal(read.events[0].source, 'node')
    assert.equal(read.events[0].nodeEventSequence, 1); assert.equal(store.ackEvents('consumer', read.sequence).duplicate, false)
    const receipt = verdict(v, task, now); const payload = verifyMediaResultVerdict(receipt, { 'guangzhou-result': v.pem }, now)
    assert.equal(store.recordResult(payload, receipt).duplicate, false); assert.equal(store.recordResult(payload, receipt).duplicate, true)
    const settled = { taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1, resultRevision: payload.resultRevision,
      billableResultRevision: payload.resultRevision, settled: true, ledgerReceiptId: 'ledger-a' }
    assert.equal(store.settlement(settled).duplicate, false)
    assert.equal(store.settlement(Object.fromEntries(Object.entries(settled).reverse())).duplicate, true)
    assert.equal(store.taskStatus(task.taskId, task.attemptId).task.stage, 'completed')
    store.close(); store = new MediaNodeStore(options)
    const replay = store.readEvents('consumer', 0, 128)
    assert.equal(replay.ackedSequence, 1); assert.deepEqual(replay.events.map(e => e.source), ['node', 'verdict', 'settlement'])
    assert.equal(store.taskStatus(task.taskId, task.attemptId).task.verdict.signature, receipt.signature)
    assert.throws(() => store.ackEvents('consumer', 999), /MEDIA_EVENT_ACK_INVALID/)
    store.ackEvents('consumer', replay.sequence)
    assert.equal(store.readEvents('consumer', replay.sequence, 128).events.length, 0)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('HTTP result ingress refuses node authority, forged signatures, stale result revisions and premature settlement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-formal-http-')); const a = key(); const v = key(); const now = Math.floor(Date.now() / 1000)
  const store = new MediaNodeStore({ path: join(directory, 'nodes.sqlite'), heartbeatIntervalMs: 100, heartbeatTimeoutMs: 30000,
    orderAuthorizationPublicKeys: { 'shanghai-authorization': a.pem } })
  const token = 'shanghai-service-0123456789012345678901234567'
  const routes = createMediaNodeRoutes({ store, verifyAccount: async () => null, dispatchToken: async () => token,
    maxLongPollRequests: 1, resultVerifierPublicKeys: { 'guangzhou-result': v.pem } })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body, bearer = token) => { const r = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  try {
    const reg = registration(); online(store, reg); const task = order(a, now)
    assert.equal((await post('/internal/media/dispatch', task)).status, 200)
    const receipt = verdict(v, task, now)
    assert.equal((await post('/internal/media/results/record', { verdict: receipt }, reg.deviceToken)).status, 401)
    const bad = structuredClone(receipt); bad.payload.file.sha256 = 'a'.repeat(64)
    assert.equal((await post('/internal/media/results/record', { verdict: bad })).status, 401)
    const premature = { taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1, resultRevision: receipt.payload.resultRevision,
      billableResultRevision: receipt.payload.resultRevision, settled: true, ledgerReceiptId: 'ledger-a' }
    assert.equal((await post('/internal/media/settlement', premature)).status, 409)
    assert.equal((await post('/internal/media/results/record', { verdict: receipt })).status, 200)
    assert.equal((await post('/internal/media/settlement', premature)).status, 200)
    const taskReply = await post('/internal/media/task', { taskId: task.taskId, attemptId: task.attemptId })
    assert.equal(taskReply.body.task.stage, 'completed'); assert.equal(taskReply.body.task.nodeOwnerId, '7')
    assert.equal(taskReply.body.task.envelope.accountId, 123)
    const read = await post('/internal/media/events/read', { consumerId: 'shanghai', afterSequence: 0, limit: 128 })
    assert.deepEqual(read.body.events.map(e => e.source), ['verdict', 'settlement'])
    assert.equal((await post('/internal/media/events/ack', { consumerId: 'shanghai', sequence: read.body.sequence })).status, 200)
  } finally { await routes.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }) }
})

test('public asset tickets bind Shanghai account and stream only to the fixed verifier without sharing its credential', async () => {
  const { createMediaExchangeHttp } = await import('../src/media-exchange-http.ts')
  const dir = mkdtempSync(join(tmpdir(), 'qs-media-public-assets-')); const service = 'private-verifier-' + 'v'.repeat(32)
  const calls = []; const bytes = Buffer.from('fixture-image-bytes'); const uploadToken = 't'.repeat(128)
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const data = Buffer.concat(chunks); calls.push({ path: req.url, auth: req.headers.authorization, data })
    if (req.url === '/v1/media/assets/read') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length), 'x-content-sha256': createHash('sha256').update(bytes).digest('hex') })
      res.end(bytes); return
    }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/media/assets/upload') res.end(JSON.stringify({ ok: true, status: 'registered', asset: { asset_id: 'asset-a', sha256: 'a'.repeat(64) } }))
    else res.end(JSON.stringify({ ok: true, ticket: { fixture: true }, upload_path: '/v1/media/assets/upload', assetId: 'asset-a' }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const exchange = createMediaExchangeHttp(`http://127.0.0.1:${upstream.address().port}`, async () => service)
  const store = new MediaNodeStore({ path: join(dir, 'nodes.db'), heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300 })
  const routes = createMediaNodeRoutes({ store, maxLongPollRequests: 4, dispatchToken: async () => 'd'.repeat(32), mediaExchange: exchange,
    verifyAccount: async req => req.headers.get('authorization') === 'Bearer ' + 'buyer-token-'.padEnd(32, 'b') ? { accountId: '123', isAdmin: false } : null })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  const body = { assetId: 'asset-a', role: 'first_frame', sha256: 'a'.repeat(64), size_bytes: bytes.length, content_type: 'image/png' }
  const headers = { authorization: 'Bearer ' + 'buyer-token-'.padEnd(32, 'b'), 'content-type': 'application/json' }
  try {
    const result = await fetch(base + '/v1/media/assets/ticket', { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(result.status, 200); assert.equal((await result.json()).upload_path, '/v1/media/assets/upload')
    assert.equal(JSON.parse(calls[0].data).accountId, 123); assert.equal(calls[0].auth, `Bearer ${service}`)
    assert.equal((await fetch(base + '/v1/media/assets/ticket', { method: 'POST', headers, body: JSON.stringify({ ...body, accountId: 7 }) })).status, 400)
    assert.equal((await fetch(base + '/v1/media/assets/ticket', { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + 'bad'.repeat(12) }, body: JSON.stringify(body) })).status, 401)
    const upload = await fetch(base + '/v1/media/assets/upload', { method: 'POST', headers: { authorization: `Bearer ${uploadToken}`, 'content-type': 'image/png', 'content-length': String(bytes.length) }, body: bytes })
    assert.equal(upload.status, 200); assert.equal((await upload.json()).status, 'registered')
    assert.equal(calls[1].auth, `Bearer ${uploadToken}`); assert.deepEqual(calls[1].data, bytes)
    const read = await fetch(base + '/v1/media/assets/read', { method: 'POST', headers: { authorization: `Bearer ${uploadToken}` } })
    assert.equal(read.status, 200); assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes)
    assert.equal(calls[2].auth, `Bearer ${uploadToken}`); assert.equal(calls[2].data.length, 0)
    assert.equal((await fetch(base + '/v1/media/assets/read', { method: 'POST', headers: { authorization: `Bearer ${uploadToken}` }, body: 'bad' })).status, 400)
    const installBody = { nonce: randomUUID(), deviceId: 'node-a', workerId: randomUUID(), mode: 'video', platform: 'win32', arch: 'x64', hardware: { gpu_name: 'Fixture RTX 4060', vram_mb: 8192, memory_mb: 16384 } }
    assert.equal((await fetch(base + '/v1/media/install-manifest', { method: 'POST', headers, body: JSON.stringify(installBody) })).status, 200)
    assert.equal(calls[3].path, '/internal/media/install-manifest'); assert.equal(JSON.parse(calls[3].data).accountId, 123)
    assert.equal((await fetch(base + '/v1/media/install-manifest', { method: 'POST', headers, body: JSON.stringify({ ...installBody, accountId: 7 }) })).status, 400)
    const qualify = { nonce: randomUUID(), deviceId: 'node-a', workerId: installBody.workerId }
    assert.equal((await fetch(base + '/v1/media/devices/qualification', { method: 'POST', headers, body: JSON.stringify(qualify) })).status, 200)
    assert.equal(calls[4].path, '/internal/media/devices/qualification'); assert.equal(JSON.parse(calls[4].data).accountId, 123)
    assert.throws(() => createMediaExchangeHttp('http://example.com', async () => service), /MEDIA_EXCHANGE_ORIGIN_INVALID/)
  } finally { await routes.close(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => upstream.close(resolve)); rmSync(dir, { recursive: true, force: true }) }
})

test('node result event keeps exact registered artifact after independent verdict and rejects a changed version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-formal-node-result-')); const a = key(); const v = key(); const now = Math.floor(Date.now() / 1000)
  const store = new MediaNodeStore({ path: join(directory, 'nodes.sqlite'), heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300,
    orderAuthorizationPublicKeys: { 'shanghai-authorization': a.pem } })
  const reg = registration(); const epoch = online(store, reg); const task = order(a, now); store.dispatch(task)
  const assetId = randomUUID(); const old = verdict(v, task, now).payload
  const identity = { ...old, assetId, file: { ...old.file, object_key: `v8/account-123/workload-${task.taskId}/shard-${task.attemptId}/result/${assetId}/result.mp4` } }
  for (const k of ['resultRevision', 'billableResultRevision', 'issued_at', 'expires_at']) delete identity[k]
  const revision = mediaResultRevision(identity); const receipt = signed({ ...identity, resultRevision: revision, billableResultRevision: revision, issued_at: now, expires_at: now + 60 }, 'guangzhou-result', v)
  const artifact = Object.fromEntries(['object_key', 'object_version_id', 'sha256', 'size_bytes', 'content_type'].map(k => [k, identity.file[k]]))
  const exchange = { upload: async () => {}, read: async () => {}, post: async path => {
    assert.equal(path, '/internal/media/results/status'); return { ok: true, status: 'verified', artifact, verdict: receipt }
  } }
  const routes = createMediaNodeRoutes({ store, maxLongPollRequests: 4, dispatchToken: async () => 's'.repeat(32), verifyAccount: async () => null,
    resultVerifierPublicKeys: { 'guangzhou-result': v.pem }, mediaExchange: exchange })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const body = { deviceId: reg.deviceId, connectionEpoch: epoch, taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1, sequence: 1, stage: 'awaiting_settlement', percent: 100, assetId, artifact }
  const send = async value => await fetch(`http://127.0.0.1:${server.address().port}/v1/nodes/events`, { method: 'POST', headers: { authorization: `Bearer ${reg.deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(value) })
  try {
    assert.equal((await send({ ...body, artifact: { ...artifact, object_version_id: 'different' } })).status, 409)
    assert.equal((await send(body)).status, 200); assert.equal((await send(body)).status, 200)
    const feed = store.readEvents('consumer', 0, 128)
    assert.deepEqual(feed.events.map(e => e.source), ['verdict', 'node']); assert.deepEqual(feed.events[1].payload.artifact, artifact)
    assert.equal(feed.events[1].payload.assetId, assetId); assert.equal(store.taskStatus(task.taskId, task.attemptId).task.stage, 'awaiting_settlement')
  } finally { await routes.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }) }
})

test('directory readiness requires fresh independent qualification for the exact enrolled owner and profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-media-qualification-')); const a = key(); const v = key(); const now = Math.floor(Date.now() / 1000)
  const store = new MediaNodeStore({ path: join(directory, 'nodes.sqlite'), heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300, orderAuthorizationPublicKeys: { auth: a.pem } })
  let owner = '7'; let expired = false
  const exchange = { upload: async () => {}, post: async (_path, body) => ({ qualification: signed({
    schema: 'qianshou.formal-media-directory-qualification.v1', purpose: 'qianshou:formal-media-directory-qualification', nonce: body.nonce,
    profiles: [{ ...cap, deviceId: 'node-a', ownerId: owner, executor_sha256: 'd'.repeat(64), worker_id: 'worker-a', authorized_until: now + 3600,
      verified_until: now + 3600, p90_execution_seconds: 10, max_task_seconds: 600, gpu_model: 'fixture RTX 4060', vram_mb: 8192,
      total_memory_mb: 16384, max_concurrent: 1, hardware_qualification: 'rtx_4060_or_better_verified' }], issued_at: now, expires_at: expired ? now - 1 : now + 30 }, 'verifier', v) }) }
  const routes = createMediaNodeRoutes({ store, maxLongPollRequests: 4, dispatchToken: async () => 's'.repeat(32), verifyAccount: async () => null,
    resultVerifierPublicKeys: { verifier: v.pem }, mediaExchange: exchange })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const read = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/internal/media/nodes`, { method: 'POST', headers: { authorization: 'Bearer ' + 's'.repeat(32), 'content-type': 'application/json' }, body: '{}' })).json()).nodes[0]
  try {
    online(store, registration()); assert.equal(store.directory()[0].media_exchange_ready, false)
    assert.equal((await read()).media_exchange_ready, true)
    owner = '8'; assert.equal((await read()).media_exchange_ready, false)
    owner = '7'; expired = true; assert.equal((await read()).media_exchange_ready, false)
  } finally { await routes.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }) }
})
