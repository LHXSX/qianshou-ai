/** Account interaction state; all identity and credential decisions remain on the Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { AccountSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

import type {} from './account-events.ts'

/** UI state never stores passwords or TOTP input. */
/** Plan and wallet figures returned by the Host. Missing numbers stay null. */
export interface AccountCommerceView {
  tierLabel: string
  remainingSp: number | null
  windowLimitSp: number | null
  usedInWindowSp: number | null
  balanceYuan: string | null
  plans: readonly { id: string; label: string; monthlyYuan: number | null; monthlySp: number | null }[]
  quote: { label: string; amountYuan: string; monthlySp: number; canPay: boolean } | null
  notice: 'insufficient-balance' | 'quote-expired' | 'downgrade-not-allowed' | 'unavailable' | 'paid' | null
}

/** Reviewed Alipay page fields. The browser submits them; it does not invent them. */
export interface AccountPaymentView {
  action: string
  fields: readonly { name: string; value: string }[]
}

export interface AccountRechargeOrderView {
  orderNo: string
  amount: string
  status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed'
  createdAt: number
  expiresAt: number | null
}
export type AccountAlipayStartView =
  | { kind: 'ready'; order: AccountRechargeOrderView; payment: AccountPaymentView; reused?: boolean }
  | { kind: 'order'; order: AccountRechargeOrderView }
  | { kind: 'unknown'; orderNo: string | null }
  | { kind: 'conflict' }
  | { kind: 'rejected' }

/** Detached Shanghai WeChat order. A QR payload is never sent to a third-party image service. */
export interface AccountWechatOrderView {
  orderNo: string
  amount: string
  status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed'
  createdAt: number
  expiresAt: number | null
  codeUrl: string | null
  providerState?: 'SUCCESS' | 'NOTPAY' | 'CLOSED' | 'REFUND' | 'REVOKED' | 'USERPAYING' | 'PAYERROR'
}
export type AccountWechatStartView =
  | { kind: 'ready'; order: AccountWechatOrderView; reused?: boolean }
  | { kind: 'unknown'; orderNo: string | null }
  | { kind: 'conflict' }
  | { kind: 'rejected' }

/** UI state never stores passwords or TOTP input. */
export interface AccountViewState {
  snapshot: AccountSnapshot | null
  commerce: AccountCommerceView | null
  payment: AccountPaymentView | null
  alipayOrder: AccountRechargeOrderView | null
  busy: boolean
  authorizing: boolean
  commerceBusy: boolean
  commerceFailed: boolean
  paymentBusy: boolean
  paymentFailed: boolean
  wechatChannel: boolean | null
  wechatRechargeIdempotency: boolean
  wechatChannelBusy: boolean
  wechatChannelFailed: boolean
  wechatOrder: AccountWechatOrderView | null
  wechatBusy: boolean
  wechatFailed: boolean
  /** Account status and authentication failures only. */
  failed: boolean
}

/** Coordinate button actions and discard stale status reads after a newer user action. */
export class AccountController {
  /** Safe account status and interaction progress shared by both entry points. */
  readonly store = createSnapshotStore<AccountViewState>({
    snapshot: null, commerce: null, payment: null, alipayOrder: null, busy: false, authorizing: false,
    commerceBusy: false, commerceFailed: false, paymentBusy: false, paymentFailed: false,
    wechatChannel: null, wechatRechargeIdempotency: false, wechatChannelBusy: false, wechatChannelFailed: false,
    wechatOrder: null, wechatBusy: false, wechatFailed: false, failed: false,
  })
  private revision = 0
  private restoreAttempted = false
  constructor(private readonly ctx: Context) {}

  private async run(operation: () => ReturnType<Context['remote']['qianshouAccount']['state']>, authorizing = false): Promise<void> {
    const revision = ++this.revision
    this.store.set({ ...this.store.getSnapshot(), busy: true, authorizing, failed: false })
    try {
      const result = await operation()
      if (revision !== this.revision) return
      const current = this.store.getSnapshot()
      const nextSnapshot = result.ok ? result.value : current.snapshot
      const changedOwner = current.snapshot?.account?.id !== nextSnapshot?.account?.id
      this.store.set({ ...current, snapshot: nextSnapshot, busy: false, authorizing: false, failed: !result.ok,
        ...(changedOwner ? { payment: null, alipayOrder: null, wechatChannel: null,
          wechatRechargeIdempotency: false, wechatOrder: null,
          wechatChannelFailed: false, wechatFailed: false } : {}) })
      if (changedOwner) this.ctx.emit('qianshou-account/identity-changed', nextSnapshot?.account?.id ?? null)
    } catch {
      if (revision === this.revision) this.store.set({ ...this.store.getSnapshot(), busy: false, authorizing: false, failed: true })
    }
  }

  /** Read Host state; restore a stored account once per Client lifetime. */
  async load(): Promise<void> {
    if (this.store.getSnapshot().busy) return
    await this.run(() => this.ctx.remote.qianshouAccount.state())
    const snapshot = this.store.getSnapshot().snapshot
    if (!this.restoreAttempted && snapshot?.restorable === true && snapshot.phase === 'signed-out') {
      this.restoreAttempted = true
      await this.reconnect()
    }
  }
  /**
   * Submit credentials directly to the Host without retaining them in a UI store.
   * @param username - Account name or email.
   * @param password - Ephemeral password passed directly to the Host.
   */
  login(username: string, password: string): Promise<void> {
    return this.run(() => this.ctx.remote.qianshouAccount.login(username, password), true)
  }
  /**
   * Ask the Host to send a phone code. The number stays out of the UI store.
   * @param phone - User-entered mainland number.
   * @param purpose - Login or account registration.
   */
  async sendPhoneCode(phone: string, purpose: 'login' | 'register' = 'login'): Promise<boolean> {
    const requestRevision = this.revision + 1
    await this.run(() => this.ctx.remote.qianshouAccount.sendPhoneCode(phone, purpose))
    const state = this.store.getSnapshot()
    return this.revision === requestRevision && !state.failed && state.snapshot?.failure === null
  }
  /**
   * Submit a phone code directly to the Host.
   * @param phone - User-entered mainland number.
   * @param code - User-entered six-digit SMS code.
   */
  loginWithPhone(phone: string, code: string): Promise<void> {
    return this.run(() => this.ctx.remote.qianshouAccount.loginWithPhone(phone, code), true)
  }
  /**
   * Register with a verified phone code and enter the authenticated account session.
   * @param phone - User-entered mainland number.
   * @param code - Registration SMS code.
   */
  registerWithPhone(phone: string, code: string): Promise<void> {
    return this.run(() => this.ctx.remote.qianshouAccount.registerWithPhone(phone, code), true)
  }
  /**
   * Submit the user's one-time code for the Host-owned challenge.
   * @param code - User-entered TOTP code.
   * @param trust - Whether the user chose to trust this device.
   */
  verify(code: string, trust: boolean): Promise<void> {
    return this.run(() => this.ctx.remote.qianshouAccount.completeTotp(code, trust), true)
  }
  /** Cancel independently of the pending request so the Host can abort its work. */
  cancel(): Promise<void> { return this.run(() => this.ctx.remote.qianshouAccount.cancel()) }
  /** Refresh authentication and the real model directory. */
  reconnect(): Promise<void> { return this.run(() => this.ctx.remote.qianshouAccount.reconnect()) }
  /** Clear and revoke the current account. */
  logout(): Promise<void> { return this.run(() => this.ctx.remote.qianshouAccount.logout()) }
  /** Explicitly select the account-backed cloud model for later conversations. */
  useCloud(): Promise<void> { return this.run(() => this.ctx.remote.qianshouAccount.useCloud()) }

  /** Read plan, window, and wallet without treating a commerce miss as a signed-out account. */
  async loadCommerce(): Promise<void> {
    this.store.set({ ...this.store.getSnapshot(), commerceBusy: true, commerceFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.billing()
      const current = this.store.getSnapshot()
      this.store.set(result.ok
        ? { ...current, commerce: result.value, commerceBusy: false, commerceFailed: false }
        : { ...current, commerce: null, commerceBusy: false, commerceFailed: true })
    } catch {
      // Commerce can fail while authentication remains valid; stale prices and balance are hidden.
      this.store.set({ ...this.store.getSnapshot(), commerce: null, commerceBusy: false, commerceFailed: true })
    }
  }

  /**
   * Price one plan. The Host keeps the quote id.
   * @param tier - Plan id from the server catalog.
   */
  async quotePlan(tier: string): Promise<void> {
    const previous = this.store.getSnapshot()
    this.store.set({ ...previous, commerceBusy: true, commerceFailed: false,
      commerce: previous.commerce === null ? null : { ...previous.commerce, quote: null } })
    try {
      const result = await this.ctx.remote.qianshouAccount.quotePlan(tier)
      const current = this.store.getSnapshot()
      this.store.set(result.ok
        ? { ...current, commerce: result.value, commerceBusy: false, commerceFailed: false }
        : { ...current, commerceBusy: false, commerceFailed: true })
    } catch {
      this.store.set({ ...this.store.getSnapshot(), commerceBusy: false, commerceFailed: true })
    }
  }

  /** Pay the quote the Host is holding. */
  async buyPlan(): Promise<void> {
    this.store.set({ ...this.store.getSnapshot(), commerceBusy: true, commerceFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.buyPlan()
      const current = this.store.getSnapshot()
      this.store.set(result.ok
        ? { ...current, commerce: result.value, commerceBusy: false, commerceFailed: false }
        : { ...current, commerce: current.commerce === null ? null : { ...current.commerce, quote: null }, commerceBusy: false, commerceFailed: true })
    } catch {
      const current = this.store.getSnapshot()
      this.store.set({ ...current, commerce: current.commerce === null ? null : { ...current.commerce, quote: null },
        commerceBusy: false, commerceFailed: true })
    }
  }

  /**
   * Ask Shanghai for an Alipay page and keep the fields for one explicit submit.
   * @param amount - Yuan amount entered by the user.
   */
  async startRecharge(amount: string, idempotencyKey: string,
    replay = false): Promise<AccountAlipayStartView | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), payment: null, paymentBusy: true, paymentFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.startRecharge(amount, idempotencyKey, replay)
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      if (!result.ok) {
        this.store.set({ ...current, paymentBusy: false, paymentFailed: true })
        return null
      }
      const answer = result.value as AccountAlipayStartView
      this.store.set({ ...current, payment: answer.kind === 'ready' ? answer.payment : null,
        alipayOrder: answer.kind === 'ready' || answer.kind === 'order' ? answer.order : current.alipayOrder,
        paymentBusy: false, paymentFailed: answer.kind === 'rejected' || answer.kind === 'conflict' })
      return answer
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, paymentBusy: false, paymentFailed: true })
      return null
    }
  }

  /** Read the original Alipay order; only Shanghai's status can release its marker. */
  async loadAlipayOrder(orderNo: string): Promise<AccountRechargeOrderView | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), paymentBusy: true, paymentFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.alipayOrder(orderNo)
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      this.store.set({ ...current, alipayOrder: result.ok ? result.value : current.alipayOrder,
        payment: result.ok && result.value.status === 'paid' ? null : current.payment,
        paymentBusy: false, paymentFailed: !result.ok })
      return result.ok ? result.value : null
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, paymentBusy: false, paymentFailed: true })
      return null
    }
  }

  /** Search bounded owner-checked history without creating another Alipay order. */
  async listAlipayOrders(): Promise<readonly AccountRechargeOrderView[] | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), paymentBusy: true, paymentFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.alipayOrders()
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      this.store.set({ ...current, paymentBusy: false, paymentFailed: !result.ok })
      return result.ok ? result.value : null
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, paymentBusy: false, paymentFailed: true })
      return null
    }
  }

  /** Reopen signed cashier fields only for an owner-bound pending order. */
  async retryAlipayOrderPayment(orderNo: string, amount: string): Promise<AccountPaymentView | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), paymentBusy: true, paymentFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.alipayOrderPayment(orderNo, amount)
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      this.store.set({ ...current, payment: result.ok ? result.value : null,
        paymentBusy: false, paymentFailed: !result.ok })
      return result.ok ? result.value : null
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, paymentBusy: false, paymentFailed: true })
      return null
    }
  }

  /** Clear only the presentation of a server-confirmed paid Alipay order. */
  clearAlipayOrder(): void {
    if (this.store.getSnapshot().alipayOrder?.status !== 'paid') return
    this.store.set({ ...this.store.getSnapshot(), alipayOrder: null, payment: null, paymentFailed: false })
  }

  /** Read the server's explicit Native channel availability. */
  async loadWechatChannel(): Promise<void> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), wechatChannel: null, wechatChannelBusy: true, wechatChannelFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.wechatChannel()
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return
      this.store.set({ ...current, wechatChannel: result.ok ? result.value.available : null,
        wechatRechargeIdempotency: result.ok && result.value.rechargeIdempotency === true,
        wechatChannelBusy: false, wechatChannelFailed: !result.ok })
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current,
        wechatChannel: null, wechatRechargeIdempotency: false, wechatChannelBusy: false, wechatChannelFailed: true })
    }
  }

  /** Create one explicitly requested order; unknown outcomes are returned for original-order recovery. */
  async startWechatRecharge(amount: string, idempotencyKey: string, replay = false): Promise<AccountWechatStartView | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), wechatBusy: true, wechatFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.startWechatRecharge(amount, idempotencyKey, replay)
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      if (!result.ok) {
        this.store.set({ ...current, wechatBusy: false, wechatFailed: true })
        return null
      }
      const response = result.value as AccountWechatStartView
      this.store.set({ ...current, wechatOrder: response.kind === 'ready' ? response.order : current.wechatOrder,
        wechatBusy: false, wechatFailed: response.kind === 'rejected' })
      return response
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, wechatBusy: false, wechatFailed: true })
      return null
    }
  }

  /** Server GET is the only signal that can mark a QR order paid. */
  async loadWechatOrder(orderNo: string): Promise<AccountWechatOrderView | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), wechatBusy: true, wechatFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.wechatOrder(orderNo)
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      const order = result.ok ? result.value : null
      const previous = current.wechatOrder
      // GET /orders carries only local status. It must never erase a newer
      // signed CLOSED verdict returned by /refresh, even if requests race.
      const sameOrder = order !== null && previous !== null && previous.orderNo === order.orderNo
      const confirmedClosed = sameOrder && previous.providerState === 'CLOSED' && order.status !== 'paid'
      const displayed = confirmedClosed ? { ...order, providerState: 'CLOSED' as const, codeUrl: null }
        : sameOrder && order.status === 'pending' ? { ...order, codeUrl: previous.codeUrl } : order
      this.store.set({ ...current, wechatOrder: displayed ?? current.wechatOrder,
        wechatBusy: false, wechatFailed: !result.ok })
      return order
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, wechatBusy: false, wechatFailed: true })
      return null
    }
  }

  /** Only a signed provider query may release an unpaid local-expired order. */
  async refreshWechatOrder(orderNo: string): Promise<AccountWechatOrderView | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), wechatBusy: true, wechatFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.wechatOrderRefresh(orderNo)
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      const order = result.ok ? result.value : null
      const previous = current.wechatOrder
      const displayed = order?.status === 'pending' && order.providerState !== 'CLOSED'
        && previous !== null && previous.orderNo === order.orderNo
        ? { ...order, codeUrl: previous.codeUrl } : order
      this.store.set({ ...current, wechatOrder: displayed ?? current.wechatOrder,
        wechatBusy: false, wechatFailed: !result.ok })
      return order
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, wechatBusy: false, wechatFailed: true })
      return null
    }
  }

  /** Search the bounded owner-checked history after an ambiguous create response. */
  async listWechatOrders(): Promise<readonly AccountWechatOrderView[] | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), wechatBusy: true, wechatFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.wechatOrders()
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      this.store.set({ ...current, wechatBusy: false, wechatFailed: !result.ok })
      return result.ok ? result.value : null
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, wechatBusy: false, wechatFailed: true })
      return null
    }
  }

  /** Recover the original pending order's QR instruction without creating another order. */
  async retryWechatOrderPayment(orderNo: string): Promise<AccountWechatOrderView | null> {
    const owner = this.store.getSnapshot().snapshot?.account?.id
    this.store.set({ ...this.store.getSnapshot(), wechatBusy: true, wechatFailed: false })
    try {
      const result = await this.ctx.remote.qianshouAccount.wechatOrderPayment(orderNo)
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id !== owner) return null
      this.store.set({ ...current, wechatOrder: result.ok ? result.value : current.wechatOrder,
        wechatBusy: false, wechatFailed: !result.ok })
      return result.ok ? result.value : null
    } catch {
      const current = this.store.getSnapshot()
      if (current.snapshot?.account?.id === owner) this.store.set({ ...current, wechatBusy: false, wechatFailed: true })
      return null
    }
  }

  /** Clear a settled order from the local view only; this never changes Shanghai's order. */
  clearWechatOrder(): void {
    this.store.set({ ...this.store.getSnapshot(), wechatOrder: null, wechatFailed: false })
  }
}
