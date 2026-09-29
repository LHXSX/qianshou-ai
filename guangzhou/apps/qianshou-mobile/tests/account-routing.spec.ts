// @vitest-environment jsdom
/**
 * 「账号请求经电脑走」的契约测试。
 *
 * 这条通路存在的唯一原因：上游的跨域白名单只放行 `localhost` 与它自己的域，
 * 手机端那个公网预览域会被浏览器**在请求发出前**拦掉，用户看到的是「连不上账号服务器」。
 * 宿主进程不受同源策略约束，所以经电脑走是手机上唯一能通的路。
 *
 * 三条必须成立的性质：
 * 1. **电脑可用时，一个直连请求都不发**（否则还是会被拦，等于没接）。
 * 2. **电脑不可用时退回直连**，不静默失败——那时至少还能给出「被拦掉了」的真实原因。
 * 3. **凭据不外流**：路由层只借用工作台客户端发请求，不把它的会话 cookie 交给账号层。
 */
import { describe, expect, it, vi } from 'vitest'
import { openAccount } from '../src/account.ts'
import type { WorkbenchClient } from '../src/workbench.ts'
import { installStorage } from './storage.ts'

const ORIGIN = 'https://accounts.test'
const TOKENS = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 7200 }
const ACCOUNT = {
  id: 167, username: 'u', email: 'u@example.com', role: 'personal',
  status: 'active', balance: '1', created_at: null, last_login_at: null,
}

/** 一个假装已连接的工作台客户端，记录被请求的路径。 */
function fakePc(connected = true): { client: WorkbenchClient; paths: string[]; handled: () => number } {
  const paths: string[] = []
  let handled = 0
  const client = {
    get connected() { return connected },
    request: vi.fn(async (path: string) => {
      paths.push(path)
      handled += 1
      if (path.endsWith('/auth/login')) {
        return new Response(JSON.stringify({ ok: true, tokens: TOKENS, account: ACCOUNT }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (path.endsWith('/my/profile')) {
        return new Response(JSON.stringify({ ok: true, account: ACCOUNT }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  } as unknown as WorkbenchClient
  return { client, paths, handled: () => handled }
}

describe('账号请求的路由', () => {
  it('电脑可用时，登录请求全走电脑，**一个直连都不发**', async () => {
    installStorage()
    const pc = fakePc()
    const direct = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const service = openAccount({ baseUrl: ORIGIN, fetch: direct as unknown as typeof fetch, pc: { client: pc.client } })

    expect(service.snapshot().route).toBe('via-pc')
    await service.client.login({ username: 'u', password: 'p' })

    expect(direct).not.toHaveBeenCalled()
    expect(pc.paths.some(p => p.endsWith('/api/v8/auth/login'))).toBe(true)
  })

  it('电脑没连上时退回直连，并如实报告走的是直连', async () => {
    installStorage()
    const pc = fakePc(false)
    const direct = vi.fn(async () => new Response(JSON.stringify({ ok: true, tokens: TOKENS, account: ACCOUNT }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const service = openAccount({ baseUrl: ORIGIN, fetch: direct as unknown as typeof fetch, pc: { client: pc.client } })

    await service.client.login({ username: 'u', password: 'p' })

    expect(direct).toHaveBeenCalled()
    expect(pc.handled()).toBe(0)
  })

  it('完全没给电脑时是直连（保持原有行为）', () => {
    installStorage()
    const service = openAccount({ baseUrl: ORIGIN, fetch: vi.fn() as unknown as typeof fetch })
    expect(service.snapshot().route).toBe('direct')
  })

  it('经电脑走的路径保留完整查询串与路径，不被截断', async () => {
    installStorage()
    const pc = fakePc()
    const service = openAccount({ baseUrl: ORIGIN, fetch: vi.fn() as unknown as typeof fetch, pc: { client: pc.client } })
    await service.client.login({ username: 'u', password: 'p' })
    // 路径必须以 /api/v8 打头——工作台的账号路由就挂在那里；截错前缀会变成 404。
    for (const path of pc.paths) expect(path.startsWith('/api/v8/')).toBe(true)
  })

  it('电脑把失败原样交回来时，错误里不出现口令', async () => {
    installStorage()
    const client = {
      get connected() { return true },
      request: vi.fn(async () => new Response(JSON.stringify({
        ok: false, code: 'AUTH_TOKEN_INVALID', message: '用户名或密码错误',
      }), { status: 401, headers: { 'content-type': 'application/json' } })),
    } as unknown as WorkbenchClient
    const service = openAccount({ baseUrl: ORIGIN, fetch: vi.fn() as unknown as typeof fetch, pc: { client } })

    const failure = await service.client.login({ username: 'u', password: 'super-secret-9f3a' }).catch((error: unknown) => error)
    expect(String(failure)).toContain('用户名或密码错误')
    expect(JSON.stringify(failure)).not.toContain('super-secret-9f3a')
    expect(JSON.stringify(localStorage)).not.toContain('super-secret-9f3a')
  })
})
