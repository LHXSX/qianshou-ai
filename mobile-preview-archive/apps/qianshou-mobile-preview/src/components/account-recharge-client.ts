/** Shanghai CNY recharge; pending/unknown writes never become a second order automatically. */
import type { AccountClient } from '@deepseek-ai/dsh-client-account'

export interface RechargeOrder {
  readonly orderNo: string
  readonly accountId: string
  readonly amount: string
  readonly gateway: RechargeGateway
  readonly status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired'
  readonly expiresAt: number | null
}
export type RechargeGateway = 'alipay' | 'wechat_pay'
export interface AlipayInstructions {
  readonly kind: 'alipay-page'
  readonly action: string
  readonly params: Readonly<Record<string, string>>
}
export interface WechatNativeInstructions {
  readonly kind: 'wechat-native'
  readonly codeUrl: string
}
export type RechargeInstructions = AlipayInstructions | WechatNativeInstructions
export interface RechargeState {
  readonly order: RechargeOrder | null
  readonly unknown: boolean
  readonly locked: boolean
}
export interface RechargeOverview {
  readonly balance: string | null
  readonly channels: Readonly<Record<RechargeGateway, { readonly available: boolean; readonly reason: string | null }>>
}
/** Owned by the account composition, so changing pages does not lose a pending write. */
export interface RechargeClient {
  readonly accountId: () => string | null
  readonly snapshot: () => RechargeState
  readonly load: (signal: AbortSignal) => Promise<RechargeOverview>
  readonly refresh: (signal: AbortSignal) => Promise<RechargeState>
  readonly create: (amount: string, gateway: RechargeGateway, signal: AbortSignal) => Promise<RechargeInstructions>
  readonly payment: (signal: AbortSignal) => Promise<RechargeInstructions>
}
export class RechargeFailure extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'unknown' | 'pending' | 'account' | 'storage') {
    super(`RECHARGE_${code.toUpperCase()}`)
    this.name = 'RechargeFailure'
  }
}
function invalid(): never { throw new RechargeFailure('invalid') }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
const orderNumber = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(value)) invalid()
  return value
}
/** Validate yuan exactly to cents before any write; no rounding or invented minimum. */
export function rechargeAmount(value: string): string {
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/u.test(value)) invalid()
  const [whole = '', decimal = ''] = value.split('.')
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'))
  if (cents < 1 || cents > 100_000_000) invalid()
  return `${whole}.${decimal.padEnd(2, '0')}`
}
/** Database Decimal strings can include extra zero scale, but fractional cents remain invalid. */
function wireAmount(value: string): string {
  if (!/^\d{1,7}(?:\.\d{1,12})?$/u.test(value)) invalid()
  const normalized = value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value
  return rechargeAmount(normalized)
}
function parseOrder(value: unknown, owner: string): RechargeOrder {
  const row = object(value)
  if (String(row.account_id) !== owner || (row.gateway !== 'alipay' && row.gateway !== 'wechat_pay') || row.currency !== 'CNY') invalid()
  const statuses = ['pending', 'paid', 'failed', 'cancelled', 'expired'] as const
  if (!statuses.includes(row.status as typeof statuses[number]) || typeof row.amount !== 'string') invalid()
  const expiresAt = row.expired_at == null ? null : typeof row.expired_at === 'string' ? Date.parse(row.expired_at) : NaN
  if (expiresAt !== null && !Number.isFinite(expiresAt)) invalid()
  return { orderNo: orderNumber(row.order_no), accountId: owner, amount: wireAmount(row.amount), gateway: row.gateway,
    status: row.status as RechargeOrder['status'], expiresAt }
}
/** Validate the server's signed data without changing its signed strings. */
export function alipayInstructions(value: unknown, order: RechargeOrder): AlipayInstructions {
  const instruction = object(value)
  if (order.gateway !== 'alipay' || instruction.mode !== 'alipay_page' || instruction.method !== 'POST'
    || instruction.action !== 'https://openapi.alipay.com/gateway.do?charset=utf-8') invalid()
  const raw = object(instruction.params)
  const keys = ['app_id', 'method', 'format', 'charset', 'sign_type', 'version', 'timestamp', 'notify_url', 'return_url', 'biz_content', 'sign']
  const params: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key) || typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u001f]/u.test(value)) invalid()
    params[key] = value
  }
  if (!/^\d{10,32}$/u.test(params.app_id ?? '') || params.method !== 'alipay.trade.page.pay'
    || params.charset !== 'utf-8' || params.sign_type !== 'RSA2' || params.version !== '1.0'
    || (params.format !== undefined && params.format !== 'JSON') || !/^[A-Za-z0-9+/]{64,2048}={0,2}$/u.test(params.sign ?? '')
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(params.timestamp ?? '')
    || params.notify_url !== 'https://qianshousuanli.com/api/v8/payment/notify/alipay') invalid()
  if (params.return_url !== undefined) {
    const url = new URL(params.return_url)
    if (url.origin !== 'https://qianshousuanli.com' || url.username || url.password) invalid()
  }
  const biz: unknown = JSON.parse(params.biz_content ?? '')
  const content = object(biz)
  if (order.status !== 'pending' || order.expiresAt === null || order.expiresAt <= Date.now()
    || content.out_trade_no !== order.orderNo || content.total_amount !== order.amount
    || content.passback_params !== `account_${order.accountId}` || content.product_code !== 'FAST_INSTANT_TRADE_PAY'
    || typeof content.subject !== 'string' || !content.subject || content.subject.length > 256
    || typeof content.time_expire !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(content.time_expire)) invalid()
  if (Date.parse(`${content.time_expire.replace(' ', 'T')}+08:00`) !== Math.floor(order.expiresAt / 1000) * 1000) invalid()
  return { kind: 'alipay-page', action: instruction.action, params }
}
/** Native WeChat instructions are a QR payload, never a same-phone payment deep link. */
export function wechatNativeInstructions(value: unknown, order: RechargeOrder): WechatNativeInstructions {
  const instruction = object(value)
  const codeUrl = instruction.code_url
  if (order.gateway !== 'wechat_pay' || order.status !== 'pending' || order.expiresAt === null || order.expiresAt <= Date.now()
    || instruction.mode !== 'wechat_native' || typeof codeUrl !== 'string' || codeUrl.length > 2048
    || !/^weixin:\/\/wxpay\/bizpayurl\?/u.test(codeUrl) || /[\u0000-\u0020\u007f]/u.test(codeUrl)) invalid()
  return { kind: 'wechat-native', codeUrl }
}
function instructions(value: unknown, order: RechargeOrder): RechargeInstructions {
  return order.gateway === 'alipay' ? alipayInstructions(value, order) : wechatNativeInstructions(value, order)
}
interface Marker { accountId: string; orderNo: string | null; amount: string | null; gateway: RechargeGateway }
interface AccountState { marker: Marker | null; order: RechargeOrder | null; busy: boolean }
/**
 * @param options Existing account credentials and same-origin Shanghai proxy; storage contains only order recovery identifiers.
 * @returns A client that never retries a financial POST automatically and never credits an account locally.
 */
export function createRechargeClient(options: {
  readonly client: AccountClient
  readonly accountId: () => string | null
  readonly fetch: typeof fetch
  readonly origin: string
  readonly timeoutMs: number
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}): RechargeClient {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) invalid()
  const states = new Map<string, AccountState>()
  const identity = (): string => { const id = options.accountId(); if (!id || !/^\d+$/u.test(id)) throw new RechargeFailure('account'); return id }
  const storage = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => options.storage ?? sessionStorage
  const key = (owner: string): string => `qianshou.mobile.recharge.${owner}`
  const stateFor = (owner: string): AccountState => {
    let state = states.get(owner)
    if (!state) {
      let marker: Marker | null = null
      try {
        const saved = storage().getItem(key(owner))
        if (saved) {
          const value: unknown = JSON.parse(saved)
          const row = object(value)
          if (row.accountId !== owner) invalid()
          marker = { accountId: owner, orderNo: row.orderNo === null ? null : orderNumber(row.orderNo),
            amount: row.amount === null ? null : rechargeAmount(String(row.amount)),
            gateway: row.gateway === undefined || row.gateway === 'alipay' ? 'alipay' : row.gateway === 'wechat_pay' ? 'wechat_pay' : invalid() }
        }
      } catch { marker = { accountId: owner, orderNo: null, amount: null, gateway: 'alipay' } }
      state = { marker, order: null, busy: false }; states.set(owner, state)
    }
    return state
  }
  const save = (owner: string, state: AccountState, marker: Marker | null): void => {
    state.marker = marker
    try {
      if (marker) storage().setItem(key(owner), JSON.stringify(marker))
      else storage().removeItem(key(owner))
    } catch { throw new RechargeFailure('storage') }
  }
  const snapshot = (): RechargeState => {
    const state = stateFor(identity())
    return { order: state.order, unknown: state.marker !== null && state.marker.orderNo === null,
      locked: state.busy || state.marker !== null || state.order?.status === 'pending' }
  }
  const request = async (owner: string, path: string, external: AbortSignal, body?: unknown): Promise<Record<string, unknown>> => {
    const signal = AbortSignal.any([external, AbortSignal.timeout(options.timeoutMs)])
    const current = (): void => { signal.throwIfAborted(); if (identity() !== owner) throw new RechargeFailure('account') }
    current()
    if (options.client.tokens.isAccessExpired()) { await options.client.refresh(); current() }
    const access = options.client.tokens.readAccess()
    if (!access) throw new RechargeFailure('account')
    const response = await options.fetch(new URL(`/account-api/api/v8/payment${path}`, options.origin), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', signal,
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    current()
    if (!response.body) invalid()
    const reader = response.body.getReader()
    let length = 0, text = ''
    const decoder = new TextDecoder()
    try {
      while (true) {
        const part = await reader.read(); current()
        if (part.done) break
        length += part.value.byteLength
        if (length > 131_072) invalid()
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
    const raw: unknown = JSON.parse(text)
    const payload = object(raw)
    if (!response.ok) {
      if (body !== undefined && response.status === 502) {
        const detail = object(payload.detail)
        if (detail.code === 'payment_request_unknown' || detail.code === 'payment_parameters_rejected') {
          const state = stateFor(owner)
          const orderNo = orderNumber(detail.order_no)
          if (state.marker?.orderNo && state.marker.orderNo !== orderNo) invalid()
          save(owner, state, { accountId: owner, orderNo, amount: state.marker?.amount ?? null, gateway: state.marker?.gateway ?? 'alipay' })
          throw new RechargeFailure('unknown')
        }
      }
      throw new RechargeFailure('unavailable')
    }
    return payload
  }
  const updateOrder = (owner: string, state: AccountState, value: unknown): RechargeOrder => {
    const order = parseOrder(value, owner)
    if ((state.marker?.orderNo && state.marker.orderNo !== order.orderNo)
      || (state.marker && state.marker.gateway !== order.gateway)
      || (state.marker?.amount && state.marker.amount !== order.amount)) invalid()
    state.order = order
    save(owner, state, order.status === 'pending' ? { accountId: owner, orderNo: order.orderNo, amount: order.amount, gateway: order.gateway } : null)
    return order
  }
  const refresh = async (signal: AbortSignal): Promise<RechargeState> => {
    const owner = identity(), state = stateFor(owner)
    if (state.marker?.orderNo) updateOrder(owner, state, await request(owner, `/orders/${state.marker.orderNo}`, signal))
    else {
      const payload = await request(owner, '/orders?limit=100', signal)
      if (!Array.isArray(payload.items) || payload.items.length > 100) invalid()
      for (const raw of payload.items) {
        const row = object(raw)
        if (String(row.account_id) !== owner) invalid()
        if (row.gateway !== 'alipay' && row.gateway !== 'wechat_pay') continue
        const order = parseOrder(row, owner)
        if (order.status === 'pending' && !state.marker) { updateOrder(owner, state, row); break }
      }
      // A lost POST with no order number cannot be disproved by a possibly lagging, bounded history page.
    }
    return snapshot()
  }
  const load = async (signal: AbortSignal): Promise<RechargeOverview> => {
    const owner = identity()
    const [channels, account] = await Promise.all([request(owner, '/channels', signal), options.client.me(signal), refresh(signal)])
    signal.throwIfAborted()
    if (identity() !== owner || (account && String(account.id) !== owner)) throw new RechargeFailure('account')
    if (!Array.isArray(channels.items) || channels.items.length > 20) invalid()
    const listed = channels.items.map(object)
    const channel = (gateway: RechargeGateway, mode: string) => {
      const row = listed.find(item => item.gateway === gateway)
      return { available: row?.available === true && row.mode === mode,
        reason: typeof row?.reason === 'string' ? row.reason.slice(0, 300) : null }
    }
    const balance = account?.balance
    return { channels: { alipay: channel('alipay', 'alipay_page'), wechat_pay: channel('wechat_pay', 'wechat_native') },
      balance: balance !== null && balance !== undefined && /^\d{1,12}(?:\.\d{1,12})?$/u.test(String(balance))
      ? Number(balance).toFixed(2) : null }
  }
  const create = async (input: string, gateway: RechargeGateway, signal: AbortSignal): Promise<RechargeInstructions> => {
    const owner = identity(), state = stateFor(owner)
    if (snapshot().locked) throw new RechargeFailure('pending')
    const amount = rechargeAmount(input)
    state.busy = true
    try {
      const overview = await load(signal)
      if (state.marker || state.order?.status === 'pending') throw new RechargeFailure('pending')
      if (!overview.channels[gateway].available) throw new RechargeFailure('unavailable')
      save(owner, state, { accountId: owner, orderNo: null, amount, gateway })
      const result = await request(owner, '/recharge', signal, { amount, gateway, remark: '' })
      const order = updateOrder(owner, state, result)
      return instructions(result.payment, order)
    } finally { state.busy = false }
  }
  const payment = async (signal: AbortSignal): Promise<RechargeInstructions> => {
    const owner = identity(), state = stateFor(owner)
    if (state.busy) throw new RechargeFailure('pending')
    state.busy = true
    try {
      await refresh(signal)
      const order = state.order
      if (!order || order.status !== 'pending' || !state.marker?.orderNo) throw new RechargeFailure('unknown')
      const result = await request(owner, `/orders/${order.orderNo}/payment`, signal, {})
      return instructions(result.payment, updateOrder(owner, state, result))
    } finally { state.busy = false }
  }
  return { accountId: options.accountId, snapshot, load, refresh, create, payment }
}
/** Build a reviewed gateway POST with text inputs only; callers require a separate explicit payment click. */
export function createAlipayForm(payment: AlipayInstructions, order: RechargeOrder): HTMLFormElement {
  alipayInstructions({ mode: 'alipay_page', method: 'POST', ...payment }, order)
  const form = document.createElement('form')
  form.method = 'POST'; form.action = payment.action; form.acceptCharset = 'utf-8'; form.target = '_blank'; form.rel = 'noopener noreferrer'
  for (const [name, value] of Object.entries(payment.params)) {
    const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input)
  }
  return form
}
