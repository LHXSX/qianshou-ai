/**
 * 账号面的插件级契约测试：**状态码、身份闸门、错误透出**（WP1 A-01 / A-16 / A-19）。
 *
 * 为什么必须测这一层而不是只测库：这三条缺陷都只在"HTTP 响应长什么样"上才看得见——
 * 库返回 `null` 与返回 `{ok:false, failure}` 在类型上都合法，但前者让界面把
 * "后端连不上"显示成"请先登录"。只有真的发一次请求、看一次状态码，才守得住。
 *
 * 上游一律打桩（本地 HTTP 服务），不碰真实账号。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCOUNT_STORE_FILENAME } from '../src/index.ts'
import { apply, inject, name } from '../src/plugin.ts'

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

/** 一个临时目录。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianshou-account-plugin-'))
  dirs.push(dir)
  return dir
}

/** 关掉一个测试用的 HTTP 服务端。 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}

/** 一条被登记的 Fetch 路由。 */
interface RegisteredRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * 起一个打桩上游。
 * @param answer - 按路径给响应；返回 `null` 表示按 404 处理。
 * @returns 基址。
 */
async function upstream(answer: (path: string) => { readonly status: number; readonly json: unknown } | null): Promise<string> {
  const server = createServer((request, response) => {
    const found = answer(request.url ?? '/')
    if (found === null) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, code: 'NOT_STUBBED' }))
      return
    }
    response.writeHead(found.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(found.json))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未能取得端口')
  return `http://127.0.0.1:${address.port}`
}

/**
 * 挂载账号插件。
 * @param config - 基址与凭据文件路径。
 * @returns 已登记的路由、真实作用域与访问 `accountSession` 服务的入口。
 */
async function mount(config: { readonly baseUrl: string; readonly storePath: string }): Promise<{
  readonly routes: RegisteredRoute[]
  readonly ctx: Context
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes: RegisteredRoute[] = []
  ctx.provide('connection', {
    fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
  } as never)
  // 第二个参数是插件配置；`ctx.plugin` 的签名对 `as never` 的插件收窄得太紧，这里显式放宽。
  await (ctx.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>)({ name, inject, apply }, config)
  return { routes, ctx }
}

/** 发一条 POST 到某条已登记的路由。 */
async function post(routes: RegisteredRoute[], path: string, body = '{}'): Promise<Response> {
  const route = routes.find(item => item.path === path)
  if (route === undefined) throw new Error(`路由没登记：${path}`)
  return await route.fetch(new Request(`http://127.0.0.1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }))
}

/** 账号的对外形状。 */
type AccountShape = { readonly id: number | string; readonly role: string }

/** 读 `accountSession` 服务（插件通过 `ctx.provide` 暴露给同进程的其它插件）。 */
interface ExposedService {
  readonly account: () => Promise<AccountShape | null>
  readonly verifiedAccount: (options?: { readonly maxAgeMs?: number }) => Promise<AccountShape | null>
  readonly ensureAccessToken: () => Promise<string | null>
}

/** 取账号服务；取不到直接失败（说明插件没暴露它，那是集成故障）。 */
async function serviceOf(ctx: Context): Promise<ExposedService> {
  // 等服务就绪：`provide` 发生在 `apply` 期间，而 `ctx.plugin()` 已经 await 过 apply。
  const found = (ctx as unknown as { get: (name: string) => unknown }).get('accountSession')
  if (found === undefined || found === null) throw new Error('accountSession 服务没被提供')
  return found as ExposedService
}

describe('/me：后端不可达必须回 5xx，不能回 401（WP1 A-19）', () => {
  it('已登录但上游连不上时回 502，文案是"网络"而不是"请先登录"', async () => {
    const dir = tempDir()
    const storePath = join(dir, ACCOUNT_STORE_FILENAME)
    // **必须是一台"登录过"的机器**：冷启动的第一次受保护请求会拿磁盘上的长期凭据去续期。
    // 没有凭据时"请先登录"才是实话（下面那条测试守的就是它）。
    writeFileSync(storePath, JSON.stringify({ refreshToken: 'refresh-1', account: ACCOUNT }), { mode: 0o600 })
    // 指一个必然连不上的端口：1 号端口不会有人监听。
    const { routes } = await mount({ baseUrl: 'http://127.0.0.1:1', storePath })
    const response = await post(routes, '/api/qianshou/account/me')
    // 修复前这里也是 401——用户于是去重输口令，而真正的问题是网络。
    expect(response.status).toBe(502)
    const body = await response.json() as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message).not.toContain('请先登录')
  })

  it('从未登录过时回 401（不能把"没凭据"说成"网络不通"）', async () => {
    const dir = tempDir()
    const { routes } = await mount({ baseUrl: 'http://127.0.0.1:1', storePath: join(dir, ACCOUNT_STORE_FILENAME) })
    expect((await post(routes, '/api/qianshou/account/me')).status).toBe(401)
  })

  it('上游明确 401 时才是 401', async () => {
    const dir = tempDir()
    const baseUrl = await upstream(path => path.startsWith('/api/v8/my/profile')
      ? { status: 401, json: { ok: false, code: 'AUTH_TOKEN_INVALID', message: '登录状态已过期' } }
      : (path.startsWith('/api/v8/auth/refresh') ? { status: 401, json: { ok: false, code: 'AUTH_TOKEN_INVALID' } } : null))
    const { routes } = await mount({ baseUrl, storePath: join(dir, ACCOUNT_STORE_FILENAME) })
    expect((await post(routes, '/api/qianshou/account/me')).status).toBe(401)
  })
})

describe('非账号异常不许透出（WP1 A-16）', () => {
  it('文件系统错误回 500 + 固定文案，不带路径也不带系统错误码', async () => {
    const dir = tempDir()
    // 把凭据文件的**父目录**做成一个普通文件：mkdir 会 ENOTDIR，这不是 AccountFailure。
    const blocked = join(dir, 'not-a-directory')
    writeFileSync(blocked, 'x', { mode: 0o600 })
    const baseUrl = await upstream(path => path.startsWith('/api/v8/my/profile')
      ? { status: 200, json: { ok: true, account: ACCOUNT } }
      : (path.startsWith('/api/v8/auth/refresh') ? { status: 200, json: { ok: true, tokens: TOKENS } } : null))
    const { routes } = await mount({ baseUrl, storePath: join(blocked, 'inner', ACCOUNT_STORE_FILENAME) })
    const response = await post(routes, '/api/qianshou/account/me')
    expect(response.status).toBe(500)
    const body = await response.json() as { message: string }
    expect(body.message).toBe('操作没成功，请稍后再试。')
    // 修复前这里会带出 `ENOTDIR: not a directory, mkdir '/…/not-a-directory/inner'`。
    expect(body.message).not.toContain('ENOTDIR')
    expect(body.message).not.toContain(blocked)
  })
})

describe('accountSession 服务：身份只在已登录时给出（WP1 A-01）', () => {
  it('冷启动（未认证）时 account() 为 null，磁盘上有账号快照也不算', async () => {
    const dir = tempDir()
    const storePath = join(dir, ACCOUNT_STORE_FILENAME)
    writeFileSync(storePath, JSON.stringify({ refreshToken: 'refresh-1', account: ACCOUNT }), { mode: 0o600 })
    const { ctx } = await mount({ baseUrl: 'http://127.0.0.1:1', storePath })
    const service = await serviceOf(ctx)
    // 快照仍可用于展示（HTTP /state），但**服务**这一份是授权依据，未认证就不给。
    expect(await service.account()).toBeNull()
  })

  it('在线核验过后 account() 才给出身份，且角色来自服务端', async () => {
    const dir = tempDir()
    const storePath = join(dir, ACCOUNT_STORE_FILENAME)
    writeFileSync(storePath, JSON.stringify({ refreshToken: 'refresh-1', account: { ...ACCOUNT, role: 'admin' } }), { mode: 0o600 })
    const baseUrl = await upstream(path => path.startsWith('/api/v8/my/profile')
      ? { status: 200, json: { ok: true, account: { ...ACCOUNT, role: 'personal' } } }
      : (path.startsWith('/api/v8/auth/refresh') ? { status: 200, json: { ok: true, tokens: TOKENS } } : null))
    const { ctx } = await mount({ baseUrl, storePath })
    const service = await serviceOf(ctx)
    const verified = await service.verifiedAccount()
    // 磁盘上写的是 admin，服务端说的是 personal —— 以服务端为准。
    expect(verified?.role).toBe('personal')
    expect((await service.account())?.role).toBe('personal')
  })

  it('核验失败时 verifiedAccount() 为 null（不退回磁盘上的角色）', async () => {
    const dir = tempDir()
    const storePath = join(dir, ACCOUNT_STORE_FILENAME)
    writeFileSync(storePath, JSON.stringify({ refreshToken: 'refresh-1', account: { ...ACCOUNT, role: 'admin' } }), { mode: 0o600 })
    // 上游 500：核验不通过。
    const baseUrl = await upstream(path => path.startsWith('/api/v8/my/profile')
      ? { status: 500, json: { ok: false, code: 'INTERNAL_ERROR' } }
      : (path.startsWith('/api/v8/auth/refresh') ? { status: 200, json: { ok: true, tokens: TOKENS } } : null))
    const { ctx } = await mount({ baseUrl, storePath })
    const service = await serviceOf(ctx)
    expect(await service.verifiedAccount()).toBeNull()
  })

  it('同进程插件可以拿到 access token；从未登录时返回 null', async () => {
    const dir = tempDir()
    const unsigned = await mount({ baseUrl: 'http://127.0.0.1:1', storePath: join(dir, ACCOUNT_STORE_FILENAME) })
    expect(await (await serviceOf(unsigned.ctx)).ensureAccessToken()).toBeNull()

    const storePath = join(tempDir(), ACCOUNT_STORE_FILENAME)
    writeFileSync(storePath, JSON.stringify({ refreshToken: 'refresh-1', account: ACCOUNT }), { mode: 0o600 })
    const baseUrl = await upstream(path => path.startsWith('/api/v8/auth/refresh')
      ? { status: 200, json: { ok: true, tokens: TOKENS } }
      : (path.startsWith('/api/v8/my/profile') ? { status: 200, json: { ok: true, account: ACCOUNT } } : null))
    const signed = await mount({ baseUrl, storePath })
    expect(await (await serviceOf(signed.ctx)).ensureAccessToken()).toBe(TOKENS.access_token)
  })
})
