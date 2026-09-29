/** Real OrderView, API and confirmation binding; local HTTP fixtures only. */
import { createApp, nextTick, type App } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderView from '../src/views/OrderView.vue'
import { clearSession, loadSession } from '../src/session/store'
import { paymentConfirmation } from '../src/api/modules/payments'
let app: App | undefined
let permissions = ['payment.read', 'payment.manage']
let fail = false
const requests: { path: string; body: Record<string, unknown> }[] = []
const order = { order_no: 'order-fixture', account_id: 42, amount: '10.25', currency: 'CNY', gateway: 'admin_manual', status: 'pending', created_at: '2026-09-19' }
const button = (text: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
const input = (label: string, value: string) => {
  const node = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }))
}
beforeEach(() => {
  clearSession(); requests.length = 0; permissions = ['payment.read', 'payment.manage']; fail = false
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = String(url); const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; requests.push({ path, body })
    let data: unknown = { ok: true }; let status = 200
    if (path.endsWith('/session/me')) data = { ok: true, admin: { accountId: '167', displayName: 'admin', roleId: 'super-admin', roleName: 'admin', roleKind: 'builtin', scope: 'all', surface: 'ai-admin' }, permissions, menu: [], readiness: [], clientIp: '127.0.0.1' }
    if (path.endsWith('/payment/orders')) { data = { ok: true, items: [order], total: 61, limit: 30, offset: body.offset }; if (fail) { data = { ok: false, code: 'payment_unavailable', message: '上海支付查询暂不可用' }; status = 502 } }
    if (path.endsWith('/payment/order')) data = { ok: true, order }
    if (path.endsWith('/payment/withdrawals')) data = { ok: true, items: [], total: 0, limit: 200 }
    if (path.endsWith('/payment/preflight')) data = { ok: true, confirm: { token: 'fixture-token', expiresAt: Date.now() + 60_000, diff: { before: { account_id: '42', balance: null }, after: body } } }
    if (path.endsWith('/payment/apply')) data = { ok: true, auditId: 'audit-fixture', result: { new_balance: 20.25 } }
    return new Response(JSON.stringify(data), { status })
  }))
})
afterEach(() => { app?.unmount(); app = undefined; clearSession(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function mount() {
  await loadSession(); app = createApp(OrderView); app.use(ElementPlus); app.mount('#app')
  await vi.waitFor(() => expect(document.body.textContent).toContain('order-fixture'))
}
describe('payment management UI', () => {
  it('renders global money and pages through the actual admin read routes', async () => {
    await mount(); expect(document.body.textContent).toContain('10.25'); expect(document.body.textContent).toContain('CNY')
    button('下一页').click()
    await vi.waitFor(() => expect(requests.filter(row => row.path.endsWith('/payment/orders')).at(-1)?.body.offset).toBe(30))
    button('详情').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('订单 order-fixture'))
    expect(requests.some(row => row.path.endsWith('/payment/order') && row.body.order_no === 'order-fixture')).toBe(true)
  })
  it('submits one frozen manual recharge with before-state and operator reason', async () => {
    await mount(); input('充值账号 ID', '42'); input('充值金额', '10.25'); await nextTick(); button('预览充值').click()
    await vi.waitFor(() => expect(requests.some(row => row.path.endsWith('/payment/preflight'))).toBe(true))
    await vi.waitFor(() => expect(document.querySelector('.el-dialog textarea')).not.toBeNull())
    const reason = document.querySelector<HTMLTextAreaElement>('.el-dialog textarea')!
    reason.value = '用户工单已核实'; reason.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    const apply = button('确认执行'); apply.click(); apply.click()
    await vi.waitFor(() => expect(requests.filter(row => row.path.endsWith('/payment/apply'))).toHaveLength(1))
    expect(requests.find(row => row.path.endsWith('/payment/apply'))!.body).toEqual({ op: 'recharge', account_id: '42', amount: '10.25', before: { account_id: '42', balance: null }, token: 'fixture-token', reason: '用户工单已核实' })
    await vi.waitFor(() => expect(document.body.textContent).toContain('20.25'))
  })
  it('shows query failure distinctly and clears account data on logout', async () => {
    await mount(); fail = true; button('查询').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('上海支付查询暂不可用'))
    expect(document.body.textContent).not.toContain('order-fixture'); expect(document.body.textContent).not.toContain('当前查询没有订单')
    clearSession(); await nextTick(); expect(document.body.textContent).not.toContain('手动充值')
  })
  it('hides financial writes without payment.manage', async () => {
    permissions = ['payment.read']; await mount(); expect(document.body.textContent).not.toContain('手动充值')
  })
  it('does not reuse a confirmation or retry after transport failure', async () => {
    const draft = { op: 'recharge' as const, account_id: '42', amount: '10.25' }
    const operation = paymentConfirmation(draft); const preview = await operation.preflight(); draft.amount = '999'
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'))
    await expect(operation.apply(preview.token, '核查账本原因')).rejects.toThrow()
    await expect(operation.apply(preview.token, '核查账本原因')).rejects.toThrow('请重新预览')
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body).toContain('"amount":"10.25"')
  })
})
