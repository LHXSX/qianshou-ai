/** Real Loader, authenticated carrier and HTTP control-plane fixture; no media execution. */
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import * as Sessions from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import * as ComputeCore from '../src/index.ts'
import { png, mp4 } from './fixtures/formal-media.ts'
import type { FormalMediaProfile } from '../src/formal-media-protocol.ts'

const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []
const profile: FormalMediaProfile = { profile_id: 'fixture.image.fast', profile_version: 1, capability: 'image', mode: 'text_to_image',
  quality: 'fast', orientation: 'landscape', width: 1024, height: 768, steps: 4, fps: null, allowed_seconds: [],
  input_roles: [], max_assets: 0, model_id: 'fixture-model', model_sha256: 'a'.repeat(64), workflow_id: 'fixture-workflow',
  workflow_sha256: 'b'.repeat(64), validation_receipt_sha256: 'c'.repeat(64), min_vram_mb: 8192,
  min_memory_mb: 16384, timeout_s: 600, price_version: 1, price_unit: 'image', unit_price_yuan: '2.00', min_charge_yuan: '0', enabled: true }
const input = () => ({ capability: 'image', mode: 'text_to_image', prompt: '原始描述不改写', negative_prompt: '',
  quality: 'fast', orientation: 'landscape', seconds: null, assets: [], profile_id: profile.profile_id, profile_version: 1 })
const post = (value: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
async function fixture() {
  const state = { ready: true, invalidProfile: false, owner: 7, losePost: false, posts: [] as Record<string, unknown>[],
    estimates: [] as Record<string, unknown>[], requests: new Map<string, string>(), gets: 0,
    assetTickets: [] as Record<string, unknown>[], uploads: 0, assetGets: 0, loseUpload: false, switchOwnerAtTicket: false,
    badTicket: false, assets: new Map<string, Record<string, unknown>>(), mediaGets: 0, deliveryAuth: '',
    resultMetadata: null as Record<string, unknown> | null, bytes: png(), badBytes: false,
    switchOwnerAtDelivery: false, settled: true, profiles: [profile] }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    const json = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (url.pathname === '/api/v8/auth/me') { json({ ok: true, account: { id: state.owner, username: 'fixture', role: 'user', status: 'active' } }); return }
    if (url.pathname === '/api/v8/economy/media-profiles') {
      json({ ok: true, billing_status: state.ready ? 'ready' : 'unavailable', profiles: state.profiles.map(p => ({ ...p,
        profile_version: state.invalidProfile ? '1' : p.profile_version })) }); return
    }
    if (url.pathname.startsWith('/api/v8/media/tasks')) {
      state.gets++
      const requestId = url.searchParams.get('request_id') ?? [...state.requests].find(([, id]) => url.pathname.endsWith('/' + id))?.[0]
      const id = requestId === undefined ? undefined : state.requests.get(requestId)
      if (id === undefined || requestId === undefined) { res.writeHead(404).end(); return }
      const result = state.resultMetadata
      const issued = Math.floor(Date.now() / 1000)
      const payload = result === null ? null : { schema: 'qianshou.media-view-grant.v1', audience: 'guangzhou-result-media',
        account_id: state.owner, task_id: id, asset_id: result.assetId, bucket: 'fixture-bucket', object_key: 'fixture/result',
        object_version_id: 'fixture-version', sha256: result.sha256, size_bytes: result.sizeBytes, content_type: result.contentType,
        result_finalized: true, media_attested: true, issued_at: issued, expires_at: issued + 60 }
      json({ ok: true, taskId: id, requestId, attemptId: null, leaseEpoch: null,
        status: result === null ? 'WAITING_FOR_WORKERS' : 'DONE', phase: result === null ? 'waiting' : 'settled',
        progress: null, elapsedSeconds: 10, resultMetadata: result,
        settlement: result === null || !state.settled ? null : { settled: true, billableResultRevision: result.resultRevision, ledgerReceiptId: `release:${id}` },
        viewerReceipt: payload === null || !state.settled ? null
          : Buffer.from(JSON.stringify({ key_id: 'fixture-view-key', payload, signature: 'fixture-view-signature' })).toString('base64url') }); return
    }
    if (url.pathname === '/media/result') {
      state.mediaGets++; state.deliveryAuth = req.headers.authorization ?? ''
      if (!state.deliveryAuth.startsWith('Bearer ') || url.searchParams.has('token')) { res.writeHead(403).end(); return }
      res.setHeader('content-type', String(state.resultMetadata?.contentType))
      res.setHeader('content-length', String(state.bytes.length))
      if (state.switchOwnerAtDelivery) state.owner = 8
      res.end(state.badBytes ? Buffer.alloc(state.bytes.length) : state.bytes); return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      if (url.pathname === '/v1/media/assets/upload') {
        state.uploads++
        const authorization = req.headers.authorization ?? ''
        const ticket = JSON.parse(Buffer.from(authorization.slice(7), 'base64url').toString()) as { payload: Record<string, unknown> }
        const payload = ticket.payload
        const bytes = Buffer.concat(chunks)
        expect(req.headers['content-type']).toBe(payload.content_type)
        expect(req.headers['content-length']).toBe(String(payload.size_bytes))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(payload.sha256)
        const asset = { asset_id: payload.assetId, object_key: payload.object_key, object_version_id: 'fixture-version',
          sha256: payload.sha256, size_bytes: payload.size_bytes, content_type: payload.content_type,
          retention_until: Math.floor(Date.now() / 1000) + 172800 }
        state.assets.set(String(payload.assetId), asset)
        if (state.loseUpload) { res.destroy(); return }
        json({ ok: true, status: 'registered', asset }); return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      if (url.pathname === '/v1/media/assets/ticket') {
        state.assetTickets.push(body)
        expect(req.headers.authorization).toBe('Bearer fixture-token')
        const issued = Math.floor(Date.now() / 1000)
        const payload = { schema: 'qianshou.formal-media-asset-upload.v1', purpose: 'qianshou:formal-media-asset-upload',
          accountId: state.owner, assetId: body.assetId, role: body.role, sha256: body.sha256, size_bytes: body.size_bytes,
          content_type: body.content_type, object_key: `v8/account-${state.owner}/media-assets/${String(body.assetId)}/input.png`,
          nonce: '35358556-2cdb-5f2f-9906-454d9e48ca0f', issued_at: issued, expires_at: issued + 300 }
        if (state.switchOwnerAtTicket) state.owner = 8
        json({ ok: true, assetId: body.assetId, ticket: { key_id: 'fixture-upload-key', payload, signature: 'fixture-signature' },
          upload_path: state.badTicket ? 'https://foreign.invalid/steal' : '/v1/media/assets/upload' }); return
      }
      if (url.pathname === '/v1/media/assets/status') {
        state.assetGets++
        expect(req.headers.authorization).toBe('Bearer fixture-token')
        const asset = state.assets.get(String(body.assetId))
        json(asset === undefined ? { ok: true, status: 'pending', assetId: body.assetId } : { ok: true, status: 'registered', asset }); return
      }
      if (url.pathname === '/api/v8/economy/estimate') {
        state.estimates.push(body)
        json({ ok: true, task_type: (body.spec as Record<string, unknown>).task_type,
          input_kind: 'params_only', currency: 'CNY', billing_mode: 'server_price',
          recommended_budget: '2.00', estimated_total: '2.00', balance_enough: true, quote_token: 'host-private-quote-token',
          quote_expires_at: Math.floor(Date.now() / 1000) + 300 }); return
      }
      if (url.pathname === '/api/v8/workloads') {
        state.posts.push(body)
        const requestId = String(body.request_id)
        const id = state.requests.get(requestId) ?? `fixture-task-${state.posts.length}`
        state.requests.set(requestId, id)
        if (state.losePost) { res.destroy(); return }
        json({ id, status: 'CREATED' }); return
      }
      res.writeHead(404).end()
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture missing port')
  const root = await mkdtemp(join(tmpdir(), 'formal-media-loader-')); roots.push(root)
  return { state, root, origin: `http://127.0.0.1:${address.port}` }
}
async function composition(upstream: Awaited<ReturnType<typeof fixture>>, gatewayOrigin = upstream.origin) {
  const routes = new Map<string, ConnectionFetchRoute>()
  const path = join(upstream.root, 'cordis.yml')
  vi.stubEnv('FORMAL_MEDIA_FIXTURE_TOKEN', 'fixture-token')
  const config = `    baseUrl: ${upstream.origin}\n`
    + (gatewayOrigin === '' ? '' : `    formalMediaGatewayOrigin: ${gatewayOrigin}\n`)
    + `    tokenEnv: FORMAL_MEDIA_FIXTURE_TOKEN\n    statePath: ${JSON.stringify(join(upstream.root, 'private', 'state.json'))}\n`
  await writeFile(path, "- name: formal-carrier\n- name: '@deepseek-ai/dsh-session'\n- name: '@deepseek-ai/dsh-compute-core'\n  config:\n" + config)
  const ctx = await boot('formal-media-fixture', path, undefined, (preparing) => {
    const modules: Record<string, unknown> = {
      '@deepseek-ai/dsh-session': Sessions, '@deepseek-ai/dsh-compute-core': ComputeCore,
      'formal-carrier': { name: 'formal-carrier', apply(scope: Context) {
        scope.provide('connection', { fetch: { register(route: ConnectionFetchRoute) {
          routes.set(route.path, route); return () => { routes.delete(route.path) }
        } } } as unknown as Context['connection'])
      } },
    }
    preparing.loader.internal = { version: 'v2', import: async (name: string) => {
      if (!(name in modules)) throw new Error('unexpected fixture import')
      return modules[name]
    } } as unknown as NonNullable<typeof preparing.loader.internal>
  })
  contexts.push(ctx)
  const first = ctx.sessions.prepare(Sessions.SessionId('original-session'), { meta: { cwd: upstream.root } })
  const other = ctx.sessions.prepare(Sessions.SessionId('other-session'), { meta: { cwd: upstream.root } })
  const leaveFirst = ctx.sessions.enter(first); ctx.sessions.announce(first)
  const leaveOther = ctx.sessions.enter(other); ctx.sessions.announce(other)
  const request = (route: string, init?: RequestInit) => {
    const url = new URL('/api/qianshou/compute/media/' + route, 'http://local-host')
    const handler = routes.get(url.pathname)
    if (handler === undefined) throw new Error('route not loaded')
    return handler.fetch(new Request(url, init))
  }
  return { ctx, request, close: async () => {
    leaveFirst(); leaveOther(); await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  } }
}
async function quote(app: Awaited<ReturnType<typeof composition>>, overrides = {}) {
  const requestId = randomUUID()
  const response = await app.request('quote', post({ requestId, sessionId: 'original-session', input: input(), ...overrides }))
  return { response, requestId, quote: await response.json() as Record<string, unknown> }
}
function confirmation(quote: Record<string, unknown>) {
  return { quoteId: quote.quoteId, requestId: quote.requestId, sessionId: quote.sessionId, amountYuan: quote.amountYuan }
}
it('keeps missing Guangzhou configuration closed before quoting or reserving a paid submission', async () => {
  const remote = await fixture(); const app = await composition(remote, '')
  const directory = await app.request('profiles')
  expect(await directory.json()).toMatchObject({ billing_status: 'ready' })
  const result = await quote(app)
  expect(result.response.status).toBe(503)
  expect(result.quote).toMatchObject({ error: { code: 'COMPUTE_MEDIA_DELIVERY_UNAVAILABLE' } })
  const confirmation = await app.request('confirm', post({ requestId: result.requestId, sessionId: 'original-session',
    quoteId: randomUUID(), amountYuan: '2.00' }))
  expect(confirmation.status).toBe(409)
  expect(await confirmation.json()).toMatchObject({ error: { code: 'COMPUTE_MEDIA_CONFIRM_NOT_STARTED' } })
  expect(remote.state.estimates).toEqual([])
  expect(remote.state.posts).toEqual([])
})
it('quotes the exact official ten-field input without submission or renderer credentials, then confirms once', async () => {
  const remote = await fixture(); const app = await composition(remote)
  const result = await quote(app)
  expect(result.response.status).toBe(200)
  expect(result.quote).toMatchObject({ amountYuan: '2.00', currency: 'CNY', input: input() })
  expect(JSON.stringify(result.quote)).not.toContain('host-private-quote-token')
  expect(remote.state.posts).toHaveLength(0)
  expect(remote.state.estimates).toEqual([{ spec: { task_type: 'image_generate', input_kind: 'params_only', media_input: input() } }])
  const body = confirmation(result.quote)
  const replies = await Promise.all([app.request('confirm', post(body)), app.request('confirm', post(body))])
  expect(replies.map(r => r.status)).toEqual([200, 200])
  expect(remote.state.posts).toHaveLength(1)
  expect(remote.state.posts[0]).toMatchObject({ request_id: result.requestId, budget: '2.00', quote_token: 'host-private-quote-token' })
  const state = await app.request(`state?requestId=${result.requestId}&sessionId=original-session`)
  expect(await state.json()).toMatchObject({ taskId: 'fixture-task-1', progress: null, phase: 'waiting', settlement: null })
  const saved = await readFile(join(remote.root, 'private', 'state.json.formal-media'), 'utf8')
  expect(saved).not.toMatch(/host-private|原始描述/u)
})
it('requires the same owner, Session, ticket and amount even when a submission is already cached', async () => {
  const remote = await fixture(); const app = await composition(remote); const result = await quote(app)
  const body = confirmation(result.quote)
  expect((await app.request('confirm', post({ ...body, amountYuan: '0' }))).status).toBe(409)
  expect((await app.request('confirm', post(body))).status).toBe(200)
  expect((await app.request('confirm', post({ ...body, sessionId: 'other-session' }))).status).toBe(409)
  expect((await app.request(`state?requestId=${result.requestId}&sessionId=other-session`)).status).toBe(404)
  remote.state.owner = 8
  expect((await app.request('confirm', post(body))).status).toBe(409)
  expect((await app.request(`state?requestId=${result.requestId}&sessionId=original-session`)).status).toBe(404)
  expect(remote.state.posts).toHaveLength(1)
})
it('restores a lost paid response through requestId GET after a real Loader restart without another POST', async () => {
  const remote = await fixture(); const app = await composition(remote); const result = await quote(app)
  remote.state.losePost = true
  expect((await app.request('confirm', post(confirmation(result.quote)))).status).toBe(409)
  expect((await app.request('confirm', post(confirmation(result.quote)))).status).toBe(409)
  await app.close()
  const restored = await composition(remote)
  const response = await restored.request(`state?requestId=${result.requestId}&sessionId=original-session`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ taskId: 'fixture-task-1', requestId: result.requestId })
  expect(remote.state.posts).toHaveLength(1)
})
it('rejects unavailable billing, a string profile version, hidden tariffs and an unavailable Session before submission', async () => {
  const remote = await fixture(); const app = await composition(remote)
  remote.state.ready = false
  expect((await quote(app)).response.status).toBe(503)
  remote.state.ready = true; remote.state.invalidProfile = true
  expect((await quote(app)).response.status).toBe(502)
  remote.state.invalidProfile = false
  expect((await quote(app, { input: { ...input(), unit_price_yuan: '0' } })).response.status).toBe(400)
  expect((await quote(app, { sessionId: 'unavailable-session' })).response.status).toBe(403)
  expect(remote.state.posts).toHaveLength(0)
})
function attachment(bytes = png()) {
  return { assetId: randomUUID(), sessionId: 'original-session', role: 'reference', mediaType: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }
}
it('registers one concurrent attachment directly in Guangzhou and persists only actor-bound identity and digest', async () => {
  const remote = await fixture(); const app = await composition(remote); const asset = attachment()
  const replies = await Promise.all([app.request('asset-upload', post(asset)), app.request('asset-upload', post(asset))])
  expect(replies.map(r => r.status)).toEqual([200, 200])
  expect(await replies[0]?.json()).toEqual({ assetId: asset.assetId, status: 'registered',
    asset: { asset_id: asset.assetId, sha256: asset.sha256, role: 'reference' } })
  expect(remote.state.assetTickets).toEqual([{ assetId: asset.assetId, role: 'reference', sha256: asset.sha256,
    size_bytes: Buffer.from(asset.data, 'base64').length, content_type: 'image/png' }])
  expect(remote.state.uploads).toBe(1); expect(remote.state.posts).toHaveLength(0)
  const saved = await readFile(join(remote.root, 'private', 'state.json.formal-media.assets'), 'utf8')
  expect(saved).toContain(asset.assetId)
  expect(saved).not.toMatch(/fixture-token|signature|object_key|base64|data|ticket/u)
  expect((await app.request('asset-status', post({ assetId: asset.assetId, sessionId: 'other-session' }))).status).toBe(404)
  expect(remote.state.assetGets).toBe(0)
  remote.state.owner = 8
  expect((await app.request('asset-status', post({ assetId: asset.assetId, sessionId: asset.sessionId }))).status).toBe(404)
  expect(remote.state.assetGets).toBe(0)
})
it('recovers an unknown upload response after Loader restart through original asset status without another ticket or upload', async () => {
  const remote = await fixture(); const app = await composition(remote); const asset = attachment()
  remote.state.loseUpload = true
  expect((await app.request('asset-upload', post(asset))).status).toBe(409)
  expect(remote.state.uploads).toBe(1)
  await app.close()
  const restored = await composition(remote)
  const status = await restored.request('asset-status', post({ assetId: asset.assetId, sessionId: asset.sessionId }))
  expect(await status.json()).toMatchObject({ assetId: asset.assetId, status: 'registered' })
  expect((await restored.request('asset-upload', post(asset))).status).toBe(200)
  expect(remote.state.assetTickets).toHaveLength(1); expect(remote.state.uploads).toBe(1)
  expect(remote.state.assetGets).toBe(2)
})
it('refuses a foreign upload URL, retains the unknown identifier and only queries it on a repeated explicit upload request', async () => {
  const remote = await fixture(); const app = await composition(remote); const asset = attachment()
  remote.state.badTicket = true
  expect((await app.request('asset-upload', post(asset))).status).toBe(409)
  expect((await app.request('asset-upload', post(asset))).status).toBe(200)
  expect(remote.state.assetTickets).toHaveLength(1); expect(remote.state.uploads).toBe(0)
  expect(remote.state.assetGets).toBe(1)
})
it('checks actor switching after a ticket and rejects hidden owner fields and corrupt bytes before any asset ticket', async () => {
  const remote = await fixture(); const app = await composition(remote); const asset = attachment()
  expect((await app.request('asset-upload', post({ ...asset, accountId: 9 }))).status).toBe(400)
  expect((await app.request('asset-upload', post({ ...asset, sha256: 'f'.repeat(64) }))).status).toBe(400)
  expect(remote.state.assetTickets).toHaveLength(0)
  remote.state.switchOwnerAtTicket = true
  expect((await app.request('asset-upload', post(asset))).status).toBe(409)
  expect(remote.state.uploads).toBe(0)
  expect((await app.request('asset-status', post({ assetId: asset.assetId, sessionId: asset.sessionId }))).status).toBe(404)
})
it('quotes only registered original Session references and keeps bytes and upload grants out of Shanghai', async () => {
  const remote = await fixture(); const app = await composition(remote); const asset = attachment()
  remote.state.profiles = [{ ...profile, mode: 'image_to_image', input_roles: ['reference'], max_assets: 1 }]
  const media = { ...input(), mode: 'image_to_image', assets: [{ asset_id: asset.assetId, sha256: asset.sha256, role: 'reference' }] }
  expect((await quote(app, { input: media })).response.status).toBe(409)
  expect(remote.state.estimates).toHaveLength(0)
  expect((await app.request('asset-upload', post(asset))).status).toBe(200)
  const result = await quote(app, { input: media })
  expect(result.response.status).toBe(200)
  expect(remote.state.estimates[0]).toEqual({ spec: { task_type: 'image_generate', input_kind: 'params_only', media_input: media } })
  expect(JSON.stringify(remote.state.estimates)).not.toMatch(/fixture-token|fixture-signature|base64|object_version/u)
})
async function settledFixture(capability: 'image' | 'video') {
  const remote = await fixture(); const app = await composition(remote)
  const video: FormalMediaProfile = { ...profile, profile_id: 'fixture.video.fast', capability: 'video', mode: 'text_to_video',
    width: 1344, height: 768, fps: 24, allowed_seconds: [5], price_unit: 'second' }
  if (capability === 'video') remote.state.profiles = [video]
  const result = await quote(app, { input: capability === 'image' ? input()
    : { ...input(), capability, mode: 'text_to_video', seconds: 5, profile_id: video.profile_id } })
  expect((await app.request('confirm', post(confirmation(result.quote)))).status).toBe(200)
  remote.state.bytes = capability === 'video' ? mp4() : png(1024, 768)
  remote.state.resultMetadata = { assetId: randomUUID(), capability,
    sha256: createHash('sha256').update(remote.state.bytes).digest('hex'), sizeBytes: remote.state.bytes.length,
    contentType: capability === 'video' ? 'video/mp4' : 'image/png', width: capability === 'video' ? 1344 : 1024,
    height: 768, fpsNum: capability === 'video' ? 24 : null, fpsDen: capability === 'video' ? 1 : null,
    secondsMs: capability === 'video' ? 5000 : null, resultRevision: 'd'.repeat(64) }
  const query = `?requestId=${result.requestId}&sessionId=original-session`
  return { remote, app, query }
}
it.each(['image', 'video'] as const)('delivers attested settled %s bytes using a private viewer Bearer and verifies the exact hash', async (capability) => {
  const { remote, app, query } = await settledFixture(capability)
  const state = await app.request('state' + query)
  const projected: unknown = await state.json()
  expect(projected).toMatchObject({ deliveryAvailable: true, pollIntervalMs: 1500 })
  expect(JSON.stringify(projected)).not.toMatch(/viewerReceipt|fixture-view-signature/u)
  const response = await app.request('result' + query)
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(remote.state.bytes)
  expect(response.headers.get('x-qianshou-sha256')).toBe(remote.state.resultMetadata?.sha256)
  expect(remote.state.deliveryAuth).toContain('Bearer ')
  expect(remote.state.deliveryAuth).not.toContain('fixture-token')
  expect(remote.state.mediaGets).toBe(1); expect(remote.state.posts).toHaveLength(1)
})
it('refuses a corrupted settled result and an owner switch during delivery without submitting or billing again', async () => {
  const { remote, app, query } = await settledFixture('video')
  remote.state.badBytes = true
  expect((await app.request('result' + query)).status).toBe(502)
  remote.state.badBytes = false; remote.state.switchOwnerAtDelivery = true
  expect((await app.request('result' + query)).status).toBe(409)
  expect(remote.state.posts).toHaveLength(1)
})
it('withholds delivery before settlement and refuses valid media with a mismatched frozen profile', async () => {
  const { remote, app, query } = await settledFixture('video')
  remote.state.settled = false
  expect((await app.request('result' + query)).status).toBe(503)
  expect(remote.state.mediaGets).toBe(0)
  remote.state.settled = true
  if (remote.state.resultMetadata === null) throw new Error('missing fixture metadata')
  remote.state.resultMetadata.width = 1024
  expect((await app.request('state' + query)).status).toBe(502)
  expect(remote.state.posts).toHaveLength(1)
})
it('requires a fresh official quote after a cold quoted card and stops profile changes before a paid POST', async () => {
  const remote = await fixture(); const first = await composition(remote); const old = await quote(first)
  await first.close()
  const app = await composition(remote)
  const rejected = await app.request('confirm', post(confirmation(old.quote)))
  expect(await rejected.json()).toEqual({ error: { code: 'COMPUTE_QUOTE_CONFIRMATION_INVALID' } })
  expect(remote.state.posts).toHaveLength(0)
  const refreshed = await quote(app, { requestId: old.requestId })
  expect(refreshed.response.status).toBe(200)
  remote.state.profiles = [{ ...profile, steps: 8 }]
  const changed = await app.request('confirm', post(confirmation(refreshed.quote)))
  expect(await changed.json()).toEqual({ error: { code: 'COMPUTE_MEDIA_CONFIRM_NOT_STARTED' } })
  expect(remote.state.posts).toHaveLength(0)
  const current = await quote(app, { requestId: old.requestId })
  expect((await app.request('confirm', post(confirmation(current.quote)))).status).toBe(200)
  expect(remote.state.posts).toHaveLength(1)
})
