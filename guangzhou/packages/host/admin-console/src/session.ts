/**
 * 管理台自己的会话。
 *
 * 为什么账号体系复用、会话却要另立：**入口不同**。账号体系属于上海那边的
 * `/api/v8`，它是给手机端/电脑端用的；管理台是独立的域名与独立的服务，
 * 浏览器在这里没有上游的 cookie。所以这里的做法是：
 * 登录时把账号口令**原样转发**给上游（不落盘、不回显），拿到上游令牌后
 * 在**本进程内存**里建一条管理台会话，浏览器只拿到一个不透明随机串。
 *
 * 四条刻意的选择：
 *
 * 1. **会话只在内存里**。进程重启 = 所有人重新登录。写盘会让"服务器被读走文件"
 *    等于"拿到一个还能用的管理台会话"；而管理台的会话有效期本来就不该长到需要跨重启。
 * 2. **存的是哈希**。内存里也只放 `sha256(token)`：即使有人 dump 进程内存，
 *    拿到的也不是能直接用的 cookie 值。
 * 3. **上游令牌不落盘、不进日志、不出进程**。它用于支付管理转发及定期向 `/auth/me`
 *    确认"这个人的账号会话还有效"，一旦上游明确拒绝（401/账号停用）立刻吊销管理台会话。
 * 4. **绝对有效期 + 空闲有效期**。绝对上限挡住"一直挂着不退出"，空闲超时挡住
 *    "人走了浏览器忘关"。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 上游令牌（只留在内存）。 */
export interface UpstreamTokens {
  readonly access: string
  readonly refresh: string | null
}

/** 一条管理台会话。 */
export interface SessionRecord {
  /** 上游 accountId（字符串化）。 */
  readonly accountId: string
  /** 登录时从上游带过来的展示名。 */
  readonly displayName: string
  readonly createdAt: number
  lastSeenAt: number
  readonly expiresAt: number
  /** 建会话时的来源 IP（只做展示与审计；白名单按每次请求的实时 IP 判）。 */
  readonly ip: string
  /** 上游令牌；仅内存。 */
  tokens: UpstreamTokens | null
  /** 上次向上游核验身份的时刻。 */
  lastVerifiedAt: number
}

/** 会话句柄。 */
export interface SessionStore {
  /** 建会话，返回**明文**令牌（只在这一刻存在于服务端）。 */
  readonly issue: (record: Omit<SessionRecord, 'lastSeenAt' | 'lastVerifiedAt'>) => string
  /** 取会话；不存在/过期/空闲超时返回 `null`（过期即删除）。 */
  readonly get: (token: string) => SessionRecord | null
  /** 更新 `lastSeenAt`。 */
  readonly touch: (token: string) => void
  /** 吊销单条。 */
  readonly revoke: (token: string) => boolean
  /** 吊销某账号的全部会话（改角色、停用、登出时用）。 */
  readonly revokeByAccount: (accountId: string) => number
  /** 当前存活会话数（运维视图）。 */
  readonly size: () => number
  /** 当前存活会话的只读快照（不含令牌）。 */
  readonly list: () => readonly Omit<SessionRecord, 'tokens'>[]
}

/** 令牌哈希（不进内存明文）。 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 建会话存储。
 * @param options - 有效期、时钟与令牌生成器（测试注入）。
 * @returns 句柄。
 */
export function createSessionStore(options: {
  /** 绝对有效期（默认 12 小时）。 */
  readonly ttlMs?: number
  /** 空闲有效期（默认 2 小时）。 */
  readonly idleMs?: number
  readonly now?: () => number
  readonly newToken?: () => string
} = {}): SessionStore {
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000
  const idleMs = options.idleMs ?? 2 * 60 * 60 * 1000
  const now = options.now ?? (() => Date.now())
  const newToken = options.newToken ?? (() => randomBytes(32).toString('base64url'))
  const sessions = new Map<string, SessionRecord>()

  const alive = (record: SessionRecord, at: number): boolean =>
    at < record.expiresAt && at - record.lastSeenAt < idleMs

  return {
    issue: (record) => {
      const token = newToken()
      const at = now()
      // 绝对有效期取「调用方给的 expiresAt」与「本存储的上限」里更早的那个：
      // 调用方算错（比如给了一个超长有效期）也不会让会话活得比上限更久。
      const expiresAt = Math.min(record.expiresAt, at + ttlMs)
      sessions.set(hashToken(token), { ...record, expiresAt, lastSeenAt: at, lastVerifiedAt: 0 })
      return token
    },
    get: (token) => {
      const key = hashToken(token)
      const record = sessions.get(key)
      if (record === undefined) return null
      const at = now()
      if (!alive(record, at)) {
        sessions.delete(key)
        return null
      }
      return record
    },
    touch: (token) => {
      const record = sessions.get(hashToken(token))
      if (record !== undefined) record.lastSeenAt = now()
    },
    revoke: token => sessions.delete(hashToken(token)),
    revokeByAccount: (accountId) => {
      let removed = 0
      for (const [key, record] of [...sessions.entries()]) {
        if (record.accountId === accountId) {
          sessions.delete(key)
          removed += 1
        }
      }
      return removed
    },
    size: () => sessions.size,
    list: () => [...sessions.values()].map(({ tokens: _tokens, ...rest }) => rest),
  }
}

/** 会话 cookie 名。 */
export const SESSION_COOKIE = 'qianshou_admin_sid'

/** 默认绝对有效期，供 CLI/文档引用。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * 生成 Set-Cookie 头。
 *
 * `SameSite=Strict` 是这里唯一有效的 CSRF 防线（我们不引入额外的 CSRF 令牌）：
 * 跨站请求不会带上它。配合"所有接口都是 POST + JSON"（简单请求发不出来），
 * 跨站伪造的路径被堵死。
 * @param token - 会话令牌。
 * @param maxAgeSeconds - 有效期秒数。
 * @returns 头部值。
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

/** 清除 cookie 的头。 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

/**
 * 从 Cookie 头里取会话令牌。
 * @param header - `Cookie` 头原文。
 * @returns 令牌；没有返回 `null`。
 */
export function readSessionCookie(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(`${SESSION_COOKIE}=`)) continue
    const value = trimmed.slice(SESSION_COOKIE.length + 1)
    return value.length > 0 ? value : null
  }
  return null
}

/**
 * 定时比较（这里用于确认前缀相同）：保留工具函数以避免将来手写 `===` 比较哈希。
 * @param left - 原文。
 * @param right - 原文。
 * @returns 相等返回 `true`。
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
