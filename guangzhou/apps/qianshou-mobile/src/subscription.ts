/**
 * 订阅通道客户端：把 `/api/qianshou/ai/chat` 的 SSE 接成与 `llm.ts` 的 `streamChat`
 * **同形**的调用，这样对话控制器可以无差别替换，不需要改它的契约。
 *
 * 与 BYOK 那条通路的四条区别（每一条都是刻意的）：
 *
 * 1. **不带任何密钥**。身份来自宿主侧的账号 cookie（同源、浏览器自动带上）；
 *    请求体里只有模型名与消息。密钥内置在我方后台，客户端永远看不到、也不需要。
 * 2. **模型名是前台名**（`千手·迅捷` / `千手·强力`），上游真实模型标识绝不出网关。
 *    所以这里在发请求前校验名字：拿到不是前台名的值就明确报错，而不是把别的标识发出去。
 * 3. **结束是明确的**：网关发 `done` 帧（带这次用了哪个模型、有没有降级、扣了多少点），
 *    或者 `error` 帧（带机器可读的 `status`）。判断走不走得通、要不要付费**按 `status`
 *    分支**，不是读那句中文去猜。
 * 4. **降级必须让用户看见**：请求的名字与实际作答的名字不同就是降级，说明文字交给
 *    上层显示；静默换模型是这里最不能犯的错。
 *
 * 身份边界（会不会把费用记到别的账号上）不在这里判定，而在 `App.tsx`：只有"同源部署 +
 * 已登录"才允许走到这里。`refuseSubscription` 是同一判定的兜底——条件不满足时**一个
 * 请求都不发**。
 */
import { ChatFailure, type ChatStream, type SendOptions, type StreamHandlers } from './llm.ts'
import { AI_CHAT_PATH, isFrontModel, routeBlockReason, type RouteConditions } from './subscription-model.ts'
import { SSE_DONE, sseData, takeLines } from './sse.ts'

/**
 * 一次对话结束时的结算信息（网关 `done` 帧）。
 *
 * 数字一律来自网关；网关没给就是 `null`，界面显示"未知"，绝不补一个看起来合理的值。
 */
export interface SubscriptionDone {
  /** 实际作答的前台模型名。 */
  readonly model: string
  /** 这次请求的前台模型名。 */
  readonly requestedModel: string
  /** 是否发生了降级（请求的名字与实际作答的名字不同）。 */
  readonly downgraded: boolean
  /** 可直接显示的中文说明；没降级时为 `null`。 */
  readonly note: string | null
  /** 这次扣了多少点数（SP）；网关没给时为 `null`。 */
  readonly chargedSp: number | null
  /** 本月剩余点数（SP）；网关没给时为 `null`。 */
  readonly remainingSp: number | null
}

/**
 * 订阅通路的流式回调。
 *
 * 与 `StreamHandlers` 同形，只把 `onDone` 多带一个结算结果：不关心结算的调用方
 * （例如只想拿到文本的代码）可以直接把它当 `StreamHandlers` 用——`StreamHandlers`
 * 在这里是**可赋值**的，所以 `streamSubscription` 能被当作 `StreamChatFn` 注入控制器。
 */
export type SubscriptionHandlers = Omit<StreamHandlers, 'onDone'> & {
  readonly onDone: (result: SubscriptionDone) => void
}

/** 网关 `done` 帧的字段。 */
interface GatewayDoneFrame {
  readonly type: 'done'
  readonly model: string
  readonly requestedModel: string
  readonly downgraded: boolean
  readonly note: string | null
  readonly chargedSp: number | null
  readonly remainingSp: number | null
}

/** 网关 `error` 帧的字段；`status` 是**机器可读**的分类依据。 */
interface GatewayErrorFrame {
  readonly type: 'error'
  readonly kind: string
  readonly message: string
  readonly status: number | null
}

/** 网关的一帧。三种之外的一律不认（网关将来加帧型时旧客户端不该炸）。 */
export type GatewayFrame =
  | { readonly type: 'delta'; readonly text: string }
  | GatewayDoneFrame
  | GatewayErrorFrame

/**
 * 解析一帧网关 SSE。
 *
 * 纯函数：三种帧的字段取舍都在这里一次说完，测试可以在毫秒级把它穷举。
 * @param payload - `data:` 后面的 JSON 原文。
 * @returns 帧对象；不是 JSON、认不出类型、或这一帧不携带内容时返回 `null`。
 */
export function parseGatewayFrame(payload: string): GatewayFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // 心跳/注释/被截断的半行：跳过这一帧，而不是中断整条流。
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const frame = parsed as Record<string, unknown>
  if (frame['type'] === 'delta') {
    const text = frame['text']
    // 空增量不产生一次空更新（与 BYOK 那条通路的取舍一致）。
    return typeof text === 'string' && text.length > 0 ? { type: 'delta', text } : null
  }
  if (frame['type'] === 'done') {
    return {
      type: 'done',
      model: stringOf(frame['model']),
      requestedModel: stringOf(frame['requestedModel']),
      downgraded: frame['downgraded'] === true,
      note: textOf(frame['downgradeNote']),
      chargedSp: numberOf(frame['chargedSp']),
      remainingSp: remainingSpOf(frame['credit']),
    }
  }
  if (frame['type'] === 'error') {
    const rejection = frame['rejection']
    const rejectionFields = rejection !== null && typeof rejection === 'object' ? (rejection as Record<string, unknown>) : {}
    /**
     * 分类取 `rejection.kind` 优先。
     *
     * 网关**被拒**时顶层 `kind` 只是粗分类 `'rejected'`，精确原因在 `rejection.kind`
     * （`no-credit` / `too-many-concurrent` / `context-too-long` / `unknown-model` …）；
     * 上游转发失败时反过来——顶层 `kind` 就是精确分类，也没有 `rejection`。
     * 两者都认，取"有信息的那一个"。实测样本见 `tests/fixtures/gateway-wire.json`。
     */
    const nested = stringOf(rejectionFields['kind'])
    return {
      type: 'error',
      kind: nested.length > 0 ? nested : stringOf(frame['kind']),
      message: stringOf(frame['message']),
      status: numberOf(frame['status']),
    }
  }
  return null
}

/** 取字符串字段；不是字符串时给空串（上层据此判断"网关没给"）。 */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 取可选文本字段；空串与空白一律当"没有"。 */
function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** 取可选数字字段；不是有限数字时返回 `null`。 */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 从 `done.credit` 里取剩余点数；结构不对时返回 `null`。 */
function remainingSpOf(credit: unknown): number | null {
  if (credit === null || typeof credit !== 'object') return null
  return numberOf((credit as Record<string, unknown>)['remainingMonthlySp'])
}

/**
 * 每种失败对应的用户可见说明。
 *
 * 402 / 429 的两句是**可行动**的：一个告诉你怎么恢复（升级档位或等下个周期），
 * 一个告诉你要等多久（几秒），而不是笼统的"失败了"。这两条都不带数字——数字只说
 * 网关给的那些（见余额显示），文案里不编。
 */
export const SUBSCRIPTION_FAILURE_COPY: Readonly<Record<string, string>> = {
  'no-credit': '订阅额度不足：升级档位，或等下个周期恢复。也可以去设置里改用你自己的密钥。',
  'too-many-concurrent': '同时进行的请求太多（并发上限）。等几秒再发一次。',
  'invalid-request': '这次请求网关没接受。把内容改短一点，或换个模型再试。',
  'context-too-long': '这次的内容太长了，超出当前档位的单次上限。把内容拆成几次，或升级档位。',
  'model-not-in-tier': '这个模型在你的档位里用不了。改用「千手·迅捷」再试。',
  'unknown-model': '这个模型现在用不了。换一个再试。',
  unauthorized: '登录状态已过期。重新登录，或去设置里改用你自己的密钥。',
  'server-error': '千手网关暂时不可用。稍后重试。',
  'invalid-response': '网关返回了无法解析的内容。',
  network: '连不上千手网关。检查手机网络，或稍后重试。',
  aborted: '已取消。',
  truncated: '连接中断了，这条回复不完整。再发一次可以接着问。',
  /**
   * 上游侧的失败（不是用户的问题，也不是用户的额度）：这三句不能用"你的订阅额度/并发"
   * 那一套去解释——那会把我们这边的故障说成用户的错。
   */
  'upstream-balance': '千手网关的上游额度暂时不足，这次没能作答。稍后重试。',
  'upstream-busy': '千手网关的上游太忙，这次没能作答。等几秒再试一次。',
  'upstream-unauthorized': '千手服务的上游凭据被拒绝，这次没能作答。稍后重试。',
}

/**
 * 按**状态码**（其次按分类）给失败定性。
 *
 * 为什么先看 `status`：它是机器可读的契约（402 该付费、429 该等一下、400 请求本身有问题、
 * 403/404 模型不可用），而 `message` 是我方后台随时会改的中文。读文案做判断的代码，
 * 文案一改就悄悄失灵。网关没给 `status` 时才退回分类——被拒时分类来自
 * `rejection.kind`，上游转发失败时它与 `ChatFailureKind` 同名，两种都认。
 * 都没有才用兜底文案。
 * @param input - 状态码、分类与网关给的中文说明。
 * @returns 面向用户的失败对象。
 */
export function subscriptionFailure(input: {
  readonly status?: number | null
  readonly kind?: string | null
  readonly message?: string | null
}): ChatFailure {
  const status = input.status ?? null
  const kind = input.kind ?? ''
  const given = (input.message ?? '').trim()
  const pick = (key: string): string => SUBSCRIPTION_FAILURE_COPY[key] ?? SUBSCRIPTION_FAILURE_COPY['invalid-response'] ?? ''
  const text = (fallback: string): string => (given.length > 0 ? given : fallback)
  if (status === 401) return new ChatFailure('unauthorized', pick('unauthorized'), 401)
  if (status === 402) return new ChatFailure('insufficient-balance', pick('no-credit'), 402)
  if (status === 429) return new ChatFailure('rate-limited', pick('too-many-concurrent'), 429)
  if (status === 403) return new ChatFailure('invalid-response', text(pick('model-not-in-tier')), 403)
  if (status === 404) return new ChatFailure('invalid-response', text(pick('unknown-model')), 404)
  if (status === 400) {
    // 400 有两种：内容太长（用户能自己改短）与请求本身不合法（同上，但文案不同）。
    return new ChatFailure('invalid-response', text(pick(kind === 'context-too-long' ? 'context-too-long' : 'invalid-request')), 400)
  }
  if (status !== null && status >= 500) return new ChatFailure('server-error', pick('server-error'), status)
  if (kind === 'no-credit') return new ChatFailure('insufficient-balance', pick('no-credit'))
  if (kind === 'too-many-concurrent') return new ChatFailure('rate-limited', pick('too-many-concurrent'))
  // 上游转发失败：分类与 `ChatFailureKind` 同名，但**原因不在用户那边**，
  // 所以文案要换一套（网关自己给的那句优先）。
  if (kind === 'insufficient-balance') return new ChatFailure('insufficient-balance', text(pick('upstream-balance')))
  if (kind === 'rate-limited') return new ChatFailure('rate-limited', text(pick('upstream-busy')))
  if (kind === 'unauthorized') return new ChatFailure('unauthorized', text(pick('upstream-unauthorized')))
  if (kind === 'model-not-in-tier') return new ChatFailure('invalid-response', text(pick('model-not-in-tier')))
  if (kind === 'unknown-model') return new ChatFailure('invalid-response', text(pick('unknown-model')))
  if (kind === 'context-too-long' || kind === 'invalid-request') {
    return new ChatFailure('invalid-response', text(pick(kind)))
  }
  if (isChatFailureKind(kind)) return new ChatFailure(kind, text(pick(kind)))
  return new ChatFailure('invalid-response', text(pick('invalid-response')), status ?? undefined)
}

/** 这个分类是不是本地的失败分类（上游转发失败的分类与它同名，可以直接借过来）。 */
function isChatFailureKind(value: string): value is ChatFailure['kind'] {
  return value === 'no-key'
    || value === 'no-endpoint'
    || value === 'unauthorized'
    || value === 'rate-limited'
    || value === 'insufficient-balance'
    || value === 'server-error'
    || value === 'network'
    || value === 'aborted'
    || value === 'invalid-response'
}

/**
 * 条件不满足时**一个请求都不发**，直接给出可行动的说明。
 *
 * 这是身份边界的第二道闸：第一道在 `App.tsx`（不满足就不切到订阅档），这一道兜住
 * "切过去之后条件又变了"（例如会话过期）。**绝不静默改走 BYOK**——用户选的是订阅通道，
 * 悄悄换一条会花钱的通路比报错更糟。
 * @param conditions - 同源与登录事实。
 * @param handlers - 错误回调。
 * @returns 立即可等待的句柄。
 */
export function refuseSubscription(conditions: RouteConditions, handlers: StreamHandlers): ChatStream {
  const message = routeBlockReason(conditions) ?? '订阅通道现在不可用。'
  return {
    abort: () => { /* 没有请求可取消 */ },
    completed: Promise.resolve().then(() => { handlers.onError(new ChatFailure('unauthorized', message)) }),
  }
}

/**
 * 发起一次订阅通道的流式对话。
 *
 * 与 `llm.ts` 的 `streamChat` **同形**（`SendOptions` / `StreamHandlers` / `ChatStream`），
 * 所以控制器可以直接换实现；`baseUrl` 与 `apiKey` 在这里**被忽略**——
 * 地址是同源宿主路径，而密钥根本不该存在这条通路上。
 * @param options - 模型（前台名）、消息与取消信号。
 * @param handlers - 增量、结束（带结算）与错误回调。
 * @returns 可中止的句柄。
 */
export function streamSubscription(options: SendOptions, handlers: SubscriptionHandlers): ChatStream {
  const controller = new AbortController()
  const signal = options.signal ?? controller.signal

  const completed = (async (): Promise<void> => {
    const model = options.model.trim()
    if (!isFrontModel(model)) {
      // 把上游标识发出去会 404，更糟的是它意味着有地方把内部标识漏到了界面。
      handlers.onError(new ChatFailure(
        'invalid-response',
        `「${model}」不是订阅通道的模型名。去「我的 → 模型设置」重新选一个。`,
      ))
      return
    }

    let response: Response
    try {
      response = await fetch(AI_CHAT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: options.messages }),
        signal,
      })
    } catch (error) {
      handlers.onError(transportFailure(signal))
      void error
      return
    }

    if (!response.ok) {
      const payload = await readJson(response)
      handlers.onError(subscriptionFailure({ status: response.status, message: messageOf(payload) }))
      return
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      // 中间层（代理/网关/预览服务）把流改写成了普通响应：说出来，别装作收到空回复。
      const payload = await readJson(response)
      handlers.onError(new ChatFailure('invalid-response', rewrittenCopy(contentType, messageOf(payload))))
      return
    }
    if (response.body === null) {
      handlers.onError(new ChatFailure('invalid-response', '网关没有返回响应体。'))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    /** 有没有真的收到过正文。全程为空时要在收流后如实说明，而不是当作完成。 */
    let sawDelta = false
    /** 收流是不是由**明确的终止帧**结束的（`done` / `error` / `[DONE]`）。 */
    let terminated = false

    /** 消费一行；返回 `true` 表示这一行终止了整条流。 */
    const consume = (line: string): boolean => {
      const payload = sseData(line)
      if (payload === null) return false
      if (payload === SSE_DONE) {
        // 有的中间层会在末尾补一个 `[DONE]`：那是"这一轮结束了"，不是一条网关帧。
        if (!sawDelta) handlers.onError(emptyReply(contentType))
        handlers.onDone(noSettlement(model))
        return true
      }
      const frame = parseGatewayFrame(payload)
      if (frame === null) return false
      if (frame.type === 'delta') {
        sawDelta = true
        handlers.onDelta(frame.text)
        return false
      }
      if (frame.type === 'done') {
        // 一个字都没有就结算：如实报错，再正常收尾（与 BYOK 那条通路同一套判断）。
        // 只报"完成"会让界面停在"已回复"而屏幕上什么都没有，比报错更难查。
        if (!sawDelta) handlers.onError(emptyReply(contentType))
        handlers.onDone(settlement(frame))
        return true
      }
      handlers.onError(subscriptionFailure({ status: frame.status, kind: frame.kind, message: frame.message }))
      return true
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const split = takeLines(buffer)
        buffer = split.rest
        for (const line of split.lines) {
          if (consume(line)) { terminated = true; break }
        }
        if (terminated) break
      }
      // 收流后缓冲里可能还剩最后一行（末尾没有换行时它进不了上面的循环）；
      // `[DONE]` 之后残余的内容也走这里，不再产生任何回调。
      if (!terminated) terminated = consume(buffer)
      if (!terminated) {
        // 没有终止帧就断了：有正文说明是被截断的半截回答，一个字都没有说明网关回了空。
        handlers.onError(sawDelta
          ? new ChatFailure('network', SUBSCRIPTION_FAILURE_COPY['truncated'] ?? '')
          : emptyReply(contentType))
      }
    } catch (error) {
      handlers.onError(transportFailure(signal))
      void error
    } finally {
      try { reader.releaseLock() } catch { /* 已经释放 */ }
    }
  })()

  return { abort: () => { controller.abort() }, completed }
}

/** 把 `done` 帧收成对上层有用的结算信息（含降级说明）。 */
function settlement(frame: GatewayDoneFrame): SubscriptionDone {
  // 判据不只靠 `downgraded` 这一个布尔位：两个名字不一样，事实就是换了模型。
  const downgraded = frame.downgraded
    || (frame.model.length > 0 && frame.requestedModel.length > 0 && frame.model !== frame.requestedModel)
  return {
    model: frame.model,
    requestedModel: frame.requestedModel,
    downgraded,
    note: downgraded ? (frame.note ?? downgradeCopy(frame)) : null,
    chargedSp: frame.chargedSp,
    remainingSp: frame.remainingSp,
  }
}

/** 网关没给说明时，用**它给的两个名字**写一句（不猜原因、不编模型）。 */
function downgradeCopy(frame: GatewayDoneFrame): string {
  if (frame.model.length > 0 && frame.requestedModel.length > 0) {
    return `这次请求的是「${frame.requestedModel}」，实际由「${frame.model}」作答。`
  }
  return '这次发生了降级：你要的模型没有被用来作答。'
}

/** 没有结算信息的结束（`[DONE]` 兜底）：什么都不编，只记下这次请求的名字。 */
function noSettlement(requestedModel: string): SubscriptionDone {
  return {
    model: '',
    requestedModel,
    downgraded: false,
    note: null,
    chargedSp: null,
    remainingSp: null,
  }
}

/** 连不上/被中止：区分"用户按了停止"与"网络不通"。 */
function transportFailure(signal: AbortSignal): ChatFailure {
  return signal.aborted
    ? new ChatFailure('aborted', SUBSCRIPTION_FAILURE_COPY['aborted'] ?? '')
    : new ChatFailure('network', SUBSCRIPTION_FAILURE_COPY['network'] ?? '')
}

/** 一个字都没收到时的说明；带上真实的 content-type，那是能动手的线索。 */
function emptyReply(contentType: string): ChatFailure {
  const detail = contentType.length > 0 ? `响应类型是 ${contentType}` : '没有给出响应类型'
  return new ChatFailure('invalid-response', `网关这条消息是空的（${detail}）。检查模型是否正确，或换一个模型再试。`)
}

/** 响应不是 SSE 时的说明；中间层给的中文说明优先。 */
function rewrittenCopy(contentType: string, given: string | null): string {
  if (given !== null) return given
  const detail = contentType.length > 0 ? contentType : '没有 content-type'
  return `网关返回的不是流式响应（${detail}），多半被中间层改写了。`
}

/** 尽力读出响应体里的 JSON；读不到给 `null`。 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** 从响应体里取一句可展示的中文说明。 */
function messageOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  return textOf((payload as Record<string, unknown>)['message'])
}
