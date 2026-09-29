/**
 * OpenAI 兼容路由的契约测试——**对着 DSH 适配器真实的请求形状**。
 *
 * 为什么这一份不能省：电脑端主对话走 `@deepseek-ai/dsh-llm-deepseek`，它按 OpenAI 形状
 * 发请求，并且要看到**完整的** `choices[0].delta`——`reasoning_content`、
 * 按 index **分片累加**的 `tool_calls`、`finish_reason`。如果网关用有损形状接上去
 * （只挑正文），agent 的工具调用会**静默消失**：界面看起来正常、只是"不会干活"，不报错。
 *
 * 所以这里断言的核心是**字节级保真**：工具调用的分片必须一个不少、顺序不乱。
 * 顺便断言我们**没有**顺手整理 body（工具定义、采样参数都该原样到上游）。
 */
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/plugin.ts'
import { AI_COMPLETIONS_PATH } from '../src/routes.ts'
import { TIERS } from '../src/tiers.ts'

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
})

/** 一条被登记的 Fetch 路由。 */
interface RegisteredRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** 上游收到的请求体，供"有没有被改过"的断言使用。 */
let upstreamBody: Record<string, unknown> | null = null

/** 起一个**按适配器期望的形状**回帧的上游：推理 + 正文 + 工具调用分片 + 末帧用量。 */
async function adapterShapedUpstream(): Promise<string> {
  upstreamBody = null
  const server = createServer((request, response) => {
    let raw = ''
    // 显式声明 `Buffer`：不写的话这个参数是 `any`，而 `any` 参与 `+=` 会触发
    // `restrict-plus-operands`（一个把"类型没写清"当成错误的规则）。
    request.on('data', (part: Buffer) => { raw += part.toString('utf8') })
    request.on('end', () => {
      upstreamBody = JSON.parse(raw) as Record<string, unknown>
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.flushHeaders()
      const frame = (payload: unknown): void => { response.write(`data: ${JSON.stringify(payload)}\n\n`) }
      // 1) 推理内容（会推理的模型会先发这个）
      frame({ model: 'deepseek-flash', choices: [{ index: 0, delta: { reasoning_content: '让我想想' }, finish_reason: null }] })
      // 2) 正文
      frame({ model: 'deepseek-flash', choices: [{ index: 0, delta: { content: '我来查一下天气。' }, finish_reason: null }] })
      // 3) 工具调用：**分片**到达，名字与参数都不在同一帧里——这是真实形状
      frame({ model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] })
      frame({ model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] })
      frame({ model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"上海"}' } }] }, finish_reason: null }] })
      // 4) 收尾帧带 finish_reason，末帧单独带 usage
      frame({ model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      frame({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 60 } })
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得端口')
  return `http://127.0.0.1:${address.port}`
}

/**
 * 装载插件。
 * @param baseUrl - 上游地址。
 * @param accountId - 登录账号；`null` 表示未登录。
 * @returns 真实作用域、登记到的路由与账本。
 */
/** 测试用到的那部分账本能力（只列断言真正读的字段）。 */
interface LedgerLike {
  readonly creditOf: (accountId: string, tier: string) => { readonly remainingMonthlySp: number }
  readonly recordsOf: (accountId: string, limit?: number) => readonly {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly publishedName: string
  }[]
}

/**
 * 装载插件。
 * @param baseUrl - 上游地址。
 * @param accountId - 登录账号；`null` 表示未登录。
 * @returns 真实作用域、登记到的路由与账本。
 */
async function boot(baseUrl: string, accountId: string | null): Promise<{
  readonly routes: RegisteredRoute[]
  readonly ledger: LedgerLike
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes: RegisteredRoute[] = []
  ctx.provide('connection', {
    fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
  } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'key-from-store', source: 'file' }) } as never)
  /**
   * 账号服务替身：`account` 是展示快照，`verifiedAccount` 是**服务端权威**快照。
   * 网关只认后者（WP1 A-01），所以替身两个都给——只给前者的替身会得到 401。
   */
  ctx.provide('accountSession', {
    account: async () => (accountId === null ? null : { id: accountId, role: 'personal' }),
    verifiedAccount: async () => (accountId === null ? null : { id: accountId, role: 'personal' }),
  } as never)
  apply(ctx, { baseUrl, backendBaseUrls: { DEEPSEEK_API_KEY: baseUrl, QWEN_TOKEN_PLAN_API_KEY: baseUrl }, ledgerPath: `/tmp/qianshou-completions-${String(Date.now())}-${Math.random().toString(36).slice(2)}.json` })
  await new Promise(resolve => setTimeout(resolve, 80))
  return { routes, ledger: (ctx as unknown as { creditLedger: never }).creditLedger }
}

/** 照适配器的形状发一次请求，返回帧数组。 */
async function callAdapterShaped(routes: RegisteredRoute[], body: Record<string, unknown>): Promise<{
  readonly status: number
  readonly frames: Record<string, unknown>[]
  readonly headers: Headers
}> {
  const route = routes.find(item => item.path === AI_COMPLETIONS_PATH)
  if (route === undefined) throw new Error('OpenAI 兼容路由没登记')
  const response = await route.fetch(new Request(`http://127.0.0.1${AI_COMPLETIONS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  let raw = ''
  if (response.body !== null) for await (const chunk of response.body) raw += new TextDecoder().decode(chunk)
  const frames: Record<string, unknown>[] = []
  for (const block of raw.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    try { frames.push(JSON.parse(payload) as Record<string, unknown>) } catch { /* 忽略非 JSON */ }
  }
  return { status: response.status, frames, headers: response.headers }
}

/** 适配器真实发送的请求形状（见 dsh-llm-deepseek 的 serialize：总是流式 + 工具定义）。 */
const ADAPTER_BODY = {
  model: '千手·迅捷',
  messages: [{ role: 'user', content: '上海天气怎么样？' }],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 4096,
  tools: [{
    type: 'function',
    function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  }],
}

describe('OpenAI 兼容路由：对着适配器真实形状', () => {
  it('工具调用的分片一帧不少、参数能拼回完整 JSON', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, 'acc-tools')
    const { status, frames } = await callAdapterShaped(routes, ADAPTER_BODY)
    expect(status).toBe(200)

    // 适配器是**按 index 累加**的，所以这里照它的方式拼一遍。
    let name = ''
    let args = ''
    for (const frame of frames) {
      const choices = frame['choices'] as { delta?: { tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] | undefined
      for (const call of choices?.[0]?.delta?.tool_calls ?? []) {
        name = call.function?.name ?? name
        args += call.function?.arguments ?? ''
      }
    }
    expect(name).toBe('get_weather')
    // 这条是关键：分片被完整透传，参数能拼回合法 JSON。
    // 用有损形状接的话，这里会是空字符串——而且**不会报错**。
    expect(JSON.parse(args)).toEqual({ city: '上海' })
  })

  it('推理内容与正文都原样到达（一个有损实现会丢掉 reasoning_content）', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, 'acc-reason')
    const { frames } = await callAdapterShaped(routes, ADAPTER_BODY)
    const deltas = frames
      .map(frame => (frame['choices'] as { delta?: Record<string, unknown> }[] | undefined)?.[0]?.delta)
      .filter((delta): delta is Record<string, unknown> => delta !== undefined)
    expect(deltas.some(delta => delta['reasoning_content'] === '让我想想')).toBe(true)
    expect(deltas.map(delta => delta['content']).filter(Boolean).join('')).toBe('我来查一下天气。')
  })

  it('finish_reason 原样保留（适配器靠它决定是不是要执行工具）', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, 'acc-finish')
    const { frames } = await callAdapterShaped(routes, ADAPTER_BODY)
    const reasons = frames
      .map(frame => (frame['choices'] as { finish_reason?: string }[] | undefined)?.[0]?.finish_reason)
      .filter((reason): reason is string => typeof reason === 'string')
    expect(reasons).toContain('tool_calls')
  })

  it('**工具定义原样到了上游**，没有被我们整理掉', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, 'acc-passthrough')
    await callAdapterShaped(routes, ADAPTER_BODY)
    expect(Array.isArray(upstreamBody?.['tools'])).toBe(true)
    expect((upstreamBody?.['tools'] as unknown[]).length).toBe(1)
    // 采样与流式参数也要在：上游按它们行为，我们无权替用户决定。
    expect(upstreamBody?.['stream']).toBe(true)
    expect(upstreamBody?.['max_tokens']).toBeDefined()
  })

  it('上游真实模型标识不出网关（帧里的 model 是前台名）', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, 'acc-name')
    const { frames } = await callAdapterShaped(routes, ADAPTER_BODY)
    const models = frames.map(frame => frame['model']).filter((model): model is string => typeof model === 'string')
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) expect(model).toBe('千手·迅捷')
    // 原始 body 里确实含有上游标识（那是发出去的请求），但**帧里不许有**。
    expect(JSON.stringify(frames)).not.toContain('deepseek-flash')
  })

  it('计费按上游回执的真实 token，且进了审计', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes, ledger } = await boot(baseUrl, 'acc-bill')
    await callAdapterShaped(routes, ADAPTER_BODY)
    const record = ledger.recordsOf('acc-bill', 5)[0]
    expect(record?.inputTokens).toBe(200)
    expect(record?.outputTokens).toBe(60)
    expect(record?.publishedName).toBe('千手·迅捷')
    // 与另一条链路（手机端 SSE）共用同一本账。
    expect(ledger.creditOf('acc-bill', 'basic').remainingMonthlySp).toBeLessThan(TIERS.basic.monthlySp)
  })

  it('降级线索在两个响应头里，且是百分号编码（中文不能直接进头）', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, 'acc-header')
    const { headers } = await callAdapterShaped(routes, ADAPTER_BODY)
    // 「千手·迅捷」是非 ASCII，直接写进响应头会让 new Response 抛异常——
    // 这是实测抓到过的真缺陷（修之前这条路由一开流就 500）。
    expect(headers.get('x-qianshou-requested')).toBe(encodeURIComponent('千手·迅捷'))
    expect(decodeURIComponent(headers.get('x-qianshou-model') ?? '')).toBe('千手·迅捷')
  })

  it('未登录回 **JSON 401**（不是 SSE）：适配器按状态码处理鉴权失败', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, null)
    const route = routes.find(item => item.path === AI_COMPLETIONS_PATH)
    if (route === undefined) throw new Error('路由没登记')
    const response = await route.fetch(new Request(`http://127.0.0.1${AI_COMPLETIONS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADAPTER_BODY),
    }))
    // 先开流再报"没登录"会让 OpenAI 生态的客户端无从判断，所以这里必须是 JSON。
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('缺少 model / messages 时回 400 带正文', async () => {
    const baseUrl = await adapterShapedUpstream()
    const { routes } = await boot(baseUrl, 'acc-bad')
    const { status } = await callAdapterShaped(routes, { stream: true })
    expect(status).toBe(400)
  })
})
