/** Shanghai owns money and its ledger. This client only forwards the current admin's token. */
export class PaymentUpstreamError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}

/** Fixed account origin; no caller URL, cookie, redirect, automatic retry or credential persistence. */
export function createPaymentUpstream(options: { readonly baseUrl: string; readonly prefix?: string; readonly fetch?: typeof fetch }) {
  const base = options.baseUrl.replace(/\/+$/, '') + (options.prefix ?? '/api/v8')
  const send = options.fetch ?? fetch
  return async (access: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 10_000)
    const writing = body !== undefined
    try {
      const response = await send(`${base}${path}`, {
        method: writing ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', authorization: `Bearer ${access}`, ...(writing ? { 'content-type': 'application/json' } : {}) },
        ...(writing ? { body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) {
        if (response.status === 401) throw new PaymentUpstreamError(401, 'payment_session_required', '上海账号会话已失效，请重新登录。')
        if (response.status === 403) throw new PaymentUpstreamError(403, 'payment_upstream_forbidden', '上海账号服务拒绝此管理员的支付权限，请核查账号权限。')
        if (response.status === 404) throw new PaymentUpstreamError(404, 'payment_not_found', '上海未找到目标或尚未部署此管理接口。')
        if (response.status < 500) throw new PaymentUpstreamError(409, 'payment_rejected', '上海拒绝本次操作，请刷新并核查金额、流水号和目标状态。')
        throw new Error('UPSTREAM_SERVER_ERROR')
      }
      const payload: unknown = await response.json()
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || (payload as Record<string, unknown>)['ok'] === false) throw new Error('UPSTREAM_INVALID_RESPONSE')
      return payload as Record<string, unknown>
    } catch (error) {
      if (error instanceof PaymentUpstreamError) throw error
      throw new PaymentUpstreamError(502, writing ? 'payment_outcome_unknown' : 'payment_unavailable', writing
        ? '未能确认上海的执行结果。请先核查上海订单或账本，勿重复充值或再次提交。'
        : '上海支付查询暂不可用，请稍后刷新。')
    } finally { clearTimeout(timer) }
  }
}
