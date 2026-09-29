/**
 * 手机端的 LLM 调用层：BYOK（用户自带密钥）直连，不经过我方服务器。
 *
 * 为什么直连而不是经工作台中转：手机端本来就该在电脑关机时也能用；经中转会让手机
 * 变成电脑的附属品。密钥只存在用户自己的浏览器里，请求从浏览器直连服务商。
 *
 * 支持范围：任何 **OpenAI 兼容**的 `/chat/completions` 端点。默认 DeepSeek，
 * 用户也可以填自己的自建网关或其它兼容服务商——这与「绝不内置我方密钥」的约束一致：
 * 这里没有任何我方密钥，也永远不会有。
 *
 * 另一条通路（密钥内置在我方后台的**订阅网关**）在 `subscription.ts`；它不经过这里，
 * 也不接受任何密钥。两条通路在 `App.tsx` 里按「同源 + 已登录」二选一，各自永远可用。
 */
import { SSE_DONE, sseData, takeLines } from './sse.ts'
import { DEFAULT_FRONT_MODEL, FRONT_MODELS, SUBSCRIPTION_BASE_URL, SUBSCRIPTION_PROVIDER_ID } from './subscription-model.ts'

/** 一条对话消息；`system` 由调用方注入，不来自用户输入。 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** 一个可用的模型。`id` 是发给服务商的真实模型名，`name` 是界面显示名。 */
export interface ModelOption {
  readonly id: string
  readonly name: string
  /** 该模型是否支持推理强度选择。 */
  readonly reasoning?: boolean
}

/** 一个服务商配置；密钥由用户在设置页填写，绝不预置。 */
export interface ProviderProfile {
  /** 界面显示名，例如「千手 V4 模型」。 */
  readonly label: string
  /** OpenAI 兼容根地址，末尾不带斜杠。 */
  readonly baseUrl: string
  /** 可选模型清单；留空表示让服务商返回。 */
  readonly models: readonly ModelOption[]
  /** 默认模型 id。 */
  readonly defaultModel: string
  /** 该服务商是否需要密钥；本地自建网关可能不需要。 */
  readonly requiresKey: boolean
}

/**
 * 界面上的模型品牌名。
 *
 * 显示名和请求里的模型 id 是两件事，不要混：`id` 必须照服务商文档原样发出去
 * （`deepseek-chat` 少一个字母就是 404），而 `name` 只是屏幕上给人看的字样。
 * 产品要求界面统一用自家品牌，所以这里只改 `name`，`id` 一个字不动。
 */
export const MODEL_BRAND = '千手 V4 模型'

/** 内置服务商模板；**只含端点与模型名，不含任何密钥**。 */
export const PROVIDER_TEMPLATES: Readonly<Record<string, ProviderProfile>> = {
  /**
   * 订阅通道：密钥在我方后台，用户只买订阅。它**不是**一个 OpenAI 兼容端点，
   * 所以 `baseUrl` 是一个本机标记（`qianshou://subscription`），永远不会被发出去——
   * 走这一档时请求由 `subscription.ts` 发到同源的宿主网关，不带任何用户密钥。
   *
   * `requiresKey: false` 是这条通路能在界面上"零配置可用"的关键：
   * 控制器据此判定"配置完整"，用户不用先填密钥才能说话。
   */
  [SUBSCRIPTION_PROVIDER_ID]: {
    label: '千手订阅通道',
    baseUrl: SUBSCRIPTION_BASE_URL,
    defaultModel: DEFAULT_FRONT_MODEL,
    requiresKey: false,
    // 只放两个前台名字：上游真实模型标识绝不出现在界面上，也不出现在这里。
    models: FRONT_MODELS.map(model => ({ id: model.name, name: model.name, reasoning: false })),
  },
  deepseek: {
    label: MODEL_BRAND,
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresKey: true,
    models: [
      { id: 'deepseek-chat', name: MODEL_BRAND, reasoning: true },
      { id: 'deepseek-reasoner', name: `${MODEL_BRAND} · 深度推理`, reasoning: true },
    ],
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    requiresKey: true,
    models: [],
  },
}

/** 设置页占位提示用的默认模板。取不到就退回空串：占位没了不算故障，不该让界面崩。 */
const DEFAULT_TEMPLATE = PROVIDER_TEMPLATES.deepseek

/**
 * 设置页的端点占位提示。
 *
 * 以前这里直接写死了某家服务商的地址，等于把后端是谁印在界面上；改成从模板取之后，
 * 占位与默认值同源，换模板时不会只剩一半没跟着改。
 */
export const DEFAULT_BASE_URL = DEFAULT_TEMPLATE?.baseUrl ?? ''

/** 设置页的模型占位提示，同样是模板里的默认模型 id。 */
export const DEFAULT_MODEL_ID = DEFAULT_TEMPLATE?.defaultModel ?? ''

/** 用户当前的连接设置；密钥单独存放，不进入这个结构。 */
export interface ConnectionSettings {
  readonly providerId: string
  readonly baseUrl: string
  readonly model: string
}

/** 调用失败的结构化原因；界面据此给出可操作的提示，而不是一句「失败了」。 */
export type ChatFailureKind =
  | 'no-key'
  | 'no-endpoint'
  | 'unauthorized'
  | 'rate-limited'
  | 'insufficient-balance'
  | 'server-error'
  | 'network'
  | 'aborted'
  | 'invalid-response'

/** 一次调用失败。 */
export class ChatFailure extends Error {
  /**
   * @param kind - 结构化原因。
   * @param message - 面向用户的中文说明。
   * @param status - 服务商返回的 HTTP 状态码（若有）。
   */
  constructor(readonly kind: ChatFailureKind, message: string, readonly status?: number) {
    super(message)
    this.name = 'ChatFailure'
  }
}

/** 把 HTTP 状态码翻译成结构化原因；无法识别时归入 server-error。 */
export function classifyStatus(status: number): ChatFailureKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402) return 'insufficient-balance'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server-error'
  return 'invalid-response'
}

/** 每个原因对应的用户可见说明。 */
export const FAILURE_COPY: Readonly<Record<ChatFailureKind, string>> = {
  'no-key': '还没有填密钥。去「我的 → 模型设置」填你自己的 API Key。',
  'no-endpoint': '还没有填服务地址。去「我的 → 模型设置」填一个 OpenAI 兼容的地址。',
  unauthorized: '密钥被服务商拒绝了。检查密钥是否正确、是否过期。',
  'rate-limited': '请求太频繁，被服务商限流了。稍等一会儿再试。',
  'insufficient-balance': '账户余额不足。请到服务商那边充值。',
  'server-error': '服务商暂时不可用。稍后重试。',
  network: '连不上服务商。检查手机网络，或确认地址是否可达。',
  aborted: '已取消。',
  'invalid-response': '服务商返回了无法解析的内容。',
}

/** 流式回调；`delta` 是本次增量文本，`done` 在收流结束时置位。 */
export interface StreamHandlers {
  readonly onDelta: (text: string) => void
  readonly onDone: () => void
  readonly onError: (failure: ChatFailure) => void
}

/** 发起一次流式对话。返回一个可 `abort()` 的句柄。 */
export interface ChatStream {
  readonly abort: () => void
  readonly completed: Promise<void>
}

/** 拼出 `/chat/completions` 的完整地址；已带 `/v1` 的地址不再重复。 */
export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return `${trimmed}/chat/completions`
}

/**
 * 解析一行 SSE 数据。
 *
 * 只认 `data:` 行；`[DONE]` 表示结束。返回 `null` 表示这一行不携带增量。
 * 分帧与 `data:` 前缀的提取走 `sse.ts`——订阅通路用的是同一套分帧、不同的帧格式。
 * @param line - 一行原文（不含换行）。
 * @returns 增量文本、结束标记，或 null。
 */
export function parseSseLine(line: string): { delta?: string; done?: boolean } | null {
  const payload = sseData(line)
  if (payload === null) return null
  if (payload === SSE_DONE) return { done: true }
  const delta = deltaOf(payload)
  return delta === null ? null : { delta }
}

/** 从一段 JSON 里取出这一片的正文；取不到返回 `null`。 */
function deltaOf(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[] }
    const choice = parsed.choices?.[0]
    // `delta` 是流式的形状；`message` 是非流式的形状，个别网关在流里也会用它。
    const content = choice?.delta?.content ?? choice?.message?.content
    return typeof content === 'string' && content.length > 0 ? content : null
  } catch {
    // 服务商偶尔发送心跳或注释行；静默跳过而不是中断整个流。
    return null
  }
}

/**
 * 从「不是 SSE」的响应体里取出正文。
 *
 * 有些自建网关、代理或兼容层会忽略 `stream: true`，直接回一个完整的
 * `{"choices":[{"message":{"content":"…"}}]}`。以前这种响应会被逐行丢掉，
 * 结果是**流正常结束、界面一片空白**——比报错更难查。这里把它认下来。
 * @param raw - 完整响应体原文。
 * @returns 正文与非流式错误说明；都没取到则两者皆空。
 */
export function parseWholeBody(raw: string): { readonly content: string; readonly error: string } {
  const text = raw.trim()
  if (text.length === 0) return { content: '', error: '' }
  try {
    const parsed = JSON.parse(text) as {
      choices?: { message?: { content?: unknown }; delta?: { content?: unknown }; text?: unknown }[]
      error?: { message?: unknown } | string
      message?: unknown
    }
    // 少数网关会把错误塞在 200 的响应体里，这条必须先看：否则会被当成"空回复"。
    const error = parsed.error
    if (typeof error === 'string' && error.length > 0) return { content: '', error }
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
      return { content: '', error: error.message }
    }
    if (typeof parsed.message === 'string' && parsed.choices === undefined) {
      return { content: '', error: parsed.message }
    }
    const choice = parsed.choices?.[0]
    const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text
    return { content: typeof content === 'string' ? content : '', error: '' }
  } catch {
    // 不是 JSON：有些网关直接回纯文本，那就当正文用。
    return { content: text, error: '' }
  }
}

export interface SendOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly messages: readonly ChatMessage[]
  /** 服务商要求的额外请求字段（例如自建网关的路由标记）。 */
  readonly extraBody?: Readonly<Record<string, unknown>>
  /** 取消信号；用户按「停止」时触发。 */
  readonly signal?: AbortSignal
}

/**
 * 执行一次流式对话。
 *
 * 用 `fetch` + 手写 SSE 解析而不是 EventSource：EventSource 只支持 GET，
 * 而对话必须 POST。
 * @param options - 端点、凭据、模型与消息。
 * @param handlers - 增量、结束与错误回调。
 * @returns 可中止的句柄。
 */
export function streamChat(options: SendOptions, handlers: StreamHandlers): ChatStream {
  const controller = new AbortController()
  const signal = options.signal ?? controller.signal

  const completed = (async () => {
    const url = completionsUrl(options.baseUrl)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          stream: true,
          ...(options.extraBody ?? {}),
        }),
        signal,
      })
    } catch (error) {
      handlers.onError(new ChatFailure(
        signal.aborted ? 'aborted' : 'network',
        signal.aborted ? FAILURE_COPY.aborted : FAILURE_COPY.network,
      ))
      void error
      return
    }

    if (!response.ok) {
      const kind = classifyStatus(response.status)
      handlers.onError(new ChatFailure(kind, FAILURE_COPY[kind], response.status))
      return
    }
    if (response.body === null) {
      handlers.onError(new ChatFailure('invalid-response', FAILURE_COPY['invalid-response']))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    /** 有没有真的收到过正文。全程为空时要在收流后如实说明，而不是当作完成。 */
    let sawDelta = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const split = takeLines(buffer)
        buffer = split.rest
        for (const line of split.lines) {
          const parsed = parseSseLine(line)
          if (parsed === null) continue
          if (parsed.done === true) {
            // 收到 `[DONE]` 但一个字都没有：服务商回的是空回复，也要说清楚。
            if (!sawDelta) handlers.onError(emptyReply())
            handlers.onDone()
            return
          }
          if (parsed.delta !== undefined) { sawDelta = true; handlers.onDelta(parsed.delta) }
        }
      }
      // 收流结束时还留在缓冲里的最后一行也要解析：末尾没有换行时它进不了上面的循环。
      const last = parseSseLine(buffer)
      if (last?.delta !== undefined) { sawDelta = true; handlers.onDelta(last.delta) }
      if (last?.done === true) {
        if (!sawDelta) handlers.onError(emptyReply())
        handlers.onDone()
        return
      }
      if (!sawDelta) {
        // 一个字都没收到。最常见的原因是服务商忽略了 `stream: true`，回了一份完整 JSON。
        const whole = parseWholeBody(buffer)
        if (whole.error.length > 0) {
          handlers.onError(new ChatFailure('invalid-response', `服务商说：${whole.error}`, response.status))
          return
        }
        if (whole.content.length > 0) {
          handlers.onDelta(whole.content)
          handlers.onDone()
          return
        }
        handlers.onError(emptyReply(response.headers.get('content-type')))
        return
      }
      // 服务商没发 `[DONE]` 就断了流：仍然算完成，但让调用方知道流已结束。
      handlers.onDone()
    } catch (error) {
      handlers.onError(new ChatFailure(
        signal.aborted ? 'aborted' : 'network',
        signal.aborted ? FAILURE_COPY.aborted : FAILURE_COPY.network,
      ))
      void error
    } finally {
      try { reader.releaseLock() } catch { /* 已经释放 */ }
    }
  })()

  return { abort: () => { controller.abort() }, completed }
}

/**
 * 空回复的失败对象。
 *
 * 以前这种情况只会走 `onDone()`，界面停在"已回复"但一个字都没有——用户看到的是
 * 转圈或空白，既不知道出了什么事，也不知道该改哪里。这里把 status 与 content-type
 * 带出来，让「无法解析」变成能动手的线索。
 * @param contentType - 响应头里的 content-type（可选）。
 * @returns 面向用户的失败对象。
 */
function emptyReply(contentType?: string | null): ChatFailure {
  const hint = contentType !== null && contentType !== undefined && !contentType.includes('event-stream')
    ? `服务商返回的是 ${contentType}，不是流式的 text/event-stream——多半是兼容层忽略了 stream 参数。`
    : '服务商这条消息是空的。检查模型名是否正确、额度是否还有，或换一个模型再试。'
  return new ChatFailure('invalid-response', hint)
}
