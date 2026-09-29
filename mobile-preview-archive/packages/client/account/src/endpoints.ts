/**
 * 上游端点与路径常量。
 *
 * 集中在一处的原因：PC 与手机两个 adapter 共用同一份路径，路径写散在两处迟早会漂移；
 * 而这里的每一条都来自上游 OpenAPI，改错一个字符就是 404。
 */

/** 生产接口基址。`GET /api/v8/health` 实测 200（2026-09-16，version 8.1.0）。 */
export const ACCOUNT_API_ORIGIN = 'https://qianshousuanli.com'

/** v8 前缀。基址与路径分开，是为了让测试能把整段前缀换成打桩服务。 */
export const ACCOUNT_API_PREFIX = '/api/v8'

/**
 * refresh token 的 cookie 路径。
 *
 * 上游对非 Tauri 客户端下发 httpOnly cookie `we_refresh_token`，并把路径限定在
 * `/api/v8/auth`——所以刷新请求必须落在该前缀下，否则浏览器根本不会带上这个 cookie。
 */
export const REFRESH_COOKIE_NAME = 'we_refresh_token'
export const REFRESH_COOKIE_PATH = `${ACCOUNT_API_PREFIX}/auth`

/** 上游路径表；除 `profile` 外都在 `/auth` 下。 */
export const ENDPOINTS = {
  register: '/auth/register',
  login: '/auth/login',
  loginTotp: '/auth/login/totp',
  smsSend: '/auth/sms/send',
  loginPhone: '/auth/login/phone',
  registerPhone: '/auth/register/phone',
  refresh: '/auth/refresh',
  me: '/auth/me',
  logout: '/auth/logout',
  sessions: '/auth/sessions',
  totpStatus: '/auth/totp/status',
  totpSetup: '/auth/totp/setup',
  totpConfirm: '/auth/totp/confirm',
  totpDisable: '/auth/totp/disable',
  securityLogs: '/auth/security-logs',
  profile: '/my/profile',
  /** 当前账号名下的节点；归属由上游 `owner_id` 守卫，不是客户端自己声明的。 */
  workers: '/workers',
} as const

/** 单个会话的路径；`sessionId` 来自 `GET /auth/sessions`，调用方不得自己拼 id。 */
export function sessionPath(sessionId: string): string {
  return `${ENDPOINTS.sessions}/${encodeURIComponent(sessionId)}`
}

/** 信任设备的路径。 */
export function sessionTrustPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/trust`
}

/** 去掉基址末尾的斜杠再与 `prefix + path` 拼接；避免出现 `//auth/login` 这种双斜杠。 */
export function accountUrl(baseUrl: string, path: string, prefix: string = ACCOUNT_API_PREFIX): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const normalizedPrefix = prefix.replace(/\/+$/, '')
  return `${trimmed}${normalizedPrefix}${path}`
}
