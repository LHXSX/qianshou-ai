// @vitest-environment jsdom
/** Full account routes preserve actual financial and identity boundaries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTokenStore, type Account, type AccountClient } from '@deepseek-ai/dsh-client-account'
import { createAccountDialog } from '../src/components/account-dialog.ts'
import type { CommerceReader } from '../src/components/account-commerce.ts'
import { SubscriptionFailure, type CnyQuote, type CnyOrder, type CnySubscriptionClient } from '../src/components/account-subscription-client.ts'
import type { RechargeClient } from '../src/components/account-recharge-client.ts'
const account: Account = { id: 7, username: 'alice', email: 'alice@example.test', role: 'user', status: 'active', balance: null, created_at: null, last_login_at: null }
const status = { tierId: 'free', tierLabel: '免费版', remainingSp: 1200, purchasableSp: 5000, spPerYuanCost: 100,
  plans: [{ id: 'basic', label: '基础版', monthlyYuan: 39, monthlySp: 390 }] }
const quote: CnyQuote = { quoteId: 'QUOTE_TEST', accountId: '7', tier: 'basic', label: '基础版', months: 1, currency: 'CNY',
  amountFen: 3900, amountYuan: '39.00', monthlySp: 390, expiresAt: '2099-09-20T00:00:00Z' }
const fulfilled: CnyOrder = { orderId: 'ORDER-TEST', quoteId: quote.quoteId, accountId: '7', tier: 'basic', months: 1,
  currency: 'CNY', amountFen: 3900, amountYuan: '39.00', paymentStatus: 'paid', status: 'fulfilled', canRetry: false,
  subscription: { tier: 'basic', from: 1000, to: 2000 } }
function subscription(overrides: Partial<CnySubscriptionClient> = {}): CnySubscriptionClient {
  const wallet = { currency: 'CNY' as const, balanceFen: 5000, balanceYuan: '50.00' }
  return { wallet: vi.fn(async () => wallet), quote: vi.fn(async () => ({ quote, wallet: { ...wallet, canPay: true, shortfallFen: 0 } })),
    purchase: vi.fn(async () => fulfilled), pending: () => null, recover: vi.fn(async () => null),
    retry: vi.fn(async () => fulfilled), ...overrides }
}
function recharge(available = true): RechargeClient {
  return { accountId: () => '7', snapshot: () => ({ order: null, unknown: false, locked: false }),
    load: vi.fn(async () => ({ balance: '50.00', channels: { alipay: { available, reason: available ? null : '商户待配置' }, wechat_pay: { available: false, reason: null } } })),
    refresh: vi.fn(async () => ({ order: null, unknown: false, locked: false })), create: vi.fn(), payment: vi.fn() }
}
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach((fn) =>{  fn() }); document.body.replaceChildren(); localStorage.clear() })
function harness(commerce?: CommerceReader) {
  const page = document.createElement('section'); page.hidden = true
  let owner: Account | null = account
  const reader = { profile: vi.fn(async () => ({ display_name: 'Alice', phone: null, language: '简体中文', country: '中国' })), sessions: vi.fn(async () => []) }
  const client = { tokens: createTokenStore({ cookiesAvailable: false }), logout: vi.fn(async () => true) } as unknown as AccountClient
  const onOpen = vi.fn(); const onClose = vi.fn()
  const component = createAccountDialog({ client, dialog: page, reader, currentAccount: () => owner,
    onAuthenticated: vi.fn(), onSignedOut: vi.fn(), onNotice: vi.fn(), onOpen, onClose,
    connections: () => [{ label: '账号服务', value: '已连接上海' }], ...(commerce ? { commerce } : {}) })
  document.body.append(page); cleanups.push(component.dispose)
  const click = (label: string) => {
    const button = [...page.querySelectorAll('button')].find(item => item.textContent === label)
    if (!button) throw new Error(`Missing button: ${label}`)
    button.click()
  }
  return { page, component, onOpen, onClose, click, switchAccount: () => { owner = { ...account, id: 8, username: 'bob' }; component.sync() } }
}
describe('application account pages', () => {
  it('opens a full section with identity, compact quota and vertical navigation, then returns to conversation', () => {
    const h = harness(); h.component.open()
    expect(h.page.hidden).toBe(false); expect(h.onOpen).toHaveBeenCalledTimes(1)
    expect(h.page.dataset.accountPage).toBe('home')
    expect(h.page.querySelector('[data-testid="account-overview"]')).not.toBeNull()
    expect(h.page.querySelector('.account-avatar')?.textContent).toBe('ae')
    expect(h.page.querySelector('[data-testid="account-quota"]')).not.toBeNull()
    expect(h.page.querySelector('[data-testid="account-commerce"]')).toBeNull()
    expect(h.page.querySelector('[role="tablist"]')).toBeNull()
    h.click('个人设置'); expect(h.page.dataset.accountPage).toBe('settings')
    h.click('连接状态'); expect(h.page.textContent).toContain('已连接上海')
    h.page.querySelector<HTMLButtonElement>('.account-back')!.click()
    expect(h.page.dataset.accountPage).toBe('settings')
    h.page.querySelector<HTMLButtonElement>('.account-back')!.click()
    expect(h.page.dataset.accountPage).toBe('home')
    h.page.querySelector<HTMLButtonElement>('.account-back')!.click()
    expect(h.page.hidden).toBe(true); expect(h.onClose).toHaveBeenCalledTimes(1)
  })
  it('puts profile editing on its own page without a collapsed form or horizontal tabs', async () => {
    const h = harness(); h.component.open(); h.click('个人资料')
    await vi.waitFor(() =>{  expect(h.page.querySelector<HTMLInputElement>('[aria-label="显示名称"]')?.value).toBe('Alice') })
    expect(h.page.querySelector('details')).toBeNull(); expect(h.page.querySelector('[data-testid="account-quota"]')).toBeNull()
    expect(h.page.querySelector('[role="tablist"]')).toBeNull()
  })
  it('shows actual channel availability inside recharge and cannot create an order when unavailable', async () => {
    const client = recharge(false)
    const h = harness({ status: vi.fn(async () => status), recharge: client }); h.component.open('recharge')
    await vi.waitFor(() =>{  expect(h.page.textContent).toContain('商户待配置') })
    expect(h.page.querySelector('[data-testid="shanghai-wallet"]')).toBeNull()
    expect(h.page.querySelector<HTMLInputElement>('[aria-label="充值金额"]')?.value).toBe('')
    expect(h.page.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    h.click('确认充值金额'); expect(client.create).not.toHaveBeenCalled()
    expect(h.page.textContent).toContain('上海人民币账户'); expect(h.page.querySelector('[data-testid="account-overview"]')).toBeNull()
  })
  it('requires a separate plan confirmation and ignores double clicks while purchasing', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const purchase = vi.fn(async () => { await pending; return fulfilled }), legacy = vi.fn()
    const client = subscription({ purchase })
    const h = harness({ status: vi.fn(async () => status), subscription: client, subscribe: legacy }); h.component.open('commerce')
    await vi.waitFor(() =>{  expect(h.page.textContent).toContain('¥39 / 月') })
    h.click('查看并选择'); await vi.waitFor(() => { expect(h.page.querySelector('[data-testid="account-cny-confirm"]')).not.toBeNull() })
    expect(purchase).not.toHaveBeenCalled(); expect(client.quote).toHaveBeenCalledWith('basic', expect.any(AbortSignal))
    expect(h.page.textContent).toContain('不自动续费')
    expect(h.page.textContent).toContain('账户余额 ¥50.00')
    h.click('确认支付 ¥39.00'); h.click('确认支付 ¥39.00'); expect(purchase).toHaveBeenCalledTimes(1)
    release(); await vi.waitFor(() =>{  expect(h.page.textContent).toContain('订阅已开通') })
    expect(h.page.textContent).toContain('ORDER-TEST'); expect(legacy).not.toHaveBeenCalled()
  })
  it('does not guess a missing quotation or enable purchase without a writer', async () => {
    const h = harness({ status: vi.fn(async () => ({ ...status, spPerYuanCost: null })) }); h.component.open('commerce')
    expect(h.page.textContent).toContain('订阅服务正在连接'); expect(h.page.textContent).not.toContain('¥')
    const client = subscription({ quote: vi.fn(async () => { throw new SubscriptionFailure('invalid-response', '报价暂不可用') }) })
    const next = harness({ status: vi.fn(async () => status), subscription: client }); next.component.open('commerce')
    await vi.waitFor(() => { expect(next.page.textContent).toContain('查看并选择') }); next.click('查看并选择')
    await vi.waitFor(() => { expect(next.page.textContent).toContain('报价暂不可用') })
    expect(next.page.querySelector('[data-testid="account-cny-confirm"]')).toBeNull(); expect(client.purchase).not.toHaveBeenCalled()
  })
  it('does not label a pending Shanghai order as credited', async () => {
    const h = harness({ status: vi.fn(async () => status), orders: vi.fn(async () => [{ orderNo: 'PAY_TEST', amount: '12.5000', currency: 'CNY', gateway: 'alipay', status: 'pending', createdAt: null }]) })
    h.component.open('orders'); await vi.waitFor(() =>{  expect(h.page.textContent).toContain('PAY_TEST') })
    expect(h.page.textContent).toContain('¥12.50'); expect(h.page.textContent).toContain('待付款或核账'); expect(h.page.textContent).not.toContain('已到账')
  })
  it('discards delayed quota and payment views when the account changes', async () => {
    let release!: (value: typeof status) => void
    const h = harness({ status: () => new Promise((resolve) => { release = resolve }), subscription: subscription() }); h.component.open('commerce')
    h.switchAccount(); expect(h.page.hidden).toBe(true); expect(h.page.textContent).toBe('')
    release(status); await Promise.resolve(); expect(h.page.textContent).toBe('')
  })
  it('reads and writes the same interaction preferences as the actual composer', () => {
    const h = harness(); h.component.open('settings')
    const sound = h.page.querySelector<HTMLInputElement>('[aria-label="轻盈提示音"]')!
    const send = h.page.querySelector<HTMLInputElement>('[aria-label="识别完成后自动发送"]')!
    expect(sound.checked).toBe(true); expect(send.checked).toBe(false)
    sound.click(); send.click()
    expect(localStorage.getItem('qianshou.mobile.sound')).toBe('false')
    expect(localStorage.getItem('qianshou.mobile.voice-auto-send')).toBe('true')
    h.component.open('home'); h.component.open('settings')
    expect(h.page.querySelector<HTMLInputElement>('[aria-label="轻盈提示音"]')!.checked).toBe(false)
    expect(h.page.querySelector<HTMLInputElement>('[aria-label="识别完成后自动发送"]')!.checked).toBe(true)
  })
  it('keeps absent promotion and unavailable commerce honest', () => {
    const h = harness(); h.component.open('promotion'); expect(h.page.textContent).toContain('推广结算接口尚未接入')
    h.component.open('commerce'); expect(h.page.textContent).toContain('订阅服务正在连接')
    expect(h.page.textContent).not.toContain('¥')
  })
})
