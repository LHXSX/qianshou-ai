/** Shanghai subscription checkout and server-backed recharge. Prices come from the servers. */
import { randomUUID } from 'node:crypto'
import { AccountFailure } from './protocol.ts'
import type { AccountProtocol } from './protocol.ts'
import type { AccountAlipayStart, AccountCommerce, AccountCommerceNotice, AccountPayment,
  AccountPlanOffer, AccountQuoteView, AccountRechargeOrder, AccountWechatChannel,
  AccountWechatOrder, AccountWechatStart } from './types.ts'

const ALIPAY_ACTION = 'https://openapi.alipay.com/gateway.do?charset=utf-8'
const PLAN_IDS = new Set(['basic', 'plus', 'max'])
const PAYMENT_KEYS = ['app_id', 'method', 'format', 'charset', 'sign_type', 'version', 'timestamp', 'notify_url', 'return_url', 'biz_content', 'sign']
const REQUIRED_PAYMENT_KEYS = ['app_id', 'method', 'format', 'charset', 'sign_type', 'version', 'timestamp', 'notify_url', 'biz_content', 'sign']

/** Quote held until the same account confirms or replaces it. */
export interface PendingQuote {
  accountId: string
  quoteId: string
  key: string
  view: AccountQuoteView
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function text(value: unknown, max = 128): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null
}

function noticeOf(payload: unknown): AccountCommerceNotice {
  const row = record(payload)
  const detail = record(row?.detail) ?? row
  const code = typeof detail?.code === 'string' ? detail.code : ''
  if (code === 'downgrade-not-allowed' || (code === 'RESOURCE_CONFLICT'
    && typeof row?.message === 'string' && /['"]code['"]:\s*['"]downgrade-not-allowed['"]/u.test(row.message))) return 'downgrade-not-allowed'
  if (code === 'insufficient_balance' || code === 'insufficient-balance') return 'insufficient-balance'
  if (code === 'quote_expired' || code === 'quote-expired' || code === 'invalid_quote' || code === 'invalid-quote') return 'quote-expired'
  return 'unavailable'
}

/**
 * Reject a recharge amount that is not a positive yuan value to the cent.
 * @param value - User-entered amount.
 * @returns The same amount padded to two decimal places.
 */
export function rechargeAmount(value: string): string {
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/u.test(value)) throw new AccountFailure('invalid-input')
  const [whole = '', decimal = ''] = value.split('.')
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'))
  if (cents < 1 || cents > 100_000_000) throw new AccountFailure('invalid-input')
  return `${whole}.${decimal.padEnd(2, '0')}`
}

function plansOf(payload: unknown): AccountPlanOffer[] {
  const rows = record(payload)?.plans
  if (!Array.isArray(rows)) return []
  const plans: AccountPlanOffer[] = []
  for (const raw of rows) {
    const row = record(raw)
    const id = text(row?.id, 32)
    const label = text(row?.label, 64)
    if (id === null || label === null || !PLAN_IDS.has(id)) continue
    plans.push({ id, label, monthlyYuan: finite(row?.monthlyYuan), monthlySp: finite(row?.monthlySp) })
  }
  return plans
}

function yuanOf(payload: unknown): string | null {
  const wallet = record(record(payload)?.wallet)
  const balanceYuan = text(wallet?.balanceYuan, 16)
  const balanceFen = finite(wallet?.balanceFen)
  if (wallet?.currency !== 'CNY' || balanceYuan === null || balanceFen === null) return null
  if (!/^\d+\.\d{2}$/u.test(balanceYuan) || Math.round(Number(balanceYuan) * 100) !== balanceFen) return null
  return balanceYuan
}

/**
 * Combine the gateway quota with the Shanghai RMB wallet.
 * @param status - Guangzhou `/status` payload.
 * @param wallet - Shanghai wallet payload, or null when that read failed.
 * @param quote - Current quote, if the user has selected a plan.
 * @param notice - Safe checkout notice.
 * @returns A detached commerce view with no payment secrets.
 */
export function commerceView(status: unknown, wallet: string | null, quote: AccountQuoteView | null, notice: AccountCommerceNotice | null): AccountCommerce {
  const body = record(status)
  const tier = record(body?.tier)
  const credit = record(body?.credit)
  return {
    tierLabel: text(tier?.label, 64) ?? '',
    remainingSp: finite(credit?.remainingSp),
    windowLimitSp: finite(credit?.windowLimitSp),
    usedInWindowSp: finite(credit?.usedInWindowSp),
    balanceYuan: wallet,
    plans: plansOf(status),
    quote,
    notice,
  }
}

function quoteView(payload: unknown, accountId: string, tier: string): { quoteId: string; view: AccountQuoteView } {
  const body = record(payload)
  const quote = record(body?.quote)
  const wallet = record(body?.wallet)
  const quoteId = text(quote?.quoteId, 80)
  const label = text(quote?.label, 64)
  const amountYuan = text(quote?.amountYuan, 16)
  const monthlySp = finite(quote?.monthlySp)
  if (body?.ok !== true || quote?.accountId !== accountId || quote?.tier !== tier || quote?.months !== 1
    || quote?.currency !== 'CNY' || quoteId === null || label === null || amountYuan === null || monthlySp === null
    || !/^\d+\.\d{2}$/u.test(amountYuan) || typeof wallet?.canPay !== 'boolean') throw new AccountFailure('invalid-response')
  return { quoteId, view: { label, amountYuan, monthlySp, canPay: wallet.canPay } }
}

/**
 * Read quota and the RMB wallet for the signed-in account.
 * @param protocol - Account and gateway transport.
 * @param access - Host-only access token.
 * @param signal - Account lifetime cancellation.
 * @param quote - Quote already shown to this account.
 * @returns The current commerce view.
 */
export async function readCommerce(protocol: AccountProtocol, access: string,
  signal: AbortSignal, quote: AccountQuoteView | null): Promise<AccountCommerce> {
  const status = await protocol.read('/status', 'POST', {}, access, signal, true)
  if (status.status === 401 || status.status === 403) throw new AccountFailure('auth-required')
  if (status.status !== 200 || record(status.payload)?.ok !== true) throw new AccountFailure('unavailable')
  let balance: string | null = null
  try {
    const wallet = await protocol.read('/subscriptions/wallet', 'GET', undefined, access, signal)
    if (wallet.status === 200) balance = yuanOf(wallet.payload)
  } catch (error) {
    if (error instanceof AccountFailure && error.code === 'cancelled') throw error
  }
  return commerceView(status.payload, balance, quote, null)
}

/**
 * Ask Shanghai for a one-month price. Nothing is debited.
 * @param protocol - Account transport.
 * @param access - Host-only access token.
 * @param accountId - Signed-in account id.
 * @param tier - Plan id the user selected.
 * @param signal - Account lifetime cancellation.
 * @param current - Existing commerce view to keep the quota numbers.
 * @returns The pending quote and the updated view.
 */
export async function quoteCommerce(protocol: AccountProtocol, access: string, accountId: string, tier: string,
  signal: AbortSignal, current: AccountCommerce): Promise<{ pending: PendingQuote | null; commerce: AccountCommerce }> {
  if (!PLAN_IDS.has(tier)) throw new AccountFailure('invalid-input')
  const response = await protocol.read('/subscriptions/quote', 'POST', { tier, months: 1 }, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  if (response.status !== 200) return { pending: null, commerce: { ...current, quote: null, notice: noticeOf(response.payload) } }
  const quoted = quoteView(response.payload, accountId, tier)
  const pending = { accountId, quoteId: quoted.quoteId, key: randomUUID(), view: quoted.view }
  return { pending, commerce: { ...current, quote: quoted.view, notice: null } }
}

/**
 * Pay the pending quote once. A repeated call keeps the first idempotency key.
 * @param protocol - Account transport.
 * @param access - Host-only access token.
 * @param pending - Quote saved before this confirmation.
 * @param signal - Account lifetime cancellation.
 * @param current - Commerce view shown with that quote.
 * @returns The updated view. A paid quote is cleared.
 */
export async function buyCommerce(protocol: AccountProtocol, access: string, pending: PendingQuote,
  signal: AbortSignal, current: AccountCommerce): Promise<{ pending: PendingQuote | null; commerce: AccountCommerce }> {
  const response = await protocol.read('/subscriptions/purchase', 'POST',
    { quoteId: pending.quoteId, idempotencyKey: pending.key }, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  const order = record(record(response.payload)?.order)
  if (response.status === 200 && record(response.payload)?.ok === true && order?.status === 'fulfilled') {
    return { pending: null, commerce: { ...current, quote: null, notice: 'paid' } }
  }
  const notice = noticeOf(response.payload)
  return { pending: notice === 'insufficient-balance' || notice === 'quote-expired' ? null : pending,
    commerce: { ...current, quote: notice === 'quote-expired' ? null : current.quote, notice } }
}

/**
 * Start one Alipay recharge. The caller submits the returned fields; this function does not.
 * @param protocol - Account transport.
 * @param access - Host-only access token.
 * @param amount - Validated yuan amount.
 * @param signal - Account lifetime cancellation.
 * @returns The reviewed Alipay page fields.
 */
function alipayPaymentOf(payload: unknown, orderNo: string, amount: string): AccountPayment {
  const payment = record(record(payload)?.payment)
  const params = record(payment?.params)
  if (payment?.mode !== 'alipay_page' || payment.action !== ALIPAY_ACTION
    || payment.method !== 'POST' || params === null
    || params.method !== 'alipay.trade.page.pay' || params.charset !== 'utf-8'
    || params.sign_type !== 'RSA2') throw new AccountFailure('invalid-response')
  let trade: Record<string, unknown> | null = null
  try { trade = record(JSON.parse(String(params.biz_content))) }
  catch { throw new AccountFailure('invalid-response') }
  if (trade?.out_trade_no !== orderNo || trade.total_amount !== amount) throw new AccountFailure('invalid-response')
  const fields = PAYMENT_KEYS.flatMap((name) => {
    const value = params[name]
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return []
    return [{ name, value }]
  })
  if (REQUIRED_PAYMENT_KEYS.some(name => !fields.some(field => field.name === name))) throw new AccountFailure('invalid-response')
  return { action: ALIPAY_ACTION, fields }
}

/** Create or replay one Alipay recharge; a replay resolves only the original order. */
export async function rechargeCommerce(protocol: AccountProtocol, access: string, accountId: string,
  amount: string, idempotencyKey: string, signal: AbortSignal): Promise<AccountAlipayStart> {
  if (!RECHARGE_KEY.test(idempotencyKey)) throw new AccountFailure('invalid-input')
  const response = await protocol.read('/payment/recharge', 'POST',
    { amount, gateway: 'alipay', remark: '', idempotency_key: idempotencyKey }, access, signal)
  if (response.status === 201 || (response.status === 200
    && record(response.payload)?.reused_order !== true
    && record(record(response.payload)?.payment)?.mode === 'alipay_page')) {
    const order = rechargeOrderOf(response.payload, accountId, 'alipay')
    if (order.amount !== amount || order.status !== 'pending') throw new AccountFailure('invalid-response')
    return { kind: 'ready', order, payment: alipayPaymentOf(response.payload, order.orderNo, amount) }
  }
  if (response.status === 200) {
    const payload = record(response.payload)
    const recovered = record(payload?.recovery)
    const number = orderNo(payload?.order_no)
    if (payload?.reused_order !== true || payload.payment !== null || number === null
      || recovered?.order_url !== `/api/v8/payment/orders/${number}`
      || (recovered.payment_url !== undefined && recovered.payment_url !== `/api/v8/payment/orders/${number}/payment`)) {
      throw new AccountFailure('invalid-response')
    }
    const summary = rechargeOrderOf(payload, accountId, 'alipay')
    if (summary.amount !== amount) throw new AccountFailure('invalid-response')
    const current = await readAlipayOrder(protocol, access, accountId, number, signal)
    if (current.amount !== amount) throw new AccountFailure('invalid-response')
    if (current.status === 'pending' && current.expiresAt !== null && current.expiresAt > Date.now()
      && recovered.payment_url === `/api/v8/payment/orders/${number}/payment`) {
      try { return { kind: 'ready', order: current,
        payment: await retryAlipayPayment(protocol, access, accountId, number, amount, signal), reused: true } }
      catch { /* Keep the original pending order if the cashier parameters are unavailable. */ }
    }
    return { kind: 'order', order: current }
  }
  if (response.status === 502) {
    const detail = record(record(response.payload)?.detail)
    return { kind: 'unknown', orderNo: orderNo(detail?.order_no) }
  }
  if (response.status === 409 && record(record(response.payload)?.detail)?.code === 'idempotency_conflict') {
    return { kind: 'conflict' }
  }
  if ([400, 401, 403, 404, 409, 422, 503].includes(response.status)) return { kind: 'rejected' }
  return { kind: 'unknown', orderNo: null }
}

const ORDER_NUMBER = /^PAY_[A-Za-z0-9_]{1,75}$/u
const RECHARGE_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const ORDER_STATUSES = new Set(['pending', 'paid', 'expired', 'cancelled', 'failed'])

function orderNo(value: unknown): string | null {
  return typeof value === 'string' && ORDER_NUMBER.test(value) ? value : null
}

function wireAmount(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,7}(?:\.\d{1,12})?$/u.test(value)) return null
  const normalized = value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value
  try { return rechargeAmount(normalized) } catch { return null }
}

function timestamp(value: unknown, required: boolean): number | null {
  if (value === null && !required) return null
  if (typeof value !== 'string') throw new AccountFailure('invalid-response')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new AccountFailure('invalid-response')
  return parsed
}

function wechatCodeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048
    || !/^weixin:\/\/wxpay\/bizpayurl\?/u.test(value) || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new AccountFailure('invalid-response')
  }
  return value
}

/** Reject an order from a different account/channel before exposing its status. */
function rechargeOrderOf(payload: unknown, accountId: string,
  gateway: 'wechat_pay' | 'alipay'): AccountRechargeOrder {
  const row = record(payload)
  const number = orderNo(row?.order_no)
  const amount = wireAmount(row?.amount)
  const createdAt = timestamp(row?.created_at, true)
  const expiresAt = timestamp(row?.expired_at, false)
  if (row === null || number === null || String(row.account_id) !== accountId || amount === null
    || row.currency !== 'CNY' || row.gateway !== gateway || !ORDER_STATUSES.has(String(row.status))
    || createdAt === null) throw new AccountFailure('invalid-response')
  return { orderNo: number, amount, status: row.status as AccountRechargeOrder['status'],
    createdAt, expiresAt }
}

/** Decode only this signed-in account's WeChat order and payment instruction. */
export function wechatOrderOf(payload: unknown, accountId: string, instruction = false): AccountWechatOrder {
  const row = record(payload)
  const order = rechargeOrderOf(payload, accountId, 'wechat_pay')
  let codeUrl: string | null = null
  if (instruction) {
    const payment = record(row?.payment)
    if (order.status !== 'pending' || order.expiresAt === null || order.expiresAt <= Date.now()
      || payment?.mode !== 'wechat_native') throw new AccountFailure('invalid-response')
    codeUrl = wechatCodeUrl(payment.code_url)
  }
  return { ...order, codeUrl }
}

/** Only an explicitly available Native channel permits a new WeChat order. */
export async function readWechatChannel(protocol: AccountProtocol, access: string,
  signal: AbortSignal): Promise<AccountWechatChannel> {
  const response = await protocol.read('/payment/channels', 'GET', undefined, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  const rows = record(response.payload)?.items
  if (response.status !== 200 || !Array.isArray(rows) || rows.length > 20) throw new AccountFailure('unavailable')
  const channel = rows.map(record).find(row => row?.gateway === 'wechat_pay')
  return { available: channel?.available === true && channel.mode === 'wechat_native',
    rechargeIdempotency: record(response.payload)?.recharge_idempotency === true }
}

/** Create or replay one durable intent. A replay never treats payment:null as a QR instruction. */
export async function startWechatRecharge(protocol: AccountProtocol, access: string, accountId: string,
  amount: string, idempotencyKey: string, signal: AbortSignal): Promise<AccountWechatStart> {
  if (!RECHARGE_KEY.test(idempotencyKey)) throw new AccountFailure('invalid-input')
  const response = await protocol.read('/payment/recharge', 'POST',
    { amount, gateway: 'wechat_pay', remark: '', idempotency_key: idempotencyKey }, access, signal)
  if (response.status === 201) {
    const order = wechatOrderOf(response.payload, accountId, true)
    if (order.amount !== amount) throw new AccountFailure('invalid-response')
    return { kind: 'ready', order }
  }
  if (response.status === 200) {
    const payload = record(response.payload)
    const recovered = record(payload?.recovery)
    const number = orderNo(payload?.order_no)
    if (payload?.reused_order !== true || payload.payment !== null || number === null
      || recovered?.order_url !== `/api/v8/payment/orders/${number}`
      || (recovered.payment_url !== undefined && recovered.payment_url !== `/api/v8/payment/orders/${number}/payment`)
      || (recovered.refresh_url !== undefined && recovered.refresh_url !== `/api/v8/payment/orders/${number}/refresh`)) {
      throw new AccountFailure('invalid-response')
    }
    const summary = wechatOrderOf(payload, accountId)
    if (summary.amount !== amount) throw new AccountFailure('invalid-response')
    const current = await readWechatOrder(protocol, access, accountId, number, signal)
    if (current.amount !== amount) throw new AccountFailure('invalid-response')
    if (current.status === 'pending' && current.expiresAt !== null && current.expiresAt > Date.now()
      && recovered.payment_url === `/api/v8/payment/orders/${number}/payment`) {
      try { return { kind: 'ready', order: await retryWechatPayment(protocol, access, accountId, number, signal), reused: true } }
      catch { return { kind: 'ready', order: current, reused: true } }
    }
    if ((current.status === 'pending' || current.status === 'expired')
      && recovered.refresh_url === `/api/v8/payment/orders/${number}/refresh`) {
      try { return { kind: 'ready', order: await refreshWechatOrder(protocol, access, accountId, number, signal), reused: true } }
      catch { /* The original order remains locked until a signed query succeeds. */ }
    }
    return { kind: 'ready', order: current, reused: true }
  }
  if (response.status === 502) {
    const detail = record(record(response.payload)?.detail)
    return { kind: 'unknown', orderNo: orderNo(detail?.order_no) }
  }
  if (response.status === 409 && record(record(response.payload)?.detail)?.code === 'idempotency_conflict') {
    return { kind: 'conflict' }
  }
  if ([400, 401, 403, 404, 409, 422, 503].includes(response.status)) return { kind: 'rejected' }
  return { kind: 'unknown', orderNo: null }
}

/** Read one existing order. Only a server-reported paid status confirms arrival. */
export async function readWechatOrder(protocol: AccountProtocol, access: string, accountId: string,
  number: string, signal: AbortSignal): Promise<AccountWechatOrder> {
  if (orderNo(number) === null) throw new AccountFailure('invalid-input')
  const response = await protocol.read(`/payment/orders/${number}`, 'GET', undefined, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  if (response.status !== 200) throw new AccountFailure('unavailable')
  const order = wechatOrderOf(response.payload, accountId)
  if (order.orderNo !== number) throw new AccountFailure('invalid-response')
  return order
}

/** Ask Shanghai to verify the original trade with WeChat; a local timeout never settles it. */
export async function refreshWechatOrder(protocol: AccountProtocol, access: string, accountId: string,
  number: string, signal: AbortSignal): Promise<AccountWechatOrder> {
  if (orderNo(number) === null) throw new AccountFailure('invalid-input')
  const response = await protocol.read(`/payment/orders/${number}/refresh`, 'POST', {}, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  if (response.status !== 200) throw new AccountFailure('unavailable')
  const order = wechatOrderOf(response.payload, accountId)
  const state = record(response.payload)?.provider_state
  if (order.orderNo !== number || !['SUCCESS', 'NOTPAY', 'CLOSED', 'REFUND', 'REVOKED', 'USERPAYING', 'PAYERROR'].includes(String(state))) {
    throw new AccountFailure('invalid-response')
  }
  return { ...order, providerState: state as NonNullable<AccountWechatOrder['providerState']> }
}

/** Bounded owner-checked history, used to recover a lost create response without another POST. */
export async function listWechatOrders(protocol: AccountProtocol, access: string, accountId: string,
  signal: AbortSignal): Promise<AccountWechatOrder[]> {
  const response = await protocol.read('/payment/orders?limit=30', 'GET', undefined, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  const body = record(response.payload)
  if (response.status !== 200 || body?.ok !== true || !Array.isArray(body.items) || body.items.length > 30) {
    throw new AccountFailure('unavailable')
  }
  if (body.items.some(item => String(record(item)?.account_id) !== accountId)) throw new AccountFailure('invalid-response')
  return body.items.filter(item => record(item)?.gateway === 'wechat_pay')
    .map(item => wechatOrderOf(item, accountId))
}

/** Retrieve payment data only for the same pending order; never create another order here. */
export async function retryWechatPayment(protocol: AccountProtocol, access: string, accountId: string,
  number: string, signal: AbortSignal): Promise<AccountWechatOrder> {
  if (orderNo(number) === null) throw new AccountFailure('invalid-input')
  const response = await protocol.read(`/payment/orders/${number}/payment`, 'POST', {}, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  if (response.status !== 200) throw new AccountFailure('unavailable')
  const order = wechatOrderOf(response.payload, accountId, true)
  if (order.orderNo !== number) throw new AccountFailure('invalid-response')
  return order
}

/** Read a single owner-bound Alipay order; only server status confirms credit. */
export async function readAlipayOrder(protocol: AccountProtocol, access: string, accountId: string,
  number: string, signal: AbortSignal): Promise<AccountRechargeOrder> {
  if (orderNo(number) === null) throw new AccountFailure('invalid-input')
  const response = await protocol.read(`/payment/orders/${number}`, 'GET', undefined, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  if (response.status !== 200) throw new AccountFailure('unavailable')
  const order = rechargeOrderOf(response.payload, accountId, 'alipay')
  if (order.orderNo !== number) throw new AccountFailure('invalid-response')
  return order
}

/** Bounded Alipay history helps a legacy server recover a lost create response without another POST. */
export async function listAlipayOrders(protocol: AccountProtocol, access: string, accountId: string,
  signal: AbortSignal): Promise<AccountRechargeOrder[]> {
  const response = await protocol.read('/payment/orders?limit=30', 'GET', undefined, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  const body = record(response.payload)
  if (response.status !== 200 || body?.ok !== true || !Array.isArray(body.items) || body.items.length > 30) {
    throw new AccountFailure('unavailable')
  }
  if (body.items.some(item => String(record(item)?.account_id) !== accountId)) throw new AccountFailure('invalid-response')
  return body.items.filter(item => record(item)?.gateway === 'alipay')
    .map(item => rechargeOrderOf(item, accountId, 'alipay'))
}

/** Reissue signed cashier fields for one pending order; never create a new order. */
export async function retryAlipayPayment(protocol: AccountProtocol, access: string, accountId: string,
  number: string, amount: string, signal: AbortSignal): Promise<AccountPayment> {
  if (orderNo(number) === null) throw new AccountFailure('invalid-input')
  const response = await protocol.read(`/payment/orders/${number}/payment`, 'POST', {}, access, signal)
  if (response.status === 401 || response.status === 403) throw new AccountFailure('auth-required')
  if (response.status !== 200) throw new AccountFailure('unavailable')
  const order = rechargeOrderOf(response.payload, accountId, 'alipay')
  if (order.orderNo !== number || order.amount !== amount || order.status !== 'pending'
    || order.expiresAt === null || order.expiresAt <= Date.now()) throw new AccountFailure('invalid-response')
  return alipayPaymentOf(response.payload, order.orderNo, amount)
}
