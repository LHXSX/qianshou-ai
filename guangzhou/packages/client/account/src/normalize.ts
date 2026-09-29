/**
 * 上游响应归一化：把「上游可能给的各种包装」收敛成本包自己的类型。
 *
 * 为什么要有这一层：本包只对少数**已核实**的字段名负责（`tokens`/`account`/
 * `two_factor_required` 等）。会话列表、安全日志、TOTP 状态、资料这些端点本轮
 * **没有逐字段核实**，写死 `payload.sessions` 的话，上游一旦把结果放在 `items`、
 * `data` 或直接给数组，客户端就会静默显示空列表——那比报错更难查。
 *
 * 因此这里的原则是：**结构上能认就认，认不出就如实说认不出**——归一化只做
 * 「取数组 / 取布尔 / 取字符串」这类不会误报的操作，**从不编造缺省值**，
 * 因为没有 id 的会话会让界面出现点不动的按钮，把「不知道」显示成
 * 「未开启 2FA」会让用户以为已经受保护。
 */
import type { Account, AccountSession, SecurityLogEntry, TotpStatus, TwoFactorChallenge } from './types.ts'

/** 对象判定。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 取第一个非空字符串，否则 `null`。 */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 取第一个有限数字（接受数字与纯数字字符串），否则 `null`。 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** 取第一个布尔（**只有真的布尔才算**），否则 `null`。 */
export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** 从多个候选键里找出第一个数组。 */
function firstArray(source: Record<string, unknown>, keys: readonly string[]): readonly unknown[] {
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/**
 * 取出列表：既接受 `{sessions: [...]}` / `{items: [...]}` / `{data: [...]}`，
 * 也接受直接给一个数组的响应。
 *
 * 已知边界：如果上游把列表放在 `{ok:true, data:{items:[...]}}` 这种**两层**包装里，
 * 这里认不出来。不猜第二层的理由——猜错的代价是「显示了并不存在的数据」，
 * 而认不出的代价只是空列表，后者安全得多。
 */
export function asList(payload: unknown, keys: readonly string[]): readonly unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  return firstArray(payload, keys)
}

/** 取字段值：先试 `keys` 里的每个键，全都取不到时返回 `undefined`。 */
function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 归一化一条会话；缺 id 的条目直接丢掉，因为撤销需要 id。 */
function asSession(value: unknown): AccountSession | null {
  if (!isRecord(value)) return null
  const id = asString(pick(value, ['id', 'session_id']))
  if (id === null) return null
  return {
    id,
    device: asString(pick(value, ['device', 'device_name'])),
    ip: asString(pick(value, ['ip', 'ip_address'])),
    user_agent: asString(value.user_agent),
    created_at: asString(value.created_at),
    last_seen_at: asString(pick(value, ['last_seen_at', 'last_used_at'])),
    expires_at: asString(value.expires_at),
    // 认不出「是不是当前会话」时按 false 处理：界面据此只决定要不要显示「当前设备」标签，
    // 显示与否不影响任何写操作，所以这里的缺省不会造成误判。
    current: asBoolean(pick(value, ['current', 'is_current'])) ?? false,
    trusted: asBoolean(pick(value, ['trusted', 'is_trusted'])) ?? false,
  }
}

/** 会话列表。 */
export function normalizeSessions(payload: unknown): readonly AccountSession[] {
  const out: AccountSession[] = []
  for (const entry of asList(payload, ['sessions', 'items', 'data'])) {
    const session = asSession(entry)
    if (session !== null) out.push(session)
  }
  return out
}

/** 归一化一条安全日志；连事件名都没有的条目丢掉，因为它在界面上只是一行空白。 */
function asSecurityLog(value: unknown): SecurityLogEntry | null {
  if (!isRecord(value)) return null
  const event = asString(pick(value, ['event', 'action', 'type']))
  if (event === null) return null
  return {
    // `event` 已经证明了 `pick` 能取到字符串；id 取不到时给空串当列表 key，
    // 不去编造一个假 id。
    id: asString(pick(value, ['id', 'log_id'])) ?? '',
    event,
    created_at: asString(pick(value, ['created_at', 'ts'])),
    ip: asString(pick(value, ['ip', 'ip_address'])),
    user_agent: asString(value.user_agent),
    detail: asString(pick(value, ['detail', 'message'])),
  }
}

/** 安全日志列表。 */
export function normalizeSecurityLogs(payload: unknown): readonly SecurityLogEntry[] {
  const out: SecurityLogEntry[] = []
  for (const entry of asList(payload, ['logs', 'items', 'security_logs', 'data'])) {
    const log = asSecurityLog(entry)
    if (log !== null) out.push(log)
  }
  return out
}

/**
 * 归一化 TOTP 状态。
 *
 * `enabled` 认不出来时**返回 `null` 而不是 `false`**：把「不知道」显示成「未开启 2FA」
 * 会让用户在没开保护的情况下以为已经开了，这是安全界面上最不该出现的默认值。
 */
export function normalizeTotpStatus(payload: unknown): TotpStatus | null {
  if (!isRecord(payload)) return null
  const enabled = asBoolean(payload.enabled)
  if (enabled === null) return null
  return {
    enabled,
    confirmed: asBoolean(pick(payload, ['confirmed', 'verified'])) ?? enabled,
    trusted_device: asBoolean(pick(payload, ['trusted_device', 'trusted'])) ?? false,
    recovery_codes_remaining: asNumber(pick(payload, ['recovery_codes_remaining', 'recovery_codes_left'])),
  }
}

/**
 * 归一化账号对象。
 *
 * `id` 缺失时返回 `null`：`Account.id` 是双端唯一的共同身份，凭空造一个
 * （例如拿用户名当 id）会让手机和电脑对不上号，而这正是本次要解决的问题。
 */
export function normalizeAccount(payload: unknown): Account | null {
  if (!isRecord(payload)) return null
  const id = payload.id
  if (typeof id !== 'number' && typeof id !== 'string') return null
  if (typeof id === 'string' && id.length === 0) return null
  return {
    id,
    username: asString(payload.username) ?? '',
    email: asString(payload.email) ?? '',
    role: asString(payload.role) ?? '',
    status: asString(payload.status) ?? '',
    balance: typeof payload.balance === 'number' || typeof payload.balance === 'string' ? payload.balance : null,
    created_at: asString(payload.created_at),
    last_login_at: asString(payload.last_login_at),
  }
}

/**
 * 判断一个登录响应是不是 2FA 分支。
 *
 * 判定要求 `two_factor_required === true` **且** 有 `challenge_token`：只看前者，
 * 上游将来加了别的挑战类型我们会把半成品当 2FA；只看后者，字段名变更会被漏判。
 */
export function asTwoFactorChallenge(payload: unknown): TwoFactorChallenge | null {
  if (!isRecord(payload)) return null
  if (payload.two_factor_required !== true) return null
  const challengeToken = asString(payload.challenge_token)
  if (challengeToken === null) return null
  const rawMethods = payload.available_methods
  const methods = Array.isArray(rawMethods)
    ? rawMethods.flatMap((method): string[] => {
      if (typeof method === 'string') return [method]
      if (isRecord(method) && typeof method.method === 'string') return [method.method]
      return []
    })
    : []
  const accountId = payload.account_id
  return {
    ok: true,
    two_factor_required: true,
    challenge_token: challengeToken,
    challenge_expires_in: asNumber(payload.challenge_expires_in) ?? 0,
    account_id: typeof accountId === 'number' || typeof accountId === 'string' ? accountId : '',
    available_methods: methods,
    default_method: asString(payload.default_method) ?? 'totp',
  }
}
