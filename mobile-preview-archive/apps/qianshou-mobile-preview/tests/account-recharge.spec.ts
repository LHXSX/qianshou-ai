// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountRecharge } from '../src/components/account-recharge.ts'
import { rechargeCopy as t } from '../src/components/account-copy.ts'
import { alipayInstructions, type RechargeState, type RechargeClient, type RechargeOrder } from '../src/components/account-recharge-client.ts'

const expiry = Date.parse('2099-09-20T10:15:00Z')
const pending: RechargeOrder = { orderNo: 'PAY_TEST_1', accountId: '167', amount: '12.34', status: 'pending', expiresAt: expiry, gateway: 'alipay' }
const payment = () => alipayInstructions({ mode: 'alipay_page', method: 'POST', action: 'https://openapi.alipay.com/gateway.do?charset=utf-8', params: {
  app_id: '2026000000000000', method: 'alipay.trade.page.pay', charset: 'utf-8', sign_type: 'RSA2', version: '1.0',
  timestamp: '2099-09-20 18:00:00', notify_url: 'https://qianshousuanli.com/api/v8/payment/notify/alipay', sign: 'A'.repeat(344),
  biz_content: JSON.stringify({ out_trade_no: pending.orderNo, total_amount: '12.34', subject: '千手账户充值', product_code: 'FAST_INSTANT_TRADE_PAY',
    passback_params: 'account_167', time_expire: '2099-09-20 18:15:00' }),
} }, pending)
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const lifetimes: AbortController[] = []
function harness(initial: RechargeState = { order: null, unknown: false, locked: false }, available = true, withWechat = false) {
  let state = initial, owner = '167'
  const controller = new AbortController(); lifetimes.push(controller)
  const client: RechargeClient = {
    accountId: () => owner, snapshot: () => state,
    load: vi.fn(async () => ({ balance: '7.00', channels: { alipay: { available, reason: null }, wechat_pay: { available: withWechat, reason: null } } })),
    refresh: vi.fn(async () => state),
    create: vi.fn(async (_amount, gateway) => { state = { order: { ...pending, gateway }, unknown: false, locked: true }
      return gateway === 'wechat_pay' ? { kind: 'wechat-native' as const, codeUrl: 'weixin://wxpay/bizpayurl?pr=TEST_ORDER' } : payment() }),
    payment: vi.fn(async () => state.order?.gateway === 'wechat_pay'
      ? { kind: 'wechat-native' as const, codeUrl: 'weixin://wxpay/bizpayurl?pr=TEST_ORDER' } : payment()),
  }
  const root = document.createElement('div'); document.body.append(root)
  const navigate = vi.fn()
  renderAccountRecharge({ container: root, client, signal: controller.signal, current: () => true, navigate })
  const button = (text: string): HTMLButtonElement => {
    const found = [...root.querySelectorAll('button')].find(item => item.textContent === text)
    if (!found) throw new Error(`Missing ${text}`)
    return found
  }
  const amount = root.querySelector('input')!
  const enter = (value: string): void => { amount.value = value; amount.dispatchEvent(new Event('input', { bubbles: true })) }
  const submit = (): void => { root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })) }
  return { root, client, button, amount, enter, submit, navigate, controller, changeOwner: () => { owner = '168' },
    setState: (next: RechargeState) => { state = next } }
}
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }) })
afterEach(() => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort()
  vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren()
})
describe('compact owned recharge page', () => {
  it('requires amount confirmation, then a separate explicit gateway payment click', async () => {
    const post = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    const h = harness(); await settle()
    expect(h.amount.value).toBe(''); expect(h.root.textContent).toContain('¥7.00')
    h.enter('12.34'); h.submit(); await settle()
    expect(h.client.create).not.toHaveBeenCalled(); expect(h.root.textContent).toContain(`${t.confirming}：¥12.34`)
    h.submit(); await settle()
    expect(h.client.create).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled()
    expect(h.amount.disabled).toBe(true)
    h.button(t.payment).click()
    expect(post).toHaveBeenCalledOnce(); expect(h.root.textContent).toContain(t.paymentOpened)
    expect(h.root.querySelectorAll('form')).toHaveLength(1)
    expect(h.root.querySelector('.account-badge')?.textContent).toBe(t.pending)
  })
  it('shows WeChat QR only after explicit order creation and never claims same-phone payment', async () => {
    const post = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {})
    const h = harness(undefined, true, true); await settle()
    h.button(t.wechat).click()
    h.enter('12.34'); h.submit(); await settle()
    expect(h.root.querySelector('.recharge-wechat-qr')).toBe(null)
    h.submit(); await settle()
    expect(h.client.create).toHaveBeenCalledWith('12.34', 'wechat_pay', expect.any(AbortSignal))
    expect(h.root.querySelector('.recharge-wechat-qr svg[role="img"]')).not.toBe(null)
    expect(h.root.textContent).toContain(t.wechatOtherDevice)
    expect(h.root.textContent).toContain(t.wechatScanHelp)
    expect(post).not.toHaveBeenCalled()
    expect(h.root.querySelector('.account-badge')?.textContent).toBe(t.pending)
  })
  it('resets confirmation after editing and never writes invalid cents', async () => {
    const h = harness(); await settle()
    h.enter('1.001'); h.submit(); expect(h.root.textContent).toContain(t.invalid)
    h.enter('12.34'); h.submit(); h.enter('23.45'); h.submit(); await settle()
    expect(h.client.create).not.toHaveBeenCalled(); expect(h.root.textContent).toContain(`${t.confirming}：¥23.45`)
  })
  it('keeps unavailable channels disabled and recovers through a read-only refresh', async () => {
    const h = harness(undefined, false); await settle()
    expect(h.button(t.create).disabled).toBe(true)
    vi.mocked(h.client.load).mockResolvedValue({ balance: '7.00', channels: { alipay: { available: true, reason: null }, wechat_pay: { available: false, reason: null } } })
    h.button(t.refresh).click(); await settle()
    expect(h.button(t.create).disabled).toBe(false); expect(h.client.create).not.toHaveBeenCalled()
  })
  it('shows an unknown write as locked and retains routes to records and subscription confirmation', async () => {
    const h = harness({ order: null, unknown: true, locked: true }); await settle()
    expect(h.root.textContent).toContain(t.unknown); expect(h.button(t.create).disabled).toBe(true)
    h.button(t.orders).click(); h.button(t.backSubscription).click()
    expect(h.navigate.mock.calls).toEqual([['orders'], ['commerce']]); expect(h.client.create).not.toHaveBeenCalled()
  })
  it('polls every three seconds, pauses while hidden, and stops after disposal', async () => {
    const h = harness({ order: pending, unknown: false, locked: true }); await settle()
    await vi.advanceTimersByTimeAsync(2999); expect(h.client.refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(h.client.refresh).toHaveBeenCalledOnce()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(9000); expect(h.client.refresh).toHaveBeenCalledOnce()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(3000); expect(h.client.refresh).toHaveBeenCalledTimes(2)
    h.controller.abort(); await vi.advanceTimersByTimeAsync(9000); expect(h.client.refresh).toHaveBeenCalledTimes(2)
  })
  it('discards late page results after account switch and never repaints another account', async () => {
    const h = harness({ order: pending, unknown: false, locked: true }); await settle()
    let finish: (state: RechargeState) => void = () => {}
    vi.mocked(h.client.refresh).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(3000)
    h.changeOwner(); h.setState({ order: { ...pending, status: 'paid' }, unknown: false, locked: false })
    finish(h.client.snapshot()); await settle()
    expect(h.root.textContent).not.toContain(t.paid)
    await vi.advanceTimersByTimeAsync(9000); expect(h.client.refresh).toHaveBeenCalledOnce()
  })
  it('uses only server-confirmed paid state and then stops polling', async () => {
    const h = harness({ order: pending, unknown: false, locked: true }); await settle()
    h.setState({ order: { ...pending, status: 'paid' }, unknown: false, locked: false })
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.root.textContent).toContain(t.paid)
    await vi.advanceTimersByTimeAsync(9000); expect(h.client.refresh).toHaveBeenCalledOnce()
    expect(h.client.create).not.toHaveBeenCalled()
  })
  it('bounds automatic polling and never presents an expired order as payable', async () => {
    const h = harness({ order: pending, unknown: false, locked: true }); await settle()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.root.textContent).toContain(t.paused)
    const count = vi.mocked(h.client.refresh).mock.calls.length
    await vi.advanceTimersByTimeAsync(9000); expect(h.client.refresh).toHaveBeenCalledTimes(count)
    h.controller.abort()
    const expired = harness({ order: { ...pending, expiresAt: 1 }, unknown: false, locked: true }); await settle()
    expect(expired.root.textContent).toContain(t.expired)
    expect([...expired.root.querySelectorAll('button')].some(button => button.textContent === t.retryPayment)).toBe(false)
  })
})
