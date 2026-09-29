/**
 * 订阅通道的契约测试。
 *
 * 三件事必须被证明，而不是"看起来对"：
 *
 * 1. **协议**：网关的三种帧（`delta` / `done` / `error`）要被正确认出来；没有正文的流、
 *    非 SSE 的响应、被截断的流都要**如实报错**，不能装作完成。
 * 2. **分类**：`error` 帧的 `status` 是机器可读的（402 该付费、429 该等一下、400 请求
 *    本身有问题），客户端必须按它分支，而不是读那句中文去猜。
 * 3. **边界**：非同源时**一个请求都不发**（配对形态下那会把费用记到别的电脑的账号上）；
 *    请求体里没有密钥；模型名只会是前台的名字。
 *
 * 真实往返跑在**真实的 node:http 服务端**上（不是 fetch 打桩）：SSE 分帧、跨 chunk 的
 * 半行、末尾无换行、`[DONE]` 之后的残余，都必须在真 socket 上验证——打桩会把这些边界
 * 全绕过去，而那正是最容易出错的地方（`llm.spec.ts` 用同一套办法验证 BYOK 那条通路）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatFailure, type StreamHandlers } from '../src/llm.ts'
import {
  parseGatewayFrame,
  refuseSubscription,
  streamSubscription,
  subscriptionFailure,
  SUBSCRIPTION_FAILURE_COPY,
  type SubscriptionDone,
  type SubscriptionHandlers,
} from '../src/subscription.ts'
import {
  AI_CHAT_PATH,
  AI_STATUS_PATH,
  DEFAULT_FRONT_MODEL,
  FRONT_MODELS,
  formatSp,
  frontModelsForTier,
  isFrontModel,
  isSubscriptionProvider,
  parseStatusPayload,
  readSubscriptionStatus,
  resolveAiRoute,
  routeBlockReason,
  SUBSCRIPTION_BASE_URL,
  SUBSCRIPTION_PROVIDER_ID,
} from '../src/subscription-model.ts'
import { PROVIDER_TEMPLATES } from '../src/llm.ts'

/** 造一帧网关 SSE。 */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 真正的 fetch。
 *
 * 在**模块加载时**先抓住它：下面会把 `globalThis.fetch` 换成"把相对路径解析到测试服务端"
 * 的替身，替身内部必须调用这一份原始实现，否则会自己调自己（第一版就是这么写成死循环的，
 * 表现为一片 network 失败）。
 */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis)

/** 一次真实往返的观测结果。 */
interface Exchange {
  readonly deltas: string[]
  readonly settled: SubscriptionDone | null
  readonly doneCalls: number
  readonly error: ChatFailure | null
  readonly requestedPath: string
  readonly requestBody: string
  readonly authorization: string | undefined
  readonly cookie: string | undefined
}

/**
 * 起一个真实服务端，按给定分片写 SSE，并用一个把相对路径解析到该服务端的 fetch 收流。
 *
 * 注意这个 fetch 替身**不改变路径**：客户端请求 `/api/qianshou/ai/chat` 就打到同一个
 * 路径上。如果实现改成发一个绝对地址（比如上游的某个域），这里会打到别的 host 而失败——
 * 这正是我们要钉住的边界。
 */
async function exchange(
  chunks: readonly string[],
  options: {
    readonly status?: number
    readonly raw?: string
    readonly contentType?: string
    readonly splitEveryByte?: boolean
    readonly noTrailingNewline?: boolean
    /** 写完分片后**不结束**响应，用来测用户按「停止」。 */
    readonly hang?: boolean
    readonly model?: string
  } = {},
): Promise<Exchange> {
  let requestedPath = ''
  let requestBody = ''
  let authorization: string | undefined
  let cookie: string | undefined
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requestedPath = request.url ?? ''
    authorization = request.headers.authorization
    cookie = request.headers.cookie
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      requestBody = Buffer.concat(parts).toString('utf8')
      if (options.status !== undefined && options.status !== 200) {
        response.writeHead(options.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, message: '请先登录。' }))
        return
      }
      if (options.raw !== undefined) {
        response.writeHead(200, { 'content-type': options.contentType ?? 'application/json' })
        response.end(options.raw)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      const payload = chunks.join('')
      if (options.splitEveryByte === true) {
        let index = 0
        const tick = setInterval(() => {
          if (index >= payload.length) { clearInterval(tick); response.end(); return }
          response.write(payload.slice(index, index + 1))
          index += 1
        }, 1)
        return
      }
      if (options.noTrailingNewline === true) {
        response.write(payload.replace(/\n+$/, ''))
        response.end()
        return
      }
      for (const chunk of chunks) response.write(chunk)
      if (options.hang !== true) response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得测试服务端口')
  const base = `http://127.0.0.1:${address.port}/`
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return await realFetch(new URL(raw, base), init)
  }) as typeof fetch)

  const deltas: string[] = []
  let settled: SubscriptionDone | null = null
  let doneCalls = 0
  let error: ChatFailure | null = null
  const handlers: SubscriptionHandlers = {
    onDelta: text => deltas.push(text),
    onDone: (result) => { settled = result; doneCalls += 1 },
    onError: (failure) => { error = failure },
  }
  try {
    const stream = streamSubscription(
      {
        baseUrl: SUBSCRIPTION_BASE_URL,
        // 这两个字段必须被**忽略**：订阅通路不接受任何密钥，也不看 baseUrl。
        apiKey: 'sk-should-never-be-sent',
        model: options.model ?? DEFAULT_FRONT_MODEL,
        messages: [{ role: 'user', content: '你好' }],
      },
      handlers,
    )
    if (options.hang === true) {
      // 等第一个增量真的到了再中止，否则测的是"还没开始就取消"。
      await vi.waitFor(() => { expect(deltas.length).toBeGreaterThan(0) })
      stream.abort()
    }
    await stream.completed
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  return { deltas, settled, doneCalls, error, requestedPath, requestBody, authorization, cookie }
}

/** 记录请求的 fetch 替身；用来证明"一个请求都没发"。 */
function recordingFetch(respond: (url: string) => Response): { readonly fetch: typeof fetch; readonly urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(raw)
    return respond(raw)
  }) as typeof fetch
  return { fetch: impl, urls }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('网关帧解析', () => {
  it('delta 帧取出增量文本', () => {
    expect(parseGatewayFrame(JSON.stringify({ type: 'delta', text: '你好' }))).toEqual({ type: 'delta', text: '你好' })
  })

  it('空增量不产生一次空更新', () => {
    expect(parseGatewayFrame(JSON.stringify({ type: 'delta', text: '' }))).toBeNull()
    expect(parseGatewayFrame(JSON.stringify({ type: 'delta', text: 42 }))).toBeNull()
  })

  it('done 帧带出模型、降级说明、扣费与剩余点数', () => {
    const parsed = parseGatewayFrame(JSON.stringify({
      type: 'done',
      model: '千手·迅捷',
      requestedModel: '千手·强力',
      chargedSp: 0.07,
      downgraded: true,
      downgradeNote: '「千手·强力」在普通版里用不了，这次由「千手·迅捷」作答。',
      usageSource: 'provider',
      credit: { remainingMonthlySp: 389.93, usedInWindowSp: 0.07 },
    }))
    expect(parsed).toEqual({
      type: 'done',
      model: '千手·迅捷',
      requestedModel: '千手·强力',
      downgraded: true,
      note: '「千手·强力」在普通版里用不了，这次由「千手·迅捷」作答。',
      chargedSp: 0.07,
      remainingSp: 389.93,
    })
  })

  it('done 帧没给 credit 时剩余点数是 null，而不是 0', () => {
    const parsed = parseGatewayFrame(JSON.stringify({ type: 'done', model: '千手·迅捷', requestedModel: '千手·迅捷' }))
    expect(parsed !== null && parsed.type === 'done' ? parsed.remainingSp : 'missing').toBeNull()
  })

  it('error 帧带出机器可读的 status 与分类', () => {
    const parsed = parseGatewayFrame(JSON.stringify({
      type: 'error',
      kind: 'no-credit',
      message: '本月额度用完了。',
      status: 402,
      rejection: { ok: false, kind: 'no-credit', message: '本月额度用完了。' },
    }))
    expect(parsed).toEqual({ type: 'error', kind: 'no-credit', message: '本月额度用完了。', status: 402 })
  })

  it('error 帧没给顶层 kind 时从 rejection 里取', () => {
    const parsed = parseGatewayFrame(JSON.stringify({
      type: 'error', message: '并发太多。', rejection: { ok: false, kind: 'too-many-concurrent' },
    }))
    expect(parsed !== null && parsed.type === 'error' ? parsed.kind : '').toBe('too-many-concurrent')
  })

  it('不是 JSON、或认不出的帧型一律跳过，而不是中断整条流', () => {
    expect(parseGatewayFrame('not-json')).toBeNull()
    expect(parseGatewayFrame('[1,2,3]')).toBeNull()
    expect(parseGatewayFrame(JSON.stringify({ type: 'heartbeat' }))).toBeNull()
  })
})

describe('失败分类按状态码分支', () => {
  it('402 是"该付费了"，文案给的是可行动的下一步', () => {
    const failure = subscriptionFailure({ status: 402, kind: 'no-credit', message: '本月额度用完了。' })
    expect(failure.kind).toBe('insufficient-balance')
    expect(failure.status).toBe(402)
    expect(failure.message).toContain('升级档位')
  })

  it('429 是"该等一下"，文案说清是并发而不是余额', () => {
    const failure = subscriptionFailure({ status: 429, kind: 'too-many-concurrent' })
    expect(failure.kind).toBe('rate-limited')
    expect(failure.status).toBe(429)
    expect(failure.message).toContain('等几秒')
  })

  it('400 归到"请求本身有问题"', () => {
    const failure = subscriptionFailure({ status: 400, kind: 'invalid-request', message: '请求格式不对。' })
    expect(failure.kind).toBe('invalid-response')
    expect(failure.message).toBe('请求格式不对。')
  })

  it('403 / 404 是模型不可用，并且用网关给的那句可操作说明', () => {
    const forbidden = subscriptionFailure({ status: 403, message: '普通版用不了「千手·强力」。可以改用「千手·迅捷」。' })
    expect(forbidden.kind).toBe('invalid-response')
    expect(forbidden.message).toContain('千手·迅捷')
    expect(subscriptionFailure({ status: 404 }).message).toBe(SUBSCRIPTION_FAILURE_COPY['unknown-model'])
  })

  it('没有 status 时才退回分类与文案兜底', () => {
    const byKind = subscriptionFailure({ kind: 'no-credit' })
    expect(byKind.kind).toBe('insufficient-balance')
    const unknown = subscriptionFailure({})
    expect(unknown.kind).toBe('invalid-response')
    expect(unknown.message.length).toBeGreaterThan(0)
  })

  it('被拒时用 rejection 里的精确分类（顶层 kind 只是"rejected"这个粗分类）', () => {
    // 这一条的形状取自真实网关抓下来的字节（见 tests/fixtures/gateway-wire.json）。
    const parsed = parseGatewayFrame(JSON.stringify({
      type: 'error',
      kind: 'rejected',
      message: '这个模型不存在。',
      status: 404,
      rejection: { ok: false, kind: 'unknown-model', message: '这个模型不存在。' },
    }))
    expect(parsed !== null && parsed.type === 'error' ? parsed.kind : '').toBe('unknown-model')
  })

  it('上游转发失败（没有 status、没有 rejection）也认得出来：文案不说成用户的错', () => {
    const parsed = parseGatewayFrame(JSON.stringify({ type: 'error', kind: 'rate-limited', message: '请求太频繁。' }))
    const kind = parsed !== null && parsed.type === 'error' ? parsed.kind : ''
    expect(kind).toBe('rate-limited')
    // 网关给了文案就用它的（那是上游的真实情况）；没有时才用本地兜底。
    expect(subscriptionFailure({ kind, message: '请求太频繁。' }).message).toBe('请求太频繁。')
    const fallback = subscriptionFailure({ kind: 'rate-limited' })
    expect(fallback.kind).toBe('rate-limited')
    expect(fallback.message).toContain('上游')
    // 上游余额不足不是"用户的订阅额度不足"：不能引导用户去升级档位。
    const upstream = subscriptionFailure({ kind: 'insufficient-balance' })
    expect(upstream.message).toContain('上游')
    expect(upstream.message).not.toContain('升级档位')
  })

  it('400 + context-too-long：内容太长给的是"拆开或升级档位"，不是笼统的失败', () => {
    const failure = subscriptionFailure({ status: 400, kind: 'context-too-long' })
    expect(failure.kind).toBe('invalid-response')
    expect(failure.message).toContain('拆成几次')
  })

  it('401 说清是登录过期，并给出两条出路', () => {
    const failure = subscriptionFailure({ status: 401 })
    expect(failure.kind).toBe('unauthorized')
    expect(failure.message).toContain('登录')
    expect(failure.message).toContain('密钥')
  })
})

describe('真实流式往返（真 socket）', () => {
  it('三种帧按序生效：增量上屏、结算信息回传、不报错', async () => {
    const result = await exchange([
      frame({ type: 'delta', text: '你' }),
      frame({ type: 'delta', text: '好' }),
      frame({
        type: 'done',
        model: '千手·迅捷',
        requestedModel: '千手·迅捷',
        chargedSp: 0.01,
        downgraded: false,
        credit: { remainingMonthlySp: 389.99 },
      }),
    ])
    expect(result.deltas.join('')).toBe('你好')
    expect(result.error).toBeNull()
    expect(result.doneCalls).toBe(1)
    expect(result.settled?.remainingSp).toBe(389.99)
    expect(result.settled?.downgraded).toBe(false)
    expect(result.settled?.note).toBeNull()
    // 路径就是同源的宿主路由，没有查询串，也没有把 cookie 拼进 URL。
    expect(result.requestedPath).toBe(AI_CHAT_PATH)
  })

  it('请求体里只有模型与消息：不带密钥、不带身份头', async () => {
    const result = await exchange([frame({ type: 'delta', text: 'x' }), frame({ type: 'done', model: '千手·迅捷', requestedModel: '千手·迅捷' })])
    const body = JSON.parse(result.requestBody) as Record<string, unknown>
    expect(body['model']).toBe(DEFAULT_FRONT_MODEL)
    expect(Object.keys(body).sort()).toEqual(['messages', 'model'])
    expect(result.authorization).toBeUndefined()
    expect(result.cookie).toBeUndefined()
    expect(result.requestBody).not.toContain('sk-')
  })

  it('逐字节到达时半行被正确拼接', async () => {
    const result = await exchange([
      frame({ type: 'delta', text: '跨' }),
      frame({ type: 'delta', text: '块' }),
      frame({ type: 'done', model: '千手·迅捷', requestedModel: '千手·迅捷' }),
    ], { splitEveryByte: true })
    expect(result.deltas.join('')).toBe('跨块')
    expect(result.doneCalls).toBe(1)
  })

  it('末尾没有换行时最后一帧也要被消费', async () => {
    const result = await exchange([
      frame({ type: 'delta', text: '开头' }),
      `data: ${JSON.stringify({ type: 'done', model: '千手·迅捷', requestedModel: '千手·迅捷', chargedSp: 0.02 })}`,
    ], { noTrailingNewline: true })
    expect(result.deltas.join('')).toBe('开头')
    expect(result.settled?.chargedSp).toBe(0.02)
  })

  it('降级说明被透出来（这是不能让用户看不见的那一条）', async () => {
    const result = await exchange([
      frame({ type: 'delta', text: '换个模型答' }),
      frame({
        type: 'done',
        model: '千手·迅捷',
        requestedModel: '千手·强力',
        downgraded: true,
        downgradeNote: '「千手·强力」在普通版里用不了，这次由「千手·迅捷」作答。',
        credit: { remainingMonthlySp: 12.5 },
      }),
    ])
    expect(result.settled?.downgraded).toBe(true)
    expect(result.settled?.note).toContain('千手·强力')
    expect(result.error).toBeNull()
  })

  it('网关没给降级说明时，用两个真实的模型名说清楚', async () => {
    const result = await exchange([
      frame({ type: 'delta', text: 'x' }),
      frame({ type: 'done', model: '千手·迅捷', requestedModel: '千手·强力', downgraded: true }),
    ])
    expect(result.settled?.note).toContain('千手·强力')
    expect(result.settled?.note).toContain('千手·迅捷')
  })

  it('两个名字不一样就算降级，哪怕 downgraded 位是假的', async () => {
    const result = await exchange([
      frame({ type: 'delta', text: 'x' }),
      frame({ type: 'done', model: '千手·迅捷', requestedModel: '千手·强力', downgraded: false }),
    ])
    expect(result.settled?.downgraded).toBe(true)
    expect(result.settled?.note).not.toBeNull()
  })

  it('一个字都没有的流：如实报错，不当作完成', async () => {
    const result = await exchange([frame({ type: 'done', model: '千手·迅捷', requestedModel: '千手·迅捷' })])
    expect(result.deltas).toHaveLength(0)
    expect(result.error?.kind).toBe('invalid-response')
    expect(result.error?.message).toContain('空的')
    // 收尾照常发生（控制器要靠它把"正在回复"收回 idle），但**失败**已经报出去了：
    // 界面不会停在"已回复却什么都没有"。
    expect(result.doneCalls).toBe(1)
  })

  it('网关只补了一个 [DONE]：没有正文也要说清楚，而不是静默当完成', async () => {
    const result = await exchange(['data: [DONE]\n\n'])
    expect(result.error?.kind).toBe('invalid-response')
    expect(result.deltas).toHaveLength(0)
  })

  it('[DONE] 之后的残余内容不再产生任何回调', async () => {
    const result = await exchange([
      frame({ type: 'delta', text: '正文' }),
      'data: [DONE]\n\n',
      frame({ type: 'delta', text: '这是残余' }),
    ])
    expect(result.deltas.join('')).toBe('正文')
    expect(result.doneCalls).toBe(1)
    expect(result.error).toBeNull()
  })

  it('响应不是 text/event-stream：说明被中间层改写了，并带上真实的 content-type', async () => {
    const result = await exchange([], { raw: JSON.stringify({ ok: true }), contentType: 'application/json' })
    expect(result.error?.kind).toBe('invalid-response')
    expect(result.error?.message).toContain('application/json')
    expect(result.error?.message).toContain('中间层')
  })

  it('中间层把网关的中文说明留下来时，优先说那一句', async () => {
    const result = await exchange([], { raw: JSON.stringify({ ok: false, message: '请先登录。' }) })
    expect(result.error?.message).toBe('请先登录。')
  })

  it('流被截断（有正文、没有结算帧）：说"不完整"，不假装答完了', async () => {
    const result = await exchange([frame({ type: 'delta', text: '半截' })])
    expect(result.deltas.join('')).toBe('半截')
    expect(result.doneCalls).toBe(0)
    expect(result.error?.kind).toBe('network')
    expect(result.error?.message).toContain('不完整')
  })

  it('402 的错误帧被分类成"额度不足"', async () => {
    const result = await exchange([frame({
      type: 'error', kind: 'no-credit', message: '本月额度用完了。', status: 402,
    })])
    expect(result.error?.kind).toBe('insufficient-balance')
    expect(result.error?.status).toBe(402)
    expect(result.error?.message).toContain('升级档位')
  })

  it('429 的错误帧被分类成"限流"，并说清是并发不是余额', async () => {
    const result = await exchange([frame({
      type: 'error', kind: 'too-many-concurrent', message: '并发太多。', status: 429,
    })])
    expect(result.error?.kind).toBe('rate-limited')
    expect(result.error?.status).toBe(429)
  })

  it('非 2xx 的 JSON 响应（登录过期）被翻译成可行动的失败', async () => {
    const result = await exchange([], { status: 401 })
    expect(result.error?.kind).toBe('unauthorized')
    expect(result.error?.status).toBe(401)
  })

  it('用户按「停止」：安静收尾成本地取消，不是网络错误', async () => {
    const result = await exchange([frame({ type: 'delta', text: '正在说' })], { hang: true })
    expect(result.error?.kind).toBe('aborted')
    expect(result.doneCalls).toBe(0)
  })

  it('模型名不是前台名时明确报错，并且一个请求都不发', async () => {
    const recorder = recordingFetch(() => { throw new Error('不该发出请求') })
    vi.stubGlobal('fetch', recorder.fetch)
    const deltas: string[] = []
    const failures: ChatFailure[] = []
    const stream = streamSubscription(
      {
        baseUrl: SUBSCRIPTION_BASE_URL,
        apiKey: '',
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '你好' }],
      },
      { onDelta: t => deltas.push(t), onDone: () => {}, onError: f => failures.push(f) },
    )
    await stream.completed
    expect(recorder.urls).toHaveLength(0)
    expect(failures[0]?.kind).toBe('invalid-response')
    expect(failures[0]?.message).toContain('不是订阅通道的模型名')
  })
})

describe('非同源时一个请求都不发', () => {
  it('页面不是同源部署：拒绝发请求，并说清原因', async () => {
    const recorder = recordingFetch(() => { throw new Error('不该发出请求') })
    vi.stubGlobal('fetch', recorder.fetch)
    const conditions = { sameOrigin: false, signedIn: true }
    const failures: ChatFailure[] = []
    const stream = refuseSubscription(conditions, {
      onDelta: () => {}, onDone: () => {}, onError: f => failures.push(f),
    } satisfies StreamHandlers)
    await stream.completed
    expect(recorder.urls).toHaveLength(0)
    expect(failures[0]?.message).toBe(routeBlockReason(conditions))
    expect(failures[0]?.message).toContain('同源')
  })

  it('同源但没登录：也拒绝发请求', async () => {
    const conditions = { sameOrigin: true, signedIn: false }
    const failures: ChatFailure[] = []
    await refuseSubscription(conditions, {
      onDelta: () => {}, onDone: () => {}, onError: f => failures.push(f),
    }).completed
    expect(failures[0]?.message).toContain('登录')
  })
})

describe('通道判定（同源 + 已登录）', () => {
  it('自动档：两个条件都满足才走订阅通道', () => {
    expect(resolveAiRoute('auto', { sameOrigin: true, signedIn: true })).toBe('subscription')
    expect(resolveAiRoute('auto', { sameOrigin: false, signedIn: true })).toBe('byok')
    expect(resolveAiRoute('auto', { sameOrigin: true, signedIn: false })).toBe('byok')
    expect(resolveAiRoute('auto', { sameOrigin: false, signedIn: false })).toBe('byok')
  })

  it('显式选了订阅但条件不满足：回落到自带密钥（安全方向），并给出原因', () => {
    const conditions = { sameOrigin: false, signedIn: true }
    expect(resolveAiRoute('subscription', conditions)).toBe('byok')
    expect(routeBlockReason(conditions)).toContain('同源部署')
    expect(resolveAiRoute('subscription', { sameOrigin: true, signedIn: false })).toBe('byok')
    expect(routeBlockReason({ sameOrigin: true, signedIn: false })).toContain('登录')
  })

  it('显式选了自带密钥：条件再好也不改道', () => {
    expect(resolveAiRoute('byok', { sameOrigin: true, signedIn: true })).toBe('byok')
  })

  it('条件满足时没有"被挡住"的理由', () => {
    expect(routeBlockReason({ sameOrigin: true, signedIn: true })).toBeNull()
  })
})

describe('前台模型目录', () => {
  it('只有两个前台名字，且都不是上游标识', () => {
    expect(FRONT_MODELS.map(model => model.name)).toEqual(['千手·迅捷', '千手·强力'])
    for (const model of FRONT_MODELS) {
      expect(model.name).not.toMatch(/deepseek|flash|pro\b/i)
      expect(isFrontModel(model.name)).toBe(true)
    }
    expect(isFrontModel('deepseek-flash')).toBe(false)
  })

  it('千手·强力只在高级版 / Max 可见；档位读不到时按最保守的一档列', () => {
    expect(frontModelsForTier('basic').map(m => m.name)).toEqual(['千手·迅捷'])
    expect(frontModelsForTier('plus').map(m => m.name)).toEqual(['千手·迅捷', '千手·强力'])
    expect(frontModelsForTier('max').map(m => m.name)).toEqual(['千手·迅捷', '千手·强力'])
    expect(frontModelsForTier(null).map(m => m.name)).toEqual(['千手·迅捷'])
  })

  it('订阅档在服务商模板里：不需要密钥，模型就是两个前台名字', () => {
    const template = PROVIDER_TEMPLATES[SUBSCRIPTION_PROVIDER_ID]
    expect(template?.requiresKey).toBe(false)
    expect(template?.models.map(model => model.name)).toEqual(['千手·迅捷', '千手·强力'])
    expect(isSubscriptionProvider(SUBSCRIPTION_PROVIDER_ID)).toBe(true)
    expect(isSubscriptionProvider('deepseek')).toBe(false)
    // 端点是个本机标记，不是任何真实地址。
    expect(SUBSCRIPTION_BASE_URL.startsWith('qianshou://')).toBe(true)
  })

  it('手机端源码里不出现网关后端的上游标识', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url))
    const offenders: string[] = []
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      const text = readFileSync(`${root}${name}`, 'utf8')
      if (/deepseek-flash|deepseek-v4-pro/.test(text)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })

  it('网关路径常量与宿主侧的路由一致（跨边界漂移的守卫）', () => {
    const hostRoutes = readFileSync(
      fileURLToPath(new URL('../../../packages/host/model-gateway/src/routes.ts', import.meta.url)),
      'utf8',
    )
    expect(hostRoutes).toContain(`'${AI_CHAT_PATH}'`)
    expect(hostRoutes).toContain(`'${AI_STATUS_PATH}'`)
  })

  it('点数显示保留两位小数，读不到就说未知', () => {
    expect(formatSp(389.93)).toBe('389.93')
    expect(formatSp(0)).toBe('0.00')
    expect(formatSp(null)).toBe('未知')
  })
})

describe('档位与额度', () => {
  it('解析网关的额度响应：档位、剩余、窗口用量', () => {
    const result = parseStatusPayload({
      ok: true,
      version: 'qianshou.ai.v1',
      tier: { id: 'plus', label: '高级版', monthlyYuan: 99 },
      credit: { remainingSp: 389.93, monthlySp: 990, usedInWindowSp: 0.07, windowLimitSp: 200 },
      limits: { contextLimitTokens: 256_000, concurrency: 20 },
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.credit.tierId).toBe('plus')
    expect(result.ok && result.credit.tierLabel).toBe('高级版')
    expect(result.ok && result.credit.remainingSp).toBe(389.93)
    expect(result.ok && result.credit.windowLimitSp).toBe(200)
  })

  it('认不出的档位不编：tierId 为 null，但额度照显示', () => {
    const result = parseStatusPayload({
      ok: true, tier: { id: 'enterprise', label: '企业版' }, credit: { remainingSp: 12 },
    })
    expect(result.ok && result.credit.tierId).toBeNull()
    expect(result.ok && result.credit.tierLabel).toBe('企业版')
    expect(result.ok && result.credit.remainingSp).toBe(12)
    expect(result.ok && result.credit.monthlySp).toBeNull()
  })

  it('缺字段时一律给 null，绝不补一个数字', () => {
    const result = parseStatusPayload({ ok: true, tier: {}, credit: { remainingSp: '389.93' } })
    expect(result.ok && result.credit.remainingSp).toBeNull()
    expect(result.ok && result.credit.tierLabel).toBe('')
  })

  it('网关说没成功：按失败处理，不假装有额度', () => {
    const result = parseStatusPayload({ ok: false, message: '请先登录。' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toBe('请先登录。')
  })

  it('真实读一次：401 说清是登录过期', async () => {
    vi.stubGlobal('fetch', (async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch)
    const result = await readSubscriptionStatus()
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('signed-out')
  })

  it('真实读一次：连不上说连不上，路径是宿主额度路由', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      throw new Error('offline')
    }) as typeof fetch)
    const result = await readSubscriptionStatus()
    expect(result.ok).toBe(false)
    expect(urls).toEqual([AI_STATUS_PATH])
  })
})
