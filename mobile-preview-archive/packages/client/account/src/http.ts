/**
 * 账号 API 的 HTTP 传输层。
 *
 * 三个刻意的决定：
 *
 * 1. **`credentials: 'include'` 是每个请求的固定项，不做条件分支。**
 *    理由：上游对非 Tauri 客户端下发 httpOnly cookie `we_refresh_token`（path `/api/v8/auth`），
 *    那是最安全的长期凭据存放方式——JS 根本看不到它，也就不可能把它写进日志或被 XSS 读走。
 *    其他客户端的做法是「登录后把 refresh token 存进 localStorage」，那等于把长期凭据
 *    交给页面脚本。所以只要这个宿主支持 cookie，本层就走 cookie；`credentials` 已由
 *    `TokenStore` 的 `refreshSource` 决定语义（cookie 模式下刷新请求体里没有令牌）。
 *    已实测：Node 的 `fetch` **接受** `credentials: 'include'`（不抛错），但 Node 没有 cookie
 *    罐，不会真的存取 cookie——PC 侧的 cookie 支持由嵌入宿主决定，本包如实依赖它。
 *
 * 2. **`fetch` 是注入的（`FetchLike`），不是全局直取。**
 *    契约测试必须能打桩，且 PC 宿主可能要用自己的网络栈（代理、证书、重试）。注入是唯一
 *    同时满足这两点的办法。
 *
 * 3. **响应体永远是「先取文本、再自己解析」。**
 *    直接 `response.json()` 在响应不是 JSON 时抛出的错误既没有状态码也没有上下文；
 *    而账号接口最容易踩的坑正是「地址填错，返回了一整页 HTML」。先取文本才能给出
 *    「服务器返回的是 text/html」这种能动手的线索。
 */
import {
  classifyFailure,
  networkFailure,
  unparseableFailure,
  type AccountOperation,
  type UpstreamErrorPayload,
  type AccountFailure,
} from './failures.ts'
import { redactText } from './redaction.ts'

/**
 * 可注入的 `fetch` 形状。
 *
 * 刻意声明成 `(input: string, init?: RequestInit) => Promise<Response>` 而不是 `typeof fetch`：
 * 本层只发字符串 URL，不构造 `Request` 对象；宽松的入参形状让宿主适配器（带代理、
 * 带自定义签名的包装）不必伪造一整套 `fetch` 重载就能接上。
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 一次请求的描述。**只放非敏感值**：口令在 `body` 里，绝不会进诊断记录。 */
export interface TransportRequest {
  readonly url: string
  readonly operation: AccountOperation
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /**
   * 请求体对象（会序列化成 JSON）。GET/DELETE 不带体，传 `null`。
   *
   * 可选字段一律用 `null` 而不是「省略」：调用方（会话层）要把几个分支的请求拼在
   * 一起构造，用省略就得写条件展开，而条件展开既难读、又会让覆盖率工具把两个分支
   * 记成一处。显式 `null` 让「发什么」在调用点一眼可见。
   */
  readonly body?: Readonly<Record<string, unknown>> | null
  /** bearer access token；`null` 表示匿名请求（登录/注册/刷新）。 */
  readonly bearer?: string | null
  /** 必须从任何输出文本里遮盖掉的明文（口令、令牌）。 */
  readonly secrets?: readonly (string | null | undefined)[] | null
  /** 取消信号；没有就是 `null`。 */
  readonly signal?: AbortSignal | null
  /** 额外的请求头（例如后续需要 `x-device-id`）。 */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * 传输结果。
 *
 * 用返回值而不是抛异常：调用方（例如会话层）必须能在 401 上先做一次刷新再重试，
 * 而「拿到失败」与「失败到无法继续」是两件事。异常留给调用方的业务判断，
 * 由 `AccountClient` 在更上层抛出 `AccountFailure`。
 */
export type TransportResult =
  | { readonly ok: true; readonly status: number; readonly payload: unknown }
  | { readonly ok: false; readonly status: number; readonly failure: AccountFailure }

/** 传输层构造参数。 */
export interface TransportConfig {
  readonly fetch: FetchLike
  /** 单次请求的超时（毫秒）。默认 20 秒：账号接口都不慢，卡住通常是网络问题。 */
  readonly timeoutMs?: number
}

/** 默认超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000

/** 请求体里这些字段是敏感值，出错时必须遮盖——上游的校验错误会回显它们。 */
const SENSITIVE_BODY_FIELDS: readonly string[] = ['password', 'old_password', 'current_password', 'code', 'challenge_token', 'setup_token', 'refresh_token']

/** 从请求体里收集需要遮盖的明文。 */
function bodySecrets(body: Readonly<Record<string, unknown>> | null | undefined): string[] {
  if (body === null || body === undefined) return []
  const out: string[] = []
  for (const field of SENSITIVE_BODY_FIELDS) {
    const value = body[field]
    if (typeof value === 'string' && value.length > 0) out.push(value)
  }
  return out
}

/** 解析响应文本；空体与非法 JSON 都返回 `null`（调用方据此走「不可解析」分支）。 */
function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

/** 从任意已解析的响应体里挑出我们**允许**读取的错误字段。 */
function errorPayloadOf(parsed: unknown): UpstreamErrorPayload {
  if (parsed === null || typeof parsed !== 'object') return {}
  const source = parsed as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (source.ok !== undefined) out.ok = source.ok
  if (typeof source.code === 'string') out.code = source.code
  if (typeof source.message === 'string') out.message = source.message
  if (source.errors !== undefined) out.errors = source.errors
  if (typeof source.trace_id === 'string') out.trace_id = source.trace_id
  return out
}

/** 响应是否声明了 JSON 内容类型。 */
function contentTypeOf(response: Response): string | null {
  try {
    return response.headers.get('content-type')
  } catch {
    // 某些宿主屏蔽了响应头读取（跨域无 CORS 暴露头）。这不是失败，只是少了一条线索。
    return null
  }
}

/** `Retry-After` 响应头；读不到返回 `null`。 */
function retryAfterOf(response: Response): string | null {
  try {
    return response.headers.get('retry-after')
  } catch {
    return null
  }
}

/**
 * 发一次请求并把它翻译成传输结果。
 * @param config - 注入的 fetch 与超时。
 * @param request - 请求描述。
 * @returns 成功时给出已解析的响应体，失败时给出分类后的失败对象。
 */
export async function sendRequest(config: TransportConfig, request: TransportRequest): Promise<TransportResult> {
  const secrets = [...bodySecrets(request.body), ...(request.secrets ?? [])]
  const controller = new AbortController()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  /**
   * 超时标记。它决定「取消」怎么翻译给用户：用户按下取消应当是「已取消」，
   * 而超时是「连不上」——两者的处置完全不同（一个什么都不用做，一个要查网络）。
   */
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  /** 外部信号与内部超时合并：任一触发都取消。 */
  const onExternalAbort = (): void => { controller.abort() }
  request.signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    const headers: Record<string, string> = { accept: 'application/json', ...request.headers }
    if (request.body !== undefined && request.body !== null) headers['content-type'] = 'application/json'
    if (request.bearer !== undefined && request.bearer !== null) headers.authorization = `Bearer ${request.bearer}`

    const init: RequestInit = {
      method: request.method,
      headers,
      // 见文件头第 1 条：cookie 是首选的长期凭据通道，所以每个请求都允许携带它。
      credentials: 'include',
      signal: controller.signal,
    }
    if (request.body !== undefined && request.body !== null) init.body = JSON.stringify(request.body)

    let response: Response
    try {
      response = await config.fetch(request.url, init)
    } catch (error) {
      const aborted = request.signal?.aborted === true && !timedOut
      return {
        ok: false,
        status: 0,
        failure: networkFailure({ operation: request.operation, aborted, secrets, cause: error }),
      }
    }

    const text = await readBody(response, request, secrets)
    if (typeof text !== 'string') return text

    const parsed = parseJson(text)
    const payload = errorPayloadOf(parsed)
    /**
     * 失败判定以 **`ok === false` 优先，HTTP 状态码其次**。
     *
     * 为什么不能只看状态码：上游的失败包是 `{ok:false, code, message, trace_id}`，
     * 这是一个「业务包」而不是 RFC 6750 的 OAuth2 错误形状（没有 `WWW-Authenticate`、
     * 没有 `error`/`error_description`）。业务失败完全可能带着 200/2xx 回来——只要它带
     * `ok:false` 就必须当失败处理，否则界面会拿到一个「没有 token 的成功」。
     * `code` 是上游可扩展的开放集合，所以这里只把 `ok` 作为判定依据，不去穷举 `code`。
     */
    if (response.ok && payload.ok !== false) {
      if (parsed !== null) return { ok: true, status: response.status, payload: parsed }
      // 2xx 但响应体不是 JSON：地址填错、被代理改写、或上游换了格式。绝不能当成功。
      return {
        ok: false,
        status: response.status,
        failure: unparseableFailure({
          status: response.status,
          operation: request.operation,
          contentType: contentTypeOf(response),
          secrets,
        }),
      }
    }

    return {
      ok: false,
      status: response.status,
      failure: classifyFailure({
        /**
         * 失败业务包带着 2xx 回来时，状态码本身没有分类价值（`200` 会落到「未知 4xx」兜底）。
         * 用 422 代入：「请求本身合法、但服务端判定不能照办」——这正是 `ok:false` 的含义。
         * 失败对象上的 `status` 会由下面一行改回**真实**状态码，排查信息不丢。
         */
        status: response.status >= 400 ? response.status : 422,
        operation: request.operation,
        payload,
        retryAfter: retryAfterOf(response),
        secrets,
        reportedStatus: response.status,
      }),
    }
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/** 读取响应体；读不出时返回一个分类好的失败结果。 */
async function readBody(
  response: Response,
  request: TransportRequest,
  secrets: readonly (string | null | undefined)[],
): Promise<string | TransportResult> {
  try {
    return await response.text()
  } catch (error) {
    void error
    return {
      ok: false,
      status: response.status,
      failure: unparseableFailure({
        status: response.status,
        operation: request.operation,
        contentType: contentTypeOf(response),
        secrets,
      }),
    }
  }
}

/**
 * 把一段诊断文本里的明文全部遮盖掉。
 *
 * 单独导出是给调用方用的：宿主（PC/手机）自己打的日志如果包含请求体，也必须过这一层；
 * 本包管不了宿主的日志，但至少给出一把能用的工具，且它就在这里、不会被忘记。
 * @param text - 原始文本。
 * @param secrets - 需要遮盖的明文。
 * @returns 遮盖后的文本。
 */
export function redactForLog(text: string, secrets: readonly (string | null | undefined)[]): string {
  return redactText(text, secrets)
}
