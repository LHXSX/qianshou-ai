/**
 * 模型网关的转发层：把一次请求真正发到模型服务商，**流式**收回来，并把用量交回账本。
 *
 * 与上游那个入口的区别（我读过它的实现）：上游从请求体里只读 `messages` 与 `model`、
 * 其余字段全部丢弃，且 `max_tokens` 写死 2000、非流式、不写审计。这里三件都能做：
 * **输出长度可配、流式输出、逐调用留痕**。
 *
 * 三个容易出错的地方，各自都有对应的处理：
 *
 * 1. **服务商可能在 200 的响应里返回错误块**，而不是用状态码。只看状态码会把错误当正文流给用户。
 * 2. **流式下 `usage` 通常只在最后一帧出现**，而且不是所有服务商都支持 `include_usage`。
 *    所以输出 token 要**边流边数**，上游给了权威值就用权威值。
 * 3. **末尾没有换行的最后一帧**会留在缓冲区里。收流后必须再冲一次缓冲，否则最后几个字丢掉。
 */

/** 服务商返回给我们的用量。 */
export interface ProviderUsage {
  readonly promptTokens: number
  readonly completionTokens: number
}

/** 一次失败。 */
export type ForwardFailureKind =
  /** 没配密钥 / 端点。 */
  | 'not-configured'
  /** 密钥被拒（401/403）。 */
  | 'unauthorized'
  /** 限流（429）。 */
  | 'rate-limited'
  /** 余额不足（402）。 */
  | 'insufficient-balance'
  /** 服务商故障（5xx）。 */
  | 'server-error'
  /** 连不上。 */
  | 'unreachable'
  /** 调用方取消。 */
  | 'aborted'
  /** 响应无法解析，或服务商在 200 里塞了错误。 */
  | 'invalid-response'

/** 面向用户的说明；直接展示，不再二次翻译。 */
export const FORWARD_COPY: Readonly<Record<ForwardFailureKind, string>> = {
  'not-configured': '服务暂时不可用，请稍后再试。',
  unauthorized: '服务配置有问题，我们已经记录。',
  'rate-limited': '现在用的人有点多，稍等一下再试。',
  'insufficient-balance': '服务额度不足，请联系我们。',
  'server-error': '服务暂时不稳定，稍后重试。',
  unreachable: '连不上模型服务。检查网络后再试。',
  aborted: '已停止。',
  'invalid-response': '模型返回的内容无法识别，请再试一次。',
}

/** 一次转发的副作用：一份失败说明 + 面向用户的文案 + 可选状态码。 */
export class ForwardFailure extends Error {
  constructor(
    readonly kind: ForwardFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ForwardFailure'
  }
}

/** 按状态码分类；顺序重要（401/403 先于 5xx 判断是分别处理，不是包含关系）。 */
export function classifyForwardStatus(status: number): ForwardFailureKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402) return 'insufficient-balance'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server-error'
  return 'invalid-response'
}

/** 转发层的配置。 */
export interface ForwarderConfig {
  /** OpenAI 兼容根地址，例如 `https://api.deepseek.com/v1`。**密钥不进这里**。 */
  readonly baseUrl: string
  /** 取密钥的函数；调用时才取，避免密钥被长期持有在闭包里。 */
  /**
   * 取密钥。**允许返回 Promise**。
   *
   * 为什么不是纯同步：密钥可能来自宿主的凭据服务，那是异步的。早期版本为了迁就
   * 同步签名，先异步预读、同时同步返回环境变量兜底，结果**第一次请求必然拿不到密钥**
   * ——用户第一次发消息就是"服务暂时不可用"，而密钥其实配得好好的。
   * 这里一次 `await` 就解决，不值得为它留一个只在首次出现的 bug。
   */
  readonly apiKey: () => string | null | Promise<string | null>
  /** 注入的 fetch；测试用。 */
  readonly fetch?: typeof fetch
  /** 单次请求超时（毫秒）。 */
  /**
   * 空闲超时（毫秒）：多久没收到字节就中止。
   *
   * 注意语义是**空闲**而不是总时长——见 {@link DEFAULT_IDLE_TIMEOUT_MS} 的说明。
   */
  readonly timeoutMs?: number
  /** 总时长硬上限（毫秒）。 */
  readonly totalTimeoutMs?: number
}

/** 一次转发请求。 */
export interface ForwardCall {
  /** 真实模型标识（后端），**只在这一层出现**。 */
  readonly model: string
  readonly messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[]
  readonly maxOutputTokens: number
  readonly signal?: AbortSignal
}

/** 流式回调。 */
export interface ForwardHandlers {
  readonly onDelta: (text: string) => void
  /** 收流结束；`usage` 是权威用量（服务商给了就用它，没给就用本地计数）。 */
  readonly onDone: (usage: ProviderUsage) => void
  readonly onError: (failure: ForwardFailure) => void
}

/** 一次转发的句柄。 */
export interface ForwardStream {
  readonly abort: () => void
  readonly completed: Promise<void>
}

/** 默认超时：模型生成长回答可能很久，给足时间。 */
/**
 * **空闲**超时：多久没有收到任何字节就认为上游卡住了。
 *
 * 为什么不是"总时长上限"：总时长会把**正在正常输出**的长回答掐死——
 * 一次写三分钟的长回答会在第 120 秒被切断，用户拿到半截话。
 * 而"多久没数据"才真正对应"上游卡住了"这件事：只要还在吐字，就说明它在工作。
 *
 * 30 秒的依据：正常首字节通常在几秒内到达；中途静默 30 秒以上，
 * 基本可以判定这次请求已经不会再有下文了。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000

/** 总时长硬上限，防止连接被无限占住（正常问答远达不到）。 */
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000

/**
 * 从一帧里取出结束原因（`stop` / `length` / …）。
 *
 * 为什么需要它：**一个字都没有**的流有两种完全不同的原因——
 * 「上游回了个看不懂的东西」与「输出上限太小，被截断了」。
 * 两者给用户的话不该一样：后者他能自己动手（把上限调大）。
 * @param payload - 一帧的 JSON 文本。
 * @returns 结束原因；这一帧没有就是 `null`。
 */
function finishReasonOf(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { choices?: { finish_reason?: unknown }[] }
    const reason = parsed.choices?.[0]?.finish_reason
    return typeof reason === 'string' && reason.length > 0 ? reason : null
  } catch {
    return null
  }
}

/** 从一帧里取出正文增量。 */
function deltaOf(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }
    const content = parsed.choices?.[0]?.delta?.content
    return typeof content === 'string' && content.length > 0 ? content : null
  } catch {
    return null
  }
}

/** 从一帧里取出权威用量（流式通常只在最后一帧有）。 */
function usageOf(payload: string): ProviderUsage | null {
  try {
    const parsed = JSON.parse(payload) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
    const prompt = parsed.usage?.prompt_tokens
    const completion = parsed.usage?.completion_tokens
    if (typeof prompt !== 'number' || typeof completion !== 'number') return null
    return { promptTokens: prompt, completionTokens: completion }
  } catch {
    return null
  }
}

/**
 * 从**非流式**的整包里取出正文与用量。
 *
 * 有些服务商或网关会忽略 `stream: true`，直接回一整份 JSON。那种响应按行解析会**一个字都取不到**，
 * 表现成"流正常结束但界面空白"——比报错更难查。这里把它认下来。
 * @param raw - 完整响应体。
 * @returns 正文与用量；都不是 JSON 时正文按纯文本处理。
 */
export function parseWholeResponse(raw: string): { readonly content: string; readonly usage: ProviderUsage | null } {
  const text = raw.trim()
  if (text.length === 0) return { content: '', usage: null }
  try {
    const parsed = JSON.parse(text) as {
      choices?: { message?: { content?: unknown } }[]
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    const content = parsed.choices?.[0]?.message?.content
    const usage = usageOf(text)
    return { content: typeof content === 'string' ? content : '', usage }
  } catch {
    return { content: text, usage: null }
  }
}

/**
 * 发一次流式请求。
 * @param config - 端点、密钥来源与超时。
 * @param call - 模型、消息与输出上限。
 * @param handlers - 增量、完成与失败回调。
 * @returns 可中止的句柄。
 */
export function forwardStream(config: ForwarderConfig, call: ForwardCall, handlers: ForwardHandlers): ForwardStream {
  const controller = new AbortController()
  const idleTimeoutMs = config.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const totalTimeoutMs = config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  /**
   * 超时标志与原因放在**对象**里，而不是各自的 `let`。
   *
   * 为什么：它们只在下方的计时器回调里被改写，而 TypeScript 的控制流分析看不见
   * "回调稍后执行"这件事——于是会把 `let timedOut = false` 在读取处收窄成 `false`，
   * 把"超时了吗"这类判断报成冗余条件。挂在对象上就没有这层（错误的）收窄，
   * 读起来也仍然是一处状态。
   */
  const timerState: { timedOut: boolean; reason: 'idle' | 'total' } = { timedOut: false, reason: 'idle' }

  /**
   * 两个计时器：
   * - `idleTimer`：每收到一块数据就重置。它是"上游卡住了"的判据。
   * - `totalTimer`：从发起请求起算，防止连接被无限占住。长回答写到一半**不会**被它误杀，
   *   因为正常回答远达不到十分钟。
   */
  /**
   * 空闲计时器的句柄也挂在**对象**上，理由与 `timerState` 相同：它只在 `armIdle` 里被赋值，
   * 而 TS 的控制流分析看不见"这个函数稍后会被调用"，会把读取处的 `idleTimer` 一直当成 `null`。
   */
  const timers: { idle: ReturnType<typeof setTimeout> | null } = { idle: null }
  const armIdle = (): void => {
    if (timers.idle !== null) globalThis.clearTimeout(timers.idle)
    timers.idle = globalThis.setTimeout(() => {
      timerState.reason = 'idle'
      timerState.timedOut = true
      controller.abort()
    }, idleTimeoutMs)
  }
  const totalTimer = globalThis.setTimeout(() => {
    timerState.reason = 'total'
    timerState.timedOut = true
    controller.abort()
  }, totalTimeoutMs)
  armIdle()
  const outer = call.signal
  const onOuterAbort = (): void => { controller.abort() }
  if (outer !== undefined) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }

  const completed = (async () => {
    const key = await config.apiKey()
    if (key === null || key.trim().length === 0) {
      handlers.onError(new ForwardFailure('not-configured', FORWARD_COPY['not-configured']))
      return
    }

    let response: Response
    try {
      response = await (config.fetch ?? globalThis.fetch)(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: call.model,
          messages: call.messages,
          max_tokens: call.maxOutputTokens,
          stream: true,
          // 请服务商在最后一帧带上用量。不是所有服务商都认这个字段，所以下面**不依赖它**。
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      })
    } catch (error) {
      void error
      handlers.onError(timerState.timedOut
        ? new ForwardFailure('unreachable', timerState.reason === 'idle'
          ? '服务商迟迟没有回应，这次请求已中止。可以重发一次。'
          : FORWARD_COPY.unreachable)
        : new ForwardFailure('aborted', FORWARD_COPY.aborted))
      return
    }

    if (!response.ok) {
      const kind = classifyForwardStatus(response.status)
      // 不把服务商原文透给用户；它可能带内部信息。状态码留着供我们排查。
      handlers.onError(new ForwardFailure(kind, FORWARD_COPY[kind], response.status))
      return
    }
    if (response.body === null) {
      handlers.onError(new ForwardFailure('invalid-response', FORWARD_COPY['invalid-response']))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let authoritative: ProviderUsage | null = null
    let sawAnyDelta = false
    /** 上游给出的结束原因；用来区分"触顶截断"与"内容无法识别"。 */
    let finishReason: string | null = null

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // 收到任何字节都说明上游在动，重置空闲计时——这样长回答不会被误杀。
        armIdle()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          const usage = usageOf(payload)
          if (usage !== null) authoritative = usage
          const reason = finishReasonOf(payload)
          if (reason !== null) finishReason = reason
          const delta = deltaOf(payload)
          if (delta !== null) {
            sawAnyDelta = true
            handlers.onDelta(delta)
          }
        }
      }
      // 收流后冲一次缓冲：末尾没有换行时最后一帧会留在这里，不冲就会丢最后几个字。
      const last = buffer.trim()
      if (last.startsWith('data:')) {
        const payload = last.slice(5).trim()
        const usage = usageOf(payload)
        if (usage !== null) authoritative = usage
        const delta = deltaOf(payload)
        if (delta !== null) { sawAnyDelta = true; handlers.onDelta(delta) }
      }

      if (!sawAnyDelta) {
        // 一个字都没收到：最常见的原因是服务商忽略了 stream 参数，回了一整份 JSON。
        const whole = parseWholeResponse(buffer)
        if (whole.content.length > 0) {
          handlers.onDelta(whole.content)
          // upstream 没给 usage 时回零，由调用方用**模型无关的估算**补齐——
          // 这里若自己按"字符数 ÷ 4"估，中文会被低估约 4 倍，那会直接少收钱。
          handlers.onDone(whole.usage ?? { promptTokens: 0, completionTokens: 0 })
          return
        }
        /**
         * 一个字都没有、但流正常结束——真实端点上的头号原因是**输出上限被推理吃掉**：
         * 会推理的模型先产 `reasoning_content`，而推理 token 算在 `max_tokens` 里，
         * 预算太小就轮不到正文（实测：deepseek-flash 在 4096 预算下正文从第 868 帧才开始）。
         *
         * 这种情况说"内容无法识别"是误导用户以为产品坏了。所以这里把
         * `finish_reason: length` 单独识别出来，给一句能动手的话。
         */
        if (finishReason === 'length') {
          handlers.onError(new ForwardFailure('invalid-response',
            '这次请求的输出上限太小，模型还没写出正文就用完了。把上限调大一些再试。'))
          return
        }
        handlers.onError(new ForwardFailure('invalid-response', FORWARD_COPY['invalid-response']))
        return
      }
      handlers.onDone(authoritative ?? { promptTokens: 0, completionTokens: 0 })
    } catch (error) {
      void error
      // 三种原因分开：超时与网络是「连不上」，调用方取消是「已停止」，
      // 其余（解码/解析）是「响应无法识别」——混成一个会让排查从第一步就走错。
      const kind: ForwardFailureKind = timerState.timedOut || outer?.aborted !== true
        ? (timerState.timedOut ? 'unreachable' : 'invalid-response')
        : 'aborted'
      handlers.onError(new ForwardFailure(kind, FORWARD_COPY[kind]))
    } finally {
      globalThis.clearTimeout(totalTimer)
      if (timers.idle !== null) globalThis.clearTimeout(timers.idle)
      outer?.removeEventListener('abort', onOuterAbort)
      try { reader.releaseLock() } catch { /* 已经释放 */ }
    }
  })()

  return { abort: () => { controller.abort() }, completed }
}
