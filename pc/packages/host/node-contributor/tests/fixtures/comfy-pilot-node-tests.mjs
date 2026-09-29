/** Real loopback HTTP + SQLite CPU regressions. No production connection or GPU. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { crc32, deflateSync } from 'node:zlib'
import { createComfyPilot } from '../../runtime/comfy-pilot/comfy-pilot.mjs'

const classes = JSON.parse(await readFile(new URL('./comfy-pilot-metadata.json', import.meta.url), 'utf8'))
const files = { diffusion_models: 'qwen_image_2.1_int8_convrot.safetensors', text_encoders: 'qwen3vl_8b_int8_convrot.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors' }
function chunk(type, content) {
  const bytes = Buffer.alloc(content.length + 12); bytes.writeUInt32BE(content.length); bytes.write(type, 4, 'ascii'); content.copy(bytes, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4); return bytes
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(2048, 0); header.writeUInt32BE(1152, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(1152 * (1 + 2048 * 3)))), chunk('IEND', Buffer.alloc(0))])
}
async function fixture() {
  const history = {}, calls = [], output = png(), posted = []
  let beforeHistory = null, beforePost = null
  let dropPost = false, shortImage = false, imageOverride = null, changedMetadata = false, wrongName = false, mintedId = null
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1'), parts = []
    for await (const part of req) parts.push(part)
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null
    calls.push({ method: req.method, path: u.pathname })
    if (u.pathname === '/prompt') {
      posted.push(body)
      await beforePost?.()
      if (dropPost) { req.socket.destroy(); return }
      const payload = Buffer.from(JSON.stringify({ prompt_id: mintedId ?? body.prompt_id, node_errors: {} }))
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length }); res.end(payload); return
    }
    if (u.pathname === '/view') {
      const value = imageOverride ?? output
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': value.length })
      if (shortImage) { res.write(value.subarray(0, 100)); setTimeout(() => res.destroy(), 5); return }
      res.end(value); return
    }
    let value
    if (u.pathname === '/system_stats') value = { devices: [{ name: 'CPU fixture' }] }
    else if (u.pathname.startsWith('/models/')) value = [files[u.pathname.split('/')[2]]]
    else if (u.pathname.startsWith('/object_info/')) {
      const name = u.pathname.split('/')[2]
      value = { [name]: structuredClone(classes[name]) }
      if (changedMetadata && name === 'KSampler') value[name].input.required.sampler_name[0] = ['not-euler']
    } else if (u.pathname.startsWith('/history/')) { await beforeHistory?.(); value = history[u.pathname.split('/')[2]] ?? {} }
    else { res.writeHead(404); res.end(); return }
    const payload = Buffer.from(JSON.stringify(value)); res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length }); res.end(payload)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qianshou-comfy-pilot-'))), token = randomBytes(32).toString('base64url'), scopeId = randomUUID()
  let connected = true, executing = true
  const options = { comfyOrigin: 'http://127.0.0.1:' + server.address().port, directory, token, ownerScopeId: scopeId, port: 0, timeoutMs: 400,
    maximumResultBytes: 64 * 1024 * 1024, authorize: async (scope, action) => scope === scopeId && connected && (action !== 'execute' || executing) }
  const runtimes = []
  const create = async () => { const runtime = await createComfyPilot(options); runtimes.push(runtime); return runtime }
  const closeRuntime = async runtime => { await runtime.close(); runtimes.splice(runtimes.indexOf(runtime), 1) }
  const complete = (id, externalId = id) => { history[externalId] = { [externalId]: { status: { completed: true, status_str: 'success' }, outputs: { '8': { images: [{ filename: wrongName ? '../other.png' : 'qianshou_pilot_' + id + '_00001_.png', subfolder: '', type: 'output' }] } } } } }
  const request = runtime => ({ requestId: randomUUID(), workflowId: runtime.descriptor.id, prompt: 'CPU fixture description' })
  return { options, calls, posted, output, directory, create, closeRuntime, complete, request,
    set beforeHistory(value) { beforeHistory = value }, set beforePost(value) { beforePost = value },
    set dropPost(value) { dropPost = value }, set shortImage(value) { shortImage = value }, set imageOverride(value) { imageOverride = value },
    set changedMetadata(value) { changedMetadata = value }, set wrongName(value) { wrongName = value }, set mintedId(value) { mintedId = value },
    set connected(value) { connected = value }, set executing(value) { executing = value },
    async close() { while (runtimes.length) await closeRuntime(runtimes[0]); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) } }
}
const send = (runtime, token, path, body) => fetch(runtime.origin + path, { method: body ? 'POST' : 'GET',
  headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })

test('auto-creates a fixed Qwen API from existing model/class GETs without GPU, paths or a reviewed paid profile', async () => {
  const f = await fixture()
  try {
    const runtime = await f.create()
    const health = await send(runtime, f.options.token, '/healthz'), value = await health.json()
    assert.equal(value.status, 'ok'); assert.equal(value.commercial, false); assert.equal(value.descriptor.steps, 8)
    assert.equal(value.descriptor.width, 2048); assert.equal(value.descriptor.height, 1152)
    assert.equal(f.posted.length, 0); assert(f.calls.every(call => call.method === 'GET'))
    assert(!JSON.stringify(value).includes(f.directory)); assert(!JSON.stringify(value).includes(f.options.token))
    assert.equal((await send(runtime, 'wrong', '/healthz')).status, 401)
    assert.equal((await fetch(runtime.origin + '/healthz', { headers: { authorization: 'Bearer ' + f.options.token, origin: 'https://example.invalid' } })).status, 403)
    f.changedMetadata = true
    assert.equal((await send(runtime, f.options.token, '/healthz')).status, 503)
  } finally { await f.close() }
})
test('uses one immutable job UUID and fixed graph, returns verified PNG bytes and never generates again', async () => {
  const f = await fixture()
  try {
    const runtime = await f.create(), request = f.request(runtime)
    const result = await send(runtime, f.options.token, '/v1/jobs', request)
    assert.equal((await result.json()).status, 'running')
    await Promise.all([runtime.submit(request), runtime.submit(request)])
    assert.equal(f.posted.length, 1); assert.equal(f.posted[0].prompt_id, request.requestId)
    assert.equal(f.posted[0].prompt['4'].inputs.prompt, request.prompt)
    assert.equal(f.posted[0].prompt['6'].inputs.steps, 8)
    await assert.rejects(runtime.submit({ ...request, prompt: 'changed' }), /PILOT_REQUEST_CONFLICT/u)
    await assert.rejects(runtime.submit({ ...request, graph: {} }), /PILOT_REQUEST_INVALID/u)
    await assert.rejects(runtime.submit({ ...request, requestId: randomUUID() }), /PILOT_BUSY/u)
    f.complete(request.requestId)
    const recovered = await runtime.get(request.requestId)
    assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.result.width, 2048)
    assert.equal(recovered.result.sha256, createHash('sha256').update(f.output).digest('hex'))
    const bytes = Buffer.from(await (await send(runtime, f.options.token, '/v1/jobs/' + request.requestId + '/image')).arrayBuffer())
    assert(bytes.equals(f.output)); assert.equal(f.posted.length, 1)
  } finally { await f.close() }
})
test('recovers the original unknown POST only through GET after factory restart, including a private truncated delivery', async () => {
  const f = await fixture()
  try {
    let runtime = await f.create(); const request = f.request(runtime)
    f.dropPost = true
    assert.equal((await runtime.submit(request)).status, 'unknown')
    await f.closeRuntime(runtime)
    runtime = await f.create()
    assert.equal((await runtime.submit(request)).status, 'unknown'); assert.equal(f.posted.length, 1)
    f.complete(request.requestId)
    const partial = f.directory + '/results/' + request.requestId + '.part'
    await writeFile(partial, f.output.subarray(0, 80), { mode: 0o600 })
    f.executing = false
    const states = await Promise.all([runtime.get(request.requestId), runtime.get(request.requestId)])
    assert(states.every(state => state.status === 'succeeded')); assert.equal(f.posted.length, 1)
    assert.deepEqual(f.calls.filter(call => call.path.startsWith('/history')).map(call => call.path), ['/history/' + request.requestId])
    assert((await readFile(f.directory + '/results/' + request.requestId + '.png')).equals(f.output))
  } finally { await f.close() }
})
test('keeps the accepted original external UUID, rejects incomplete/corrupt/foreign images and recovers final rename before SQLite commit', async () => {
  const f = await fixture()
  try {
    let runtime = await f.create(); const request = f.request(runtime), external = randomUUID()
    f.mintedId = external
    assert.equal((await runtime.submit(request)).externalJobId, external)
    f.complete(request.requestId, external)
    f.shortImage = true
    assert.equal((await runtime.get(request.requestId)).status, 'delivery_pending')
    f.shortImage = false; const corrupt = Buffer.from(f.output); corrupt[corrupt.length - 1] ^= 1; f.imageOverride = corrupt
    assert.equal((await runtime.get(request.requestId)).errorCode, 'PILOT_IMAGE_INVALID')
    f.imageOverride = null; f.wrongName = true; f.complete(request.requestId, external)
    assert.equal((await runtime.get(request.requestId)).errorCode, 'PILOT_IMAGE_INVALID')
    f.wrongName = false; f.complete(request.requestId, external)
    assert.equal((await runtime.get(request.requestId)).status, 'succeeded')
    await f.closeRuntime(runtime)
    const db = new DatabaseSync(f.directory + '/pilot-jobs.sqlite'); db.prepare("UPDATE jobs SET status='delivery_pending',result=NULL WHERE id=?").run(request.requestId); db.close()
    runtime = await f.create()
    assert.equal((await runtime.get(request.requestId)).status, 'succeeded')
    assert.equal(f.posted.length, 1)
    assert(f.calls.filter(call => call.path.startsWith('/history')).every(call => call.path.endsWith(external)))
  } finally { await f.close() }
})
test('denies new execution on pause and all access after account change; unknown jobs cannot be adopted by another scope', async () => {
  const f = await fixture()
  try {
    const runtime = await f.create(), request = f.request(runtime)
    f.executing = false
    await assert.rejects(runtime.submit(request), /PILOT_SCOPE_UNAUTHORIZED/u); assert.equal(f.posted.length, 0)
    f.executing = true; f.dropPost = true; await runtime.submit(request)
    f.connected = false
    assert.equal((await send(runtime, f.options.token, '/v1/jobs/' + request.requestId)).status, 403)
    f.connected = true; await f.closeRuntime(runtime)
    await assert.rejects(createComfyPilot({ ...f.options, ownerScopeId: randomUUID(), authorize: () => true }), /PILOT_SCOPE_CHANGED/u)
    assert.equal(f.posted.length, 1)
  } finally { await f.close() }
})
test('rejects a linked partial image and changed node enums without GPU submissions', async () => {
  const f = await fixture()
  try {
    f.changedMetadata = true; await assert.rejects(f.create(), /PILOT_WORKFLOW_UNSUPPORTED/u); assert.equal(f.posted.length, 0)
    f.changedMetadata = false
    const runtime = await f.create(), request = f.request(runtime); await runtime.submit(request); f.complete(request.requestId)
    const external = f.directory + '/existing.png'; await writeFile(external, f.output, { mode: 0o600 })
    await symlink(external, f.directory + '/results/' + request.requestId + '.part')
    assert.equal((await runtime.get(request.requestId)).status, 'delivery_pending')
    assert.equal(f.posted.length, 1); assert((await readFile(external)).equals(f.output))
  } finally { await f.close() }
})

test('revocation during the original GET returns no job metadata and can later recover only the original UUID', async () => {
  const f = await fixture()
  try {
    const runtime = await f.create(), request = f.request(runtime); await runtime.submit(request); f.complete(request.requestId)
    f.beforeHistory = async () => { f.connected = false }
    const response = await send(runtime, f.options.token, '/v1/jobs/' + request.requestId)
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { ok: false, code: 'PILOT_SCOPE_UNAUTHORIZED' })
    f.beforeHistory = null; f.connected = true
    assert.equal((await runtime.get(request.requestId)).status, 'succeeded')
    assert.equal(f.posted.length, 1)
  } finally { await f.close() }
})
test('revocation in an accepted POST persists the real external ID before denying the caller without another POST', async () => {
  const f = await fixture()
  try {
    const runtime = await f.create(), request = f.request(runtime), external = randomUUID(); f.mintedId = external
    f.beforePost = async () => { f.connected = false }
    const response = await send(runtime, f.options.token, '/v1/jobs', request)
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { ok: false, code: 'PILOT_SCOPE_UNAUTHORIZED' })
    f.beforePost = null; f.connected = true
    const original = await runtime.submit(request)
    assert.equal(original.externalJobId, external); assert.equal(original.status, 'unknown')
    f.complete(request.requestId, external)
    assert.equal((await runtime.get(request.requestId)).status, 'succeeded'); assert.equal(f.posted.length, 1)
  } finally { await f.close() }
})


test('maintenance denial before the sole GPU POST creates no false unresolved installation slot', async () => {
  const f = await fixture()
  try {
    const authorize = f.options.authorize; let executions = 0
    f.options.authorize = async (scope, action) => {
      if (action === 'execute' && ++executions === 2) return false
      return authorize(scope, action)
    }
    const runtime = await f.create(), request = f.request(runtime)
    assert.equal((await runtime.submit(request)).status, 'failed')
    assert.equal(runtime.busy(), false); assert.equal(f.posted.length, 0)
    f.options.authorize = authorize
    assert.equal((await runtime.submit(request)).status, 'failed')
    assert.equal(f.posted.length, 0)
  } finally { await f.close() }
})
