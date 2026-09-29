import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { expect, it, vi } from 'vitest'
import { registerMarketplaceRoutes } from '../src/marketplace-routes.ts'
import { createMarketplaceUpstream } from '../src/marketplace-upstream.ts'
import type { Route, RouteContext } from '../src/server.ts'
const id = '5533b344-256b-44ce-8677-a3082f44d93e'
async function fixture(options: { delegated?: boolean; revision?: number; auditAvailable?: boolean; scope?: 'self' | 'all' } = {}) {
  const requests: Array<{ path: string; body?: object }> = []
  const item = { publication_id: id, owner_id: 167, name: '虚构旧测试', task_type: 'fictional', status: 'rejected',
    lifecycle: { state: 'active', archived: false, revision: 0, allowed_actions: ['archive'], blocking_reasons: [] } }
  const upstream = createMarketplaceUpstream({ baseUrl: 'https://fictional.invalid', fetch: vi.fn<typeof fetch>(async (url, init) => {
    const path = url instanceof URL ? url.pathname : typeof url === 'string' ? new URL(url).pathname : new URL(url.url).pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as object : undefined
    requests.push({ path, ...(body === undefined ? {} : { body }) })
    if (path.endsWith('/review-capabilities')) return Response.json({ schema: 'qianshou.market-review-capabilities.v1', account_id: 6, review_authorized: !options.delegated })
    if (path.endsWith('/managed')) return Response.json({ items: [item] })
    return Response.json({ ...item, lifecycle: { ...item.lifecycle, state: 'delisted', archived: true, revision: 1, allowed_actions: ['restore'] } })
  }) })
  const routes: Route[] = []
  const audit = vi.fn(async (draft: Parameters<Parameters<typeof registerMarketplaceRoutes>[0]['audit']>[0]) =>
    options.auditAvailable === false ? null : { ...draft, id: 'fixture-audit', at: 0 })
  registerMarketplaceRoutes({ route: route => { routes.push(route) }, upstream, audit })
  const request = new IncomingMessage(new Socket())
  const results: Array<{ status: number; value: unknown }> = []
  const ctx: RouteContext = { request, response: new ServerResponse(request), ip: '127.0.0.1', addressSource: 'socket', requestId: 'fixture',
    body: { publicationId: id, action: 'archive', expectedRevision: options.revision ?? 0, note: '管理员确认归档虚构测试', owner_id: 999 },
    admin: { accountId: '6', displayName: 'fixture', roleId: 'super-admin', scope: 'all', enabled: true, createdAt: 0, createdBy: 'fixture' },
    role: null, scope: options.scope ?? 'all', sessionToken: 'fictional-session',
    session: { accountId: '6', displayName: 'fixture', createdAt: 0, lastSeenAt: 0, expiresAt: 1, ip: '127.0.0.1', tokens: { access: 'fictional-access', refresh: null }, lastVerifiedAt: 0 },
    json: (status, value) => { results.push({ status, value }) } }
  const route = routes.find(row => row.path === '/market/order-publication/lifecycle')
  if (!route) throw new Error('missing route')
  await route.handler(ctx)
  return { requests, results, audit, route }
}
it('requires market.review and emits only current subject metadata after two audit writes', async () => {
  const f = await fixture(); expect(f.route.permission).toBe('market.review'); expect(f.route.mutating).toBe(true)
  expect(f.results[0]?.status).toBe(200); expect(f.audit).toHaveBeenCalledTimes(2)
  expect(f.requests.find(row => row.path.endsWith('/lifecycle'))?.body).toEqual({ action: 'archive', expected_revision: 0, note: '管理员确认归档虚构测试' })
})
it.each([{ delegated: true }, { scope: 'self' as const }])('never turns delegated/self visibility into moderation authority', async options => {
  const f = await fixture(options); expect(f.results[0]?.status).toBe(403)
  expect(f.requests.some(row => row.path.endsWith('/lifecycle'))).toBe(false)
})
it('rejects a captured stale revision before mutation', async () => {
  const f = await fixture({ revision: 1 }); expect(f.results[0]?.status).toBe(409)
  expect(f.requests.some(row => row.path.endsWith('/lifecycle'))).toBe(false)
})
it('requires a durable pre-audit before sending a write', async () => {
  const f = await fixture({ auditAvailable: false }); expect(f.results[0]?.status).toBe(503)
  expect(f.requests.some(row => row.path.endsWith('/lifecycle'))).toBe(false)
})
