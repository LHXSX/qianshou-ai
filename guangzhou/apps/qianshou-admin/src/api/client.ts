/**
 * 传输层 —— 全站唯一出网入口。
 *
 * 约定（API.md §1）：
 * - 方法恒为 POST，JSON 正文；
 * - 会话凭据是 `HttpOnly; SameSite=Strict` 的 cookie，因此必须 `credentials: 'same-origin'`；
 * - 成功信封 `{ok:true,…}`，失败信封 `{ok:false,code,message}`；
 * - 401 统一跳登录页（由 `src/api/unauthorized.ts` 注册的钩子负责，避免 API 层依赖 router）。
 */

import { toAdminApiError, toTransportError, AdminApiError } from './errors'

/** 401 的唯一处理入口：由应用启动时注册（跳登录 + 清会话）。 */
type UnauthorizedHandler = () => void

let unauthorizedHandler: UnauthorizedHandler | undefined

/** 注册 401 处理器；重复注册以最后一次为准。 */
export function onUnauthorized(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler
}

function notifyUnauthorized(): void {
  unauthorizedHandler?.()
}

/** 契约里所有请求体的形状：JSON 对象；无参数接口传 `{}`。 */
export type RequestPayload = Record<string, unknown>

/**
 * 发起一次契约请求。
 *
 * @throws {AdminApiError} 网络失败、非 2xx、或响应体不满足契约时抛出。
 */
export async function postJson<TResponse extends { ok: true }>(
  path: string,
  payload: RequestPayload = {},
  signal?: AbortSignal,
): Promise<TResponse> {
  let response: Response
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    }
    if (signal !== undefined) init.signal = signal
    response = await fetch(path, init)
  } catch (cause) {
    throw toTransportError(cause)
  }

  let parsed: unknown = undefined
  const text = await response.text()
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      // 白名单拒绝时服务端可能返回纯文本（API.md §1.1），保留原文交由错误分类处理。
      parsed = { ok: false, code: response.ok ? 'unexpected_response' : '', message: text.slice(0, 500) }
    }
  }

  if (!response.ok) {
    const error = toAdminApiError(response.status, parsed)
    if (error.isUnauthenticated) notifyUnauthorized()
    throw error
  }

  if (typeof parsed !== 'object' || parsed === null || (parsed as { ok?: unknown }).ok !== true) {
    throw new AdminApiError({
      status: response.status,
      code: 'unexpected_response',
      message: '服务端返回了不符合契约的响应（缺少 ok:true 信封）。',
    })
  }

  return parsed as TResponse
}
