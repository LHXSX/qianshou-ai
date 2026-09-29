/** Real admin HTTP pipeline and Shanghai-contract fixtures; never calls or changes production. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdminService, API_PREFIX } from '../src/server.ts'
import type { AdminRecord, RoleRecord } from '../src/rbac.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks() })
async function harness(options: { permissions?: string[]; scope?: 'self' | 'all' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'admin-payment-'))
  await mkdir(join(dir, 'home')); await mkdir(join(dir, 'web'))
  let status = 'pending'; let gateway = 'admin_manual'; let fail: number | 'network' | null = null; let withdrawStatus = 'pending'; let malformedWrite = false
  const calls: { url: string; body: Record<string, unknown> | undefined; headers: Headers; method: string }[] = []
  const row = () => ({ order_no: 'order-1', account_id: 42, amount: '10.25', currency: 'CNY', gateway, status, ledger_id: status === 'paid' ? 'ledger-1' : null, created_at: '2026-09-19', remark: 'fixture' })
  const wd = () => ({ request_no: 'withdraw-1', account_id: 42, amount: '8.00', currency: 'CNY', status: withdrawStatus, kyc_status: 'verified', created_at: '2026-09-19', payee_info: { kind: 'bank', account_no: '1234****5678' } })
  const service = createAdminService({ dataDir: dir, webRoot: join(dir, 'web'), origin: 'https://admin.test', accountBaseUrl: 'https://shanghai.test', dshHome: join(dir, 'home'), tiersPath: join(dir, 'missing-tiers.ts'), trustProxy: false,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      const headers = new Headers(init?.headers); const method = init?.method ?? 'GET'
      const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code })
      if (url.endsWith('/auth/login')) return json({ access_token: 'fixture-secret-access', refresh_token: 'fixture-secret-refresh', account: { id: '167', username: 'admin' } })
      if (url.endsWith('/auth/me')) return json({ account: { id: '167', username: 'admin' } })
      calls.push({ url, body, headers, method })
      if (fail === 'network') throw new Error('network fixture')
      if (fail !== null) return json({ ok: false, detail: 'private upstream secret' }, fail)
      if (url.includes('/admin/payment/orders?')) return json({ ok: true, items: [row()], total: 83, limit: 30, offset: 0 })
      if (url.endsWith('/admin/payment/orders/order-1')) return json(row())
      if (url.includes('/withdraw/pending?')) return json({ ok: true, items: [{ ...wd(), payee_info_full: { account_no: 'private-payee-number' } }], total: 1 })
      if (url.endsWith('/admin/payment/confirm')) { status = 'paid'; return json({ ok: true, order: row() }) }
      if (url.endsWith('/admin/users/42/recharge')) return json(malformedWrite ? { ok: true } : { ok: true, new_balance: 14.75 })
      if (url.endsWith('/withdraw/approve')) { withdrawStatus = 'approved'; return json({ ok: true, withdraw: wd() }) }
      if (url.endsWith('/withdraw/reject')) { withdrawStatus = 'rejected'; return json({ ok: true, withdraw: wd() }) }
      if (url.endsWith('/withdraw/mark_paid')) { withdrawStatus = 'paid'; return json({ ok: true, withdraw: wd() }) }
      return json({ ok: false }, 404)
    },
  })
  const roleId = options.permissions ? 'payment-test' : 'super-admin'
  const admin: AdminRecord = { accountId: '167', displayName: 'admin', roleId, scope: options.scope ?? 'all', enabled: true, createdAt: 0, createdBy: 'fixture' }
  await service.components.admins.save({ version: 1, admins: [admin] })
  if (options.permissions) {
    const role: RoleRecord = { id: roleId, name: roleId, kind: 'custom', surface: 'ai-admin', description: '', permissions: options.permissions, scopeDefault: 'all' }
    await service.components.roles.save({ version: 1, roles: [role] })
  }
  const server = createServer((req, res) => { void service.handle(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${API_PREFIX}`
  let cookie = ''
  const api = async (path: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://admin.test', cookie }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown>, cookie: response.headers.get('set-cookie') }
  }
  cookie = (await api('/session/login', { username: 'admin', password: 'fixture' })).cookie ?? ''
  return { service, api, calls, dir, state: (next: { status?: string; gateway?: string; fail?: number | 'network' | null; withdrawStatus?: string; malformedWrite?: boolean }) => {
    status = next.status ?? status; gateway = next.gateway ?? gateway; withdrawStatus = next.withdrawStatus ?? withdrawStatus
    if ('fail' in next) fail = next.fail ?? null
    malformedWrite = next.malformedWrite ?? malformedWrite
  } }
}
const confirm = { op: 'confirm', order_no: 'order-1', gateway_tx_id: 'MANUAL-VERIFIED' }
async function preview(h: Awaited<ReturnType<typeof harness>>, draft: Record<string, unknown> = confirm) {
  const response = await h.api('/payment/preflight', draft)
  expect(response.status).toBe(200)
  const confirm = response.body['confirm'] as { token: string; diff: { before: unknown } }
  return { ...draft, before: confirm.diff.before, token: confirm.token, reason: '工单核对通过' }
}

describe('Shanghai payment projection', () => {
  it('uses global admin pagination and only the server-side account bearer, masking full payee fields', async () => {
    const h = await harness()
    const response = await h.api('/payment/orders', { account_id: '42', offset: 30, limit: 30, url: 'https://attacker.invalid', access: 'browser-secret' })
    expect(response.status).toBe(200); expect(response.body.total).toBe(83)
    expect(h.calls[0]?.url).toBe('https://shanghai.test/api/v8/admin/payment/orders?limit=30&offset=30&account_id=42')
    expect(h.calls[0]?.headers.get('authorization')).toBe('Bearer fixture-secret-access')
    expect(h.calls[0]?.headers.has('cookie')).toBe(false)
    const queue = await h.api('/payment/withdrawals')
    expect(JSON.stringify(queue.body)).not.toContain('private-payee-number')
    expect(queue.body.items).toEqual([expect.objectContaining({ payee_info: { kind: 'bank', account_no: '1234****5678' } })])
  })
  it('separates payment permissions from credential and forbids self-scope platform reads', async () => {
    for (const options of [{ permissions: ['credential.read', 'credential.manage'] }, { permissions: ['payment.read', 'payment.manage'], scope: 'self' as const }]) {
      const h = await harness(options)
      expect((await h.api('/payment/orders')).status).toBe(403)
      expect((await h.api('/payment/preflight', confirm)).status).toBe(403)
      expect(h.calls).toEqual([])
    }
    const h = await harness({ permissions: ['payment.read'] })
    expect((await h.api('/payment/orders')).status).toBe(200)
    expect((await h.api('/payment/preflight', confirm)).status).toBe(403)
  })
  it('binds before-state and payload, confirms once, and records reason without credentials', async () => {
    const h = await harness(); const draft = await preview(h)
    expect(h.calls.every(call => call.method === 'GET')).toBe(true)
    const responses = await Promise.all([h.api('/payment/apply', draft), h.api('/payment/apply', draft)])
    expect(responses.map(row => row.status).sort()).toEqual([200, 409])
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    const audit = await readFile(join(h.dir, 'audit.jsonl'), 'utf8')
    expect(audit).toContain('payment.confirm.apply'); expect(audit).toContain('工单核对通过')
    expect(audit).not.toMatch(/fixture-secret|private-payee/)
  })
  it('rejects altered confirmation payload, changed upstream state and automatic-channel manual confirmation', async () => {
    const h = await harness(); const draft = await preview(h)
    expect((await h.api('/payment/apply', { ...draft, gateway_tx_id: 'different' })).status).toBe(409)
    const fresh = await preview(h); h.state({ status: 'paid' })
    expect((await h.api('/payment/apply', fresh)).status).toBe(409)
    h.state({ status: 'pending', gateway: 'alipay' })
    expect((await h.api('/payment/preflight', confirm)).status).toBe(409)
    expect(h.calls.some(call => call.method === 'POST')).toBe(false)
  })
  it('executes manual recharge with exact decimal text and reason, but never automatically retries uncertain writes', async () => {
    const h = await harness(); const draft = await preview(h, { op: 'recharge', account_id: '42', amount: '10.25' })
    const done = await h.api('/payment/apply', draft)
    expect(done.status).toBe(200); expect(done.body.result).toEqual({ new_balance: 14.75 })
    expect(h.calls[0]?.body).toEqual({ amount: '10.25', reason: '工单核对通过' })
    const another = await preview(h, { op: 'recharge', account_id: '42', amount: '1.00' })
    h.state({ fail: 'network' })
    const failed = await h.api('/payment/apply', another)
    expect(failed.status).toBe(502)
    expect(failed.body).toEqual(JSON.parse(readFileSync(new URL('./expected/payment-write-unknown.json', import.meta.url), 'utf8')) as unknown)
    expect((await h.api('/payment/apply', another)).status).toBe(409)
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(2)
  })
  it('forwards review reason but gates paid registration until Shanghai money review', async () => {
    const h = await harness()
    expect((await h.api('/payment/preflight', { op: 'mark_paid', request_no: 'withdraw-1', paid_tx_id: 'tx' })).status).toBe(503)
    const draft = await preview(h, { op: 'approve', request_no: 'withdraw-1' })
    expect((await h.api('/payment/apply', draft)).status).toBe(200)
    expect(h.calls.find(call => call.url.endsWith('/withdraw/approve'))?.body).toEqual({ request_no: 'withdraw-1', note: '工单核对通过' })
    const blocked = await h.api('/payment/apply', { op: 'mark_paid', request_no: 'withdraw-1', paid_tx_id: 'bank-tx-1', token: 'cannot-bypass-gate' })
    expect(blocked.status).toBe(503); expect(blocked.body.code).toBe('payment_withdrawal_gate')
    expect(h.calls.some(call => call.url.endsWith('/withdraw/mark_paid'))).toBe(false)
  })
  it('fails explicitly for unavailable, forbidden and undeployed queries without fake empty orders', async () => {
    const h = await harness()
    for (const [fail, expected] of [[401, 401], [403, 403], [404, 404], [500, 502]] as const) {
      h.state({ fail }); const response = await h.api('/payment/orders')
      expect(response.status).toBe(expected); expect(response.body.items).toBeUndefined()
      if (fail === 401) expect(response.body.code).toBe('payment_session_required')
      if (fail === 403) expect(response.body.code).toBe('payment_upstream_forbidden')
      expect(JSON.stringify(response.body)).not.toContain('private upstream secret')
    }
  })
  it('refuses money writes when the intent audit cannot be persisted', async () => {
    const h = await harness(); const draft = await preview(h, { op: 'recharge', account_id: '42', amount: '1.00' })
    vi.spyOn(h.service.components.audit, 'record').mockRejectedValue(new Error('fixture audit disk unavailable'))
    const response = await h.api('/payment/apply', draft)
    expect(response.status).toBe(503); expect(response.body.code).toBe('payment_audit_unavailable')
    expect(h.calls.some(call => call.method === 'POST')).toBe(false)
  })
  it('reports malformed success as an unknown outcome rather than completed money movement', async () => {
    const h = await harness(); const draft = await preview(h, { op: 'recharge', account_id: '42', amount: '1.00' })
    h.state({ malformedWrite: true })
    const response = await h.api('/payment/apply', draft)
    expect(response.status).toBe(502); expect(response.body.code).toBe('payment_outcome_unknown')
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect((await h.api('/payment/apply', draft)).status).toBe(409)
  })
  it('rejects unsafe amounts and unsupported money operations before requesting Shanghai', async () => {
    const h = await harness()
    for (const amount of ['0', '-1', '1.001', 'Infinity', '1e4']) expect((await h.api('/payment/preflight', { op: 'recharge', account_id: '42', amount })).status).toBe(400)
    expect((await h.api('/payment/preflight', { op: 'refund', order_no: 'order-1' })).status).toBe(400)
    expect(h.calls).toEqual([])
  })
})
