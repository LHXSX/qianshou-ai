/** Authenticated admin projection of Shanghai enterprise inquiries; synthetic HTTP only. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminService, API_PREFIX } from '../src/server.ts'
import type { AdminRecord, RoleRecord } from '../src/rbac.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function harness(permissions: string[] = ['enterprise.read'], scope: 'all' | 'self' = 'all') {
  const dir = await mkdtemp(join(tmpdir(), 'admin-enterprise-'))
  await mkdir(join(dir, 'home')); await mkdir(join(dir, 'web'))
  const calls: { url: string; method: string; headers: Headers }[] = []
  let upstreamStatus = 200
  const row = { id: 17, company: '测试公司', contact: '李女士', phone: '13800000000', size: '11-50', use_case: 'other', budget: '', source: 'beta-program-page', created_at: '2026-09-23T08:00:00+00:00', status: 'new', note: '测试需求', submitted_at: '2026-09-23T08:00:00+00:00', source_ip: '203.0.113.7', user_agent: 'test-browser', internal_secret: 'must-not-leak' }
  const service = createAdminService({
    dataDir: dir, webRoot: join(dir, 'web'), origin: 'https://admin.test', accountBaseUrl: 'https://shanghai.test',
    dshHome: join(dir, 'home'), tiersPath: join(dir, 'missing-tiers.ts'), trustProxy: false,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code })
      if (url.endsWith('/auth/login')) return json({ access_token: 'fixture-secret-access', refresh_token: 'fixture-secret-refresh', account: { id: '167', username: 'admin' } })
      if (url.endsWith('/auth/me')) return json({ account: { id: '167', username: 'admin' } })
      calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
      if (upstreamStatus !== 200) return json({ detail: 'private upstream detail' }, upstreamStatus)
      if (url.includes('/admin/enterprise/leads?')) return json({ ok: true, items: [row], total: 1 })
      if (url.endsWith('/admin/enterprise/leads/17')) return json({ ok: true, lead: row })
      return json({}, 404)
    },
  })
  const role: RoleRecord = { id: 'enterprise-test', name: 'enterprise-test', kind: 'custom', surface: 'ai-admin', description: '', permissions, scopeDefault: 'all' }
  const admin: AdminRecord = { accountId: '167', displayName: 'admin', roleId: role.id, scope, enabled: true, createdAt: 0, createdBy: 'fixture' }
  await service.components.roles.save({ version: 1, roles: [role] })
  await service.components.admins.save({ version: 1, admins: [admin] })
  const server = createServer((req, res) => { void service.handle(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${API_PREFIX}`
  const request = async (path: string, body: Record<string, unknown> = {}, cookie = '') => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://admin.test', cookie }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown>, cookie: response.headers.get('set-cookie') ?? '' }
  }
  const cookie = (await request('/session/login', { username: 'admin', password: 'fixture' })).cookie
  return { request, cookie, calls, setStatus: (value: number) => { upstreamStatus = value } }
}

describe('enterprise inquiry admin projection', () => {
  it('uses existing session bearer and exposes only allowlisted fields', async () => {
    const h = await harness()
    const list = await h.request('/enterprise/leads', { limit: 30, offset: 0, url: 'https://attacker.invalid' }, h.cookie)
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(1)
    expect(h.calls[0]?.url).toBe('https://shanghai.test/api/v8/admin/enterprise/leads?limit=30&offset=0')
    expect(h.calls[0]?.method).toBe('GET')
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer fixture-secret-access')
    expect(h.calls[0]?.headers.has('cookie')).toBe(false)
    expect(JSON.stringify(list.body)).not.toContain('internal_secret')
    expect(JSON.stringify(list.body)).not.toContain('source_ip')
    const detail = await h.request('/enterprise/lead', { id: 17 }, h.cookie)
    expect(detail.status).toBe(200)
    expect((detail.body.lead as Record<string, unknown>).note).toBe('测试需求')
    expect(JSON.stringify(detail.body)).not.toContain('must-not-leak')
  })

  it('requires login, enterprise permission and all-data scope before upstream', async () => {
    const h = await harness()
    expect((await h.request('/enterprise/leads')).status).toBe(401)
    expect(h.calls).toHaveLength(0)
    const noPermission = await harness(['payment.read'])
    expect((await noPermission.request('/enterprise/leads', {}, noPermission.cookie)).status).toBe(403)
    expect(noPermission.calls).toHaveLength(0)
    const self = await harness(['enterprise.read'], 'self')
    expect((await self.request('/enterprise/leads', {}, self.cookie)).status).toBe(403)
    expect(self.calls).toHaveLength(0)
  })

  it('rejects invalid parameters and reports Shanghai auth/deployment errors without PII', async () => {
    const h = await harness()
    for (const body of [{ limit: 101 }, { offset: -1 }, { limit: '30' }]) {
      expect((await h.request('/enterprise/leads', body, h.cookie)).status).toBe(400)
    }
    expect((await h.request('/enterprise/lead', { id: '../17' }, h.cookie)).status).toBe(400)
    expect(h.calls).toHaveLength(0)
    for (const [code, expected] of [[403, 403], [404, 404], [500, 502]] as const) {
      h.setStatus(code)
      const result = await h.request('/enterprise/leads', {}, h.cookie)
      expect(result.status).toBe(expected)
      expect(JSON.stringify(result.body)).not.toContain('private upstream detail')
    }
  })
})
