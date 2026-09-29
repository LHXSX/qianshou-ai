/** Shanghai CNY checkout. Legacy gateway SP funds never pay this contract. */
import type { AccountClient } from '@deepseek-ai/dsh-client-account'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

export interface CnyWallet { readonly currency: 'CNY'; readonly balanceFen: number; readonly balanceYuan: string }
export interface CnyQuote {
  readonly quoteId: string
  readonly accountId: string
  readonly tier: string
  readonly label: string
  readonly months: number
  readonly currency: 'CNY'
  readonly amountFen: number
  readonly amountYuan: string
  readonly monthlySp: number
  readonly expiresAt: string
}
export interface CnyQuoteResult {
  readonly quote: CnyQuote
  readonly wallet: CnyWallet & { readonly shortfallFen: number; readonly canPay: boolean }
}
export interface CnyOrder {
  readonly orderId: string
  readonly quoteId: string
  readonly accountId: string
  readonly tier: string
  readonly months: number
  readonly currency: 'CNY'
  readonly amountFen: number
  readonly amountYuan: string
  readonly status: 'fulfilling' | 'fulfilled' | 'requires-review'
  readonly paymentStatus: 'paid'
  readonly canRetry: boolean
  readonly subscription?: { readonly tier: string; readonly from: number; readonly to: number }
}
export interface PendingSubscription { readonly accountId: string; readonly key: string; readonly quote: CnyQuote }
export interface CnySubscriptionClient {
  wallet(signal: AbortSignal): Promise<CnyWallet>
  quote(tier: string, signal: AbortSignal): Promise<CnyQuoteResult>
  purchase(quote: CnyQuote, signal: AbortSignal): Promise<CnyOrder>
  pending(): PendingSubscription | null
  recover(signal: AbortSignal): Promise<CnyOrder | null>
  retry(order: CnyOrder, signal: AbortSignal): Promise<CnyOrder>
}
export class SubscriptionFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SubscriptionFailure' }
}
const CODE_ALIASES: Readonly<Record<string, string>> = {
  insufficient_balance: 'insufficient-balance', quote_expired: 'quote-expired',
  invalid_quote: 'invalid-quote', quote_not_found: 'invalid-quote', order_not_found: 'not-found',
}
// These exact Shanghai purchase errors are raised before the debit transaction can commit.
// Transport/config failures cannot prove that an earlier same-key attempt was unpaid.
const UNPAID_PURCHASE_CODES = new Set([
  'insufficient-balance', 'quote-expired', 'invalid-quote',
  'wallet_reconciliation_required', 'wallet_currency_conflict',
])
function failureMessage(code: string, path: string): string {
  const messages: Readonly<Record<string, string>> = {
    'insufficient-balance': '账户余额不足，充值后可以继续购买。',
    'quote-expired': '报价已过期，请重新确认价格。',
    'invalid-quote': '这次报价已失效，请重新查看并确认价格。',
    'not-found': '没有查到这笔订单。',
    'downgrade-not-allowed': '当前订阅有效期内暂不支持降级，请选择当前或更高档位。',
    'already-subscribed': '当前账号已拥有该订阅，无需重复购买。',
    wallet_reconciliation_required: '人民币余额需要核对，暂时无法支付。请联系客服。',
    wallet_currency_conflict: '账户余额的币种需要核对，暂时无法支付。请联系客服。',
    idempotency_conflict: '这次请求与原订单不一致，请查询原订单，勿再次付款。',
    quote_already_paid: '这次报价已有付款记录，请查询原订单，勿再次付款。',
    jwt_required: '请使用账号登录后继续。',
    'signed-out': '登录已过期，请重新登录。',
    account_unavailable: '当前账号暂时无法购买订阅，请联系客服。',
  }
  if (messages[code]) return messages[code]
  const orderRequest = path === 'subscriptions/purchase' || path.startsWith('subscriptions/orders/')
  if (orderRequest) return '暂时无法确认购买状态，请查询原订单，勿再次付款。'
  if (path === 'subscriptions/wallet') return '暂时无法读取人民币余额，请稍后重新查看。'
  if (['gateway_unavailable', 'checkout_unavailable', 'gateway_outcome_unknown', 'unavailable'].includes(code)) {
    return '订阅服务暂时无法连接，请稍后重新查看。'
  }
  return '暂时无法确认套餐报价，请稍后重新查看。'
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubscriptionFailure('invalid-response', '暂时无法确认购买信息，请重新查询。')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new SubscriptionFailure('invalid-response', '购买信息暂不完整。')
  return value
}
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SubscriptionFailure('invalid-response', '金额信息暂不完整。')
  return value
}
function money(row: Record<string, unknown>): { currency: 'CNY'; amountFen: number; amountYuan: string } {
  const amountFen = integer(row.amountFen); const amountYuan = text(row.amountYuan)
  if (row.currency !== 'CNY' || !/^\d+\.\d{2}$/u.test(amountYuan) || Math.round(Number(amountYuan) * 100) !== amountFen) throw new SubscriptionFailure('invalid-response', '暂时无法确认人民币报价。')
  return { currency: 'CNY', amountFen, amountYuan }
}
function parseQuote(value: unknown, owner: string): CnyQuote {
  const row = object(value); const accountId = text(row.accountId); const months = integer(row.months)
  const expiresAt = text(row.expiresAt)
  if (accountId !== owner || months !== 1 || !Number.isFinite(Date.parse(expiresAt))) throw new SubscriptionFailure('invalid-response', '报价身份或有效期不匹配。')
  return { quoteId: text(row.quoteId), accountId, tier: text(row.tier), label: text(row.label),
    months, ...money(row), monthlySp: integer(row.monthlySp), expiresAt }
}
function parseWallet(value: unknown): CnyWallet {
  const row = object(value); const balanceFen = integer(row.balanceFen); const balanceYuan = text(row.balanceYuan)
  if (row.currency !== 'CNY' || !/^\d+\.\d{2}$/u.test(balanceYuan) || Math.round(Number(balanceYuan) * 100) !== balanceFen) throw new SubscriptionFailure('invalid-response', '暂时无法读取账户余额。')
  return { currency: 'CNY', balanceFen, balanceYuan }
}
function parseOrder(value: unknown, owner: string, quote?: CnyQuote): CnyOrder {
  const row = object(value); const status = row.status; const amount = money(row)
  if (row.accountId !== owner || !['fulfilling', 'fulfilled', 'requires-review'].includes(String(status))
    || row.paymentStatus !== 'paid' || typeof row.canRetry !== 'boolean') throw new SubscriptionFailure('invalid-response', '订单状态待确认，请查询原订单。')
  const order: CnyOrder = { ...amount, orderId: text(row.orderId), quoteId: text(row.quoteId), accountId: owner,
    tier: text(row.tier), months: integer(row.months), status: status as CnyOrder['status'], paymentStatus: 'paid', canRetry: row.canRetry }
  if (quote && (order.quoteId !== quote.quoteId || order.tier !== quote.tier || order.months !== quote.months || order.amountFen !== quote.amountFen)) throw new SubscriptionFailure('invalid-response', '订单与确认的报价不匹配，请查询原订单。')
  if (status !== 'fulfilled') return order
  const sub = object(row.subscription); const from = integer(sub.from); const to = integer(sub.to)
  if (sub.tier !== order.tier || to <= from) throw new SubscriptionFailure('invalid-response', '权益正在确认，请查询原订单。')
  return { ...order, subscription: { tier: order.tier, from, to } }
}
/** Identity-guarded requests, single pending checkout, and durable recovery without storing tokens. */
export function createCnySubscriptionClient(options: {
  readonly client: AccountClient
  readonly accountId: () => string | null
  readonly fetch: typeof fetch
  readonly origin: string
  readonly timeoutMs: number
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}): CnySubscriptionClient {
  const memory = new Map<string, PendingSubscription>()
  const inFlight = new Map<string, Promise<CnyOrder>>()
  const keyOf = (owner: string): string => `qianshou.cny-purchase.v1.${owner}`
  const owner = (): string => { const id = options.accountId(); if (!id) throw new SubscriptionFailure('signed-out', '请先登录。'); return id }
  const current = (id: string, signal: AbortSignal): void => { signal.throwIfAborted(); if (options.accountId() !== id) throw new SubscriptionFailure('account-changed', '登录账号已切换。') }
  function pending(): PendingSubscription | null {
    const id = options.accountId(); if (!id) return null
    const live = memory.get(id); if (live) return live
    try {
      const raw = options.storage?.getItem(keyOf(id)); if (!raw) return null
      const row = object(JSON.parse(raw)); const key = text(row.key)
      if (row.accountId !== id || !/^[a-zA-Z0-9-]{16,80}$/u.test(key)) return null
      const value = { accountId: id, key, quote: parseQuote(row.quote, id) }; memory.set(id, value); return value
    } catch { return null }
  }
  const save = (value: PendingSubscription): void => {
    // A write must have a recovery anchor before any money can leave the account.
    if (options.storage) options.storage.setItem(keyOf(value.accountId), JSON.stringify(value))
    memory.set(value.accountId, value)
  }
  const clear = (id: string): void => { memory.delete(id); try { options.storage?.removeItem(keyOf(id)) } catch {} }
  async function request(path: string, external: AbortSignal, id: string, body?: unknown): Promise<Record<string, unknown>> {
    const signal = AbortSignal.any([external, AbortSignal.timeout(options.timeoutMs)])
    const send = async (): Promise<Response> => {
      current(id, signal)
      if (options.client.tokens.isAccessExpired()) { await options.client.refresh(); current(id, signal) }
      const token = options.client.tokens.readAccess(); if (!token) throw new SubscriptionFailure('signed-out', '登录已过期，请重新登录。')
      return options.fetch(new URL(`/account-api/api/v8/${path}`, options.origin), { method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
    }
    let response = await send(); current(id, signal)
    if (response.status === 401) { await options.client.refresh(); current(id, signal); response = await send(); current(id, signal) }
    const value: unknown = await response.json(); current(id, signal); const payload = object(value)
    if (!response.ok) {
      const detail = payload.detail && typeof payload.detail === 'object' ? object(payload.detail) : payload
      const rawCode = typeof detail.code === 'string' ? detail.code : response.status === 401 ? 'signed-out' : 'unavailable'
      const code = CODE_ALIASES[rawCode] ?? rawCode
      throw new SubscriptionFailure(code, failureMessage(code, path))
    }
    if (payload.ok !== true) throw new SubscriptionFailure('invalid-response', '购买结果待确认，请查询原订单。')
    return payload
  }
  const readOrder = async (path: string, signal: AbortSignal, id: string, quote?: CnyQuote, body?: unknown): Promise<CnyOrder> => {
    const order = parseOrder((await request(path, signal, id, body)).order, id, quote)
    if (order.status === 'fulfilled') clear(id)
    return order
  }
  return {
    pending,
    async wallet(signal) {
      const id = owner(); return parseWallet((await request('subscriptions/wallet', signal, id)).wallet)
    },
    async quote(tier, signal) {
      const id = owner(); const payload = await request('subscriptions/quote', signal, id, { tier, months: 1 })
      const quote = parseQuote(payload.quote, id); const raw = object(payload.wallet); const wallet = parseWallet(raw)
      const shortfallFen = integer(raw.shortfallFen)
      if (quote.tier !== tier || typeof raw.canPay !== 'boolean' || shortfallFen !== Math.max(0, quote.amountFen - wallet.balanceFen) || raw.canPay !== (shortfallFen === 0)) throw new SubscriptionFailure('invalid-response', '报价与余额信息不一致，请重新查询。')
      return { quote, wallet: { ...wallet, shortfallFen, canPay: raw.canPay } }
    },
    async purchase(quote, signal) {
      const id = owner(); current(id, signal); parseQuote(quote, id)
      const previous = pending()
      if (previous && previous.quote.quoteId !== quote.quoteId) throw new SubscriptionFailure('pending-order', '有一笔购买待确认，请先查看原订单。')
      const running = inFlight.get(id); if (running) return running
      const attempt = previous ?? { accountId: id, key: randomUUID(), quote }
      save(attempt)
      const work = readOrder('subscriptions/purchase', signal, id, quote, { quoteId: quote.quoteId, idempotencyKey: attempt.key })
      inFlight.set(id, work)
      try { return await work }
      catch (error) {
        if (error instanceof SubscriptionFailure && UNPAID_PURCHASE_CODES.has(error.code)) clear(id)
        throw error
      } finally { inFlight.delete(id) }
    },
    async recover(signal) {
      const id = owner(); const attempt = pending(); if (!attempt) return null
      try { return await readOrder(`subscriptions/orders/by-key/${encodeURIComponent(attempt.key)}`, signal, id, attempt.quote) }
      catch (error) { if (error instanceof SubscriptionFailure && error.code === 'not-found') return null; throw error }
    },
    async retry(order, signal) {
      const id = owner(); if (order.accountId !== id || !order.canRetry) throw new SubscriptionFailure('retry-unavailable', '这笔订单暂不能重试，请查询状态。')
      return readOrder(`subscriptions/orders/${encodeURIComponent(order.orderId)}/retry`, signal, id, pending()?.quote, {})
    },
  }
}
