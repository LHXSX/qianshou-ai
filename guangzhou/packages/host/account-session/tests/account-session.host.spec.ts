/**
 * 宿主侧账号会话的契约测试（打桩服务端，**不碰真实账号**）。
 *
 * 重点不在"登录能不能成功"，而在**落盘的性质**：口令绝不进文件、文件权限只给本人、
 * 重启后登录态还在、登出后令牌真的消失。这四条任何一条错了都是安全事故，
 * 而它们都看不出来——所以必须由测试盯住。
 */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_STORE_FILENAME, openHostAccount } from '../src/index.ts'

const ORIGIN = 'https://accounts.test'
const TOKENS = { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 7200 }
const ACCOUNT = {
  id: 167, username: 'qianshou-user', email: 'u@example.com', role: 'personal',
  status: 'active', balance: '1912345.00', created_at: '2026-01-01T00:00:00Z', last_login_at: null,
}

const homes: string[] = []
afterEach(() => { homes.length = 0; vi.unstubAllGlobals() })

/** 一个 200 的 JSON 响应。 */
function jsonReply(json: unknown): Response {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 一个临时 HOME，避免动到真实的 `~/.dsh`。 */
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-account-'))
  homes.push(dir)
  return dir
}

/** 打桩上游。 */
function stub(routes: Record<string, { status?: number; json: unknown }>): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(ORIGIN, '')
    const route = routes[path]
    if (route === undefined) {
      return new Response(JSON.stringify({ ok: false, code: 'NOT_STUBBED', message: path }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200, headers: { 'content-type': 'application/json' },
    })
  }
  return vi.fn(impl)
}

describe('凭据落盘：四条不能错的性质', () => {
  it('登录后令牌写入文件，且**口令一个字都不落盘**', async () => {
    const home = await tempHome()
    const session = await openHostAccount({
      dshHome: home,
      baseUrl: ORIGIN,
      fetch: stub({ '/api/v8/auth/login': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } } }),
    })
    await session.client.login({ username: 'qianshou-user', password: 'a-very-secret-password' })

    const path = join(home, ACCOUNT_STORE_FILENAME)
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('refresh-1')
    expect(raw).not.toContain('a-very-secret-password')
    expect(raw).not.toContain('password')
  })

  it('文件权限是 0600：只有本人可读', async () => {
    const home = await tempHome()
    const session = await openHostAccount({
      dshHome: home,
      baseUrl: ORIGIN,
      fetch: stub({ '/api/v8/auth/login': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } } }),
    })
    await session.client.login({ username: 'u', password: 'p' })

    const info = await stat(join(home, ACCOUNT_STORE_FILENAME))
    // 只看权限位：0o600 或更严（0o400）
    expect(info.mode & 0o077).toBe(0)
  })

  it('重启后不必重新登录：用磁盘上的长期凭据换回可用的 access token', async () => {
    const home = await tempHome()
    const fetchImpl = stub({
      '/api/v8/auth/login': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
      '/api/v8/auth/refresh': { json: { ok: true, tokens: { ...TOKENS, access_token: 'access-2' } } },
    })
    const first = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch: fetchImpl })
    await first.client.login({ username: 'u', password: 'p' })

    // 新进程：同一 HOME，全新会话——内存里没有 access token（它刻意不落盘）
    const second = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch: fetchImpl })
    // 必须 `await`：漏掉它就是一个浮动的 Promise，断言会被跳过而测试仍然"通过"。
    await expect(second.ensureAccessToken()).resolves.toBe('access-2')
  })

  it('没有登录过时 ensureAccessToken 返回 null，而不是抛', async () => {
    const home = await tempHome()
    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch: stub({}) })
    expect(await session.ensureAccessToken()).toBeNull()
  })

  it('登出后文件里不再有令牌', async () => {
    const home = await tempHome()
    const session = await openHostAccount({
      dshHome: home,
      baseUrl: ORIGIN,
      fetch: stub({
        '/api/v8/auth/login': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
        '/api/v8/auth/logout': { json: { ok: true } },
      }),
    })
    await session.client.login({ username: 'u', password: 'p' })
    await session.signOut()

    const raw = await readFile(join(home, ACCOUNT_STORE_FILENAME), 'utf8')
    expect(raw).not.toContain('refresh-1')
    expect(await session.ensureAccessToken()).toBeNull()
  })

  it('刷新在途时登出：磁盘上不留下任何长期凭据（WP1 A-17）', async () => {
    const home = await tempHome()
    const storePath = join(home, ACCOUNT_STORE_FILENAME)
    /**
     * 造出那条真实存在的交错，时序是确定的：
     * 1. 先登录 → 内存里有 access token（所以登出请求直接发得出去，不必等刷新）；
     * 2. 起一次刷新，响应卡在闸门上（"刷新在途"）；
     * 3. 用户点登出，整条登出走完（含清盘）；
     * 4. 刷新才回来——早先它会把**新的长期凭据**写回磁盘：用户看到已登出，
     *    磁盘上却留着一枚仍然有效的凭据。
     */
    let releaseRefresh: () => void = () => { /* 下面立刻赋值 */ }
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = url.replace(ORIGIN, '')
      if (path === '/api/v8/auth/login') return jsonReply({ ok: true, tokens: TOKENS, account: ACCOUNT })
      if (path === '/api/v8/auth/refresh') {
        await refreshGate
        return jsonReply({ ok: true, tokens: { ...TOKENS, access_token: 'access-2', refresh_token: 'refresh-2' } })
      }
      if (path === '/api/v8/auth/logout') return jsonReply({ ok: true })
      return new Response(JSON.stringify({ ok: false, code: 'NOT_STUBBED', message: path }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch: fetchImpl })
    await session.client.login({ username: 'u', password: 'p' })
    // 刷新出门了，卡在闸门上。
    const refreshing = session.session.refresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    // 登出整条走完（它用的是内存里那枚 access token，不等刷新）。
    await session.signOut()
    // 现在才让刷新回来。
    releaseRefresh()
    await refreshing
    // 刷新的写入是异步落盘的，给它时间真的去写（如果它还敢写的话）。
    await new Promise(resolve => setTimeout(resolve, 80))

    const raw = await readFile(storePath, 'utf8')
    expect(raw).not.toContain('refresh-2')
    expect(raw).not.toContain('refresh-1')
    expect(JSON.parse(raw)).not.toHaveProperty('refreshToken')
    // 而且状态确实是"已登出"。
    expect(session.state()).toBe('signed-out')
    expect(await session.ensureAccessToken()).toBeNull()
  })

  it('两个读-改-写并发时不丢字段（WP1 A-17：同一路径串行化）', async () => {
    const home = await tempHome()
    const storePath = join(home, ACCOUNT_STORE_FILENAME)
    /**
     * 让两个"读—改—写"**在同一时刻**落到同一个文件上：
     * 刷新的响应与 `/me` 的响应都由同一道闸门放行，于是两次写入几乎同时开始。
     * 没有串行化时两边都会先读到同一份旧内容，后写的那次把对方的字段整体覆盖掉。
     */
    let release: () => void = () => { /* 下面立刻赋值 */ }
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = url.replace(ORIGIN, '')
      if (path === '/api/v8/auth/login') return jsonReply({ ok: true, tokens: TOKENS, account: ACCOUNT })
      if (path === '/api/v8/auth/refresh') {
        await gate
        return jsonReply({ ok: true, tokens: { ...TOKENS, access_token: 'access-2', refresh_token: 'refresh-2' } })
      }
      if (path === '/api/v8/my/profile') {
        await gate
        return jsonReply({ ok: true, account: { ...ACCOUNT, balance: '2000000.00' } })
      }
      return new Response(JSON.stringify({ ok: false, code: 'NOT_STUBBED', message: path }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch: fetchImpl })
    // 先登录：内存里有了 access token，接下来两个操作才都能走到"写盘"那一步。
    await session.client.login({ username: 'u', password: 'p' })
    const loading = session.loadAccount()
    const refreshing = session.session.refresh()
    await new Promise(resolve => setTimeout(resolve, 10))
    release()
    await Promise.all([loading, refreshing])

    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { refreshToken?: unknown; account?: { balance?: unknown } }
    // 两次写入的字段都要在：谁也覆盖不了谁。
    expect(stored.refreshToken).toBe('refresh-2')
    expect(stored.account?.balance).toBe('2000000.00')
  })
})

describe('账号信息：冷启动先显示缓存，再由 /me 校正', () => {
  it('冷启动不联网也知道「上次是谁」，/me 之后再校正一次', async () => {
    const home = await tempHome()
    // 预置一份磁盘缓存，模拟上一轮登录过
    await writeFile(join(home, ACCOUNT_STORE_FILENAME), JSON.stringify({ refreshToken: 'refresh-1', account: ACCOUNT }), { mode: 0o600 })

    // 冷启动内存里没有 access token，受保护请求会**先刷新再重试**——所以 refresh 必须打桩。
    const fetchImpl = stub({
      '/api/v8/auth/refresh': { json: { ok: true, tokens: TOKENS } },
      '/api/v8/my/profile': { json: { ok: true, account: { ...ACCOUNT, balance: '2000000.00' } } },
    })
    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch: fetchImpl })

    // 冷启动：来自磁盘，不需要网络
    expect(session.account()?.username).toBe('qianshou-user')

    const refreshed = await session.loadAccount()
    expect(refreshed.ok).toBe(true)
    expect(refreshed.failure).toBeNull()
    expect(refreshed.account?.balance).toBe('2000000.00')
    expect(session.account()?.balance).toBe('2000000.00')
  })

  it('文件损坏时当没登录，而不是崩', async () => {
    const home = await tempHome()
    await writeFile(join(home, ACCOUNT_STORE_FILENAME), '{ 这不是 JSON', { mode: 0o600 })
    const session = await openHostAccount({ dshHome: home, baseUrl: ORIGIN, fetch: stub({}) })
    expect(session.account()).toBeNull()
    // `ensureAccessToken` 是异步的（要先 hydrate 磁盘再判断），必须 await——
    // 漏了 await 就是一个浮动的 Promise，断言会被跳过而测试仍然"通过"。
    expect(await session.ensureAccessToken()).toBeNull()
  })

  it('/me 失败不把用户登出：网络问题也会走到这条路径', async () => {
    const home = await tempHome()
    await writeFile(join(home, ACCOUNT_STORE_FILENAME), JSON.stringify({ refreshToken: 'refresh-1', account: ACCOUNT }), { mode: 0o600 })
    const session = await openHostAccount({
      dshHome: home,
      baseUrl: ORIGIN,
      fetch: stub({
        '/api/v8/auth/refresh': { json: { ok: true, tokens: TOKENS } },
        '/api/v8/my/profile': { status: 500, json: { ok: false, code: 'INTERNAL_ERROR' } },
      }),
    })
    const outcome = await session.loadAccount()
    // 失败必须**带原因**：后端 500 与"没登录"是两件事（WP1 A-19）。
    expect(outcome.ok).toBe(false)
    expect(outcome.account).toBeNull()
    expect(outcome.failure?.kind).toBe('server-error')
    // 账号缓存与令牌都还在
    expect(session.account()?.username).toBe('qianshou-user')
  })
})
