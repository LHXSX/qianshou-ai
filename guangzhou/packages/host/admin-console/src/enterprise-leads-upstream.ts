/** Read-only bridge to Shanghai's authenticated enterprise inquiry API. */
export class EnterpriseLeadsUpstreamError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}

/** Only the server holds the account bearer. A browser cannot select an upstream URL. */
export function createEnterpriseLeadsUpstream(options: {
  readonly baseUrl: string
  readonly prefix?: string
  readonly fetch?: typeof fetch
}) {
  const base = options.baseUrl.replace(/\/+$/, '') + (options.prefix ?? '/api/v8')
  const send = options.fetch ?? fetch
  return async (access: string, path: string): Promise<Record<string, unknown>> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await send(`${base}${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json', authorization: `Bearer ${access}` },
      })
      if (response.status === 401) throw new EnterpriseLeadsUpstreamError(401, 'enterprise_session_required', '上海账号会话已失效，请重新登录。')
      if (response.status === 403) throw new EnterpriseLeadsUpstreamError(403, 'enterprise_upstream_forbidden', '上海未授予该账号管理员权限。')
      if (response.status === 404) throw new EnterpriseLeadsUpstreamError(404, 'enterprise_not_found', '上海尚未部署企业咨询接口，或记录不存在。')
      if (!response.ok) throw new EnterpriseLeadsUpstreamError(502, 'enterprise_unavailable', '上海企业咨询查询暂不可用，请稍后刷新。')
      const body: unknown = await response.json()
      if (body === null || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>)['ok'] !== true) {
        throw new EnterpriseLeadsUpstreamError(502, 'enterprise_contract_mismatch', '上海企业咨询接口返回的数据不完整。')
      }
      return body as Record<string, unknown>
    } catch (error) {
      if (error instanceof EnterpriseLeadsUpstreamError) throw error
      throw new EnterpriseLeadsUpstreamError(502, 'enterprise_unavailable', '上海企业咨询查询暂不可用，请稍后刷新。')
    } finally { clearTimeout(timer) }
  }
}
