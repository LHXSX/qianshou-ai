/**
 * `@deepseek-ai/dsh-client-account` —— 千手算力调度账号的共用客户端。
 *
 * 一句话：**PC 与手机登录的是同一个账号**（余额、节点归属、会话都是同一份）。
 * 本包只负责「说清楚怎么跟上游账号接口对话」，不负责界面、不负责落盘位置、
 * 不负责判断用户在哪个平台——那三件事分别属于 M2/M3 和各自的嵌入宿主。
 *
 * 只读实测过的上游事实（2026-09-16，`https://qianshousuanli.com/api/v8`）：
 * - `GET /health` → 200 `{ok:true, service:"edge-backend", version:"8.1.0"}`；
 * - 无凭据的鉴权端点 → 401 业务包 `{ok:false, code:"AUTH_TOKEN_INVALID", message, trace_id}`；
 * - 校验失败 → 422 `{ok:false, code:"VALIDATION_ERROR", errors:[…], trace_id}`，
 *   其中 `errors[].input` 会**回显提交的请求体（含口令）**，所以本包整体丢弃该数组，
 *   并对所有输出文本再遮盖一次。
 *
 * 从未做过的事：**没有向真实账号发起过注册或登录**。契约测试全部打桩。
 */
export {
  ACCOUNT_API_ORIGIN,
  ACCOUNT_API_PREFIX,
  ENDPOINTS,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  accountUrl,
  sessionPath,
  sessionTrustPath,
} from './endpoints.ts'

export {
  AccountFailure,
  FAILURE_COPY,
  FIELD_COPY,
  KNOWN_ERROR_CODES,
  RATE_LIMIT_COPY,
  classifyFailure,
  isAccountFailure,
  networkFailure,
  parseRetryAfter,
  rateLimitScopeOf,
  unparseableFailure,
} from './failures.ts'
export type {
  AccountFailureKind,
  AccountOperation,
  ClassifyInput,
  RateLimitScope,
  UpstreamErrorPayload,
} from './failures.ts'

export { DEFAULT_TIMEOUT_MS, redactForLog, sendRequest } from './http.ts'
export type { FetchLike, TransportConfig, TransportRequest, TransportResult } from './http.ts'

export {
  ACCESS_EXPIRY_SKEW_MS,
  createTokenStore,
} from './tokens.ts'
export type { RefreshTokenSource, RefreshTokenStore, TokenState, TokenStore, TokenStoreConfig } from './tokens.ts'

export { createSession, tokensOf } from './session.ts'
export type {
  AccountSession,
  AccountSessionState,
  ProtectedRequest,
  SessionConfig,
} from './session.ts'

export {
  asBoolean,
  asList,
  asNumber,
  asString,
  asTwoFactorChallenge,
  normalizeAccount,
  normalizeSecurityLogs,
  normalizeSessions,
  normalizeTotpStatus,
} from './normalize.ts'

export { createAccountClient } from './auth.ts'
export type { AccountClient, AccountClientConfig } from './auth.ts'

export { REDACTED, redactText, stripEchoes } from './redaction.ts'

export type {
  Account,
  AccountSession as AccountSessionInfo,
  ChangePasswordRequest,
  LoginRequest,
  LoginResult,
  LoginTotpRequest,
  SmsPurpose,
  SmsSendRequest,
  SmsSendResult,
  PhoneLoginRequest,
  PhoneRegisterRequest,
  ProfileUpdate,
  RegisterRequest,
  SecurityLogEntry,
  TokenCarrier,
  TokenPair,
  TotpStatus,
  TrustDeviceRequest,
  TrustDuration,
  TwoFactorChallenge,
} from './types.ts'
