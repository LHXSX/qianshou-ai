/**
 * 账号 API 的数据形状。
 *
 * 这些字段名**照抄上游 OpenAPI**（`https://qianshousuanli.com/api/v8`），一个字母都不改：
 * 客户端与上游之间没有中间层，改名就等于改名失效。请求体因此也用 snake_case 原样发送，
 * 而不是在本包内做一层 camelCase 再映射回去——少一次映射就少一处对不上的地方。
 */

/** 上游账号对象（`GET /auth/me` 的 `account`，登录响应里的 `account` 同一形状）。 */
export interface Account {
  readonly id: number | string
  readonly username: string
  readonly email: string
  readonly role: string
  readonly status: string
  /** 账户余额；上游把余额直接放在登录响应里，所以「登录后立刻能显示余额」不需要第二次请求。 */
  readonly balance: number | string | null
  readonly created_at: string | null
  readonly last_login_at: string | null
}

/** 令牌对。`expires_in` 是 access token 的秒数，不是时间戳。 */
export interface TokenPair {
  readonly access_token: string
  readonly refresh_token: string | null
  readonly token_type: string
  readonly expires_in: number
}

/**
 * 响应里可能出现的兼容字段。
 *
 * `agent_token` 是**陷阱**：上游 `auth.py:178-179` 把它和 `refresh_token` 赋成同一个值，
 * v8 已删除 v1 的一年期 agent token，也不存在节点凭据接口。这里只把它记录成
 * 「可能是刷新型令牌」的候选值，绝不把它暴露成节点凭据，也不为它造任何抽象。
 */
export interface TokenCarrier {
  readonly ok?: boolean
  readonly tokens?: Partial<TokenPair> | null
  readonly access_token?: string
  readonly refresh_token?: string
  readonly agent_token?: string
  readonly token_type?: string
  readonly expires_in?: number
  readonly agent_token_expires_in?: number
  readonly role?: string
  readonly account?: Account | null
  readonly user?: unknown
}

/** 2FA 分支：账号开了 TOTP 且在不可信设备上登录时，上游返回的是挑战而不是令牌。 */
export interface TwoFactorChallenge {
  readonly ok: true
  readonly two_factor_required: true
  readonly challenge_token: string
  readonly challenge_expires_in: number
  readonly account_id: number | string
  /** 上游当前只提供 `'totp'`；保留数组形式以免上游加了恢复码就写死。 */
  readonly available_methods: readonly string[]
  readonly default_method: string
}

/** 登录结果：要么拿到令牌，要么必须补验 2FA。调用方必须两个分支都处理。 */
export type LoginResult =
  | { readonly kind: 'tokens'; readonly tokens: TokenPair; readonly account: Account | null }
  | { readonly kind: 'two-factor'; readonly challenge: TwoFactorChallenge }

/** 一条已登录会话（`GET /auth/sessions`）。 */
export interface AccountSession {
  readonly id: string
  readonly device: string | null
  readonly ip: string | null
  readonly user_agent: string | null
  readonly created_at: string | null
  readonly last_seen_at: string | null
  readonly expires_at: string | null
  readonly current: boolean
  readonly trusted: boolean
}

/** 一条安全日志（`GET /auth/security-logs`）。 */
export interface SecurityLogEntry {
  readonly id: string
  readonly event: string
  readonly created_at: string | null
  readonly ip: string | null
  readonly user_agent: string | null
  readonly detail: string | null
}

/** 资料（`PUT /my/profile` 的请求体与响应体共用；全部字段可选）。 */
export interface ProfileUpdate {
  readonly display_name?: string
  readonly phone?: string
  readonly language?: string
  readonly country?: string
  readonly avatar_url?: string
  readonly notification_prefs?: Readonly<Record<string, unknown>>
}

/** TOTP 状态（`GET /auth/totp/status`）。 */
export interface TotpStatus {
  readonly enabled: boolean
  readonly confirmed: boolean
  readonly trusted_device: boolean
  readonly recovery_codes_remaining: number | null
}

/** 会话可信时长；上游要一个明确的秒数，不给默认值，避免「信任多久」由客户端替用户决定。 */
export type TrustDuration = number

/** 注册请求。除 `password` 外全部可选——上游的事实就是用户名/邮箱都可选，客户端不擅自收紧。 */
export interface RegisterRequest {
  readonly password: string
  readonly username?: string
  readonly email?: string
  readonly company?: string
  readonly remember_me?: boolean
}

/** 登录请求。`username` 收用户名**或**邮箱，两者走同一个字段。 */
export interface LoginRequest {
  readonly username: string
  readonly password: string
  readonly remember_me?: boolean
}

/** 2FA 补验请求。 */
export interface LoginTotpRequest {
  /** 来自登录响应的 `challenge_token`。 */
  readonly challenge_token: string
  /** 6 位动态码。 */
  readonly code: string
  readonly trust_device?: boolean
  readonly remember_me?: boolean
}

/** 上海短信验证码按用途隔离，登录码不能用于注册。 */
export type SmsPurpose = 'register' | 'login'
export interface SmsSendRequest { readonly phone: string; readonly purpose: SmsPurpose }
export interface SmsSendResult {
  readonly phone: string
  readonly purpose: SmsPurpose
  readonly expiresIn: number
  readonly resendAfter: number
}
export interface PhoneLoginRequest {
  readonly phone: string
  readonly code: string
  readonly remember_me?: boolean
}
export interface PhoneRegisterRequest extends PhoneLoginRequest { readonly username?: string }

/** 改密码请求；两个字段都可选意味着上游不强制旧密码在每次都提交。 */
export interface ChangePasswordRequest {
  readonly password?: string
  readonly old_password?: string
}

/** 信任设备请求；三个字段上游都标了必填。 */
export interface TrustDeviceRequest {
  readonly code: string
  readonly current_password: string
  readonly duration: TrustDuration
}
