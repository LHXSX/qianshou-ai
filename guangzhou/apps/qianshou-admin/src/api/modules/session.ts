/** §2 会话与身份（API.md §2.2）。 */

import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type { SessionMe } from '../types'

export interface LoginRequest {
  readonly username: string
  readonly password: string
}

/**
 * `POST session/login` 的成功形状。
 * 两步走时返回 `challenge.challengeToken`，交由 `loginTotp` 完成第二步。
 */
export interface LoginResult {
  readonly twoFactor: boolean
  readonly challengeToken?: string
}

export interface LoginTotpRequest {
  readonly challengeToken: string
  readonly code: string
  readonly trustDevice: boolean
}

/** 第一步：账号密码。失败按 code 分类：401 invalid_credentials / 403 not_an_admin / 403 admin_disabled / 429 rate_limited / 502 upstream_unavailable。 */
export async function login(payload: LoginRequest): Promise<LoginResult> {
  const response = await postJson<{ ok: true; twoFactor: boolean; challenge?: { challengeToken?: string } }>(
    ENDPOINTS.sessionLogin,
    { username: payload.username, password: payload.password },
  )
  const result: LoginResult = { twoFactor: response.twoFactor === true }
  const challengeToken = response.challenge?.challengeToken
  if (typeof challengeToken === 'string' && challengeToken !== '') {
    return { twoFactor: result.twoFactor, challengeToken }
  }
  return result
}

/** 第二步：TOTP 验证码（或信任设备）。 */
export async function loginTotp(payload: LoginTotpRequest): Promise<void> {
  await postJson<{ ok: true }>(ENDPOINTS.sessionLoginTotp, {
    challengeToken: payload.challengeToken,
    code: payload.code,
    trustDevice: payload.trustDevice,
  })
}

/** 退出登录：吊销服务端会话并清 cookie。 */
export async function logout(): Promise<void> {
  await postJson<{ ok: true }>(ENDPOINTS.sessionLogout, {})
}

/** 当前身份：菜单、权限、就绪度、clientIp 全部来自服务端。 */
export async function fetchMe(): Promise<SessionMe> {
  const response = await postJson<{ ok: true } & SessionMe>(ENDPOINTS.sessionMe, {})
  return {
    admin: response.admin,
    permissions: response.permissions ?? [],
    menu: response.menu ?? [],
    readiness: response.readiness ?? [],
    clientIp: response.clientIp,
  }
}
