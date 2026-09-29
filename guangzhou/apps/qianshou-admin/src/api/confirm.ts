/**
 * 两步确认流程（API.md §1.3）—— 所有写操作的唯一通道。
 *
 * 前端只负责按契约顺序调用：`…/preflight` 拿令牌与 `before → after` 差异，
 * 管理员填 `reason`（≥4 字）后 `…/apply`。
 * 权限校验、令牌一次性、载荷哈希绑定、版本冲突检测全部在服务端，前端不做安全判断。
 */

import { postJson } from './client'
import type { RequestPayload } from './client'
import type { ApplyResult, ConfirmPreview } from './types'

/** `reason` 的最小长度：契约要求「≥4 字」。 */
export const MIN_REASON_LENGTH = 4

interface PreflightResponse<TBefore, TAfter> extends ConfirmPreview<TBefore, TAfter> {
  readonly ok: true
  readonly confirm: ConfirmPreview<TBefore, TAfter>
}

interface ApplyResponse extends ApplyResult {
  readonly ok: true
}

/** 第一步：请求预览，返回一次性令牌与差异。 */
export async function preflight<TBefore = unknown, TAfter = unknown>(
  preflightPath: string,
  payload: RequestPayload,
): Promise<ConfirmPreview<TBefore, TAfter>> {
  const response = await postJson<PreflightResponse<TBefore, TAfter>>(preflightPath, payload)
  return response.confirm
}

/** 第二步：带令牌与原因执行。 */
export async function apply(
  applyPath: string,
  token: string,
  reason: string,
  payload: RequestPayload = {},
): Promise<ApplyResult> {
  const trimmed = reason.trim()
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw new Error(`操作原因至少需要 ${MIN_REASON_LENGTH} 个字。`)
  }
  // `payload` 只有少数接口需要（服务端要用它重算载荷哈希，例如上游密钥的
  // `ref` / `value`）。默认空对象 —— 免得把敏感字段顺手塞进每个写请求。
  return postJson<ApplyResponse>(applyPath, { ...payload, token, reason: trimmed })
}

/** 令牌剩余有效时间（毫秒），用于弹窗倒计时展示；已过期返回 0。 */
export function remainingMs(preview: ConfirmPreview, now: number = Date.now()): number {
  return Math.max(0, preview.expiresAt - now)
}
