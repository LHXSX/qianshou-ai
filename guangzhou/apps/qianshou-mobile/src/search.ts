/**
 * 手机端的联网搜索：**Anthropic 兼容**接口上的原生 `web_search_20250305` 服务端工具。
 *
 * 为什么单开一层，而不是塞进 `llm.ts`：这是**两套协议**。手机上的 BYOK 对话走
 * OpenAI 兼容的 `/chat/completions`；联网搜索只在 Anthropic 兼容的 `/messages` 上
 * 提供，请求体（`tools` + 服务端工具）、响应体（内容块数组）、流事件名全都不同。
 * 把两者揉进一个文件，只会让"对话"和"搜索"互相污染。这里只放**纯函数**——
 * 端点推导、请求体、SSE 事件解析、来源提取——可在毫秒级测完，不碰网络。
 *
 * 权威实现来自工作台里已经装载的搜索插件：`packages/web/web-search-deepseek/src/provider.ts`
 * （端点 `https://api.deepseek.com/anthropic/v1` + `/messages`、`anthropic-version`
 * `2023-06-01`、`tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses }]`、
 * 同时带 `x-api-key` 与 `authorization: Bearer`）。这里的常量与请求体形状照它写，
 * 只做了手机端必须的那点适配：复用用户自己的密钥，不引入任何我方密钥。
 */

/** 服务端搜索工具的类型名；Anthropic 兼容接口按这个字符串识别原生联网搜索。 */
export const SEARCH_TOOL_TYPE = 'web_search_20250305'

/** 工具名；与权威实现一致。 */
export const SEARCH_TOOL_NAME = 'web_search'

/** Anthropic 协议版本头；与权威实现一致。 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** 一次请求最多几次搜索；与权威实现的默认值一致。 */
export const SEARCH_MAX_USES = 5

/** 生成 token 上限；与权威实现的默认值一致。 */
export const SEARCH_MAX_TOKENS = 4096

/**
 * 支持手机端联网搜索的服务商。
 *
 * 只有 **DeepSeek**：联网搜索是它的 Anthropic 兼容接口提供的原生服务端工具，
 * 别的 OpenAI 兼容服务商没有这个接口。配置成别的服务商时界面必须**明说**
 * 不支持，而不是静默发一个必然失败的请求。
 */
export const SEARCH_PROVIDER_ID = 'deepseek'

/**
 * 该服务商是否支持手机端联网搜索。
 * @param providerId - 用户在设置里选的服务商 id。
 * @returns 是否支持。
 */
export function supportsWebSearch(providerId: string): boolean {
  return providerId === SEARCH_PROVIDER_ID
}

/**
 * 从用户配置的 OpenAI 兼容根地址推出 Anthropic 兼容的 `/messages` 端点。
 *
 * 规则（可解释、可测，不是猜）：
 * - 保留原地址的 origin 与路径前缀（自建网关常挂在 `/deepseek` 这类前缀下）；
 * - 去掉结尾的 `/v1`（那是 OpenAI 协议的版本段，Anthropic 的版本段在 `/anthropic/v1`）；
 * - 已经有 `/anthropic/v1` 或 `/anthropic` 的不再重复追加。
 *
 * 例：`https://api.deepseek.com/v1` → `https://api.deepseek.com/anthropic/v1/messages`，
 * 与工作台插件的默认端点完全一致。
 *
 * **限制**：这是推导，不是探测。自建网关若把 Anthropic 兼容接口挂在别的路径上，
 * 推导结果会不对——那时搜索会以可读的错误收场，不会假装搜过。
 * @param baseUrl - 设置页里的服务地址。
 * @returns 完整端点；地址无法解析时返回 `null`。
 */
export function webSearchEndpoint(baseUrl: string): string | null {
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return null
  }
  const path = url.pathname.replace(/\/+$/u, '')
  if (path.endsWith('/anthropic/v1')) return `${url.origin}${path}/messages`
  if (path.endsWith('/anthropic')) return `${url.origin}${path}/v1/messages`
  const base = path.endsWith('/v1') ? path.slice(0, -'/v1'.length) : path
  return `${url.origin}${base}/anthropic/v1/messages`
}

/** 服务端工具声明；字段与权威实现逐字一致。 */
export function searchTool(maxUses: number = SEARCH_MAX_USES): {
  readonly type: typeof SEARCH_TOOL_TYPE
  readonly name: typeof SEARCH_TOOL_NAME
  readonly max_uses: number
} {
  return { type: SEARCH_TOOL_TYPE, name: SEARCH_TOOL_NAME, max_uses: maxUses }
}

/** 一条联网来源；只保留界面上真的会用到、且服务端真的返回了的字段。 */
export interface SearchSource {
  readonly url: string
  readonly title?: string
  /** 服务端给出的页面时间（若有）。 */
  readonly pageAge?: string
}

/** `text` 块上的引用；服务端的摘录挂在这里。 */
export interface Citation {
  readonly url?: string
  readonly title?: string
  readonly cited_text?: string
}

/** 模型输出的文本块。 */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
  readonly citations?: readonly Citation[]
}

/** 服务端正在执行（或已执行）的工具调用。 */
export interface ServerToolUseBlock {
  readonly type: 'server_tool_use'
  readonly id: string
  readonly name: string
}

/** 服务端搜索的结果块；结果就在 `content` 里。 */
export interface WebSearchToolResultBlock {
  readonly type: 'web_search_tool_result'
  readonly tool_use_id: string
  readonly content: readonly WebSearchResultItem[]
}

/** 单条搜索结果；字段是**归一化后**的名字（线上的 `page_age` 在解析时就换成了 `pageAge`）。 */
export interface WebSearchResultItem {
  readonly type: 'web_search_result'
  readonly url: string
  readonly title?: string
  readonly pageAge?: string
}

/** 客户端工具调用块（某些兼容实现会用它表达同一件事）。 */
export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
}

/**
 * 内容块。
 *
 * 带 `unknown` 兜底是刻意的：服务端将来新增一种块类型时，解析器**不能**因此把
 * 整条回复丢掉。未知块原样保留、参与回灌，界面只渲染它认识的类型。
 */
export type ContentBlock =
  | TextBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | ToolUseBlock
  | { readonly type: string }

/** 流事件。只保留这一层真正要用的四种，其余归为 `other`。 */
export type AnthropicEvent =
  | { readonly type: 'content_block_start'; readonly index: number; readonly contentBlock: ContentBlock }
  | { readonly type: 'content_block_delta'; readonly index: number; readonly text: string }
  | { readonly type: 'message_delta'; readonly stopReason: string | null }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'other' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 把未知对象收成我们认识的内容块；形状不对时退化为 `other` 块而不是抛错。 */
function asBlock(value: unknown): ContentBlock {
  if (!isRecord(value)) return { type: 'unknown' }
  const type = stringOf(value.type)
  if (type === 'text') return { type: 'text', text: stringOf(value.text) ?? '' }
  if (type === 'server_tool_use') {
    return { type: 'server_tool_use', id: stringOf(value.id) ?? '', name: stringOf(value.name) ?? '' }
  }
  if (type === 'tool_use') {
    return { type: 'tool_use', id: stringOf(value.id) ?? '', name: stringOf(value.name) ?? '' }
  }
  if (type === 'web_search_tool_result') {
    const items = Array.isArray(value.content) ? value.content : []
    const results: WebSearchResultItem[] = []
    for (const item of items) {
      if (!isRecord(item) || item.type !== 'web_search_result') continue
      const url = stringOf(item.url)
      if (url === undefined || url.length === 0) continue
      const title = stringOf(item.title)
      const pageAge = stringOf(item.page_age)
      results.push({
        type: 'web_search_result',
        url,
        ...title !== undefined && title.length > 0 ? { title } : {},
        ...pageAge !== undefined && pageAge.length > 0 ? { pageAge } : {},
      })
    }
    return { type: 'web_search_tool_result', tool_use_id: stringOf(value.tool_use_id) ?? '', content: results }
  }
  return { type: type ?? 'unknown' }
}

/**
 * 解析一行 Anthropic SSE 数据。
 *
 * 和 `llm.ts` 的 `parseSseLine` 同构：只认 `data:` 行，`event:` 行忽略（载荷里自带
 * `type`，再读一遍事件名只会多一处可能不一致的地方）。解析不出来就返回 `null`，
 * 心跳、注释行、半行都不会中断整条流。
 * @param line - 一行原文（不含换行）。
 * @returns 归一化后的事件，或 `null`。
 */
export function parseAnthropicEvent(line: string): AnthropicEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (payload.length === 0 || payload === '[DONE]') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const type = stringOf(parsed.type)
  const index = typeof parsed.index === 'number' ? parsed.index : -1
  if (type === 'content_block_start') {
    return { type: 'content_block_start', index, contentBlock: asBlock(parsed.content_block) }
  }
  if (type === 'content_block_delta') {
    const delta = isRecord(parsed.delta) ? parsed.delta : {}
    if (delta.type !== 'text_delta') return { type: 'other' }
    return { type: 'content_block_delta', index, text: stringOf(delta.text) ?? '' }
  }
  if (type === 'message_delta') {
    const delta = isRecord(parsed.delta) ? parsed.delta : {}
    return { type: 'message_delta', stopReason: stringOf(delta.stop_reason) ?? null }
  }
  if (type === 'error') {
    const error = isRecord(parsed.error) ? parsed.error : {}
    return { type: 'error', message: stringOf(error.message) ?? '' }
  }
  return { type: 'other' }
}

/** 把若干内容块摊平成来源清单；同一条 URL 只留第一次出现的那条。 */
export function sourcesOf(blocks: readonly ContentBlock[]): readonly SearchSource[] {
  const seen = new Set<string>()
  const sources: SearchSource[] = []
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result') continue
    for (const item of (block as WebSearchToolResultBlock).content) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      sources.push({
        url: item.url,
        ...item.title !== undefined ? { title: item.title } : {},
        ...item.pageAge !== undefined ? { pageAge: item.pageAge } : {},
      })
    }
  }
  return sources
}

/**
 * 这一轮里模型是否调用了搜索工具。
 *
 * 两种块都算：`server_tool_use`（服务端原生工具，DeepSeek 的实际形态）与
 * `tool_use`（部分兼容实现用它表达同一件事）。
 * @param blocks - 本轮收到的内容块。
 * @returns 是否出现搜索工具调用。
 */
export function invokedSearch(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block =>
    (block.type === 'server_tool_use' || block.type === 'tool_use')
    && (block as ServerToolUseBlock).name === SEARCH_TOOL_NAME)
}

/**
 * 请求体。
 *
 * `system` 是顶层字段、`messages` 里不出现 `system` 角色——这是 Anthropic 协议
 * 与 OpenAI 协议最容易被忽略的差别之一。
 */
export interface SearchRequestBody {
  readonly model: string
  readonly max_tokens: number
  readonly system: string
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
  readonly tools: readonly ReturnType<typeof searchTool>[]
  readonly stream: true
}

/** 一条对话轮次；`system` 已经在顶层。 */
export interface SearchTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/**
 * 把手机端的消息列表转成 Anthropic 的 `system` + `messages`。
 *
 * 相邻同角色消息会合并：Anthropic 要求 user/assistant 交替，而手机端的会话记录
 * 里可能连着两条同角色（例如上一次失败后重发）。合并规则与界面上的
 * `groupRuns` 一致——同一件事在两个地方必须得到同一种结果。
 * @param messages - 手机端的对话消息（含 system）。
 * @returns 顶层 system 文本与合并后的轮次。
 */
export function toAnthropicTurns(messages: readonly { readonly role: string; readonly content: string }[]): {
  readonly system: string
  readonly turns: readonly SearchTurn[]
} {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
  const turns: SearchTurn[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const previous = turns[turns.length - 1]
    if (previous !== undefined && previous.role === message.role) {
      turns[turns.length - 1] = { role: previous.role, content: `${previous.content}\n\n${message.content}` }
      continue
    }
    turns.push({ role: message.role, content: message.content })
  }
  return { system, turns }
}

/**
 * 构造一次搜索请求的请求体。
 * @param options - 模型、消息、上限。
 * @returns 可直接 `JSON.stringify` 的请求体。
 */
export function searchRequestBody(options: {
  readonly model: string
  readonly messages: readonly { readonly role: string; readonly content: string }[]
  readonly maxTokens?: number
  readonly maxUses?: number
}): SearchRequestBody {
  const { system, turns } = toAnthropicTurns(options.messages)
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? SEARCH_MAX_TOKENS,
    system,
    messages: turns,
    tools: [searchTool(options.maxUses ?? SEARCH_MAX_USES)],
    stream: true,
  }
}

/** 端点上要带的请求头；同时给 `x-api-key` 与 `Bearer`，官方与兼容网关都能认。 */
export function searchHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'authorization': `Bearer ${apiKey}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
  }
}
