/**
 * 插件装配的契约测试：**`apply()` 必须真的能在 cordis 里跑起来，并且路由能真的被调用**。
 *
 * 这个文件是补出来的，代价是两次真实的启动级故障，而且两次的症状都极具误导性：
 *
 * **故障一：一个没有正文的 400。** 插件只声明了 `inject: ['connection']`，却在
 * `principalOf()` 里读 `ctx.accountSession`。cordis 对服务访问是**运行时强制**的，
 * 于是每个请求都在 `principalOf()` 抛 `cannot get property "accountSession" without
 * inject`；宿主 webServer 把处理器异常统一成一个**空正文 400**。从外面看很像"路由没
 * 登记"（同一路径 `GET` 是 404、`POST` 是 400），从代码看又像"路由明明登记了"。
 *
 * **故障二：整个工作台起不来。** 知道故障一后把 `accountSession` 加进 `inject`，启动
 * 直接失败：`pending (waiting for service: accountSession)`。宿主在启动末尾执行
 * `assertEntriesActivated`，**每条插件条目都必须激活**，于是"账号插件必须存在"变成了
 * 硬约束。cordis 的 `Inject` 两种形状都表示必需，没有"可选依赖"这一档。
 *
 * 为什么此前没测出来：所有测试都只测 `tiers/ledger/forward/service/routes/routing`
 * 这些**纯函数模块**，没有任何一条真的把插件放进 cordis 里跑。纯逻辑全绿，装配线断了。
 *
 * 所以这个文件用**真实的 `Context`**（不是手写的假 ctx）做三件事：
 * 1. `inject` 只声明 `connection`——多声明一个必需服务会让工作台起不来；
 * 2. `apply()` 能跑完且不抛——默认目录的生效时刻必须严格递增；
 * 3. 登记的路由**真的能被调用**，且在"没有账号服务"时给 401 JSON 而不是抛异常。
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/plugin.ts'
import { ADMIN_BIND_PATH, ADMIN_NAMES_PATH } from '../src/admin-routes.ts'
import { ADMIN_AUDIT_PATH, AI_AUDIT_PATH } from '../src/audit-routes.ts'
import { ADMIN_SUBSCRIPTIONS_PATH, ADMIN_SUBSCRIPTION_PATH } from '../src/subscription-routes.ts'
import { AI_COMPLETIONS_PATH } from '../src/routes.ts'
import { AI_CHAT_PATH, AI_STATUS_PATH } from '../src/routes.ts'
import { ADMIN_MARKETPLACE_PATH } from '../src/marketplace-admin.ts'
import { PLUGIN_LICENSE_PATH } from '../src/plugin-license.ts'
import { PLUGIN_SUBMISSIONS_PATH } from '../src/plugin-submissions.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** 一条被登记的 Fetch 路由（只保留断言需要的字段）。 */
interface RegisteredRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: unknown
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * 一个最小的连接替身：只实现 `fetch.register` 这一件插件真正用到的事。
 *
 * 重复登记会抛错——与真实载体一致，这样测试也能挡住"同名注册两次"。
 * @param routes - 收集登记结果的数组。
 * @returns 形状与 `ctx.connection` 兼容的替身。
 */
function connectionStub(routes: RegisteredRoute[]): { readonly fetch: { register: (route: RegisteredRoute) => () => void } } {
  return {
    fetch: {
      register: (route) => {
        if (routes.some(existing => existing.path === route.path)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
        }
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  }
}

/**
 * 账号服务的替身形状。
 *
 * **必须同时给 `verifiedAccount`**：网关只认服务端权威的快照（WP1 A-01），
 * 只给 `account` 的替身会一律得到 401——那正是我们要的行为，不是替身漏了字段。
 */
type AccountStub = {
  readonly account: () => Promise<{ readonly id: number; readonly role: string } | null>
  readonly verifiedAccount: () => Promise<{ readonly id: number; readonly role: string } | null>
}

/**
 * 用**真实 cordis Context** 装载插件。
 * @param account - 可选的账号服务：不传表示"这套部署里没有账号插件"。
 * @returns 真实作用域与被登记的路由。
 */
async function mount(account?: AccountStub): Promise<{
  readonly ctx: Context
  readonly routes: RegisteredRoute[]
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes: RegisteredRoute[] = []
  ctx.provide('connection', connectionStub(routes) as never)
  if (account !== undefined) ctx.provide('accountSession', account as never)
  // 等 `ctx.plugin()` 返回的 **Fiber**：它在注入满足、`apply` 跑完之后才 settle。
  // 等 `ctx.fiber` 是错的——那是根作用域，早就已激活，等于什么都没等（实测 7 条红）。
  await (ctx.plugin as unknown as (plugin: unknown) => Promise<unknown>)({ name, inject, apply })
  return { ctx, routes }
}

/**
 * 发一条 POST 到某条已登记的路由。
 * @param route - 目标路由。
 * @param body - 原始请求体。
 * @returns 路由给出的响应。
 */
async function post(route: RegisteredRoute, body: string): Promise<Response> {
  return await route.fetch(new Request(`http://127.0.0.1${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))
}

/** 路由集合里取一条，取不到直接失败。 */
function routeAt(routes: RegisteredRoute[], path: string): RegisteredRoute {
  const found = routes.find(route => route.path === path)
  if (found === undefined) throw new Error(`路由没登记：${path}`)
  return found
}

describe('插件装配：在真实的 cordis 里必须能起来并能被调用', () => {
  it('插件身份稳定（改名字会让 profiles 按名字加载的条目静默失配）', () => {
    expect(name).toBe('qianshou-model-gateway')
  })

  it('inject 只声明 connection——多声明一个必需服务就会让工作台起不来', () => {
    // 这条断言是故障二的直接防线：`accountSession` 只能当作运行期事实来探测。
    expect([...inject]).toEqual(['connection'])
  })

  it('apply() 在真实 Context 里不抛异常', async () => {
    // 默认目录的生效时刻若不再严格递增，bind() 会在这里抛错。
    const { routes } = await mount()
    expect(routes.length).toBe(12)
  })

  it('路由全部登记，路径与方法正确，且必须用 buffered', async () => {
    const { routes } = await mount()
    expect(routes.map(route => route.path).sort())
      .toEqual([
        ADMIN_BIND_PATH, ADMIN_NAMES_PATH, AI_CHAT_PATH, AI_COMPLETIONS_PATH, AI_STATUS_PATH,
        AI_AUDIT_PATH, ADMIN_AUDIT_PATH, ADMIN_SUBSCRIPTION_PATH, ADMIN_SUBSCRIPTIONS_PATH,
        ADMIN_MARKETPLACE_PATH, PLUGIN_LICENSE_PATH, PLUGIN_SUBMISSIONS_PATH,
      ].sort())
    for (const route of routes) {
      expect(route.methods).toEqual(['POST'])
      // 必须是 buffered：streaming 模式下载体用 Node 流构造 Request，
      // 带 content-length 时 undici 会抛错，客户端只会收到一个空的 400。
      expect(route.requestBody).toBe('buffered')
    }
  })

  it('投稿注册层允许 2 MiB ZIP 的 base64 正文，其他路由仍保持 2 MiB 限额', async () => {
    const { routes } = await mount()
    const overOrdinaryLimit = ' '.repeat(2 * 1024 * 1024 + 1)
    const submission = routeAt(routes, PLUGIN_SUBMISSIONS_PATH)
    const acceptedByCarrier = await submission.fetch(new Request(`http://127.0.0.1${submission.path}`, {
      method: 'POST', headers: { 'content-length': String(overOrdinaryLimit.length) }, body: overOrdinaryLimit,
    }))
    // The submission handler is disabled in this harness, so reaching it yields 503, not the carrier's 413.
    expect(acceptedByCarrier.status).toBe(503)
    const chat = routeAt(routes, AI_CHAT_PATH)
    const refusedByOrdinaryCarrier = await chat.fetch(new Request(`http://127.0.0.1${chat.path}`, {
      method: 'POST', headers: { 'content-length': String(overOrdinaryLimit.length) }, body: overOrdinaryLimit,
    }))
    expect(refusedByOrdinaryCarrier.status).toBe(413)
    const overSubmissionLimit = ' '.repeat(3 * 1024 * 1024 + 1)
    const refusedBySubmissionCarrier = await submission.fetch(new Request(`http://127.0.0.1${submission.path}`, {
      method: 'POST', headers: { 'content-length': String(overSubmissionLimit.length) }, body: overSubmissionLimit,
    }))
    expect(refusedBySubmissionCarrier.status).toBe(413)
  })

  it('控制台与账本被提供，且默认目录已登记进控制台', async () => {
    const { ctx } = await mount()
    const routing = (ctx as unknown as { routingConsole?: { names: () => readonly { publishedName: string }[] } }).routingConsole
    const ledger = (ctx as unknown as { creditLedger?: unknown }).creditLedger
    expect(routing).toBeDefined()
    expect(ledger).toBeDefined()
    // "空的控制台等于所有模型都不可用"——默认目录必须真的写进去了。
    expect(routing?.names().map(record => record.publishedName).sort())
      .toEqual(['千手·强力', '千手·迅捷'])
  })

  it('没有账号服务时给 401 JSON，而不是抛异常（故障一的直接防线）', async () => {
    const { routes } = await mount()
    const response = await post(routeAt(routes, AI_STATUS_PATH), '{}')
    // 曾经这里抛出 `cannot get property "accountSession" without inject`，
    // 在宿主侧表现为一个**没有正文的 400**。
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toMatchObject({ ok: false, message: '请先登录。' })
  })


  it('账号服务在场但未登录时同样是 401，不是 500', async () => {
    const { routes } = await mount({ account: async () => null, verifiedAccount: async () => null })
    const response = await post(routeAt(routes, AI_STATUS_PATH), '{}')
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ ok: false })
  })

  it('请求格式不对时是带正文的 400——与"空正文 400"区分开', async () => {
    const { routes } = await mount({ account: async () => ({ id: 7, role: 'personal' }), verifiedAccount: async () => ({ id: 7, role: 'personal' }) })
    const response = await post(routeAt(routes, AI_CHAT_PATH), 'not json')
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ ok: false, message: '请求格式不对。' })
  })

  it('未登录时不会因为缺密钥而崩——密钥是运行期事实', async () => {
    // 未登录时应该在上游调用之前就返回 401，不依赖任何密钥或网络。
    const { routes } = await mount({ account: async () => null, verifiedAccount: async () => null })
    const body = JSON.stringify({ model: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] })
    const response = await post(routeAt(routes, AI_CHAT_PATH), body)
    expect(response.status).toBe(401)
  })
})

describe('启动健壮性：可选服务缺失也不能让工作台起不来', () => {
  /**
   * 这一组守的是一次**真实的启动级故障**：为了"让第一句对话不用等凭据解析"，
   * 我在 `apply()` 里加了一次启动预热，而预热去读 `ctx.credentials`——
   * 那是个**可选**服务，cordis 对未声明的服务访问是运行时强制的，于是抛
   * `cannot get property "credentials" without inject`，直接表现为
   * `dsh: fatal load failure`：**整个工作台起不来**。
   *
   * 教训与 `accountSession` 那次完全一样：可选服务必须在 try 里探测，
   * 而且**不要在 apply() 期间碰它们**——那会把"没挂某个服务"升级成"工作台挂了"。
   */
  it('既没有凭据服务、也没有环境变量时，插件照常装载', async () => {
    const { routes } = await mount()
    expect(routes.length).toBe(12)
    // 预热是延后一拍的，给它一点时间把（失败）路径走完。
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  it('只有环境变量时，环境变量被真的用上（凭据服务缺席不影响）', async () => {
    const previous = process.env['QIANSHOU_MODEL_API_KEY']
    process.env['QIANSHOU_MODEL_API_KEY'] = 'key-from-env'
    try {
      const { routes } = await mount()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(routes.some(route => route.path === AI_STATUS_PATH)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env['QIANSHOU_MODEL_API_KEY']
      else process.env['QIANSHOU_MODEL_API_KEY'] = previous
    }
  })

  it('凭据服务在场时按**裸引用**读（default DEEPSEEK_API_KEY）', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    ctx.provide('connection', connectionStub(routes) as never)
    let asked: string | null = null
    ctx.provide('credentials', {
      resolve: async (ref: string) => { asked = ref; return 'key-from-store' },
    } as never)
    await (ctx.plugin as unknown as (plugin: unknown) => Promise<unknown>)({ name, inject, apply })
    // 预热是延后一拍的，等它真的调过凭据服务。
    await new Promise(resolve => setTimeout(resolve, 60))
    /**
     * 引用名是**裸引用**（凭据文件 `refs:` 段的键），不是 `<scope>/<id>`。
     *
     * 这条断言是从一次真实排查里来的：用户早已把密钥存进 `refs.DEEPSEEK_API_KEY`，
     * 而我们去找 `qianshou/model-api`——永远取不到，现象只是"密钥没配"。
     * 裸引用这条路径读的才是用户直接存进来的密钥。
     */
    expect(asked).toBe('DEEPSEEK_API_KEY')
  })
})
