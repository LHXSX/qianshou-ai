/**
 * 错误分类 —— 严格按 API.md §1.2 的 HTTP + `code` 语义分流。
 *
 * 关键点（契约点名要求）：
 * - `401`（`unauthenticated`）才是「未登录/会话过期」，跳登录页；
 * - `502 upstream_unavailable` 是**上游账号服务不可达**，
 *   **绝不能**被渲染成「请重新登录」；
 * - `403 forbidden` 要带上缺失的权限键 `need`；
 * - `403 ip_not_allowed` 是被白名单拒绝（连 SPA 资源都拿不到）；
 * - `503 dependency_unavailable` 要带 `module` + `missing[]` 详情。
 */

import type { MissingDependency } from './types'

/** 失败信封里可能出现的机器可读 code（API.md §1.2）。 */
export type AdminErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'not_an_admin'
  | 'admin_disabled'
  | 'forbidden'
  | 'ip_not_allowed'
  | 'confirm_required'
  | 'confirm_invalid'
  | 'confirm_expired'
  | 'confirm_mismatch'
  | 'version_conflict'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'dependency_unavailable'
  | 'transport_unavailable'
  | 'unexpected_response'
  | (string & {})

/**
 * 从失败信封里尽量提取出的附加字段。
 * 其中 `missing` 复用契约里 `missing[]` 的形状，与就绪度条目共用同一份定义。
 */
export interface AdminErrorDetails {
  /** `403 forbidden` 额外带：缺失的权限键。 */
  need?: string
  /** `503 dependency_unavailable` 额外带：模块 key 与模块标题。 */
  module?: string
  moduleTitle?: string
  missing?: readonly MissingDependency[]
}

export interface AdminErrorInit {
  readonly status: number
  readonly code: AdminErrorCode
  readonly message: string
  readonly details?: AdminErrorDetails
}

/** 统一的接口错误类型：视图层据此渲染中文说明，不做二次猜测。 */
export class AdminApiError extends Error {
  readonly status: number
  readonly code: AdminErrorCode
  readonly details: AdminErrorDetails

  constructor(init: AdminErrorInit) {
    super(init.message)
    this.name = 'AdminApiError'
    this.status = init.status
    this.code = init.code
    this.details = init.details ?? {}
  }

  /** `401 unauthenticated` —— 唯一应当跳登录页的情况。 */
  get isUnauthenticated(): boolean {
    return (this.status === 401 && this.code !== 'workbench_service_unauthorized') || this.code === 'unauthenticated'
  }

  /** 缺权限：可展示需要哪个权限键。 */
  get isForbidden(): boolean {
    return this.status === 403 && this.code === 'forbidden'
  }

  /** 来源 IP 不在白名单（含前端资源请求被拒的情形）。 */
  get isIpNotAllowed(): boolean {
    return this.code === 'ip_not_allowed'
  }

  /** 账号密码对，但没被授予管理台角色。 */
  get isNotAnAdmin(): boolean {
    return this.code === 'not_an_admin'
  }

  /** 管理员记录被停用。 */
  get isAdminDisabled(): boolean {
    return this.code === 'admin_disabled'
  }

  /** 上游账号服务不可达 —— 不是登录问题，不要提示重新登录。 */
  get isUpstreamUnavailable(): boolean {
    return this.status === 502 || this.code === 'upstream_unavailable'
  }

  /** 该业务的属主服务尚未提供接口；`details.module` / `details.missing` 可渲染占位页。 */
  get isDependencyUnavailable(): boolean {
    return this.status === 503 || this.code === 'dependency_unavailable'
  }

  /** 两步确认令牌问题，需要重新预览。 */
  get isConfirmTokenProblem(): boolean {
    return this.code === 'confirm_required' || this.code === 'confirm_invalid' || this.code === 'confirm_expired'
  }

  /** 预览之后目标被别人改过，必须重新预览。 */
  get isVersionConflict(): boolean {
    return this.code === 'version_conflict'
  }
}

const STATUS_FALLBACK_MESSAGE: Readonly<Record<number, string>> = {
  400: '请求参数不被服务端接受。',
  401: '会话已失效，请重新登录。',
  403: '当前管理员没有执行该操作的权限。',
  409: '操作与当前状态冲突，请重新预览后再确认。',
  429: '请求过于频繁，请稍后再试。',
  500: '服务端内部错误。',
  502: '上游账号服务不可达（这不是登录问题）。',
  503: '该业务依赖的属主服务尚未提供接口。',
}

const CODE_FALLBACK_MESSAGE: Readonly<Record<string, string>> = {
  unauthenticated: '未登录或会话已过期，请重新登录。',
  invalid_credentials: '账号或密码不正确。',
  not_an_admin: '账号密码正确，但该账号没有被授予管理台角色。',
  admin_disabled: '该管理员记录已被停用。',
  forbidden: '缺少执行该操作所需的权限。',
  ip_not_allowed: '当前来源 IP 不在白名单内，请求已被拒绝。',
  confirm_required: '该操作需要二次确认令牌，请先预览差异。',
  confirm_invalid: '二次确认令牌无效，请重新预览。',
  confirm_expired: '二次确认令牌已过期（60 秒），请重新预览。',
  confirm_mismatch: '二次确认令牌与本次操作或载荷不匹配。',
  version_conflict: '目标在你预览之后已被他人修改，请重新预览。',
  rate_limited: '登录失败次数过多，已被限流，请稍后再试。',
  upstream_unavailable: '上游账号服务不可达或超时，请稍后重试（这不是登录问题）。',
  dependency_unavailable: '该业务的属主服务尚未提供接口。',
  transport_unavailable: '无法连接到管理台服务（网络中断或服务未启动）。',
  unexpected_response: '服务端返回了不符合契约的响应。',
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 503 响应体里读出 `missing[]`（形状见 API.md §3）。 */
export function readMissingDependencies(payload: unknown): MissingDependency[] {
  if (!isRecord(payload)) return []
  const raw = payload.missing
  if (!Array.isArray(raw)) return []
  const output: MissingDependency[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name = typeof item.interface === 'string' ? item.interface : ''
    if (name === '') continue
    output.push({ interface: name, why: typeof item.why === 'string' ? item.why : '' })
  }
  return output
}

/** 从任意失败响应体里提取 code / message / 附加字段。 */
export function toAdminApiError(status: number, payload: unknown): AdminApiError {
  const record = isRecord(payload) ? payload : {}
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : `http_${status}`
  const message =
    typeof record.message === 'string' && record.message !== ''
      ? record.message
      : CODE_FALLBACK_MESSAGE[code] ?? STATUS_FALLBACK_MESSAGE[status] ?? `请求失败（HTTP ${status}）。`

  const details: AdminErrorDetails = {}
  if (typeof record.need === 'string' && record.need !== '') details.need = record.need
  if (typeof record.module === 'string' && record.module !== '') details.module = record.module
  if (typeof record.moduleTitle === 'string' && record.moduleTitle !== '') details.moduleTitle = record.moduleTitle
  const missing = readMissingDependencies(payload)
  if (missing.length > 0 || status === 503) details.missing = missing

  return new AdminApiError({ status, code, message, details })
}

/** 网络层失败（fetch reject）也归一到同一个错误类型，便于视图统一渲染。 */
export function toTransportError(cause: unknown): AdminApiError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new AdminApiError({
    status: 0,
    code: 'transport_unavailable',
    message: `${CODE_FALLBACK_MESSAGE.transport_unavailable ?? '无法连接到管理台服务。'}（${reason}）`,
  })
}

/** 给视图层用的中文标题（与 message 分开，避免把「重试提示」写死进 message）。 */
export function errorTitle(error: AdminApiError): string {
  if (error.code.startsWith('workbench_')) return error.code === 'workbench_outcome_unknown' || error.code === 'workbench_audit_failed' ? '操作结果需要核查' : '工作台操作未就绪'
  if (error.isIpNotAllowed) return '来源 IP 不在白名单'
  if (error.isUnauthenticated) return '会话已失效'
  if (error.isNotAnAdmin) return '该账号不是管理台管理员'
  if (error.isAdminDisabled) return '管理员已被停用'
  if (error.isForbidden) return '权限不足'
  if (error.isUpstreamUnavailable) return '上游账号服务不可达'
  if (error.isDependencyUnavailable) return '依赖服务未就绪'
  if (error.isVersionConflict) return '数据已被他人修改'
  if (error.isConfirmTokenProblem) return '二次确认令牌失效'
  if (error.code === 'rate_limited') return '请求被限流'
  if (error.code === 'bad_request') return '请求参数不合法'
  if (error.code === 'transport_unavailable') return '无法连接服务'
  return '请求失败'
}

/**
 * 附加说明：把契约里容易混淆的语义显式化。
 * 特别是 502 —— 必须说明「不是重新登录能解决的问题」。
 */
export function errorHint(error: AdminApiError): string {
  if (error.code.startsWith('workbench_')) return '请保留原操作号核查。服务凭据与管理台账号登录独立；此页面不会自动重试修改，也不会建议另建相同操作。'
  if (error.isIpNotAllowed) {
    return '服务端在进入任何接口之前就拒绝了该来源。请用服务器本机回环（127.0.0.1）或 SSH 本机 CLI 把自己加回白名单（见「白名单」页逃生路径）。'
  }
  if (error.isUpstreamUnavailable) {
    // 措辞刻意避开「重新登录」：502 不是登录态失效，提示重新登录会把值班引向错误方向。
    return '管理台本身是可达的，是它背后的账号服务没有响应。这不是登录态失效，无需再次输入账号密码；请稍后重试或联系账号服务值班。'
  }
  if (error.isForbidden && error.details.need !== undefined) {
    return `需要权限键：${error.details.need}，请联系超级管理员在「权限管理」里授予。`
  }
  if (error.isDependencyUnavailable) {
    return '页面只如实展示服务端给出的缺口，不填充任何演示数据。'
  }
  if (error.isVersionConflict) {
    return '请点「重新预览」再确认一次。'
  }
  if (error.code === 'rate_limited') {
    return '登录失败过多会触发限流（429 rate_limited），等待窗口结束后再试。'
  }
  if (hasOwn(CODE_FALLBACK_MESSAGE, error.code) && error.message === CODE_FALLBACK_MESSAGE[error.code]) return ''
  return ''
}
