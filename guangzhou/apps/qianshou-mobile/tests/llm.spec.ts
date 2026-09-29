/**
 * 手机端 LLM 调用层与存储层的契约测试。
 *
 * 流式测试跑在**真实的 node:http 服务端**上（不是 fetch 打桩）：SSE 分帧、跨 chunk
 * 的半行拼接、`[DONE]` 终止、非 200 分类，都必须在真实 socket 上验证——打桩会把
 * 这些边界全绕过去，而那正是最容易出错的地方。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChatFailure, FAILURE_COPY, classifyStatus, completionsUrl, parseSseLine, streamChat, PROVIDER_TEMPLATES,
} from '../src/llm.ts'

/** 一次真实往返的观测结果。 */
interface Exchange {
  readonly status: number
  readonly deltas: string[]
  readonly error: ChatFailure | null
  readonly done: boolean
  readonly requestBody: string
  readonly authorization: string | undefined
}

/** 起一个真实服务端，按给定分片逐段写 SSE，然后收流。 */
async function exchange(
  chunks: readonly string[],
  options: {
    status?: number
    splitEveryByte?: boolean
    omitDone?: boolean
    /** 整段响应体原样发出（不走 SSE 分帧）；用来模拟"忽略 stream 参数"的网关。 */
    raw?: string
    /** 配 `raw` 用的 content-type；默认按普通 JSON。 */
    contentType?: string
    /** 结尾不带换行：逼出"最后一行留在缓冲里"这条路径。 */
    noTrailingNewline?: boolean
  } = {},
): Promise<Exchange> {
  let requestBody = ''
  let authorization: string | undefined
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    authorization = request.headers.authorization
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      requestBody = Buffer.concat(parts).toString('utf8')
      if (options.status !== undefined && options.status !== 200) {
        response.writeHead(options.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'denied' }))
        return
      }
      if (options.raw !== undefined) {
        response.writeHead(200, { 'content-type': options.contentType ?? 'application/json' })
        response.end(options.raw)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const payload = chunks.join('')
      if (options.splitEveryByte === true) {
        // 逐字节写：逼出"跨 chunk 的半行"这条路径。
        let index = 0
        const tick = setInterval(() => {
          if (index >= payload.length) { clearInterval(tick); response.end(); return }
          response.write(payload.slice(index, index + 1))
          index += 1
        }, 1)
        return
      }
      if (options.noTrailingNewline === true) {
        // 去掉末尾换行：这样最后一条 `data:` 会留在客户端缓冲区里，
        // 只有"收流后再冲一次缓冲"的实现才拿得到它。
        response.write(payload.replace(/\n+$/, ''))
        response.end()
        return
      }
      for (const chunk of chunks) response.write(chunk)
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得测试服务端口')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`

  const deltas: string[] = []
  let error: ChatFailure | null = null
  let done = false
  try {
    const stream = streamChat(
      { baseUrl, apiKey: 'test-key', model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
      { onDelta: text => deltas.push(text), onDone: () => { done = true }, onError: (failure) => { error = failure } },
    )
    await stream.completed
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  return { status: options.status ?? 200, deltas, error, done, requestBody, authorization }
}

/** 构造一行 SSE。 */
function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

const servers: Server[] = []
afterEach(() => { for (const s of servers) s.close() })

describe('端点在 OpenAI 兼容路径上', () => {
  it('根地址拼出 /chat/completions', () => {
    expect(completionsUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('末尾多余的斜杠不会拼出双斜杠', () => {
    expect(completionsUrl('https://example.test/v1///')).toBe('https://example.test/v1/chat/completions')
  })
})

describe('SSE 行解析', () => {
  it('取出 delta 文本', () => {
    expect(parseSseLine(sse('你好').trim())).toEqual({ delta: '你好' })
  })

  it('[DONE] 表示流结束', () => {
    expect(parseSseLine('data: [DONE]')).toEqual({ done: true })
  })

  it('注释行与心跳被忽略，而不是中断整个流', () => {
    expect(parseSseLine(': keep-alive')).toBeNull()
    expect(parseSseLine('data: not-json')).toBeNull()
  })

  it('空 delta 不产生一次空更新', () => {
    expect(parseSseLine('data: {"choices":[{"delta":{}}]}')).toBeNull()
  })
})

describe('状态码分类', () => {
  it('鉴权失败与余额不足分开', () => {
    expect(classifyStatus(401)).toBe('unauthorized')
    expect(classifyStatus(403)).toBe('unauthorized')
    expect(classifyStatus(402)).toBe('insufficient-balance')
    expect(classifyStatus(429)).toBe('rate-limited')
    expect(classifyStatus(503)).toBe('server-error')
    expect(classifyStatus(400)).toBe('invalid-response')
  })

  it('每个原因都有面向用户的说明，且都是中文', () => {
    for (const kind of Object.keys(FAILURE_COPY)) {
      const copy = FAILURE_COPY[kind as keyof typeof FAILURE_COPY]
      expect(copy.trim().length, kind).toBeGreaterThan(0)
      expect(copy, kind).toMatch(/[\u4e00-\u9fff]/)
    }
  })
})

describe('真实流式往返', () => {
  it('多个分片的增量按序到达且标记完成', async () => {
    const result = await exchange([sse('你'), sse('好'), 'data: [DONE]\n\n'])
    expect(result.deltas.join('')).toBe('你好')
    expect(result.done).toBe(true)
    expect(result.error).toBeNull()
  })

  it('逐字节到达时半行被正确拼接', async () => {
    const result = await exchange([sse('跨'), sse('块'), 'data: [DONE]\n\n'], { splitEveryByte: true })
    expect(result.deltas.join('')).toBe('跨块')
    expect(result.done).toBe(true)
  })

  it('服务商不发 [DONE] 就断流时仍然结束，不会悬挂', async () => {
    const result = await exchange([sse('半')], { omitDone: true })
    expect(result.deltas.join('')).toBe('半')
    expect(result.done).toBe(true)
  })

  it('末尾没有换行时最后一行也要吐出来，不能停在缓冲里', async () => {
    const result = await exchange([sse('开头'), sse('结尾')], { omitDone: true, noTrailingNewline: true })
    expect(result.deltas.join('')).toBe('开头结尾')
  })

  it('网关忽略 stream 参数、回了一整份 JSON：正文照样上屏', async () => {
    // 这条以前会静默丢掉：`parseSseLine` 只认 `data:` 开头的行，
    // 结果是流正常结束、界面一片空白，用户只看到转圈。
    const body = JSON.stringify({ choices: [{ message: { content: '这是非流式的回答' } }] })
    const result = await exchange([], { raw: body })
    expect(result.deltas.join('')).toBe('这是非流式的回答')
    expect(result.done).toBe(true)
    expect(result.error).toBeNull()
  })

  it('网关把错误塞在 200 的响应体里：说出来，而不是当成空回复', async () => {
    const body = JSON.stringify({ error: { message: 'model not found' } })
    const result = await exchange([], { raw: body })
    expect(result.error?.kind).toBe('invalid-response')
    expect(result.error?.message).toContain('model not found')
  })

  it('整条流一个字都没有时给的是能动手的提示，带上真实的 content-type', async () => {
    const result = await exchange([], { raw: '', contentType: 'application/json' })
    expect(result.error?.kind).toBe('invalid-response')
    expect(result.error?.message).toContain('application/json')
    expect(result.done).toBe(false)
  })

  it('服务商回了空回复（有 [DONE] 但没内容）：明确报错，不停在"已回复"', async () => {
    const result = await exchange(['data: [DONE]\n\n'])
    expect(result.error?.kind).toBe('invalid-response')
    expect(result.deltas).toHaveLength(0)
  })

  it('请求带上 Bearer 凭据与模型名', async () => {
    const result = await exchange([sse('x'), 'data: [DONE]\n\n'])
    expect(result.authorization).toBe('Bearer test-key')
    const body = JSON.parse(result.requestBody) as { model: string; stream: boolean }
    expect(body.model).toBe('test-model')
    expect(body.stream).toBe(true)
  })

  it('401 被翻译成"密钥被拒绝"，不泄露服务商原文', async () => {
    const result = await exchange([], { status: 401 })
    expect(result.error?.kind).toBe('unauthorized')
    expect(result.error?.message).toBe(FAILURE_COPY.unauthorized)
    expect(result.error?.status).toBe(401)
  })

  it('402 被翻译成"余额不足"', async () => {
    const result = await exchange([], { status: 402 })
    expect(result.error?.kind).toBe('insufficient-balance')
  })
})

describe('内置模板', () => {
  it('模板里没有任何密钥字段', () => {
    for (const template of Object.values(PROVIDER_TEMPLATES)) {
      expect(JSON.stringify(template)).not.toMatch(/sk-|apiKey|api_key|secret/i)
    }
  })

  it('DeepSeek 模板指向官方端点并给出默认模型', () => {
    expect(PROVIDER_TEMPLATES.deepseek?.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(PROVIDER_TEMPLATES.deepseek?.defaultModel).toBe('deepseek-chat')
  })
})
