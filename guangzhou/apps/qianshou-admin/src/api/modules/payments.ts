/** Shanghai money operations through the existing authenticated admin proxy. */
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import { apply, preflight } from '../confirm'
import type { ConfirmPreview } from '../types'

export interface PaymentOrder {
  readonly order_no: string
  readonly account_id: string | number
  readonly amount: string
  readonly currency: string
  readonly gateway: string
  readonly status: string
  readonly ledger_id?: string | null
  readonly gateway_tx_id?: string | null
  readonly created_at: string
  readonly paid_at?: string | null
  readonly remark?: string
}
export interface PaymentWithdrawal {
  readonly request_no: string
  readonly account_id: string | number
  readonly amount: string
  readonly currency: string
  readonly status: string
  readonly kyc_status: string
  readonly payee_info: Record<string, unknown>
  readonly created_at: string
}
export type PaymentDraft = { readonly op: 'confirm'; readonly order_no: string; readonly gateway_tx_id: string }
  | { readonly op: 'recharge'; readonly account_id: string; readonly amount: string }
  | { readonly op: 'approve' | 'reject'; readonly request_no: string }
  | { readonly op: 'mark_paid'; readonly request_no: string; readonly paid_tx_id: string }

export const listPaymentOrders = (query: { account_id?: string; status?: string; gateway?: string; offset: number; limit: number }) =>
  postJson<{ ok: true; items: PaymentOrder[]; total: number; limit: number; offset: number }>(ENDPOINTS.paymentOrders, query)
export const getPaymentOrder = (order_no: string) => postJson<{ ok: true; order: PaymentOrder }>(ENDPOINTS.paymentOrder, { order_no })
export const listPaymentWithdrawals = () =>
  postJson<{ ok: true; items: PaymentWithdrawal[]; total: number; limit: number }>(ENDPOINTS.paymentWithdrawals)

/** A frozen draft plus authoritative before-state binds both confirmation steps. No retries. */
export function paymentConfirmation(draft: PaymentDraft) {
  const frozen = { ...draft }
  let preview: ConfirmPreview | undefined
  return {
    preflight: async () => { preview = await preflight(ENDPOINTS.paymentPreflight, frozen); return preview },
    apply: async (token: string, reason: string) => {
      if (preview === undefined || token !== preview.token) throw new Error('请重新预览本次支付操作。')
      const before = preview.diff.before
      preview = undefined
      return await apply(ENDPOINTS.paymentApply, token, reason, { ...frozen, before })
    },
  }
}
