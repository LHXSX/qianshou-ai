/** Account reads use snapshots; SP writes use the confirmed workbench module. */

import { preflight } from '../confirm'
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type {
  AccountAdjustmentDraft,
  AccountDetail,
  AccountDetailResult,
  AccountListResult,
  AccountReservation,
  AccountRow,
  ConfirmPreview,
  LedgerResult,
  LedgerRow,
} from '../types'

/** `POST account/list`（支持 `query/limit/offset`）。 */
export async function fetchAccountList(query: string, limit: number, offset: number): Promise<AccountListResult> {
  const response = await postJson<{ ok: true; total: number; accounts: readonly AccountRow[] }>(
    ENDPOINTS.accountList,
    { query, limit, offset },
  )
  return { total: response.total ?? 0, accounts: response.accounts ?? [] }
}

/** `POST account/detail`。 */
export async function fetchAccountDetail(accountId: string): Promise<AccountDetailResult> {
  const response = await postJson<{ ok: true; account: AccountDetail; reservations?: readonly AccountReservation[] }>(
    ENDPOINTS.accountDetail,
    { accountId },
  )
  return { account: response.account, reservations: response.reservations ?? [] }
}

/** `POST account/ledger`：按账号查流水。 */
export async function fetchAccountLedger(accountId: string, limit: number, offset: number): Promise<LedgerResult> {
  const response = await postJson<{ ok: true; total: number; entries: readonly LedgerRow[] }>(
    ENDPOINTS.accountLedger,
    { accountId, limit, offset },
  )
  return { total: response.total ?? 0, entries: response.entries ?? [] }
}

/** Compatibility preview helper; callers must include a reason before confirmation. */
export function preflightAccountAdjustment(draft: AccountAdjustmentDraft): Promise<ConfirmPreview> {
  return preflight(ENDPOINTS.accountAdjustmentPreflight, { ...draft })
}
