/** Existing admin session, permission, scope and Shanghai identity guard this projection. */
import type { Route, RouteContext } from './server.ts'
import { createEnterpriseLeadsUpstream, EnterpriseLeadsUpstreamError } from './enterprise-leads-upstream.ts'

const summaryKeys = ['id', 'company', 'contact', 'phone', 'size', 'use_case', 'budget', 'source', 'created_at', 'status'] as const
const detailKeys = [...summaryKeys, 'note', 'submitted_at', 'source_ip', 'user_agent'] as const

function pickLead(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EnterpriseLeadsUpstreamError(502, 'enterprise_contract_mismatch', '上海企业咨询接口返回的数据不完整。')
  const source = value as Record<string, unknown>
  if (!Number.isSafeInteger(source['id']) || typeof source['company'] !== 'string' || typeof source['phone'] !== 'string' || typeof source['created_at'] !== 'string') {
    throw new EnterpriseLeadsUpstreamError(502, 'enterprise_contract_mismatch', '上海企业咨询接口返回的数据不完整。')
  }
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]))
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = value === undefined ? fallback : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new EnterpriseLeadsUpstreamError(400, 'bad_request', '分页参数或线索编号无效。')
  }
  return number
}

export function registerEnterpriseLeadRoutes(options: {
  readonly route: (route: Route) => void
  readonly upstream: ReturnType<typeof createEnterpriseLeadsUpstream>
}): void {
  const add = (path: string, run: (ctx: RouteContext, access: string) => Promise<void>) => options.route({
    path: `/enterprise/${path}`, auth: 'permission', permission: 'enterprise.read', mutating: false,
    handler: async ctx => {
      try {
        if (ctx.scope !== 'all') throw new EnterpriseLeadsUpstreamError(403, 'enterprise_scope_forbidden', '企业咨询包含客户联系方式，需要全部数据范围。')
        const access = ctx.session?.tokens?.access
        if (!access) throw new EnterpriseLeadsUpstreamError(401, 'enterprise_session_required', '请重新登录以取得上海账号会话。')
        await run(ctx, access)
      } catch (error) {
        if (!(error instanceof EnterpriseLeadsUpstreamError)) throw error
        ctx.json(error.status, { ok: false, code: error.code, message: error.message })
      }
    },
  })
  add('leads', async (ctx, access) => {
    const limit = integer(ctx.body['limit'], 30, 1, 100)
    const offset = integer(ctx.body['offset'], 0, 0, 100_000)
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    const response = await options.upstream(access, `/admin/enterprise/leads?${query}`)
    if (!Array.isArray(response['items']) || !Number.isSafeInteger(response['total'])) throw new EnterpriseLeadsUpstreamError(502, 'enterprise_contract_mismatch', '上海企业咨询列表结构不完整。')
    ctx.json(200, { ok: true, items: response['items'].map(row => pickLead(row, summaryKeys)), total: response['total'], limit, offset })
  })
  add('lead', async (ctx, access) => {
    const id = integer(ctx.body['id'], 0, 1, Number.MAX_SAFE_INTEGER)
    const response = await options.upstream(access, `/admin/enterprise/leads/${id}`)
    ctx.json(200, { ok: true, lead: pickLead(response['lead'], detailKeys) })
  })
}
