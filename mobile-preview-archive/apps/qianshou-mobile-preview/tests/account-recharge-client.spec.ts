// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountClient } from '@deepseek-ai/dsh-client-account'
import { alipayInstructions, createAlipayForm, createRechargeClient, rechargeAmount, wechatNativeInstructions, type RechargeOrder } from '../src/components/account-recharge-client.ts'

const signal = (): AbortSignal => new AbortController().signal
const expiry = Date.parse('2099-09-20T10:15:00Z')
const order: RechargeOrder = { orderNo: 'PAY_TEST_1', accountId: '167', amount: '12.34', status: 'pending', expiresAt: expiry, gateway: 'alipay' }
const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ order_no: order.orderNo, account_id: 167,
  amount: '12.340000', currency: 'CNY', gateway: 'alipay', status: 'pending', expired_at: new Date(expiry).toISOString(), ...overrides })
const instruction = () => ({ mode: 'alipay_page', method: 'POST', action: 'https://openapi.alipay.com/gateway.do?charset=utf-8', params: {
  app_id: '2026000000000000', method: 'alipay.trade.page.pay', format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', version: '1.0',
  timestamp: '2099-09-20 18:00:00', notify_url: 'https://qianshousuanli.com/api/v8/payment/notify/alipay', sign: 'A'.repeat(344),
  biz_content: JSON.stringify({ out_trade_no: order.orderNo, total_amount: '12.34', subject: '千手账户充值', product_code: 'FAST_INSTANT_TRADE_PAY',
    passback_params: 'account_167', time_expire: '2099-09-20 18:15:00' }),
} })
const wechatInstruction = () => ({ mode: 'wechat_native', code_url: 'weixin://wxpay/bizpayurl?pr=TEST_ORDER' })
function harness(handler?: (path: string, init: RequestInit | undefined) => Response | Promise<Response>, withWechat = false) {
  let owner = '167'
  const account = { tokens: { isAccessExpired: () => false, readAccess: () => 'test-access' }, refresh: vi.fn(),
    me: vi.fn(async () => ({ id: owner, balance: '7.000000' })) } as unknown as AccountClient
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname.replace('/account-api/api/v8/payment', '')
    if (path === '/channels') return Response.json({ items: [{ gateway: 'alipay', available: true, mode: 'alipay_page' },
      ...(withWechat ? [{ gateway: 'wechat_pay', available: true, mode: 'wechat_native' }] : [])] })
    if (handler) return handler(path, init)
    return Response.json(path === '/orders' ? { items: [] } : { ...row(), payment: instruction() })
  })
  const options = { client: account, accountId: () => owner, fetch: fetcher, origin: 'https://app.qianshousuanli.com', timeoutMs: 3000, storage: sessionStorage }
  return { client: createRechargeClient(options), recreate: () => createRechargeClient(options), fetcher, account, changeOwner: () => { owner = '168' } }
}
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks() })
describe('Shanghai recharge exact money and signed payment binding', () => {
  it('accepts cents without rounding or locally chosen amounts', () => {
    expect(rechargeAmount('0.01')).toBe('0.01'); expect(rechargeAmount('1000000')).toBe('1000000.00')
    for (const value of ['0', '-1', '1.001', '1e2', '01', '1000000.01', 'Infinity']) expect(() => rechargeAmount(value)).toThrow()
  })
  it('preserves signed strings and builds only a hidden POST to the exact gateway', () => {
    const raw = instruction(), parsed = alipayInstructions(raw, order), form = createAlipayForm(parsed, order)
    expect(form.action).toBe(raw.action); expect(form.method).toBe('post'); expect(form.target).toBe('_blank')
    expect(form.querySelectorAll('input')).toHaveLength(Object.keys(raw.params).length)
    expect((form.elements.namedItem('biz_content') as HTMLInputElement).value).toBe(raw.params.biz_content)
    expect(form.textContent).toBe('')
  })
  it.each(['https://evil.test/gateway.do', 'https://openapi.alipay.com.evil.test/gateway.do', 'https://openapi.alipay.com/gateway.do?charset=utf-8&return_url=bad'])('rejects an unreviewed action %s', (action) => {
    expect(() => alipayInstructions({ ...instruction(), action }, order)).toThrow()
  })
  it.each([{ out_trade_no: 'PAY_OTHER' }, { total_amount: '12.35' }, { passback_params: 'account_168' }, { time_expire: '2099-09-20 18:16:00' }])('rejects changed order, amount, owner or expiry %j', (change) => {
    const raw = instruction(); raw.params.biz_content = JSON.stringify({ ...JSON.parse(raw.params.biz_content), ...change })
    expect(() => alipayInstructions(raw, order)).toThrow()
  })
  it('rejects unsafe form fields, callbacks, terminal and expired orders', () => {
    const raw = instruction()
    expect(() => alipayInstructions({ ...raw, params: { ...raw.params, action: 'https://evil.test' } }, order)).toThrow()
    expect(() => alipayInstructions({ ...raw, params: { ...raw.params, notify_url: 'https://evil.test' } }, order)).toThrow()
    expect(() => alipayInstructions(raw, { ...order, status: 'paid' })).toThrow()
    expect(() => alipayInstructions(raw, { ...order, expiresAt: 1 })).toThrow()
  })
})
describe('WeChat Native recharge on mobile', () => {
  it('creates one owner-bound WeChat order and requires server status for paid', async () => {
    let status = 'pending'
    const h = harness(path => Response.json(path === '/orders' ? { items: [] }
      : path === `/orders/${order.orderNo}` ? row({ gateway: 'wechat_pay', status })
        : { ...row({ gateway: 'wechat_pay' }), payment: wechatInstruction() }), true)
    const result = await h.client.create('12.34', 'wechat_pay', signal())
    expect(result).toEqual({ kind: 'wechat-native', codeUrl: wechatInstruction().code_url })
    expect(h.client.snapshot()).toMatchObject({ order: { gateway: 'wechat_pay', status: 'pending' }, locked: true })
    expect(h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body))))
      .toEqual([{ amount: '12.34', gateway: 'wechat_pay', remark: '' }])
    expect(sessionStorage.getItem('qianshou.mobile.recharge.167')).toBe(JSON.stringify({ accountId: '167', orderNo: order.orderNo,
      amount: '12.34', gateway: 'wechat_pay' }))
    status = 'paid'
    await h.client.refresh(signal())
    expect(h.client.snapshot()).toMatchObject({ order: { status: 'paid' }, locked: false })
    expect(sessionStorage.length).toBe(0)
  })
  it('keeps unavailable WeChat disabled and refuses unreviewed QR payloads', async () => {
    const h = harness()
    expect((await h.client.load(signal())).channels.wechat_pay.available).toBe(false)
    await expect(h.client.create('12.34', 'wechat_pay', signal())).rejects.toThrow('RECHARGE_UNAVAILABLE')
    expect(h.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    const wechatOrder = { ...order, gateway: 'wechat_pay' as const }
    expect(wechatNativeInstructions(wechatInstruction(), wechatOrder).kind).toBe('wechat-native')
    for (const code_url of ['https://wxpay.example/pay', 'weixin://evil/bizpayurl?pr=1', 'weixin://wxpay/bizpayurl?pr=1\n']) {
      expect(() => wechatNativeInstructions({ mode: 'wechat_native', code_url }, wechatOrder)).toThrow()
    }
    expect(() => wechatNativeInstructions(wechatInstruction(), order)).toThrow()
  })
})
describe('Shanghai recharge ownership and uncertain write recovery', () => {
  it('reads real balance and channels, creates once, then prevents a second order', async () => {
    const h = harness()
    expect(await h.client.load(signal())).toMatchObject({ balance: '7.00', channels: { alipay: { available: true } } })
    await h.client.create('12.34', 'alipay', signal())
    expect(h.client.snapshot()).toEqual({ order, unknown: false, locked: true })
    await expect(h.client.create('12.34', 'alipay', signal())).rejects.toThrow('RECHARGE_PENDING')
    const posts = h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({ amount: '12.34', gateway: 'alipay', remark: '' })
    expect(new Headers(posts[0]?.[1]?.headers).get('authorization')).toBe('Bearer test-access')
    expect(JSON.stringify(sessionStorage)).not.toContain('test-access')
    expect(sessionStorage.getItem('qianshou.mobile.recharge.167')).toBe(JSON.stringify({ accountId: '167', orderNo: order.orderNo, amount: '12.34', gateway: 'alipay' }))
  })
  it('finds an account-owned pending order before any create write', async () => {
    const h = harness(() => Response.json({ items: [row()] }))
    await expect(h.client.create('12.34', 'alipay', signal())).rejects.toThrow('RECHARGE_PENDING')
    expect(h.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
  it('retains a 502 original order and only regenerates parameters for that same order', async () => {
    const h = harness(path => Response.json(path === '/orders' ? { items: [] } : path === '/recharge'
      ? { detail: { code: 'payment_request_unknown', order_no: order.orderNo } } : { ...row(), payment: instruction() }, { status: path === '/recharge' ? 502 : 200 }))
    await expect(h.client.create('12.34', 'alipay', signal())).rejects.toThrow('RECHARGE_UNKNOWN')
    const resumed = h.recreate()
    await resumed.payment(signal())
    const posts = h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => new URL(String(url)).pathname)
    expect(posts).toEqual(['/account-api/api/v8/payment/recharge', `/account-api/api/v8/payment/orders/${order.orderNo}/payment`])
  })
  it('does not disprove an unknown POST by an empty history or page reload', async () => {
    const h = harness((path) => { if (path === '/recharge') throw new TypeError('network'); return Response.json({ items: [] }) })
    await expect(h.client.create('12.34', 'alipay', signal())).rejects.toThrow()
    const resumed = h.recreate(); await resumed.refresh(signal())
    expect(resumed.snapshot()).toMatchObject({ unknown: true, locked: true })
    await expect(resumed.create('12.34', 'alipay', signal())).rejects.toThrow('RECHARGE_PENDING')
    expect(h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('never retries a financial write after a 401', async () => {
    const h = harness(path => Response.json(path === '/orders' ? { items: [] } : {}, { status: path === '/recharge' ? 401 : 200 }))
    await expect(h.client.create('12.34', 'alipay', signal())).rejects.toThrow()
    expect(h.account.refresh).not.toHaveBeenCalled()
    expect(h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('rejects another owner and fractional-cent server values', async () => {
    for (const invalidRow of [row({ account_id: 168 }), row({ amount: '12.340001' })]) {
      const h = harness(() => Response.json({ items: [invalidRow] }))
      await expect(h.client.refresh(signal())).rejects.toThrow()
    }
  })
  it('rejects late responses after account changes without populating the new account', async () => {
    let finish: (value: Response) => void = () => {}
    const h = harness(() => new Promise<Response>((resolve) => { finish = resolve }))
    const pending = h.client.refresh(signal()); h.changeOwner(); finish(Response.json({ items: [row()] }))
    await expect(pending).rejects.toThrow('RECHARGE_ACCOUNT')
    expect(h.client.snapshot().order).toBe(null)
  })
  it('accepts paid only from the original server order and clears recovery markers', async () => {
    sessionStorage.setItem('qianshou.mobile.recharge.167', JSON.stringify({ accountId: '167', orderNo: order.orderNo, amount: '12.34', gateway: 'alipay' }))
    const h = harness(() => Response.json(row({ status: 'paid' })))
    expect(await h.client.refresh(signal())).toMatchObject({ order: { status: 'paid' }, locked: false })
    expect(sessionStorage.length).toBe(0)
  })
  it('does not send when already aborted or when recovery storage is unavailable', async () => {
    const h = harness(), controller = new AbortController(); controller.abort()
    await expect(h.client.create('12.34', 'alipay', controller.signal)).rejects.toThrow()
    expect(h.fetcher).not.toHaveBeenCalled()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled') })
    await expect(h.client.create('12.34', 'alipay', signal())).rejects.toThrow('RECHARGE_STORAGE')
    expect(h.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
  it('retains the unknown write lock when an in-flight create is aborted', async () => {
    const controller = new AbortController()
    const h = harness((path, init) => {
      if (path !== '/recharge') return Response.json({ items: [] })
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
        controller.abort()
      })
    })
    await expect(h.client.create('12.34', 'alipay', controller.signal)).rejects.toThrow()
    expect(h.recreate().snapshot()).toMatchObject({ unknown: true, locked: true })
    expect(h.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('rejects oversized server payloads before projecting any order', async () => {
    const h = harness(() => Response.json({ items: [], extra: 'X'.repeat(132_000) }))
    await expect(h.client.refresh(signal())).rejects.toThrow('RECHARGE_INVALID')
    expect(h.client.snapshot().order).toBe(null)
  })
})
