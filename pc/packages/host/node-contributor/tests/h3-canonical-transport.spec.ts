import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseH3CanonicalIdentity, parseH3CanonicalJob, type H3CanonicalJobExpectation } from '../src/h3-canonical-protocol.ts'
import { readH3CanonicalIdentity, readH3CanonicalJob, readH3CanonicalMedia } from '../src/h3-canonical-transport.ts'

// The actual stage1 Python public_identity/view/gateway constructors produced these packets.
// workbench_node.py 638f0bbf376813e22c9ba62b239d04e0043810650c796ff8a422c25314da54bd.
// Identity/model/encoder/media values are synthetic; no GPU or installed software is proved.
const wire = {
  'identity': {
    'schemaVersion': 'qs.h3.recipe-identity.canonical-vnext',
    'workflow': 'qs_new4',
    'recipeVersion': '1.0.0-rc.1',
    'graphTemplateSha256': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'executionRecipeSha256': 'a7b929ee140c10e20eb8f1a50deb32592dc47853946f71bca23bbbf6be720660',
    'modelSha256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'modelSetSha256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'sourceManifestSha256': '937a6aea58c9e4b8a269d7e1abb4c8da5b528c50d68267fe2c186ac09ee0dc3b',
    'classOriginSha256': 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'graphSha256': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'runtimeAbi': 'qs.h3.canonical.qs_new4.vnext',
    'weightSha256ByRole': {
      'audioVae': '1111111111111111111111111111111111111111111111111111111111111111',
      'clip': '2222222222222222222222222222222222222222222222222222222222222222',
      'lora': '3333333333333333333333333333333333333333333333333333333333333333',
      'unet': '4444444444444444444444444444444444444444444444444444444444444444',
      'videoVae': '5555555555555555555555555555555555555555555555555555555555555555',
    },
  },
  'mediaBase64': 'AAAAGGZ0eXBpc29tY2Fub25pY2FsIHByb3RvY29sIGZpeHR1cmUsIG5vdCBhIHJlYWwgcmVuZGVyZWQgTVA0',
  'done': {
    'job_id': 'qa-canonical-job',
    'id': 'qa-canonical-job',
    'phase': 'done',
    'status': 'done',
    'pct': 0,
    'percent': 0,
    'done': true,
    'failed': false,
    'cancelled': false,
    'error': null,
    'video_url': 'http://127.0.0.1:8790/v1/jobs/qa-canonical-job/video',
    'file_url': 'http://127.0.0.1:8790/v1/jobs/qa-canonical-job/video',
    'elapsed_sec': 1,
    'progress': {
      'percent': 0,
      'value': 0,
      'max': 0,
      'node': null,
      'phase': 'done',
      'message': null,
    },
    'fed': {
      'version': '0.1.0-canonical.20260927',
    },
    'recipe_identity': {
      'schemaVersion': 'qs.h3.job-identity.canonical-vnext',
      'expected': {
        'executionRecipeSha256': 'a7b929ee140c10e20eb8f1a50deb32592dc47853946f71bca23bbbf6be720660',
        'modelSha256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      'actual': {
        'executionRecipeSha256': 'a7b929ee140c10e20eb8f1a50deb32592dc47853946f71bca23bbbf6be720660',
        'modelSha256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'modelSetSha256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'sourceManifestSha256': '937a6aea58c9e4b8a269d7e1abb4c8da5b528c50d68267fe2c186ac09ee0dc3b',
        'classOriginSha256': 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'deliverySha256': '4dd06600aa088c2032d238aa62d53204a88df2d2bb428ddc15645e9e4ce1c97f',
        'deliverySize': 63,
        'comfyFfmpegSha256': 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        'deliveryFfmpegSha256': 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
      'attested': true,
    },
    'comfy_model_load_generation_sha256': 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  },
}

const servers: Server[] = []
const options = { timeoutMs: 2_000 }
const media = Buffer.from(wire.mediaBase64, 'base64')
const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }))
})

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  return `http://127.0.0.1:${address.port}`
}

function connectionClose() {
  let close: () => void = () => { throw new Error('fixture close observer missing') }
  const closed = new Promise<void>((resolve) => { close = resolve })
  return { closed, watch: (request: IncomingMessage): void => { request.socket.once('close', close) } }
}

function expected(base: string): H3CanonicalJobExpectation {
  return { adapterBase: base, jobId: wire.done.job_id, identity: parseH3CanonicalIdentity(wire.identity),
    comfyFfmpegSha256: wire.done.recipe_identity.actual.comfyFfmpegSha256,
    deliveryFfmpegSha256: wire.done.recipe_identity.actual.deliveryFfmpegSha256 }
}

function job(status: 'queued' | 'running' | 'failed' | 'cancelled' | 'done' = 'done') {
  const { comfy_model_load_generation_sha256: generation, ...row } = wire.done
  const complete = status === 'done'
  return { ...row, status, phase: status, done: complete, failed: status === 'failed', cancelled: status === 'cancelled',
    video_url: complete ? `/v1/jobs/${row.job_id}/video` : null,
    file_url: complete ? `/v1/jobs/${row.job_id}/video` : null,
    recipe_identity: { ...row.recipe_identity, actual: complete ? row.recipe_identity.actual : null, attested: complete },
    ...(complete ? { comfy_model_load_generation_sha256: generation } : {}) }
}

function completed(base: string, bytes: Buffer = media) {
  const packet = job()
  packet.recipe_identity.actual = { ...wire.done.recipe_identity.actual, deliverySha256: digest(bytes), deliverySize: bytes.length }
  const result = parseH3CanonicalJob(packet, expected(base))
  if (result.state !== 'completed') throw new Error('fixture terminal missing')
  return result
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function stream(response: ServerResponse, bytes: Buffer, contentType: string): void {
  response.writeHead(200, { 'content-type': contentType })
  for (let offset = 0; offset < bytes.length; offset += 16 * 1024) response.write(bytes.subarray(offset, offset + 16 * 1024))
  response.end()
}

describe('canonical fixed loopback GET transport', () => {
  it('reads the actual public identity without ambient credentials, proxy or a write request', async () => {
    const requests: { method: string | undefined; path: string | undefined; headers: IncomingMessage['headers'] }[] = []
    let proxyCalls = 0
    const proxy = await serve((_request, response) => { proxyCalls++; response.writeHead(500); response.end() })
    vi.stubEnv('HTTP_PROXY', proxy)
    vi.stubEnv('http_proxy', proxy)
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    const base = await serve((request, response) => {
      requests.push({ method: request.method, path: request.url, headers: request.headers })
      sendJson(response, wire.identity)
    })
    expect(await readH3CanonicalIdentity(base, options)).toEqual(parseH3CanonicalIdentity(wire.identity))
    expect(proxyCalls).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/recipes/qs_new4/identity',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' } })
    expect(requests[0]?.headers.authorization).toBeUndefined()
    expect(requests[0]?.headers.cookie).toBeUndefined()
    expect(requests[0]?.headers['proxy-authorization']).toBeUndefined()
  })

  it.each(['queued', 'running', 'failed', 'cancelled'] as const)('reads one %s job and omits private feedback', async (status) => {
    const paths: string[] = []
    const base = await serve((request, response) => {
      paths.push(request.url ?? '')
      sendJson(response, { ...job(status), error: 'private local path', feedback: 'not public' })
    })
    expect(await readH3CanonicalJob(expected(base), options)).toEqual({ state: status, jobId: wire.done.job_id })
    expect(paths).toEqual([`/v1/jobs/${wire.done.job_id}`])
  })

  it('reads terminal media from only the fixed job route and returns an independent verified copy', async () => {
    const paths: string[] = []
    const base = await serve((request, response) => {
      paths.push(request.url ?? '')
      if (request.url === `/v1/jobs/${wire.done.job_id}`) sendJson(response, job())
      else stream(response, media, 'video/mp4')
    })
    const end = await readH3CanonicalJob(expected(base), options)
    if (end.state !== 'completed') throw new Error('expected actual terminal packet')
    const first = await readH3CanonicalMedia(expected(base), end, options)
    expect(first).toEqual(media)
    expect(digest(first)).toBe(end.sha256)
    first.fill(0)
    expect(await readH3CanonicalMedia(expected(base), end, options)).toEqual(media)
    expect(paths).toEqual([`/v1/jobs/${wire.done.job_id}`, `/v1/jobs/${wire.done.job_id}/video`, `/v1/jobs/${wire.done.job_id}/video`])
  })

  it('rejects a foreign job identifier instead of following its media', async () => {
    let calls = 0
    const base = await serve((_request, response) => { calls++; sendJson(response, { ...job(), id: 'foreign', job_id: 'foreign' }) })
    await expect(readH3CanonicalJob(expected(base), options)).rejects.toMatchObject({ code: 'H3_CANONICAL_PROTOCOL_INVALID' })
    expect(calls).toBe(1)
  })

  it('rejects external returned media links without making a second request', async () => {
    let externalCalls = 0
    const other = await serve((_request, response) => { externalCalls++; response.end('external') })
    const base = await serve((_request, response) =>{  sendJson(response, { ...job(),
      video_url: `${other}/unowned/video`, file_url: 'file:///private/credentials' }) })
    await expect(readH3CanonicalJob(expected(base), options)).rejects.toMatchObject({ code: 'H3_CANONICAL_PROTOCOL_INVALID' })
    expect(externalCalls).toBe(0)
  })

  it.each([301, 302, 303, 307, 308])('rejects HTTP %s rather than following its Location', async (status) => {
    let targetCalls = 0
    const other = await serve((_request, response) => { targetCalls++; sendJson(response, wire.identity) })
    const base = await serve((_request, response) => { response.writeHead(status, { location: `${other}/private` }); response.end() })
    await expect(readH3CanonicalIdentity(base, options)).rejects.toMatchObject({ code: 'H3_CANONICAL_RESPONSE_INVALID' })
    expect(targetCalls).toBe(0)
  })

  it.each(['https://127.0.0.1', 'http://localhost', 'http://192.0.2.1', 'file:///private',
    'http://user:secret@127.0.0.1', 'http://127.0.0.1/custom', 'http://127.0.0.1?token=private',
    'http://127.0.0.1#private'])('refuses an origin with unowned addressing: %s', async (base) => {
    await expect(readH3CanonicalIdentity(base, options)).rejects.toMatchObject({ code: 'H3_CANONICAL_PROTOCOL_INVALID' })
  })

  it('accepts the exact 64KiB JSON byte limit including transport whitespace', async () => {
    const raw = Buffer.from(JSON.stringify(wire.identity))
    const body = Buffer.concat([raw, Buffer.alloc(64 * 1024 - raw.length, 32)])
    const base = await serve((_request, response) =>{  stream(response, body, 'application/json') })
    expect(await readH3CanonicalIdentity(base, options)).toEqual(parseH3CanonicalIdentity(wire.identity))
  })

  it('bounds UTF-8 streamed bytes even when character count and no Content-Length suggest a smaller body', async () => {
    const connection = connectionClose()
    const text = JSON.stringify({ ...job('running'), feedback: '中'.repeat(22_000) })
    expect(text.length).toBeLessThan(64 * 1024)
    expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024)
    const base = await serve((request, response) => { connection.watch(request); stream(response, Buffer.from(text), 'application/json') })
    await expect(readH3CanonicalJob(expected(base), options)).rejects.toMatchObject({ code: 'H3_CANONICAL_RESPONSE_TOO_LARGE' })
    await connection.closed
  })

  it('rejects an oversized declared JSON body before retaining its response bytes', async () => {
    const connection = connectionClose()
    const base = await serve((request, response) => { connection.watch(request); response.writeHead(200,
      { 'content-type': 'application/json', 'content-length': String(64 * 1024 + 1) }); response.flushHeaders() })
    await expect(readH3CanonicalIdentity(base, options)).rejects.toMatchObject({ code: 'H3_CANONICAL_RESPONSE_TOO_LARGE' })
    await connection.closed
  })

  it.each([Buffer.from([0xff, 0xfe]), Buffer.from('{not-json')])('rejects invalid JSON bytes without echoing them', async (body) => {
    const base = await serve((_request, response) =>{  stream(response, body, 'application/json') })
    await expect(readH3CanonicalIdentity(base, options)).rejects.toMatchObject({ code: 'H3_CANONICAL_RESPONSE_INVALID' })
  })

  it('accepts an exact 16MiB media stream with matching receipt bytes and SHA', async () => {
    const bytes = Buffer.alloc(16 * 1024 * 1024)
    bytes.write('ftyp', 4, 'ascii')
    const base = await serve((_request, response) =>{  stream(response, bytes, 'video/mp4') })
    const result = await readH3CanonicalMedia(expected(base), completed(base, bytes), options)
    expect(result.byteLength).toBe(bytes.byteLength)
    expect(result.equals(bytes)).toBe(true)
  })

  it('rejects streamed media beyond 16MiB before retaining an oversized result', async () => {
    const connection = connectionClose()
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 1)
    const base = await serve((request, response) => { connection.watch(request); stream(response, bytes, 'video/mp4') })
    await expect(readH3CanonicalMedia(expected(base), completed(base), options)).rejects.toMatchObject({ code: 'H3_CANONICAL_RESPONSE_TOO_LARGE' })
    await connection.closed
  })

  it('rejects an oversized declared media body', async () => {
    const connection = connectionClose()
    const base = await serve((request, response) => { connection.watch(request); response.writeHead(200,
      { 'content-type': 'video/mp4', 'content-length': String(16 * 1024 * 1024 + 1) }); response.flushHeaders() })
    await expect(readH3CanonicalMedia(expected(base), completed(base), options)).rejects.toMatchObject({ code: 'H3_CANONICAL_RESPONSE_TOO_LARGE' })
    await connection.closed
  })

  it.each(['size', 'hash', 'header'] as const)('rejects terminal media with a mismatched %s', async (changed) => {
    const bytes = Buffer.from(media)
    if (changed === 'hash') {
      const last = bytes.at(-1)
      if (last === undefined) throw new Error('fixture media missing')
      bytes[bytes.length - 1] = last ^ 1
    }
    if (changed === 'header') bytes.write('xxxx', 4)
    const body = changed === 'size' ? bytes.subarray(0, bytes.length - 1) : bytes
    const base = await serve((_request, response) =>{  stream(response, body, 'video/mp4') })
    await expect(readH3CanonicalMedia(expected(base), completed(base), options)).rejects.toMatchObject({ code: 'H3_CANONICAL_PROTOCOL_INVALID' })
  })

  it('rejects media from another operation before any GET', async () => {
    let calls = 0
    const base = await serve((_request, response) => { calls++; stream(response, media, 'video/mp4') })
    await expect(readH3CanonicalMedia(expected(base), { ...completed(base), jobId: 'other-operation' }, options))
      .rejects.toMatchObject({ code: 'H3_CANONICAL_REQUEST_INVALID' })
    expect(calls).toBe(0)
  })

  it.each([{ 'content-type': 'text/html' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' }])
  ('rejects unsupported content representation %j', async (headers) => {
    const base = await serve((_request, response) => { response.writeHead(200, headers); response.end('{}') })
    await expect(readH3CanonicalIdentity(base, options)).rejects.toMatchObject({ code: 'H3_CANONICAL_RESPONSE_INVALID' })
  })

  it('does not retry or echo a temporary server failure', async () => {
    let calls = 0
    const base = await serve((_request, response) => { calls++; response.writeHead(503); response.end('private token and local path') })
    await expect(readH3CanonicalIdentity(base, options)).rejects.toMatchObject({ message: 'H3_CANONICAL_RESPONSE_INVALID' })
    expect(calls).toBe(1)
  })

  it.each(['headers', 'body'] as const)('enforces the same deadline while awaiting %s', async (stalled) => {
    const connection = connectionClose()
    let calls = 0
    const base = await serve((request, response) => {
      connection.watch(request)
      calls++
      if (stalled === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{') }
    })
    await expect(readH3CanonicalIdentity(base, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'H3_CANONICAL_READ_TIMEOUT' })
    await connection.closed
    expect(calls).toBe(1)
  })

  it('honors already cancelled callers without contacting the server', async () => {
    let calls = 0
    const base = await serve((_request, response) => { calls++; sendJson(response, wire.identity) })
    await expect(readH3CanonicalIdentity(base, { ...options, signal: AbortSignal.abort('private reason') }))
      .rejects.toMatchObject({ code: 'H3_CANONICAL_READ_ABORTED', message: 'H3_CANONICAL_READ_ABORTED' })
    expect(calls).toBe(0)
  })

  it('cancels an actual streaming request without exposing its private abort reason', async () => {
    const connection = connectionClose()
    let seen: () => void = () => { throw new Error('fixture deferred missing') }
    const received = new Promise<void>((resolve) => { seen = resolve })
    const base = await serve((request, response) => {
      connection.watch(request)
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); seen()
    })
    const controller = new AbortController()
    const reading = readH3CanonicalIdentity(base, { ...options, signal: controller.signal })
    await Promise.all([
      expect(reading).rejects.toMatchObject({ code: 'H3_CANONICAL_READ_ABORTED', message: 'H3_CANONICAL_READ_ABORTED' }),
      received.then(() => { controller.abort('private reason') }),
    ])
    await connection.closed
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 180_001])('rejects an unbounded or invalid deadline %s', async (timeoutMs) => {
    let calls = 0
    const base = await serve((_request, response) => { calls++; sendJson(response, wire.identity) })
    await expect(readH3CanonicalIdentity(base, { timeoutMs })).rejects.toMatchObject({ code: 'H3_CANONICAL_REQUEST_INVALID' })
    expect(calls).toBe(0)
  })
})
