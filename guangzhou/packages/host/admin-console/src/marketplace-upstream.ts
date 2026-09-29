/** Fixed Shanghai marketplace review transport for the Guangzhou admin console. */
export class MarketplaceUpstreamError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

type ReviewAction = 'approve' | 'reject'

export function createMarketplaceUpstream(options: {
  readonly baseUrl: string
  readonly prefix?: string
  readonly fetch?: typeof fetch
}) {
  const origin = new URL(options.baseUrl)
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) {
    throw new Error('MARKETPLACE_ORIGIN_INVALID')
  }
  const base = origin.origin + (options.prefix ?? '/api/v8')
  const send = options.fetch ?? fetch

  async function request(access: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const writing = body !== undefined
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 8_000)
    try {
      const response = await send(`${base}${path}`, {
        method: writing ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', authorization: `Bearer ${access}`,
          ...(writing ? { 'content-type': 'application/json' } : {}) },
        ...(writing ? { body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) {
        if (response.status === 401) throw new MarketplaceUpstreamError(401, 'market_session_required', '上海账号会话已失效，请重新登录。')
        if (response.status === 403) throw new MarketplaceUpstreamError(403, 'market_upstream_forbidden', '上海平台拒绝此账号的市场审核权限。')
        if (response.status === 404) throw new MarketplaceUpstreamError(404, 'market_not_found', '上海未找到投稿或尚未部署审核接口。')
        if (response.status < 500) throw new MarketplaceUpstreamError(409, 'market_review_rejected', '上海拒绝本次审核，请刷新队列并核对阻断项。')
        throw new Error('UPSTREAM_SERVER_ERROR')
      }
      const payload: unknown = await response.json()
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('UPSTREAM_INVALID_RESPONSE')
      return payload as Record<string, unknown>
    } catch (error) {
      if (error instanceof MarketplaceUpstreamError) throw error
      throw new MarketplaceUpstreamError(502, writing ? 'market_review_outcome_unknown' : 'market_unavailable', writing
        ? '上海审核结果暂无法确认。请刷新队列核对状态，勿重复提交。'
        : '上海审核队列暂不可用，请稍后刷新。')
    } finally { clearTimeout(timer) }
  }

  async function readQueue(access: string, path: string, subject: string): Promise<Record<string, unknown>> {
    const queue = await request(access, path)
    const capabilities = await request(access, '/admin/task-adapter-publications/review-capabilities')
    if (Object.keys(capabilities).sort().join(',') !== 'account_id,review_authorized,schema'
      || capabilities['schema'] !== 'qianshou.market-review-capabilities.v1'
      || !Number.isSafeInteger(capabilities['account_id']) || Number(capabilities['account_id']) < 1
      || String(capabilities['account_id']) !== subject
      || typeof capabilities['review_authorized'] !== 'boolean') {
      throw new MarketplaceUpstreamError(502, 'market_contract_mismatch', '上海审核写授权回执与当前账号不匹配。')
    }
    return { ...queue, reviewAuthorized: capabilities['review_authorized'],
      readDelegated: capabilities['review_authorized'] === false }
  }

  return {
    list: (access: string, limit: number, subject: string) => readQueue(access, `/admin/marketplace/review?limit=${limit}`, subject),
    moderate: (access: string, appId: number, action: ReviewAction, note: string) =>
      request(access, `/admin/marketplace/review/${appId}`, { action, note }),
    listManagedOrderPublications: (access: string, subject: string) => readQueue(access, '/admin/task-adapter-publications/managed?include_archived=true', subject),
    manageOrderPublication: (access: string, id: string, action: 'withdraw' | 'delist' | 'archive' | 'restore', expectedRevision: number, note: string) =>
      request(access, `/admin/task-adapter-publications/${id}/lifecycle`, { action, expected_revision: expectedRevision, note }),
    listOrderPublications: (access: string, subject: string) => readQueue(access, '/admin/task-adapter-publications/pending', subject),
    rejectOrderPublication: (access: string, id: string, note: string) =>
      request(access, `/admin/task-adapter-publications/${id}/reject`, { note }),
    approveOrderPublication: (access: string, id: string, note: string) =>
      request(access, `/admin/task-adapter-publications/${id}/approve`, { note }),
    listOrderAdapterProducts: (access: string, subject: string) => readQueue(access, '/admin/order-adapter-products/pending', subject),
    approveOrderAdapterProduct: (access: string, id: string, note: string) =>
      request(access, `/admin/order-adapter-products/${id}/approve`, { note }),
    rejectOrderAdapterProduct: (access: string, id: string, note: string) =>
      request(access, `/admin/order-adapter-products/${id}/reject`, { note }),
  }
}
