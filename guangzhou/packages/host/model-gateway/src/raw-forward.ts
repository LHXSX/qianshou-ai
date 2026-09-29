/**
 * **原样透传**的转发层：把上游的 SSE 帧逐帧交出去，不解析、不重建。
 *
 * 为什么需要它（与 `forward.ts` 的分工）：
 * - `forward.ts` 服务的是**我们自己的对话协议**——它把上游帧解析成"正文增量"，
 *   因为我们的手机客户端只需要正文。这个形状是**有损的**。
 * - 但电脑端的主对话走的是 DSH 自己的模型适配器，它需要看到**完整的
 *   `choices[0].delta`**：`reasoning_content`（推理内容）、`tool_calls`（按 index
 *   分片累加的工具调用）、`finish_reason`、以及末帧的 `usage`。
 *   用有损形状去接，agent 的工具调用会**静默消失**——表现为"接上了但不会干活"，
 *   而且不报错。所以这里另开一层：**只做记账与准入，一个字节都不改**。
 *
 * 刻意不做的事：不解析 delta、不合并帧、不改写 body。任何"顺手整理一下"的念头
 * 都会让适配器看到与真实服务商不同的形状，而它正是按真实形状写的。
 */
import { FORWARD_COPY, classifyForwardStatus, type ForwardFailureKind, type ProviderUsage } from './forward.ts'

/** 一段原始 SSE 数据行（已去掉 `data: ` 前缀与换行）。 */
export interface RawFrame {
  /** `data:` 之后的内容；`[DONE]` 也在其中。 */
  readonly payload: string
}

/** 透传失败。 */
export class RawForwardFailure extends Error {
  /**
   * @param kind - 分类，与 `forward.ts` 一致，供路由层选文案。
   * @param message - 面向用户的说明。
   * @param status - 上游状态码（有的话）。
   */
  constructor(
    readonly kind: ForwardFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RawForwardFailure'
  }
}

/** 一次透传的配置。 */
export interface RawForwarderConfig {
  readonly baseUrl: string
  readonly apiKey: () => string | null | Promise<string | null>
  readonly fetch?: typeof fetch
  /** 空闲超时：多久没有字节就认为上游卡住了。语义与 `forward.ts` 一致。 */
  readonly timeoutMs?: number
  /** 总时长硬上限。 */
  readonly totalTimeoutMs?: number
}

/** 一次透传的输入。 */
export interface RawForwardCall {
  /** 上游模型标识（真实标识，**不出网关**）。 */
  readonly model: string
  /** **原样的** OpenAI 兼容请求体字段（messages / tools / temperature / …）。 */
  readonly body: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/** 透传回调。 */
export interface RawForwardHandlers {
  /** 每收到一段 `data:` 就回调一次。 */
  readonly onFrame: (frame: RawFrame) => void
  /** 收流结束。`usage` 是权威用量（上游给了就用它，没给就为 null）。 */
  readonly onDone: (usage: ProviderUsage | null) => void
  readonly onError: (failure: RawForwardFailure) => void
}

/** 可中止的透传句柄。 */
export interface RawForwardStream {
  readonly abort: () => void
  readonly completed: Promise<void>
}

/** 默认空闲超时。 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000
/** 默认总时长上限；agent 的一轮可能很久，所以比普通问答宽。 */
const DEFAULT_TOTAL_TIMEOUT_MS = 900_000

/**
 * 从一帧里取用量。**只读不写**：解析失败就当没有。
 * @param payload - `data:` 之后的内容。
 * @returns 用量，或 `null`。
 */
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
 * 发一次**原样透传**的流式请求。
 * @param config - 端点、密钥与超时。
 * @param call - 上游模型标识与**原样**请求体。
 * @param handlers - 帧、结束与失败回调。
 * @returns 可中止的句柄。
 */
export function forwardRaw(config: RawForwarderConfig, call: RawForwardCall, handlers: RawForwardHandlers): RawForwardStream {
  const controller = new AbortController()
  const idleTimeoutMs = config.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const totalTimeoutMs = config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  /**
   * 超时标志放在**对象**里：它只在计时器回调里被改写，而 TypeScript 的控制流分析
   * 看不见"回调稍后执行"，会把 `let timedOut = false` 在读取处收窄成 `false`
   * （于是"超时了吗"被判成冗余条件）。详见 `forward.ts` 里同一处的说明。
   */
  const timerState: { timedOut: boolean } = { timedOut: false }
  /**
   * 空闲计时器的句柄也挂在**对象**上，理由与 `timerState` 相同：它只在 `armIdle` 里被赋值，
   * 而 TS 的控制流分析看不见"这个函数稍后会被调用"，会把读取处的 `idleTimer` 一直当成 `null`。
   */
  const timers: { idle: ReturnType<typeof setTimeout> | null } = { idle: null }
  const armIdle = (): void => {
    if (timers.idle !== null) globalThis.clearTimeout(timers.idle)
    timers.idle = globalThis.setTimeout(() => {
      timerState.timedOut = true
      controller.abort()
    }, idleTimeoutMs)
  }
  const totalTimer = globalThis.setTimeout(() => {
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
      handlers.onError(new RawForwardFailure('not-configured', FORWARD_COPY['not-configured']))
      return
    }
    let response: Response
    try {
      response = await (config.fetch ?? globalThis.fetch)(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        // **body 原样转发**：工具定义、采样参数、system 提示都在里面。
        // 只覆盖 model（把前台名换成真实后端标识）与强制流式。
        body: JSON.stringify({ ...call.body, model: call.model, stream: true, stream_options: { include_usage: true } }),
        signal: controller.signal,
      })
    } catch (error) {
      void error
      handlers.onError(timerState.timedOut
        ? new RawForwardFailure('unreachable', '服务商迟迟没有回应，这次请求已中止。可以重发一次。')
        : new RawForwardFailure('aborted', FORWARD_COPY.aborted))
      return
    }
    if (!response.ok) {
      const kind = classifyForwardStatus(response.status)
      handlers.onError(new RawForwardFailure(kind, FORWARD_COPY[kind], response.status))
      return
    }
    if (response.body === null) {
      handlers.onError(new RawForwardFailure('invalid-response', FORWARD_COPY['invalid-response']))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let usage: ProviderUsage | null = null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armIdle()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload.length === 0) continue
          if (payload !== '[DONE]') {
            const seen = usageOf(payload)
            if (seen !== null) usage = seen
          }
          handlers.onFrame({ payload })
        }
      }
      // 收流后冲一次缓冲：末尾没有换行时最后一帧会留在这里。
      const last = buffer.trim()
      if (last.startsWith('data:')) {
        const payload = last.slice(5).trim()
        if (payload.length > 0) {
          if (payload !== '[DONE]') {
            const seen = usageOf(payload)
            if (seen !== null) usage = seen
          }
          handlers.onFrame({ payload })
        }
      }
      handlers.onDone(usage)
    } catch (error) {
      void error
      handlers.onError(timerState.timedOut
        ? new RawForwardFailure('unreachable', '服务商迟迟没有回应，这次请求已中止。可以重发一次。')
        : new RawForwardFailure('invalid-response', FORWARD_COPY['invalid-response']))
    } finally {
      globalThis.clearTimeout(totalTimer)
      if (timers.idle !== null) globalThis.clearTimeout(timers.idle)
      try { reader.releaseLock() } catch { /* 已经释放 */ }
    }
  })()

  return { abort: () => { controller.abort() }, completed }
}
