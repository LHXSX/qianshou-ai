/** Actual console HTTP -> native credential resolver -> actual gateway service authorization/ledger. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdminService, API_PREFIX } from '../src/server.ts'
import { createWorkbenchUpstream } from '../src/workbench-upstream.ts'
import { createInternalAdminRoutes } from '../../model-gateway/src/internal-admin-routes.ts'
import { createServiceAdminAuthorizer } from '../../model-gateway/src/service-admin-auth.ts'
import { createCreditLedger } from '../../model-gateway/src/ledger.ts'
import { createTierStore } from '../../model-gateway/src/tier-store.ts'
import type { AdminRecord, RoleRecord } from '../src/rbac.ts'
const key = 'fixture_service_key_012345678901234567890123456789'
const refName = 'QIANSHOU_ADMIN_WORKBENCH_KEY_V1'
const config = { baseUrl: 'http://127.0.0.1:7080', audience: 'fixture-workbench', keyId: 'v1', credentialRef: refName }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function harness(options: { permissions?: string[]; scope?: 'self' | 'all' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'admin-workbench-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const home = join(dir, 'home'); await mkdir(home); await mkdir(join(dir, 'web'))
  const credentials = join(home, '.credentials.yaml')
  await writeFile(credentials, `version: 1\nrefs:\n  ${refName}: ${key}\n`, { mode: 0o600 })
  const ledger = createCreditLedger(); const store = createTierStore()
  let acceptedKey = key; let failure: number | null = null; let failFlush = false; let malformed = false
  const calls: { url: string; body: Record<string, unknown>; headers: Headers; redirect: RequestRedirect | undefined }[] = []
  const host = vi.fn(() => ({ accountId: 'UNRELATED-HOST', role: 'admin', isAdmin: true }))
  const routes = createInternalAdminRoutes({ ledger, store, authenticate: host,
    serviceAuthorise: createServiceAdminAuthorizer({ config: { audience: config.audience, keys: [{ id: config.keyId, credentialRef: refName, scopes: ['ledger.adjust', 'subscription.grant'] }] }, resolve: async () => acceptedKey }),
    flushLedger: async () => { if (failFlush) throw new Error('fixture disk') }, flushSubscriptions: async () => { if (failFlush) throw new Error('fixture disk') },
  })
  const service = createAdminService({ dataDir: dir, webRoot: join(dir, 'web'), origin: 'https://admin.test', accountBaseUrl: 'https://shanghai.test', dshHome: home, tiersPath: join(dir, 'missing-tiers.ts'), trustProxy: false, workbench: config,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; const json = (body: unknown, status = 200) => Response.json(body, { status })
      if (url.endsWith('/auth/login')) return json({ access_token: 'fixture-account-secret', refresh_token: 'fixture-account-refresh', account: { id: '167', username: 'admin' } })
      if (url.endsWith('/auth/me')) return json({ account: { id: '167', username: 'admin' } })
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>; const headers = new Headers(init?.headers)
      calls.push({ url, body, headers, redirect: init?.redirect })
      if (failure !== null) return json({ ok: false, detail: 'PRIVATE-FAILURE-BODY' }, failure)
      if (malformed) return json({ ok: true, ref: body['ref'], preview: { before: {}, after: { ...body, accountId: 'unrelated' } } })
      const request = new Request(url, init)
      if (url.endsWith('/internal/ledger/adjust')) return routes.adjustLedger(request)
      if (url.endsWith('/internal/subscriptions/grant')) return routes.grantSubscription(request)
      return json({ ok: false }, 404)
    },
  })
  const roleId = options.permissions ? 'workbench-test' : 'super-admin'
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
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://admin.test', cookie }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown>, cookie: response.headers.get('set-cookie') }
  }
  cookie = (await api('/session/login', { username: 'admin', password: 'fixture' })).cookie ?? ''
  return { service, api, calls, dir, credentials, ledger, store, host,
    state: (next: { acceptedKey?: string; failure?: number | null; failFlush?: boolean; malformed?: boolean }) => {
      acceptedKey = next.acceptedKey ?? acceptedKey; if ('failure' in next) failure = next.failure ?? null; failFlush = next.failFlush ?? failFlush; malformed = next.malformed ?? malformed
    } }
}
const adjustment = { accountId: 'customer-42', deltaSp: 12.25, bucket: 'recharge', reason: '工单核对通过' }
const subscription = { accountId: 'customer-42', tier: 'plus', from: 1000, to: 9999999999999, reason: '订阅申请已核查' }
async function preview(h: Awaited<ReturnType<typeof harness>>, body: Record<string, unknown> = adjustment, prefix = '/account/adjustment'): Promise<Record<string, unknown>> {
  const result = await h.api(`${prefix}/preflight`, body)
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  const confirm = result.body['confirm'] as { token: string; diff: { before: unknown; after: Record<string, unknown> } }
  return { ...confirm.diff.after, before: confirm.diff.before, token: confirm.token }
}
describe('workbench management service integration', () => {
  it('previews real balance then submits once with normalized payload and verified operator', async () => {
    const h = await harness(); h.ledger.recordCreditAdjustment({ accountId: 'customer-42', tier: 'free', bucket: 'recharge', sp: 100, reason: 'fixture', grantedBy: 'fixture' })
    const draft = await preview(h, { ...adjustment, _admin: { operatorAccountId: 'attacker' }, url: 'https://attacker.invalid' })
    expect(draft['before']).toMatchObject({ purchasableSp: 100 }); expect(draft['tier']).toBe('free'); expect(h.ledger.purchasableOf('customer-42').totalSp).toBe(100)
    const results = await Promise.all([h.api('/account/adjustment/apply', draft), h.api('/account/adjustment/apply', draft)])
    expect(results.map(row => row.status).sort()).toEqual([200, 409]); expect(h.ledger.purchasableOf('customer-42').totalSp).toBe(112.25)
    expect(h.calls).toHaveLength(2)
    const call = h.calls[1]!; expect(call.url).toBe('http://127.0.0.1:7080/internal/ledger/adjust'); expect(call.redirect).toBe('error')
    expect(call.headers.get('authorization')).toBe(`Bearer ${key}`); expect(call.headers.has('cookie')).toBe(false); expect(call.headers.has('origin')).toBe(false); expect(call.headers.has('sec-fetch-site')).toBe(false)
    expect(call.body['_admin']).toEqual({ audience: config.audience, operatorAccountId: '167', operatorRole: 'super-admin', operationId: draft['ref'] })
    expect(call.body['dryRun']).toBeUndefined(); expect(h.host).not.toHaveBeenCalled()
    const audit = await readFile(join(h.dir, 'audit.jsonl'), 'utf8'); expect(audit).toContain('ledger.adjust.apply'); expect(audit).toContain(String(draft['ref'])); expect(audit).not.toContain(key); expect(audit).not.toContain('fixture-account-secret')
  })
  it('binds the reason, delta and before-state to one confirmation without money on tampering', async () => {
    const h = await harness()
    for (const changed of [{ reason: '其他原因不可替换' }, { deltaSp: 99 }, { before: {} }]) {
      const draft = await preview(h); expect((await h.api('/account/adjustment/apply', { ...draft, ...changed })).status).toBe(409)
    }
    expect(h.ledger.creditAdjustmentsOf('customer-42')).toEqual([]); expect(h.calls.every(row => row.body['dryRun'] === true)).toBe(true)
  })
  it('uses existing dedicated permissions and all scope, never credential permissions', async () => {
    for (const options of [{ permissions: ['credential.manage'] }, { permissions: ['account.charge.adjust', 'subscription.manage'], scope: 'self' as const }]) {
      const h = await harness(options)
      expect((await h.api('/account/adjustment/preflight', adjustment)).status).toBe(403)
      expect((await h.api('/subscription/manage/preflight', subscription)).status).toBe(403); expect(h.calls).toEqual([])
    }
  })
  it('requires explicit subscription expiry and applies the exact normalized dates once', async () => {
    const h = await harness(); const { to, ...missing } = subscription; void to
    expect((await h.api('/subscription/manage/preflight', missing)).status).toBe(400)
    const draft = await preview(h, subscription, '/subscription/manage')
    expect(h.store.historyOf('customer-42')).toEqual([])
    expect((await h.api('/subscription/manage/apply', draft)).status).toBe(200)
    expect(h.store.historyOf('customer-42')).toEqual([expect.objectContaining({ tier: 'plus', from: subscription.from, to: subscription.to, grantedBy: '167', ref: draft['ref'] })])
    expect((await h.api('/subscription/manage/check', draft)).body.recorded).toBe(true)
    expect(h.store.historyOf('customer-42')).toHaveLength(1)
  })
  it('distinguishes service credential 401 from scope 403 and never leaks upstream bodies', async () => {
    const h = await harness()
    for (const failure of [401, 403]) {
      h.state({ failure }); const result = await h.api('/account/adjustment/preflight', adjustment)
      expect(result.status).toBe(failure); expect(result.body.code).toBe(failure === 401 ? 'workbench_service_unauthorized' : 'workbench_service_forbidden')
      expect(JSON.stringify(result.body)).not.toContain('PRIVATE'); expect((await h.api('/session/me')).status).toBe(200)
    }
  })
  it('resolves rotation from current owner-only refs and fails on unsafe mode or environment ambiguity', async () => {
    const h = await harness(); const rotated = `${key}_rotated`
    await preview(h); await writeFile(h.credentials, `version: 1\nrefs:\n  ${refName}: ${rotated}\n`); h.state({ acceptedKey: rotated })
    await preview(h); expect(h.calls.at(-1)?.headers.get('authorization')).toBe(`Bearer ${rotated}`)
    await chmod(h.credentials, 0o644); expect((await h.api('/account/adjustment/preflight', adjustment)).status).toBe(503)
    await chmod(h.credentials, 0o600); vi.stubEnv(refName, key); expect((await h.api('/account/adjustment/preflight', adjustment)).status).toBe(503)
    expect(h.calls).toHaveLength(2)
  })
  it('does not retry an uncertain persisted operation; same-ref check cannot create another adjustment', async () => {
    const h = await harness(); const draft = await preview(h); h.state({ failFlush: true })
    const failed = await h.api('/account/adjustment/apply', draft)
    expect(failed.status).toBe(502); expect(failed.body['ref']).toBe(draft['ref'])
    expect({ ...failed.body, ref: '<operation-ref>' }).toEqual(JSON.parse(readFileSync(new URL('./expected/workbench-write-unknown.json', import.meta.url), 'utf8')) as unknown)
    expect(h.ledger.creditAdjustmentsOf('customer-42')).toHaveLength(1)
    expect((await h.api('/account/adjustment/apply', draft)).status).toBe(409)
    h.state({ failFlush: false }); const checked = await h.api('/account/adjustment/check', draft)
    expect(checked.status).toBe(200); expect(checked.body.recorded).toBe(true)
    expect(h.ledger.creditAdjustmentsOf('customer-42')).toHaveLength(1); expect(h.calls.filter(row => row.body['dryRun'] !== true)).toHaveLength(1)
  })
  it('refuses malformed owner preview and cannot write without an intent audit', async () => {
    const h = await harness(); h.state({ malformed: true })
    expect((await h.api('/account/adjustment/preflight', adjustment)).status).toBe(502)
    h.state({ malformed: false }); const draft = await preview(h)
    vi.spyOn(h.service.components.audit, 'record').mockRejectedValue(new Error('fixture disk unavailable'))
    expect((await h.api('/account/adjustment/apply', draft)).status).toBe(503)
    expect(h.ledger.creditAdjustmentsOf('customer-42')).toEqual([])
  })
  it('rejects unsafe service origins before any credentials can be sent', () => {
    for (const baseUrl of ['http://public.example', 'https://user:secret@host', 'https://host/path', 'https://host/?token=anything']) expect(() => createWorkbenchUpstream({ config: { ...config, baseUrl }, dshHome: '/unused' })).toThrow()
  })
})
