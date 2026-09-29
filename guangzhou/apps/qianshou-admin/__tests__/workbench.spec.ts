/** The real account/subscription views and shared dialog, with deterministic local transport. */
import { createApp, nextTick, type App } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountView from '../src/views/AccountView.vue'
import SubscriptionView from '../src/views/SubscriptionView.vue'
import { clearSession, loadSession, session } from '../src/session/store'
import { onUnauthorized } from '../src/api/client'
let app: App | undefined
let permissions: string[] = []
let failure = 0
let deferred: ((response: Response) => void) | undefined
let delayPreview = false
let delayApply = false
const ref = '5e126930-74b0-47ac-b9e1-548169322a00'
const requests: { path: string; body: Record<string, unknown> }[] = []
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
const input = (label: string, value: string) => {
  const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`input[aria-label="${label}"],textarea[aria-label="${label}"]`)!
  node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }))
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
beforeEach(() => {
  clearSession(); requests.length = 0; failure = 0; deferred = undefined; delayPreview = false; delayApply = false
  permissions = ['account.read', 'account.charge.adjust', 'subscription.read', 'subscription.manage']
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = String(url); const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; requests.push({ path, body })
    if (path.endsWith('/session/me')) return response({ ok: true, admin: { accountId: '167', displayName: 'admin', roleId: 'super-admin', roleName: 'admin', roleKind: 'builtin', scope: 'all', surface: 'ai-admin' }, permissions, menu: [], readiness: [], clientIp: '127.0.0.1' })
    if (path.endsWith('/account/list')) return response({ ok: true, accounts: [{ accountId: 'customer-42', tier: 'free', remainingSp: 100 }], total: 1 })
    if (path.endsWith('/subscription/list')) return response({ ok: true, entries: [{ accountId: 'customer-42', tier: 'plus', from: 1000, to: 9999999999999, active: true }], total: 1 })
    if (path.endsWith('/subscription/tiers')) return response({ ok: true, source: 'fixture', tiers: [{ id: 'plus', label: 'Plus', monthlySp: 100 }] })
    if (path.endsWith('/preflight')) {
      if (delayPreview) return new Promise<Response>((resolve) => { deferred = resolve })
      if (failure === 401) return response({ ok: false, code: 'workbench_service_unauthorized', message: '工作台服务凭据无效' }, 401)
      return response({ ok: true, confirm: { token: 'fixture-confirm', expiresAt: Date.now() + 60000, diff: { before: { purchasableSp: 100 }, after: { ...body, tier: body.tier ?? 'free', ref } } } })
    }
    if (path.endsWith('/apply')) {
      if (delayApply) return new Promise<Response>((resolve) => { deferred = resolve })
      if (failure) return response({ ok: false, code: 'workbench_outcome_unknown', message: '保留原操作号核查' }, 502)
      return response({ ok: true, auditId: 'fixture-audit', result: { ref, created: true } })
    }
    if (path.endsWith('/check')) return response({ ok: true, ref, recorded: true, preview: { before: {}, after: body } })
    return response({ ok: true })
  }))
})
afterEach(() => { app?.unmount(); app = undefined; clearSession(); vi.unstubAllGlobals(); vi.restoreAllMocks(); onUnauthorized(() => {}) })
async function mount(subscription = false) {
  await loadSession(); app = createApp(subscription ? SubscriptionView : AccountView); app.use(ElementPlus); app.mount('#app')
  await vi.waitFor(() => expect(document.body.textContent).toContain('customer-42'))
  button(subscription ? '变更档位' : '异常扣费处理').click()
  await vi.waitFor(() => expect(document.querySelector('input[aria-label="目标账号"]')).not.toBeNull())
}
async function adjustment() {
  input('目标账号', 'customer-42'); input('SP 增量', '12.25'); input('操作原因', '账务工单已核实'); await nextTick()
  button('请求真实预览').click()
}
describe('SP and subscription management UI', () => {
  it('collects reason before preview and binds one normalized apply despite double clicks', async () => {
    await mount(); await adjustment()
    await vi.waitFor(() => expect(document.body.textContent).toContain(ref))
    delayApply = true; button('确认执行').click(); button('确认执行').click()
    await vi.waitFor(() => expect(requests.filter(row => row.path.endsWith('/apply'))).toHaveLength(1))
    expect(requests.find(row => row.path.endsWith('/apply'))!.body).toEqual({ accountId: 'customer-42', deltaSp: 12.25, bucket: 'recharge', reason: '账务工单已核实', tier: 'free', ref, before: { purchasableSp: 100 }, token: 'fixture-confirm' })
    deferred!(response({ ok: true, auditId: 'fixture', result: { ref, created: true } }))
    await vi.waitFor(() => expect(document.body.textContent).toContain('工作台已确认操作'))
    expect(button('确认执行').disabled).toBe(true)
  })
  it('requires explicit expiry and never silently supplies permanent or 30-day terms', async () => {
    await mount(true); input('操作原因', '订阅工单已核实'); await nextTick(); button('请求真实预览').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('请选择档位及明确的生效和到期时间'))
    expect(requests.some(row => row.path.endsWith('/preflight'))).toBe(false)
    input('生效时间', '2026-09-19T12:00'); input('到期时间', '2026-10-03T12:00'); await nextTick(); button('请求真实预览').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain(ref)); button('确认执行').click()
    await vi.waitFor(() => expect(requests.some(row => row.path.endsWith('/apply'))).toBe(true))
    expect(requests.find(row => row.path.endsWith('/apply'))!.body).toMatchObject({ accountId: 'customer-42', tier: 'plus', from: new Date('2026-09-19T12:00').getTime(), to: new Date('2026-10-03T12:00').getTime(), reason: '订阅工单已核实', ref })
  })
  it('preserves the original ref after uncertainty and checks it without another apply', async () => {
    await mount(); await adjustment(); await vi.waitFor(() => expect(document.body.textContent).toContain(ref))
    failure = 502; button('确认执行').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('当前不会自动重试'))
    expect(button('确认执行').disabled).toBe(true); expect(document.body.textContent).not.toContain('请稍后重试或联系账号服务')
    button('关闭').click(); await nextTick(); button('异常扣费处理').click(); await nextTick()
    expect(document.body.textContent).toContain(ref); expect(button('确认执行').disabled).toBe(true)
    expect(requests.filter(row => row.path.endsWith('/preflight'))).toHaveLength(1)
    button('核查同一操作').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('工作台已记录操作'))
    expect(requests.filter(row => row.path.endsWith('/apply'))).toHaveLength(1)
    expect(requests.find(row => row.path.endsWith('/check'))!.body.ref).toBe(ref)
  })
  it('recovers an uncertain operation across route remount without retaining a reusable confirmation', async () => {
    await mount(); await adjustment(); await vi.waitFor(() => expect(document.body.textContent).toContain(ref))
    failure = 502; button('确认执行').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('当前不会自动重试'))
    app!.unmount(); app = createApp(AccountView); app.use(ElementPlus); app.mount('#app')
    await vi.waitFor(() => expect(document.body.textContent).toContain('customer-42')); button('异常扣费处理').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain(ref))
    expect(button('确认执行').disabled).toBe(true); expect(document.body.textContent).toContain('当前只可核查原操作')
    button('核查同一操作').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('工作台已记录操作'))
    expect(requests.filter(row => row.path.endsWith('/apply'))).toHaveLength(1)
    expect(requests.filter(row => row.path.endsWith('/preflight'))).toHaveLength(1)
    expect(requests.find(row => row.path.endsWith('/check'))!.body).not.toHaveProperty('token')
  })
  it('clears an unresolved operation when the administrator logs out', async () => {
    await mount(); await adjustment(); await vi.waitFor(() => expect(document.body.textContent).toContain(ref))
    failure = 502; button('确认执行').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('当前不会自动重试'))
    clearSession(); await nextTick(); app!.unmount(); await loadSession()
    app = createApp(AccountView); app.use(ElementPlus); app.mount('#app')
    await vi.waitFor(() => expect(document.body.textContent).toContain('customer-42')); button('异常扣费处理').click(); await nextTick()
    expect(document.body.textContent).not.toContain(ref); expect(button('请求真实预览')).toBeDefined()
  })
  it('does not log the operator out for a service credential failure', async () => {
    const logout = vi.fn(); onUnauthorized(logout); await mount(); failure = 401; await adjustment()
    await vi.waitFor(() => expect(document.body.textContent).toContain('工作台服务凭据无效'))
    expect(logout).not.toHaveBeenCalled(); expect(session.admin?.accountId).toBe('167')
    expect(requests.some(row => row.path.endsWith('/apply'))).toBe(false)
  })
  it('discards late previews and private account data on identity change', async () => {
    await mount(); delayPreview = true; await adjustment(); await vi.waitFor(() => expect(deferred).toBeTypeOf('function'))
    clearSession(); await nextTick()
    deferred!(response({ ok: true, confirm: { token: 'late', expiresAt: Date.now() + 60000, diff: { before: {}, after: { ref, accountId: 'customer-42' } } } }))
    await nextTick(); await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.body.textContent).not.toContain(ref); expect(document.body.textContent).not.toContain('customer-42')
    expect(requests.some(row => row.path.endsWith('/apply'))).toBe(false)
  })
  it('hides both money entry points without their existing permissions', async () => {
    permissions = ['account.read', 'subscription.read']; await loadSession(); app = createApp(AccountView); app.use(ElementPlus); app.mount('#app')
    await vi.waitFor(() => expect(document.body.textContent).toContain('customer-42'))
    expect(document.body.textContent).not.toContain('异常扣费处理')
    app.unmount(); app = createApp(SubscriptionView); app.use(ElementPlus); app.mount('#app')
    await vi.waitFor(() => expect(document.body.textContent).toContain('customer-42')); expect(document.body.textContent).not.toContain('开通订阅'); expect(document.body.textContent).not.toContain('变更档位')
  })
})
