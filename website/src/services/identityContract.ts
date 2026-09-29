import type { AuthLoginResponse, AuthUser } from './api'
import type { SessionCode } from '../shared/session-coordinator'
const roles = new Set(['personal', 'enterprise', 'channel', 'admin'])
export function normalizedLogin(raw: any): AuthLoginResponse {
  const account = raw?.account || raw?.user
  const access = raw?.tokens?.access_token || raw?.access_token
  const refresh = raw?.tokens?.refresh_token || raw?.refresh_token
  const role = account?.role || raw?.role
  if (!account || !account.id || typeof access !== 'string' || !access || !roles.has(role)
    || account.status !== 'active' || (refresh != null && typeof refresh !== 'string')) throw new Error('服务器未返回有效的登录身份，请重新登录。')
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: raw?.tokens?.expires_in || raw?.expires_in || 0,
    role, user: { ...account, id: String(account.id), role } }
}
export function verifiedIdentity(raw: any): AuthUser {
  const account = raw?.account
  if (raw?.ok !== true || !account || !account.id || account.status !== 'active' || !roles.has(account.role)) throw new Error('当前账号不可用，无法进入工作空间。')
  return { ...account, id: String(account.id) }
}
const sessionMessages: Record<SessionCode, string> = {
  WEB_LOCKS_UNAVAILABLE: '当前浏览器不支持安全会话协调，请使用新版浏览器和 HTTPS。',
  SESSION_STORAGE_UNAVAILABLE: '浏览器存储不可用，请允许本站存储后重新登录。',
  SESSION_CHANGED: '登录状态已改变，请继续使用当前账号。',
  SESSION_REAUTH_REQUIRED: '当前会话需要重新登录。',
  SESSION_SCOPE_CONFLICT: '该会话不能从其他入口复制，请在个人工作台重新登录。',
  INVALID_TOKEN_PAIR: '登录凭证不完整或不一致，请重新登录。',
  REFRESH_REJECTED: '登录已失效，请重新登录。',
  REFRESH_UNCERTAIN: '会话续期结果不确定，请重新登录。',
  REFRESH_INVALID_RESPONSE: '会话续期响应无效，请重新登录。',
}
export function errorMessage(error: any, fallback: string): string {
  if (typeof error?.code === 'string' && Object.prototype.hasOwnProperty.call(sessionMessages, error.code)) {
    return sessionMessages[error.code as SessionCode]
  }
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail.length < 400) return detail
  if (error?.response?.status === 429) return '请求过于频繁，请稍后再试。'
  if (error?.response?.status >= 500) return '服务暂时不可用，请稍后再试。'
  if (error?.code === 'ERR_NETWORK') return '连接失败，请检查网络后重试。'
  return typeof error?.message === 'string' && !error.message.startsWith('Request failed') ? error.message : fallback
}
