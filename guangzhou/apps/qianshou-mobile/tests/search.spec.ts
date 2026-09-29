/**
 * 手机端联网搜索的**纯函数层**契约测试：端点推导、请求体形状、SSE 事件解析、来源提取。
 *
 * 为什么这一层值得单独测：它把 Anthropic 兼容协议的**形状**固定下来。形状错了，
 * 真机上只会得到一句"服务商返回了无法解析的内容"，而那时已经花了用户的钱、也花掉了
 * 一次真实的搜索额度。这里毫秒级把每条边界钉死，网络行为交给 `search-loop.spec.ts`。
 */
import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_VERSION,
  SEARCH_MAX_TOKENS,
  SEARCH_MAX_USES,
  parseAnthropicEvent,
  searchHeaders,
  searchRequestBody,
  searchTool,
  sourcesOf,
  supportsWebSearch,
  toAnthropicTurns,
  webSearchEndpoint,
  type ContentBlock,
} from '../src/search.ts'

describe('端点推导：从 OpenAI 兼容地址推出 Anthropic 兼容的 /messages', () => {
  it('官方 DeepSeek 的默认地址与工作台插件的端点完全一致', () => {
    // 权威实现：packages/web/web-search-deepseek/src/provider.ts 的 DEEPSEEK_DEFAULT_BASE_URL
    expect(webSearchEndpoint('https://api.deepseek.com/v1'))
      .toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  it('不带 /v1、已经带 /anthropic 或 /anthropic/v1 都不重复拼接', () => {
    expect(webSearchEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(webSearchEndpoint('https://api.deepseek.com/anthropic'))
      .toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(webSearchEndpoint('https://api.deepseek.com/anthropic/v1'))
      .toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  it('保留网关的路径前缀，只换掉协议那一段', () => {
    expect(webSearchEndpoint('https://gw.test/deepseek/v1'))
      .toBe('https://gw.test/deepseek/anthropic/v1/messages')
    expect(webSearchEndpoint('http://127.0.0.1:18999/v1'))
      .toBe('http://127.0.0.1:18999/anthropic/v1/messages')
  })

  it('结尾斜杠与小写路径都不影响结果', () => {
    expect(webSearchEndpoint('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/anthropic/v1/messages')
  })

  it('地址无法解析时返回 null，而不是拼出一个假端点', () => {
    expect(webSearchEndpoint('')).toBeNull()
    expect(webSearchEndpoint('api.deepseek.com/v1')).toBeNull()
    expect(webSearchEndpoint('随便写的')).toBeNull()
  })
})

describe('服务商支持范围', () => {
  it('只有 DeepSeek 支持：联网搜索是它 Anthropic 兼容接口上的原生服务端工具', () => {
    expect(supportsWebSearch('deepseek')).toBe(true)
    // 其它 OpenAI 兼容服务商没有这个接口；界面必须明说不支持，而不是发一个必然失败的请求。
    expect(supportsWebSearch('custom')).toBe(false)
    expect(supportsWebSearch('openai')).toBe(false)
    expect(supportsWebSearch('')).toBe(false)
  })
})

describe('请求体：与权威实现逐字段对齐', () => {
  it('system 提到顶层，messages 里只剩 user/assistant', () => {
    const body = searchRequestBody({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是千手 AI 助手。' },
        { role: 'user', content: '今天有什么新闻？' },
      ],
    })
    expect(body.system).toBe('你是千手 AI 助手。')
    expect(body.messages).toEqual([{ role: 'user', content: '今天有什么新闻？' }])
    expect(body.model).toBe('deepseek-chat')
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(SEARCH_MAX_TOKENS)
  })

  it('相邻同角色消息合并：Anthropic 要求 user/assistant 交替，而本机历史可能连着两条', () => {
    const { turns } = toAnthropicTurns([
      { role: 'user', content: '第一条' },
      { role: 'user', content: '第二条' },
      { role: 'assistant', content: '回答' },
      { role: 'assistant', content: '补充' },
    ])
    expect(turns).toEqual([
      { role: 'user', content: '第一条\n\n第二条' },
      { role: 'assistant', content: '回答\n\n补充' },
    ])
  })

  it('工具声明就是原生 web_search_20250305，max_uses 可调', () => {
    expect(searchTool()).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_MAX_USES })
    const body = searchRequestBody({ model: 'm', messages: [], maxUses: 2 })
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }])
  })

  it('请求头同时给 x-api-key 与 Bearer：官方与兼容网关各认一种', () => {
    const headers = searchHeaders('sk-user-key')
    expect(headers['x-api-key']).toBe('sk-user-key')
    expect(headers['authorization']).toBe('Bearer sk-user-key')
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(ANTHROPIC_VERSION).toBe('2023-06-01')
  })
})

describe('SSE 事件解析', () => {
  it('文本增量', () => {
    const line = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}'
    expect(parseAnthropicEvent(line)).toEqual({ type: 'content_block_delta', index: 0, text: '你好' })
  })

  it('搜索工具调用块', () => {
    const line = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv-1","name":"web_search"}}'
    expect(parseAnthropicEvent(line)).toEqual({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'server_tool_use', id: 'srv-1', name: 'web_search' },
    })
  })

  it('搜索结果块：url 为空或类型不对的条目被丢掉，而不是变成一条假来源', () => {
    const line = 'data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result",'
      + '"tool_use_id":"srv-1","content":['
      + '{"type":"web_search_result","url":"https://a.test/x","title":"甲","page_age":"2026-01-02"},'
      + '{"type":"web_search_result","url":""},'
      + '{"type":"other","url":"https://b.test/y"},'
      + '{"type":"web_search_result","url":"https://c.test/z"}'
      + ']}}'
    const event = parseAnthropicEvent(line)
    expect(event?.type).toBe('content_block_start')
    if (event?.type !== 'content_block_start') throw new Error('事件类型不对')
    expect(event.contentBlock).toEqual({
      type: 'web_search_tool_result',
      tool_use_id: 'srv-1',
      content: [
        { type: 'web_search_result', url: 'https://a.test/x', title: '甲', pageAge: '2026-01-02' },
        { type: 'web_search_result', url: 'https://c.test/z' },
      ],
    })
  })

  it('结束原因', () => {
    expect(parseAnthropicEvent('data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"}}'))
      .toEqual({ type: 'message_delta', stopReason: 'pause_turn' })
  })

  it('服务端错误事件带着可读原因', () => {
    expect(parseAnthropicEvent('data: {"type":"error","error":{"message":"overloaded"}}'))
      .toEqual({ type: 'error', message: 'overloaded' })
  })

  it('心跳、注释行、半行、非 JSON 一律返回 null：不能让一行噪声中断整条流', () => {
    expect(parseAnthropicEvent('event: content_block_delta')).toBeNull()
    expect(parseAnthropicEvent(': ping')).toBeNull()
    expect(parseAnthropicEvent('data: {"type":"content_block_delta","delta":{"type":"text_del')).toBeNull()
    expect(parseAnthropicEvent('data: [DONE]')).toBeNull()
    expect(parseAnthropicEvent('')).toBeNull()
  })

  it('不认识的块类型退化为 other 块而不抛错：服务端新增块类型不该毁掉整条回复', () => {
    const line = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"future_block","x":1}}'
    expect(parseAnthropicEvent(line)).toEqual({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'future_block' },
    })
  })
})

describe('来源提取', () => {
  const blocks: readonly ContentBlock[] = [
    { type: 'text', text: '正文' },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv-1',
      content: [
        { type: 'web_search_result', url: 'https://a.test/1', title: '甲' },
        { type: 'web_search_result', url: 'https://a.test/1' },
      ],
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv-2',
      content: [{ type: 'web_search_result', url: 'https://b.test/2', title: '乙', pageAge: '2026-01-01' }],
    },
  ]

  it('跨多个结果块去重，顺序按第一次出现', () => {
    expect(sourcesOf(blocks)).toEqual([
      { url: 'https://a.test/1', title: '甲' },
      { url: 'https://b.test/2', title: '乙', pageAge: '2026-01-01' },
    ])
  })

  it('没有结果块时是空数组，不是一条编出来的来源', () => {
    expect(sourcesOf([{ type: 'text', text: '这是没有联网的回答' }])).toEqual([])
  })
})
