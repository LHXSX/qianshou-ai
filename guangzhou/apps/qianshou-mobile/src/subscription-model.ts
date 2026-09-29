/**
 * 订阅档的**前台目录与档位**：用户能看到的名字、能用的模型、还剩多少点数。
 *
 * 三条硬边界，写在这里而不是散在界面里：
 *
 * 1. **前台名字就是全部**。用户只会看到「千手·迅捷」「千手·强力」；后端真实模型标识
 *    （上游那家叫什么）绝不出网关，也绝不进这个文件。界面要渲染的一切都从这里取，
 *    于是"哪个名字能用"只有一处定义。
 * 2. **额度只能来自网关**。`remainingSp` 一律由 `/api/qianshou/ai/status` 读出，
 *    读不到就是 `null`——界面显示"额度未知"，绝不拿别的数字顶上去。
 * 3. **档位决定模型可见性**，不是反过来：`千手·迅捷` 所有档位都能用，`千手·强力`
 *    只在高级版 / Max。档位读不到时按**最保守**的一档显示（只列所有档位都能用的那个），
 *    因为"我承诺了一个你其实用不了的模型"比"少列一个"更糟。
 *
 * 身份边界（谁的钱被扣）不在这里判定，而在 `App.tsx`：只有"同源部署 + 已登录"才允许
 * 走订阅通道。这个文件只负责"这一档有什么"。
 */

/** 订阅档在连接设置里的服务商标识。 */
export const SUBSCRIPTION_PROVIDER_ID = 'subscription'

/**
 * 订阅档的端点标记。
 *
 * **它不是地址，永远不会被发出去**：走订阅通路时请求由 `subscription.ts` 发到当前页面的
 * 同源宿主路径。这里需要一个非空值，只是因为控制层的"配置完整性"判定要求端点非空——
 * 而空着会让订阅用户在没填过任何东西时被拦在"请先填服务地址"上。
 */
export const SUBSCRIPTION_BASE_URL = 'qianshou://subscription'

/** 宿主网关的对话路由；与 `packages/host/model-gateway/src/routes.ts` 的 `AI_CHAT_PATH` 一致。 */
export const AI_CHAT_PATH = '/api/qianshou/ai/chat'

/** 宿主网关的额度路由；与宿主侧 `AI_STATUS_PATH` 一致。 */
export const AI_STATUS_PATH = '/api/qianshou/ai/status'

/** 订阅档位标识；与宿主侧一致（basic / plus / max）。 */
export type SubscriptionTierId = 'basic' | 'plus' | 'max'

/** 一个前台模型：只有名字与它允许出现的档位。 */
export interface FrontModel {
  /** 前台名字，也是发给网关的 `model`。 */
  readonly name: string
  /** 允许使用它的档位。 */
  readonly tiers: readonly SubscriptionTierId[]
}

/**
 * 前台模型目录。
 *
 * 顺序即界面顺序；第一个是默认模型（也是所有档位都能用的那个）。
 */
export const FRONT_MODELS: readonly FrontModel[] = [
  { name: '千手·迅捷', tiers: ['basic', 'plus', 'max'] },
  { name: '千手·强力', tiers: ['plus', 'max'] },
]

/** 默认前台模型：所有档位都能用，所以任何档位下都是安全选择。 */
export const DEFAULT_FRONT_MODEL = FRONT_MODELS[0]?.name ?? ''

/** 这个服务商标识是不是订阅档。 */
export function isSubscriptionProvider(providerId: string): boolean {
  return providerId === SUBSCRIPTION_PROVIDER_ID
}

/** 一个名字是不是前台模型名。 */
export function isFrontModel(name: string): boolean {
  return FRONT_MODELS.some(model => model.name === name)
}

/** 宿主返回的档位标识是不是我们认识的那一档。 */
export function isSubscriptionTierId(value: unknown): value is SubscriptionTierId {
  return value === 'basic' || value === 'plus' || value === 'max'
}

/** 档位总数；`tiers.length` 等于它就意味着"每个档位都能用"。 */
const TIER_COUNT = 3

/**
 * 这一档能选的前台模型。
 * @param tier - 当前档位；读不到传 `null`。
 * @returns 可选的模型清单（`null` 档位时只返回所有档位通用的那些）。
 */
export function frontModelsForTier(tier: SubscriptionTierId | null): readonly FrontModel[] {
  if (tier === null) return FRONT_MODELS.filter(model => model.tiers.length >= TIER_COUNT)
  return FRONT_MODELS.filter(model => model.tiers.includes(tier))
}

/** 界面上要显示的档位与额度快照；**每个数字都来自网关**。 */
export interface SubscriptionCredit {
  /** 档位标识；认不出（宿主加了新档位）时为 `null`。 */
  readonly tierId: SubscriptionTierId | null
  /** 档位显示名（宿主给的那份，例如「高级版」）；读不到时为空串。 */
  readonly tierLabel: string
  /** 本月剩余点数（SP）；读不到时为 `null`，1 SP = 0.01 元。 */
  readonly remainingSp: number | null
  /** 本月授予的总点数；读不到时为 `null`。 */
  readonly monthlySp: number | null
  /** 五小时窗口内已用点数；读不到时为 `null`。 */
  readonly usedInWindowSp: number | null
  /** 五小时窗口上限；读不到时为 `null`。 */
  readonly windowLimitSp: number | null
}

/** 读额度的结果。 */
export type SubscriptionStatusResult =
  | { readonly ok: true; readonly credit: SubscriptionCredit }
  | { readonly ok: false; readonly reason: 'signed-out' | 'unavailable'; readonly message: string }

/**
 * 读一次当前档位与剩余额度。
 *
 * 身份靠**同源 cookie**——路由不接受任何请求头自报身份，所以这里不带凭据、也不带密钥。
 * 读不到时返回 `ok: false` 与一句可展示的中文，**绝不返回编造的点数**。
 * @param options - 可注入的 fetch 与请求信号，便于测试。
 * @returns 额度快照或失败说明。
 */
export async function readSubscriptionStatus(options: {
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
} = {}): Promise<SubscriptionStatusResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  let response: Response
  try {
    response = await fetchImpl(AI_STATUS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch {
    return { ok: false, reason: 'unavailable', message: '读不到订阅额度：连不上网关。' }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'signed-out', message: '读不到订阅额度：登录状态已过期。' }
  }
  if (!response.ok) {
    return { ok: false, reason: 'unavailable', message: `读不到订阅额度：网关返回 ${response.status}。` }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'unavailable', message: '读不到订阅额度：网关返回的不是 JSON。' }
  }
  return parseStatusPayload(payload)
}

/**
 * 解析额度响应。
 *
 * 单独抽成纯函数：宿主改字段时，这一条能在毫秒级的单测里被抓住，而不是等到界面上
 * 显示成"额度未知"再去猜是网络还是字段名。
 * @param payload - 已解析的响应体。
 * @returns 额度快照或失败说明。
 */
export function parseStatusPayload(payload: unknown): SubscriptionStatusResult {
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, reason: 'unavailable', message: '读不到订阅额度：网关返回的结构不对。' }
  }
  const body = payload as Record<string, unknown>
  if (body['ok'] !== true) {
    const message = typeof body['message'] === 'string' && body['message'].length > 0 ? body['message'] : '读不到订阅额度。'
    return { ok: false, reason: 'unavailable', message }
  }
  const tier = body['tier']
  const credit = body['credit']
  const tierFields = tier !== null && typeof tier === 'object' ? (tier as Record<string, unknown>) : {}
  const creditFields = credit !== null && typeof credit === 'object' ? (credit as Record<string, unknown>) : {}
  const tierId = tierFields['id']
  return {
    ok: true,
    credit: {
      tierId: isSubscriptionTierId(tierId) ? tierId : null,
      tierLabel: typeof tierFields['label'] === 'string' ? tierFields['label'] : '',
      remainingSp: finiteOrNull(creditFields['remainingSp']),
      monthlySp: finiteOrNull(creditFields['monthlySp']),
      usedInWindowSp: finiteOrNull(creditFields['usedInWindowSp']),
      windowLimitSp: finiteOrNull(creditFields['windowLimitSp']),
    },
  }
}

/** 取一个有限数字；不是数字或不是有限值一律返回 `null`（宁可显示"未知"也不编）。 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 点数显示。
 *
 * 网关给的点数最多两位小数（`0.07` / `389.93`），这里固定两位、不做四舍五入到整数——
 * 1 SP = 0.01 元，抹掉小数就等于抹掉钱。
 * @param sp - 点数；`null` 表示读不到。
 * @returns 可直接显示的文本；读不到时给出"未知"。
 */
export function formatSp(sp: number | null): string {
  if (sp === null) return '未知'
  return sp.toFixed(2)
}

/** 用户对「走哪条通道」的选择。 */
export type RouteChoice = 'auto' | 'subscription' | 'byok'

/** 这一次真正生效的通道。 */
export type AiRoute = 'subscription' | 'byok'

/** 判定通道所依据的事实；两个都必须来自可核对的证据，不能靠猜。 */
export interface RouteConditions {
  /** 页面与宿主同源（`account.ts` 的同源探测已通过）。 */
  readonly sameOrigin: boolean
  /**
   * 这台设备上有账号证据：本次会话已登录，或本机留着上次登录的账号。
   *
   * 它**不是**"我替你确认了凭据还有效"：宿主账号面没有 refresh 路由，手机端在冷启动时
   * 拿不到更权威的信号。凭据真的失效时由网关回 401，界面照实说"登录状态已过期"——
   * 那一次不会产生任何费用，也不会静默改道。
   */
  readonly signedIn: boolean
}

/**
 * 这一次走哪条通道。
 *
 * 为什么**不满足条件时一律回落到自带密钥**而不是"报错等用户处理"：BYOK 那条通路
 * 是"永远可用"的底线，用户不该因为订阅通道没准备好就不能说话。
 *
 * 为什么条件必须**同时**满足，缺一不可（这是安全边界，不是体验取舍）：
 * 配对/遥控形态下手机连的是**另一台电脑**，那里的 cookie 属于那台电脑的账号——
 * 用它会把这笔费用记到别人头上。所以只认"页面由宿主自己提供"（同源）这一种情形；
 * 非同源时哪怕用户显式选了订阅，也只走 BYOK。
 * @param choice - 用户的选择；`auto` 表示跟随条件。
 * @param conditions - 同源与账号事实。
 * @returns 生效通道。
 */
export function resolveAiRoute(choice: RouteChoice, conditions: RouteConditions): AiRoute {
  if (choice === 'byok') return 'byok'
  return usable(conditions) ? 'subscription' : 'byok'
}

/**
 * 订阅通道此刻可用不可用。
 * @param conditions - 同源与登录事实。
 * @returns 可用返回 `true`。
 */
export function usable(conditions: RouteConditions): boolean {
  return conditions.sameOrigin && conditions.signedIn
}

/**
 * 订阅通道用不了时，给用户一句**能解释清楚**的话。
 *
 * 两种原因分开写：一个是"这个页面不是从工作台打开的"（换地址就能解决），
 * 一个是"还没登录"（登录就能解决）。合成一句"订阅通道不可用"等于什么都没说。
 * @param conditions - 同源与登录事实。
 * @returns 不可用时的中文说明；可用时为 `null`。
 */
export function routeBlockReason(conditions: RouteConditions): string | null {
  if (conditions.sameOrigin && conditions.signedIn) return null
  if (!conditions.sameOrigin) return '订阅通道需要同源部署：这个页面不是从千手工作台打开的，所以只能走你自己的密钥。'
  return '订阅通道需要登录账号：这个页面还没有登录。登录后会自动切到订阅通道。'
}
