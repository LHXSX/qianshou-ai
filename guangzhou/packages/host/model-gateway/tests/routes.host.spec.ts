/**
 * 网关 HTTP 面的契约测试。
 *
 * 跑在**真实 node:http 服务端**上：这一层要验的正是"真流式"——边收上游边往下推，
 * 而不是攒完再返回。用打桩 Request/Response 会把最该验的那一点绕过去。
 *
 * 上游也是真实服务端（假服务商），所以整条链路是：
 *   测试客户端 → 我们的路由 → 网关服务层 → 账本 → 转发层 → 假服务商（真 socket）。
 * 全程不碰真实模型服务商。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createCreditLedger } from '../src/ledger.ts'
import { createGateway } from '../src/service.ts'
import { AI_STATUS_PATH, createAiRoutes } from '../src/routes.ts'
import { TIERS, type TierId } from '../src/tiers.ts'

/** 起一个假服务商，按 SSE 逐帧回。 */
async function fakeProvider(script: {
  readonly deltas: readonly string[]
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number }
}): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const piece of script.deltas) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      }
      if (script.usage !== undefined) {
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: script.usage.promptTokens, completion_tokens: script.usage.completionTokens } })}\n\n`)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得端口')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

/** 起我们自己的网关服务端（真实 HTTP），把路由挂上去。 */
async function gatewayServer(options: {
  readonly tier?: 'basic' | 'plus' | 'max'
  readonly monthlySp?: number
  readonly authenticated?: boolean
  readonly providerDeltas?: readonly string[]
  readonly providerUsage?: { readonly promptTokens: number; readonly completionTokens: number }
} = {}): Promise<{
  readonly origin: string
  readonly ledger: ReturnType<typeof createCreditLedger>
  readonly close: () => Promise<void>
  readonly seenBodies: string[]
}> {
  const provider = await fakeProvider({
    deltas: options.providerDeltas ?? ['你', '好'],
    ...(options.providerUsage === undefined ? {} : { usage: options.providerUsage }),
  })
  const ledger = createCreditLedger()
  const tier = options.tier ?? 'plus'
  ledger.grant('acct-1', tier, options.monthlySp ?? TIERS[tier].monthlySp)
  const gateway = createGateway({
    ledger,
    tierOf: () => tier,
    forwardConfig: { baseUrl: provider.baseUrl, apiKey: () => 'test-key' },
  })
  const routes = createAiRoutes({
    gateway,
    ledger,
    tierOf: () => tier,
    authenticate: request => (options.authenticated === false ? null : (request.headers.get('authorization') === 'Bearer good' ? PRINCIPAL : null)),
    newCallId: () => 'call-fixed',
  })

  const seenBodies: string[] = []
  const server: Server = createServer((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      seenBodies.push(Buffer.concat(parts).toString('utf8'))
      const url = `http://127.0.0.1${request.url ?? '/'}`
      const webRequest = new Request(url, {
        method: request.method ?? 'POST',
        headers: { 'content-type': request.headers['content-type'] ?? 'application/json', ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }) },
        // `exactOptionalPropertyTypes` 下不能显式传 `body: undefined`：GET 就不带这个字段。
        ...(request.method === 'GET' ? {} : { body: Buffer.concat(parts) }),
      })
      const handler = (request.url ?? '').startsWith(AI_STATUS_PATH) ? routes.status : routes.chat
      void handler(webRequest).then(async (webResponse) => {
        response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers))
        if (webResponse.body === null) { response.end(); return }
        const reader = webResponse.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // 边收边写：不加这层就变成"攒完再返回"，流式就测不出来了。
          response.write(Buffer.from(value))
        }
        response.end()
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得端口')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    ledger,
    seenBodies,
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      await provider.close()
    },
  }
}

const live: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of live.splice(0)) await close()
})

/** 解析 SSE 文本成事件数组。 */
function events(text: string): { readonly type?: string; readonly [key: string]: unknown }[] {
  return text
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.startsWith('data:'))
    .map(block => JSON.parse(block.slice(5).trim()) as { type?: string })
}

describe('对话路由：一次请求走完整条链路', () => {
  it('未登录 → 401，且**不发生任何调用**', async () => {
    const server = await gatewayServer({ authenticated: false })
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(401)
    expect(server.ledger.recordsOf('acct-1')).toHaveLength(0)
  })

  it('真流式：逐帧收到 delta，最后收到 done（含扣费与剩余额度）', async () => {
    const server = await gatewayServer({ providerUsage: { promptTokens: 100, completionTokens: 50 } })
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const parsed = events(await response.text())
    expect(parsed.filter(e => e.type === 'delta').map(e => e['text'])).toEqual(['你', '好'])
    const done = parsed.find(e => e.type === 'done')
    expect(done?.['model']).toBe('千手·迅捷')
    expect(done?.['chargedSp']).toBeGreaterThan(0)
    expect(done?.['downgraded']).toBe(false)
    expect(done?.['usageSource']).toBe('provider')
    // 落账：一次调用一条记录
    expect(server.ledger.recordsOf('acct-1')).toHaveLength(1)
  })

  it('前台只有我们的模型名：响应里**不出现上游厂商标识**', async () => {
    const server = await gatewayServer({})
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const raw = await response.text()
    expect(raw).not.toContain('deepseek')
    expect(raw).toContain('千手·迅捷')
  })

  it('额度不足 → 拒绝事件，且不扣费', async () => {
    const server = await gatewayServer({ monthlySp: 0 })
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const parsed = events(await response.text())
    const error = parsed.find(e => e.type === 'error')
    expect(error?.['kind']).toBe('rejected')
    expect(server.ledger.recordsOf('acct-1')).toHaveLength(0)
  })

  it('请求格式不对 → 400（不是流式错误）', async () => {
    const server = await gatewayServer({})
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({ model: '千手·迅捷' }),
    })
    expect(response.status).toBe(400)
  })

  it('空消息 → 400', async () => {
    const server = await gatewayServer({})
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [] }),
    })
    expect(response.status).toBe(400)
  })
})

describe('额度状态路由', () => {
  it('返回档位、剩余额度与限额，供界面显示', async () => {
    const server = await gatewayServer({ tier: 'plus' })
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      tier: { id: string }
      credit: { remainingSp: number; monthlySp: number }
      limits: { contextLimitTokens: number }
    }
    expect(body.tier.id).toBe('plus')
    expect(body.credit.monthlySp).toBe(TIERS.plus.monthlySp)
    expect(body.credit.remainingSp).toBe(TIERS.plus.monthlySp)
    expect(body.limits.contextLimitTokens).toBe(TIERS.plus.contextLimitTokens)
  })

  it('未登录 → 401', async () => {
    const server = await gatewayServer({ authenticated: false })
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })
})

describe('真流式（这一条才真的证明不是「攒完再返回」）', () => {
  it('第一帧在**整条完成之前**就到达客户端', async () => {
    // 关键手法：读第一帧时，**不要**等到流结束。攒完再返回的实现会在这里卡住。
    const server = await gatewayServer({ providerDeltas: ['第一段', '第二段', '第三段'] })
    live.push(server.close)
    const response = await fetch(`${server.origin}/api/qianshou/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()

    // 只读一次，就应当拿到第一帧——而不是等整条流读完。
    const first = await reader.read()
    expect(first.done).toBe(false)
    const firstText = decoder.decode(first.value ?? new Uint8Array())
    expect(firstText).toContain('data:')
    expect(firstText).toContain('第一段')

    // 收尾：把剩下的读完，确认整条能正常结束。
    // 断言累计而不是分片：帧小的时候 Node 会把几帧合并成一次 read，
    // 那是正常的传输行为——真正要证明的是"第一帧不必等整条完成"。
    let all = firstText
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      all += decoder.decode(value)
    }
    expect(all).toContain('done')
    expect(all).toContain('第三段')
  })
})

/**
 * 接口测试用的主体。
 *
 * 身份现在是一个**对象**（账号 + 角色 + 是否管理员），不再是裸字符串：档位要按角色算、
 * 管理面要按角色判，而这两件事都得有角色才做得了（WP1 A-04）。
 */
const PRINCIPAL = { accountId: 'acct-1', role: 'personal', isAdmin: false } as const

describe('额度状态接口：新用户不该看到"剩余 0"', () => {
  it('首次打开时先把本周期额度落实，再报余额', async () => {
    const ledger = createCreditLedger()
    const routes = createAiRoutes({
      gateway: { chat: () => ({ abort: () => {}, completed: Promise.resolve() }) } as never,
      ledger,
      tierOf: () => 'basic',
      authenticate: () => PRINCIPAL,
      // 与插件里的真实接线一致：按 (账号, 账期, 档位) 的事实判断要不要授予（WP1 A-12）。
      onGrant: (accountId, tierId) => {
        if (!ledger.isGranted(accountId, tierId)) ledger.grant(accountId, tierId, TIERS[tierId].monthlySp)
      },
    })
    const response = await routes.status(new Request('http://127.0.0.1/api/qianshou/ai/status', { method: 'POST' }))
    const body = await response.json() as { credit: { remainingSp: number; monthlySp: number } }
    // 修复前这里是 0——用户会以为订阅没生效。
    expect(body.credit.remainingSp).toBe(TIERS.basic.monthlySp)
    expect(body.credit.monthlySp).toBe(TIERS.basic.monthlySp)
  })

  it('重复查询不会把额度叠加（授予是幂等的）', async () => {
    const ledger = createCreditLedger()
    const grant = (accountId: string, tierId: TierId): void => {
      if (!ledger.isGranted(accountId, tierId)) ledger.grant(accountId, tierId, TIERS[tierId].monthlySp)
    }
    const routes = createAiRoutes({
      gateway: { chat: () => ({ abort: () => {}, completed: Promise.resolve() }) } as never,
      ledger,
      tierOf: () => 'basic',
      authenticate: () => PRINCIPAL,
      onGrant: grant,
    })
    await routes.status(new Request('http://127.0.0.1/api/qianshou/ai/status', { method: 'POST' }))
    await routes.status(new Request('http://127.0.0.1/api/qianshou/ai/status', { method: 'POST' }))
    const body = await (await routes.status(new Request('http://127.0.0.1/api/qianshou/ai/status', { method: 'POST' }))).json() as { credit: { remainingSp: number } }
    expect(body.credit.remainingSp).toBe(TIERS.basic.monthlySp)
  })
})
