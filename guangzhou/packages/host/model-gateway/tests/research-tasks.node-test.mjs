import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { test } from 'node:test'
import { MediaNodeStore, parseMediaNodeRegistration } from '../src/media-node-store.ts'
import { createMediaNodeRoutes } from '../src/media-node-http.ts'

const start = Date.parse('2030-01-01T00:00:00Z')
const modelId = 'qwen-image-2.1-int8-convrot'; const workflowId = 'comfy-pilot-image-154f7d6133fe0276'
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'qs-research-task-')); let now = start
  const options = { path: join(dir, 'nodes.sqlite'), heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 180000, clock: () => now }
  let store = new MediaNodeStore(options)
  const reg = { deviceId: 'mac-fixture', deviceToken: randomBytes(32).toString('base64url'), capabilityRevision: 'empty-1', adapterVersion: '1.0.0', capabilities: [], maxConcurrency: 1 }
  let epoch = store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch
  const channel = () => store.channel(reg.deviceId, reg.deviceToken, epoch, 0)
  const heartbeat = () => store.heartbeat(reg.deviceId, reg.deviceToken, { connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 })
  const observation = () => ({ mode: 'image', adapter: 'comfyui', status: 'ready', model: { id: modelId, sha256: null, version: '2.1' }, workflow: { id: workflowId, sha256: '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be', version: '1' }, observedAt: new Date(now).toISOString() })
  const resources = (idle = true, resourceAllowed = true) => store.researchExecution(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision: `snapshot-${epoch}`, mode: 'image', idle, resourceAllowed })
  const confirm = () => { channel(); heartbeat(); store.apiObservations(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision: `snapshot-${epoch}`, observations: [observation()] }); const p = channel().apiProbes[0]; store.apiProbeResult(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, requestId: p.requestId, observation: observation() }); resources() }
  confirm()
  const dispatch = () => ({ schema: 'qianshou.research-media-lease.v1', requestId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(), accountId: 167, deviceId: reg.deviceId, connectionEpoch: epoch, leaseEpoch: 1, leaseExpiresAt: new Date(now + 300000).toISOString(), mode: 'image', adapter: 'comfyui', modelId, workflowId, input: { prompt: 'CPU fixture only; no model invocation' } })
  const tuple = p => ({ deviceId: reg.deviceId, connectionEpoch: epoch, taskId: p.taskId, attemptId: p.attemptId, leaseEpoch: 1 })
  return { get store() { return store }, get epoch() { return epoch }, reg, dir, dispatch, tuple, heartbeat, confirm, resources,
    advance(ms) { now += ms }, pause() { const ref = randomUUID(); const p = store.adminPreview(reg.deviceId, 'pause', ref); store.adminApply(reg.deviceId, 'pause', ref, '1', 'fixture pause', p.preview.before) },
    reopen() { store.close(); store = new MediaNodeStore(options); epoch = store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch; channel(); heartbeat() },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('same-owner confirmed API can lease with empty formal caps/free0; exact retries freeze original revision and never replace attempt', () => {
  const f = fixture()
  try {
    const p = f.dispatch(); const first = f.store.researchDispatch(p)
    assert.equal(first.duplicate, false); assert.equal(first.task.lease.observationRevision, 'snapshot-1'); assert.equal(first.task.lease.non_billable, true)
    assert.equal(f.store.researchDispatch(structuredClone(p)).duplicate, true)
    assert.throws(() => f.store.researchDispatch({ ...p, attemptId: randomUUID() }), /IDEMPOTENCY_CONFLICT/)
    assert.throws(() => f.store.researchDispatch({ ...p, input: { prompt: 'changed' } }), /IDEMPOTENCY_CONFLICT/)
    assert.throws(() => f.store.researchDispatch(f.dispatch()), /NODE_BUSY/)
    const plain = f.store.channel(f.reg.deviceId, f.reg.deviceToken, f.epoch, 0)
    assert.deepEqual(plain.tasks, []); assert.equal(plain.sequence, 0)
    assert.deepEqual(f.store.directory()[0].media_profiles, []); assert.equal(f.store.directory()[0].freeSlots, 0)
    assert.equal(f.store.adminList().nodes[0].settledTasks, 0)
    const research = f.store.researchChannel(f.reg.deviceId, f.reg.deviceToken, f.epoch, 0)
    assert.equal(research.tasks[0].lease.attemptId, p.attemptId); assert.equal(research.sequence, 1)
    assert.equal(f.store.researchChannel(f.reg.deviceId, f.reg.deviceToken, f.epoch, 1).tasks[0].lease.attemptId, p.attemptId)
  } finally { f.close() }
})

test('closed trial schema rejects billing, preset/graph/path/URL, wrong owner, workflow, unconfirmed and expired admission', () => {
  const f = fixture()
  try {
    for (const key of ['price', 'quoteId', 'authorization', 'non_billable', 'observationRevision']) assert.throws(() => f.store.researchDispatch({ ...f.dispatch(), [key]: 'spoof' }), /RESEARCH_MESSAGE_INVALID/)
    for (const extra of [{ preset: 'square_1024' }, { graph: {} }, { path: '/private' }, { url: 'https://invalid' }]) assert.throws(() => f.store.researchDispatch({ ...f.dispatch(), input: { prompt: 'safe', ...extra } }), /RESEARCH_MESSAGE_INVALID/)
    assert.throws(() => f.store.researchDispatch({ ...f.dispatch(), accountId: 168 }), /OWNER_MISMATCH/)
    assert.throws(() => f.store.researchDispatch({ ...f.dispatch(), workflowId: 'old-logical-workflow' }), /WORKFLOW_UNSUPPORTED/)
    assert.throws(() => f.store.researchDispatch({ ...f.dispatch(), connectionEpoch: f.epoch + 1 }), /EPOCH_STALE/)
    assert.throws(() => f.store.researchDispatch({ ...f.dispatch(), leaseExpiresAt: new Date(start).toISOString() }), /LEASE_EXPIRED/)
    f.advance(120000); f.heartbeat()
    assert.throws(() => f.store.researchDispatch(f.dispatch()), /API_NOT_CONFIRMED/)
  } finally { f.close() }
})

test('claim is durable before POST; pause blocks unclaimed work but preserves original unknown/running recovery', () => {
  const f = fixture()
  try {
    const p = f.dispatch(); f.store.researchDispatch(p)
    const t = f.tuple(p)
    f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...t, sequence: 1, stage: 'accepted', backendJobId: null })
    assert.equal(f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, t).task.submission, 'claimed')
    f.pause(); f.advance(300001)
    assert.equal(f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, t).duplicate, true)
    const e = { ...t, sequence: 2, stage: 'outcome_unknown', backendJobId: p.attemptId }
    assert.equal(f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, e).duplicate, false)
    assert.equal(f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, e).duplicate, true)
    assert.throws(() => f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...e, backendJobId: randomUUID() }), /EVENT_CONFLICT/)
    assert.throws(() => f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...t, sequence: 3, stage: 'completed', backendJobId: p.attemptId }), /STAGE_INVALID/)
    f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...t, sequence: 3, stage: 'running', backendJobId: p.attemptId })
    f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...t, sequence: 4, stage: 'uploading', backendJobId: p.attemptId })
    assert.equal(f.store.researchNodeStatus(f.reg.deviceId, f.reg.deviceToken, t).task.stage, 'uploading')
    assert.throws(() => f.store.researchDispatch({ ...p, attemptId: randomUUID() }), /IDEMPOTENCY_CONFLICT/)
  } finally { f.close() }
  const g = fixture()
  try { const p = g.dispatch(); g.store.researchDispatch(p); g.pause(); assert.throws(() => g.store.researchClaim(g.reg.deviceId, g.reg.deviceToken, g.tuple(p)), /SUBMISSION_DISABLED/) } finally { g.close() }
})

test('SQLite restart and a replacement epoch recover the exact claimed attempt without a fresh submission right', () => {
  const f = fixture()
  try {
    const p = f.dispatch(); f.store.researchDispatch(p); f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, f.tuple(p))
    f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(p), sequence: 1, stage: 'outcome_unknown', backendJobId: p.attemptId })
    f.reopen(); assert(f.epoch > p.connectionEpoch)
    const recovered = f.store.researchChannel(f.reg.deviceId, f.reg.deviceToken, f.epoch, 1).tasks[0]
    assert.equal(recovered.lease.attemptId, p.attemptId); assert.equal(recovered.lease.connectionEpoch, p.connectionEpoch); assert.equal(recovered.submission, 'claimed')
    assert.equal(f.store.researchDispatch(p).duplicate, true)
    assert.equal(f.store.researchNodeStatus(f.reg.deviceId, f.reg.deviceToken, f.tuple(p)).task.backendJobId, p.attemptId)
    assert.throws(() => f.store.researchNodeStatus(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(p), deviceId: 'other-device' }), /LEASE_MISMATCH/)
    assert.throws(() => f.store.researchNodeStatus(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(p), connectionEpoch: p.connectionEpoch }), /EPOCH_STALE/)
  } finally { f.close() }
  const g = fixture()
  try { const p = g.dispatch(); g.store.researchDispatch(p); g.reopen(); assert.throws(() => g.store.researchClaim(g.reg.deviceId, g.reg.deviceToken, g.tuple(p)), /SUBMISSION_DISABLED/) } finally { g.close() }
})

test('actual HTTP identities separate read, paid dispatch, owner and device credentials from research dispatch; longpoll and original status work', async () => {
  const f = fixture(); const key = () => randomBytes(32).toString('base64url'); const research = key(); const read = key(); const formal = key(); const account = key()
  const routes = createMediaNodeRoutes({ store: f.store, verifyAccount: async () => null, maxLongPollRequests: 2, dispatchToken: async () => formal, researchDirectoryToken: async () => read, researchDispatchToken: async () => research })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, token, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  try {
    const p = f.dispatch()
    for (const token of [undefined, read, formal, account, f.reg.deviceToken]) assert.equal((await post('/internal/media/research/dispatch', token, p)).status, 401)
    const poll = post('/v1/nodes/research/channel', f.reg.deviceToken, { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, afterSequence: 0, waitMs: 2000 })
    const first = await post('/internal/media/research/dispatch', research, p); assert.equal(first.status, 200)
    const leased = await poll; assert.equal(leased.status, 200); assert.equal(leased.body.tasks[0].lease.attemptId, p.attemptId)
    const task = await post('/internal/media/research/task', research, { taskId: p.taskId, attemptId: p.attemptId }); assert.equal(task.status, 200); assert.deepEqual(task.body.task, first.body.task)
    for (const token of [read, formal, account, f.reg.deviceToken]) assert.equal((await post('/internal/media/research/task', token, { taskId: p.taskId, attemptId: p.attemptId })).status, 401)
    assert.equal((await post('/v1/nodes/research/claim', research, f.tuple(p))).status, 401)
    assert.equal((await post('/v1/nodes/research/claim', f.reg.deviceToken, f.tuple(p))).status, 200)
    assert.equal((await post('/v1/nodes/research/task-status', f.reg.deviceToken, f.tuple(p))).body.task.submission, 'claimed')
    assert.equal((await post('/internal/media/dispatch', research, {})).status, 401)
    assert.equal((await post('/internal/media/research/nodes', research, { nonce: randomUUID() })).status, 401)
    assert.equal(JSON.stringify(first.body).includes(f.reg.deviceToken), false); assert.equal(JSON.stringify(first.body).includes(research), false)
  } finally { await routes.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(f.dir, { recursive: true, force: true }) }
})

function png(width = 2048, height = 1152) {
  function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) }; return (c ^ 0xffffffff) >>> 0 }
  function chunk(kind, body) { const b = Buffer.alloc(body.length + 12); b.writeUInt32BE(body.length); b.write(kind, 4); body.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, body.length + 8)), body.length + 8); return b }
  const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', deflateSync(Buffer.alloc(height * (width * 3 + 1)))), chunk('IEND', Buffer.alloc(0))])
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function uploadReady(f) { const p = f.dispatch(); f.store.researchDispatch(p); f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, f.tuple(p)); f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(p), sequence: 1, stage: 'uploading', backendJobId: p.attemptId }); return p }

test('independent PNG validation, immutable private bytes and buyer scope alone can complete a non-billable task', () => {
  const f = fixture()
  try {
    const p = uploadReady(f); const bytes = png()
    assert.throws(() => f.store.researchUpload(f.reg.deviceId, f.reg.deviceToken, f.tuple(p), 'a'.repeat(64), bytes), /HASH_MISMATCH/)
    const corrupt = Buffer.from(bytes); corrupt[40] ^= 1
    assert.throws(() => f.store.researchUpload(f.reg.deviceId, f.reg.deviceToken, f.tuple(p), digest(corrupt), corrupt), /PNG_INVALID/)
    const wrong = png(1024, 1024)
    assert.throws(() => f.store.researchUpload(f.reg.deviceId, f.reg.deviceToken, f.tuple(p), digest(wrong), wrong), /PNG_INVALID/)
    const result = f.store.researchUpload(f.reg.deviceId, f.reg.deviceToken, f.tuple(p), digest(bytes), bytes)
    assert.equal(result.task.stage, 'completed'); assert.equal(result.task.artifact.sha256, digest(bytes)); assert.equal(result.task.artifact.width, 2048); assert.equal(result.task.artifact.height, 1152)
    assert.deepEqual(Object.keys(result.task.artifact).sort(), ['assetId','sha256','size_bytes','content_type','width','height','resultRevision','download_path'].sort())
    assert.equal(f.store.researchUpload(f.reg.deviceId, f.reg.deviceToken, f.tuple(p), digest(bytes), bytes).duplicate, true)
    assert.equal(readdirSync(join(f.dir, 'research-results')).length, 1)
    assert(f.store.researchOwnerResult('167', p.taskId, p.attemptId).bytes.equals(bytes))
    assert.throws(() => f.store.researchOwnerResult('168', p.taskId, p.attemptId), /NOT_FOUND/)
    assert.equal(f.store.adminList().nodes[0].settledTasks, 0)
    assert.throws(() => f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(p), sequence: 2, stage: 'failed', backendJobId: p.attemptId }), /EVENT_STALE/)
  } finally { f.close() }
})

test('lost upload acknowledgement or crash after atomic file placement recovers via original status after restart without another PUT', () => {
  const f = fixture()
  try {
    const p = uploadReady(f); const bytes = png(); const dir = join(f.dir, 'research-results')
    mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, `${p.taskId}.${p.attemptId}.png`), bytes, { mode: 0o600 })
    f.reopen()
    const recovered = f.store.researchNodeStatus(f.reg.deviceId, f.reg.deviceToken, f.tuple(p))
    assert.equal(recovered.task.stage, 'completed'); assert.equal(recovered.task.artifact.sha256, digest(bytes)); assert.equal(readdirSync(dir).length, 1)
    assert.equal(f.store.researchTaskStatus(p.taskId, p.attemptId).task.artifact.resultRevision, recovered.task.artifact.resultRevision)
    assert(f.store.researchOwnerResult('167', p.taskId, p.attemptId).bytes.equals(bytes))
  } finally { f.close() }
})

test('actual HTTP original PNG delivery goes node→Guangzhou→authenticated owner; Shanghai service receives metadata only', async () => {
  const f = fixture(); const token = () => randomBytes(32).toString('base64url'); const research = token(); const read = token(); const formal = token(); const buyer = token(); const other = token()
  const routes = createMediaNodeRoutes({ store: f.store, verifyAccount: async request => request.headers.get('authorization') === `Bearer ${buyer}` ? { accountId: '167', role: 'user', isAdmin: false } : request.headers.get('authorization') === `Bearer ${other}` ? { accountId: '168', role: 'user', isAdmin: false } : null,
    maxLongPollRequests: 2, dispatchToken: async () => formal, researchDirectoryToken: async () => read, researchDispatchToken: async () => research })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === new URL(req.url, 'http://127.0.0.1').pathname); if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  try {
    const p = uploadReady(f); f.pause(); const bytes = png()
    const headers = { authorization: `Bearer ${f.reg.deviceToken}`, 'content-type': 'image/png', 'content-length': String(bytes.length), 'x-qianshou-device-id': f.reg.deviceId, 'x-qianshou-connection-epoch': String(f.epoch), 'x-qianshou-task-id': p.taskId, 'x-qianshou-attempt-id': p.attemptId, 'x-qianshou-lease-epoch': '1', 'x-qianshou-sha256': digest(bytes) }
    const denied = await fetch(base + '/v1/nodes/research/results/upload', { method: 'POST', headers: { ...headers, authorization: `Bearer ${research}` }, body: bytes }); assert.equal(denied.status, 401)
    const upload = await fetch(base + '/v1/nodes/research/results/upload', { method: 'POST', headers, body: bytes }); assert.equal(upload.status, 200); const body = await upload.json(); assert.equal(body.task.stage, 'completed')
    const path = body.task.artifact.download_path
    for (const t of [undefined, f.reg.deviceToken, read, research]) { const r = await fetch(base + path, { headers: t ? { authorization: `Bearer ${t}` } : {} }); assert.equal(r.status, 401) }
    const wrongOwner = await fetch(base + path, { headers: { authorization: `Bearer ${other}` } }); assert.equal(wrongOwner.status, 404)
    const result = await fetch(base + path, { headers: { authorization: `Bearer ${buyer}` } }); assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'image/png'); assert.equal(result.headers.get('x-qianshou-sha256'), digest(bytes)); assert.equal(result.headers.get('cache-control'), 'no-store'); assert(Buffer.from(await result.arrayBuffer()).equals(bytes))
    const metadata = await fetch(base + '/internal/media/research/task', { method: 'POST', headers: { authorization: `Bearer ${research}`, 'content-type': 'application/json' }, body: JSON.stringify({ taskId: p.taskId, attemptId: p.attemptId }) }); assert.equal(metadata.headers.get('content-type'), 'application/json; charset=utf-8'); assert.equal((await metadata.json()).task.artifact.sha256, digest(bytes))
  } finally { await routes.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(f.dir, { recursive: true, force: true }) }
})

test('resource reports are current-device exact messages and unknown values do not imply idle or permission', () => {
  const f = fixture()
  try {
    const body = { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, observationRevision: `snapshot-${f.epoch}`, mode: 'image', idle: true, resourceAllowed: true }
    const ack = f.store.researchExecution(f.reg.deviceId, f.reg.deviceToken, body)
    assert.deepEqual(Object.keys(ack).sort(), ['ok','deviceId','connectionEpoch','observationRevision','mode','observedAt'].sort())
    assert.equal(ack.observedAt, new Date(start).toISOString())
    for (const extra of [{ activeTasks: 0 }, { observedAt: new Date(start).toISOString() }, { slotCount: 10 }, { path: '/private' }]) assert.throws(() => f.store.researchExecution(f.reg.deviceId, f.reg.deviceToken, { ...body, ...extra }), /MESSAGE_INVALID/)
    for (const flags of [{ idle: 1 }, { resourceAllowed: 'true' }, { idle: {} }, { resourceAllowed: undefined }, { mode: 'video' }]) assert.throws(() => f.store.researchExecution(f.reg.deviceId, f.reg.deviceToken, { ...body, ...flags }), /EXECUTION_INVALID/)
    assert.throws(() => f.store.researchExecution(f.reg.deviceId, randomBytes(32).toString('base64url'), body), /CREDENTIAL_INVALID/)
    assert.throws(() => f.store.researchExecution(f.reg.deviceId, f.reg.deviceToken, { ...body, connectionEpoch: f.epoch + 1 }), /EPOCH_STALE/)
    assert.throws(() => f.store.researchExecution(f.reg.deviceId, f.reg.deviceToken, { ...body, observationRevision: 'other' }), /EXECUTION_SCOPE_INVALID/)
    f.resources(null, null)
    const node = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(node.execution.idle, null); assert.equal(node.execution.resourceAllowed, null)
    assert.equal(node.localServices[0].availableForTrial, false)
    assert.throws(() => f.store.researchDispatch(f.dispatch()), /EXECUTION_NOT_READY/)
  } finally { f.close() }
})

test('API identity can remain ready while resource TTL expires; only a fresh server-stamped report can admit a new lease', () => {
  const f = fixture()
  try {
    const first = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(first.localServices[0].availableForTrial, true)
    assert.deepEqual(Object.keys(first.execution).sort(), ['schema','observedAt','connectionEpoch','observationRevision','idle','resourceAllowed','activeTasks','slotCount'].sort())
    f.advance(15000); f.heartbeat()
    const stale = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(stale.localServices[0].status, 'ready'); assert.equal(stale.localServices[0].probe.state, 'confirmed')
    assert.equal(stale.execution.idle, null); assert.equal(stale.execution.resourceAllowed, null)
    assert.throws(() => f.store.researchDispatch(f.dispatch()), /EXECUTION_NOT_READY/)
    f.resources(true, false); assert.throws(() => f.store.researchDispatch(f.dispatch()), /EXECUTION_NOT_READY/)
    f.resources(false, true); assert.throws(() => f.store.researchDispatch(f.dispatch()), /EXECUTION_NOT_READY/)
    f.resources(); const p = f.dispatch(); assert.equal(f.store.researchDispatch(p).duplicate, false)
    const held = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(held.execution.activeTasks, 1); assert.equal(held.localServices[0].availableForTrial, false)
    assert.equal(f.store.adminList().nodes[0].activeTasks, 1); assert.equal(f.store.adminList().nodes[0].totalTasks, 1)
    assert.equal(f.store.adminDetail(f.reg.deviceId).tasks[0].attemptId, p.attemptId)
    assert.throws(() => f.store.researchDispatch(f.dispatch()), /NODE_BUSY/)
  } finally { f.close() }
})

test('new API revision or connection epoch cannot inherit a previous resource permission', () => {
  const f = fixture()
  try {
    f.store.apiObservations(f.reg.deviceId, f.reg.deviceToken, { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, observationRevision: 'withdraw-2', observations: [] })
    const changed = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(changed.execution, undefined); assert.deepEqual(changed.localServices, [])
    f.reopen(); const replaced = f.store.researchDirectory(randomUUID()).nodes[0]
    assert.equal(replaced.execution, undefined)
    assert.throws(() => f.store.researchExecution(f.reg.deviceId, f.reg.deviceToken, { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, observationRevision: 'withdraw-2', mode: 'image', idle: true, resourceAllowed: true }), /SCOPE_INVALID/)
  } finally { f.close() }
})

test('resource withdrawal denies a new claim but an original claimed unknown attempt retains its slot and PNG delivery', () => {
  const f = fixture()
  try {
    const p = f.dispatch(); f.store.researchDispatch(p); f.resources(false, false)
    assert.throws(() => f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, f.tuple(p)), /EXECUTION_NOT_READY/)
    f.resources(false, true)
    assert.equal(f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, f.tuple(p)).duplicate, false)
    f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(p), sequence: 1, stage: 'outcome_unknown', backendJobId: p.attemptId })
    f.resources(false, false); f.pause(); f.advance(300001)
    assert.equal(f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, f.tuple(p)).duplicate, true)
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].execution.activeTasks, 1)
    f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(p), sequence: 2, stage: 'uploading', backendJobId: p.attemptId })
    const bytes = png(); assert.equal(f.store.researchUpload(f.reg.deviceId, f.reg.deviceToken, f.tuple(p), digest(bytes), bytes).task.stage, 'completed')
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].execution.activeTasks, 0)
    assert(f.store.researchOwnerResult('167', p.taskId, p.attemptId).bytes.equals(bytes))
  } finally { f.close() }
})

test('real HTTP concurrent dispatches reserve one device; read or owner credentials cannot report device resources', async () => {
  const f = fixture(); const key = () => randomBytes(32).toString('base64url'); const research = key(); const read = key(); const account = key()
  const routes = createMediaNodeRoutes({ store: f.store, verifyAccount: async token => token === account ? { accountId: '167' } : null, maxLongPollRequests: 2, dispatchToken: async () => undefined, researchDirectoryToken: async () => read, researchDispatchToken: async () => research })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, token, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  try {
    const report = { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, observationRevision: `snapshot-${f.epoch}`, mode: 'image', idle: true, resourceAllowed: true }
    for (const token of [undefined, read, research, account]) assert.equal((await post('/v1/nodes/research/execution', token, report)).status, 401)
    const ack = await post('/v1/nodes/research/execution', f.reg.deviceToken, report); assert.equal(ack.status, 200); assert.equal(ack.body.observationRevision, report.observationRevision)
    const requests = [f.dispatch(), f.dispatch()]
    const results = await Promise.all(requests.map(p => post('/internal/media/research/dispatch', research, p)))
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
    const winner = results.find(r => r.status === 200); const loser = results.find(r => r.status === 409)
    assert.equal(loser.body.code, 'RESEARCH_NODE_BUSY')
    assert.equal((await post('/internal/media/research/dispatch', research, requests[results.indexOf(winner)])).body.duplicate, true)
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].execution.activeTasks, 1)
    assert.equal(f.store.directory()[0].freeSlots, 0); assert.deepEqual(f.store.directory()[0].media_profiles, [])
  } finally { await routes.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(f.dir, { recursive: true, force: true }) }
})

test('two same-account devices each reserve one task while an unknown original attempt is never released by TTL', () => {
  const f = fixture()
  try {
    const reg = { ...f.reg, deviceId: 'second-pc', deviceToken: randomBytes(32).toString('base64url') }
    const epoch = f.store.register('167', parseMediaNodeRegistration(reg)).connectionEpoch
    const observation = { mode: 'image', adapter: 'comfyui', status: 'ready', model: { id: modelId, sha256: null, version: '2.1' }, workflow: { id: workflowId, sha256: '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be', version: '1' }, observedAt: new Date(start).toISOString() }
    f.store.channel(reg.deviceId, reg.deviceToken, epoch, 0)
    f.store.heartbeat(reg.deviceId, reg.deviceToken, { connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: 0, runningAttemptIds: [], freeVramMb: 0, availableSeconds: 0 })
    f.store.apiObservations(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision: 'second-1', observations: [observation] })
    const probe = f.store.channel(reg.deviceId, reg.deviceToken, epoch, 0).apiProbes[0]
    f.store.apiProbeResult(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, requestId: probe.requestId, observation })
    f.store.researchExecution(reg.deviceId, reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, observationRevision: 'second-1', mode: 'image', idle: true, resourceAllowed: true })
    const a = f.dispatch(); const b = { ...f.dispatch(), deviceId: reg.deviceId, connectionEpoch: epoch }
    assert.equal(f.store.researchDispatch(a).duplicate, false); assert.equal(f.store.researchDispatch(b).duplicate, false)
    const directory = f.store.researchDirectory(randomUUID())
    assert.equal(directory.nodes.length, 2); assert(directory.nodes.every(node => node.execution.activeTasks === 1 && !node.localServices[0].availableForTrial))
    f.store.researchClaim(f.reg.deviceId, f.reg.deviceToken, f.tuple(a))
    f.store.researchEvent(f.reg.deviceId, f.reg.deviceToken, { ...f.tuple(a), sequence: 1, stage: 'outcome_unknown', backendJobId: a.attemptId })
    f.advance(300001); f.heartbeat(); f.resources()
    const p = f.store.channel(f.reg.deviceId, f.reg.deviceToken, f.epoch, 0).apiProbes[0]
    f.store.apiProbeResult(f.reg.deviceId, f.reg.deviceToken, { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, requestId: p.requestId, observation: { ...observation, observedAt: new Date(start + 300001).toISOString() } })
    assert.equal(f.store.researchNodeStatus(f.reg.deviceId, f.reg.deviceToken, f.tuple(a)).task.stage, 'outcome_unknown')
    assert.throws(() => f.store.researchDispatch(f.dispatch()), /NODE_BUSY/)
    assert.equal(f.store.researchDispatch(a).duplicate, true)
  } finally { f.close() }
})

test('trusted account names and epoch-bound hardware labels never accept node-supplied account identity or private endpoint data', () => {
  const f = fixture()
  try {
    const info = { os: 'darwin', osVersion: '26.0', arch: 'arm64', deviceName: null, cpu: 'Apple M5', gpu: 'Apple M5', memoryMb: 32768, vramMb: null }
    assert.equal(f.store.adminList().nodes[0].username, null); assert.equal(f.store.adminList().nodes[0].deviceInfo, null)
    f.store.register('167', parseMediaNodeRegistration(f.reg), 'CPU 账号')
    const body = { deviceId: f.reg.deviceId, connectionEpoch: f.epoch, deviceInfo: info }
    assert.deepEqual(f.store.deviceInfo(f.reg.deviceId, f.reg.deviceToken, body), { ok: true, deviceId: f.reg.deviceId, connectionEpoch: f.epoch })
    assert.deepEqual(f.store.adminList().nodes[0].deviceInfo, info); assert.equal(f.store.adminList().nodes[0].username, 'CPU 账号')
    for (const patch of [{ deviceName: '127.0.0.1' }, { cpu: '/private/model' }, { gpu: 'http://local' }, { deviceName: 'bad\nname' }, { memoryMb: '32768' }, { vramMb: -1 }, { os: ['darwin'] }, { arch: ['arm64'] }, { username: 'spoof' }, { token: 'secret' }]) assert.throws(() => f.store.deviceInfo(f.reg.deviceId, f.reg.deviceToken, { ...body, deviceInfo: { ...info, ...patch } }))
    assert.throws(() => f.store.deviceInfo(f.reg.deviceId, f.reg.deviceToken, { ...body, username: 'spoof' }), /MESSAGE_INVALID/)
    assert.throws(() => f.store.accountIdentity('168', f.reg.deviceId, 'other owner'), /OWNER_MISMATCH/)
    assert.equal(f.store.accountIdentity('167', f.reg.deviceId, 'Verified renamed owner').ok, true)
    assert.equal(f.store.adminList().nodes[0].connectionEpoch, f.epoch)
    f.reopen(); assert.equal(f.store.adminList().nodes[0].username, 'Verified renamed owner'); assert.equal(f.store.adminList().nodes[0].deviceInfo, null)
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].username, undefined)
    assert.equal(f.store.researchDirectory(randomUUID()).nodes[0].deviceInfo, undefined)
  } finally { f.close() }
})

test('real HTTP account-name refresh verifies account bearer and original owner without changing device epoch', async () => {
  const f = fixture(); const ownerKey = randomBytes(32).toString('base64url'); const otherKey = randomBytes(32).toString('base64url')
  const routes = createMediaNodeRoutes({ store: f.store, verifyAccount: async request => {
    const token = request.headers.get('authorization')
    return token === `Bearer ${ownerKey}` ? { accountId: '167', username: 'Verified fixture owner' } : token === `Bearer ${otherKey}` ? { accountId: '168', username: 'Other owner' } : null
  }, maxLongPollRequests: 2, dispatchToken: async () => undefined })
  const server = createServer((req, res) => { const route = routes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`
  const post = async (token, body) => { const r = await fetch(base + '/v1/nodes/account-identity', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  try {
    for (const token of [undefined, f.reg.deviceToken]) assert.equal((await post(token, { deviceId: f.reg.deviceId })).status, 401)
    assert.equal((await post(otherKey, { deviceId: f.reg.deviceId })).status, 403)
    assert.equal((await post(ownerKey, { deviceId: f.reg.deviceId, username: 'forged' })).status, 400)
    const result = await post(ownerKey, { deviceId: f.reg.deviceId }); assert.equal(result.status, 200)
    assert.deepEqual(result.body, { ok: true, deviceId: f.reg.deviceId })
    assert.equal(f.store.adminList().nodes[0].username, 'Verified fixture owner'); assert.equal(f.store.adminList().nodes[0].connectionEpoch, f.epoch)
  } finally { await routes.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(f.dir, { recursive: true, force: true }) }
})
