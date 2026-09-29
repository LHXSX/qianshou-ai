/** Owner-authorized, zero-fee Qwen Comfy API factory. It never starts or modifies Comfy. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { crc32, inflateSync } from 'node:zlib'

const TEMPLATE_SHA = '154f7d6133fe0276e7cefc97a17ea2bde1febe397f3963bd0ea8be8c624ee7be'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_GRAPH = 1024 * 1024
const MAX_MEDIA = 64 * 1024 * 1024
const MODEL = 'qwen-image-2.1-int8-convrot'
const FILES = { diffusion_models: 'qwen_image_2.1_int8_convrot.safetensors', text_encoders: 'qwen3vl_8b_int8_convrot.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
class PilotError extends Error { constructor(code, status = 503) { super(code); this.code = code; this.status = status } }
const fail = (code, status) => { throw new PilotError(code, status) }
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('PILOT_RESPONSE_INVALID')
const exact = (value, fields) => {
  const row = object(value)
  if (Object.keys(row).sort().join('|') !== [...fields].sort().join('|')) fail('PILOT_REQUEST_INVALID', 400)
  return row
}
function localOrigin(value) {
  let u; try { u = new URL(value) } catch { fail('PILOT_CONFIG_INVALID', 400) }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) fail('PILOT_CONFIG_INVALID', 400)
  return u.origin
}
async function privatePath(directory) {
  if (!isAbsolute(directory) || directory.split(/[\\/]/u).includes('..')) fail('PILOT_STORAGE_INVALID')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let current = parse(directory).root
  for (const part of directory.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('PILOT_STORAGE_INVALID')
  }
  const info = await lstat(directory)
  if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) fail('PILOT_STORAGE_INVALID')
}
async function privateFile(path, bytes) {
  const fd = await open(path, 'wx', 0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
}
async function regularFile(path, maximum) {
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await fd.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) fail('PILOT_STORAGE_INVALID')
    const bytes = await fd.readFile()
    if (bytes.length !== info.size) fail('PILOT_STORAGE_INVALID')
    return bytes
  } finally { await fd.close() }
}
function transport(origin, timeoutMs, controller) {
  return (method, path, body, maximum) => new Promise((resolve, reject) => {
    let settled = false, timer
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value) }
    const encoded = body === undefined ? null : Buffer.from(canonical(body))
    const req = httpRequest(new URL(path, origin), { method, agent: false, signal: controller.signal,
      headers: { accept: method === 'GET' && path.startsWith('/view?') ? 'image/png' : 'application/json',
        ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}) } }, response => {
      const declared = response.headers['content-length']
      if (response.statusCode !== 200 || typeof declared !== 'string' || !/^[1-9][0-9]*$/u.test(declared) || Number(declared) > maximum) {
        response.destroy(); finish(new PilotError('PILOT_UPSTREAM_UNAVAILABLE')); return
      }
      let size = 0; const chunks = []
      response.on('data', chunk => { size += chunk.length; if (size > maximum || size > Number(declared)) response.destroy(); else chunks.push(chunk) })
      response.on('end', () => size === Number(declared) ? finish(null, Buffer.concat(chunks)) : finish(new PilotError('PILOT_UPSTREAM_INCOMPLETE')))
      response.on('error', () => finish(new PilotError('PILOT_UPSTREAM_INCOMPLETE')))
    })
    timer = setTimeout(() => req.destroy(new PilotError('PILOT_UPSTREAM_UNAVAILABLE')), timeoutMs)
    req.on('error', () => finish(new PilotError('PILOT_UPSTREAM_UNAVAILABLE')))
    if (encoded) req.write(encoded)
    req.end()
  })
}
function json(bytes) { try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) } catch { fail('PILOT_RESPONSE_INVALID') } }
async function verifyGraph(get, graph) {
  const stats = json(await get('GET', '/system_stats', undefined, MAX_GRAPH))
  if (!Array.isArray(stats.devices) || stats.devices.length === 0) fail('PILOT_COMFY_UNAVAILABLE')
  for (const [group, name] of Object.entries(FILES)) {
    let list; try { list = JSON.parse((await get('GET', '/models/' + group, undefined, MAX_GRAPH)).toString('utf8')) } catch { fail('PILOT_MODEL_UNAVAILABLE') }
    if (!Array.isArray(list) || !list.includes(name)) fail('PILOT_MODEL_UNAVAILABLE')
  }
  const classes = {}
  for (const node of Object.values(graph)) {
    const name = node.class_type
    classes[name] = object(json(await get('GET', '/object_info/' + name, undefined, MAX_GRAPH))[name])
    if (!Array.isArray(classes[name].output)) fail('PILOT_WORKFLOW_UNSUPPORTED')
  }
  for (const node of Object.values(graph)) {
    const input = object(classes[node.class_type].input)
    const required = object(input.required)
    const allowed = { ...required, ...object(input.optional ?? {}) }
    for (const field of Object.keys(required)) if (!(field in node.inputs)) fail('PILOT_WORKFLOW_UNSUPPORTED')
    for (const [key, value] of Object.entries(node.inputs)) {
      const definition = allowed[key]
      if (!Array.isArray(definition)) fail('PILOT_WORKFLOW_UNSUPPORTED')
      const type = definition[0], limits = definition[1] ?? {}
      if (Array.isArray(value)) {
        const from = graph[value[0]]
        if (value.length !== 2 || !from || !Number.isSafeInteger(value[1]) || value[1] < 0 || classes[from.class_type].output[value[1]] !== type) fail('PILOT_WORKFLOW_UNSUPPORTED')
      } else if (Array.isArray(type)) {
        if (!type.includes(value)) fail('PILOT_WORKFLOW_UNSUPPORTED')
      } else if (type === 'INT' || type === 'FLOAT') {
        if (typeof value !== 'number' || !Number.isFinite(value) || type === 'INT' && !Number.isSafeInteger(value)
          || limits.min !== undefined && value < limits.min || limits.max !== undefined && value > limits.max
          || type === 'INT' && limits.step !== undefined && value % limits.step !== 0) fail('PILOT_WORKFLOW_UNSUPPORTED')
      } else if (type === 'STRING') {
        if (typeof value !== 'string') fail('PILOT_WORKFLOW_UNSUPPORTED')
      } else if (type === 'COMFY_AUTOGROW_V3') {
        if (node.class_type !== 'TextEncodeQwenImage21' || key !== 'images' || Object.keys(object(value)).length !== 0 || limits.template?.min !== 0) fail('PILOT_WORKFLOW_UNSUPPORTED')
      } else fail('PILOT_WORKFLOW_UNSUPPORTED')
    }
  }
  if (classes.SaveImage.output_node !== true) fail('PILOT_WORKFLOW_UNSUPPORTED')
}
function imageMetadata(bytes, width, height) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('PILOT_IMAGE_INVALID')
  let position = 8, header = false, ended = false, dataEnded = false, seenData = false, channels = 0; const compressed = []
  while (position < bytes.length) {
    if (position + 12 > bytes.length) fail('PILOT_IMAGE_INVALID')
    const length = bytes.readUInt32BE(position), end = position + length + 12
    if (end > bytes.length) fail('PILOT_IMAGE_INVALID')
    const type = bytes.toString('ascii', position + 4, position + 8), content = bytes.subarray(position + 8, end - 4)
    if (!/^[A-Za-z]{4}$/u.test(type) || crc32(bytes.subarray(position + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('PILOT_IMAGE_INVALID')
    if (!header && type !== 'IHDR') fail('PILOT_IMAGE_INVALID')
    if (type === 'IHDR') {
      if (header || length !== 13 || content.readUInt32BE(0) !== width || content.readUInt32BE(4) !== height
        || content[8] !== 8 || ![2, 6].includes(content[9]) || content[10] !== 0 || content[11] !== 0 || content[12] !== 0) fail('PILOT_IMAGE_INVALID')
      channels = content[9] === 2 ? 3 : 4; header = true
    } else if (type === 'IDAT') {
      if (dataEnded) fail('PILOT_IMAGE_INVALID')
      seenData = true; compressed.push(content)
    } else if (type === 'IEND') {
      if (length !== 0 || !seenData || end !== bytes.length) fail('PILOT_IMAGE_INVALID')
      ended = true
    } else {
      if (seenData) dataEnded = true
      if (type[0] === type[0].toUpperCase() && type !== 'PLTE') fail('PILOT_IMAGE_INVALID')
    }
    position = end
  }
  if (!ended) fail('PILOT_IMAGE_INVALID')
  const expected = height * (1 + width * channels)
  if (expected > MAX_MEDIA) fail('PILOT_IMAGE_INVALID')
  let raw; try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }) } catch { fail('PILOT_IMAGE_INVALID') }
  if (raw.length !== expected) fail('PILOT_IMAGE_INVALID')
  for (let row = 0; row < height; row++) if (raw[row * (1 + width * channels)] > 4) fail('PILOT_IMAGE_INVALID')
  return { sha256: hash(bytes), sizeBytes: bytes.length, contentType: 'image/png', width, height }
}

/** Validate the builtin graph against real GET metadata, create private fixed API state, and listen on loopback.
 * @param {object} options Explicit Host-selected origins/storage/port/deadline and current-scope authorization callback.
 * @returns {Promise<object>} Private library handle. No application CLI, paid qualification or GPU self-test.
 */
export async function createComfyPilot(options) {
  const config = { ...options }
  const origin = localOrigin(config.comfyOrigin)
  if (!UUID.test(config.ownerScopeId) || typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/u.test(config.token)
    || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
    || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30000
    || !Number.isInteger(config.maximumResultBytes) || config.maximumResultBytes < 1 || config.maximumResultBytes > MAX_MEDIA
    || typeof config.authorize !== 'function' || config.recoveryOnly !== undefined && typeof config.recoveryOnly !== 'boolean') fail('PILOT_CONFIG_INVALID', 400)
  const controller = new AbortController(), upstream = transport(origin, config.timeoutMs, controller)
  const scopeId = config.ownerScopeId
  const authorized = async action => { if (await config.authorize(scopeId, action) !== true) fail('PILOT_SCOPE_UNAUTHORIZED', 403) }
  await authorized(config.recoveryOnly ? 'recover' : 'connect')
  const template = await readFile(new URL('./qwen-image21-template.json', import.meta.url))
  if (hash(template) !== TEMPLATE_SHA) fail('PILOT_TEMPLATE_CHANGED')
  const graph = json(template)
  if (!config.recoveryOnly) await verifyGraph(upstream, graph)
  await authorized(config.recoveryOnly ? 'recover' : 'connect')
  if (config.recoveryOnly) {
    await regularFile(join(config.directory, 'pilot-jobs.sqlite'), MAX_MEDIA)
    await regularFile(join(config.directory, 'graph-' + TEMPLATE_SHA + '.json'), MAX_GRAPH)
  }
  await privatePath(config.directory)
  const workflowId = 'comfy-pilot-image-' + TEMPLATE_SHA.slice(0, 16)
  const generated = join(config.directory, 'graph-' + TEMPLATE_SHA + '.json')
  try { await privateFile(generated, template) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (hash(await regularFile(generated, MAX_GRAPH)) !== TEMPLATE_SHA) fail('PILOT_TEMPLATE_CHANGED')
  }
  const results = join(config.directory, 'results'); await privatePath(results)
  const database = join(config.directory, 'pilot-jobs.sqlite')
  try { await privateFile(database, Buffer.alloc(0)) } catch (error) { if (error.code !== 'EEXIST') throw error; await regularFile(database, MAX_MEDIA) }
  const db = new DatabaseSync(database)
  db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT, external_id TEXT NOT NULL, error_code TEXT)')
  const setting = db.prepare("SELECT value FROM settings WHERE key='scope'").get()
  if (setting && setting.value !== scopeId) { db.close(); fail('PILOT_SCOPE_CHANGED', 409) }
  if (!setting && config.recoveryOnly) { db.close(); fail('PILOT_SCOPE_CHANGED', 409) }
  if (!setting) db.prepare("INSERT INTO settings(key,value) VALUES('scope',?)").run(scopeId)
  const getRow = id => {
    const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
    if (!row) return row
    if (!UUID.test(row.id) || !UUID.test(row.external_id) || !/^[0-9a-f]{64}$/u.test(row.request_hash)
      || !['unknown', 'running', 'delivery_pending', 'succeeded', 'failed'].includes(row.status)
      || row.error_code !== null && (typeof row.error_code !== 'string' || !/^PILOT_[A-Z_]{1,64}$/u.test(row.error_code))) fail('PILOT_STORAGE_INVALID')
    if (row.result !== null) {
      let value; try { value = JSON.parse(row.result) } catch { fail('PILOT_STORAGE_INVALID') }
      const result = exact(value, ['sha256', 'sizeBytes', 'contentType', 'width', 'height'])
      if (!/^[0-9a-f]{64}$/u.test(result.sha256) || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 1
        || result.sizeBytes > config.maximumResultBytes || result.contentType !== 'image/png'
        || result.width !== graph['5'].inputs.width || result.height !== graph['5'].inputs.height) fail('PILOT_STORAGE_INVALID')
    }
    if (row.status === 'succeeded' && row.result === null) fail('PILOT_STORAGE_INVALID')
    return row
  }
  const update = (id, state, result = null, errorCode = null) => db.prepare('UPDATE jobs SET status=?,result=?,error_code=? WHERE id=?').run(state, result === null ? null : canonical(result), errorCode, id)
  const project = row => ({ schema: 'qianshou.comfy-pilot-job.v1', requestId: row.id, workflowId,
    status: row.status, externalJobId: row.external_id, errorCode: row.error_code, commercial: false, ...(row.result ? { result: JSON.parse(row.result) } : {}) })
  const operations = new Set(), recovering = new Map(); let closed = false
  const track = promise => { operations.add(promise); void promise.finally(() => operations.delete(promise)).catch(() => undefined); return promise }
  const descriptor = { schema: 'qianshou.comfy-pilot-workflow.v1', id: workflowId, mode: 'image', name: 'Qwen Image 2.1 text-to-image',
    model: { id: MODEL, sha256: null, version: '2.1' }, workflow: { id: workflowId, sha256: TEMPLATE_SHA, version: '1' },
    width: graph['5'].inputs.width, height: graph['5'].inputs.height, steps: graph['6'].inputs.steps, commercial: false }
  Object.freeze(descriptor.model); Object.freeze(descriptor.workflow); Object.freeze(descriptor)
  function validateRequest(value) {
    const request = exact(value, ['requestId', 'workflowId', 'prompt'])
    if (!UUID.test(request.requestId) || request.workflowId !== workflowId || typeof request.prompt !== 'string'
      || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 8192
      || Array.from(request.prompt).some(character => character.charCodeAt(0) < 32 && !'\t\n\r'.includes(character))) fail('PILOT_REQUEST_INVALID', 400)
    return request
  }
  async function submit(value) {
    if (closed) fail('PILOT_CLOSED', 503)
    if (config.recoveryOnly) fail('PILOT_EXECUTION_DISABLED', 409)
    const request = validateRequest(value), requestHash = hash(canonical(request))
    await authorized('connect')
    if (!getRow(request.requestId)) await authorized('execute')
    db.exec('BEGIN IMMEDIATE')
    let known
    try {
      known = getRow(request.requestId)
      if (known && known.request_hash !== requestHash) fail('PILOT_REQUEST_CONFLICT', 409)
      if (!known) {
        if (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status NOT IN ('succeeded','failed')").get().count > 0) fail('PILOT_BUSY', 409)
        db.prepare('INSERT INTO jobs(id,request_hash,status,result,external_id,error_code) VALUES(?,?,?,NULL,?,NULL)').run(request.requestId, requestHash, 'unknown', request.requestId)
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    if (known) return project(known)
    const actual = structuredClone(graph)
    actual['4'].inputs.prompt = request.prompt
    actual['8'].inputs.filename_prefix = 'qianshou_pilot_' + request.requestId
    let postAttempted = false
    try {
      await authorized('execute')
      postAttempted = true
      const reply = json(await upstream('POST', '/prompt', { prompt: actual, prompt_id: request.requestId, client_id: request.requestId }, MAX_GRAPH))
      if (!UUID.test(reply.prompt_id) || Object.keys(object(reply.node_errors)).length !== 0) fail('PILOT_RESPONSE_INVALID')
      // The accepted backend UUID is saved even when the account changes while POST is in flight.
      db.prepare('UPDATE jobs SET external_id=? WHERE id=?').run(reply.prompt_id, request.requestId)
      await authorized('connect'); update(request.requestId, 'running')
    } catch (error) { update(request.requestId, !postAttempted && error instanceof PilotError && error.code === 'PILOT_SCOPE_UNAUTHORIZED' ? 'failed' : 'unknown', null, error instanceof PilotError ? error.code : 'PILOT_UPSTREAM_UNAVAILABLE') }
    await authorized('connect')
    return project(getRow(request.requestId))
  }
  async function recover(id) {
    if (closed) fail('PILOT_CLOSED')
    await authorized('recover')
    if (!UUID.test(id)) fail('PILOT_REQUEST_INVALID', 400)
    let row = getRow(id)
    if (!row) fail('PILOT_JOB_NOT_FOUND', 404)
    if (row.status === 'succeeded' || row.status === 'failed') return project(row)
    try {
      const history = json(await upstream('GET', '/history/' + row.external_id, undefined, MAX_GRAPH))
      await authorized('recover')
      if (!(row.external_id in history)) return project(row)
      const item = object(history[row.external_id]), state = object(item.status)
      if (state.status_str === 'error' && state.completed === false) { update(id, 'failed'); return project(getRow(id)) }
      if (state.completed !== true || state.status_str !== 'success') return project(row)
      const images = object(object(item.outputs)['8']).images
      if (!Array.isArray(images) || images.length !== 1) fail('PILOT_IMAGE_INVALID')
      const image = exact(images[0], ['filename', 'subfolder', 'type'])
      if (image.type !== 'output' || image.subfolder !== '' || typeof image.filename !== 'string'
        || !new RegExp('^qianshou_pilot_' + id + '_[0-9]+_\\.png$', 'u').test(image.filename)) fail('PILOT_IMAGE_INVALID')
      update(id, 'delivery_pending')
      const query = new URLSearchParams({ filename: image.filename, subfolder: '', type: 'output' })
      const bytes = await upstream('GET', '/view?' + query, undefined, config.maximumResultBytes)
      const metadata = imageMetadata(bytes, descriptor.width, descriptor.height)
      await authorized('recover')
      const partial = join(results, id + '.part'), final = join(results, id + '.png')
      try { await privateFile(partial, bytes) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const fd = await open(partial, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
        try {
          const info = await fd.stat()
          if (!info.isFile() || info.nlink !== 1 || info.size > bytes.length || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) fail('PILOT_STORAGE_INVALID')
          const prefix = await fd.readFile()
          if (prefix.length !== info.size || !prefix.equals(bytes.subarray(0, prefix.length))) fail('PILOT_STORAGE_INVALID')
          await fd.writeFile(bytes.subarray(prefix.length)); await fd.sync()
        } finally { await fd.close() }
      }
      let finalExists = false
      try {
        const existing = await regularFile(final, config.maximumResultBytes)
        if (!existing.equals(bytes)) fail('PILOT_STORAGE_INVALID')
        finalExists = true
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!finalExists) await rename(partial, final)
      if (process.platform !== 'win32') { const fd = await open(results, constants.O_RDONLY); try { await fd.sync() } finally { await fd.close() } }
      await authorized('recover'); update(id, 'succeeded', metadata)
    } catch (error) { row = getRow(id); update(id, row.status, row.result ? JSON.parse(row.result) : null, error instanceof PilotError ? error.code : 'PILOT_DELIVERY_UNAVAILABLE') }
    await authorized('recover')
    return project(getRow(id))
  }
  function get(id) {
    if (recovering.has(id)) return recovering.get(id)
    const running = track(recover(id)); recovering.set(id, running)
    void running.finally(() => recovering.delete(id)).catch(() => undefined)
    return running
  }
  async function result(id) {
    const state = await get(id)
    if (state.status !== 'succeeded') fail('PILOT_RESULT_PENDING', 409)
    await authorized('recover')
    const bytes = await regularFile(join(results, id + '.png'), config.maximumResultBytes)
    if (canonical(imageMetadata(bytes, descriptor.width, descriptor.height)) !== canonical(state.result)) fail('PILOT_IMAGE_INVALID')
    await authorized('recover'); return bytes
  }
  async function health() {
    await authorized('connect'); await verifyGraph(upstream, graph); await authorized('connect')
    return { schema: 'qianshou.comfy-pilot.v1', status: 'ok', descriptor,
      busy: db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status NOT IN ('succeeded','failed')").get().count > 0, commercial: false }
  }
  if (config.recoveryOnly) {
    await authorized('recover')
    return { origin: null, descriptor,
      busy: () => db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status NOT IN ('succeeded','failed')").get().count > 0,
      submit: value => track(submit(value)), get, result: id => track(result(id)),
      health: async () => fail('PILOT_EXECUTION_DISABLED', 409),
      async close() { if (closed) return; closed = true; controller.abort(); await Promise.allSettled(operations); db.close() } }
  }
  function authenticated(request) {
    if (request.headers.origin || request.headers.cookie) fail('PILOT_AUTH_REQUIRED', 403)
    const value = request.headers.authorization
    const actual = typeof value === 'string' ? Buffer.from(value) : Buffer.alloc(0), expected = Buffer.from('Bearer ' + config.token)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('PILOT_AUTH_REQUIRED', 401)
  }
  const server = createServer((request, response) => {
    const job = (async () => {
      authenticated(request)
      const path = request.url ?? ''
      let output
      if (request.method === 'GET' && path === '/healthz') output = await health()
      else if (request.method === 'GET' && path === '/v1/workflows') { await authorized('connect'); output = { workflows: [descriptor] } }
      else if (request.method === 'GET' && path === '/v1/models') { await authorized('connect'); output = { models: [descriptor.model] } }
      else if (request.method === 'POST' && path === '/v1/jobs') {
        if (request.headers['content-type'] !== 'application/json') fail('PILOT_REQUEST_INVALID', 400)
        const declared = request.headers['content-length']
        if (typeof declared !== 'string' || !/^[1-9][0-9]*$/u.test(declared) || Number(declared) > 16384) fail('PILOT_REQUEST_INVALID', 400)
        let length = 0; const chunks = []
        for await (const chunk of request) { length += chunk.length; if (length > 16384) fail('PILOT_REQUEST_INVALID', 400); chunks.push(chunk) }
        if (length !== Number(declared)) fail('PILOT_REQUEST_INVALID', 400)
        output = await track(submit(json(Buffer.concat(chunks))))
      } else if (request.method === 'GET' && /^\/v1\/jobs\/[0-9a-f-]+(?:\/image)?$/u.test(path)) {
        const id = path.split('/')[3]
        if (path.endsWith('/image')) {
          const bytes = await result(id); await authorized('recover'); response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length, 'cache-control': 'no-store' }); response.end(bytes); return
        }
        output = await get(id)
      } else fail('PILOT_ROUTE_NOT_FOUND', 404)
      await authorized(request.method === 'GET' && path.startsWith('/v1/jobs/') ? 'recover' : 'connect')
      const bytes = Buffer.from(canonical(output)); response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': 'no-store' }); response.end(bytes)
    })()
    track(job).catch(error => {
      if (response.destroyed || response.headersSent) { response.destroy(); return }
      const bytes = Buffer.from(canonical({ ok: false, code: error instanceof PilotError ? error.code : 'PILOT_UNAVAILABLE' }))
      response.writeHead(error instanceof PilotError ? error.status : 503, { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': 'no-store' }); response.end(bytes)
    })
  })
  server.requestTimeout = config.timeoutMs; server.headersTimeout = config.timeoutMs
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve) }) }
  catch (error) { controller.abort(); db.close(); throw error }
  try { await authorized('connect') }
  catch (error) { controller.abort(); await new Promise(resolve => server.close(resolve)); db.close(); throw error }
  return { origin: 'http://127.0.0.1:' + server.address().port, descriptor,
    busy: () => db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status NOT IN ('succeeded','failed')").get().count > 0,
    submit: value => track(submit(value)), get, result: id => track(result(id)), health: () => track(health()),
    async close() {
      if (closed) return
      closed = true; controller.abort()
      const stopped = new Promise(resolve => server.close(resolve)); server.closeIdleConnections()
      await Promise.allSettled(operations); await stopped; db.close()
    } }
}
