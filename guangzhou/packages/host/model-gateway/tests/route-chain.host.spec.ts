/**
 * 全链路集成：**插件 → 真实 HTTP 路由 → 网关 → 真实上游（本地 SSE 服务）→ SSE 响应 → 账本**。
 *
 * 为什么必须有这一层：已有的三类测试各自只覆盖一段——
 * - `verify-e2e.mjs` 直接从服务层开始，**绕过 HTTP 路由**；
 * - `routes.host.spec.ts` 用的是**假网关**，不碰转发与结算；
 * - `plugin.host.spec.ts` 只断言路由**登记**了，没真的发过一条对话。
 * 于是"插件把路由接到网关上"这一跳从来没有测试覆盖过——而第 11 轮那个
 * **没有正文的 400** 正是藏在这一跳里（`ctx.accountSession` 未声明，cordis 运行时抛错）。
 *
 * 这里用真实 `Context` 装载插件、真实本地 HTTP 服务当上游、从**登记到的路由**发请求，
 * 一路走到账本与 SSE 帧。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/plugin.ts'
import { AI_CHAT_PATH, AI_STATUS_PATH } from '../src/routes.ts'
import { ADMIN_NAMES_PATH } from '../src/admin-routes.ts'
import { TIERS } from '../src/tiers.ts'

const contexts: Context[] = []
const servers: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一条被登记的 Fetch 路由。 */
interface RegisteredRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** 起一个吐两块正文 + 一帧用量的 SSE 上游。 */
async function upstream(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.flushHeaders()
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，世界' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得端口')
  return `http://127.0.0.1:${address.port}`
}

/** 审计记录里测试真正断言的字段。 */
interface CallRow {
  readonly callId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly sp: number
  readonly publishedName: string
}

/**
 * 装载插件，并把账号服务、密钥、账本路径都接到可控的替身上。
 * @param baseUrl - 上游地址。
 * @param accountId - 当前登录账号；`null` 表示未登录。
 * @returns 真实作用域、登记到的路由与账本。
 */
async function boot(baseUrl: string, accountId: string | null): Promise<{
  readonly ctx: Context
  readonly routes: RegisteredRoute[]
  readonly ledger: {
    creditOf: (accountId: string, tier: string) => { remainingMonthlySp: number; usedInWindowSp: number }
    recordsOf: (accountId: string, limit?: number) => readonly CallRow[]
  }
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes: RegisteredRoute[] = []
  ctx.provide('connection', {
    fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
  } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 'key-from-store', source: 'file' }) } as never)
  /**
   * 账号服务替身。`verifiedAccount` 是**服务端权威**那一份（在线 `/me` 的结果）：
   * 网关的身份、角色与管理员判定只认它（WP1 A-01）。
   */
  ctx.provide('accountSession', {
    account: async () => (accountId === null ? null : { id: accountId, role: 'personal' }),
    verifiedAccount: async () => (accountId === null ? null : { id: accountId, role: 'personal' }),
  } as never)
  apply(ctx, { baseUrl, backendBaseUrls: { DEEPSEEK_API_KEY: baseUrl, QWEN_TOKEN_PLAN_API_KEY: baseUrl }, ledgerPath: `/tmp/qianshou-route-chain-${String(Date.now())}-${Math.random().toString(36).slice(2)}.json` })
  // 等一等：账本读取与密钥预热都是延后一拍的。
  await new Promise(resolve => setTimeout(resolve, 60))
  return {
    ctx,
    routes,
    ledger: (ctx as unknown as { creditLedger: never }).creditLedger,
  }
}

/** 从登记到的路由发一条对话，返回原始 SSE 文本。 */
async function chatOverRoute(routes: RegisteredRoute[], model: string, content: string): Promise<{
  readonly status: number
  readonly contentType: string | null
  readonly raw: string
}> {
  const route = routes.find(item => item.path === AI_CHAT_PATH)
  if (route === undefined) throw new Error('对话路由没登记')
  const response = await route.fetch(new Request(`http://127.0.0.1${AI_CHAT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  }))
  let raw = ''
  if (response.body !== null) for await (const chunk of response.body) raw += new TextDecoder().decode(chunk)
  return { status: response.status, contentType: response.headers.get('content-type'), raw }
}

/** 把 SSE 文本里所有帧解析出来。 */
function framesOf(raw: string): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  for (const block of raw.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data:')) continue
    try {
      frames.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
    } catch { /* [DONE] 之类不是 JSON */ }
  }
  return frames
}

describe('全链路：从登记到的路由一路走到账本', () => {
  it('登录状态下走通：SSE 帧正确、账本按真实用量扣减', async () => {
    const baseUrl = await upstream()
    const { routes, ledger } = await boot(baseUrl, 'acc-1')

    const { status, contentType, raw } = await chatOverRoute(routes, '千手·迅捷', '你好')
    expect(status).toBe(200)
    // 这条断言守的是第 11 轮那个空正文 400：路由必须回的是 SSE，不是空 400。
    expect(contentType).toContain('text/event-stream')

    const frames = framesOf(raw)
    const text = frames.filter(frame => frame['type'] === 'delta').map(frame => frame['text']).join('')
    expect(text).toBe('你好，世界')

    const done = frames.find(frame => frame['type'] === 'done')
    expect(done).toBeDefined()
    expect(done?.['model']).toBe('千手·迅捷')
    expect(done?.['requestedModel']).toBe('千手·迅捷')
    expect(done?.['chargedSp']).toBe(0.07)

    // 账本：真实 token 用量落账，余额精确。
    const record = ledger.recordsOf('acc-1', 5)[0]
    expect(record?.inputTokens).toBe(120)
    expect(record?.outputTokens).toBe(40)
    expect(record?.publishedName).toBe('千手·迅捷')
    expect(ledger.creditOf('acc-1', 'basic').remainingMonthlySp).toBe(TIERS.basic.monthlySp - 0.07)
  })

  it('未登录时是**带正文的 401 JSON**，不是那个空正文 400', async () => {
    const baseUrl = await upstream()
    const { routes } = await boot(baseUrl, null)
    const route = routes.find(item => item.path === AI_CHAT_PATH)
    if (route === undefined) throw new Error('对话路由没登记')
    const response = await route.fetch(new Request(`http://127.0.0.1${AI_CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] }),
    }))
    /**
     * 实测发现路由的设计比我预想的好：**身份检查发生在开流之前**，
     * 所以未登录直接回 401 JSON，而不是先开一条 SSE 再用 error 帧说没登录。
     * 客户端因此可以按 HTTP 状态码分流，不必先建立流再解析帧。
     *
     * 这一条同时是第 11 轮那个故障的回归：那时的症状是**空正文 400**，
     * 用户完全不知道发生了什么。所以这里既断状态码，也断**正文非空且带类型**。
     */
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json() as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message.length).toBeGreaterThan(0)
  })

  it('订阅档位由订阅记录决定，而不是平台角色（全链路验证）', async () => {
    const baseUrl = await upstream()
    const { routes, ledger } = await boot(baseUrl, 'acc-2')
    /**
     * 账号角色是 `personal`，而**没有任何订阅记录**——按设计应当兜底成普通版。
     * 这条断言守的是"订阅优先、角色兜底"这个顺序：兜底存在是对的
     * （一次存储故障不该让所有付费用户都用不了），但它不该变成"角色决定额度"。
     *
     * 开通订阅那条路（管理面路由）另有 `subscription-routes.host.spec.ts` 覆盖，
     * 这里只验证兜底这一侧的端到端行为。
     */
    const route = routes.find(item => item.path === AI_STATUS_PATH)
    if (route === undefined) throw new Error('状态路由没登记')
    const response = await route.fetch(new Request(`http://127.0.0.1${AI_STATUS_PATH}`, { method: 'POST' }))
    const body = await response.json() as { tier: { id: string }; credit: { remainingSp: number } }
    // 没有任何订阅记录 → 按角色兜底成普通版（这是刻意设计的降级，不是缺陷）。
    expect(body.tier.id).toBe('basic')
    expect(body.credit.remainingSp).toBe(TIERS.basic.monthlySp)
    expect(ledger.creditOf('acc-2', 'basic').remainingMonthlySp).toBe(TIERS.basic.monthlySp)
  })

  it('上下文超限在全链路上被挡住，且不留审计记录', async () => {
    const baseUrl = await upstream()
    const { routes, ledger } = await boot(baseUrl, 'acc-3')
    const { raw } = await chatOverRoute(routes, '千手·迅捷', '内'.repeat(70000))
    const failure = framesOf(raw).find(frame => frame['type'] === 'error')
    expect(failure).toBeDefined()
    expect((failure?.['rejection'] as Record<string, unknown> | undefined)?.['kind']).toBe('context-too-long')
    expect((failure?.['rejection'] as Record<string, unknown> | undefined)?.['kind']).not.toBe(undefined)
    // 被拒的请求不该在账本里留下任何一笔。
    expect(ledger.recordsOf('acc-3', 10).length).toBe(0)
  })
})

describe('回归：用户在场时绝不能出现空正文 400', () => {
  it('登录用户发一条对话，绝不抛异常（第 11 轮故障的直接防线）', async () => {
    const baseUrl = await upstream()
    const { routes } = await boot(baseUrl, 'acc-regression')
    /**
     * 第 11 轮的症状是：路由**登记着**，但每个请求都抛
     * `cannot get property "accountSession" without inject`，
     * 宿主把它变成一个**没有正文的 400**——从外面看像"路由不存在"。
     *
     * 这条断言的价值在于"用户在场"这个条件：账号服务的**属性访问**本身就会抛，
     * 而只有真的走到取身份那一步才会碰到它。所以必须发一条真实请求，而不是只断言路由登记了。
     */
    const { status, contentType, raw } = await chatOverRoute(routes, '千手·迅捷', '你好')
    expect(status).toBe(200)
    expect(contentType).toContain('text/event-stream')
    expect(framesOf(raw).some(frame => frame['type'] === 'delta')).toBe(true)
  })

  it('管理面路由同样不会抛（它用同一套取身份逻辑）', async () => {
    const baseUrl = await upstream()
    const { routes } = await boot(baseUrl, 'acc-admin')
    const admin = routes.find(item => item.path === '/api/qianshou/ai/admin/names')
    if (admin === undefined) throw new Error('管理路由没登记')
    const response = await admin.fetch(new Request('http://127.0.0.1/api/qianshou/ai/admin/names', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    /**
     * 实测确认这里的语义比我预想的更细：**已登录但非管理员 → 403**，
     * 未登录才是 401。这比"统一 401"更有用——客户端能区分"去登录"与"权限不够"。
     * 关键是它既不是空正文 400（第 11 轮的症状），也不是 500（抛异常的表现）。
     */
    expect(response.status).toBe(403)
    const body = await response.json() as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message.length).toBeGreaterThan(0)
  })

  it('管理面对未登录回 401（与"权限不够"分开）', async () => {
    const baseUrl = await upstream()
    const { routes } = await boot(baseUrl, null)
    const admin = routes.find(item => item.path === '/api/qianshou/ai/admin/names')
    if (admin === undefined) throw new Error('管理路由没登记')
    const response = await admin.fetch(new Request('http://127.0.0.1/api/qianshou/ai/admin/names', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    // 客户端据此决定是"去登录"还是"要权限"，所以这两种必须分开。
    expect(response.status).toBe(401)
  })
})

describe('身份只认服务端：改本机文件不再是当管理员的办法（WP1 A-01）', () => {
  /**
   * 这一组守的是一次**真实环境里才暴露出来**的故障的**反面**。
   *
   * 当时的现象是：用户明明登录了（实测账号 167、`/api/qianshou/account/state` 是
   * `authenticated`），网关却一路回「请先登录」。当时的判断是"这两个服务对我的插件
   * 不可见"，于是加了「服务优先、**读账号文件兜底**」。
   *
   * 事后的证据把根因钉在了别处：早先 `principalOf()` 直接读 `ctx.accountSession`，
   * 而 cordis 对**未声明**的服务访问是运行时强制的——那一句**必然抛**
   * （就是 `docs/dev-plan/故障-插件路由空正文400.zh.md` 记的那个故障），
   * try/catch 把异常吞成了"未登录"。真正缺的是 `ctx.inject` 那一行，不是文件兜底。
   * 证据：两个真实插件挂在同一个 `Context` 下时，`ctx.get('accountSession')` 拿得到对象、
   * `/admin/*` 也按服务给的角色放行（见 `wp1-authority.host.spec.ts`）。
   *
   * 而文件兜底本身是个**越权口子**：`$DSH_HOME/.qianshou-account.json` 与工作台同属
   * 一个 OS 用户，改一行 `"role":"admin"` 就是管理员——能开订阅、改全局路由、读全站审计。
   * 所以它被删掉了，并且下面这两条把"删干净了"钉住。
   */
  it('账号服务缺席时一律未登录：磁盘上写着 admin 也没用', async () => {
    const baseUrl = await upstream()
    const dir = mkdtempSync(join(tmpdir(), 'qianshou-authority-'))
    dirs.push(dir)
    // 造一个**真实格式**的账号文件，并且把角色改成 admin——这正是攻击者的做法。
    writeFileSync(join(dir, '.qianshou-account.json'), JSON.stringify({
      refreshToken: 'not-a-real-token',
      account: { id: 167, role: 'admin', username: 'fixture' },
    }))

    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    ctx.provide('connection', {
      fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    } as never)
    // **故意不提供 accountSession**：没有权威来源，就必须是什么都认不出来。
    apply(ctx, {
      baseUrl,
      backendBaseUrls: { DEEPSEEK_API_KEY: baseUrl, QWEN_TOKEN_PLAN_API_KEY: baseUrl },
      dshHome: dir,
      ledgerPath: join(dir, 'ledger.json'),
    })
    await new Promise(resolve => setTimeout(resolve, 80))

    const status = routes.find(item => item.path === AI_STATUS_PATH)
    if (status === undefined) throw new Error('状态路由没登记')
    expect((await status.fetch(new Request(`http://127.0.0.1${AI_STATUS_PATH}`, { method: 'POST' }))).status).toBe(401)

    const admin = routes.find(item => item.path === ADMIN_NAMES_PATH)
    if (admin === undefined) throw new Error('管理路由没登记')
    const denied = await admin.fetch(new Request(`http://127.0.0.1${ADMIN_NAMES_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    // 修复前这里是 200（照着磁盘上的 role 放行）——一行文件就是管理员。
    expect(denied.status).toBe(401)
  })

  it('服务端说 personal 时管理面回 403：文件里的 admin 同样不作数', async () => {
    const baseUrl = await upstream()
    const dir = mkdtempSync(join(tmpdir(), 'qianshou-authority-'))
    dirs.push(dir)
    writeFileSync(join(dir, '.qianshou-account.json'), JSON.stringify({
      refreshToken: 'not-a-real-token',
      account: { id: 167, role: 'admin', username: 'fixture' },
    }))

    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    ctx.provide('connection', {
      fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    } as never)
    // 账号服务在场，但**服务端权威快照**说这个账号是 personal。
    ctx.provide('accountSession', {
      account: async () => ({ id: 167, role: 'admin' }),
      verifiedAccount: async () => ({ id: 167, role: 'personal' }),
    } as never)
    apply(ctx, { baseUrl, backendBaseUrls: { DEEPSEEK_API_KEY: baseUrl, QWEN_TOKEN_PLAN_API_KEY: baseUrl }, dshHome: dir, ledgerPath: join(dir, 'ledger.json') })
    await new Promise(resolve => setTimeout(resolve, 80))

    const admin = routes.find(item => item.path === ADMIN_NAMES_PATH)
    if (admin === undefined) throw new Error('管理路由没登记')
    const response = await admin.fetch(new Request(`http://127.0.0.1${ADMIN_NAMES_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    // 403 = "登录了，但权限不够"：与 401 分开，界面才知道该显示哪一句。
    expect(response.status).toBe(403)
  })

  it('账号文件不存在、服务也缺席时同样是未登录（不把"读不到"当成已登录）', async () => {
    const baseUrl = await upstream()
    const dir = mkdtempSync(join(tmpdir(), 'qianshou-authority-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    ctx.provide('connection', {
      fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    } as never)
    apply(ctx, { baseUrl, backendBaseUrls: { DEEPSEEK_API_KEY: baseUrl, QWEN_TOKEN_PLAN_API_KEY: baseUrl }, dshHome: dir, ledgerPath: join(dir, 'ledger.json') })
    await new Promise(resolve => setTimeout(resolve, 80))
    const route = routes.find(item => item.path === AI_STATUS_PATH)
    if (route === undefined) throw new Error('状态路由没登记')
    const response = await route.fetch(new Request(`http://127.0.0.1${AI_STATUS_PATH}`, { method: 'POST' }))
    expect(response.status).toBe(401)
  })

  it('凭据服务不可见时，从凭据文件的 refs 段读密钥（密钥配了就该能用）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qianshou-cred-'))
    dirs.push(dir)
    // 凭据文件是 YAML，但这里只复现我们解析的那一部分形状（refs 段）。
    writeFileSync(join(dir, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      'refs:',
      '  DEEPSEEK_API_KEY: file-backed-key-value',
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    let authorization: string | undefined
    const server = createServer((request, response) => {
      authorization = request.headers.authorization
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('未能取得端口')

    ctx.provide('connection', {
      fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    } as never)
    ctx.provide('accountSession', {
      account: async () => ({ id: 'acc-cred', role: 'personal' }),
      verifiedAccount: async () => ({ id: 'acc-cred', role: 'personal' }),
    } as never)
    // **故意不提供 credentials**：复现"凭据服务不可见"。
    const baseUrlLocal = `http://127.0.0.1:${address.port}`
    apply(ctx, { baseUrl: baseUrlLocal, backendBaseUrls: { DEEPSEEK_API_KEY: baseUrlLocal, QWEN_TOKEN_PLAN_API_KEY: baseUrlLocal }, dshHome: dir, ledgerPath: join(dir, 'ledger.json') })
    await new Promise(resolve => setTimeout(resolve, 80))

    const route = routes.find(item => item.path === AI_CHAT_PATH)
    if (route === undefined) throw new Error('对话路由没登记')
    const response = await route.fetch(new Request(`http://127.0.0.1${AI_CHAT_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] }),
    }))
    let raw = ''
    if (response.body !== null) for await (const chunk of response.body) raw += new TextDecoder().decode(chunk)
    // 修复前这里会得到「服务暂时不可用」——而密钥其实就在文件里、并且有效。
    expect(raw).toContain('好')
    expect(authorization).toBe('Bearer file-backed-key-value')
  })
})

describe('本机适配器路径：自己的门，只认 loopback', () => {
  /**
   * 这一组守的是一条**真实阻塞**：
   *
   * 宿主的 `/api` 前缀路由前面有一道信任门（`requestRejection`），它要一枚
   * **宿主进程签名**的浏览器 cookie（密钥只活在进程内存里）。本机模型适配器不带 cookie，
   * 实测被挡成 `{ 401, 正文: "unauthorized" }`——纯文本，适配器按 SSE 解析会失败。
   *
   * 修法不是削弱 `/api` 的门禁（那会动到所有接口的安全边界），而是**另开一条路**
   * （`/qianshou-ai`），由网关自己把门。这里测的就是那道门。
   */
  it('只认 loopback：判定用 socket 远端地址，不看任何请求头', async () => {
    const { isLoopbackAddress } = await import('../src/local-openai.ts')
    // 内核给的连接事实。
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    // 非本机一律拒绝——**包括看起来像本机的写法**（`127.0.0.1.evil.com` 之类）。
    expect(isLoopbackAddress('10.0.0.5')).toBe(false)
    expect(isLoopbackAddress('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackAddress('::ffff:10.0.0.5')).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    // `127.0.0.2` 也在 127/8 里，仍是本机。
    expect(isLoopbackAddress('127.0.0.2')).toBe(true)
  })

  it('越界时留痕（"谁在用"必须能追查）', async () => {
    const { createLocalOpenAiRoute } = await import('../src/local-openai.ts')
    const rejected: { remoteAddress: string }[] = []
    const route = createLocalOpenAiRoute({
      handle: async () => Response.json({ ok: true }),
      onRejected: (detail) => { rejected.push({ remoteAddress: detail.remoteAddress }) },
    })
    // 伪造一个**非本机**的 socket 地址；Host/Origin 怎么伪装都不影响判定。
    const fakeRequest = {
      socket: { remoteAddress: '10.1.2.3' },
      url: '/qianshou-ai/v1/chat/completions',
      method: 'POST',
      headers: { host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', 'x-forwarded-for': '127.0.0.1' },
    } as unknown as Parameters<typeof route.handler>[0]
    let status = 0
    let body = ''
    const fakeResponse = {
      writeHead: (code: number) => { status = code; return fakeResponse },
      end: (chunk?: unknown) => { if (typeof chunk === 'string') body = chunk },
      write: () => true,
      on: () => fakeResponse,
      off: () => fakeResponse,
      once: () => fakeResponse,
    } as unknown as Parameters<typeof route.handler>[1]
    await route.handler(fakeRequest, fakeResponse)
    expect(status).toBe(403)
    expect(body).toContain('只服务本机')
    // 越界是异常事件，必须留下痕迹。
    expect(rejected.length).toBe(1)
    expect(rejected[0]?.remoteAddress).toBe('10.1.2.3')
  })

  it('处理器抛异常时给**带正文**的 500，而不是空响应', async () => {
    const { createLocalOpenAiRoute } = await import('../src/local-openai.ts')
    const route = createLocalOpenAiRoute({ handle: async () => { throw new Error('故意炸一下') } })
    const fakeRequest = {
      socket: { remoteAddress: '127.0.0.1' },
      url: '/qianshou-ai/v1/chat/completions',
      method: 'POST',
      // 要长得像**真正的本机进程**：无 Origin、无 Sec-Fetch、Host 是本机。
      // 否则会被来源门提前拦成 403，测不到"处理器抛异常"这条路径。
      headers: { host: '127.0.0.1:3091' },
      [Symbol.asyncIterator]: async function* () { /* 空请求体 */ },
    } as unknown as Parameters<typeof route.handler>[0]
    let status = 0
    let body = ''
    const fakeResponse = {
      writeHead: (code: number) => { status = code; return fakeResponse },
      end: (chunk?: unknown) => { if (typeof chunk === 'string') body = chunk },
      write: () => true, on: () => fakeResponse, off: () => fakeResponse, once: () => fakeResponse,
    } as unknown as Parameters<typeof route.handler>[1]
    await route.handler(fakeRequest, fakeResponse)
    expect(status).toBe(500)
    // 宿主的 /api 会把异常压成一个没有正文的 400，那种失败排查极贵——所以这里必须带正文。
    expect(body).toContain('故意炸一下')
  })
})

describe('漏洞回归：中途断开不能再白用', () => {
  /**
   * 复现攻击手法：发一个大请求、然后**立刻中止**。
   *
   * 早先的链路是：中止 → `forward` 归为 aborted → `service` 走 `ledger.release()`
   * → **全额退回且不留记录** → 月度上限与五小时刹车同时看不到这次调用 → 可以无限重复。
   * 而上游已经把发过去的输入 token 算过费了，成本由我们承担。
   *
   * 修法：中止这类"**可能已经产生成本**"的失败改为 `settlePartial`——
   * 按已发出的输入结算，其余退回。
   */
  it('中止后按已发出的输入扣费，而不是全额退回', async () => {
    const baseUrl = await upstream()
    const { routes, ledger } = await boot(baseUrl, 'acc-abuse')
    const route = routes.find(item => item.path === AI_CHAT_PATH)
    if (route === undefined) throw new Error('对话路由没登记')

    // 一段够长的输入，确保要扣的钱看得出来。
    const content = '这是一段用来验证计费的输入。'.repeat(200)
    const controller = new AbortController()
    const response = await route.fetch(new Request(`http://127.0.0.1${AI_CHAT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content }] }),
      signal: controller.signal,
    }))
    // 立刻中止——模拟"发完就断"。
    controller.abort()
    try {
      if (response.body !== null) for await (const chunk of response.body) void chunk
    } catch { /* 中止本身会抛，无所谓 */ }
    // 给收尾一点时间（abort 是异步传播到 forward 与结算的）。
    await new Promise(resolve => setTimeout(resolve, 300))

    const after = ledger.creditOf('acc-abuse', 'basic').remainingMonthlySp
    // 修复前这里等于**授予量**（一分没扣）；修复后必须小于它。
    expect(after).toBeLessThan(TIERS.basic.monthlySp)
    // 而五小时窗口也必须看到这笔钱，否则刹车照样被绕过。
    expect(ledger.creditOf('acc-abuse', 'basic').usedInWindowSp).toBeGreaterThan(0)
  })
})

describe('安全：本机路径不能成为任意网页的后门', () => {
  /**
   * 这是一处**我引入的**安全漏洞，由独立审查发现后实测坐实。
   *
   * 早先只用 `socket.remoteAddress` 判 loopback。但**浏览器里任何网页**发一条
   * `fetch('http://127.0.0.1:<port>/qianshou-ai/…')` 时，来源地址**也是本机**——
   * 实测最初版本带 `Origin: https://evil.example.com` 的请求被放行成 **200**，
   * 也就是说任意页面都能花掉用户的额度与上游密钥。
   *
   * 我原先"本机进程本来就能读密钥"的推理**漏掉了浏览器这个混淆代理**：
   * 本机进程是我们自己的代码，而网页是**别人控制的代码**，两者不能等同。
   */
  it('带 Origin 的请求被拒（跨站 fetch）', async () => {
    const { looksLikeLocalProcessRequest } = await import('../src/local-openai.ts')
    const verdict = looksLikeLocalProcessRequest({ origin: 'https://evil.example.com', host: '127.0.0.1:3091' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toContain('Origin')
  })

  /**
   * 这条测试原来断言的是「**只要**带 `Sec-Fetch-*` 就拒绝」，
   * 依据是"现代浏览器对 fetch/XHR 一定会带 `Sec-Fetch-Mode`"。
   *
   * **那个依据只对了一半，并造成了一个真实的线上故障**：
   * 这个头不只第三方网页会带，**产品自己的运行时也带**。实测到的真实请求是
   * `origin=undefined, secFetchSite=undefined, secFetchMode=cors` —— 于是
   * **千手自己的界面被自己的信任门挡住**（403 → 适配器映射成 `AUTH`，
   * 用户看到「本轮运行失败 模型接口鉴权失败」，而网关审计里没有任何记录）。
   *
   * 现在判据改为**按"是否跨站"分级**，本测试随之改为守护**真正的威胁**：
   */
  it('跨站来源被拒，同源/运行时请求放行（按 Sec-Fetch-Site 分级）', async () => {
    const { looksLikeLocalProcessRequest } = await import('../src/local-openai.ts')
    // ① 真正的威胁：明确跨站 —— 拒。
    expect(looksLikeLocalProcessRequest({ secFetchSite: 'cross-site', host: '127.0.0.1:3091' }).ok).toBe(false)
    // ② 同一站点（本机服务自己的页面）—— 放行：它是我们自己的界面。
    expect(looksLikeLocalProcessRequest({ secFetchSite: 'same-origin', host: '127.0.0.1:3091' }).ok).toBe(true)
    // ③ **被误伤的那种请求**：没有 Origin、没有 Sec-Fetch-Site，只有 Sec-Fetch-Mode。
    //    这是产品运行时的真实形状，必须放行——它正是此前让对话不可用的原因。
    expect(looksLikeLocalProcessRequest({ secFetchMode: 'cors', host: '127.0.0.1:3091' }).ok).toBe(true)
    expect(looksLikeLocalProcessRequest({ secFetchMode: 'no-cors', host: '127.0.0.1:3091' }).ok).toBe(true)
  })

  it('`Origin` 仍是硬判据——第三方网页即使伪造 Sec-Fetch 也进不来', async () => {
    const { looksLikeLocalProcessRequest } = await import('../src/local-openai.ts')
    // 浏览器对**任何跨源 POST** 都必定带 Origin，所以这一条才是这道门真正的支柱。
    // 即便攻击者把 Sec-Fetch-Site 伪造成 same-origin，Origin 仍会暴露它。
    expect(looksLikeLocalProcessRequest({
      origin: 'https://evil.example.com', secFetchSite: 'same-origin', host: '127.0.0.1:3091',
    }).ok).toBe(false)
  })

  it('Host 不是本机时被拒（DNS rebinding）', async () => {
    const { looksLikeLocalProcessRequest, isLoopbackHost } = await import('../src/local-openai.ts')
    expect(looksLikeLocalProcessRequest({ host: 'evil.example.com' }).ok).toBe(false)
    // 判定本身：只认 loopback 主机名与 localhost。
    expect(isLoopbackHost('127.0.0.1:3091')).toBe(true)
    expect(isLoopbackHost('localhost:3091')).toBe(true)
    expect(isLoopbackHost('[::1]:3091')).toBe(true)
    expect(isLoopbackHost('evil.example.com')).toBe(false)
    // "看起来像本机"的域名必须落空——否则 rebinding 换个名字就能绕。
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost(undefined)).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
  })

  it('真正本机进程的形状（无 Origin、无 Sec-Fetch、Host 是本机）才放行', async () => {
    const { looksLikeLocalProcessRequest } = await import('../src/local-openai.ts')
    // 这三条都成立才算本机进程——缺一条就可能是浏览器或别人控制的代码。
    expect(looksLikeLocalProcessRequest({ host: '127.0.0.1:3091' }).ok).toBe(true)
  })
})
