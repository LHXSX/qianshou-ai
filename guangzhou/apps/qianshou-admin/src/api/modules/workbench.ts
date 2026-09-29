/** Confirmed SP/entitlement operations; a check reuses its original ref and never applies it. */
import { postJson } from '../client'
import { preflight } from '../confirm'
import { ENDPOINTS } from '../endpoints'
import type { ApplyResult, ConfirmPreview } from '../types'
export type WorkbenchAction = 'adjustment' | 'subscription'
export type WorkbenchPreview = ConfirmPreview<Record<string, unknown>, Record<string, unknown>>
const paths = (action: WorkbenchAction) => action === 'adjustment'
  ? { preview: ENDPOINTS.accountAdjustmentPreflight, apply: ENDPOINTS.accountAdjustmentApply, check: ENDPOINTS.accountAdjustmentCheck }
  : { preview: ENDPOINTS.subscriptionManagePreflight, apply: ENDPOINTS.subscriptionManageApply, check: ENDPOINTS.subscriptionManageCheck }
export async function previewWorkbench(action: WorkbenchAction, draft: Record<string, unknown>): Promise<WorkbenchPreview> {
  return await preflight<Record<string, unknown>, Record<string, unknown>>(paths(action).preview, draft)
}
export async function applyWorkbench(action: WorkbenchAction, preview: WorkbenchPreview): Promise<ApplyResult> {
  return await postJson<{ ok: true } & ApplyResult>(paths(action).apply, {
    ...preview.diff.after, before: preview.diff.before, token: preview.token,
  })
}
export async function checkWorkbench(action: WorkbenchAction, preview: WorkbenchPreview) {
  return await postJson<{ ok: true; ref: string; recorded: boolean; preview: WorkbenchPreview['diff'] }>(paths(action).check, { ...preview.diff.after })
}
