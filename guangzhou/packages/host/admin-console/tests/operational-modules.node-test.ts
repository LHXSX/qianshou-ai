/** Real HTTP and persisted content acceptance; all upstream credentials are isolated fixtures. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdminService, API_PREFIX } from '../src/server.ts'
import { createModelReadAuthorizer } from '../../model-gateway/src/service-admin-read-auth.ts'
import { createModelReadHttpRoute } from '../../model-gateway/src/model-read-http.ts'
import { createAiAdminRoutes } from '../../model-gateway/src/admin-routes.ts'

const serviceConfig = { baseUrl: 'http://127.0.0.1:7080', audience: 'fixture-workbench', keyId: 'fixture-key', credentialRef: 'FIXTURE_ADMIN_SERVICE' }
const key = 'a'.repeat(43)
const delegation = { ref: 'models-read-fixture-operation', _admin: { audience: serviceConfig.audience, operatorAccountId: '42', operatorRole: 'super-admin', operationId: 'models-read-fixture-operation' } }
const identity = { audience: serviceConfig.audience, keyId: serviceConfig.keyId, credentialRef: serviceConfig.credentialRef, scopes: ['models.read'] as const }
const request = (path = '/internal/models/names', body: unknown = delegation, token = key) => new Request('http://127.0.0.1' + path,
  { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-qianshou-service-key-id': serviceConfig.keyId }, body: JSON.stringify(body) })

test('model read identity refuses wrong scope, audience, key, write path and deleted credential', async () => {
  let current: string | null = key
  const authorise = createModelReadAuthorizer(identity, async () => current)
  assert.equal((await authorise(request())).ok, true)
  for (const incoming of [request('/internal/models/bind'), request('/internal/ledger/adjust'), request('/internal/models/names', { ...delegation, _admin: { ...delegation._admin, audience: 'other' } })]) {
    const denied = await authorise(incoming); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.response.status, 403)
  }
  const bad = await authorise(request('/internal/models/names', delegation, 'b'.repeat(43)))
  assert.equal(bad.ok, false); if (!bad.ok) assert.equal(bad.response.status, 401)
  current = null
  const removed = await authorise(request()); assert.equal(removed.ok, false); if (!removed.ok) assert.equal(removed.response.status, 401)
  assert.throws(() => createModelReadAuthorizer({ ...identity, scopes: ['ledger.adjust'] as never }, async () => key))
})

test('model HTTP directory carries real names and history through service auth without registering writes', async t => {
  const authorise = createModelReadAuthorizer(identity, async () => key)
  const route = createModelReadHttpRoute('/internal/models/names', async request => {
    const auth = await authorise(request); if (!auth.ok) return auth.response
    return createAiAdminRoutes({ routing: { names: () => [{ publishedName: 'fixture-name' }], historyOf: () => [{ backendKeys: ['fixture-backend'] }] } as never,
      authenticate: () => auth.principal }).names(request)
  })
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const response = await fetch(base + route.path, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'x-qianshou-service-key-id': identity.keyId }, body: JSON.stringify(delegation) })
  const body = await response.json() as { names: { history: unknown[] }[] }
  assert.equal(response.status, 200); assert.equal(body.names[0]!.history.length, 1)
  assert.equal((await fetch(base + route.path)).status, 405)
  assert.equal((await fetch(base + '/internal/models/bind', { method: 'POST' })).status, 404)
})

async function harness(t: { after: (fn: () => unknown) => void }, scope: 'all' | 'self' = 'all', permissions = ['models.read', 'discovery.read', 'order.read']) {
  const dir = await mkdtemp(join(tmpdir(), 'qs-admin-modules-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const home = join(dir, 'home'); await mkdir(home)
  await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  FIXTURE_ADMIN_SERVICE: ' + key + '\n', { mode: 0o600 })
  const calls: { url: string; headers: Headers; method: string; body: Record<string, unknown> }[] = []
  const authorise = createModelReadAuthorizer(identity, async () => key)
  const service = createAdminService({ dataDir: join(dir, 'data'), webRoot: join(dir, 'web'), origin: 'https://admin.fixture', accountBaseUrl: 'https://shanghai.fixture',
    dshHome: home, tiersPath: join(dir, 'missing-tiers.ts'), trustProxy: false, workbench: serviceConfig, fetch: async (input, init) => {
      const url = String(input), headers = new Headers(init?.headers), method = init?.method ?? 'GET', body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (url.endsWith('/auth/me')) return Response.json({ account: { id: 42, username: 'fixture-admin', role: 'admin' } })
      if (url.endsWith('/auth/login')) return Response.json({ account: { id: 42, username: 'fixture-admin' }, tokens: { access_token: 'fixture-shanghai-token', refresh_token: 'fixture-refresh' } })
      calls.push({ url, headers, method, body })
      if (url.endsWith('/internal/models/names')) {
        const auth = await authorise(new Request(url, { method, headers, body: JSON.stringify(body) }))
        if (!auth.ok) return auth.response
        return Response.json({ ok: true, names: [{ publishedName: 'fixture-model', history: [{ backendKeys: ['real-fixture-binding'] }] }], backends: [] })
      }
      if (url.includes('/admin/payment/orders?')) return Response.json({ ok: true, items: [{ order_no: 'fixture-order', account_id: 42, amount: '1.00', status: 'paid' }], total: 1 })
      return Response.json({ ok: false }, { status: 404 })
    } })
  await service.components.roles.save({ version: 1, roles: [{ id: 'fixture-reader', name: 'fixture reader', kind: 'custom', surface: 'ai-admin', permissions, scopeDefault: scope }] as never })
  await service.components.admins.save({ version: 1, admins: [{ accountId: '42', displayName: 'fixture-admin', roleId: 'fixture-reader', scope, enabled: true, createdAt: 0, updatedAt: 0 }] })
  await mkdir(join(dir, 'data'), { recursive: true })
  const topic = (id: string, official: boolean, category: string, pinned: boolean) => ({ id, official, category, pinned, visibility: 'visible', updatedAt: '2026-09-27T00:00:00Z', title: id })
  await writeFile(join(dir, 'data', 'community.json'), JSON.stringify({ version: 1, topics: [topic('official-event', true, 'activities', false), topic('pinned-help', false, 'help', true), topic('ordinary-help', false, 'help', false)], replies: [], reports: [{ id: 'open-report', status: 'open', createdAt: '' }, { id: 'resolved-report', status: 'dismissed', createdAt: '' }] }))
  const server = createServer((req, res) => { void service.handle(req, res) }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + API_PREFIX
  let cookie = ''
  const api = async (path: string, body: unknown = {}) => { const response = await fetch(base + path, { method: 'POST', headers: { origin: 'https://admin.fixture', 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, unknown>, cookie: response.headers.get('set-cookie') } }
  cookie = (await api('/session/login', { username: 'fixture-admin', password: 'isolated-fixture' })).cookie ?? ''
  assert.ok(cookie)
  return { api, calls }
}

test('three admin overview reads use real content owner and separate service/account credentials', async t => {
  const h = await harness(t)
  const models = await h.api('/models/overview', { operatorAccountId: 'attacker', url: 'https://attacker.invalid' }); assert.equal(models.status, 200)
  const mc = h.calls.find(row => row.url.endsWith('/internal/models/names'))!
  assert.equal(mc.headers.get('authorization'), 'Bearer ' + key); assert.equal(mc.headers.get('cookie'), null)
  assert.equal((mc.body['_admin'] as { operatorAccountId: string }).operatorAccountId, '42')
  const content = await h.api('/discovery/overview'); assert.equal(content.status, 200)
  assert.deepEqual((content.body['announcements'] as { id: string }[]).map(row => row.id), ['official-event'])
  assert.deepEqual((content.body['recommendations'] as { id: string }[]).map(row => row.id), ['pinned-help'])
  assert.deepEqual((content.body['reports'] as { id: string }[]).map(row => row.id), ['open-report'])
  const order = await h.api('/order/overview'); assert.equal(order.status, 200); assert.equal(order.body['total'], 1)
  const oc = h.calls.find(row => row.url.includes('/admin/payment/orders?'))!
  assert.equal(oc.method, 'GET'); assert.equal(oc.headers.get('authorization'), 'Bearer fixture-shanghai-token'); assert.equal(oc.headers.get('cookie'), null)
  assert.ok(h.calls.every(row => !row.url.includes('attacker')))
})

test('all three global reads keep existing RBAC and refuse self data scope before any upstream call', async t => {
  for (const setup of [{ scope: 'self' as const, permissions: ['models.read', 'discovery.read', 'order.read'] }, { scope: 'all' as const, permissions: ['account.read'] }]) {
    const h = await harness(t, setup.scope, setup.permissions)
    for (const key of ['models', 'discovery', 'order']) assert.equal((await h.api(`/${key}/overview`)).status, 403)
    assert.deepEqual(h.calls, [])
  }
})
