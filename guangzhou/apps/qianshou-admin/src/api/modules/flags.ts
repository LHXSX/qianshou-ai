/** §6 功能开关：开关 + 灰度百分比，写操作走两步确认。 */

import { apply, preflight } from '../confirm'
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type { ApplyResult, ConfirmPreview, FlagDraft, FlagRecord } from '../types'

/** `POST flags/list`。 */
export async function fetchFlags(): Promise<readonly FlagRecord[]> {
  const response = await postJson<{ ok: true; flags: readonly FlagRecord[] }>(ENDPOINTS.flagsList, {})
  return response.flags ?? []
}

/** 第一步：预览 `enabled` / `rolloutPercent` 的 before → after。 */
export function preflightFlag(draft: FlagDraft): Promise<ConfirmPreview> {
  return preflight(ENDPOINTS.flagsPreflight, { ...draft })
}

/** 第二步：带令牌与原因执行。 */
export function applyFlag(token: string, reason: string): Promise<ApplyResult> {
  return apply(ENDPOINTS.flagsApply, token, reason)
}
