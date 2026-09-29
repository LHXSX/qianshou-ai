/** Admin-only bridge to Shanghai's legacy marketplace review queue. */
import type { Principal } from './admin-routes.ts'

/** Browser carrier path. Shanghai performs its own bearer authorization again. */
export const ADMIN_MARKETPLACE_PATH = '/api/qianshou/ai/admin/marketplace'

interface MarketplaceAdminDeps {
  readonly apiOrigin: string
  readonly authenticate: () => Promise<Principal | null>
  readonly accessToken: () => Promise<string | null>
  readonly fetcher?: typeof fetch
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

function originOf(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('MARKETPLACE_API_ORIGIN_INVALID')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('MARKETPLACE_API_ORIGIN_INVALID')
  }
  return url.origin
}

/** Review/read operations only; no price mutation or executable plugin activation. */
export function createMarketplaceAdminRoute(deps: MarketplaceAdminDeps): (request: Request) => Promise<Response> {
  const origin = originOf(deps.apiOrigin)
  const fetcher = deps.fetcher ?? fetch
  return async (request) => {
    const principal = await deps.authenticate()
    if (principal === null) return json({ ok: false, message: '请先登录。' }, 401)
    if (!principal.isAdmin) return json({ ok: false, message: '这个操作需要管理员权限。' }, 403)
    const token = await deps.accessToken()
    if (!token) return json({ ok: false, message: '上海平台登录状态已过期，请重新登录。' }, 401)

    let body: unknown
    try { body = await request.json() } catch { return json({ ok: false, message: '请求格式不对。' }, 400) }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, message: '请求格式不对。' }, 400)
    const input = body as Record<string, unknown>
    let path = '/api/v8/admin/marketplace/review?limit=50'
    let method = 'GET'
    let payload: string | undefined
    if (input['action'] !== 'list') {
      const action = input['action']
      const appId = input['appId']
      const note = input['note']
      if ((action !== 'approve' && action !== 'reject' && action !== 'suspend')
        || typeof appId !== 'number' || !Number.isSafeInteger(appId) || appId < 1
        || typeof note !== 'string' || note.trim().length < 1 || note.trim().length > 500) {
        return json({ ok: false, message: '请选择应用和审核动作，并填写审核原因。' }, 400)
      }
      path = `/api/v8/admin/marketplace/review/${appId}`
      method = 'POST'
      payload = JSON.stringify({ action, note: note.trim() })
    }

    try {
      const upstream = await fetcher(`${origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(8_000),
      })
      const data: unknown = await upstream.json()
      if (!upstream.ok) {
        const detail = data !== null && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)['detail'] : undefined
        return json({ ok: false, message: typeof detail === 'string' ? detail : '上海审核服务暂不可用。' },
          [400, 401, 403, 404].includes(upstream.status) ? upstream.status : 502)
      }
      return json({ ok: true, result: data })
    } catch {
      return json({ ok: false, message: '上海审核服务暂不可用。' }, 502)
    }
  }
}
