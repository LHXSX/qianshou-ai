/**
 * 失败分类：把上游的 HTTP 结果翻译成**可以给用户看的中文原因**。
 *
 * 做法参考 `apps/qianshou-mobile/src/llm.ts` 的 `ChatFailure` + `FAILURE_COPY`（本项目
 * 已认可的写法），但这里**不跨包 import 手机端代码**：手机端是应用、本包是库，库反向依赖
 * 应用会锁死依赖方向。两条约束一起满足的办法是照同样的形状在本包内实现一份。
 *
 * 与手机端 LLM 层的两点差别，都是账号场景特有的：
 * 1. 失败带**操作**（`Operation`）。同样是 401，登录时是「用户名或密码错误」，
 *    而在 `me`/`sessions` 上就是「登录状态已过期」，两者的处置完全不同（重填 vs 重新登录）。
 * 2. 429 要分桶。上游限流按端点独立计数：注册 5 次/分/IP、登录 10 次/分/IP、OTP 10 次/分/IP，
 *    一句笼统的「请求太频繁」会让用户不知道该等哪个操作。
 *
 * 上游真实错误体（2026-09-16 只读实测，未做任何注册/登录）：
 * `{"ok":false,"code":"AUTH_TOKEN_INVALID","message":"用户名或密码错误","trace_id":"…"}`
 * 校验失败则是 `{"ok":false,"code":"VALIDATION_ERROR","message":"请求参数校验失败","errors":[…]}`。
 */
import { redactText, stripEchoes } from './redaction.ts'

/** 结构化失败原因。 */
export type AccountFailureKind =
  | 'account-taken'
  | 'invalid-credentials'
  | 'account-disabled'
  | 'unauthorized'
  | 'rate-limited'
  | 'two-factor-required'
  | 'invalid-request'
  | 'server-error'
  | 'network'
  | 'unparseable'
  | 'aborted'

/** 限流的分桶：同一份「稍后再试」文案下，用户要知道是哪个动作被限了。 */
export type RateLimitScope = 'register' | 'login' | 'two-factor'

/**
 * 触发失败的账号操作。
 *
 * 只列出会进入分类决策的操作：`refresh`（刷新）与 `unknown`（兜底）之外，其余都是上游端点。
 */
export type AccountOperation =
  | 'register'
  | 'login'
  | 'login-totp'
  | 'sms-send'
  | 'login-phone'
  | 'register-phone'
  | 'payment'
  | 'refresh'
  | 'me'
  | 'sessions'
  | 'logout'
  | 'totp'
  | 'security-logs'
  | 'profile'
  | 'unknown'

/**
 * 上游错误体里我们**允许**读取的字段。
 *
 * `errors` 是校验错误数组，只被 `fieldCopies` 用来取字段名（`loc` 的最后一段）；
 * 其中的 `input`/`msg`/`ctx` **一律不读**——上游会把提交的口令回显在 `input` 里，
 * 所以这里读出字段名之后就必须整体丢弃，理由见 `redaction.ts` 的说明。
 *
 * 它曾经被写成一个从类型上「看不见」的字段，靠 `errorPayloadOf` 里的断言搬进来；
 * 那个写法让类型与实现互相矛盾：实现明明取了这个字段，类型却说没有。现在按实现如实的形状声明。
 */
export interface UpstreamErrorPayload {
  readonly ok?: boolean
  readonly code?: string
  readonly message?: string
  readonly detail?: unknown
  /**
   * 校验错误条目；只读 `loc` 的最后一段。
   *
   * 上游客端可以把任何东西放在这里，所以是 `unknown`——取值一律走 `Array.isArray` + 逐字段判型。
   */
  readonly errors?: unknown
  /**
   * 上游追踪 id。
   *
   * 类型是 `unknown` 而不是 `string`：这一层面对的本来就是**未经验证的**响应体，
   * 上游换成毫秒数或整型 id 时，客户端应当表现为「没有追踪 id」而不是把一个数字当成 id 显示。
   * `payloadTraceId` 负责这个判定。
   */
  readonly trace_id?: unknown
}

/** 一次账号操作失败。 */
export class AccountFailure extends Error {
  /**
   * @param kind - 结构化原因。
   * @param message - 面向用户的中文说明；不含任何口令或令牌。
   * @param options - 状态码、操作、限流分桶与服务端追踪 id。
   */
  constructor(
    readonly kind: AccountFailureKind,
    message: string,
    readonly options: {
      readonly status?: number
      readonly operation?: AccountOperation
      readonly rateLimitScope?: RateLimitScope
      readonly traceId?: string
      /** 服务端给出的建议等待秒数（来自 `Retry-After`，若上游提供）。 */
      readonly retryAfterSeconds?: number
    } = {},
  ) {
    super(message)
    this.name = 'AccountFailure'
  }

  /** 上游 HTTP 状态码；网络不可达与响应不可解析时没有状态码。 */
  get status(): number | undefined {
    return this.options.status
  }

  /** 触发失败的操作。 */
  get operation(): AccountOperation | undefined {
    return this.options.operation
  }

  /** 限流分桶，仅 `kind === 'rate-limited'` 时存在。 */
  get rateLimitScope(): RateLimitScope | undefined {
    return this.options.rateLimitScope
  }

  /** 服务端追踪 id：用户报障时，这一个字符串比昵称和手机号有用得多。 */
  get traceId(): string | undefined {
    return this.options.traceId
  }

  /**
   * 服务端建议的等待秒数。
   *
   * 上游是否回 `Retry-After` **本轮未实测**（429 没能复现），所以这个值可能一直是
   * `undefined`；界面必须自己给一个兜底时长，不能依赖它存在。
   */
  get retryAfterSeconds(): number | undefined {
    return this.options.retryAfterSeconds
  }
}

/** 每个原因对应的用户可见说明。 */
export const FAILURE_COPY: Readonly<Record<AccountFailureKind, string>> = {
  'account-taken': '这个用户名或邮箱已经被占用了。换一个，或直接用邮箱登录。',
  'invalid-credentials': '用户名或密码不对。用户名处也可以填邮箱。',
  'account-disabled': '这个账号已被停用。请联系客服核对账号状态，我们不能替你恢复。',
  unauthorized: '登录状态已过期，请重新登录。',
  'rate-limited': '操作太频繁，被服务器限流了。稍等一会儿再试。',
  'two-factor-required': '这个账号开启了二次验证，需要先输入动态码。',
  'invalid-request': '提交的内容不符合服务器要求。检查一下必填项和格式。',
  'server-error': '服务器暂时不可用。稍后重试；如果一直失败，请把追踪 id 一起报给我们。',
  network: '连不上账号服务器。检查网络，或确认接口地址是否可达。',
  unparseable: '服务器返回了无法解析的内容。可能是接口地址填错了，或中间有代理改写了响应。',
  aborted: '已取消。',
}

/** 限流分桶对应的补充说明；与 `FAILURE_COPY['rate-limited']` 拼接使用。 */
export const RATE_LIMIT_COPY: Readonly<Record<RateLimitScope, string>> = {
  register: '注册每分钟最多 5 次，等一分钟再注册。',
  login: '登录每分钟最多 10 次，等一分钟再登录；连续失败时先确认口令，别一直试。',
  'two-factor': '动态码每分钟最多 10 次。等下一组动态码，或检查手机时间是否准确。',
}

/**
 * 上游校验错误里的字段名 → 人话。
 *
 * 用户看不懂 `loc: ["body","password"]`，但「密码至少 6 位」是他能马上照做的。
 * 实测上游的密码最小长度就是 6（`string_too_short`, `ctx.min_length: 6`）。
 */
export const FIELD_COPY: Readonly<Record<string, string>> = {
  password: '密码：至少 6 位。',
  old_password: '原密码：请填写当前正在用的密码。',
  username: '用户名：填写服务器要求的格式。',
  email: '邮箱：填一个真实可收信的邮箱地址。',
  company: '公司：按服务器要求的格式填写。',
  challenge_token: '二次验证的挑战已失效，请重新登录。',
  code: '动态码：6 位数字。',
  duration: '信任时长：按服务器要求的单位填写。',
  setup_token: '二次验证的初始化已失效，请重新开始绑定。',
}

/** 把 429 的端点归属翻成限流分桶。 */
export function rateLimitScopeOf(operation: AccountOperation): RateLimitScope {
  if (operation === 'register' || operation === 'register-phone') return 'register'
  if (operation === 'login-totp') return 'two-factor'
  // `me`/`sessions` 一类受保护读也被限流时，用户看到的动作仍然是「登录态下的操作」，
  // 归到 login 桶比新造一个分桶更贴近真实原因（同一账号同一 IP 的登录流量）。
  return 'login'
}

/** 读取 `Retry-After`：支持秒数与 HTTP 日期两种写法，取不到返回 `undefined`。 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (/^\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10)
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  const seconds = Math.ceil((at - now) / 1000)
  return seconds > 0 ? seconds : 0
}

/** 上游错误码里出现这些字样时，说明账号名已被占用。 */
const TAKEN_CODES: readonly string[] = ['USER_EXISTS', 'USERNAME_TAKEN', 'EMAIL_TAKEN', 'ACCOUNT_EXISTS']

/** 上游 message 里出现这些字样时，同样按「已占用」处理。 */
const TAKEN_WORDS: readonly string[] = ['已存在', '已被占用', '已被注册', '已被使用', 'already exists', 'taken']

/** 上游 message 里出现这些字样时，说明账号被停用或封禁。 */
const DISABLED_WORDS: readonly string[] = ['禁用', '停用', '封禁', 'disabled', 'suspended', 'banned']

/** 上游 message 里出现这些字样时，说明提交的是口令/身份问题，而不是会话过期。 */
const CREDENTIAL_WORDS: readonly string[] = ['用户名或密码', '密码错误', '口令', 'credentials', 'password is incorrect']

/** 分类输入。 */
export interface ClassifyInput {
  /** HTTP 状态码；**响应体判定为失败但状态码是 2xx 时传 `200`**，`ok:false` 优先于状态码。 */
  readonly status: number
  readonly operation: AccountOperation
  /** 已解析的上游错误体；响应不是 JSON 时为 `null`。 */
  readonly payload: UpstreamErrorPayload | null
  /** `Retry-After` 响应头原文。 */
  readonly retryAfter?: string | null
  /** 必须遮盖的明文（口令、令牌），用于最后一道清洗。 */
  readonly secrets?: readonly (string | null | undefined)[]
  /** 注入的当前时间，便于对 `Retry-After` 的日期形式做确定性测试。 */
  readonly now?: number
  /**
   * 失败对象上要记录的真实 HTTP 状态码。
   *
   * 什么时候会与 `status` 不同：失败业务包带着 2xx 回来时，分类需要一个「业务失败」的
   * 代入码，但汇报给用户与日志的应当是真实收到的那一个（否则排查时看到的状态码是假的）。
   */
  readonly reportedStatus?: number
}

/** 上游错误体里可读的 `code`。 */
function codeOf(payload: UpstreamErrorPayload | null): string {
  return typeof payload?.code === 'string' ? payload.code.toUpperCase() : ''
}

/**
 * 我们**依赖其语义**的上游错误码白名单。
 *
 * 判定一律以 `ok === false` + `code` 为准，而不是只看 HTTP 状态码；但 `code` 是上游可以
 * 随时新增的开放集合，所以这里只白名单化少数**本包会据此改变行为**的取值，
 * 其余取值一律落到状态码与文案兜底——上游加一个新码，客户端最多是文案不够贴切，
 * 绝不会崩、也不会把它当成成功。
 */
export const KNOWN_ERROR_CODES: readonly string[] = [
  'VALIDATION_ERROR',
  'AUTH_TOKEN_INVALID',
  'AUTH_REQUIRED',
  'TWO_FACTOR_REQUIRED',
  'RATE_LIMITED',
]

/** 上游错误体里可读的 `message`，已去掉回显的字段值。 */
function messageOf(payload: UpstreamErrorPayload | null): string {
  return typeof payload?.message === 'string' ? stripEchoes(payload.message) : ''
}

/** 从校验错误里取出的字段名（不含任何提交内容）。 */
function fieldCopies(payload: UpstreamErrorPayload | null): string {
  const errors = payload?.errors
  if (!Array.isArray(errors)) return ''
  const lines: string[] = []
  for (const entry of errors) {
    if (entry === null || typeof entry !== 'object') continue
    const loc = (entry as { loc?: unknown }).loc
    // 先归一成 `unknown[]`：`Array.isArray` 收窄出的是 `any[]`，
    // 直接取元素会把上游内容以 any 带进下面的逻辑，类型检查就形同虚设。
    const path: unknown[] = Array.isArray(loc) ? loc : []
    const field = path[path.length - 1]
    if (typeof field !== 'string') continue
    const copy = FIELD_COPY[field]
    if (copy !== undefined && !lines.includes(copy)) lines.push(copy)
  }
  return lines.join(' ')
}

/** 组装失败对象：文案先拼中文提示，再统一遮盖一遍明文。 */
function failure(
  kind: AccountFailureKind,
  message: string,
  input: ClassifyInput,
  extra: { readonly rateLimitScope?: RateLimitScope } = {},
): AccountFailure {
  const options: {
    status?: number
    operation?: AccountOperation
    rateLimitScope?: RateLimitScope
    traceId?: string
    retryAfterSeconds?: number
  } = { status: input.reportedStatus ?? input.status, operation: input.operation }
  if (extra.rateLimitScope !== undefined) options.rateLimitScope = extra.rateLimitScope
  const traceId = payloadTraceId(input.payload)
  if (traceId !== undefined) options.traceId = traceId
  if (input.status === 429) {
    const retryAfter = parseRetryAfter(input.retryAfter ?? null, input.now ?? Date.now())
    if (retryAfter !== undefined) options.retryAfterSeconds = retryAfter
  }
  const redacted = redactText(message, input.secrets ?? [])
  return new AccountFailure(kind, redacted, options)
}

/** 读取上游 `trace_id`；非字符串或空串视为没有。 */
function payloadTraceId(payload: UpstreamErrorPayload | null): string | undefined {
  const trace = payload?.trace_id
  return typeof trace === 'string' && trace.length > 0 ? trace : undefined
}

/**
 * 把一个失败的上游响应分类。
 *
 * 判定顺序是刻意的：**先认上游自己给的语义（`code`/`message`）**，再落到本包的分支，
 * 最后才是状态码兜底。理由有两条：
 * - 上游的 `message` 本来就是中文用户文案（实测登录失败是「用户名或密码错误」），
 *   它比我们猜的文案更贴近真实原因；上游改了措辞，客户端自动跟上，不需要发版。
 * - 但**不能只信它**：文案可能变、可能缺失、也可能被中间层改写。所以每一种情况本包
 *   都留了 `FAILURE_COPY` 兜底，且「该不该清会话、该不该要求重新登录」这类**行为判断**
 *   由本包的状态码 + 操作决定，不交给上游文案。
 * @param input - 状态码、操作、错误体与遮盖用明文。
 * @returns 分类后的失败对象。
 */
export function classifyFailure(input: ClassifyInput): AccountFailure {
  const code = codeOf(input.payload)
  const message = messageOf(input.payload)
  const fromMessage = (words: readonly string[]): boolean =>
    words.some(word => message.toLowerCase().includes(word.toLowerCase()))
  /**
   * 上游 message 作为首选文案；没有就退回本包文案。
   *
   * `VALIDATION_ERROR` 例外：它的 message 是「请求参数校验失败」这种笼统句子，
   * 而真正有用的是字段提示，所以那条分支自己拼文案。
   */
  const upstreamCopy = (fallback: string): string => (message.length > 0 ? message : fallback)

  if (code === 'VALIDATION_ERROR') {
    const details = fieldCopies(input.payload)
    return failure(
      'invalid-request',
      details.length > 0 ? `提交的内容不符合服务器要求：${details}` : FAILURE_COPY['invalid-request'],
      input,
    )
  }
  if (input.operation === 'login-phone' && input.status === 404) {
    return failure('invalid-request', '这个手机号还没有注册，请先注册。', input)
  }
  if (input.operation === 'register-phone' && input.status === 409) {
    return failure('account-taken', '这个手机号已经注册，直接用验证码登录。', input)
  }
  if (input.operation === 'sms-send' && input.status === 503) {
    return failure('server-error', '短信通道暂不可用，请稍后重试或使用账号密码登录。', input)
  }
  if ((input.operation === 'login-phone' || input.operation === 'register-phone') && input.status === 401) {
    return failure('invalid-credentials', '验证码错误或已过期，请重新获取。', input)
  }
  if (code === 'TWO_FACTOR_REQUIRED') {
    return failure('two-factor-required', upstreamCopy(FAILURE_COPY['two-factor-required']), input)
  }
  if (code === 'RATE_LIMITED' || input.status === 429) {
    const scope = rateLimitScopeOf(input.operation)
    return failure('rate-limited', `${FAILURE_COPY['rate-limited']}${RATE_LIMIT_COPY[scope]}`, input, { rateLimitScope: scope })
  }
  if (TAKEN_CODES.includes(code) || fromMessage(TAKEN_WORDS)) {
    return failure('account-taken', upstreamCopy(FAILURE_COPY['account-taken']), input)
  }
  if (fromMessage(DISABLED_WORDS)) {
    return failure('account-disabled', upstreamCopy(FAILURE_COPY['account-disabled']), input)
  }
  if (input.status === 401) {
    // 登录/补验这两个端点上的 401 只可能是「凭据不成立」，不是「会话过期」。
    const credentialOperation = input.operation === 'login' || input.operation === 'login-totp' || input.operation === 'login-phone'
    if (credentialOperation || fromMessage(CREDENTIAL_WORDS)) {
      return failure('invalid-credentials', upstreamCopy(FAILURE_COPY['invalid-credentials']), input)
    }
    if (input.operation === 'refresh') {
      // 刷新失败 = 长期凭据也没了。单独说清楚，界面才知道要清干净并回到登录页。
      return failure('unauthorized', upstreamCopy('登录状态已过期，需要重新登录。'), input)
    }
    return failure('unauthorized', upstreamCopy(FAILURE_COPY.unauthorized), input)
  }
  if (input.status === 403) {
    // 403 在上游也可能是「权限不足」，但账号体系里最常见的是账号状态问题；
    // 文案因此把「账号被停用」放在前面，同时保留「或权限不足」这层含义。
    // 这里不再套 `upstreamCopy`：能走到这一行说明上面每一处「按文案判定」都没命中，
    // 也就是说上游 message 不含任何可识别的字样，拿它当文案只会给用户一句看不懂的话。
    return failure('account-disabled', FAILURE_COPY['account-disabled'], input)
  }
  if (input.status === 409) {
    return failure('account-taken', FAILURE_COPY['account-taken'], input)
  }
  if (input.status === 400 || input.status === 422) {
    const details = fieldCopies(input.payload)
    return failure(
      'invalid-request',
      details.length > 0 ? `提交的内容不符合服务器要求：${details}` : upstreamCopy(FAILURE_COPY['invalid-request']),
      input,
    )
  }
  if (input.status >= 500) {
    return failure('server-error', upstreamCopy(FAILURE_COPY['server-error']), input)
  }
  // 剩下的 4xx（含 404：接口地址写错）都归入「请求不对」，附状态码，便于排查。
  return failure('invalid-request', `${FAILURE_COPY['invalid-request']}（HTTP ${input.status}）`, input)
}

/** 网络不可达（`fetch` 直接抛错）的分类。 */
export function networkFailure(input: {
  readonly operation: AccountOperation
  readonly aborted: boolean
  readonly secrets?: readonly (string | null | undefined)[]
  readonly cause?: unknown
}): AccountFailure {
  const kind: AccountFailureKind = input.aborted ? 'aborted' : 'network'
  const redacted = redactText(FAILURE_COPY[kind], input.secrets ?? [])
  void input.cause
  return new AccountFailure(kind, redacted, { operation: input.operation })
}

/** 响应体不是可解析 JSON 时的分类。 */
export function unparseableFailure(input: {
  readonly status: number
  readonly operation: AccountOperation
  readonly contentType?: string | null
  readonly secrets?: readonly (string | null | undefined)[]
}): AccountFailure {
  const hint = input.contentType !== null && input.contentType !== undefined
    && !input.contentType.includes('application/json')
    ? `（服务器返回的是 ${input.contentType}）`
    : ''
  const message = `${FAILURE_COPY.unparseable}${hint}`
  return new AccountFailure('unparseable', redactText(message, input.secrets ?? []), {
    status: input.status,
    operation: input.operation,
  })
}

/** 判断一个未知对象是不是本包的失败对象——调用方据此决定「要不要给用户看 message」。 */
export function isAccountFailure(value: unknown): value is AccountFailure {
  return value instanceof AccountFailure
}
