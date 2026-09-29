/** Account-bound commerce facts and explicit subscription writes; Shanghai and gateway balances stay separate. */
import { accountCopy as t } from './account-copy.ts'
import { createCnySubscriptionClient, type CnySubscriptionClient } from './account-subscription-client.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { AccountFailure, type AccountClient } from '@deepseek-ai/dsh-client-account'
import { createRechargeClient, type RechargeClient } from './account-recharge-client.ts'

/** Server-supplied subscription offer. */
export interface CommercePlan {
  readonly id: string
  readonly label: string
  readonly monthlyYuan: number | null
  readonly monthlySp: number | null
}
/** Gateway quota and price facts; missing values never acquire local defaults. */
export interface CommerceStatus {
  readonly windowLimitSp?: number | null
  readonly usedInWindowSp?: number | null
  readonly tierId: string | null
  readonly tierLabel: string
  readonly remainingSp: number | null
  readonly purchasableSp: number | null
  readonly spPerYuanCost?: number | null
  readonly plans: readonly CommercePlan[]
}
/** Shanghai reports whether an online payment channel is configured. */
export interface PaymentChannel {
  readonly gateway: string
  readonly mode: string
  readonly available: boolean
  readonly reason: string | null
}
/** Shanghai account-owned recharge record; pending never means credited. */
export interface PaymentOrder {
  readonly orderNo: string
  readonly amount: string
  readonly currency: string
  readonly gateway: string
  readonly status: string
  readonly createdAt: string | null
}
/** A confirmed gateway subscription receipt. */
export interface SubscriptionReceipt {
  readonly orderId: string
  readonly spentSp: number
  readonly to: number | null
}
/** Explicit user purchase, quoted using the current server catalog. */
export interface SubscriptionPurchase {
  readonly tier: string
  readonly monthlyYuan: number
  readonly costSp: number
}
/** Optional methods let read-only embeds keep payment unavailable without inventing capability. */
export interface CommerceReader {
  readonly subscription?: CnySubscriptionClient
  readonly recharge?: RechargeClient
  readonly status: (signal: AbortSignal) => Promise<CommerceStatus>
  readonly channels?: (signal: AbortSignal) => Promise<readonly PaymentChannel[]>
  readonly orders?: (signal: AbortSignal) => Promise<readonly PaymentOrder[]>
  readonly subscribe?: (purchase: SubscriptionPurchase, signal: AbortSignal) => Promise<SubscriptionReceipt>
}
/** An action may have reached the server even when its response was lost. */
export class CommerceFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CommerceFailure' }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null }
function parseStatus(payload: Record<string, unknown>): CommerceStatus {
  if (payload.ok !== true) throw new Error('COMMERCE_RESPONSE_INVALID')
  const tier = object(payload.tier); const credit = object(payload.credit)
  const plans = (Array.isArray(payload.plans) ? payload.plans : []).map((raw): CommercePlan | null => {
    const row = object(raw); if (!row) return null
    const id = text(row.id); const label = text(row.label)
    return id && label ? { id, label, monthlyYuan: number(row.monthlyYuan), monthlySp: number(row.monthlySp) } : null
  }).filter((row): row is CommercePlan => row !== null)
  return { ...(credit?.windowLimitSp === undefined ? {} : { windowLimitSp: number(credit.windowLimitSp), usedInWindowSp: number(credit.usedInWindowSp) }), tierId: text(tier?.id), tierLabel: text(tier?.label) ?? '', remainingSp: number(credit?.remainingSp),
    purchasableSp: number(credit?.purchasableSp), spPerYuanCost: number(object(payload.prices)?.spPerYuanCost), plans }
}
/**
 * Uses existing same-origin Shanghai payment reads and the gateway subscription endpoint.
 * @param options - Shared caller tokens, verified identity and bounded transport.
 * @returns Account-bound reader with an explicit, idempotent one-month purchase operation.
 */
export function createCommerceReader(options: {
  readonly client: AccountClient
  readonly accountId: () => string | null
  readonly fetch: typeof fetch
  readonly origin: string
  readonly timeoutMs: number
}): CommerceReader {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('COMMERCE_READ_TIMEOUT_INVALID')
  const attempts = new Map<string, { key: string; sent?: boolean; pending?: Promise<SubscriptionReceipt> }>()
  const request = async (path: string, signal: AbortSignal, account: string, body?: unknown): Promise<Record<string, unknown>> => {
    const current = (): void => { signal.throwIfAborted(); if (options.accountId() !== account) throw new Error('ACCOUNT_CHANGED') }
    const send = async (): Promise<Response> => {
      current()
      if (options.client.tokens.isAccessExpired()) { await options.client.refresh(); current() }
      const token = options.client.tokens.readAccess()
      if (!token) throw new AccountFailure('unauthorized', '', { status: 401 })
      return options.fetch(new URL(path, options.origin), { method: body === undefined ? 'GET' : 'POST', signal,
        credentials: 'omit', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    }
    let response = await send(); current()
    if (response.status === 401) { await options.client.refresh(); current(); response = await send(); current() }
    if (response.status === 404) throw new Error('COMMERCE_ROUTE_UNAVAILABLE')
    const payload = object(await response.json()); current()
    if (!response.ok) {
      if (path.endsWith('/subscription/purchase')) {
        throw new CommerceFailure(text(payload?.code) ?? 'purchase_unconfirmed', text(payload?.message) ?? t.purchaseUnconfirmed)
      }
      throw new AccountFailure(response.status === 401 ? 'unauthorized' : response.status === 429 ? 'rate-limited' : 'server-error', '', { status: response.status })
    }
    if (!payload) throw new Error('COMMERCE_RESPONSE_INVALID')
    return payload
  }
  const identity = (): string => { const id = options.accountId(); if (id === null) throw new Error('ACCOUNT_REQUIRED'); return id }
  const scoped = (external: AbortSignal): AbortSignal => AbortSignal.any([external, AbortSignal.timeout(options.timeoutMs)])
  const status = async (external: AbortSignal): Promise<CommerceStatus> => parseStatus(await request('/api/qianshou/ai/status', scoped(external), identity(), {}))
  return {
    recharge: createRechargeClient(options),
    status,
    subscription: createCnySubscriptionClient({ ...options, ...(typeof localStorage === 'undefined' ? {} : { storage: localStorage }) }),
    channels: async (external) => {
      const payload = await request('/account-api/api/v8/payment/channels', scoped(external), identity())
      if (!Array.isArray(payload.items)) throw new Error('COMMERCE_RESPONSE_INVALID')
      return payload.items.map((item: unknown) => {
        const row = object(item)
        const gateway = text(row?.gateway); const mode = text(row?.mode)
        if (!row || gateway === null || mode === null || typeof row.available !== 'boolean') throw new Error('COMMERCE_RESPONSE_INVALID')
        return { gateway, mode, available: row.available, reason: text(row.reason) }
      })
    },
    orders: async (external) => {
      const owner = identity(); const payload = await request('/account-api/api/v8/payment/orders?limit=30', scoped(external), owner)
      if (!Array.isArray(payload.items)) throw new Error('COMMERCE_RESPONSE_INVALID')
      return payload.items.map((item: unknown) => {
        const row = object(item)
        const orderNo = text(row?.order_no); const currency = text(row?.currency)
        const gateway = text(row?.gateway); const status = text(row?.status)
        if (!row || String(row.account_id) !== owner || orderNo === null || currency === null
          || gateway === null || status === null || typeof row.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.amount)) throw new Error('COMMERCE_RESPONSE_INVALID')
        return { orderNo, amount: row.amount, currency, gateway,
          status, createdAt: text(row.created_at) }
      })
    },
    subscribe: async (purchase, external) => {
      const owner = identity(); const attemptId = `${owner}:${purchase.tier}`
      let attempt = attempts.get(attemptId)
      if (attempt?.pending) return attempt.pending
      if (!attempt) { attempt = { key: randomUUID() }; attempts.set(attemptId, attempt) }
      const key = attempt.key
      const work = async (): Promise<SubscriptionReceipt> => {
        const signal = scoped(external)
        if (!attempt.sent) {
          const latest = parseStatus(await request('/api/qianshou/ai/status', signal, owner, {}))
          const plan = latest.plans.find(row => row.id === purchase.tier)
          const rate = latest.spPerYuanCost
          if (!plan || plan.id === 'free' || plan.monthlyYuan === null || !rate || plan.monthlyYuan !== purchase.monthlyYuan
          || Math.round(plan.monthlyYuan * rate) !== purchase.costSp) throw new CommerceFailure('price_changed', t.planChanged)
          if (latest.purchasableSp === null || latest.purchasableSp < purchase.costSp) throw new CommerceFailure('insufficient-balance', t.subscriptionInsufficient)
        }
        attempt.sent = true
        const result = await request('/api/qianshou/ai/subscription/purchase', signal, owner,
          { kind: 'subscribe', tier: purchase.tier, months: 1, idempotencyKey: key })
        const order = object(result.order); const subscription = object(result.subscription)
        const orderId = text(order?.orderId); const spentSp = number(order?.sp)
        if (result.ok !== true || orderId === null || spentSp === null) {
          throw new CommerceFailure('receipt_unconfirmed', t.receiptUnconfirmed)
        }
        attempts.delete(attemptId)
        return { orderId, spentSp, to: number(subscription?.to) }
      }
      attempt.pending = work()
      try { return await attempt.pending }
      finally { delete attempt.pending }
    },
  }
}
