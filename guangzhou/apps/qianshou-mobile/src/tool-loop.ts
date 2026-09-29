/**
 * 手机端的**搜索工具循环**：拿用户自己的 DeepSeek 密钥，在 Anthropic 兼容接口上
 * 用原生 `web_search_20250305` 服务端工具做一次真正的联网检索，再把结果交回模型，
 * 直到它给出最终回答。
 *
 * 为什么要成环，而不是一次请求：服务端工具在两种情况下会把话语权交回客户端——
 * `stop_reason: "pause_turn"`（长回合被服务端暂停）与工具调用已发出但结果还没回来。
 * 那时把助手这一轮的内容**原样**送回去继续，模型才会拿着搜索结果把话说完。
 *
 * 与 `llm.ts` 的边界：这一层对外**完全**实现 `ChatStream`（`abort` + `completed`），
 * 因此可以直接当作 `ChatController` 的流实现注入，控制器与界面都不需要知道自己
 * 拿到的是普通对话还是搜索循环。密钥、端点、模型都来自调用方，这里不持有任何配置。
 *
 * 中间状态通过 `onPhase` 往上暴露：`searching`（正在等搜索结果）与 `reading`
 * （结果已到，模型正在整理）。`chat.ts` 的 `ChatPhase` 契约一个字都不改。
 */
import {
  ChatFailure,
  FAILURE_COPY,
  classifyStatus,
  type ChatStream,
  type SendOptions,
  type StreamHandlers,
} from './llm.ts'
import {
  invokedSearch,
  parseAnthropicEvent,
  searchHeaders,
  searchRequestBody,
  sourcesOf,
  webSearchEndpoint,
  type ContentBlock,
  type SearchSource,
  type TextBlock,
} from './search.ts'

/** 搜索过程中的中间状态；界面据此显示「正在搜索…」与「正在整理…」。 */
export type SearchPhase = 'searching' | 'reading'

/** 一次搜索循环的可注入依赖；省略即使用真实实现。 */
export interface SearchLoopOptions {
  /** 最多几轮；搜索本身仍由服务端执行，成环只发生在服务端把回合交回时。 */
  readonly maxRounds?: number
  /** 每次请求最多几次搜索。 */
  readonly maxUses?: number
  /** 生成 token 上限。 */
  readonly maxTokens?: number
  /** 注入的 fetch；测试用它接一个假服务端。 */
  readonly fetchImpl?: typeof fetch
  /** 中间状态回调：进入搜索 / 开始整理。 */
  readonly onPhase?: (phase: SearchPhase) => void
  /** 拿到来源时回调一次（同一轮内已去重）。 */
  readonly onSources?: (sources: readonly SearchSource[]) => void
}

/** 默认轮数上限：一次正常搜索一轮就够，成环只在服务端交回时发生。 */
const DEFAULT_MAX_ROUNDS = 3

/** 一条 Anthropic 轮次；`content` 是字符串或内容块数组（续轮时要原样送回）。 */
interface Turn {
  role: 'user' | 'assistant'
  content: string | readonly ContentBlock[]
}

/** 一轮的结果；失败通过判别式字段表达，不靠抛异常跨层。 */
type RoundOutcome =
  | {
    readonly round: RoundResult
    readonly failed?: undefined
  }
  | {
    readonly round?: undefined
    readonly failed: ChatFailure
  }

/** 一轮成功时的观测值。 */
interface RoundResult {
  /** 本轮收到的全部内容块（按出现顺序重建）。 */
  readonly blocks: readonly ContentBlock[]
  /** 服务端给出的结束原因；没有就是 `null`。 */
  readonly stopReason: string | null
  /** 本轮是否真的吐过文字。 */
  readonly textEmitted: boolean
  /** 本轮返回的联网来源（已去重）。 */
  readonly sources: readonly SearchSource[]
}

/**
 * 跑一次搜索工具循环。
 * @param options - 与普通对话同一份 `SendOptions`：端点、密钥、模型、消息、取消信号。
 * @param config - 轮数上限、注入的 fetch 与状态回调。
 * @param handlers - 与 `streamChat` 完全相同的三个回调。
 * @returns 可 `abort()` 的句柄；语义与 `streamChat` 一致。
 */
export function runSearchLoop(
  options: SendOptions,
  config: SearchLoopOptions,
  handlers: StreamHandlers,
): ChatStream {
  const own = new AbortController()
  const signal = options.signal ?? own.signal
  const fetchImpl = config.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS

  const completed = (async () => {
    const endpoint = webSearchEndpoint(options.baseUrl)
    if (endpoint === null) {
      // 端点无法推导 = 配置不可用；给的是**去设置页**的引导，不是技术堆栈。
      handlers.onError(new ChatFailure('no-endpoint', FAILURE_COPY['no-endpoint']))
      return
    }

    const base = searchRequestBody({ model: options.model, messages: options.messages, ...knobs(config) })
    let turns: Turn[] = base.messages.map(message => ({ role: message.role, content: message.content }))
    const collected: SearchSource[] = []

    /**
     * 收下来源并去重；真的有新来源时才回报。
     *
     * 结果块一到就回报，而不是等整轮结束：模型拿到结果之后还要写一段话，那段时间
     * 用户看到的应该是「正在整理…」——等整轮读完再报，用户就只能在"正在搜索"里干等。
     */
    const absorb = (sources: readonly SearchSource[]): void => {
      let added = false
      for (const source of sources) {
        if (collected.some(existing => existing.url === source.url)) continue
        collected.push(source)
        added = true
      }
      if (!added) return
      config.onSources?.([...collected])
      config.onPhase?.('reading')
    }

    for (let round = 1; round <= maxRounds; round += 1) {
      config.onPhase?.('searching')
      const outcome = await oneRound({
        endpoint,
        apiKey: options.apiKey,
        model: options.model,
        system: base.system,
        turns,
        maxTokens: base.max_tokens,
        maxUses: config.maxUses ?? base.tools[0].max_uses,
        signal,
        fetchImpl,
        onDelta: handlers.onDelta,
        onBlock: (block) => {
          if (block.type === 'web_search_tool_result') absorb(sourcesOf([block]))
        },
      })
      if (outcome.failed !== undefined) {
        handlers.onError(outcome.failed)
        return
      }
      const result = outcome.round
      // 整包 JSON 的兼容网关没有流事件，来源只能在这一步收；去重让两条路径可以共用。
      absorb(result.sources)

      const pendingSearch = invokedSearch(result.blocks) && result.sources.length === 0
      const wantContinue = round < maxRounds
        && (result.stopReason === 'pause_turn' || result.stopReason === 'tool_use' || pendingSearch)
      if (!wantContinue) {
        handlers.onDone()
        return
      }
      // 服务端把回合交回来了：把助手这一轮**原样**送回去，让它在搜索结果上继续说完。
      turns = [...turns, { role: 'assistant', content: result.blocks }]
    }
    // 轮数用尽仍没结束：把已经拿到的内容当作完成，而不是挂着不返回。
    handlers.onDone()
  })()

  return { abort: () => { own.abort() }, completed }
}

/** 只带上调用方真的给了的可选旋钮，保持请求体精确。 */
function knobs(config: SearchLoopOptions): { maxTokens?: number; maxUses?: number } {
  return {
    ...config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {},
    ...config.maxUses !== undefined ? { maxUses: config.maxUses } : {},
  }
}

/** 一轮请求的入参。 */
interface RoundInput {
  readonly endpoint: string
  readonly apiKey: string
  readonly model: string
  readonly system: string
  readonly turns: readonly Turn[]
  readonly maxTokens: number
  readonly maxUses: number
  readonly signal: AbortSignal
  readonly fetchImpl: typeof fetch
  readonly onDelta: (text: string) => void
  /** 每出现一个非文本内容块就回调一次；搜索结果块靠它在流中途就被看见。 */
  readonly onBlock: (block: ContentBlock) => void
}

/** 发一轮请求并把内容块拼回来；失败时返回结构化原因。 */
async function oneRound(input: RoundInput): Promise<RoundOutcome> {
  let response: Response
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: 'POST',
      headers: searchHeaders(input.apiKey),
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: input.turns,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: input.maxUses }],
        stream: true,
      }),
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal.aborted) return failed('aborted')
    void error
    return failed('network')
  }

  if (!response.ok) {
    const kind = classifyStatus(response.status)
    return { failed: new ChatFailure(kind, FAILURE_COPY[kind], response.status) }
  }
  if (response.body === null) return failed('invalid-response')

  // 服务端可能不理 `stream: true` 而直接回整包 JSON（兼容网关常见）。
  // 两条路共用同一套内容块处理，界面看到的差别只有"一次性到达"还是"逐字到达"。
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream')) return readWholeBody(response, input.onDelta, input.onBlock)

  return readStream(response, input.signal, input.onDelta, input.onBlock)
}

/** 读整包 JSON 响应。 */
async function readWholeBody(
  response: Response,
  onDelta: (text: string) => void,
  onBlock: (block: ContentBlock) => void,
): Promise<RoundOutcome> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    void error
    return failed('invalid-response')
  }
  if (typeof payload !== 'object' || payload === null) return failed('invalid-response')
  const body = payload as { content?: unknown; stop_reason?: unknown }
  const blocks = Array.isArray(body.content)
    ? body.content.map(block => parseBlockFromJson(block))
    : []
  for (const block of blocks) { if (!isText(block)) onBlock(block) }
  const text = blocks.filter(isText).map(block => block.text).join('')
  if (text.length > 0) onDelta(text)
  return {
    round: {
      blocks,
      stopReason: typeof body.stop_reason === 'string' ? body.stop_reason : null,
      textEmitted: text.length > 0,
      sources: sourcesOf(blocks),
    },
  }
}

/** 逐行读 SSE 并把内容块按 index 重建。 */
async function readStream(
  response: Response,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onBlock: (block: ContentBlock) => void,
): Promise<RoundOutcome> {
  const reader = response.body?.getReader()
  if (reader === undefined) return failed('invalid-response')
  const decoder = new TextDecoder()
  const starts = new Map<number, ContentBlock>()
  const texts = new Map<number, string>()
  let order: number[] = []
  let stopReason: string | null = null
  let textEmitted = false
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseAnthropicEvent(line)
        if (event === null) continue
        if (event.type === 'content_block_start') {
          if (!starts.has(event.index) && !texts.has(event.index)) order.push(event.index)
          const block = event.contentBlock
          if (isText(block)) texts.set(event.index, (texts.get(event.index) ?? '') + block.text)
          else { starts.set(event.index, block); onBlock(block) }
          continue
        }
        if (event.type === 'content_block_delta') {
          if (!texts.has(event.index) && !starts.has(event.index)) order.push(event.index)
          texts.set(event.index, (texts.get(event.index) ?? '') + event.text)
          if (event.text.length > 0) {
            textEmitted = true
            onDelta(event.text)
          }
          continue
        }
        if (event.type === 'message_delta') { stopReason = event.stopReason; continue }
        if (event.type === 'error') {
          return { failed: new ChatFailure('server-error', event.message.length > 0 ? event.message : FAILURE_COPY['server-error']) }
        }
      }
    }
    const blocks = order.map((index) => {
      const text = texts.get(index)
      return text !== undefined ? { type: 'text' as const, text } : starts.get(index)
    }).filter((block): block is ContentBlock => block !== undefined)
    return {
      round: { blocks, stopReason, textEmitted, sources: sourcesOf(blocks) },
    }
  } catch (error) {
    if (signal.aborted) return failed('aborted')
    void error
    return failed('network')
  } finally {
    try { reader.releaseLock() } catch { /* 已经释放 */ }
  }
}

/** 整包 JSON 里的一个内容块；形状不认识时退化为 `unknown` 块。 */
function parseBlockFromJson(value: unknown): ContentBlock {
  if (typeof value !== 'object' || value === null) return { type: 'unknown' }
  const block = value as { type?: unknown; text?: unknown; content?: unknown; tool_use_id?: unknown; id?: unknown; name?: unknown }
  if (block.type === 'text') return { type: 'text', text: typeof block.text === 'string' ? block.text : '' }
  if (block.type === 'server_tool_use') {
    return { type: 'server_tool_use', id: typeof block.id === 'string' ? block.id : '', name: typeof block.name === 'string' ? block.name : '' }
  }
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: typeof block.id === 'string' ? block.id : '', name: typeof block.name === 'string' ? block.name : '' }
  }
  if (block.type === 'web_search_tool_result') {
    const items = Array.isArray(block.content) ? block.content : []
    const content: { type: 'web_search_result'; url: string; title?: string; pageAge?: string }[] = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as { type?: unknown; url?: unknown; title?: unknown; page_age?: unknown }
      if (row.type !== 'web_search_result' || typeof row.url !== 'string') continue
      content.push({
        type: 'web_search_result',
        url: row.url,
        ...typeof row.title === 'string' ? { title: row.title } : {},
        ...typeof row.page_age === 'string' ? { pageAge: row.page_age } : {},
      })
    }
    return { type: 'web_search_tool_result', tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', content }
  }
  return { type: typeof block.type === 'string' ? block.type : 'unknown' }
}

function isText(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

/** 构造一个失败结果；文案一律来自 `FAILURE_COPY`。 */
function failed(kind: ChatFailure['kind']): RoundOutcome {
  return { failed: new ChatFailure(kind, FAILURE_COPY[kind]) }
}
