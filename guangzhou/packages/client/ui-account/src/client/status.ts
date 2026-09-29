/**
 * 把网关原样返回的 JSON 折叠成界面事实。
 *
 * 一条贯穿全文件的纪律：**读不懂的字段一律不猜**。
 * 网关将来加字段、改层级或换了版本号，界面显示"未知"是**诚实**的；
 * 显示一个编造的数字是**最坏**的——用户会据此决定要不要充值。
 *
 * 实测的 200 正文（2026-09-16，本机 3091）：
 * ```json
 * {
 *   "ok": true, "version": "qianshou.ai.v1",
 *   "tier": { "id": "basic", "label": "普通版", "monthlyYuan": 39 },
 *   "credit": { "remainingSp": 389.53, "monthlySp": 390,
 *               "usedInWindowSp": 0.47, "windowLimitSp": 60 },
 *   "limits": { "contextLimitTokens": 64000, "concurrency": 5 }
 * }
 * ```
 */

/** 网关报出的档位；`label` 与 `monthlyYuan` 由服务端给，界面不硬编码价格。 */
export interface TierFacts {
  /** 档位 id：`basic` / `plus` / `max`，未来可能更多。 */
  readonly id: string
  /** 服务端给的中文档位名。 */
  readonly label: string
  /** 每月应付金额（元）；服务端没给就是 `null`。 */
  readonly monthlyYuan: number | null
}

/** 额度事实。单位是 SP（1 SP = 0.01 元），精度取到分位由服务端决定。 */
export interface CreditFacts {
  /** 本计费周期剩余 SP。 */
  readonly remainingSp: number
  /** 本计费周期总量 SP；服务端没给就是 `null`。 */
  readonly monthlySp: number | null
  /** 滚动窗口内已用 SP。 */
  readonly usedInWindowSp: number | null
  /** 滚动窗口上限 SP。 */
  readonly windowLimitSp: number | null
}

/** 并发与上下文限制。 */
export interface LimitFacts {
  readonly contextLimitTokens: number | null
  readonly concurrency: number | null
}

/** 一次成功的额度读取。 */
export interface GatewayFacts {
  /** 服务端报的协议版本；用于将来并存时判断。 */
  readonly version: string | null
  readonly tier: TierFacts
  readonly credit: CreditFacts
  readonly limits: LimitFacts
}

/** 登录后的账号事实；只保留界面要显示的字段。 */
export interface AccountFacts {
  readonly id: string
  /** 用户名；上游可能给空串。 */
  readonly username: string
  readonly email: string
  /** 上游角色，`personal` / `admin` / `enterprise`。 */
  readonly role: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取字符串；不是字符串就返回 `null`（不 `String()` 强转，那会把 `{}` 变成 `"[object Object]"`）。 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 取有限数字；`NaN`/`Infinity`/字符串数字都不算。 */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 解析额度状态正文。
 * @param payload - `response.json()` 的结果。
 * @returns 折叠后的事实；`ok !== true` 或档位读不出来时返回 `null`。
 */
export function parseGatewayStatus(payload: unknown): GatewayFacts | null {
  if (!isRecord(payload)) return null
  if (payload.ok !== true) return null
  const tier = payload.tier
  const credit = payload.credit
  const limits = payload.limits
  if (!isRecord(tier) || !isRecord(credit)) return null
  const tierId = str(tier.id)
  const remainingSp = num(credit.remainingSp)
  if (tierId === null || remainingSp === null) return null
  return {
    version: str(payload.version),
    tier: { id: tierId, label: str(tier.label) ?? tierId, monthlyYuan: num(tier.monthlyYuan) },
    credit: {
      remainingSp,
      monthlySp: num(credit.monthlySp),
      usedInWindowSp: num(credit.usedInWindowSp),
      windowLimitSp: num(credit.windowLimitSp),
    },
    limits: isRecord(limits)
      ? { contextLimitTokens: num(limits.contextLimitTokens), concurrency: num(limits.concurrency) }
      : { contextLimitTokens: null, concurrency: null },
  }
}

/** 账号会话状态路由的解析结果。 */
export type AccountStateFacts =
  | { readonly state: 'authenticated'; readonly account: AccountFacts }
  | { readonly state: 'anonymous' }
  | { readonly state: 'unknown' }

/**
 * 解析账号会话正文。
 *
 * 三种结果分得很细，因为**它们导向完全不同的界面动作**：
 * `authenticated` 显示名字；`anonymous` 显示"未登录"并把登录入口推到眼前；
 * `unknown` 是宿主没答上话（网络/服务异常），此时**不能**说"未登录"——
 * 那会让一个已登录的人去重新登录，而问题其实在别处。
 */
export function parseAccountState(payload: unknown): AccountStateFacts {
  if (!isRecord(payload)) return { state: 'unknown' }
  if (payload.ok !== true) return { state: 'unknown' }
  const state = str(payload.state)
  if (state === 'authenticated') {
    const account = payload.account
    if (!isRecord(account)) return { state: 'unknown' }
    const id = account.id
    const idText = typeof id === 'number' ? String(id) : str(id)
    if (idText === null) return { state: 'unknown' }
    return {
      state: 'authenticated',
      account: {
        id: idText,
        username: str(account.username) ?? '',
        email: str(account.email) ?? '',
        role: str(account.role) ?? 'personal',
      },
    }
  }
  if (state === 'anonymous' || state === 'unauthenticated' || state === 'none') return { state: 'anonymous' }
  return { state: 'unknown' }
}

/**
 * SP → 元的显示串。
 *
 * 为什么在客户端换算：网关按 SP 记账（1 SP = 0.01 元），而**用户想的是钱**。
 * 汇率常量在这里是**显示用**的，不参与计费——计费只在服务端发生，
 * 客户端任何数字都不可能改变账单。
 * @param sp - SP 数量。
 * @returns 形如 `3.90` 的元金额串，两位小数。
 */
export function yuanOfSp(sp: number): string {
  return (sp / 100).toFixed(2)
}

/**
 * 剩余比例 [0, 1]；总量读不出来或为零时返回 `null`。
 * @param credit - 额度事实。
 * @returns 比例，或 `null`（表示"算不出来"，界面画不确定态而不是画 0%）。
 */
export function remainingRatio(credit: CreditFacts): number | null {
  const total = credit.monthlySp
  if (total === null || total <= 0) return null
  return Math.min(1, Math.max(0, credit.remainingSp / total))
}
