// @vitest-environment jsdom
/** Shared AccountClient and actual dialog against HTTP fixtures; no live account mutations. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountClient, createTokenStore, type Account } from '@deepseek-ai/dsh-client-account'
import { createAccountDialog } from '../src/components/account-dialog.ts'
import { createAccountReader } from '../src/components/account-profile.ts'
import { createCommerceReader } from '../src/components/account-commerce.ts'
const user = { id: 7, username: 'alice', email: 'a@example.test', role: 'user', status: 'active', balance: '23.50', created_at: null, last_login_at: null }
const records: { path: string; method: string; body: unknown; bearer: string | null }[] = []
let profile = { display_name: '昵称', phone: '', country: '中国', language: '简体中文' }
let fetcher: typeof fetch
let extra: ((path: string, init?: RequestInit) => Promise<Response | undefined>) | null
let walletFen = 5000
let subscriptionPhase: 'fulfilled' | 'fulfilling' | 'requires-review' = 'fulfilled'
let rechargeStatus: 'pending' | 'paid' | null = null
let rechargeAmount = '12.34'
const cnyQuote = { quoteId: 'QUOTE_HTTP_TEST', accountId: '7', tier: 'basic', label: '基础订阅', months: 1,
  currency: 'CNY', amountFen: 3900, amountYuan: '39.00', monthlySp: 390, expiresAt: '2099-09-20T00:00:00Z' }
const cnyWallet = () => ({ currency: 'CNY', balanceFen: walletFen, balanceYuan: (walletFen / 100).toFixed(2) })
const cnyOrder = () => ({ orderId: 'ORDER_HTTP_TEST', quoteId: cnyQuote.quoteId, accountId: '7', tier: 'basic', months: 1,
  currency: 'CNY', amountFen: 3900, amountYuan: '39.00', status: subscriptionPhase, paymentStatus: 'paid', canRetry: subscriptionPhase === 'requires-review',
  ...(subscriptionPhase === 'fulfilled' ? { subscription: { tier: 'basic', from: 1000, to: 2000 } } : {}) })
const rechargeOrder = () => ({ order_no: 'PAY_HTTP_TEST', account_id: 7, amount: rechargeAmount, currency: 'CNY', gateway: 'alipay',
  status: rechargeStatus, expired_at: '2099-09-20T10:15:00Z' })
const alipay = () => ({ mode: 'alipay_page', method: 'POST', action: 'https://openapi.alipay.com/gateway.do?charset=utf-8', params: {
  app_id: '2026000000000000', method: 'alipay.trade.page.pay', charset: 'utf-8', sign_type: 'RSA2', version: '1.0',
  timestamp: '2099-09-20 18:00:00', notify_url: 'https://qianshousuanli.com/api/v8/payment/notify/alipay', sign: 'A'.repeat(344),
  biz_content: JSON.stringify({ out_trade_no: 'PAY_HTTP_TEST', total_amount: rechargeAmount, subject: '千手账户充值', product_code: 'FAST_INSTANT_TRADE_PAY',
    passback_params: 'account_7', time_expire: '2099-09-20 18:15:00' }),
} })
const cleanups: (() => void)[] = []
function button(text: string): HTMLButtonElement {
  const value = [...document.querySelectorAll('button')].find(item => item.textContent === text)
  if (!value) throw new Error(`MISSING_BUTTON ${text}`)
  return value
}
function input(label: string): HTMLInputElement {
  const value = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!value) throw new Error(`MISSING_FIELD ${label}`)
  return value
}
function buttonsEnabled(form: HTMLFormElement | null): boolean { return form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === false }
function submit(label: string): void { button(label).closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }
async function harness(loggedIn = true, withCommerce = false) {
  let account: Account | null = null
  const client = createAccountClient({ baseUrl: window.location.origin, prefix: '/account-api/api/v8', fetch: fetcher, tokens: createTokenStore({ cookiesAvailable: false }) })
  if (loggedIn) { await client.login({ username: 'alice', password: 'not-real', remember_me: false }); account = await client.me() }
  const reader = createAccountReader({
    client, accountId: () => account === null ? null : String(account.id),
    fetch: fetcher, origin: window.location.origin, timeoutMs: 5000,
  })
  const commerce = withCommerce ? createCommerceReader({ client, accountId: () => account === null ? null : String(account.id),
    fetch: fetcher, origin: window.location.origin, timeoutMs: 5000 }) : undefined
  const dialog = document.createElement('dialog'); document.body.append(dialog)
  const notice = vi.fn()
  const component = createAccountDialog({
    client, reader, dialog, currentAccount: () => account, onAuthenticated: (value) => { account = value },
    onSignedOut: () => { account = null; component.sync() }, onNotice: notice, onConnections: vi.fn(),
    ...(commerce ? { commerce } : {}),
  })
  const off = client.subscribe((state) => { if (state !== 'authenticated') { account = null; component.sync() } })
  cleanups.push(() => { off(); component.dispose() })
  return { client, reader, commerce, component, dialog, notice, account: () => account, switchIdentity: () => { account = { ...user, id: 8, username: 'bob' }
    component.sync() } }
}
beforeEach(() => {
  records.length = 0
  extra = null
  walletFen = 5000; subscriptionPhase = 'fulfilled'; rechargeStatus = null; rechargeAmount = '12.34'
  localStorage.clear(); sessionStorage.clear()
  profile = { display_name: '昵称', phone: '', country: '中国', language: '简体中文' }
  document.body.replaceChildren()
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    records.push({ path, method: init?.method ?? 'GET', body, bearer: new Headers(init?.headers).get('authorization') })
    const special = await extra?.(path, init); if (special) return special
    if (path.endsWith('/auth/login')) return Response.json({ ok: true, access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, account: user })
    if (path.endsWith('/auth/register')) return Response.json({ ok: true, account: null })
    if (path.endsWith('/auth/me')) return Response.json({ ok: true, account: { ...user, balance: (walletFen / 100).toFixed(2) } })
    if (path === '/api/qianshou/ai/status') return Response.json({ ok: true, tier: { id: 'free', label: '免费版' },
      credit: { remainingSp: 1200, purchasableSp: 999999 }, plans: [{ id: 'basic', label: '基础订阅', monthlyYuan: 39, monthlySp: 390 }] })
    if (path.endsWith('/subscriptions/wallet')) return Response.json({ ok: true, wallet: cnyWallet() })
    if (path.endsWith('/subscriptions/quote')) return Response.json({ ok: true, quote: cnyQuote,
      wallet: { ...cnyWallet(), canPay: walletFen >= 3900, shortfallFen: Math.max(0, 3900 - walletFen) } })
    if (path.endsWith('/subscriptions/purchase') || path.includes('/subscriptions/orders/by-key/') || /^.*\/subscriptions\/orders\/[^/]+\/retry$/u.test(path)) {
      return Response.json({ ok: true, order: cnyOrder() }, { status: subscriptionPhase === 'fulfilled' ? 200 : 202 })
    }
    if (path.endsWith('/payment/channels')) return Response.json({ items: [{ gateway: 'alipay', mode: 'alipay_page', available: true }] })
    if (path.endsWith('/payment/recharge')) {
      rechargeStatus = 'pending'; rechargeAmount = String((body as { amount: unknown }).amount)
      return Response.json({ ...rechargeOrder(), payment: alipay() }, { status: 201 })
    }
    if (path.endsWith('/payment/orders')) return Response.json({ items: rechargeStatus === null ? [] : [rechargeOrder()] })
    if (path.endsWith('/payment/orders/PAY_HTTP_TEST/payment')) return Response.json({ ...rechargeOrder(), payment: alipay() })
    if (path.endsWith('/payment/orders/PAY_HTTP_TEST')) return Response.json(rechargeOrder())
    if (path.endsWith('/my/profile')) {
      if (init?.method === 'PUT') profile = { ...profile, ...body as object }
      return Response.json({ ok: true, user: { ...user, profile } })
    }
    if (path.endsWith('/auth/totp/status')) return Response.json({ ok: true, enabled: false, enabled_at: null })
    if (path.endsWith('/auth/totp/setup')) return Response.json({ ok: true, secret: 'EXAMPLESECRET', setup_token: 'private-setup', otpauth_uri: 'otpauth://totp/test', expires_in: 600 })
    if (path.endsWith('/auth/totp/confirm')) return Response.json({ ok: true, reauthentication_required: true })
    if (path.endsWith('/auth/sessions') && init?.method === 'GET') return Response.json({ ok: true, sessions: [
      { session_id: 'current', device_name: '当前浏览器', client_ip: '127.0.0.1', is_current: true, status: 'active', last_seen_at: '2026-09-19T00:00:00Z' },
      { session_id: 'other', device_name: '工作电脑', client_ip: '192.0.2.1', is_current: false, status: 'active' },
      { session_id: 'past', device_name: '旧手机', is_current: false, status: 'revoked' },
    ] })
    if (path.includes('/auth/sessions') || path.endsWith('/auth/logout')) return Response.json({ ok: true })
    throw new Error('UNEXPECTED_ACCOUNT_ENDPOINT')
  })
})

describe('Shanghai CNY commerce through actual account and page clients', () => {
  const selectBasic = async (): Promise<void> => {
    await vi.waitFor(() => { expect(button('查看并选择')).toBeDefined() }); button('查看并选择').click()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="account-cny-confirm"]')).not.toBeNull() })
  }
  it('requires an exact CNY quote and explicit payment, never legacy SP purchase', async () => {
    const h = await harness(true, true); h.component.open('commerce')
    await selectBasic()
    expect(records.find(row => row.path.endsWith('/subscriptions/wallet'))).toMatchObject({ method: 'GET', bearer: 'Bearer private-access' })
    expect(records.find(row => row.path.endsWith('/subscriptions/quote'))).toMatchObject({ method: 'POST', body: { tier: 'basic', months: 1 } })
    expect(h.dialog.textContent).toContain('账户余额 ¥50.00')
    expect(records.some(row => row.path.endsWith('/subscriptions/purchase'))).toBe(false)
    button('确认支付 ¥39.00').click(); button('确认支付 ¥39.00').click()
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('订阅已开通') })
    const purchases = records.filter(row => row.path.endsWith('/subscriptions/purchase'))
    expect(purchases).toHaveLength(1)
    expect(purchases[0]).toMatchObject({ method: 'POST', bearer: 'Bearer private-access',
      body: { quoteId: 'QUOTE_HTTP_TEST', idempotencyKey: expect.any(String) as unknown } })
    expect(Object.keys(purchases[0]!.body as object).sort()).toEqual(['idempotencyKey', 'quoteId'])
    expect(records.some(row => row.path === '/api/qianshou/ai/subscription/purchase')).toBe(false)
    expect(h.commerce?.subscription?.pending()).toBeNull()
    expect(h.dialog.textContent).not.toMatch(/private-access|private-refresh/)
  })
  it('keeps paid fulfilment pending and retries only the existing order after recovery', async () => {
    subscriptionPhase = 'fulfilling'
    const h = await harness(true, true); h.component.open('commerce'); await selectBasic()
    button('确认支付 ¥39.00').click()
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('权益正在确认') })
    expect(h.dialog.textContent).not.toContain('订阅已开通'); expect(h.commerce?.subscription?.pending()).not.toBeNull()
    const purchase = records.find(row => row.path.endsWith('/subscriptions/purchase'))!.body as { idempotencyKey: string }
    subscriptionPhase = 'requires-review'; button('查询进度').click()
    await vi.waitFor(() => { expect(button('继续开通')).toBeDefined() })
    expect(records.find(row => row.path.includes('/subscriptions/orders/by-key/'))).toMatchObject({ method: 'GET',
      path: `/account-api/api/v8/subscriptions/orders/by-key/${purchase.idempotencyKey}` })
    expect(h.dialog.textContent).not.toContain('订阅已开通')
    subscriptionPhase = 'fulfilled'; button('继续开通').click()
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('订阅已开通') })
    expect(records.filter(row => row.path.endsWith('/subscriptions/purchase'))).toHaveLength(1)
    expect(records.find(row => row.path.endsWith('/subscriptions/orders/ORDER_HTTP_TEST/retry'))).toMatchObject({ method: 'POST', body: {} })
    expect(h.commerce?.subscription?.pending()).toBeNull()
  })
  it('recovers a lost payment response by its persisted key after remount without another purchase', async () => {
    extra = async (path) => { if (path.endsWith('/subscriptions/purchase')) throw new TypeError('fixture response lost'); return undefined }
    const h = await harness(true, true); h.component.open('commerce'); await selectBasic()
    button('确认支付 ¥39.00').click()
    await vi.waitFor(() => { expect(button('查询这笔购买')).toBeDefined() })
    const previous = h.commerce?.subscription?.pending(); expect(previous?.key).toBeTruthy()
    expect(JSON.stringify(localStorage)).not.toMatch(/private-access|private-refresh/)
    h.component.dispose(); extra = null
    const next = await harness(true, true); next.component.open('commerce')
    expect(next.commerce?.subscription?.pending()?.key).toBe(previous?.key)
    button('有一笔购买待确认 · 查看进度').click()
    await vi.waitFor(() => { expect(next.dialog.textContent).toContain('订阅已开通') })
    expect(records.filter(row => row.path.endsWith('/subscriptions/purchase'))).toHaveLength(1)
    expect(records.some(row => row.method === 'GET' && row.path.endsWith(`/orders/by-key/${previous!.key}`))).toBe(true)
  })
  it('routes insufficient CNY to recharge and keeps the chosen tier until a new explicit quote', async () => {
    walletFen = 100
    const h = await harness(true, true); h.component.open('commerce'); await selectBasic()
    expect(h.dialog.textContent).toContain('还差 ¥38.00')
    expect([...h.dialog.querySelectorAll('button')].some(item => item.textContent === '确认支付 ¥39.00')).toBe(false)
    button('充值后继续购买').click()
    expect(h.dialog.dataset.accountPage).toBe('recharge')
    await vi.waitFor(() => { expect(input('充值金额')).toBeDefined(); expect(h.dialog.textContent).toContain('¥1.00') })
    button('返回订阅中心').click()
    expect(h.dialog.dataset.accountPage).toBe('commerce')
    expect(button('充值完成，继续确认订阅')).toBeDefined()
    expect(records.filter(row => row.path.endsWith('/subscriptions/quote'))).toHaveLength(1)
    walletFen = 5000; button('充值完成，继续确认订阅').click()
    await vi.waitFor(() => { expect(button('确认支付 ¥39.00')).toBeDefined() })
    expect(records.filter(row => row.path.endsWith('/subscriptions/quote')).map(row => row.body)).toEqual([{ tier: 'basic', months: 1 }, { tier: 'basic', months: 1 }])
    expect(records.some(row => row.path.endsWith('/subscriptions/purchase') || row.path.endsWith('/payment/recharge'))).toBe(false)
  })
  it('creates one recharge, recovers its parameters and only shows credited after the server changes status', async () => {
    const post = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    const h = await harness(true, true); h.component.open('recharge')
    await vi.waitFor(() => { expect(button('确认充值金额').disabled).toBe(false) })
    input('充值金额').value = '12.34'; submit('确认充值金额')
    expect(records.some(row => row.path.endsWith('/payment/recharge'))).toBe(false)
    submit('确认并创建订单')
    await vi.waitFor(() => { expect(button('前往支付宝支付')).toBeDefined() })
    expect(post).not.toHaveBeenCalled(); expect(h.dialog.textContent).not.toContain('已到账')
    expect(records.find(row => row.path.endsWith('/payment/recharge'))).toMatchObject({ method: 'POST', bearer: 'Bearer private-access',
      body: { amount: '12.34', gateway: 'alipay', remark: '' } })
    h.component.open('recharge')
    await vi.waitFor(() => { expect(button('重取原订单付款参数').disabled).toBe(false) }); button('重取原订单付款参数').click()
    await vi.waitFor(() => { expect(button('前往支付宝支付')).toBeDefined() }); button('前往支付宝支付').click()
    expect(post).toHaveBeenCalledOnce(); expect(h.dialog.textContent).not.toContain('已到账')
    expect(records.filter(row => row.path.endsWith('/payment/recharge'))).toHaveLength(1)
    expect(records.find(row => row.path.endsWith('/payment/orders/PAY_HTTP_TEST/payment'))).toMatchObject({ method: 'POST', body: {} })
    rechargeStatus = 'paid'; button('查询到账状态').click()
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('已到账') })
    expect(records.some(row => row.path.endsWith('/subscriptions/purchase'))).toBe(false)
    expect(JSON.stringify(sessionStorage)).not.toMatch(/private-access|private-refresh/)
  })
  it('rejects a late quote after identity switches without displaying the old checkout', async () => {
    let finish!: () => void
    const delay = new Promise<void>((resolve) => { finish = resolve })
    extra = async (path) => { if (path.endsWith('/subscriptions/quote')) await delay; return undefined }
    const h = await harness(true, true); h.component.open('commerce')
    await vi.waitFor(() => { expect(button('查看并选择')).toBeDefined() }); button('查看并选择').click()
    await vi.waitFor(() => { expect(records.some(row => row.path.endsWith('/subscriptions/quote'))).toBe(true) })
    h.switchIdentity(); expect(h.dialog.textContent).toBe(''); finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.dialog.textContent).toBe(''); expect(h.dialog.querySelector('[data-testid="account-cny-confirm"]')).toBeNull()
    expect(records.some(row => row.path.endsWith('/subscriptions/purchase'))).toBe(false)
  })
})
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks() })

describe('Shanghai account settings', () => {
  it('uses the real registration endpoint, returns to login, and keeps social placeholders honest', async () => {
    const h = await harness(false); h.component.open()
    button('微信号登录').click()
    expect(h.dialog.textContent).toContain('微信登录待配置，请先使用账号登录。')
    expect(h.dialog.querySelector('input[aria-label="密码"]')).not.toBeNull()
    button('注册账号').click()
    input('用户名（可选）').value = 'new-user'
    input('设置密码').value = 'new-password'
    input('确认密码').value = 'new-password'
    submit('提交注册')
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('注册请求已提交，请使用新账号登录。') })
    const registration = records.find(row => row.path.endsWith('/auth/register'))
    expect(registration?.method).toBe('POST')
    expect(registration?.body).toEqual({ password: 'new-password', username: 'new-user', remember_me: false })
    expect(h.account()).toBeNull()
    expect(h.client.tokens.readAccess()).toBeNull()
  })

  it('reads actual profile then submits only edits, with no fake account fields or stored secrets', async () => {
    const h = await harness(); h.component.open('settings'); button('个人资料').click()
    await vi.waitFor(() => { expect(input('显示名称').value).toBe('昵称') })
    expect(h.dialog.textContent).toContain('a@example.test')
    input('显示名称').value = '新的昵称'; submit('保存资料'); submit('保存资料')
    await vi.waitFor(() => { expect(h.notice).toHaveBeenCalledWith('资料已保存') })
    const writes = records.filter(row => row.path.endsWith('/my/profile') && row.method === 'PUT')
    expect(writes).toHaveLength(1); expect(writes[0]?.body).toEqual({ display_name: '新的昵称' })
    expect(records.filter(row => row.path.endsWith('/my/profile')).every(row => row.bearer === 'Bearer private-access')).toBe(true)
    expect(h.dialog.textContent).not.toMatch(/private-access|private-refresh/)
    expect(JSON.stringify(localStorage)).not.toMatch(/private-/)
  })
  it('preserves a dirty profile on service failure and never claims the update succeeded', async () => {
    const h = await harness(); h.component.open('settings'); button('个人资料').click(); await vi.waitFor(() => { expect(input('显示名称')).toBeDefined() })
    extra = async (path, init) => path.endsWith('/my/profile') && init?.method === 'PUT' ? Response.json({ ok: false }, { status: 503 }) : undefined
    input('显示名称').value = '未保存'; submit('保存资料')
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('服务暂时不可用') })
    expect(input('显示名称').value).toBe('未保存'); expect(h.notice).not.toHaveBeenCalled()
  })
  it('never offers current or revoked devices for individual revocation, and confirms other-device removal', async () => {
    const h = await harness(); h.component.open('sessions')
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('工作电脑') })
    expect([...h.dialog.querySelectorAll('.session-row')].map(row => [row.querySelector('strong')?.textContent, row.querySelector('span')?.textContent, row.querySelector('button')?.textContent ?? null])).toEqual([
      ['当前浏览器', '当前设备', null], ['工作电脑', '有效', '撤销此设备登录'], ['旧手机', '已撤销', null],
    ])
    button('撤销此设备登录').click(); expect(records.some(row => row.method === 'DELETE')).toBe(false)
    submit('确认撤销'); submit('确认撤销')
    await vi.waitFor(() => { expect(records.filter(row => row.method === 'DELETE')).toHaveLength(1) })
    expect(records.find(row => row.method === 'DELETE')?.path).toBe('/account-api/api/v8/auth/sessions/other')
  })
  it('updates password once and clears the current login because Shanghai revokes all sessions', async () => {
    const h = await harness(); h.component.open('security')
    await vi.waitFor(() => { expect(input('新密码')).toBeDefined() })
    const form = button('确认修改密码').closest('form')
    if (!form) throw new Error('MISSING_PASSWORD_FORM')
    const old = form.querySelector<HTMLInputElement>('[aria-label="当前密码"]'); if (!old) throw new Error('MISSING_OLD_PASSWORD')
    old.value = 'old-secret'
    input('新密码').value = 'new-secret'
    input('确认新密码').value = 'new-secret'
    input('确认新密码').dispatchEvent(new Event('input'))
    submit('确认修改密码'); submit('确认修改密码')
    await vi.waitFor(() => { expect(h.client.tokens.readAccess()).toBeNull() })
    expect(h.account()).toBeNull(); expect(h.dialog.open).toBe(false); expect(h.notice).toHaveBeenCalledWith('安全设置已更新，所有设备需重新登录。')
    expect(records.filter(row => row.path.endsWith('/auth/me') && row.method === 'PUT').map(row => row.body)).toEqual([{ password: 'new-secret', old_password: 'old-secret' }])
    expect(records.some(row => row.path.endsWith('/auth/refresh'))).toBe(false)
  })
  it('keeps TOTP setup token out of the DOM, confirms with the original token and requires fresh login', async () => {
    const h = await harness(); h.component.open('security')
    await vi.waitFor(() => { expect(button('设置二次验证')).toBeDefined() })
    input('当前密码').value = 'old-secret'; submit('设置二次验证')
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('EXAMPLESECRET') })
    expect(h.dialog.textContent).not.toContain('private-setup')
    input('动态验证码').value = '123456'; submit('确认开启并重新登录')
    await vi.waitFor(() => { expect(h.account()).toBeNull() })
    expect(records.find(row => row.path.endsWith('/auth/totp/confirm'))?.body).toEqual({ setup_token: 'private-setup', code: '123456' })
    expect(h.dialog.textContent).not.toContain('EXAMPLESECRET')
  })
  it('rejects a profile body arriving after identity changes and hides the old account immediately', async () => {
    const h = await harness(); let release!: () => void
    const delayed = new Promise<void>((resolve) => { release = resolve })
    extra = async (path) => {
      if (!path.endsWith('/my/profile')) return undefined
      return new Response(new ReadableStream({ async start(controller) { await delayed
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, user: { ...user, profile } })))
        controller.close() } }))
    }
    const read = h.reader.profile(new AbortController().signal)
    h.component.open(); h.switchIdentity()
    expect(h.dialog.open).toBe(false); expect(h.dialog.textContent).toBe('')
    release(); await expect(read).rejects.toThrow('ACCOUNT_CHANGED')
    await Promise.resolve(); expect(h.dialog.textContent).toBe('')
  })
  it('blocks a mismatched profile identity and failed sessions without fabricating empty data', async () => {
    const h = await harness()
    extra = async path => path.endsWith('/my/profile') ? Response.json({ ok: true, user: { ...user, id: 8, profile } }) : path.endsWith('/auth/sessions') ? Response.json({ ok: false }, { status: 503 }) : undefined
    h.component.open('settings'); button('个人资料').click()
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('服务暂时不可用') })
    expect(h.dialog.querySelector('.profile-form')).toBeNull()
    h.component.open('sessions'); await vi.waitFor(() => { expect(h.dialog.textContent).toContain('服务暂时不可用') })
    expect(h.dialog.textContent).not.toContain('服务器未返回登录设备')
  })
  it('does not clear a newly selected identity when an old password update finishes late', async () => {
    const h = await harness(); h.component.open('security')
    await vi.waitFor(() => { expect(input('新密码')).toBeDefined() })
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    extra = async (path, init) => {
      if (!path.endsWith('/auth/me') || init?.method !== 'PUT') return undefined
      await pending; return Response.json({ ok: true, reauthentication_required: true })
    }
    const form = button('确认修改密码').closest('form')
    const old = form?.querySelector<HTMLInputElement>('[aria-label="当前密码"]')
    if (!old) throw new Error('MISSING_PASSWORD_FORM')
    old.value = 'old-secret'; input('新密码').value = 'new-secret'; input('确认新密码').value = 'new-secret'
    input('确认新密码').dispatchEvent(new Event('input')); submit('确认修改密码')
    await vi.waitFor(() => { expect(records.some(row => row.method === 'PUT')).toBe(true) })
    h.switchIdentity()
    await h.client.tokens.write({ access_token: 'new-account-access', refresh_token: 'new-account-refresh', token_type: 'bearer', expires_in: 3600 })
    release()
    await vi.waitFor(() => { expect(buttonsEnabled(form)).toBe(true) })
    expect(h.account()?.username).toBe('bob'); expect(h.client.tokens.readAccess()).toBe('new-account-access')
    expect(records.some(row => row.path.endsWith('/auth/logout'))).toBe(false)
  })

  it('keeps password visibility local and handles logout transport rejection without restoring private UI', async () => {
    const h = await harness(false); h.component.open()
    const password = input('密码'); password.value = 'typed-secret'
    button('显示密码').click(); expect(password.type).toBe('text'); expect(password.value).toBe('typed-secret')
    expect(button('隐藏密码').getAttribute('aria-pressed')).toBe('true')
    button('隐藏密码').click(); expect(password.type).toBe('password')
    input('用户名或邮箱').value = 'alice'; submit('登录')
    await vi.waitFor(() => { expect(h.account()?.username).toBe('alice') })
    h.component.open(); vi.spyOn(h.client, 'logout').mockRejectedValueOnce(new Error('fixture-transport'))
    button('退出登录').click()
    await vi.waitFor(() => { expect(h.notice).toHaveBeenCalledWith('本页已退出；如网络中断，服务器撤销状态需在其他设备核查。') })
    expect(h.account()).toBeNull(); expect(h.dialog.textContent).toBe(''); expect(h.client.tokens.readAccess()).toBeNull()
  })

})
