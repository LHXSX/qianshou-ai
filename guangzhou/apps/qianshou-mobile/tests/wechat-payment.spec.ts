import { describe, expect, it, vi } from 'vitest'
import { amountOf, channelAvailable, createOrder, orderOf, readOrder } from '../src/wechat-payment.ts'
import type { AccountService } from '../src/account.ts'

const base = { order_no: 'PAY_mobile_1', account_id: 167, amount: '10.00', currency: 'CNY', gateway: 'wechat_pay', status: 'pending', expired_at: '2999-01-01T00:00:00Z' }
const instruction = { ...base, payment: { mode: 'wechat_native', code_url: 'weixin://wxpay/bizpayurl?pr=abc' } }

function service(responses: Array<{ ok: true; status: number; payload: unknown }>): { value: AccountService; calls: unknown[] } {
  const calls: unknown[] = []
  const requestProtected = vi.fn(async (input: unknown) => {
    calls.push(input)
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected payment request')
    return next
  })
  return { value: { session: { requestProtected } } as unknown as AccountService, calls }
}

describe('正式手机壳微信 Native 订单合同', () => {
  it('仅通道明确 available 的 Native 支持扫码入口', async () => {
    const disabled = service([{ ok: true, status: 200, payload: { items: [{ gateway: 'wechat_pay', mode: 'wechat_native', available: false }] } }])
    expect(await channelAvailable(disabled.value)).toBe(false)
    const enabled = service([{ ok: true, status: 200, payload: { items: [{ gateway: 'wechat_pay', mode: 'wechat_native', available: true }] } }])
    expect(await channelAvailable(enabled.value)).toBe(true)
  })

  it('创建订单明确传微信网关和金额；只有本人订单与微信 Native 付款码能展示', async () => {
    const stub = service([{ ok: true, status: 201, payload: instruction }])
    const result = await createOrder(stub.value, '167', '10')
    expect(result.codeUrl).toBe('weixin://wxpay/bizpayurl?pr=abc')
    expect(stub.calls[0]).toMatchObject({ path: '/payment/recharge', body: { amount: '10.00', gateway: 'wechat_pay' } })
    expect(() => orderOf({ ...instruction, account_id: 999 }, '167', true)).toThrow()
    expect(() => orderOf({ ...instruction, payment: { mode: 'alipay_page' } }, '167', true)).toThrow()
  })

  it('支付完成只读取上海订单 paid 状态，客户端不能自行宣布成功', async () => {
    const stub = service([{ ok: true, status: 200, payload: { ...base, status: 'paid' } }])
    expect((await readOrder(stub.value, '167', 'PAY_mobile_1')).status).toBe('paid')
    expect(stub.calls[0]).toMatchObject({ path: '/payment/orders/PAY_mobile_1', method: 'GET' })
    expect(amountOf('0')).toBeNull()
    expect(amountOf('10.999')).toBeNull()
  })
})
