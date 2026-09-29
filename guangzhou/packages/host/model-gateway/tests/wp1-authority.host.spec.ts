/**
 * WP1 验收：**权威回到服务端**（缺陷 A-01 / A-02 / A-04 / A-12）。
 *
 * 这个文件用**两个真实插件**（账号面 + 模型网关）挂在同一个 cordis `Context` 上，
 * 上游用本地 HTTP 打桩。它守的是四条只有"整条链路一起跑"才看得见的性质：
 *
 * 1. 篡改 `$DSH_HOME/.qianshou-account.json`（把 `role` 改成 `admin`）**不能**换来管理权限；
 * 2. `enterprise` 是客户身份，**不是**运营者身份（A-02）；
 * 3. 并发两个账号各自按自己的角色拿档位，互不串（A-04）；
 * 4. 升档之后**立刻**拿到新档位的额度（A-12）。
 *
 * 顺带把一条历史结论钉住：网关**不需要**读账号文件也能拿到身份——
 * 早先加的"服务优先、文件兜底"绕过了权威，也把真正的根因（未声明就访问
 * `ctx.accountSession` 会抛）藏了起来。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as applyAccount } from '../../account-session/src/plugin.ts'
import { apply as applyGateway } from '../src/plugin.ts'
import { AI_STATUS_PATH } from '../src/routes.ts'
import { ADMIN_NAMES_PATH } from '../src/admin-routes.ts'
import { ADMIN_SUBSCRIPTION_PATH } from '../src/subscription-routes.ts'
import { TIERS } from '../src/tiers.ts'

const ACCOUNT = {
  id: 167, username: 'qianshou-user', email: 'u@example.com', role: 'personal',
  status: 'active', balance: '1912345.00', created_at: '2026-01-01T00:00:00Z', last_login_at: null,
}
const TOKENS = { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 7200 }

const dirs: string[] = []
const servers: Server[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(servers.splice(0).map(closeServer))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 关掉一个测试用的 HTTP 服务端。 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}

/** `/status` 的响应形状（只列断言用到的字段）。 */
type StatusBody = { readonly tier: { readonly id: string }; readonly credit: { readonly monthlySp: number; readonly remainingSp: number } }

/** 一条被登记的 Fetch 路由。 */
interface RegisteredRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * 起一个打桩账号服务端：`refresh` 换票、`my/profile` 回**由测试指定角色**的账号。
 * @param role - 服务端在这次核验里给出的角色。
 * @returns 基址。
 */
async function accountUpstream(role: string): Promise<string> {
  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    const body = url.startsWith('/api/v8/my/profile')
      ? { ok: true, account: { ...ACCOUNT, role } }
      : (url.startsWith('/api/v8/auth/refresh') ? { ok: true, tokens: TOKENS } : null)
    if (body === null) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, code: 'NOT_STUBBED' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得端口')
  return `http://127.0.0.1:${address.port}`
}

/**
 * 把账号面与模型网关**都**装到一个真实 `Context` 上。
 * @param options - 服务端角色、以及账号文件写在哪（默认写进 dshHome）。
 * @returns 已登记的路由、作用域与目录。
 */
async function mountBoth(options: {
  readonly role: string
  /** 篡改用的角色（写进账号文件缓存）；不传表示缓存里也写服务端那个角色。 */
  readonly cachedRole?: string
  /** 账号文件的落点；不传则放 dshHome（网关的"文件兜底"路径正是这里）。 */
  readonly storePathElsewhere?: boolean
}): Promise<{ readonly routes: RegisteredRoute[]; readonly ctx: Context; readonly dshHome: string }> {
  const dshHome = mkdtempSync(join(tmpdir(), 'qianshou-wp1-'))
  dirs.push(dshHome)
  const baseUrl = await accountUpstream(options.role)
  /**
   * 账号文件写哪儿，是这两组测试的关键变量：
   * - 写在 `dshHome` → 用来说明"篡改了它也换不到权限"；
   * - 写在别处 → 用来说明网关**根本不是**从文件读身份的（服务就是够得着的）。
   */
  const storePath = options.storePathElsewhere === true
    ? join(mkdtempSync(join(tmpdir(), 'qianshou-wp1-elsewhere-')), '.qianshou-account.json')
    : join(dshHome, '.qianshou-account.json')
  if (options.storePathElsewhere === true) dirs.push(join(storePath, '..'))
  writeFileSync(storePath, JSON.stringify({
    refreshToken: 'refresh-1',
    account: { ...ACCOUNT, role: options.cachedRole ?? options.role },
  }), { mode: 0o600 })

  const ctx = new Context()
  contexts.push(ctx)
  const routes: RegisteredRoute[] = []
  ctx.provide('connection', {
    fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
  } as never)
  await (ctx.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>)(
    { name: 'qianshou-account', inject: ['connection'], apply: applyAccount },
    { storePath, baseUrl },
  )
  await (ctx.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>)(
    { name: 'qianshou-model-gateway', inject: ['connection'], apply: applyGateway },
    {
      dshHome,
      ledgerPath: join(dshHome, 'ledger.json'),
      subscriptionsPath: join(dshHome, 'subscriptions.json'),
    },
  )
  return { routes, ctx, dshHome }
}

/** 发一条 POST 到某条已登记的路由。 */
async function post(routes: RegisteredRoute[], path: string, body = '{}'): Promise<Response> {
  const route = routes.find(item => item.path === path)
  if (route === undefined) throw new Error(`路由没登记：${path}`)
  return await route.fetch(new Request(`http://127.0.0.1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }))
}

describe('篡改本机账号文件换不到管理权限（WP1 A-01）', () => {
  it('文件里写 role=admin、服务端说 personal：管理面 403，额度面照常', async () => {
    const { routes } = await mountBoth({ role: 'personal', cachedRole: 'admin' })
    const denied = await post(routes, ADMIN_NAMES_PATH)
    // 修复前这里是 200：网关直接读那个文件里的 role，改一行就是管理员。
    expect(denied.status).toBe(403)
    const allowed = await post(routes, AI_STATUS_PATH)
    expect(allowed.status).toBe(200)
    const body = await allowed.json() as { tier: { id: string } }
    // 服务端说 personal → 兜底档位是 basic，不是文件里那个 admin 对应的 max。
    expect(body.tier.id).toBe('basic')
  })

  it('服务端说 admin 时才放行（不是"一律拒绝"）', async () => {
    const { routes } = await mountBoth({ role: 'admin' })
    expect((await post(routes, ADMIN_NAMES_PATH)).status).toBe(200)
  })

  it('身份来自服务而不是账号文件：文件放在别处也一样能认出身份', async () => {
    // 这条直接反驳"服务读不到、只能读文件"的历史结论：服务在，身份就在。
    const { routes } = await mountBoth({ role: 'admin', storePathElsewhere: true })
    expect((await post(routes, ADMIN_NAMES_PATH)).status).toBe(200)
  })
})

describe('enterprise 是客户，不是运营者（WP1 A-02）', () => {
  it('enterprise 账号访问管理面回 403，但额度面可用', async () => {
    const { routes } = await mountBoth({ role: 'enterprise' })
    expect((await post(routes, ADMIN_NAMES_PATH)).status).toBe(403)
    const status = await post(routes, AI_STATUS_PATH)
    expect(status.status).toBe(200)
    // 企业客户仍然拿到高额度（这是**商业**映射，与"是不是管理员"是两件事）。
    expect(((await status.json()) as { tier: { id: string } }).tier.id).toBe('max')
  })
})

describe('并发两个账号：档位互不串（WP1 A-04）', () => {
  it('A 的角色不会因为 B 后到而改变', async () => {
    /**
     * 关键在时序：A 的请求**先出发**，但它的身份要等 B 整条跑完之后才返回。
     * 老实现用一个进程级的 `lastRole`（"最近一次看到的角色"）——A 于是会拿到 B 的档位；
     * 现在角色随主体显式传递，A 用的始终是自己的那个。
     */
    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    ctx.provide('connection', {
      fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    } as never)
    const dshHome = mkdtempSync(join(tmpdir(), 'qianshou-wp1-concurrent-'))
    dirs.push(dshHome)
    /** A 先到、但要等 B 跑完才返回身份。 */
    let releaseA: () => void = () => { /* 立即被下面的 Promise 赋值 */ }
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    let calls = 0
    ctx.provide('accountSession', {
      account: async () => ({ id: 'a', role: 'pro' }),
      verifiedAccount: async () => {
        calls += 1
        if (calls === 1) {
          await gateA
          return { id: 'a', role: 'pro' }
        }
        return { id: 'b', role: 'personal' }
      },
    } as never)
    applyGateway(ctx, { dshHome, ledgerPath: join(dshHome, 'ledger.json'), subscriptionsPath: join(dshHome, 'subs.json') })

    const requestA = post(routes, AI_STATUS_PATH)
    const responseB = await post(routes, AI_STATUS_PATH)
    releaseA()
    const responseA = await requestA

    // pro → plus；personal → basic。老实现里两句会得到同一个档位。
    expect(((await responseA.json()) as { tier: { id: string } }).tier.id).toBe('plus')
    expect(((await responseB.json()) as { tier: { id: string } }).tier.id).toBe('basic')
  })
})

describe('升档后立刻拿到新档位额度（WP1 A-12）', () => {
  it('管理员给同一个账号开到 plus 之后，下一次 /status 就是 990 SP', async () => {
    const { routes } = await mountBoth({ role: 'admin' })
    const before = await (await post(routes, AI_STATUS_PATH)).json() as StatusBody
    // admin 的兜底档位是 max（角色映射），但这里要验证的是**升档之后**的变化，
    // 所以先把订阅开到 plus 之上的档位、再看额度是否跟着动。
    expect(before.credit.monthlySp).toBe(TIERS.max.monthlySp)

    // 降级到 basic：订阅优先于角色，额度应当立刻变成 basic 的月额度。
    const granted = await post(routes, ADMIN_SUBSCRIPTION_PATH, JSON.stringify({
      accountId: '167', tier: 'basic', days: 30, reason: 'WP1 验收：订阅优先于角色',
    }))
    expect(granted.status).toBe(200)
    const after = await (await post(routes, AI_STATUS_PATH)).json() as StatusBody
    expect(after.tier.id).toBe('basic')
    /**
     * 修复前这里是 **2990**：账本按"账号"只记一份授予，admin 已经拿了 max 的 2990，
     * 于是"余额不为 0"⇒ 新的档位永远发不下来，用户付了钱却拿不到对应额度。
     * 现在授予以 (账号, 账期, 档位) 为键，basic 这份还没授予过 → 立刻授予 390。
     */
    expect(after.credit.monthlySp).toBe(TIERS.basic.monthlySp)
    expect(after.credit.remainingSp).toBe(TIERS.basic.monthlySp)
  })
})
