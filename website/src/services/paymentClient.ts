import { httpClient } from './api'

export interface PaymentChannel {
  gateway: 'wechat_pay' | 'alipay'
  mode: string
  available: boolean
  reason?: string
}

export interface RechargeOrder {
  order_no: string
  account_id: number
  amount: string
  currency: 'CNY'
  gateway: string
  status: 'pending' | 'paid' | 'expired' | 'cancelled' | string
  created_at: string
  paid_at: string | null
  expired_at: string | null
  payment?: { mode: string; code_url?: string | null } | null
  /** Only /orders/{order_no}/refresh supplies this verified provider state. */
  provider_state?: string | null
}

function validOrder(raw: unknown): RechargeOrder {
  const row = raw as Partial<RechargeOrder> | null
  if (!row || typeof row.order_no !== 'string' || !/^PAY_[A-Za-z0-9_]+$/.test(row.order_no)
      || typeof row.status !== 'string' || typeof row.amount !== 'string' || row.currency !== 'CNY') {
    throw new Error('支付订单数据不完整，请核对原订单。')
  }
  return row as RechargeOrder
}

export const paymentClient = {
  async channels(): Promise<PaymentChannel[]> {
    const response = await httpClient.get('/payment/channels')
    if (!Array.isArray(response.data?.items)) throw new Error('支付通道状态不可用。')
    return response.data.items as PaymentChannel[]
  },
  async createWechatOrder(amount: string): Promise<RechargeOrder> {
    const response = await httpClient.post('/payment/recharge', { amount, gateway: 'wechat_pay' })
    const order = validOrder(response.data)
    if (order.gateway !== 'wechat_pay' || order.status !== 'pending'
      || order.payment?.mode !== 'wechat_native' || !order.payment.code_url?.startsWith('weixin://')) {
      throw new Error('微信收银台数据不完整，请核对原订单。')
    }
    return order
  },
  async getOrder(orderNo: string): Promise<RechargeOrder> {
    return validOrder((await httpClient.get(`/payment/orders/${encodeURIComponent(orderNo)}`)).data)
  },
  async retryPayment(orderNo: string): Promise<RechargeOrder> {
    const order = validOrder((await httpClient.post(`/payment/orders/${encodeURIComponent(orderNo)}/payment`)).data)
    if (order.payment?.mode !== 'wechat_native' || !order.payment.code_url?.startsWith('weixin://')) {
      throw new Error('微信收银台数据不完整，请核对原订单。')
    }
    return order
  },
  async refreshWechatOrder(orderNo: string): Promise<RechargeOrder> {
    return validOrder((await httpClient.post(`/payment/orders/${encodeURIComponent(orderNo)}/refresh`)).data)
  },
  async listOrders(): Promise<RechargeOrder[]> {
    const response = await httpClient.get('/payment/orders', { params: { limit: 30 } })
    if (response.data?.ok !== true || !Array.isArray(response.data.items)) {
      throw new Error('充值记录暂时不可用。')
    }
    return response.data.items.map(validOrder)
  },
}
