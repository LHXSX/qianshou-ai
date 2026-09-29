/** 微信 Native 扫码支付合同。手机屏只展示给另一台设备扫描；完成依据仅为上海订单状态。 */
import type { AccountService } from './account.ts'

export interface WechatOrder {
  readonly orderNo: string
  readonly amount: string
  readonly status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed'
  readonly codeUrl: string | null
}

const ORDER_NUMBER = /^PAY_[A-Za-z0-9_]{1,75}$/u
const STATUSES = new Set(['pending', 'paid', 'expired', 'cancelled', 'failed'])

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

export function amountOf(input: string): string | null {
  const raw = input.trim()
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/u.test(raw)) return null
  const cents = Math.round(Number(raw) * 100)
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= 100_000_000
    ? (cents / 100).toFixed(2) : null
}

export function orderOf(payload: unknown, accountId: string, needCode = false): WechatOrder {
  const row = record(payload)
  const payment = record(row?.payment)
  const orderNo = row?.order_no
  const amount = typeof row?.amount === 'string' ? amountOf(row.amount) : null
  const status = row?.status
  if (row === null || typeof orderNo !== 'string' || !ORDER_NUMBER.test(orderNo)
    || String(row.account_id) !== accountId || row.currency !== 'CNY'
    || row.gateway !== 'wechat_pay' || amount === null || typeof status !== 'string' || !STATUSES.has(status)) {
    throw new Error('支付订单返回内容不完整，已停止操作。')
  }
  let codeUrl: string | null = null
  if (needCode) {
    const candidate = payment?.code_url
    const expires = typeof row.expired_at === 'string' ? Date.parse(row.expired_at) : NaN
    if (status !== 'pending' || payment?.mode !== 'wechat_native'
      || !Number.isFinite(expires) || expires <= Date.now()
      || typeof candidate !== 'string' || candidate.length > 2048
      || !/^weixin:\/\/wxpay\/bizpayurl\?/u.test(candidate) || /[\u0000-\u0020\u007f]/u.test(candidate)) {
      throw new Error('微信付款码无效，已停止操作。')
    }
    codeUrl = candidate
  }
  return { orderNo, amount, status: status as WechatOrder['status'], codeUrl }
}

export async function channelAvailable(service: AccountService): Promise<boolean> {
  const result = await service.session.requestProtected({ path: '/payment/channels', operation: 'payment', method: 'GET' })
  if (!result.ok) throw result.failure
  if (result.status !== 200) throw new Error('暂时无法确认微信支付通道。')
  const items = record(result.payload)?.items
  if (!Array.isArray(items) || items.length > 20) throw new Error('暂时无法确认微信支付通道。')
  const channel = items.map(record).find(item => item?.gateway === 'wechat_pay')
  return channel?.available === true && channel.mode === 'wechat_native'
}

export async function createOrder(service: AccountService, accountId: string, amount: string): Promise<WechatOrder> {
  const normalized = amountOf(amount)
  if (normalized === null) throw new Error('请填写有效充值金额，最多两位小数。')
  const result = await service.session.requestProtected({
    path: '/payment/recharge', operation: 'payment', method: 'POST',
    body: { amount: normalized, gateway: 'wechat_pay' },
  })
  if (!result.ok) throw result.failure
  if (result.status !== 201) throw new Error('订单创建状态不正确，先核对订单记录。')
  const order = orderOf(result.payload, accountId, true)
  if (order.amount !== normalized) throw new Error('订单金额与输入不一致，已停止操作。')
  return order
}

export async function readOrder(service: AccountService, accountId: string, orderNo: string): Promise<WechatOrder> {
  if (!ORDER_NUMBER.test(orderNo)) throw new Error('订单号无效。')
  const result = await service.session.requestProtected({
    path: `/payment/orders/${orderNo}`, operation: 'payment', method: 'GET',
  })
  if (!result.ok) throw result.failure
  if (result.status !== 200) throw new Error('订单查询状态不正确。')
  const order = orderOf(result.payload, accountId)
  if (order.orderNo !== orderNo) throw new Error('订单号与查询结果不一致。')
  return order
}

export async function listOrders(service: AccountService, accountId: string): Promise<WechatOrder[]> {
  const result = await service.session.requestProtected({ path: '/payment/orders?limit=30', operation: 'payment', method: 'GET' })
  if (!result.ok) throw result.failure
  if (result.status !== 200) throw new Error('订单记录暂时不可用。')
  const items = record(result.payload)?.items
  if (!Array.isArray(items) || items.length > 30) throw new Error('订单记录暂时不可用。')
  if (items.some(item => String(record(item)?.account_id) !== accountId)) throw new Error('订单归属核对失败。')
  return items.filter(item => record(item)?.gateway === 'wechat_pay').map(item => orderOf(item, accountId))
}

export async function refreshPaymentCode(service: AccountService, accountId: string, orderNo: string): Promise<WechatOrder> {
  if (!ORDER_NUMBER.test(orderNo)) throw new Error('订单号无效。')
  const result = await service.session.requestProtected({
    path: `/payment/orders/${orderNo}/payment`, operation: 'payment', method: 'POST', body: {},
  })
  if (!result.ok) throw result.failure
  if (result.status !== 200) throw new Error('原订单付款码暂时不可用。')
  const order = orderOf(result.payload, accountId, true)
  if (order.orderNo !== orderNo) throw new Error('订单号与付款码不一致。')
  return order
}
