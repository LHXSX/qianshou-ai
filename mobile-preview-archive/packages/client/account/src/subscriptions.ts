/** Shanghai CNY checkout. Legacy gateway SP funds never pay this contract. */

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
export class SubscriptionFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SubscriptionFailure' }
}
export const CODE_ALIASES: Readonly<Record<string, string>> = {
  insufficient_balance: 'insufficient-balance', quote_expired: 'quote-expired',
  invalid_quote: 'invalid-quote', quote_not_found: 'invalid-quote', order_not_found: 'not-found',
}
// These exact Shanghai purchase errors are raised before the debit transaction can commit.
// Transport/config failures cannot prove that an earlier same-key attempt was unpaid.
export const UNPAID_PURCHASE_CODES = new Set([
  'insufficient-balance', 'quote-expired', 'invalid-quote',
  'wallet_reconciliation_required', 'wallet_currency_conflict',
])
export function failureMessage(code: string, path: string): string {
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
export function parseQuote(value: unknown, owner: string): CnyQuote {
  const row = object(value); const accountId = text(row.accountId); const months = integer(row.months)
  const expiresAt = text(row.expiresAt)
  if (accountId !== owner || months !== 1 || !Number.isFinite(Date.parse(expiresAt))) throw new SubscriptionFailure('invalid-response', '报价身份或有效期不匹配。')
  return { quoteId: text(row.quoteId), accountId, tier: text(row.tier), label: text(row.label),
    months, ...money(row), monthlySp: integer(row.monthlySp), expiresAt }
}
export function parseWallet(value: unknown): CnyWallet {
  const row = object(value); const balanceFen = integer(row.balanceFen); const balanceYuan = text(row.balanceYuan)
  if (row.currency !== 'CNY' || !/^\d+\.\d{2}$/u.test(balanceYuan) || Math.round(Number(balanceYuan) * 100) !== balanceFen) throw new SubscriptionFailure('invalid-response', '暂时无法读取账户余额。')
  return { currency: 'CNY', balanceFen, balanceYuan }
}
export function parseOrder(value: unknown, owner: string, quote?: CnyQuote): CnyOrder {
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

/** Owner-host scope is an opaque generation, not an account authorization credential. */
export interface SubscriptionScope { readonly accountId: string; readonly revision: string }
export const SUBSCRIPTION_PREFIX = '/api/qianshou/account/subscriptions/'
export const SUBSCRIPTION_ACTIONS = ['scope', 'wallet', 'quote', 'purchase', 'pending', 'order-by-key', 'order', 'retry'] as const
export type SubscriptionAction = typeof SUBSCRIPTION_ACTIONS[number]
export function parseSubscriptionScope(value: unknown): SubscriptionScope {
  const row = object(value)
  return { accountId: text(row.accountId), revision: text(row.revision) }
}
export function parsePendingSubscription(value: unknown, owner: string): PendingSubscription | null {
  if (value === null) return null
  const row = object(value); const key = text(row.key)
  if (row.accountId !== owner || !/^[A-Za-z0-9_-]{16,96}$/u.test(key)) throw new SubscriptionFailure('invalid-response', '订单恢复信息不匹配。')
  return { accountId: owner, key, quote: parseQuote(row.quote, owner) }
}
export function parseQuoteResult(value: unknown, owner: string, tier: string): CnyQuoteResult {
  const row = object(value); const quote = parseQuote(row.quote, owner)
  const raw = object(row.wallet); const wallet = parseWallet(raw); const shortfallFen = integer(raw.shortfallFen)
  if (quote.tier !== tier || typeof raw.canPay !== 'boolean' || shortfallFen !== Math.max(0, quote.amountFen - wallet.balanceFen)
    || raw.canPay !== (shortfallFen === 0)) throw new SubscriptionFailure('invalid-response', '报价与余额信息不一致。')
  return { quote, wallet: { ...wallet, shortfallFen, canPay: raw.canPay } }
}
/** Only the transport differs between an owner desktop and a caller-Bearer mobile client. */
export type SubscriptionTransport = (
  action: SubscriptionAction, payload: Readonly<Record<string, unknown>>, signal: AbortSignal
) => Promise<unknown>
export function createOwnerSubscriptionClient(transport: SubscriptionTransport) {
  const request = async (action: SubscriptionAction, scope: SubscriptionScope, payload: Record<string, unknown>, signal: AbortSignal) =>
    object(await transport(action, { ...payload, scope }, signal))
  return {
    async scope(signal: AbortSignal): Promise<SubscriptionScope> { return parseSubscriptionScope(object(await transport('scope', {}, signal)).scope) },
    async wallet(scope: SubscriptionScope, signal: AbortSignal): Promise<CnyWallet> { return parseWallet((await request('wallet', scope, {}, signal)).wallet) },
    async quote(scope: SubscriptionScope, tier: string, signal: AbortSignal): Promise<CnyQuoteResult> {
      return parseQuoteResult(await request('quote', scope, { tier, months: 1 }, signal), scope.accountId, tier)
    },
    async pending(scope: SubscriptionScope, signal: AbortSignal): Promise<PendingSubscription | null> {
      return parsePendingSubscription((await request('pending', scope, {}, signal)).pending, scope.accountId)
    },
    async purchase(scope: SubscriptionScope, quote: CnyQuote, key: string, signal: AbortSignal): Promise<CnyOrder> {
      parseQuote(quote, scope.accountId)
      return parseOrder((await request('purchase', scope, { quoteId: quote.quoteId, idempotencyKey: key }, signal)).order, scope.accountId, quote)
    },
    async recover(scope: SubscriptionScope, pending: PendingSubscription, signal: AbortSignal): Promise<CnyOrder | null> {
      try { return parseOrder((await request('order-by-key', scope, { idempotencyKey: pending.key }, signal)).order, scope.accountId, pending.quote) }
      catch (error) { if (error instanceof SubscriptionFailure && error.code === 'not-found') return null; throw error }
    },
    async retry(scope: SubscriptionScope, order: CnyOrder, signal: AbortSignal): Promise<CnyOrder> {
      if (order.accountId !== scope.accountId || !order.canRetry) throw new SubscriptionFailure('retry-unavailable', '请查询原订单。')
      return parseOrder((await request('retry', scope, { orderId: order.orderId }, signal)).order, scope.accountId)
    },
  }
}
