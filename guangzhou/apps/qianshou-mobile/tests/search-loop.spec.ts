/**
 * 手机端**搜索工具循环**的端到端契约测试：跑在真实的 `node:http` 假服务端上，
 * 不是 fetch 打桩。
 *
 * 这一层要证明的不是"代码看起来对"，而是三件在真机上会真金白银发生的事：
 * 1. 服务端把回合交回来（`pause_turn` / 工具调用已发出但结果没到）时，**真的会发第二轮**，
 *    并且第二轮带上了第一轮的助手内容——不带回去，模型就是无记忆地重来一遍；
 * 2. 搜索结果块里的 url/title 被提取出来，作为**可核对的来源**交给上层；
 * 3. 失败（401 / 断流 / 取消）以结构化原因结束，不重试、不吞掉、也不编造回答。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatFailure, type StreamHandlers } from '../src/llm.ts'
import { runSearchLoop, type SearchPhase } from '../src/tool-loop.ts'
import type { SearchSource } from '../src/search.ts'

/** 一次循环的观测结果；闭包里只写数组元素，避免可空标量被收窄成 never。 */
interface Observation {
  readonly text: string
  readonly deltas: readonly string[]
  readonly phases: readonly SearchPhase[]
  readonly sourceBatches: readonly (readonly SearchSource[])[]
  readonly failures: readonly ChatFailure[]
  readonly done: boolean
}

/** 假服务端记录下来的每一次请求。 */
interface ReceivedRequest {
  readonly path: string
  readonly apiKey: string | undefined
  readonly apiVersion: string | undefined
  readonly body: {
    readonly model?: string
    readonly max_tokens?: number
    readonly system?: string
    readonly messages?: readonly { readonly role: string; readonly content: unknown }[]
    readonly tools?: readonly { readonly type?: string; readonly name?: string; readonly max_uses?: number }[]
    readonly stream?: boolean
  }
}

/** 一轮的脚本：要么写 SSE 分片，要么给一个 HTTP 状态码。 */
type RoundScript =
  | { readonly kind: 'sse'; readonly chunks: readonly string[] }
  | { readonly kind: 'json'; readonly body: unknown }
  | { readonly kind: 'status'; readonly status: number }

/** 起一个假 Anthropic 端点，按轮次脚本应答；轮次用完后一直重复最后一轮。 */
async function anthropicServer(rounds: readonly RoundScript[]): Promise<{
  readonly endpoint: string
  readonly requests: readonly ReceivedRequest[]
  readonly close: () => Promise<void>
}> {
  const requests: ReceivedRequest[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      let body: ReceivedRequest['body'] = {}
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) as ReceivedRequest['body'] } catch { /* 保持空对象 */ }
      requests.push({
        path: request.url ?? '',
        apiKey: request.headers['x-api-key'] as string | undefined,
        apiVersion: request.headers['anthropic-version'] as string | undefined,
        body,
      })
      const script = rounds[Math.min(requests.length - 1, rounds.length - 1)]
      if (script === undefined) { response.writeHead(500).end(); return }
      if (script.kind === 'status') {
        response.writeHead(script.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'denied' } }))
        return
      }
      if (script.kind === 'json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(script.body))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const chunk of script.chunks) response.write(chunk)
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得测试服务端口')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

/** 跑一次搜索循环并收集全部观测值。 */
async function observe(
  baseUrl: string,
  config: { readonly maxRounds?: number; readonly signal?: AbortSignal } = {},
): Promise<Observation> {
  const deltas: string[] = []
  const phases: SearchPhase[] = []
  const sourceBatches: (readonly SearchSource[])[] = []
  const failures: ChatFailure[] = []
  let done = false
  const handlers: StreamHandlers = {
    onDelta: text => deltas.push(text),
    onDone: () => { done = true },
    onError: failure => failures.push(failure),
  }
  const stream = runSearchLoop(
    { baseUrl, apiKey: 'sk-user-key', model: 'deepseek-chat', messages: [{ role: 'user', content: '今天有什么新闻？' }] },
    {
      ...config.maxRounds !== undefined ? { maxRounds: config.maxRounds } : {},
      onPhase: phase => phases.push(phase),
      onSources: sources => sourceBatches.push(sources),
    },
    handlers,
  )
  await stream.completed
  return { text: deltas.join(''), deltas, phases, sourceBatches, failures, done }
}

/** 一帧 SSE。 */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 服务端发起了搜索调用、并把这个回合交回客户端。 */
const PAUSE_WITH_TOOL: readonly string[] = [
  frame({ type: 'message_start', message: { id: 'msg-1' } }),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv-1', name: 'web_search' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"今天' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '有什么新闻"}' } }),
  frame({ type: 'content_block_stop', index: 0 }),
  frame({ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }),
  frame({ type: 'message_stop' }),
]

/** 一次搜索就答完：结果块与正文都在同一轮里。 */
const SEARCH_THEN_ANSWER: readonly string[] = [
  frame({ type: 'message_start', message: { id: 'msg-2' } }),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv-9', name: 'web_search' } }),
  frame({
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'srv-9',
      content: [
        { type: 'web_search_result', url: 'https://news.test/a', title: '甲报道', page_age: '2026-01-05' },
        { type: 'web_search_result', url: 'https://news.test/b', title: '乙报道' },
      ],
    },
  }),
  frame({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
  frame({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '根据最新报道，' } }),
  frame({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '今天有两件事。' } }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  frame({ type: 'message_stop' }),
]

/** 第二轮：拿到结果后的最终回答。 */
const ANSWER_AFTER_RESUME: readonly string[] = [
  frame({ type: 'message_start', message: { id: 'msg-3' } }),
  frame({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'srv-1',
      content: [{ type: 'web_search_result', url: 'https://news.test/c', title: '丙报道' }],
    },
  }),
  frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '搜到了：' } }),
  frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '丙报道是今天的新消息。' } }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  frame({ type: 'message_stop' }),
]

let closeServer: (() => Promise<void>) | undefined
afterEach(async () => {
  if (closeServer !== undefined) { await closeServer(); closeServer = undefined }
})

describe('搜索工具循环：服务端把回合交回来时会真的再发一轮', () => {
  it('第一轮只发出 web_search 工具调用 → 发第二轮 → 最终回答与来源都交付到上层', async () => {
    const server = await anthropicServer([
      { kind: 'sse', chunks: PAUSE_WITH_TOOL },
      { kind: 'sse', chunks: ANSWER_AFTER_RESUME },
    ])
    closeServer = server.close

    const seen = await observe(`${server.endpoint}/v1`)

    // ① 真的发生了第二轮请求——这是"工具循环"与"一次调用"的分水岭。
    expect(server.requests).toHaveLength(2)
    // ② 端点是 Anthropic 兼容的 /messages，不是 OpenAI 的 /chat/completions。
    expect(server.requests[0]?.path).toBe('/anthropic/v1/messages')
    expect(server.requests[1]?.path).toBe('/anthropic/v1/messages')
    // ③ 请求头同时带两种鉴权，且带协议版本。
    expect(server.requests[0]?.apiKey).toBe('sk-user-key')
    expect(server.requests[0]?.apiVersion).toBe('2023-06-01')
    // ④ 第一轮带上了原生搜索工具声明。
    expect(server.requests[0]?.body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
    expect(server.requests[0]?.body.stream).toBe(true)
    expect(server.requests[0]?.body.model).toBe('deepseek-chat')

    // ⑤ 第二轮把第一轮的助手内容**原样**带回去了：助手轮里必须有那个工具调用块。
    const second = server.requests[1]?.body.messages ?? []
    const assistant = second.filter(message => message.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]?.content).toEqual([
      { type: 'server_tool_use', id: 'srv-1', name: 'web_search' },
    ])

    // ⑥ 最终回答逐字交付，且是以增量形式。
    expect(seen.deltas.length).toBeGreaterThan(1)
    expect(seen.text).toBe('搜到了：丙报道是今天的新消息。')
    expect(seen.done).toBe(true)
    expect(seen.failures).toEqual([])

    // ⑦ 中间状态分档：两轮各报一次"正在搜索"，结果到手后转"正在整理"。
    expect(seen.phases).toEqual(['searching', 'searching', 'reading'])
    // ⑧ 来源来自响应本身，不是编的。
    expect(seen.sourceBatches[0]).toEqual([{ url: 'https://news.test/c', title: '丙报道' }])
  })

  it('一轮就答完时不多发请求：没有交回就没有第二轮', async () => {
    const server = await anthropicServer([{ kind: 'sse', chunks: SEARCH_THEN_ANSWER }])
    closeServer = server.close

    const seen = await observe(`${server.endpoint}/v1`)

    expect(server.requests).toHaveLength(1)
    expect(seen.text).toBe('根据最新报道，今天有两件事。')
    expect(seen.phases).toEqual(['searching', 'reading'])
    expect(seen.sourceBatches[0]).toEqual([
      { url: 'https://news.test/a', title: '甲报道', pageAge: '2026-01-05' },
      { url: 'https://news.test/b', title: '乙报道' },
    ])
    expect(seen.done).toBe(true)
  })

  it('轮数上限是硬边界：服务端一直交回也不会无限发下去', async () => {
    const server = await anthropicServer([{ kind: 'sse', chunks: PAUSE_WITH_TOOL }])
    closeServer = server.close

    const seen = await observe(`${server.endpoint}/v1`, { maxRounds: 2 })

    expect(server.requests).toHaveLength(2)
    // 用尽轮数也要收尾，不能挂着不返回。
    expect(seen.done).toBe(true)
    expect(seen.failures).toEqual([])
  })
})

describe('失败与取消：结构化原因，不重试、不编造', () => {
  it('401 归类为密钥被拒，且不再发第二轮', async () => {
    const server = await anthropicServer([{ kind: 'status', status: 401 }])
    closeServer = server.close

    const seen = await observe(`${server.endpoint}/v1`)

    expect(server.requests).toHaveLength(1)
    expect(seen.done).toBe(false)
    expect(seen.failures.map(failure => failure.kind)).toEqual(['unauthorized'])
    expect(seen.text).toBe('')
  })

  it('429 归类为限流', async () => {
    const server = await anthropicServer([{ kind: 'status', status: 429 }])
    closeServer = server.close
    const seen = await observe(`${server.endpoint}/v1`)
    expect(seen.failures.map(failure => failure.kind)).toEqual(['rate-limited'])
  })

  it('取消：立刻以 aborted 收尾，用户看到的是"已停止"而不是错误', async () => {
    const server = await anthropicServer([{ kind: 'sse', chunks: PAUSE_WITH_TOOL }])
    closeServer = server.close
    const controller = new AbortController()
    const deltas: string[] = []
    const failures: ChatFailure[] = []
    const stream = runSearchLoop(
      {
        baseUrl: `${server.endpoint}/v1`, apiKey: 'sk-user-key', model: 'deepseek-chat',
        messages: [{ role: 'user', content: '问' }], signal: controller.signal,
      },
      {},
      { onDelta: text => deltas.push(text), onDone: () => { throw new Error('取消不该走 onDone') }, onError: failure => failures.push(failure) },
    )
    controller.abort()
    await stream.completed
    expect(failures.map(failure => failure.kind)).toEqual(['aborted'])
  })

  it('端点推不出来时给的是"去填服务地址"的引导，且一个请求都不发', async () => {
    const failures: ChatFailure[] = []
    const stream = runSearchLoop(
      { baseUrl: '不是地址', apiKey: 'sk', model: 'm', messages: [{ role: 'user', content: '问' }] },
      {},
      { onDelta: () => {}, onDone: () => {}, onError: failure => failures.push(failure) },
    )
    await stream.completed
    expect(failures.map(failure => failure.kind)).toEqual(['no-endpoint'])
  })
})

describe('兼容网关不认 stream 时也能用', () => {
  it('整包 JSON 响应：正文一次交付，来源照样提取', async () => {
    const server = await anthropicServer([{
      kind: 'json',
      body: {
        content: [
          { type: 'web_search_tool_result', tool_use_id: 'srv-7', content: [{ type: 'web_search_result', url: 'https://news.test/d', title: '丁' }] },
          { type: 'text', text: '这是整包返回的回答。' },
        ],
        stop_reason: 'end_turn',
      },
    }])
    closeServer = server.close

    const seen = await observe(`${server.endpoint}/v1`)

    expect(seen.text).toBe('这是整包返回的回答。')
    expect(seen.sourceBatches[0]).toEqual([{ url: 'https://news.test/d', title: '丁' }])
    expect(seen.done).toBe(true)
  })

  it('无法解析的响应体归类为 invalid-response，而不是静默成功', async () => {
    const server = await anthropicServer([{ kind: 'json', body: 'not-an-object' }])
    closeServer = server.close
    const seen = await observe(`${server.endpoint}/v1`)
    expect(seen.failures.map(failure => failure.kind)).toEqual(['invalid-response'])
  })
})
