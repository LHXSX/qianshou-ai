/** Read operational module data from their existing owners, with unchanged console RBAC. */
import { randomUUID } from 'node:crypto'
import type { Route, RouteContext } from './server.ts'
import type { CommunityStore } from './community.ts'
import { createWorkbenchUpstream, WorkbenchUpstreamError } from './workbench-upstream.ts'
import { createPaymentUpstream, PaymentUpstreamError } from './payment-upstream.ts'
import type { ModuleReadiness } from './modules.ts'

/** Existing official activities, pinned topics and open reports share the authoritative community store.
 * @param store - Current content owner; no parallel database is created.
 * @returns Real content entries, including visibility and publication timestamps.
 */
export async function readDiscovery(store: CommunityStore) {
  const data = await store.adminList()
  return { source: 'guangzhou-community',
    announcements: data.topics.filter(row => row.official && row.category === 'activities'),
    recommendations: data.topics.filter(row => row.pinned && row.visibility === 'visible'), reports: data.reports }
}

/** Register currently callable overview reads; each uses the console's declared permission and data scope.
 * @param options - Existing service clients and authoritative content owner.
 * @returns Live readiness probe and route registrations.
 */
export function registerOperationalModules(options: {
  readonly route: (route: Route) => void
  readonly community: CommunityStore
  readonly workbench: ReturnType<typeof createWorkbenchUpstream>
  readonly payment: ReturnType<typeof createPaymentUpstream>
}) {
  const models = async (operatorAccountId: string, operatorRole: string) => options.workbench.request({
    action: 'models.read', operatorAccountId, operatorRole, operationId: `models-read-${randomUUID()}`, body: {}, dryRun: true })
  const rows = async (): Promise<readonly ModuleReadiness[]> => {
    let modelReady = false, modelDetail = '工作台模型服务身份尚未验证。'
    try {
      const data = await models('admin-console-readiness', 'service-readiness')
      modelReady = Array.isArray(data['names']) && Array.isArray(data['backends'])
      modelDetail = modelReady ? '已通过专用服务身份读取工作台当前发布名、绑定历史及后端目录；改绑入口尚未开放。' : '工作台没有返回有效模型目录。'
    } catch (error) { modelDetail = error instanceof WorkbenchUpstreamError ? error.message : '工作台模型目录暂不可用。' }
    let discoveryReady = false
    try { await readDiscovery(options.community); discoveryReady = true } catch { /* Corrupt or inaccessible owner data remains unavailable. */ }
    return [
      { key: 'discovery', title: '发现页内容', status: discoveryReady ? 'read-only' : 'dependency-unavailable',
        summary: discoveryReady ? '读取现有官方活动公告、可见置顶推荐与待处理举报；发布和处理入口仍由讨论区管理权限管理。' : '广州内容数据暂不可读。', missing: [] },
      { key: 'order', title: '支付订单与提现', status: 'read-only',
        summary: '已接入上海全局订单只读查询；每次由上海核验当前管理员账号。退款与工单入口仍未开放。',
        missing: [{ interface: '退款政策与工单服务', why: '当前仅开放真实订单读取。', owner: '产品与上海服务' }] },
      { key: 'models', title: '模型路由', status: modelReady ? 'read-only' : 'dependency-unavailable', summary: modelDetail,
        missing: [{ interface: 'POST /api/qianshou/ai/admin/bind', why: '模型改绑尚未接入本管理台的确认与审计流程。', owner: '模型网关与管理台' }] },
    ]
  }
  const add = (key: 'models' | 'discovery' | 'order', run: (ctx: RouteContext) => Promise<Record<string, unknown>>) => options.route({
    path: `/${key}/overview`, auth: 'permission', permission: `${key}.read`, mutating: false,
    handler: async ctx => {
      if (ctx.scope !== 'all') { ctx.json(403, { ok: false, code: 'forbidden', message: '此模块读取全局数据，需要全部数据范围。' }); return }
      try { ctx.json(200, { ok: true, ...await run(ctx) }) }
      catch (error) {
        if (!(error instanceof WorkbenchUpstreamError) && !(error instanceof PaymentUpstreamError)) throw error
        ctx.json(error.status, { ok: false, code: error.code, message: error.message })
      }
    },
  })
  add('models', async ctx => models(ctx.admin!.accountId, ctx.role!.id))
  add('discovery', async () => readDiscovery(options.community))
  add('order', async ctx => {
    const access = ctx.session?.tokens?.access
    if (!access) throw new PaymentUpstreamError(401, 'payment_session_required', '请重新登录以取得上海账号会话。')
    const data = await options.payment(access, '/admin/payment/orders?limit=30&offset=0')
    if (!Array.isArray(data['items']) || typeof data['total'] !== 'number') {
      throw new PaymentUpstreamError(502, 'payment_contract_mismatch', '上海没有返回完整的全局订单列表。')
    }
    const keys = ['order_no', 'account_id', 'amount', 'currency', 'gateway', 'status', 'ledger_id', 'gateway_order_id', 'gateway_tx_id', 'created_at', 'paid_at', 'expired_at', 'remark']
    const items = data['items'].map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new PaymentUpstreamError(502, 'payment_contract_mismatch', '上海订单字段无效。')
      return Object.fromEntries(keys.filter(key => key in row).map(key => [key, row[key]]))
    })
    return { source: 'shanghai-admin-payment-orders', items, total: data['total'], limit: 30, offset: 0 }
  })
  return { readiness: rows }
}
