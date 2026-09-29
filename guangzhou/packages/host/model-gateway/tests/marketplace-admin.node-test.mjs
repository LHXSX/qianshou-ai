import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMarketplaceAdminRoute } from '../src/marketplace-admin.ts'

const request = body => new Request('http://localhost/api/qianshou/ai/admin/marketplace', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
})

test('only an online-verified admin may reach Shanghai', async () => {
  let calls = 0
  const make = principal => createMarketplaceAdminRoute({
    apiOrigin: 'https://shanghai.example',
    authenticate: async () => principal,
    accessToken: async () => 'session-token',
    fetcher: async () => { calls++; return Response.json({ items: [] }) },
  })
  assert.equal((await make(null)(request({ action: 'list' }))).status, 401)
  assert.equal((await make({ accountId: '2', role: 'personal', isAdmin: false })(request({ action: 'list' }))).status, 403)
  assert.equal(calls, 0)
})

test('fixed Shanghai path gets server-held bearer and explicit review note', async () => {
  let target, options
  const handler = createMarketplaceAdminRoute({
    apiOrigin: 'https://shanghai.example',
    authenticate: async () => ({ accountId: '1', role: 'admin', isAdmin: true }),
    accessToken: async () => 'session-token',
    fetcher: async (url, init) => { target = url; options = init; return Response.json({ status: 'published' }) },
  })
  const response = await handler(request({ action: 'approve', appId: 12, note: 'HTTPS page checked' }))
  assert.equal(response.status, 200)
  assert.equal(target, 'https://shanghai.example/api/v8/admin/marketplace/review/12')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers.authorization, 'Bearer session-token')
  assert.deepEqual(JSON.parse(options.body), { action: 'approve', note: 'HTTPS page checked' })
  assert.deepEqual(await response.json(), { ok: true, result: { status: 'published' } })
  assert.equal((await handler(request({ action: 'reject', appId: 12, note: '' }))).status, 400)
})

test('origin is fixed and cannot embed credentials or non-loopback HTTP', () => {
  const deps = { authenticate: async () => null, accessToken: async () => null }
  assert.throws(() => createMarketplaceAdminRoute({ ...deps, apiOrigin: 'http://shanghai.example' }), /INVALID/)
  assert.throws(() => createMarketplaceAdminRoute({ ...deps, apiOrigin: 'https://host.example/path' }), /INVALID/)
  assert.throws(() => createMarketplaceAdminRoute({ ...deps, apiOrigin: 'https://user:pass@host.example' }), /INVALID/)
})
