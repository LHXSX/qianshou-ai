/** §5 审计日志：只追加，前端只读。 */

import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type { AuditEntry, AuditEntryDetail, AuditListResult, AuditQuery } from '../types'

/**
 * `POST audit/list`：按时间/操作人/动作前缀/结果过滤 + 分页。
 * 数据范围（`scope: all|self`）由服务端裁剪，前端拿到的就是裁剪后的数据。
 */
export async function fetchAuditList(query: AuditQuery): Promise<AuditListResult> {
  const response = await postJson<{ ok: true; total: number; entries: readonly AuditEntry[] }>(
    ENDPOINTS.auditList,
    { ...query },
  )
  return { total: response.total ?? 0, entries: response.entries ?? [] }
}

/** `POST audit/detail`：单条详情的 before/after 与结构化 diff。 */
export async function fetchAuditDetail(id: string): Promise<AuditEntryDetail> {
  const response = await postJson<{ ok: true; entry: AuditEntryDetail }>(ENDPOINTS.auditDetail, { id })
  return response.entry
}
