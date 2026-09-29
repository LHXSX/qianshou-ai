import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MediaNodeStore } from '../src/media-node-store.ts'
import { createMediaNodeRoutes } from '../src/media-node-http.ts'
import { createMediaExchangeHttp } from '../src/media-exchange-http.ts'
import { createPluginLicenseBearerVerifier } from '../src/plugin-license-bearer.ts'

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}` }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }

test('metadata-only carrier authenticates the real account and cannot route bytes or open formal readiness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-metadata-only-')); const accountToken = 'a'.repeat(40); const privateToken = 'm'.repeat(40)
  const calls = []; let forgedCode = false
  const account = createServer((req, res) => {
    if (req.url !== '/api/v8/auth/me' || req.headers.authorization !== `Bearer ${accountToken}`) { res.writeHead(401); res.end('{}'); return }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, account: { id: 123, role: 'personal' } }))
  })
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${privateToken}`)
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); calls.push({ path: req.url, body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/internal/media/install-manifest') {
      res.writeHead(503); res.end(JSON.stringify({ detail: { code: forgedCode ? 'PRIVATE_PATH_LEAK' : 'MEDIA_INSTALL_CATALOG_UNAVAILABLE',
        missing_integrations: ['reviewed_install_release_missing'], internal_path: '/do-not-forward/private-key' } })); return
    }
    assert.equal(req.url, '/internal/media/devices/qualification')
    res.end(JSON.stringify({ qualification: { key_id: 'fixture', payload: { profiles: [] }, signature: 'fixture-only' } }))
  })
  const accountOrigin = await listen(account); const metadataOrigin = await listen(upstream)
  const store = new MediaNodeStore({ path: join(dir, 'nodes.db'), heartbeatIntervalMs: 100, heartbeatTimeoutMs: 300 })
  const nodes = createMediaNodeRoutes({ store, mediaMetadata: createMediaExchangeHttp(metadataOrigin, async () => privateToken),
    verifyAccount: createPluginLicenseBearerVerifier({ accountApiOrigin: accountOrigin }), dispatchToken: async () => undefined, maxLongPollRequests: 1 })
  const server = createServer((req, res) => { const route = nodes.routes.find(r => r.path === req.url); if (route) void route.handler(req, res); else { res.writeHead(404); res.end() } })
  const origin = await listen(server)
  const post = async (path, body, token = accountToken) => {
    const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const body = { nonce: randomUUID(), deviceId: 'node-a', workerId: randomUUID(), mode: 'image', platform: 'darwin', arch: 'arm64', hardware: { gpu_name: 'Fixture MPS', vram_mb: 0, memory_mb: 24576 } }
  try {
    const missing = await post('/v1/media/install-manifest', body)
    assert.equal(missing.status, 503); assert.deepEqual(missing.body, { ok: false, code: 'MEDIA_INSTALL_CATALOG_UNAVAILABLE' })
    assert.equal(calls[0].body.accountId, 123)
    assert.equal((await post('/v1/media/install-manifest', { ...body, accountId: 7 })).status, 400)
    assert.equal((await post('/v1/media/install-manifest', body, 'bad'.repeat(16))).status, 401)
    const qualification = await post('/v1/media/devices/qualification', { nonce: body.nonce, deviceId: body.deviceId, workerId: body.workerId })
    assert.deepEqual(qualification.body.qualification.payload.profiles, [])
    assert.equal(calls[1].body.accountId, 123)
    assert.equal((await post('/v1/media/assets/ticket', {})).body.code, 'MEDIA_ASSETS_UNAVAILABLE')
    assert.equal((await post('/v1/nodes/media/result-ticket', {})).body.code, 'MEDIA_RESULT_UPLOAD_UNAVAILABLE')
    assert.equal((await post('/v1/nodes/media/order-current', {})).body.code, 'MEDIA_ORDER_CURRENT_UNAVAILABLE')
    assert.equal(calls.length, 2)
    assert.deepEqual(store.directory(), [])
    forgedCode = true
    assert.deepEqual((await post('/v1/media/install-manifest', body)).body, { ok: false, code: 'MEDIA_EXCHANGE_UNAVAILABLE' })
    assert.equal(JSON.stringify(missing.body).includes('private-key'), false)
    assert.throws(() => createMediaExchangeHttp('http://example.com', async () => privateToken), /MEDIA_EXCHANGE_ORIGIN_INVALID/)
  } finally { await nodes.close(); await close(server); await close(upstream); await close(account); rmSync(dir, { recursive: true, force: true }) }
})
