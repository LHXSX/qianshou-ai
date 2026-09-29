/** §7 IP 白名单：展示服务端看到的 clientIp、条目增删（两步确认）、逃生路径说明。 */

import { apply, preflight } from '../confirm'
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type { ApplyResult, ConfirmPreview, WhitelistDraft, WhitelistStatus } from '../types'

/** `POST whitelist/status`：白名单开关、当前来源 IP、条目、逃生路径。 */
export async function fetchWhitelistStatus(): Promise<WhitelistStatus> {
  const response = await postJson<{ ok: true } & WhitelistStatus>(ENDPOINTS.whitelistStatus, {})
  return {
    enabled: response.enabled === true,
    clientIp: response.clientIp,
    entries: response.entries ?? [],
    escapeHatch: response.escapeHatch,
  }
}

/** 第一步：预览条目增删差异。 */
export function preflightWhitelistEntry(draft: WhitelistDraft): Promise<ConfirmPreview> {
  return preflight(ENDPOINTS.whitelistEntriesPreflight, { ...draft })
}

/** 第二步：带令牌与原因执行。 */
export function applyWhitelistEntry(token: string, reason: string): Promise<ApplyResult> {
  return apply(ENDPOINTS.whitelistEntriesApply, token, reason)
}
