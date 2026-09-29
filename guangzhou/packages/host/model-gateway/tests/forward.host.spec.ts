/**
 * 转发层的契约测试。
 *
 * 跑在**真实 node:http 服务端**上而不是打桩 fetch：SSE 分帧、跨 chunk 的半行、
 * 末尾无换行的最后一帧、服务商忽略 stream 参数回整包——这些边界打桩全绕过去了，
 * 而那正是「流正常结束但界面空白」这类问题的来源。
 *
 * 本文件**不碰真实模型服务商**：所有请求都打到本机随机端口。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  FORWARD_COPY,
  classifyForwardStatus,
  forwardStream,
  parseWholeResponse,
  type ForwardFailure,
  type ProviderUsage,
} from '../src/forward.ts'

/** 一次转发的观测结果。 */
interface Observed {
  readonly deltas: string[]
  readonly usage: ProviderUsage | null
  readonly error: ForwardFailure | null
  readonly requestBody: string
  readonly authorization: string | undefined
}

/**
 * 起一个假服务商。
 * @param options - 分片、状态码、内容类型与原始响应体。
 * @returns 观测结果与请求体。
 */
async function exchange(options: {
  readonly chunks?: readonly string[]
  readonly status?: number
  readonly raw?: string
  readonly contentType?: string
  /** 每个字节单独写，逼出「跨 chunk 的半行」。 */
  readonly byteByByte?: boolean
  /** 密钥：可以直接给值，也可以给一个（可能异步的）工厂来模拟凭据服务。 */
  readonly apiKey?: string | null | (() => string | null | Promise<string | null>)
} = {}): Promise<Observed> {
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
        response.end(JSON.stringify({ error: { message: 'denied' } }))
        return
      }
      response.writeHead(200, { 'content-type': options.contentType ?? 'text/event-stream' })
      if (options.raw !== undefined) { response.end(options.raw); return }
      const payload = (options.chunks ?? []).join('')
      if (options.byteByByte === true) {
        let index = 0
        const tick = setInterval(() => {
          if (index >= payload.length) { clearInterval(tick); response.end(); return }
          response.write(payload.slice(index, index + 1))
          index += 1
        }, 1)
        return
      }
      response.end(payload)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得测试端口')

  const deltas: string[] = []
  // 收结果用对象：`let usage`/`let error` 只在回调里赋值，TS 会在读取处把它们收窄成 `null`。
  const captured: { usage: ProviderUsage | null; error: ForwardFailure | null } = { usage: null, error: null }
  /**
   * 密钥选项先取到局部常量：在闭包里读 `options.apiKey` 会丢掉 `undefined` 的收窄，
   * 三元表达式于是推断成"可能是函数也可能是字符串"的联合，接不上 `apiKey` 的签名。
   */
  const apiKeyOption = options.apiKey
  try {
    const stream = forwardStream(
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: typeof apiKeyOption === 'function'
          ? apiKeyOption
          : () => (apiKeyOption === undefined ? 'test-key' : apiKeyOption),
      },
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 128 },
      {
        onDelta: (text) => { deltas.push(text) },
        onDone: (value) => { captured.usage = value },
        onError: (failure) => { captured.error = failure },
      },
    )
    await stream.completed
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  return { deltas, usage: captured.usage, error: captured.error, requestBody, authorization }
}

/** 构造一帧 SSE。 */
function frame(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`
}
/** 一帧正文。 */
function delta(content: string): string {
  return frame({ choices: [{ delta: { content } }] })
}
/** 一帧用量。 */
function usageFrame(prompt: number, completion: number): string {
  return frame({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })
}

describe('流式转发', () => {
  it('逐帧的增量按到达顺序交给调用方', async () => {
    const result = await exchange({ chunks: [delta('你'), delta('好'), 'data: [DONE]\n\n'] })
    expect(result.deltas).toEqual(['你', '好'])
    expect(result.error).toBeNull()
  })

  it('逐字节到达时半行被正确拼接（真实 socket 才会有的边界）', async () => {
    const result = await exchange({ chunks: [delta('跨'), delta('块'), 'data: [DONE]\n\n'], byteByByte: true })
    expect(result.deltas.join('')).toBe('跨块')
    expect(result.error).toBeNull()
  })

  it('末尾没有换行时最后一帧也要取到（否则丢最后几个字）', async () => {
    const raw = `${delta('开头')}${delta('结尾')}`.trimEnd()
    const result = await exchange({ raw })
    expect(result.deltas.join('')).toBe('开头结尾')
  })

  it('权威用量来自最后一帧', async () => {
    const result = await exchange({ chunks: [delta('答'), usageFrame(1234, 567), 'data: [DONE]\n\n'] })
    expect(result.usage).toEqual({ promptTokens: 1234, completionTokens: 567 })
  })

  it('服务商不给用量时回零，**不自己按字符数瞎估**（中文会被低估约 4 倍）', async () => {
    const result = await exchange({ chunks: [delta('没有用量的回答'), 'data: [DONE]\n\n'] })
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 })
  })
})

describe('服务商忽略 stream 参数（回整包 JSON）', () => {
  it('整包 JSON 的正文照样交给调用方，而不是流正常结束却一个字都没有', async () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: '这是非流式的回答' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    })
    const result = await exchange({ raw, contentType: 'application/json' })
    expect(result.deltas.join('')).toBe('这是非流式的回答')
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20 })
    expect(result.error).toBeNull()
  })

  it('整包 JSON 里没有用量时回零，由调用方补估', async () => {
    const raw = JSON.stringify({ choices: [{ message: { content: '答' } }] })
    const result = await exchange({ raw, contentType: 'application/json' })
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 })
  })

  it('空响应被判为无法识别，而不是当成空回答', async () => {
    const result = await exchange({ raw: '' })
    expect(result.error?.kind).toBe('invalid-response')
  })
})

describe('请求形状与失败分类', () => {
  it('请求带上 Bearer 密钥、输出上限与 include_usage', async () => {
    const result = await exchange({ chunks: [delta('x'), 'data: [DONE]\n\n'] })
    expect(result.authorization).toBe('Bearer test-key')
    const body = JSON.parse(result.requestBody) as { model: string; max_tokens: number; stream: boolean; stream_options?: unknown }
    expect(body.model).toBe('deepseek-flash')
    expect(body.max_tokens).toBe(128)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('没配密钥时不发请求，直接给「服务不可用」', async () => {
    const result = await exchange({ chunks: [delta('x')], apiKey: null })
    expect(result.error?.kind).toBe('not-configured')
    expect(result.error?.message).toBe(FORWARD_COPY['not-configured'])
    // 没发请求：请求体是空的
    expect(result.requestBody).toBe('')
  })

  it('状态码分类：401/403 密钥、402 余额、429 限流、5xx 服务商、其余无法识别', () => {
    expect(classifyForwardStatus(401)).toBe('unauthorized')
    expect(classifyForwardStatus(403)).toBe('unauthorized')
    expect(classifyForwardStatus(402)).toBe('insufficient-balance')
    expect(classifyForwardStatus(429)).toBe('rate-limited')
    expect(classifyForwardStatus(500)).toBe('server-error')
    expect(classifyForwardStatus(400)).toBe('invalid-response')
  })

  it('失败时给的是面向用户的中文，且不带服务商原文', async () => {
    const result = await exchange({ status: 429 })
    expect(result.error?.kind).toBe('rate-limited')
    expect(result.error?.message).toBe(FORWARD_COPY['rate-limited'])
    expect(result.error?.message).not.toContain('denied')
    expect(result.error?.status).toBe(429)
  })
})

describe('整包解析（不依赖网络的纯函数）', () => {
  it('标准 OpenAI 形状', () => {
    const parsed = parseWholeResponse(JSON.stringify({
      choices: [{ message: { content: '正文' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    }))
    expect(parsed.content).toBe('正文')
    expect(parsed.usage).toEqual({ promptTokens: 1, completionTokens: 2 })
  })

  it('不是 JSON 时按纯文本用', () => {
    expect(parseWholeResponse('就是一段话').content).toBe('就是一段话')
  })

  it('空串返回空', () => {
    expect(parseWholeResponse('   ')).toEqual({ content: '', usage: null })
  })
})

describe('密钥来源可以是异步的（首次请求必须等它）', () => {
  it('凭据服务延迟返回时，请求会等密钥而不是空手发出去', async () => {
    // 复现那个真实缺陷：早期版本为迁就同步签名，同步返回环境变量兜底，
    // 结果密钥明明配在凭据服务里，**第一次请求**却是"服务暂时不可用"。
    let resolved = false
    const { deltas, error, authorization } = await exchange({
      chunks: [delta('好')],
      // 模拟凭据服务的异步解析：一个 tick 之后才有值。
      apiKey: async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        resolved = true
        return 'key-from-async-store'
      },
    })
    expect(resolved).toBe(true)
    expect(error).toBeNull()
    expect(deltas.join('')).toBe('好')
    // 发出去的必须是**异步解析出来的那把**，而不是任何兜底值。
    expect(authorization).toBe('Bearer key-from-async-store')
  })

  it('异步解析返回 null 时如实报"服务不可用"，不空手发请求', async () => {
    const { error, authorization } = await exchange({
      chunks: [delta('好')],
      apiKey: async () => null,
    })
    // 服务商**一次请求都不该收到**——没有密钥就没有请求可发。
    expect(authorization).toBeUndefined()
    expect(error?.kind).toBe('not-configured')
  })

  it('同步返回仍然照常工作（不强迫所有调用方改异步）', async () => {
    const { deltas, error, authorization } = await exchange({ chunks: [delta('好')], apiKey: () => 'sync-key' })
    expect(error).toBeNull()
    expect(deltas.join('')).toBe('好')
    expect(authorization).toBe('Bearer sync-key')
  })
})

describe('超时语义：空闲才中止，正在输出就不中止', () => {
  /** 一个"先吐一块、随后静默"的上游。 */
  async function stalledServer(): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
    const server: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(delta('开始'))
      // 之后什么都不发，也不断开——真实上游偶发挂起就是这样。
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('未能取得测试端口')
    return {
      port: address.port,
      close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
    }
  }

  it('上游静默挂起时，空闲超时把它中止，并交回已收到的正文', async () => {
    const server = await stalledServer()
    const deltas: string[] = []
    // 收失败用对象：`let failure` 只在回调里赋值，TS 会在读取处把它收窄成 `null`
    // （于是 `failure?.kind` 报 "does not exist on type 'never'"）。详见 `service.host.spec.ts`。
    const captured: { failure: ForwardFailure | null } = { failure: null }
    const started = Date.now()
    try {
      const stream = forwardStream(
        { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: () => 'k', timeoutMs: 300 },
        { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 128 },
        {
          onDelta: (text) => { deltas.push(text) },
          onDone: () => { /* 这一幕不会正常收尾 */ },
          onError: (value) => { captured.failure = value },
        },
      )
      await stream.completed
    } finally {
      await server.close()
    }
    const elapsed = Date.now() - started
    expect(captured.failure?.kind).toBe('unreachable')
    // 已经流出去的字要交回——用户看到的那半截话不是幻觉。
    expect(deltas.join('')).toBe('开始')
    // 且**必须**在空闲超时附近结束，而不是等一个两分钟的总时长。
    expect(elapsed).toBeLessThan(3000)
  })

  it('**正在输出的长回答不会被超时误杀**（这是"空闲"而非"总时长"的意义）', async () => {
    // 上游持续吐字，每 120ms 一块，共 8 块 ≈ 960ms；
    // 空闲超时设 400ms：只要计时被每次数据重置，这次就不会被中止。
    const server: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let sent = 0
      const tick = setInterval(() => {
        if (sent >= 8) { clearInterval(tick); response.end('data: [DONE]\n\n'); return }
        response.write(delta('字'))
        sent += 1
      }, 120)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('未能取得测试端口')

    const deltas: string[] = []
    let failure: ForwardFailure | null = null
    let finished = false
    try {
      const stream = forwardStream(
        { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: () => 'k', timeoutMs: 400 },
        { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 128 },
        { onDelta: text => deltas.push(text), onDone: () => { finished = true }, onError: (value) => { failure = value } },
      )
      await stream.completed
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
    // 总耗时远超空闲超时，但因为一直在输出，所以必须正常完成。
    expect(failure).toBeNull()
    expect(finished).toBe(true)
    expect(deltas.length).toBe(8)
  })

  it('总时长硬上限仍然存在（防止连接被无限占住）', async () => {
    const server = await stalledServer()
    const captured: { failure: ForwardFailure | null } = { failure: null }
    const started = Date.now()
    try {
      const stream = forwardStream(
        // 空闲超时给得很长，总时长给得很短：验证是总时长这道闸先起作用。
        { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: () => 'k', timeoutMs: 60_000, totalTimeoutMs: 300 },
        { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 128 },
        {
          onDelta: () => { /* 这一幕不会有正文 */ },
          onDone: () => { /* 同样不会正常收尾 */ },
          onError: (value) => { captured.failure = value },
        },
      )
      await stream.completed
    } finally {
      await server.close()
    }
    expect(captured.failure?.kind).toBe('unreachable')
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
