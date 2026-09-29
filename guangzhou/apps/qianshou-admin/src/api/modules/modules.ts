/** §3 模块就绪度 + §8.6 健康检查。 */

import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type { HealthPayload, ReadinessEntry } from '../types'

/** `POST modules`：返回全部模块的就绪度，用于总览矩阵。 */
export async function fetchModules(): Promise<readonly ReadinessEntry[]> {
  const response = await postJson<{ ok: true; modules: readonly ReadinessEntry[] }>(ENDPOINTS.modules, {})
  return response.modules ?? []
}

/** `POST health`：管理台服务自身的存活信息（同样过白名单）。 */
export async function fetchHealth(): Promise<HealthPayload> {
  const response = await postJson<{ ok: true } & HealthPayload>(ENDPOINTS.health, {})
  return { service: response.service, version: response.version, uptimeMs: response.uptimeMs }
}
