/**
 * 订阅的管理面：管理员给账号开通/改档，以及查订阅状态。
 *
 * 为什么必须有这条路：如果没有它，订阅只能靠改代码或直接编辑文件来开通——
 * 那不是产品，那是运维操作。用户付完钱之后，**中间一定有一个"给这个账号开通"的动作**，
 * 这个路由就是它。
 *
 * 两条路由，都要求管理员：
 * - `POST /api/qianshou/ai/admin/subscription`：开通/改档（追加一条记录）。
 * - `POST /api/qianshou/ai/admin/subscriptions`：读某账号的订阅历史。
 *
 * 刻意不做的事：**不做支付**。支付回调、订单号、退款这些应当由部署方接自己的
 * 支付系统，然后调这条路由。这里只负责"钱已经收过了，把权益给上"，
 * 以及留痕（`grantedBy` / `reason`）供对账。
 */
import type { Subscription, TierStore } from './tier-store.ts'
import { TIERS, TIER_IDS, type TierId } from './tiers.ts'
import type { Principal } from './admin-routes.ts'

/** 开通/改档路由。 */
export const ADMIN_SUBSCRIPTION_PATH = '/api/qianshou/ai/admin/subscription'
/** 读订阅历史路由。 */
export const ADMIN_SUBSCRIPTIONS_PATH = '/api/qianshou/ai/admin/subscriptions'

/** 管理面依赖。 */
export interface SubscriptionAdminDeps {
  readonly store: TierStore
  /** 认出主体；与模型路由控制台同一套判据（身份来自宿主侧账号会话的服务端核验结果）。 */
  readonly authenticate: (request: Request) => Promise<Principal | null> | Principal | null
  /** 时钟；测试注入。 */
  readonly now?: () => number
}

/** 统一 JSON 响应。 */
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** 一天有多少毫秒。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 校验后的开通输入。 */
interface GrantInput {
  readonly accountId: string
  readonly tier: TierId
  readonly from: number
  readonly to: number | null
  readonly reason: string
}

/**
 * 校验一条开通请求。
 *
 * 校验都在**提交前**给可行动的说明，而不是抛一个泛化的失败：
 * 管理员正在办事，他需要知道"哪里不对、怎么改"。
 * @param body - 请求体。
 * @param at - 当前时刻。
 * @returns 合法输入，或一句面向用户的原因。
 */
function validate(body: Record<string, unknown>, at: number): GrantInput | { readonly message: string } {
  const accountId = body['accountId']
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    return { message: '要开通给哪个账号？请给出 accountId。' }
  }
  const tier = body['tier']
  if (typeof tier !== 'string' || !TIER_IDS.includes(tier as TierId)) {
    return { message: `档位只能是 ${TIER_IDS.join(' / ')} 之一。` }
  }
  const from = typeof body['from'] === 'number' && Number.isFinite(body['from']) ? body['from'] : at
  // 期限：允许显式 null（内部账号），或给天数（更不容易算错），或直接给到期时刻。
  let to: number | null
  if (body['to'] === null) {
    to = null
  } else if (typeof body['to'] === 'number' && Number.isFinite(body['to'])) {
    to = body['to']
  } else if (typeof body['days'] === 'number' && Number.isFinite(body['days']) && body['days'] > 0) {
    to = from + Math.floor(body['days']) * DAY_MS
  } else {
    // 不给期限就拒绝：默认"永久"等于忘记续费就永远免费，那是个会漏钱的默认值。
    return { message: '请给出期限：days（天数）或 to（到期时刻）；确实不过期请显式传 to: null。' }
  }
  if (to !== null && to <= from) return { message: '到期时刻必须晚于生效时刻。' }
  const reason = typeof body['reason'] === 'string' && body['reason'].trim().length > 0
    ? body['reason'].trim()
    : ''
  if (reason.length === 0) {
    // 留痕不是可选项：对账时要能解释"为什么给他这一档"。
    return { message: '请给出 reason（订单号或活动名）——对账时要靠它解释。' }
  }
  return { accountId: accountId.trim(), tier: tier as TierId, from, to, reason }
}

/**
 * 建管理面的订阅处理器。
 * @param deps - 订阅存储与身份解析。
 * @returns 两个处理器：开通与查询。
 */
export function createSubscriptionAdminRoutes(deps: SubscriptionAdminDeps): {
  readonly grant: (request: Request) => Promise<Response>
  readonly list: (request: Request) => Promise<Response>
} {
  const now = deps.now ?? (() => Date.now())

  /**
   * 统一的"必须是管理员"闸门。
   *
   * 未登录 401（去登录）、已登录但非管理员 403（权限不够）：**两种必须分开**，
   * 因为界面据此显示的下一步动作不同。早先这里把两者都回 401，于是"没权限"被
   * 显示成"请去登录"（WP1 A-11）。
   */
  const requireAdmin = async (request: Request): Promise<{ readonly accountId: string } | Response> => {
    const principal = await deps.authenticate(request)
    if (principal === null) return json({ ok: false, message: '请先登录。' }, 401)
    if (!principal.isAdmin) return json({ ok: false, message: '这个操作需要管理员权限。' }, 403)
    return { accountId: principal.accountId }
  }

  return {
    grant: async (request) => {
      const admin = await requireAdmin(request)
      if (admin instanceof Response) return admin
      let body: Record<string, unknown>
      try {
        body = await request.json() as Record<string, unknown>
      } catch {
        return json({ ok: false, message: '请求格式不对。' }, 400)
      }
      const validated = validate(body, now())
      if ('message' in validated) return json({ ok: false, message: validated.message }, 400)

      const subscription: Subscription = {
        accountId: validated.accountId,
        tier: validated.tier,
        from: validated.from,
        to: validated.to,
        // 操作者来自**已验证的主体**，不信请求体自报——否则谁都把自己写成"由管理员开通"。
        grantedBy: admin.accountId,
        reason: validated.reason,
      }
      deps.store.grant(subscription)
      return json({
        ok: true,
        subscription,
        tier: { id: validated.tier, label: TIERS[validated.tier].label, monthlySp: TIERS[validated.tier].monthlySp },
      })
    },

    list: async (request) => {
      const admin = await requireAdmin(request)
      if (admin instanceof Response) return admin
      let accountId: string | null = null
      try {
        const body = await request.json() as { accountId?: unknown }
        if (typeof body.accountId === 'string' && body.accountId.length > 0) accountId = body.accountId
      } catch {
        // 不带账号就返回全部账号的概览。
      }
      const at = now()
      if (accountId === null) {
        return json({
          ok: true,
          count: deps.store.accounts().length,
          accounts: deps.store.accounts().map(id => ({
            accountId: id,
            tier: deps.store.tierOf(id, at),
            records: deps.store.historyOf(id).length,
          })),
        })
      }
      return json({
        ok: true,
        accountId,
        tier: deps.store.tierOf(accountId, at),
        history: deps.store.historyOf(accountId),
      })
    },
  }
}
