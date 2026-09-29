import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { MediaNodeStore, parseMediaNodeRegistration } from '../src/media-node-store.ts'
import { createMediaNodeRoutes } from '../src/media-node-http.ts'
import { createPluginLicenseBearerVerifier } from '../src/plugin-license-bearer.ts'

const accountToken = 'fixture-account-token-0123456789'
const serviceToken = 'fixture-shanghai-service-token-01234567890123456789'
const capability = { profile_id: 'h3-fast', profile_version: 1, model_sha256: 'a'.repeat(64), workflow_sha256: 'b'.repeat(64), validation_receipt_sha256: 'c'.repeat(64) }
const registration = () => ({ deviceId: 'device-a', deviceToken: randomBytes(32).toString('base64url'), adapterVersion: '1.0.0', capabilityRevision: 'revision-1', capabilities: [capability], maxConcurrency: 1 })
const dispatch = () => ({ deviceId: 'device-a', taskId: 'task-a', attemptId: 'attempt-a', leaseEpoch: 1, leaseExpiresAt: '2030-01-01T00:00:30.000Z', quoteId: 'quote-a', authorizationId: 'authorization-a', envelope: { spec: { task_type: 'video_generate', media_input: { capability: 'video', mode: 'image_to_video', prompt: 'test video', negative_prompt: '', orientation: 'landscape', seconds: 5, quality: 'fast', profile_id: 'h3-fast', profile_version: 1, assets: [{ asset_id: 'first-a', sha256: 'd'.repeat(64), role: 'first_frame' }] } } } })
const now = Date.parse('2030-01-01T00:00:00.000Z')
const open = (path, clock = () => now) => new MediaNodeStore({ path, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300, clock })
const recover = (store, reg, epoch) => store.channel(reg.deviceId, reg.deviceToken, epoch, 0)
const heartbeat = (store, reg, epoch, freeSlots = 1) => store.heartbeat(reg.deviceId, reg.deviceToken, { connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots, runningAttemptIds: [], freeVramMb: 15000, availableSeconds: 300 })

test('registration retry, recovery, stale epoch, and real liveness are independent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-media-node-'))
  let clock = now
  const store = open(join(directory, 'nodes.sqlite'), () => clock)
  try {
    const reg = registration(); const first = store.register('167', parseMediaNodeRegistration(reg))
    assert.throws(() => parseMediaNodeRegistration({ ...reg, capabilities: [{ ...capability, profile_version: '1' }] }), /MEDIA_NODE_NUMBER_INVALID/)
    assert.throws(() => parseMediaNodeRegistration({ ...reg, capabilities: [{ ...capability, profile_version: 0 }] }), /MEDIA_NODE_NUMBER_INVALID/)
    assert.deepEqual(store.register('167', parseMediaNodeRegistration(reg)), first)
    assert.throws(() => store.register('168', parseMediaNodeRegistration(reg)), /DEVICE_CREDENTIAL_CONFLICT/)
    assert.throws(() => store.register('167', parseMediaNodeRegistration({ ...reg, maxConcurrency: 2 })), /CAPABILITY_REVISION_CONFLICT/)
    assert.throws(() => heartbeat(store, reg, first.connectionEpoch), /NODE_RECOVERY_REQUIRED/)
    assert.equal(store.directory()[0].online, false)
    recover(store, reg, first.connectionEpoch); heartbeat(store, reg, first.connectionEpoch)
    assert.equal(store.directory()[0].online, true)
    assert.equal(store.directory()[0].media_exchange_ready, false)
    clock += 300
    assert.equal(store.directory()[0].online, false)
    assert.equal(store.directory()[0].freeSlots, 0)
    const second = store.reconnect(reg.deviceId, reg.deviceToken, reg.capabilityRevision)
    assert.equal(second.connectionEpoch, first.connectionEpoch + 1)
    assert.throws(() => heartbeat(store, reg, first.connectionEpoch), /CONNECTION_EPOCH_STALE/)
    assert.throws(() => store.channel(reg.deviceId, 'wrong-device-credential-'.repeat(2), second.connectionEpoch, 0), /DEVICE_CREDENTIAL_INVALID/)
    recover(store, reg, second.connectionEpoch); heartbeat(store, reg, second.connectionEpoch)
    assert.equal(store.disconnect(reg.deviceId, reg.deviceToken, second.connectionEpoch).online, false)
    assert.equal(store.directory()[0].online, false)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('durable inbox prevents double reservation, unknown-outcome retry, stale events and restart loss', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-media-node-'))
  const path = join(directory, 'nodes.sqlite')
  let store = open(path)
  try {
    const reg = registration(); const { connectionEpoch: epoch } = store.register('167', parseMediaNodeRegistration(reg))
    recover(store, reg, epoch); heartbeat(store, reg, epoch)
    const task = dispatch(); const first = store.dispatch(task)
    assert.equal(store.directory()[0].freeSlots, 0)
    assert.equal(store.dispatch(task).sequence, first.sequence)
    assert.equal(store.dispatch(task).duplicate, true)
    assert.throws(() => store.dispatch({ ...task, quoteId: 'changed-quote' }), /MEDIA_TASK_IDEMPOTENCY_CONFLICT/)
    assert.throws(() => store.dispatch({ ...task, taskId: 'task-b', attemptId: 'attempt-b' }), /MEDIA_NODE_BUSY/)
    assert.throws(() => store.dispatch({ ...task, attemptId: 'attempt-b' }), /MEDIA_TASK_RECONCILIATION_REQUIRED/)
    const event = { deviceId: reg.deviceId, connectionEpoch: epoch, taskId: task.taskId, attemptId: task.attemptId, leaseEpoch: 1, sequence: 1, stage: 'running', percent: 15 }
    store.event(reg.deviceId, reg.deviceToken, event)
    assert.equal(store.event(reg.deviceId, reg.deviceToken, event).duplicate, true)
    assert.throws(() => store.event(reg.deviceId, reg.deviceToken, { ...event, percent: 16 }), /MEDIA_EVENT_IDEMPOTENCY_CONFLICT/)
    assert.throws(() => store.event(reg.deviceId, reg.deviceToken, { ...event, sequence: 2, stage: 'accepted' }), /MEDIA_EVENT_STALE/)
    assert.throws(() => store.event(reg.deviceId, reg.deviceToken, { ...event, sequence: 2, stage: 'completed' }), /MEDIA_EVENT_STAGE_INVALID/)
    store.close(); store = open(path)
    assert.equal(store.directory()[0].online, false)
    assert.throws(() => heartbeat(store, reg, epoch), /CONNECTION_EPOCH_STALE/)
    const next = store.reconnect(reg.deviceId, reg.deviceToken, reg.capabilityRevision)
    // The Host already committed its cursor; unfinished tasks are still present in the new epoch's recovery snapshot.
    const replay = store.channel(reg.deviceId, reg.deviceToken, next.connectionEpoch, first.sequence)
    assert.equal(replay.tasks[0].taskId, task.taskId)
    assert.equal(replay.tasks[0].stage, 'running')
    assert.equal(replay.sequence, first.sequence)
    assert.equal(store.event(reg.deviceId, reg.deviceToken, { ...event, connectionEpoch: next.connectionEpoch, sequence: 2, stage: 'awaiting_settlement' }).settlement, 'not-performed')
    assert.throws(() => store.event(reg.deviceId, reg.deviceToken, { ...event, connectionEpoch: next.connectionEpoch, sequence: 3 }), /MEDIA_EVENT_STALE/)
    assert.throws(() => store.dispatch({ ...task, taskId: 'other-task', attemptId: 'other-attempt', envelope: { first_frame: { url: 'https://attacker.invalid/private' } } }), /MEDIA_CONTROL_BYTES_FORBIDDEN/)
    heartbeat(store, reg, next.connectionEpoch)
    const mismatch = dispatch(); mismatch.taskId = 'other-task'; mismatch.attemptId = 'other-attempt'; mismatch.envelope.spec.media_input.profile_id = 'unknown'
    assert.throws(() => store.dispatch(mismatch), /MEDIA_NODE_PROFILE_UNAVAILABLE/)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}` }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }

test('Shanghai media input uses integer profile versions and refuses billing claims or hidden generation inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-media-input-'))
  const store = open(join(directory, 'nodes.sqlite'))
  try {
    const reg = registration(); const { connectionEpoch: epoch } = store.register('167', parseMediaNodeRegistration(reg))
    recover(store, reg, epoch); heartbeat(store, reg, epoch)
    const cases = [
      input => { input.profile_version = '1' },
      input => { input.profile_version = 0 },
      input => { input.profile_version = 1.5 },
      input => { input.profile_version = true },
      input => { input.mode = 'text_to_image' },
      input => { input.seconds = '5' },
      input => { input.seconds = 121 },
      input => { input.prompt = ' ' },
      input => { input.prompt = '界'.repeat(3000) },
      input => { input.negative_prompt = null },
      input => { input.assets = null },
      input => { input.assets = [] },
      input => { input.assets[0].role = 'reference' },
      input => { input.assets[0].sha256 = 'f'.repeat(63) },
      input => { input.assets[0].other = 'unexpected' },
      input => { input.assets.push({ ...input.assets[0] }) },
      input => { input.steps = 4 },
      input => { input.non_billable = true },
      input => { input.billing = 'research-no-charge' },
      input => { input.unit_price_yuan = 0 },
    ]
    for (const change of cases) {
      const task = dispatch(); change(task.envelope.spec.media_input)
      assert.throws(() => store.dispatch(task), /MEDIA_(INPUT_INVALID|NODE_NUMBER_INVALID|BILLING_FIELDS_FORBIDDEN)/)
      assert.equal(store.directory()[0].freeSlots, 1)
    }
    for (const [key, value] of [['params', { seconds: 10 }], ['inline_input', 'hidden media'], ['code_url', 'not-a-media-url'], ['redundancy_factor', 2]]) {
      const task = dispatch(); task.envelope.spec[key] = value
      assert.throws(() => store.dispatch(task), /MEDIA_LEGACY_INPUT_FORBIDDEN/)
    }
    assert.equal(store.dispatch(dispatch()).duplicate, false)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('real HTTP account registration, device channel and Shanghai metadata ingress refuse wrong authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-media-http-'))
  const account = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url !== '/api/v8/auth/me' || request.headers.authorization !== `Bearer ${accountToken}`) { response.writeHead(401); response.end('{}'); return }
    response.end(JSON.stringify({ ok: true, account: { id: 167, role: 'personal' } }))
  })
  const accountOrigin = await listen(account)
  const store = open(join(directory, 'nodes.sqlite'))
  const channel = createMediaNodeRoutes({ store, verifyAccount: createPluginLicenseBearerVerifier({ accountApiOrigin: accountOrigin }), dispatchToken: async () => serviceToken, maxLongPollRequests: 2 })
  const server = createServer((request, response) => {
    const route = channel.routes.find(route => route.path === request.url)
    if (!route) { response.writeHead(404); response.end(); return }
    void route.handler(request, response)
  })
  const origin = await listen(server)
  const post = async (path, token, body, headers = {}) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const reg = registration()
    assert.equal((await post('/v1/nodes/register', reg.deviceToken, reg)).status, 401)
    assert.equal((await post('/v1/nodes/register', accountToken, reg, { cookie: 'owner-session=other' })).status, 403)
    const first = await post('/v1/nodes/register', accountToken, reg)
    assert.equal(first.status, 200)
    assert.equal(first.body.deviceToken, reg.deviceToken)
    const epoch = first.body.connectionEpoch
    assert.equal((await post('/v1/nodes/channel', reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, afterSequence: 0, waitMs: 0 })).body.sequence, 0)
    const hb = { deviceId: reg.deviceId, connectionEpoch: epoch, capabilityRevision: reg.capabilityRevision, freeSlots: 1, runningAttemptIds: [], freeVramMb: 15000, availableSeconds: 300 }
    assert.equal((await post('/v1/nodes/heartbeat', reg.deviceToken, hb)).body.connectionEpoch, epoch)
    assert.equal((await post('/internal/media/dispatch', reg.deviceToken, dispatch())).status, 401)
    assert.equal((await post('/internal/media/dispatch', serviceToken, { ...dispatch(), billing: 'research-no-charge' })).status, 400)
    const pending = post('/v1/nodes/channel', reg.deviceToken, { deviceId: reg.deviceId, connectionEpoch: epoch, afterSequence: 0, waitMs: 2000 })
    const queued = await post('/internal/media/dispatch', serviceToken, dispatch())
    assert.equal(queued.status, 200)
    assert.equal((await pending).body.tasks[0].taskId, 'task-a')
    const projection = await post('/internal/media/nodes', serviceToken, {})
    assert.equal(projection.body.nodes[0].ownerId, '167')
    assert.equal(projection.body.nodes[0].media_exchange_ready, false)
    assert.equal(JSON.stringify(projection.body).includes(reg.deviceToken), false)
    assert.equal(JSON.stringify(projection.body).includes('token_hash'), false)
  } finally { await channel.close(); await close(server); await close(account); rmSync(directory, { recursive: true, force: true }) }
})

test('closing gateway aborts pending channels before closing SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qs-media-close-'))
  const store = open(join(directory, 'nodes.sqlite'))
  const reg = registration(); const first = store.register('167', parseMediaNodeRegistration(reg))
  const channel = createMediaNodeRoutes({ store, verifyAccount: async () => null, dispatchToken: async () => undefined, maxLongPollRequests: 1 })
  const server = createServer((req, res) => void channel.routes.find(route => route.path === req.url).handler(req, res))
  const origin = await listen(server)
  try {
    const pending = fetch(`${origin}/v1/nodes/channel`, { method: 'POST', headers: { authorization: `Bearer ${reg.deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: reg.deviceId, connectionEpoch: first.connectionEpoch, afterSequence: 0, waitMs: 25000 }) })
    await new Promise(resolve => setTimeout(resolve, 30))
    await channel.close()
    assert.equal((await pending).status, 200)
  } finally { await close(server); rmSync(directory, { recursive: true, force: true }) }
})
