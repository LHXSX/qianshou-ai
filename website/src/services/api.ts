import axios, { type InternalAxiosRequestConfig } from 'axios'
import { browserSession, SessionError, type RequestLease, type WebLoginAttempt } from './browserSession'
import { normalizedLogin, verifiedIdentity } from './identityContract'

// All browser credentials stay on the current origin; no environment or localhost fallback.
const BASE_URL = '/api/v8'
const transportOptions = {
  baseURL: BASE_URL,
  adapter: 'fetch' as const,
  withCredentials: false,
  fetchOptions: { credentials: 'omit', mode: 'same-origin', redirect: 'error' },
  headers: { 'Content-Type': 'application/json' },
}
const api = axios.create(transportOptions)
// Login verification and server logout use explicit credentials and never refresh implicitly.
const authTransport = axios.create(transportOptions)

const WEB_DEVICE_CREDENTIAL_KEY = 'web_device_credential'
const WEB_DEVICE_FINGERPRINT_KEY = 'web_device_fingerprint'

function readDeviceCredential(): string | null {
  return sessionStorage.getItem(WEB_DEVICE_CREDENTIAL_KEY)
}

function storeDeviceCredential(credential?: string | null) {
  if (!credential) return
  sessionStorage.setItem(WEB_DEVICE_CREDENTIAL_KEY, credential)
}

function clearDeviceCredential() {
  sessionStorage.removeItem(WEB_DEVICE_CREDENTIAL_KEY)
  localStorage.removeItem(WEB_DEVICE_CREDENTIAL_KEY)
}

function getOrCreateDeviceFingerprint(): string {
  try {
    const existing =
      localStorage.getItem(WEB_DEVICE_FINGERPRINT_KEY) ||
      sessionStorage.getItem(WEB_DEVICE_FINGERPRINT_KEY)
    if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) {
      localStorage.setItem(WEB_DEVICE_FINGERPRINT_KEY, existing)
      return existing
    }
    const created =
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID().replace(/-/g, '')
        : `fp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
    localStorage.setItem(WEB_DEVICE_FINGERPRINT_KEY, created)
    return created
  } catch {
    return `fp${Date.now().toString(36)}`
  }
}

// S3-T6 · 2026-06-07 · 通用 HTTP 客户端 export (给非 myApi/auth 等模块的页面用 · 已带 token 拦截器)
export const httpClient = api

export function isJwtExpired(token: string | null | undefined): boolean {
  if (!token) return true
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return true
    const middle = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(middle.padEnd(Math.ceil(middle.length / 4) * 4, '=')))
    return !Number.isFinite(payload.exp) || payload.exp * 1000 < Date.now() + 60_000
  } catch { return true }
}
interface SessionRequest extends InternalAxiosRequestConfig {
  _sessionLease?: RequestLease | null
  _sessionTracked?: boolean
  _retried?: boolean
}
const publicAuthPaths = new Set([
  '/api/v8/auth/login', '/api/v8/auth/login/totp', '/api/v8/auth/register',
  '/api/v8/auth/sms/send', '/api/v8/auth/login/phone', '/api/v8/auth/register/phone',
])
function sameOriginPath(config: InternalAxiosRequestConfig) {
  const url = new URL(api.getUri(config), window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/v8/')) {
    throw new Error('会话请求只允许发送到当前站点 API。')
  }
  return url.pathname
}
function assertResponseIdentity(config?: SessionRequest) {
  if (!config?._sessionTracked) return
  if (config._sessionLease ? !browserSession.isCurrent(config._sessionLease) : browserSession.capture() !== null) {
    throw new SessionError('SESSION_CHANGED')
  }
}
api.interceptors.request.use(async (raw) => {
  const config = raw as SessionRequest
  const path = sameOriginPath(config)
  if (path === '/api/v8/auth/refresh') throw new Error('会话刷新必须通过统一协调器。')
  // Explicitly use the fetch adapter: XHR withCredentials=false still accepts same-origin cookies.
  config.withCredentials = false
  config.adapter = 'fetch'
  config.fetchOptions = { ...config.fetchOptions, credentials: 'omit', mode: 'same-origin', redirect: 'error' }
  if (!publicAuthPaths.has(path)) {
    let lease = config._retried ? config._sessionLease : browserSession.capture()
    if (lease && !browserSession.isCurrent(lease)) throw new SessionError('SESSION_CHANGED')
    if (lease && isJwtExpired(lease.accessToken)) lease = await browserSession.refresh(lease)
    if (lease && !browserSession.isCurrent(lease)) throw new SessionError('SESSION_CHANGED')
    config._sessionLease = lease ?? null
    config._sessionTracked = true
    if (lease) config.headers.Authorization = `Bearer ${lease.accessToken}`
    else config.headers.delete('Authorization')
  } else {
    config.headers.delete('Authorization')
  }
  config.headers['X-Device-Fingerprint'] = getOrCreateDeviceFingerprint()
  const credential = readDeviceCredential()
  if (credential && !config.headers['X-Device-Credential']) config.headers['X-Device-Credential'] = credential
  return config
})
api.interceptors.response.use(
  response => { assertResponseIdentity(response.config); return response },
  async error => {
    // Never log Axios config; it may contain passwords or bearer credentials.
    const original = error.config as SessionRequest | undefined
    assertResponseIdentity(original)
    if (error.response?.status === 401 && original?._sessionLease) {
      if (original._retried) {
        await browserSession.clear(original._sessionLease)
      } else {
        const lease = await browserSession.refresh(original._sessionLease)
        if (!browserSession.isCurrent(lease)) throw new SessionError('SESSION_CHANGED')
        original._sessionLease = lease
        original._retried = true
        original.headers.Authorization = `Bearer ${lease.accessToken}`
        return api(original)
      }
    }
    throw error
  },
)

export interface User {
  id: string
  username: string
  email: string
  status: string
  reputation_score: number
  created_at: string
}

export interface Task {
  id: string
  name: string
  description: string
  status: string
  reward: number
  created_at: string
  updated_at: string
}

export interface Wallet {
  user_id: string | number
  balance: number
  total_earned: number
  total_spent: number
  transaction_count?: number
}

export interface EconomyStats {
  total_supply: number
  circulating_supply: number
  today_rewards: number
  platform_earnings: number
}

export interface Transaction {
  id: string | number
  user_id?: string | number
  from_user_id?: string
  to_user_id?: string
  amount: number
  transaction_type?: string
  type?: string
  description: string
  balance?: number
  created_at: string
}

export interface TaskEconomyLedger {
  task_id: number
  charged: number
  remaining_escrow: number
  transaction_count: number
  transactions: Transaction[]
}

export interface BoundDevice {
  binding_id: string
  node_id: string
  device_name: string
  device_type: string
  platform?: string
  os_version?: string
  client_version?: string
  status: string
  last_seen_at: string
  today_earning: number
  total_earning: number
  cpu_cores: number
  memory_gb: number
  gpu_count: number
  load_rate?: number
  cpu_usage?: number
  memory_usage?: number
  gpu_usage?: number
  system_family: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'
  capability_level: 'basic' | 'standard' | 'pro'
}

export interface MyDevicesOverview {
  user_id: string
  total_devices: number
  online_devices: number
  total_earning: number
  today_earning: number
  devices: BoundDevice[]
}

export interface DailyEarningPoint {
  date: string
  amount: number
}

export interface AuthUser {
  id: string
  username: string
  email: string
  role?: string
  status?: string
  node_count?: number
  completed_tasks?: number
  balance?: number
  total_earnings?: number
}

export interface AuthLoginResponse {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_in: number
  role: string
  user: AuthUser
}

export interface UserSession {
  session_id: string
  device_id?: string | null
  device_name: string
  device_type?: 'desktop' | 'mobile' | 'tablet' | 'unknown' | string
  browser?: string
  os?: string
  user_agent: string
  client_ip: string
  created_at?: string
  last_seen_at: string
  revoked_at?: string | null
  status?: 'active' | 'revoked' | 'expired' | string
  is_current: boolean
  trust_eligible?: boolean
  is_trusted?: boolean
  trusted_at?: string | null
  trusted_until?: string | null
  trust_permanent?: boolean
}

export type TrustDeviceDuration = '7d' | '30d' | '90d' | 'permanent'

export interface TotpStatus {
  ok: boolean
  enabled: boolean
  enabled_at: string | null
  reauthentication_required?: boolean
  message?: string
}

export interface TotpSetupResponse {
  ok: boolean
  setup_token: string
  secret: string
  otpauth_uri: string
  expires_in: number
}

export interface TotpChallengeResponse {
  ok: boolean
  two_factor_required: true
  challenge_token: string
  challenge_expires_in: number
  account_id: number
  available_methods: Array<{
    method: string
    display_name: string
    description: string
  }>
  default_method: string
  device_credential?: string
}

export interface SecurityLog {
  id: string
  action: string
  detail: string
  level?: 'low' | 'medium' | 'high'
  created_at: string
}

const loginCredentials = new WeakMap<WebLoginAttempt, string>()
export const auth = {
  beginLogin: browserSession.beginLogin,
  cancelLogin: browserSession.cancelLogin,
  sessionSupported: browserSession.supported,
  sessionError: browserSession.supportError,

  async setSession(
    params: { accessToken: string; refreshToken?: string; user?: AuthUser; rememberMe?: boolean },
    attempt: WebLoginAttempt,
  ) {
    browserSession.assertLogin(attempt)
    if (!params.refreshToken || !params.user) throw new Error('服务器未返回完整会话，请重新登录。')
    const response = await authTransport.get('/auth/me', { headers: { Authorization: `Bearer ${params.accessToken}` } })
    browserSession.assertLogin(attempt)
    const user = verifiedIdentity(response.data)
    if (user.id !== String(params.user.id)) throw new Error('登录身份不一致，请重新登录。')
    const lease = await browserSession.commitLogin(attempt, { accessToken: params.accessToken, refreshToken: params.refreshToken }, user)
    if (!browserSession.isCurrent(lease)) throw new SessionError('SESSION_CHANGED')
    storeDeviceCredential(loginCredentials.get(attempt))
    loginCredentials.delete(attempt)
    return lease
  },

  async requestWithFallback<T>(
    request: (client: typeof api) => Promise<{ data: T }>
  ): Promise<T> {
    // Preserve the existing call sites while keeping credentials on the configured API.
    return (await request(api)).data
  },

  async login(
    username: string,
    password: string,
    rememberMe: boolean,
    attempt: WebLoginAttempt,
  ): Promise<AuthLoginResponse | TotpChallengeResponse> {
    browserSession.assertLogin(attempt)
    const response = await api.post('/auth/login', {
      username, password, remember_me: rememberMe,
    })
    const raw = response.data
    browserSession.assertLogin(attempt)
    if (typeof raw?.device_credential === 'string') loginCredentials.set(attempt, raw.device_credential)
    if (raw?.two_factor_required === true && typeof raw.challenge_token === 'string') return raw as TotpChallengeResponse
    return normalizedLogin(raw)
  },

  async sendPhoneCode(phone: string, purpose: 'login' | 'register'): Promise<{ expires_in: number; resend_after: number }> {
    const response = await api.post('/auth/sms/send', { phone, purpose })
    if (response.data?.ok !== true || response.data?.purpose !== purpose) {
      throw new Error('短信通道未确认发送，请稍后重试。')
    }
    return { expires_in: Number(response.data.expires_in), resend_after: Number(response.data.resend_after) }
  },

  async loginWithPhone(phone: string, code: string, rememberMe: boolean, attempt: WebLoginAttempt): Promise<AuthLoginResponse | TotpChallengeResponse> {
    browserSession.assertLogin(attempt)
    const response = await api.post('/auth/login/phone', { phone, code, remember_me: rememberMe })
    browserSession.assertLogin(attempt)
    if (typeof response.data?.device_credential === 'string') loginCredentials.set(attempt, response.data.device_credential)
    if (response.data?.two_factor_required === true && typeof response.data.challenge_token === 'string') {
      return response.data as TotpChallengeResponse
    }
    return normalizedLogin(response.data)
  },

  async registerWithPhone(phone: string, code: string, rememberMe: boolean, attempt: WebLoginAttempt): Promise<AuthLoginResponse> {
    browserSession.assertLogin(attempt)
    const response = await api.post('/auth/register/phone', { phone, code, remember_me: rememberMe })
    browserSession.assertLogin(attempt)
    if (typeof response.data?.device_credential === 'string') loginCredentials.set(attempt, response.data.device_credential)
    return normalizedLogin(response.data)
  },

  async loginTotp(
    challengeToken: string,
    code: string,
    opts: { trustDevice?: boolean; rememberMe?: boolean | null },
    attempt: WebLoginAttempt,
  ): Promise<AuthLoginResponse> {
    browserSession.assertLogin(attempt)
    const deviceCred = loginCredentials.get(attempt) || readDeviceCredential()
    const raw = await this.requestWithFallback((client) =>
      client.post(
        '/auth/login/totp',
        {
          challenge_token: challengeToken,
          code,
          trust_device: !!opts.trustDevice,
          remember_me: opts.rememberMe ?? null,
        },
        {
          headers: deviceCred ? { 'X-Device-Credential': deviceCred } : {},
          withCredentials: false,
        },
      )
    )
    browserSession.assertLogin(attempt)
    if (typeof (raw as any)?.device_credential === 'string') loginCredentials.set(attempt, (raw as any).device_credential)
    return normalizedLogin(raw)
  },

  /**
   * 注册新账号。
   *  - 第一种用法（推荐）：register(username, password, role)  —— 仅账号 + 密码，邮箱由后端自动占位
   *  - 第二种用法（向后兼容）：register(emailOrUsername, password, username, role) —— 老调用方式继续可用
   */
  async register(
    usernameOrEmail: string,
    password: string,
    usernameOrRole?: string,
    role: string = 'individual'
  ): Promise<AuthLoginResponse> {
    let payload: { username: string; password: string; role: string; email?: string }
    if (usernameOrRole && (usernameOrRole === 'individual' || usernameOrRole === 'enterprise')) {
      // 三参数：(username, password, role)
      payload = {
        username: usernameOrEmail.trim(),
        password,
        role: usernameOrRole,
      }
    } else if (usernameOrRole) {
      // 四参数（旧）：(email, password, username, role)
      payload = {
        username: (usernameOrRole || '').trim(),
        password,
        role,
        email: usernameOrEmail.trim(),
      }
    } else {
      payload = {
        username: usernameOrEmail.trim(),
        password,
        role: 'individual',
      }
    }
    // 账号用途是申请意向。服务端始终以 personal 创建匿名账号；
    // 不把前端 role 当作授予企业权限的依据。
    const { role: requestedRole, ...accountFields } = payload
    const response = await api.post('/auth/register', {
      ...accountFields,
      ...(requestedRole === 'enterprise' ? { company: 'enterprise' } : {}),
    })
    if (response.data?.ok !== true) throw new Error('服务器未确认账号创建成功，请检查后重试。')
    return normalizedLogin(response.data)
  },

  async me(): Promise<{ authenticated: boolean; kind: string; user: AuthUser }> {
    const response = await api.get('/auth/me')
    const user = verifiedIdentity(response.data)
    const lease = (response.config as SessionRequest)._sessionLease
    if (!lease || user.id !== lease.accountId || !browserSession.isCurrent(lease)) throw new SessionError('SESSION_CHANGED')
    return { authenticated: true, kind: 'user', user }
  },

  async updateMe(payload: {
    username?: string
    email?: string
    password?: string
    old_password?: string
  }) {
    return this.requestWithFallback((client) => client.put('/auth/me', payload))
  },

  async listSessions(): Promise<{ sessions: UserSession[] }> {
    return this.requestWithFallback((client) => client.get('/auth/sessions'))
  },

  async revokeSession(sessionId: string) {
    return this.requestWithFallback((client) => client.delete(`/auth/sessions/${sessionId}`))
  },

  async revokeOtherSessions() {
    return this.requestWithFallback((client) => client.delete('/auth/sessions'))
  },

  async trustSession(
    sessionId: string,
    payload: { duration: TrustDeviceDuration; current_password: string; code: string },
  ) {
    return this.requestWithFallback((client) =>
      client.put(`/auth/sessions/${sessionId}/trust`, payload)
    )
  },

  async cancelSessionTrust(sessionId: string) {
    return this.requestWithFallback((client) =>
      client.delete(`/auth/sessions/${sessionId}/trust`)
    )
  },

  async getTotpStatus(): Promise<TotpStatus> {
    return this.requestWithFallback((client) => client.get('/auth/totp/status'))
  },

  async setupTotp(currentPassword: string): Promise<TotpSetupResponse> {
    return this.requestWithFallback((client) =>
      client.post('/auth/totp/setup', { current_password: currentPassword })
    )
  },

  async confirmTotp(setupToken: string, code: string): Promise<TotpStatus> {
    return this.requestWithFallback((client) =>
      client.post('/auth/totp/confirm', { setup_token: setupToken, code })
    )
  },

  async disableTotp(currentPassword: string, code: string): Promise<TotpStatus> {
    return this.requestWithFallback((client) =>
      client.post('/auth/totp/disable', {
        current_password: currentPassword,
        code,
      })
    )
  },

  requiresRelogin(response: any): boolean {
    return !!(response && (response.reauthentication_required || response.relogin_required))
  },

  async clearForRelogin() {
    clearDeviceCredential()
    await browserSession.clear()
  },

  async listSecurityLogs(): Promise<{ logs: SecurityLog[] }> {
    return this.requestWithFallback((client) => client.get('/auth/security-logs'))
  },
  
  async logout() {
    const lease = browserSession.capture()
    if (!lease) return
    clearDeviceCredential()
    await browserSession.clear(lease)
    try {
      await authTransport.post('/auth/logout', {}, { headers: { Authorization: `Bearer ${lease.accessToken}` }, timeout: 5000 })
    } catch { /* Local logout already completed; a late server response cannot restore it. */ }
  },

  isAuthenticated() { return Boolean(browserSession.getToken()) },
  async ensureAccessToken() {
    const unavailable = browserSession.supportError()
    if (unavailable) throw new Error(unavailable)
    const lease = browserSession.capture()
    if (!lease) return null
    const ready = isJwtExpired(lease.accessToken) ? await browserSession.refresh(lease) : lease
    if (!browserSession.isCurrent(ready)) throw new SessionError('SESSION_CHANGED')
    return ready.accessToken
  },
  getToken() { const token = browserSession.getToken(); return isJwtExpired(token) ? null : token },
  getUser: browserSession.getUser,
  onStateChange: browserSession.onStateChange,

}

export const tasks = {
  async getAll(limit: number = 10, offset: number = 0): Promise<Task[]> {
    const response = await api.get(`/tasks?limit=${limit}&skip=${offset}`)
    return response.data
  },

  async getById(taskId: string): Promise<Task> {
    const response = await api.get(`/tasks/${taskId}`)
    return response.data
  },

  async create(taskData: { name: string; description: string; type: string; priority: number }): Promise<Task> {
    const response = await api.post('/tasks', taskData)
    return response.data
  },

  async cancel(taskId: string): Promise<void> {
    await api.delete(`/tasks/${taskId}`)
  }
}

export const economy = {
  async getWallet(userId: string): Promise<Wallet> {
    const response = await api.get(`/economy/balance?account_id=${userId}`)
    return response.data
  },

  async getTransactions(_userId: string, limit: number = 10): Promise<Transaction[]> {
    const response = await api.get(`/economy/ledger?limit=${limit}`)
    return response.data
  },

  async getStats(): Promise<EconomyStats> {
    const response = await api.get('/economy/daily-report')
    return response.data
  },

  async transfer(_fromUserId: number, toUserId: number, amount: number, _description = '') {
    const response = await api.post('/economy/withdraw', {
      to_account_id: toUserId,
      amount: amount,
    })
    return response.data
  },

  async getTaskLedger(taskId: number): Promise<TaskEconomyLedger> {
    const response = await api.get(`/economy/ledger?task_id=${taskId}`)
    return response.data
  },

  async settleTask(taskId: number) {
    const response = await api.post(`/economy/ledger?task_id=${taskId}`, {})
    return response.data
  }
}

export const users = {
  async getAll(limit: number = 10, offset: number = 0): Promise<User[]> {
    const response = await api.get(`/users/?limit=${limit}&skip=${offset}`)
    return response.data
  },
  
  async getById(userId: string): Promise<User> {
    const response = await api.get(`/users/${userId}/`)
    return response.data
  }
}

export const nodes = {
  async getMyDevices(): Promise<MyDevicesOverview> {
    const response = await api.get('/workers')
    const items = Array.isArray(response.data) ? response.data : (response.data?.items || [])
    return {
      user_id: String(browserSession.getUser()?.id || ''),
      total_devices: items.length,
      online_devices: items.filter((w: any) => w.status === 'ONLINE').length,
      today_earning: 0,
      total_earning: 0,
      devices: items.map((w: any) => ({
        id: w.id,
        name: w.name || w.id,
        status: w.status?.toLowerCase() || 'offline',
        ip: '',
        platform: w.capabilities?.os || '',
        cpu: `${w.capabilities?.cpu_cores || 0}核`,
        memory: `${w.capabilities?.memory_gb || 0}G`,
        load: (w.load || 0),
        last_seen: w.last_seen || '',
        tier: w.capabilities?.tier || 'basic',
      })),
    }
  },
  async getMyEarningsTrend(_days: number = 7): Promise<DailyEarningPoint[]> {
    // v8: 暂无 earnings-trend 路由，返回空
    return []
  },
  async getMyDeviceEvents(_since?: string, _limit: number = 20) {
    return { events: [] }
  },
  async getDeviceEarningsTrend(_nodeId: string, _days: number = 7): Promise<DailyEarningPoint[]> {
    // v8: 暂无，返回空
    return []
  },
  async markMyDeviceEventsRead() {
    try {
      const response = await api.post('/nodes/my-devices/events/mark-read')
      return response.data
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return { message: 'ok' }
      }
      throw error
    }
  },
  async forceOfflineNode(nodeId: string | number) {
    const response = await api.post(`/nodes/${nodeId}/force-offline`)
    return response.data
  },
  async deleteNode(nodeId: string | number) {
    const response = await api.delete(`/nodes/${nodeId}`)
    return response.data
  },
  async getSingleDeviceEarningsTrend(nodeId: string, days: number = 7): Promise<DailyEarningPoint[]> {
    const response = await api.get(`/nodes/my-devices/${nodeId}/earnings-trend?days=${days}`)
    return response.data
  },
  async getNodeTask(nodeId: string): Promise<{ id?: string; task_id?: string; status: string } | null> {
    const response = await api.get(`/nodes/${nodeId}/tasks`)
    const data = response.data
    if (!data) return null
    if (Array.isArray(data)) return data[0] || null
    return data
  }
}

// ════════════════════════════════════════════════════════════════════
// 个人节点后台 my-* API · 全部基于 /api/v8/my/*
// 后端: platform_v8/api/v8/my.py
// ════════════════════════════════════════════════════════════════════

export interface MyProfile {
  id: number
  username: string
  email: string
  role: string
  status: string
  balance: number
  level: number
  tier: string
  tier_multiplier: number
  registered_at: string | null
  last_login_at: string | null
  profile: Record<string, any>
}

export interface DashboardKpi {
  nodes_total: number
  nodes_online: number
  nodes_offline: number
  apps_total?: number
  apps_installs?: number
  installed_app_slugs?: string[]
  models_total: number
  models_ready: number
  models_downloading: number
  earnings_today: number
  earnings_total: number
  tasks_today: number
  level: number
  tier: string
  tier_multiplier: number
}

export interface EarningPoint {
  date: string
  amount: number
  tasks: number
}

export interface NodeSummary {
  id: string
  name: string
  status: string
  load_pct: number
  specialty: string[]
  apps_count?: number
  equipped_count: number
  last_seen: string | null
}

export interface SpecialtyCoverage {
  specialty: string
  node_count: number
  coverage_pct: number
}

export interface DashboardSummary {
  ok: boolean
  user: { username: string; balance: number; level: number; tier: string }
  kpi: DashboardKpi
  earnings_trend: EarningPoint[]
  nodes_summary: NodeSummary[]
  specialty_coverage: SpecialtyCoverage[]
  generated_at: string
}

export interface MyNode {
  id: string
  name: string
  status: string
  mode?: string
  accepting_work?: boolean
  hardware: {
    cpu_cores: number
    ram_gb: number
    gpu: string
    os: string
    tier: string
  }
  capabilities: {
    specialty: string[]
    equipped_models: string[]
    model_health: Record<string, string>
    installed_apps?: Array<{ slug: string; name?: string; version?: string } | string>
  }
  models: { ready: number; downloading: number; total: number }
  apps?: { total: number }
  load_pct: number
  active_shards: number
  reputation: number
  capability_score: number
  last_seen: string | null
  registered_at: string | null
}

export interface MyEquipmentApp {
  slug: string
  name: string
  description?: string
  category?: string
  version?: string
  versions?: string[]
  node_count: number
  nodes?: Array<{ id: string; name: string; status: string; version?: string }>
  coming_soon?: boolean
  capability_tags?: string[]
}

/** @deprecated 装备页已改为应用；保留类型避免旧引用报错 */
export interface MyEquipmentModel {
  model_id: string
  name: string
  description: string
  size_mb: number
  industry: string[]
  tags: string[]
  node_count: number
  ready_count: number
  downloading_count: number
  avg_progress: number
}

export interface MyWallet {
  ok: boolean
  wallet: {
    balance: number
    pending: number
    total_earned: number
    total_withdrawn: number
    recent_transactions_30d: number
  }
  level: {
    current: number
    tier: string
    tier_multiplier: number
    next_threshold: {
      threshold: number | null
      level: number
      tier: string
      remaining: number
    }
  }
}

export interface MyTransaction {
  id: string
  type: string
  workload_id: string
  shard_id: string
  amount: number
  currency: string
  note: string
  metadata: Record<string, any>
  created_at: string | null
}

export const myApi = {
  /** 个人完整信息 */
  async getProfile(): Promise<MyProfile> {
    const r = await api.get('/my/profile')
    if (r.data?.ok !== true || !r.data.user?.id) throw new Error('账户资料格式不完整，请重试。')
    return r.data.user
  },

  /** 更新个人资料（显示名称/电话/语言/地区/头像/通知偏好） */
  async updateProfile(payload: {
    display_name?: string
    phone?: string
    language?: string
    country?: string
    avatar_url?: string
    notification_prefs?: {
      notify_offline?: boolean
      daily_report?: boolean
      notify_failed?: boolean
      system_notice?: boolean
    }
  }): Promise<MyProfile> {
    const r = await api.put('/my/profile', payload)
    return r.data.user
  },

  /** Dashboard 一次性聚合数据 */
  async getDashboardSummary(): Promise<DashboardSummary> {
    const r = await api.get('/my/dashboard-summary')
    return r.data
  },

  /** 我的节点列表 */
  async getMyNodes(status?: 'online' | 'offline' | 'busy'): Promise<MyNode[]> {
    const params = status ? { status } : {}
    const r = await api.get('/my/nodes', { params })
    if (r.data?.ok !== true || !Array.isArray(r.data.nodes)) throw new Error('节点数据格式不完整，请重试。')
    return r.data.nodes
  },

  /** 重命名 / 设置是否接单 */
  async updateMyNode(
    nodeId: string,
    payload: { name?: string; accepting_work?: boolean },
  ): Promise<MyNode> {
    const r = await api.patch(`/my/nodes/${nodeId}`, payload)
    return r.data.node
  },

  async pauseMyNode(nodeId: string): Promise<MyNode> {
    const r = await api.post(`/my/nodes/${nodeId}/pause`)
    return r.data.node
  },

  async resumeMyNode(nodeId: string): Promise<MyNode> {
    const r = await api.post(`/my/nodes/${nodeId}/resume`)
    return r.data.node
  },

  /** 删除设备（摘除注册 · 服务端强制客户端注销） */
  async deleteMyNode(nodeId: string): Promise<{
    ok: boolean
    worker_id: string
    name?: string
    force_logout_delivered?: boolean
    disconnected?: boolean
  }> {
    const r = await api.delete(`/my/nodes/${nodeId}`)
    return r.data
  },

  /** 单节点详情 */
  async getMyNodeDetail(nodeId: string): Promise<{
    node: MyNode
    apps?: Array<{ slug: string; name: string; version?: string }>
    models: Array<{
      model_id: string
      name: string
      description: string
      size_mb: number
      status: string
      progress_pct: number
      installed_at: string | null
      error: string
    }>
    earnings_trend: EarningPoint[]
  }> {
    const r = await api.get(`/my/nodes/${nodeId}`)
    return r.data
  },

  /** 我的任务记录 */
  async getMyTasks(opts: { status?: string; page?: number; size?: number } = {}) {
    const r = await api.get('/my/tasks', { params: opts })
    return r.data as {
      ok: boolean
      page: number
      size: number
      total: number
      tasks: Array<{
        id: string
        skill: string
        model: string
        node_id: string
        node_name: string
        status: string
        elapsed_ms: number
        reward: number
        error: string
        started_at: string | null
        completed_at: string | null
        note: string
      }>
      stats: {
        today: number
        this_month: number
        total: number
        total_reward: number
        today_reward: number
        avg_reward: number
        success_rate: number
      }
    }
  },

  /** 装备汇总（跨节点已装应用聚合 · 只读） */
  async getMyEquipment(): Promise<{
    apps: MyEquipmentApp[]
    nodes_with_apps: number
    total_nodes: number
    count: number
  }> {
    const r = await api.get('/my/equipment')
    if (r.data?.ok !== true || !Array.isArray(r.data.apps)) throw new Error('已装应用数据格式不完整，请重试。')
    return {
      apps: r.data.apps || [],
      nodes_with_apps: Number(r.data.nodes_with_apps || 0),
      total_nodes: Number(r.data.total_nodes || 0),
      count: Number(r.data.count || 0),
    }
  },

  /** 钱包 */
  async getMyWallet(): Promise<MyWallet> {
    const r = await api.get('/my/wallet')
    if (r.data?.ok !== true || !r.data.wallet || !r.data.level?.next_threshold) throw new Error('钱包数据格式不完整，请重试。')
    return r.data
  },

  /** 流水分页 */
  async getMyTransactions(opts: { type?: 'all' | 'income' | 'expense'; page?: number; size?: number } = {}) {
    const r = await api.get('/my/wallet/transactions', { params: opts })
    return r.data as { ok: boolean; page: number; size: number; total: number; items: MyTransaction[] }
  },
}

/** 千手生态应用市场 · /api/v8/marketplace/* */
export interface EcoMarketApp {
  id?: number
  slug: string
  name: string
  description?: string
  tagline?: string | null
  category?: string
  version?: string
  icon_url?: string | null
  pricing_model?: string
  price?: number
  install_count?: number
  rating_avg?: number
  requires_gpu?: boolean
  coming_soon?: boolean
  capability_tags?: string[]
  [key: string]: unknown
}

export interface EcoLibraryItem {
  slug: string
  name?: string
  version?: string | null
  installed_at?: string | null
}

function normalizeEcoApp(raw: Record<string, unknown>): EcoMarketApp {
  const meta = (raw.display_meta ?? {}) as Record<string, unknown>
  const coming =
    raw.coming_soon ?? raw.comingSoon ?? meta.coming_soon ?? meta.comingSoon ?? meta.soon
  return {
    ...raw,
    slug: String(raw.slug || ''),
    name: String(raw.name || raw.slug || ''),
    description: raw.description != null ? String(raw.description) : '',
    tagline:
      (typeof meta.tagline === 'string' ? meta.tagline : null) ??
      (typeof raw.tagline === 'string' ? raw.tagline : null),
    category: raw.category != null ? String(raw.category) : 'other',
    version: raw.version != null ? String(raw.version) : '1.0.0',
    install_count: raw.install_count != null ? Number(raw.install_count) : 0,
    requires_gpu: Boolean(raw.requires_gpu ?? raw.gpu_required),
    coming_soon: coming != null ? Boolean(coming) : false,
    capability_tags: Array.isArray(meta.capability_tags)
      ? (meta.capability_tags as string[])
      : Array.isArray(raw.capability_tags)
        ? (raw.capability_tags as string[])
        : [],
  }
}

export const marketplaceApi = {
  async listApps(params: { q?: string; category?: string; sort?: string; page_size?: number } = {}) {
    const r = await api.get('/marketplace/apps', {
      params: {
        q: params.q || undefined,
        category: params.category || undefined,
        sort: params.sort || 'popular',
        page_size: params.page_size || 100,
      },
    })
    const rows = r.data?.items || r.data?.apps || []
    return (Array.isArray(rows) ? rows : []).map((row: Record<string, unknown>) => normalizeEcoApp(row))
  },

  async installApp(slug: string) {
    const r = await api.post(`/marketplace/apps/${encodeURIComponent(slug)}/install`)
    return r.data
  },

  async uninstallApp(slug: string) {
    const r = await api.delete(`/marketplace/apps/${encodeURIComponent(slug)}/install`)
    return r.data
  },

  async myLibrary(): Promise<EcoLibraryItem[]> {
    const r = await api.get('/marketplace/library')
    const items = r.data?.items || []
    return (Array.isArray(items) ? items : [])
      .map((it: { install?: Record<string, unknown>; app?: Record<string, unknown> }) => {
        const app = it.app || {}
        const inst = it.install || {}
        return {
          slug: String(app.slug || ''),
          name: app.name != null ? String(app.name) : undefined,
          version: inst.version != null ? String(inst.version) : null,
          installed_at: inst.installed_at != null ? String(inst.installed_at) : null,
        }
      })
      .filter((x: EcoLibraryItem) => Boolean(x.slug))
  },

  async provisionApp(slug: string, workerId: string) {
    const r = await api.post(`/marketplace/apps/${encodeURIComponent(slug)}/provision`, {
      worker_id: workerId,
    })
    return r.data as {
      ok: boolean
      worker_id: string
      worker_name?: string
      slug?: string
      version?: string
      control_id?: string
      delivered?: boolean
    }
  },

  async deprovisionApp(slug: string, workerId: string) {
    const r = await api.post(`/marketplace/apps/${encodeURIComponent(slug)}/deprovision`, {
      worker_id: workerId,
    })
    return r.data as {
      ok: boolean
      worker_id: string
      worker_name?: string
      slug?: string
      control_id?: string
      delivered?: boolean
    }
  },
}

export default api
