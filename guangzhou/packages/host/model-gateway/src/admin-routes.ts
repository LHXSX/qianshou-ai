/**
 * 控制台的管理路由：列表、追加绑定、看历史。
 *
 * 这是「控制台」这个词的最后一块——数据面（`routing.ts`）已经能用，但**还没有人能通过界面操作它**。
 *
 * 安全要害：这几条路由能**改动全局路由**（所有人的模型都受影响），所以：
 *
 * 1. **授权必须显式注入，缺了就一律拒绝**（fail-closed）。绝不"没配置就当放行"——
 *    那是把最危险的路由交给一个默认值。
 * 2. **每次写入都必须带操作者**，写进绑定里。不知道是谁改的，等于不可追责。
 * 3. **生效日必须在未来**。允许改当下，就等于允许在计费周期中间换后端，
 *    用户会在同一次对话里看到消耗口径变化。
 * 4. **回读永远给全量历史**（含已失效的绑定），这样"改了什么"当场可验，
 *    而不是只能相信一次成功的响应。
 *
 * 仓库里没有管理面的先例，所以这里按最保守的方式定契约，不自己发明宽松规则。
 */

import { BACKENDS, type TierId } from './tiers.ts'
import { TIER_IDS } from './tiers.ts'
import type { LifecycleStage, PublishedNameRecord, RoutingConsole, UpgradeRule } from './routing.ts'

/** 管理路由路径。 */
export const ADMIN_NAMES_PATH = '/api/qianshou/ai/admin/names'
/** 追加绑定。 */
export const ADMIN_BIND_PATH = '/api/qianshou/ai/admin/bind'

/**
 * 一个**已验证**的主体。
 *
 * 为什么定义在这里而不是各路由各写一份：模型路由、审计、订阅、控制台四条面用的是
 * **同一个**身份判据。早先"是不是管理员"在两处各写了一遍（其中一处还多认了
 * `enterprise`），于是同一个人在不同路由上的身份不一致——这在权限判定上不可接受。
 *
 * 这个对象**只能由服务端权威的账号快照产生**（`plugin.ts` 里的 `principalOf`）：
 * `role` 直接来自 `/me` 的响应，不来自请求头、请求体、环境变量或磁盘缓存中的任何字段。
 */
export interface Principal {
  /** 账号 id（字符串化；上游可能给数字或字符串）。 */
  readonly accountId: string
  /** 平台角色原文（`personal` / `pro` / `enterprise` / `admin` …），由服务端给出。 */
  readonly role: string
  /** 是不是管理员。**只有 `true` 才能碰管理路由**。 */
  readonly isAdmin: boolean
}

/** 管理路由依赖。 */
export interface AiAdminDeps {
  readonly routing: RoutingConsole
  /**
   * 认出请求是哪个主体。
   * @param request - 原始请求。
   * **异步**：身份来自宿主侧的账号会话。
   * @returns 主体；认不出返回 `null`（路由回 401）。
   */
  readonly authenticate: (request: Request) => Promise<Principal | null> | Principal | null
  /** 时钟；测试注入。 */
  readonly now?: () => number
}

/** JSON 响应。 */
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

/** 归一化结果：要么给出值，要么给出一句能直接展示给管理员的原因。 */
type NormalizeResult<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly message: string }

/** 生命周期阶段与升级规则的合法取值（照 Azure 的成文取值）。 */
const STAGES: readonly LifecycleStage[] = ['preview', 'ga', 'legacy', 'deprecated', 'retired']
const RULES: readonly UpgradeRule[] = ['follow-default', 'on-expiry', 'never']

/** 读请求体；不是对象返回 `null`。 */
async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * 校验并归一化一个名字记录。
 *
 * 校验写得细，因为**这里错一个字段就会影响所有人的模型**：`tiers` 写错会让某个档位
 * 突然用不了任何模型，`backendKeys` 写错会让所有请求打到一个不存在的后端。
 * @param raw - 请求体。
 * @returns 归一化的记录，或一条可展示的错误说明。
 */
export function normalizeNameRecord(raw: Record<string, unknown>): NormalizeResult<PublishedNameRecord> {
  const publishedName = raw['publishedName']
  if (typeof publishedName !== 'string' || publishedName.trim().length === 0) {
    return { ok: false, message: 'publishedName 必填。' }
  }
  const rawTiers = Array.isArray(raw['tiers']) ? raw['tiers'] : []
  const tiers = rawTiers.filter((item): item is TierId => typeof item === 'string' && TIER_IDS.includes(item as TierId))
  if (tiers.length === 0) return { ok: false, message: '至少要指定一个档位（basic / plus / max）。' }
  const maxOutputTokens = raw['maxOutputTokens']
  if (typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    return { ok: false, message: 'maxOutputTokens 必须是正整数。' }
  }
  const stage = raw['lifecycleStage']
  if (stage !== undefined && (typeof stage !== 'string' || !STAGES.includes(stage as LifecycleStage))) {
    return { ok: false, message: `lifecycleStage 只能是 ${STAGES.join(' / ')}。` }
  }
  const rule = raw['upgradeRule']
  if (rule !== undefined && (typeof rule !== 'string' || !RULES.includes(rule as UpgradeRule))) {
    return { ok: false, message: `upgradeRule 只能是 ${RULES.join(' / ')}。` }
  }
  const label = typeof raw['label'] === 'string' && raw['label'].length > 0 ? raw['label'] : publishedName
  const order = typeof raw['order'] === 'number' && Number.isFinite(raw['order']) ? raw['order'] : 0
  const shutdownDate = typeof raw['shutdownDate'] === 'number' && Number.isFinite(raw['shutdownDate']) ? raw['shutdownDate'] : null
  const migrationTarget = typeof raw['migrationTarget'] === 'string' && raw['migrationTarget'].length > 0 ? raw['migrationTarget'] : null
  return {
    ok: true,
    record: {
      publishedName,
      label,
      tiers,
      maxOutputTokens,
      order,
      upgradeRule: (rule as UpgradeRule | undefined) ?? 'on-expiry',
      lifecycleStage: (stage as LifecycleStage | undefined) ?? 'ga',
      shutdownDate,
      migrationTarget,
    },
  }
}

/**
 * 校验追加绑定的输入。
 * @param raw - 请求体。
 * @param now - 当前时刻（用于强制"生效日在未来"）。
 * @returns 归一化的输入，或错误说明。
 */
export function normalizeBindInput(raw: Record<string, unknown>, now: number): { readonly ok: true; readonly input: Parameters<RoutingConsole['bind']>[0] } | { readonly ok: false; readonly message: string } {
  const publishedName = raw['publishedName']
  if (typeof publishedName !== 'string' || publishedName.length === 0) {
    return { ok: false, message: 'publishedName 必填。' }
  }
  const backendKeys = Array.isArray(raw['backendKeys']) ? raw['backendKeys'].filter((item): item is string => typeof item === 'string') : []
  if (backendKeys.length === 0) return { ok: false, message: '至少要指定一个后端。' }
  // 后端必须是**我们登记过的键**：写错一个字母就会让所有人的请求打到一个不存在的后端。
  const unknown = backendKeys.filter(key => BACKENDS[key] === undefined)
  if (unknown.length > 0) {
    return { ok: false, message: `不认识的后端：${unknown.join(', ')}。可用的是 ${Object.keys(BACKENDS).join(', ')}。` }
  }
  const effectiveFrom = raw['effectiveFrom']
  if (typeof effectiveFrom !== 'number' || !Number.isFinite(effectiveFrom)) {
    return { ok: false, message: 'effectiveFrom 必填（毫秒时间戳）。' }
  }
  if (effectiveFrom <= now) {
    // 允许改当下 = 允许在计费周期中间换后端，用户会在同一次对话里看到消耗口径变化。
    return { ok: false, message: '生效时刻必须在将来。要立刻生效请等一个周期，或联系运维走紧急流程。' }
  }
  const reason = raw['reason']
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, message: 'reason 必填：将来对账的人要知道为什么改。' }
  }
  const rolloutPercent = typeof raw['rolloutPercent'] === 'number' && Number.isFinite(raw['rolloutPercent']) ? raw['rolloutPercent'] : 100
  return { ok: true, input: { publishedName, backendKeys, effectiveFrom, reason, operator: '', rolloutPercent } }
}

/**
 * 建管理路由。
 * @param deps - 控制台、身份解析与时钟。
 * @returns 两个处理器：名字清单（含历史）与追加绑定。
 */
export function createAiAdminRoutes(deps: AiAdminDeps): {
  readonly names: (request: Request) => Promise<Response>
  readonly bind: (request: Request) => Promise<Response>
} {
  const now = deps.now ?? (() => Date.now())

  /** 统一的授权关卡。**缺授权一律拒绝**，不给任何默认放行。 */
  const guard = async (request: Request): Promise<{ readonly principal: Principal } | { readonly response: Response }> => {
    const principal = await deps.authenticate(request)
    if (principal === null) return { response: json({ ok: false, message: '请先登录。' }, 401) }
    if (!principal.isAdmin) return { response: json({ ok: false, message: '这个操作需要管理员权限。' }, 403) }
    return { principal }
  }

  return {
    names: async (request) => {
      const gated = await guard(request)
      if ('response' in gated) return gated.response
      const records = deps.routing.names()
      return json({
        ok: true,
        names: records.map(record => ({
          ...record,
          // 回读永远给全量历史（含已失效的），这样"改了什么"当场可验，
          // 而不是只能相信一次成功的响应。
          history: deps.routing.historyOf(record.publishedName),
        })),
        backends: Object.entries(BACKENDS).map(([key, backend]) => ({ key, id: backend.id, concurrency: backend.concurrency })),
      })
    },

    bind: async (request) => {
      const gated = await guard(request)
      if ('response' in gated) return gated.response
      const body = await readObject(request)
      if (body === null) return json({ ok: false, message: '请求格式不对。' }, 400)

      if (deps.routing.names().every(record => record.publishedName !== body['publishedName'])) {
        return json({ ok: false, message: '这个前台名字还没登记，请先用 /admin/names 登记。' }, 400)
      }
      const normalized = normalizeBindInput(body, now())
      if (!normalized.ok) return json({ ok: false, message: normalized.message }, 400)

      let history: readonly unknown[]
      try {
        history = deps.routing.bind({
          ...normalized.input,
          // 操作者来自**已验证的主体**，不接受请求体自报——否则追责链就断了。
          operator: gated.principal.accountId,
        })
      } catch (error) {
        return json({ ok: false, message: error instanceof Error ? error.message : '追加绑定失败。' }, 400)
      }
      return json({ ok: true, history })
    },
  }
}
