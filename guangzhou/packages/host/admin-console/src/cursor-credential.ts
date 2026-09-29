/**
 * Cursor 凭据：**形态识别 → 剥包装 → 验活 → 归一化 → 身份提取**。
 *
 * 这是"往号池里贴一枚凭据"这件事的全部上游协议知识。运营粘进来的东西有三种写法，
 * 而它们的可信度不一样，所以处理方式也不一样。
 *
 * ## 为什么必须先「剥包装」再发上游（实测结论，不是风格偏好）
 *
 * 从浏览器里复制出来的 Cursor 凭据常常是 `userId::eyJ…` 形状（`::` 有时会写成
 * 百分号编码的 `%3A%3A`）。实测矩阵：
 *
 * | 发给上游的东西 | 结果 |
 * | --- | --- |
 * | 整串（含 `%3A%3A`） | 401 |
 * | 解码后的 `userId::jwt` | 401 |
 * | **只发 JWT** | **200** |
 * | 只发 `userId` | 401 |
 *
 * 所以归一化的第一步根本不是格式化，而是**把包装剥掉**。少了这一步，一枚完全有效的
 * 凭据会被上游回 401，而现象看起来像"凭据坏了"。
 *
 * ## 关于那三次 401：同一 bug 骗出来的三次失败不是三个证据
 *
 * 上表里三行 401 来自**同一个** bug（把包装一起发了出去），只是输入的编码不同。
 * 它们不是三次独立确认 —— 同一个动作的三种写法不是三个证据。**证据的数量不构成
 * 证据的强度**：真正下结论的是那个 200。这条教训写进了 `API.md` §8.8，因为它会
 * 反复发生：任何"多试几种写法"的验证都可能收到一串同源的失败，而把它们当成
 * "三次都失败"会让排查停在完全错误的方向（去怀疑凭据本身）。
 *
 * ## 为什么裸 JWT 要走一次网络、而不是本地判个形状就算数
 *
 * "看起来像 JWT" 证明不了任何事：签名可能已过期、账号可能被停用。所以 `session`
 * 形态必须真打一次 `GetMe`，拿到 `authId` 才算验活通过 —— `authId` 还是号池 ref 的
 * 唯一来源（见 `poolRefForAuthId`）。
 *
 * ## `crsr_…` API key 验活必须**两步**（实测，别想抄近路）
 *
 * 第二组实测矩阵（广州服务器，用号池里那把真 key）：
 *
 * | 做法 | 结果 |
 * | --- | --- |
 * | `crsr_…` 直接打 `GetMe`（只带 `Authorization`） | 401 |
 * | `crsr_…` 直接打 `GetMe` + CLI 头 | 401 |
 * | `crsr_…` 直接打 `GetMe` + ide 的 `x-cursor-checksum` | 401 |
 * | **换票 → 用票打 `GetMe`** | **200** |
 *
 * API key **不是身份凭据**：它在身份接口上恒被拒，必须先去
 * `/auth/exchange_user_api_key` 换一张票。票 `type = api_key_token`、**有效期 3600 秒**，
 * 所以它只用于这一次验活；落盘存的仍然是用户给的那把长期 `crsr_…`。
 *
 * 这组失败与上面那组**不是同一回事**：那组是"同一个 bug 的三种写法"，这组是"三条不同的
 * 路都指向同一个结论"（key 不是身份凭据）。判断失败的归属要看**原因是不是同一个**，
 * 而不是数它们出现了几次 —— 同源失败不构成多条证据，独立失败才构成。
 *
 * ## 归一化：会话凭据换成不过期的长期 key
 *
 * 会话 JWT 会过期，把它写进号池等于埋一个"过几天全线 401"的雷。所以会话形态多了
 * 一步 `CreateUserApiKey`：换成 69 字符的 `crsr_…` 长期 key 再落盘。它同时是
 * **YAML 裸标量安全值**（没有空白、引号、`#`、冒号），这一点很要紧 —— 凭据文件的
 * 网关兜底读取路径用自写正则取值且不剥引号。
 *
 * 两条路径落盘的都是"长期有效的那一个"：会话 → 新铸的 `crsr_…`；API key → 用户给的那把
 * （票只有 1 小时，**绝不落盘**）。
 *
 * ## 模块边界
 *
 * - 导出面刻意很小：**形态识别/ref 命名（纯逻辑）+ 验活 + 归一化**，剩下的是上游契约常量。
 *   `cursorCall`、`classifyCursorFailure` 这些内部件不导出 —— 它们只服务于本模块的编排。
 * - 本模块**不 import 任何管理台模块的运行时**：`ProbeFailureKind` 是 `import type`，
 *   编译后完全消失（ESM 下没有环）。反向的运行时依赖只有一条：
 *   `connectivity.ts → cursor-credential.ts`（它按 kind 把探测派发到这里）。
 * - 只用 node 内置能力（`fetch` 是 Node 22 的内置能力）：部署形态是
 *   `node src/main.ts serve`（Node 的类型剥离模式），引包会让那台机器上起不来。
 *   因此这里也**没有 `enum`、没有构造器参数属性**（不可擦除语法会直接拒绝启动）。
 */
import { createHash } from 'node:crypto'
import type { ProbeFailureKind } from './connectivity.ts'

/** Cursor 上游基址（实测）。 */
export const CURSOR_API_BASE = 'https://api2.cursor.sh'

/** 验活：拿当前凭据读登录身份。 */
export const CURSOR_GET_ME_PATH = '/aiserver.v1.DashboardService/GetMe'

/**
 * 用 API key 换一张票。
 *
 * **这是 API key 通往 `GetMe` 的唯一路径**（实测，见 `verifyCursorCredential` 的说明）。
 */
export const CURSOR_EXCHANGE_API_KEY_PATH = '/auth/exchange_user_api_key'

/** 归一化：把会话凭据换成长不过期的 API key。 */
export const CURSOR_CREATE_API_KEY_PATH = '/aiserver.v1.DashboardService/CreateUserApiKey'

/** 客户端标识（上游认这两个头；**不需要** `x-cursor-checksum`，见 `cursorHeaders`）。 */
export const CURSOR_CLIENT_TYPE = 'cli'
/**
 * 客户端版本号。
 *
 * 写死成实测通过的那一个：它是**上游契约的一部分**（换版本号等于换契约），
 * 而不是"我们自己的版本"。所以它不进部署配置 —— 改了要重跑实测。
 */
export const CURSOR_CLIENT_VERSION = 'cli-2026.08.11-e8db854'

/** 归一化出来的 key 具有的前缀与长度（69 字符）。 */
export const CURSOR_API_KEY_PREFIX = 'crsr_'
export const CURSOR_API_KEY_LENGTH = 69

/** 换出来的长期 key 的名字与权限范围（最小权限：只读用户身份）。 */
export const CURSOR_POOL_KEY_NAME = 'qianshou-pool'
export const CURSOR_POOL_KEY_SCOPES: readonly string[] = ['user:read']

/** 号池 ref 前缀：`CURSOR_CK_<sha256(authId) 前 8 位>`。 */
export const CURSOR_POOL_REF_PREFIX = 'CURSOR_CK_'

/** ref 里那 8 位十六进制的长度（与 `upstream-keys.ts` 的指纹长度一致）。 */
const REF_DIGEST_LENGTH = 8

/** 探测超时（毫秒）：上游慢的时候不能把管理台接口一起拖住。 */
export const CURSOR_PROBE_TIMEOUT_MS = 15_000

/** 只被 `session` / `web` 两种 JWT 认作 Cursor 的会话凭据。 */
const CURSOR_SESSION_TYPES: readonly string[] = ['session', 'web']

/** 输入的三种写法。`unknown` 表示"本管理台不认识的形状"，不猜、不试。 */
export type CursorCredentialShape = 'api-key' | 'session' | 'session-wrapped' | 'unknown'

/** 一次形态识别的结果。 */
export interface CursorCredentialReading {
  readonly shape: CursorCredentialShape
  /**
   * 该发给上游的那一份。
   *
   * 对 `session-wrapped` 来说这里是**剥掉包装之后的裸 JWT** —— 这是本模块存在的
   * 第一个理由。无法识别时为空串。
   */
  readonly bearer: string
  /** 输入是不是被 `userId::` 包着（含 `%3A%3A` 写法）。 */
  readonly wrapped: boolean
  /** 会话凭据的 `type`（`session` / `web`）；其余形态为 `null`。 */
  readonly sessionType: string | null
  /** 无法识别时给管理员看的原因（可识别时为 `null`）。 */
  readonly problem: string | null
}

/** 上游 `GetMe` 回的身份。 */
export interface CursorIdentity {
  /** Cursor 的账号标识（`auth0|user_…`）。**号池 ref 由它派生**。 */
  readonly authId: string
  readonly userId: number | null
  readonly email: string | null
  readonly firstName: string | null
  readonly lastName: string | null
}

/** 网络依赖（测试注入；真实部署下全部走默认）。 */
export interface CursorDeps {
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly now?: () => number
  /** 重试前的等待（测试里注入成 0，别让用例真的睡过去）。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 一次上游调用的结论。
 *
 * 分层刻意如此：`cursorCall` 只管"发出了、回来了什么"，**分类留给调用方**
 * （`classifyCursorResponse`）。这样"401 是凭据问题、5xx 不是"这条判断只有一处。
 */
export type CursorCallOutcome<T> =
  | {
    readonly ok: true
    readonly status: number
    readonly latencyMs: number
    /** 解析出来的值；`null` 表示 2xx 但正文不是期望的形状。 */
    readonly value: T | null
    readonly bodyText: string
  }
  | { readonly ok: false; readonly status: number; readonly bodyText: string; readonly latencyMs: number }
  | { readonly ok: false; readonly transport: 'timeout' | 'network'; readonly message: string }

/** 带分类的调用结论（`cursorGetMe` / `cursorCreateApiKey` 的返回）。 */
export type CursorAttempt<T> =
  | { readonly ok: true; readonly latencyMs: number; readonly status: number; readonly value: T }
  | { readonly ok: false; readonly kind: ProbeFailureKind; readonly message: string; readonly status: number | null }

/**
 * 从上游错误正文里取一句可读的原因。
 *
 * 刻意**不复用** `connectivity.ts` 里的同名逻辑：那份按 OpenAI 兼容形状
 * （`{ error: { message } }`）取值，而 Cursor 的正文形状不一样；更要紧的是
 * `cursor-credential` 不能 import `connectivity` 的运行时（那会形成环——
 * 探测派发方向正好相反）。两处各管自己的上游方言，边界清楚。
 *
 * 无论取到什么，**只来自上游响应**，绝不回显我们发出去的东西。
 * @param text - 响应正文。
 * @returns 一句截断后的原因；取不到返回 `null`。
 */
function cursorReasonFromBody(text: string): string | null {
  if (text.trim().length === 0) return null
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as Record<string, unknown>
      const error = row['error']
      if (typeof error === 'string' && error.length > 0) return error.slice(0, 300)
      if (error !== null && typeof error === 'object') {
        const message = (error as Record<string, unknown>)['message']
        if (typeof message === 'string' && message.length > 0) return message.slice(0, 300)
      }
      const message = row['message']
      if (typeof message === 'string' && message.length > 0) return message.slice(0, 300)
    }
  } catch {
    // 不是 JSON：退化成截断的纯文本。
  }
  return text.trim().slice(0, 300)
}

/**
 * 判定一次**失败**的上游响应属于四类里的哪一类（2xx 不会走到这里）。
 *
 * **分类不同，给管理员的建议就不同**（与 `API.md` §8.7 同一张表）：
 * 401/403 是凭据的确定性结论；429 与 5xx 是"无法确认"，说成"凭据无效"会让管理员
 * 去换一枚本来没问题的凭据。
 * @param status - HTTP 状态码（非 2xx）。
 * @param bodyText - 响应正文。
 * @returns 分类与可直接展示的中文原因。
 */
function classifyCursorFailure(
  status: number,
  bodyText: string,
): { readonly kind: ProbeFailureKind; readonly message: string } {
  const reason = cursorReasonFromBody(bodyText)
  const tail = reason === null ? '' : `：${reason}`
  if (status === 401 || status === 403) {
    return { kind: 'credential_rejected', message: `上游拒绝了这枚凭据（HTTP ${status}）${tail}` }
  }
  if (status === 429) {
    return { kind: 'rate_limited', message: `上游限流（HTTP 429）${tail}。这**不能证明**凭据无效，请稍后重试。` }
  }
  if (status === 400 || status === 404) {
    return {
      kind: 'upstream_unavailable',
      message: `上游不接受这次探测请求（HTTP ${status}）${tail}。上游契约可能已经变了，请修好再试。`,
    }
  }
  return {
    kind: 'upstream_unavailable',
    message: `上游返回 HTTP ${status}${tail}。这是上游的问题，**不能证明凭据无效**。`,
  }
}

/** 把一次原始调用结论转成带分类的结论。 */
function attemptOf<T>(outcome: CursorCallOutcome<T>, shapeProblem: string): CursorAttempt<T> {
  if (outcome.ok) {
    if (outcome.value === null) {
      return { ok: false, kind: 'upstream_unavailable', message: shapeProblem, status: outcome.status }
    }
    return { ok: true, latencyMs: outcome.latencyMs, status: outcome.status, value: outcome.value }
  }
  if ('transport' in outcome) {
    return {
      ok: false,
      kind: outcome.transport === 'timeout' ? 'upstream_unavailable' : 'network_error',
      message: outcome.message,
      status: null,
    }
  }
  return { ok: false, ...classifyCursorFailure(outcome.status, outcome.bodyText), status: outcome.status }
}

/**
 * 发一次 Cursor 的上游调用。
 *
 * 重试策略刻意不对称（与 `connectivity.ts` 的探测同一套道理）：
 * **只重试"无法确认"的那两类** —— 5xx 与网络层失败，各重试一次。401/403 是确定性
 * 结论，重试只是让管理员多等；400/404 是契约问题，重试没用。
 * @param options - 路径、凭据、请求体、正文解析器与依赖。
 * @returns 原始结论（分类交给调用方）。
 */
async function cursorCall<T>(options: {
  readonly path: string
  readonly bearer: string
  readonly body: Record<string, unknown>
  readonly parse: (raw: unknown) => T | null
  readonly deps: CursorDeps
}): Promise<CursorCallOutcome<T>> {
  const doFetch = options.deps.fetch ?? fetch
  const baseUrl = options.deps.baseUrl ?? CURSOR_API_BASE
  const timeoutMs = options.deps.timeoutMs ?? CURSOR_PROBE_TIMEOUT_MS
  const now = options.deps.now ?? (() => Date.now())
  const sleep = options.deps.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
  const url = `${baseUrl}${options.path}`

  /** 打一次。除了 5xx 与网络层失败，其余结果都是终局。 */
  const attempt = async (): Promise<CursorCallOutcome<T>> => {
    const started = now()
    let response: Response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: cursorHeaders(options.bearer),
        body: JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const timedOut = name === 'TimeoutError' || name === 'AbortError'
      return {
        ok: false,
        transport: timedOut ? 'timeout' : 'network',
        message: timedOut
          ? `连接 Cursor 上游超时（${timeoutMs} 毫秒）—— 这是链路问题，**不能证明凭据无效**。`
          : `连不上 Cursor 上游：${error instanceof Error ? error.message : String(error)}。这是链路问题，**不能证明凭据无效**。`,
      }
    }

    // 读正文时也要能兜住：有些失败是"连上了但不回正文"。
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch {
      bodyText = ''
    }
    const latencyMs = Math.max(0, now() - started)

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, bodyText, latencyMs }
    }
    let parsed: unknown = null
    try {
      parsed = bodyText.trim().length === 0 ? null : JSON.parse(bodyText) as unknown
    } catch {
      parsed = null
    }
    return {
      ok: true,
      status: response.status,
      latencyMs,
      value: parsed === null ? null : options.parse(parsed),
      bodyText,
    }
  }

  const first = await attempt()
  if (first.ok) return first
  const retryable = 'transport' in first || first.status >= 500
  if (!retryable) return first
  await sleep(500)
  return await attempt()
}

/**
 * 请求头。
 *
 * 硬事实：`x-cursor-checksum` **是无关的**（实测带真 checksum / 假 checksum /
 * 完全不带，三种都 200）。所以这里刻意不加 —— 一个不影响结果的头只会多一个
 * 将来会失效的变量。
 * @param bearer - 已经剥过包装的那一份凭据。
 * @returns 请求头。
 */
function cursorHeaders(bearer: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${bearer}`,
    'x-cursor-client-type': CURSOR_CLIENT_TYPE,
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
  }
}

/** 解出 JWT 的 payload；不是三段式 JWT 或解不出来返回 `null`。 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const header = parts[0] as string
  const payload = parts[1] as string
  const signature = parts[2] as string
  if (header.length === 0 || signature.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** 认作 Cursor 会话凭据的形状校验。 */
function sessionProblem(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return '这看起来不是一枚 JWT（不是 `头.载荷.签名` 三段式，或载荷解不出来）。'
  const type = payload['type']
  if (typeof type !== 'string' || !CURSOR_SESSION_TYPES.includes(type)) {
    return `这是一枚 JWT，但它的 type 是 ${typeof type === 'string' ? `「${type}」` : '缺失'}；Cursor 的会话凭据只有 `
      + `${CURSOR_SESSION_TYPES.map(item => `「${item}」`).join(' 与 ')} 两种。本管理台不猜别的类型。`
  }
  return null
}

/**
 * 识别输入形态，并**算出该发给上游的那一份**。
 *
 * 纯函数：不碰网络、不碰磁盘。三种写法都要支持，第四种（认不出来）明确拒绝 ——
 * "先试一个再说"会让排查变成猜谜。
 * @param input - 运营粘贴的原文。
 * @returns 识别结果（含剥包装后的凭据）。
 */
export function identifyCursorCredential(input: string): CursorCredentialReading {
  // 粘贴常常带上首尾空白/换行；它属于剪贴板噪声，不是凭据的一部分。
  const text = input.trim()
  const unknown = (problem: string): CursorCredentialReading =>
    ({ shape: 'unknown', bearer: '', wrapped: false, sessionType: null, problem })
  if (text.length === 0) return unknown('没有粘进任何内容。')

  if (text.startsWith(CURSOR_API_KEY_PREFIX)) {
    // 已经是归一化之后的长期 key：它本身就是发给上游的那一份。
    return { shape: 'api-key', bearer: text, wrapped: false, sessionType: null, problem: null }
  }

  // `userId::jwt` 的冒号可能被百分号编码（`%3A%3A`）。两种写法都剥掉包装 ——
  // 整串发出去实测就是 401（见文件头那张表）。
  const decoded = text.replaceAll(/%3a%3a/gi, '::')
  const separator = decoded.indexOf('::')
  if (separator !== -1) {
    const bearer = decoded.slice(separator + 2).trim()
    const payload = decodeJwtPayload(bearer)
    const problem = sessionProblem(payload)
    if (problem !== null) return unknown(problem)
    return { shape: 'session-wrapped', bearer, wrapped: true, sessionType: payload?.['type'] as string, problem: null }
  }

  const payload = decodeJwtPayload(decoded)
  const problem = sessionProblem(payload)
  if (problem !== null) return unknown(problem)
  return { shape: 'session', bearer: decoded, wrapped: false, sessionType: payload?.['type'] as string, problem: null }
}

/**
 * 号池 ref：`CURSOR_CK_<sha256(authId) 前 8 位>`。
 *
 * 为什么由 `authId` 派生而不是由邮箱/序号：它**稳定**（同一个 Cursor 账号永远同一个
 * ref，于是天然去重）、**不含 PII**（邮箱不进 ref 名，而 ref 会出现在凭据文件、
 * 审计与接口响应里）、且只含 `[A-Za-z0-9_.\-/]`（满足凭据体系对键名的严格度）。
 * @param authId - Cursor 账号标识。
 * @returns ref 名。
 */
export function poolRefForAuthId(authId: string): string {
  return `${CURSOR_POOL_REF_PREFIX}${createHash('sha256').update(authId).digest('hex').slice(0, REF_DIGEST_LENGTH)}`
}

/**
 * 是不是号池 ref。
 *
 * 这条判据在**破坏性操作**上很要紧：移除号池成员时会真的删掉凭据文件里的一行，
 * 所以必须能区分"号池的号"和"网关自己的密钥"（`DEEPSEEK_API_KEY`）。
 * @param ref - 引用名。
 * @returns 是号池 ref 返回 `true`。
 */
export function isCursorPoolRef(ref: string): boolean {
  return new RegExp(`^${CURSOR_POOL_REF_PREFIX}[0-9a-f]{${REF_DIGEST_LENGTH}}$`).test(ref)
}

/** 从 `GetMe` 的响应体里取身份。**没有 `authId` 就是不合格**。 */
function parseCursorIdentity(raw: unknown): CursorIdentity | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const authId = row['authId']
  if (typeof authId !== 'string' || authId.length === 0) return null
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  return {
    authId,
    userId: typeof row['userId'] === 'number' ? row['userId'] : null,
    email: text(row['email']),
    firstName: text(row['firstName']),
    lastName: text(row['lastName']),
  }
}

/**
 * 从 `CreateUserApiKey` 的响应体里取新 key。
 * @param raw - 响应体。
 * @returns key；形状不对返回 `null`。
 */
function parseCursorApiKey(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const apiKey = (raw as Record<string, unknown>)['apiKey']
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null
  return apiKey
}

/** 一次换票的结果（票只在内存里用一次，绝不落盘）。 */
interface CursorTicket {
  readonly accessToken: string
  readonly refreshToken: string | null
}

/**
 * 从换票接口的响应体里取票。
 * @param raw - 响应体。
 * @returns 票；没有 `accessToken` 就算形状不对。
 */
function parseCursorTicket(raw: unknown): CursorTicket | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const accessToken = row['accessToken']
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null
  const refreshToken = row['refreshToken']
  return { accessToken, refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null }
}

/**
 * 验活：用一枚已经剥好包装的凭据读上游身份。
 *
 * `GetMe` 同时是**验活**与**身份提取**：2xx 且带回 `authId` 才算通过。
 * 200 但缺 `authId` 按"无法确认"处理 —— 号池的主键就是它，猜一个等于埋重复号。
 *
 * ⚠️ **它只接受会话凭据（JWT）或换来的票**，不接受 `crsr_…` API key：
 * 见 `verifyCursorCredential` 里那条实测结论。所以调用方要么在 API key 形态下先换票，
 * 要么走 `verifyCursorCredential`（推荐）—— 后者把两步串好了。
 * @param bearer - 剥过包装的会话凭据，或换来的票。
 * @param deps - 网络依赖。
 * @returns 身份或分类后的失败。
 */
async function cursorGetMe(bearer: string, deps: CursorDeps = {}): Promise<CursorAttempt<CursorIdentity>> {
  const outcome = await cursorCall<CursorIdentity>({
    path: CURSOR_GET_ME_PATH,
    bearer,
    body: {},
    parse: parseCursorIdentity,
    deps,
  })
  return attemptOf(
    outcome,
    '上游返回了成功状态，但正文里没有 authId —— 无法确认这是哪个 Cursor 账号，按"无法确认"处理（号池的主键就是它）。',
  )
}

/**
 * 换票：用 API key 换一张 1 小时的票（票只在内存里用一次，绝不落盘）。
 *
 * 失败分类照 §8.7 的四类表：**这一步非 200 才是"密钥被拒"**（确定性失败）。
 * @param apiKey - 用户给的 `crsr_…`。
 * @param deps - 网络依赖。
 * @returns 票，或分类后的失败。
 */
async function cursorExchangeApiKey(apiKey: string, deps: CursorDeps = {}): Promise<CursorAttempt<CursorTicket>> {
  const outcome = await cursorCall<CursorTicket>({
    path: CURSOR_EXCHANGE_API_KEY_PATH,
    bearer: apiKey,
    body: {},
    parse: parseCursorTicket,
    deps,
  })
  return attemptOf(
    outcome,
    '上游返回了成功状态，但正文里没有 accessToken —— 换票没拿到可用的票。',
  )
}

/**
 * 一次验活的实际结果（供预览与审计展示诚实区间）。
 *
 * 两步路径（API key 形态）下 `latencyMs` 是两段之和、`status` 是取身份那一步的状态码；
 * "打的是哪几个接口"由 `cursorProbeEndpoint` 按形态给出，不在这里重复表述。
 */
export interface CursorProbeFacts {
  readonly latencyMs: number
  readonly status: number
}

/** 验活（含形态识别与身份提取）的结论。 */
export type CursorVerification =
  | {
    readonly ok: true
    /** 形态识别结果（`shape` 必不为 `unknown`）。 */
    readonly reading: CursorCredentialReading
    readonly identity: CursorIdentity
    readonly probe: CursorProbeFacts
  }
  | { readonly ok: false; readonly code: 'unrecognized'; readonly message: string }
  | { readonly ok: false; readonly code: 'probe_failed'; readonly kind: ProbeFailureKind; readonly message: string; readonly status: number | null }

/**
 * 探测目标在界面上叫什么（`endpoint` 字段的取值）。
 *
 * 两步路径必须**说出来**：只写 `GetMe` 会让人以为"API key 直接打身份接口"，
 * 而那正是实测里必然 401 的做法。
 * @param shape - 凭据形态。
 * @returns 可直接展示的端点说法。
 */
export function cursorProbeEndpoint(shape: CursorCredentialShape): string {
  return shape === 'api-key' ? 'exchange_user_api_key → GetMe' : 'GetMe'
}

/**
 * **验活 + 身份提取**：识别形态、剥掉包装、真打上游读身份。
 *
 * ## `crsr_…` API key 必须走两步（实测，不是推测）
 *
 * 在广州服务器上用号池里那把真 key 实测：
 *
 * | 做法 | 结果 |
 * | --- | --- |
 * | `crsr_…` 直接打 `GetMe`（只带 `Authorization`） | **401** |
 * | `crsr_…` 直接打 `GetMe` + CLI 头（`x-cursor-client-type/version`） | **401** |
 * | `crsr_…` 直接打 `GetMe` + ide 的 `x-cursor-checksum` | **401** |
 * | **`POST /auth/exchange_user_api_key` 换票 → 用票打 `GetMe`** | **200**（换票 200 / 取身份 200，带回 `authId`、`email`） |
 *
 * 结论是**确定性**的：API key 不是身份凭据，**必须先换一张票**。换来的票 `type` 是
 * `api_key_token`、有效期只有 3600 秒，所以它**只用于这次验活**；号池落盘存的仍然是用户
 * 给的那把长期 `crsr_…`（见 `normalizeCursorCredential`）。
 *
 * ## 失败分类（两步的归属不一样）
 *
 * - **换票非 200** → 照四类表：那是"这枚 API key 被上游拒了"（确定性失败）；
 * - **换票 200、`GetMe` 非 200** → **上游异常**，不是 key 的问题（换票成功已经证明 key 被
 *   接受了）。报成"key 无效"会让运营去换一把本来没问题的 key。
 *
 * 刻意**不顺手做归一化**。归一化要动 Cursor 账号里的东西（铸一把新 key），而本函数被
 * 预览端点调用 —— 预览绝不能产生持久副作用（`confirm.ts` 的明文约定）。多铸的那些 key
 * 还会让"预览里看到的指纹"与"真正落盘的指纹"变成两把不同的值，那正是两步确认要防的
 * "预览看到 A、执行的是 B"。所以预览只验活，归一化交给 `apply`（见 `normalizeCursorCredential`）。
 * @param input - 粘贴的原文。
 * @param deps - 网络依赖。
 * @returns 身份，或分类后的失败。
 */
export async function verifyCursorCredential(input: string, deps: CursorDeps = {}): Promise<CursorVerification> {
  const reading = identifyCursorCredential(input)
  if (reading.shape === 'unknown') {
    return { ok: false, code: 'unrecognized', message: reading.problem ?? '认不出这枚凭据的形状。' }
  }

  if (reading.shape === 'api-key') {
    // 第一步：换票。票只活在这次调用里。
    const ticket = await cursorExchangeApiKey(reading.bearer, deps)
    if (!ticket.ok) return { ok: false, code: 'probe_failed', kind: ticket.kind, message: ticket.message, status: ticket.status }
    // 第二步：用票取身份。
    const alive = await cursorGetMe(ticket.value.accessToken, deps)
    if (!alive.ok) {
      return {
        ok: false,
        code: 'probe_failed',
        // 限流仍然报限流（它本来就是"无法确认"那一类）；其余一律归到上游异常 ——
        // 换票已经成功，所以任何"key 被拒"的说法在这个位置都是错的。
        kind: alive.kind === 'rate_limited' ? 'rate_limited' : 'upstream_unavailable',
        message: `换票成功（这枚 API key 已被上游接受），但随后的取身份调用失败：${alive.message}`
          + '这一步的结论是**上游异常**，不是这枚 key 的问题。',
        status: alive.status,
      }
    }
    return {
      ok: true,
      reading,
      identity: alive.value,
      probe: { latencyMs: ticket.latencyMs + alive.latencyMs, status: alive.status },
    }
  }

  const alive = await cursorGetMe(reading.bearer, deps)
  if (!alive.ok) return { ok: false, code: 'probe_failed', kind: alive.kind, message: alive.message, status: alive.status }
  return { ok: true, reading, identity: alive.value, probe: { latencyMs: alive.latencyMs, status: alive.status } }
}

/**
 * 归一化：把会话凭据换成不过期的长期 key。
 * @param bearer - 剥过包装的会话凭据。
 * @param deps - 网络依赖。
 * @returns 新的 `crsr_…` key，或分类后的失败。
 */
async function cursorCreateApiKey(bearer: string, deps: CursorDeps = {}): Promise<CursorAttempt<string>> {
  const outcome = await cursorCall<string>({
    path: CURSOR_CREATE_API_KEY_PATH,
    bearer,
    body: { name: CURSOR_POOL_KEY_NAME, scopes: CURSOR_POOL_KEY_SCOPES },
    parse: parseCursorApiKey,
    deps,
  })
  return attemptOf(
    outcome,
    '上游返回了成功状态，但正文里没有 apiKey —— 归一化没有拿到可落盘的值。',
  )
}


/** 归一化的结论：落盘值与"它是不是这次新铸的"。 */
export interface CursorNormalization {
  /** 将要落盘的 `crsr_…` 长期 key（**只在内存里**，不进日志、不进审计）。 */
  readonly value: string
  /** `true` = 这次新铸了一把；`false` = 输入本来就是 API key，原样落盘。 */
  readonly created: boolean
}

/**
 * **归一化**：把凭据换成不过期的、YAML 裸标量安全的长期 key。
 *
 * - `crsr_…` 输入：原样返回（它已经是长期 key，重新铸一把只会平白多一个没人用的凭据）；
 * - 会话输入：`CreateUserApiKey` 换一把新的 —— JWT 会过期，把它写进号池等于埋一个
 *   "过几天全线 401"的雷。
 *
 * 只在 `apply` 里调用：铸 key 是对 Cursor 账号的**持久副作用**。
 * @param reading - 形态识别结果（形状必须已经识别出来）。
 * @param deps - 网络依赖。
 * @returns 落盘值，或分类后的失败。
 */
export async function normalizeCursorCredential(
  reading: CursorCredentialReading,
  deps: CursorDeps = {},
): Promise<CursorAttempt<CursorNormalization>> {
  if (reading.shape === 'api-key') return { ok: true, latencyMs: 0, status: 200, value: { value: reading.bearer, created: false } }
  const created = await cursorCreateApiKey(reading.bearer, deps)
  if (!created.ok) return created
  return { ok: true, latencyMs: created.latencyMs, status: created.status, value: { value: created.value, created: true } }
}
