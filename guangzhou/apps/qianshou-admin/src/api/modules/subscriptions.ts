/** Subscription reads use owner snapshots; term-bound writes use the workbench module. */

import { preflight } from '../confirm'
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type { ConfirmPreview, SubscriptionListResult, SubscriptionRow, SubscriptionTierCatalog } from '../types'

/** `POST subscription/list`。 */
export async function fetchSubscriptionList(query: string, limit: number, offset: number): Promise<SubscriptionListResult> {
  const response = await postJson<{ ok: true; total: number; entries: readonly SubscriptionRow[] }>(
    ENDPOINTS.subscriptionList,
    { query, limit, offset },
  )
  return { total: response.total ?? 0, entries: response.entries ?? [] }
}

/** `POST subscription/tiers`：档位目录只读，`source` 说明目录来自哪个上游。 */
export async function fetchSubscriptionTiers(): Promise<SubscriptionTierCatalog> {
  const response = await postJson<{ ok: true } & SubscriptionTierCatalog>(ENDPOINTS.subscriptionTiers, {})
  return { source: response.source, tiers: response.tiers ?? [] }
}

/** Compatibility preview helper; an explicit term and reason are required. */
export function preflightSubscriptionManage(draft: Record<string, unknown>): Promise<ConfirmPreview> {
  return preflight(ENDPOINTS.subscriptionManagePreflight, { ...draft })
}
