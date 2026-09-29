/** Public account views contain neither credentials nor authorization challenges. */
export type AccountPhase = 'signed-out' | 'authorizing' | 'two-factor-required' | 'authenticated' | 'refreshing' | 'unavailable' | 'expired'

/** Safe, stable failures shared with the account presentation plugin. */
export type AccountFailureCode = 'auth-required' | 'invalid-credentials' | 'invalid-input'
  | 'rate-limited' | 'unavailable' | 'invalid-response' | 'cancelled'
  | 'storage-failed' | 'route-invalid'

/** Whitelisted identity confirmed by the account server. */
export interface AccountIdentity {
  id: string
  username: string
}

/** One purchasable plan reported by the model gateway. */
export interface AccountPlanOffer {
  id: string
  label: string
  monthlyYuan: number | null
  monthlySp: number | null
}

/** A quoted one-month purchase. The quote id stays on the Host. */
export interface AccountQuoteView {
  label: string
  amountYuan: string
  monthlySp: number
  canPay: boolean
}

/** Safe commerce notice. Raw payment text never crosses this list. */
export type AccountCommerceNotice = 'insufficient-balance' | 'quote-expired' | 'downgrade-not-allowed' | 'unavailable' | 'paid'

/** Signed-in plan, quota, and RMB wallet. Missing numbers stay null. */
export interface AccountCommerce {
  tierLabel: string
  remainingSp: number | null
  windowLimitSp: number | null
  usedInWindowSp: number | null
  balanceYuan: string | null
  plans: AccountPlanOffer[]
  quote: AccountQuoteView | null
  notice: AccountCommerceNotice | null
}

/** One reviewed Alipay page-pay field. */
export interface AccountPaymentField {
  name: string
  value: string
}

/** Server-signed Alipay page the browser may submit once. */
export interface AccountPayment {
  action: string
  fields: AccountPaymentField[]
}

/** Owner-checked recharge record; a browser return URL cannot declare it paid. */
export interface AccountRechargeOrder {
  orderNo: string
  amount: string
  status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed'
  createdAt: number
  expiresAt: number | null
}

export type AccountAlipayStart =
  | { kind: 'ready'; order: AccountRechargeOrder; payment: AccountPayment; reused?: boolean }
  | { kind: 'order'; order: AccountRechargeOrder }
  | { kind: 'unknown'; orderNo: string | null }
  | { kind: 'conflict' }
  | { kind: 'rejected' }

/** Public WeChat Native channel state; the Host never exposes provider configuration. */
export interface AccountWechatChannel {
  available: boolean
  /** Only a server with a durable recharge-key ledger may permit a replay. */
  rechargeIdempotency: boolean
}

/** One owner-checked Shanghai recharge order. Code URL exists only for a pending checkout. */
export interface AccountWechatOrder extends AccountRechargeOrder {
  codeUrl: string | null
  /** Present only after Shanghai verifies a WeChat trade query. Local expiry is not closure. */
  providerState?: 'SUCCESS' | 'NOTPAY' | 'CLOSED' | 'REFUND' | 'REVOKED' | 'USERPAYING' | 'PAYERROR'
}

/** A failed/unknown create response must preserve the original order when known. */
export type AccountWechatStart =
  | { kind: 'ready'; order: AccountWechatOrder; reused?: boolean }
  | { kind: 'unknown'; orderNo: string | null }
  | { kind: 'conflict' }
  | { kind: 'rejected' }

/** Read-only account status projected to the browser. */
export interface AccountSnapshot {
  phase: AccountPhase
  account: AccountIdentity | null
  failure: AccountFailureCode | null
  verifiedAt: number | null
  restorable: boolean
  models: string[]
  cloudSelected: boolean
}
