// @vitest-environment jsdom
/**
 * 账号屏的端到端契约（打桩服务端，**不碰真实账号**）。
 *
 * 验证的是「用户点了会发生什么」这条链：输入 → 提交 → 令牌落盘 → `/me` 拉到账号 →
 * 界面切走。以及两个最容易做错的分支：**2FA 补验**与**注册后不假装已登录**。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAccount } from '../src/account.ts'
import { AuthScreen } from '../src/auth-screen.tsx'
import { installStorage } from './storage.ts'

const ORIGIN = 'https://accounts.test'

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
  vi.unstubAllGlobals()
})

/** 一次可观测的假上游。 */
interface Stub {
  readonly fetch: typeof fetch
  readonly calls: string[]
  readonly bodies: unknown[]
}

/**
 * 造一个假的上游账号接口。
 * @param routes - 路径（不含基址）到响应的映射。
 * @returns 假 fetch 与调用记录。
 */
function stubServer(routes: Record<string, { status?: number; json: unknown }>): Stub {
  const calls: string[] = []
  const bodies: unknown[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(ORIGIN, '')
    calls.push(path)
    if (typeof init?.body === 'string') {
      try { bodies.push(JSON.parse(init.body)) } catch { bodies.push(init.body) }
    }
    const route = routes[path]
    if (route === undefined) {
      return new Response(JSON.stringify({ ok: false, code: 'NOT_STUBBED', message: `未打桩: ${path}` }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: impl, calls, bodies }
}

const TOKENS = { access_token: 'a-token', refresh_token: 'r-token', token_type: 'Bearer', expires_in: 7200 }
const ACCOUNT = {
  id: 167, username: 'qianshou-user', email: 'u@example.com', role: 'personal',
  status: 'active', balance: '1912345.00', created_at: '2026-01-01T00:00:00Z', last_login_at: null,
}

/** 挂载账号屏；`onDone` 记录是否被调用。 */
async function mount(stub: Stub, location = { protocol: 'https:', hostname: 'app.test' }): Promise<{ done: () => number }> {
  installStorage()
  let doneCalls = 0
  const service = openAccount({ fetch: stub.fetch, baseUrl: ORIGIN, location })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  const Screen: FC = () => createElement(AuthScreen, {
    service,
    onDone: () => { doneCalls += 1 },
    onBack: () => { /* 断言不涉及返回 */ },
  })
  await act(async () => { mounted.render(createElement(Screen)) })
  return { done: () => doneCalls }
}

/** 往第 n 个输入框里打字（受控组件要走原生 setter）。 */
async function type(index: number, value: string): Promise<void> {
  const inputs = container!.querySelectorAll('input')
  const node = inputs[index]
  if (node === undefined) throw new Error(`没有第 ${index} 个输入框`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 点掉按钮。 */
async function click(match: string): Promise<void> {
  const button = [...container!.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === match)
  if (button === undefined) {
    const inputs = [...container!.querySelectorAll('input')].map(i => `${i.type}${i.disabled ? '(disabled)' : ''}`).join(', ')
    throw new Error(`找不到按钮「${match}」；现有按钮：${[...container!.querySelectorAll('button')].map(b => `${b.textContent?.trim()}${b.disabled ? '(disabled)' : ''}`).join(' | ')}；输入框：${inputs}`)
  }
  await act(async () => { button.click() })
  await act(async () => { await Promise.resolve() })
}

describe('登录：口令对了就拿令牌并拉账号', () => {
  it('令牌写进本机，账号从 /my/profile 读出来，界面切走', async () => {
    const stub = stubServer({
      '/api/v8/auth/login': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
      '/api/v8/my/profile': { json: { ok: true, account: ACCOUNT } },
    })
    const { done } = await mount(stub)
    await type(0, 'qianshou-user')
    await type(1, 'the-password')
    await click('登录')

    expect(stub.calls).toContain('/api/v8/auth/login')
    expect(stub.calls).toContain('/api/v8/my/profile')
    expect(done()).toBe(1)
    // https 下 cookie 可用：长期凭据由 httpOnly cookie 承载，**刻意不重复写本地**
    // （多一份本地副本就多一个泄露面）。http 下的情形见下面那条用例。
    expect(localStorage.getItem('qianshou.mobile.account.refresh.v1')).toBeNull()
    // 口令只出现在请求体里，不落任何存储
    expect(JSON.stringify(localStorage)).not.toContain('the-password')
  })

  it('口令错误时说清楚，并且**不**把用户当成已登录', async () => {
    const stub = stubServer({
      '/api/v8/auth/login': {
        status: 401,
        json: { ok: false, code: 'AUTH_TOKEN_INVALID', message: '用户名或密码错误', trace_id: 't' },
      },
    })
    const { done } = await mount(stub)
    await type(0, 'qianshou-user')
    await type(1, 'wrong')
    await click('登录')

    expect(done()).toBe(0)
    expect(container!.textContent).toContain('用户名或密码错误')
    expect(localStorage.getItem('qianshou.mobile.account.refresh.v1')).toBeNull()
    // 口令提交后立刻清空，不留在输入框里
    expect((container!.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('')
  })
})

describe('2FA：口令对了但还要补验', () => {
  it('先出验证码框，补验成功后拿到令牌', async () => {
    const stub = stubServer({
      '/api/v8/auth/login': {
        json: {
          ok: true, two_factor_required: true, challenge_token: 'challenge-1',
          challenge_expires_in: 300, account_id: 167, available_methods: ['totp'], default_method: 'totp',
        },
      },
      '/api/v8/auth/login/totp': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
      '/api/v8/my/profile': { json: { ok: true, account: ACCOUNT } },
    })
    const { done } = await mount(stub)
    await type(0, 'qianshou-user')
    await type(1, 'the-password')
    await click('登录')

    // 停在验证码那一步，而不是"登录成功但进不去"
    expect(container!.textContent).toContain('两步验证')
    expect(done()).toBe(0)

    await type(0, '123456')
    await click('验证')

    expect(stub.calls).toContain('/api/v8/auth/login/totp')
    const totpBody = stub.bodies.find(b => typeof b === 'object' && b !== null && 'challenge_token' in b) as Record<string, unknown>
    expect(totpBody['challenge_token']).toBe('challenge-1')
    expect(done()).toBe(1)
  })
})

describe('注册：不假装已经登录', () => {
  it('注册成功后切到登录页，并提示用刚设的账号登录', async () => {
    const stub = stubServer({
      '/api/v8/auth/register': { json: { ok: true, account: ACCOUNT } },
    })
    const { done } = await mount(stub)
    await click('还没有账号？去注册')
    // 注册表单是三个框：账号、邮箱（可选）、密码——密码是第 3 个。
    await type(0, 'brand-new')
    await type(2, 'a-new-password')
    await click('注册')

    expect(stub.calls).toContain('/api/v8/auth/register')
    expect(done()).toBe(0)
    expect(container!.textContent).toContain('账号已创建')
    // 回到登录态：按钮又变成「登录」
    expect([...container!.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === '登录')).toBe(true)
  })
})

describe('本机存储与 cookie 的取舍要如实', () => {
  it('http 下 cookie 不可用：长期凭据必须落本地，否则刷新活不过关页面', async () => {
    const stub = stubServer({
      '/api/v8/auth/login': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
      '/api/v8/my/profile': { json: { ok: true, account: ACCOUNT } },
    })
    const { done } = await mount(stub, { protocol: 'http:', hostname: '203.0.113.20' })
    await type(0, 'qianshou-user')
    await type(1, 'the-password')
    await click('登录')

    expect(done()).toBe(1)
    expect(localStorage.getItem('qianshou.mobile.account.refresh.v1')).toBe('r-token')
  })

  it('http 下明说 cookie 不可用、登录状态只能存本地', async () => {
    const stub = stubServer({})
    await mount(stub, { protocol: 'http:', hostname: '203.0.113.20' })
    expect(container!.textContent).toContain('httpOnly cookie')
    expect(container!.textContent).toContain('https')
  })

  it('https 下不出现这条说明', async () => {
    const stub = stubServer({})
    await mount(stub, { protocol: 'https:', hostname: 'app.test' })
    expect(container!.textContent).not.toContain('httpOnly cookie')
  })
})

describe('手机号验证码：真实上海合同', () => {
  it('只有短信服务确认发送后才提示，登录令牌成立后才进入账号', async () => {
    const stub = stubServer({
      '/api/v8/auth/sms/send': { json: { ok: true, phone: '138****8888', purpose: 'login', expires_in: 300, resend_after: 60 } },
      '/api/v8/auth/login/phone': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
      '/api/v8/my/profile': { json: { ok: true, account: ACCOUNT } },
    })
    const { done } = await mount(stub)
    await click('手机验证码')
    await type(0, '13800138888')
    await click('获取验证码')
    expect(container!.textContent).toContain('验证码已发送至 138****8888')
    expect(stub.bodies[0]).toEqual({ phone: '13800138888', purpose: 'login' })
    await type(1, '123456')
    await click('登录')
    expect(stub.calls).toContain('/api/v8/auth/login/phone')
    expect(done()).toBe(1)
    expect(JSON.stringify(localStorage)).not.toContain('123456')
  })

  it('发送失败不能显示已发送；手机号两步验证仍需动态码', async () => {
    const stub = stubServer({
      '/api/v8/auth/sms/send': { status: 503, json: { ok: false, code: 'SMS_NOT_CONFIGURED', message: '通道不可用' } },
      '/api/v8/auth/login/phone': { json: { ok: true, two_factor_required: true, challenge_token: 'phone-challenge', challenge_expires_in: 300, account_id: 167, available_methods: [{ method: 'totp' }], default_method: 'totp' } },
      '/api/v8/auth/login/totp': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
      '/api/v8/my/profile': { json: { ok: true, account: ACCOUNT } },
    })
    const { done } = await mount(stub)
    await click('手机验证码')
    await type(0, '13800138888')
    await click('获取验证码')
    expect(container!.textContent).not.toContain('验证码已发送至')
    expect(container!.textContent).toContain('短信通道暂不可用')
    await type(1, '123456')
    await click('登录')
    expect(done()).toBe(0)
    expect(container!.textContent).toContain('两步验证')
    await type(0, '654321')
    await click('验证')
    expect(done()).toBe(1)
  })

  it('注册码只用于注册；服务端返回令牌并取到资料后才算登录', async () => {
    const stub = stubServer({
      '/api/v8/auth/sms/send': { json: { ok: true, phone: '138****8888', purpose: 'register', expires_in: 300, resend_after: 60 } },
      '/api/v8/auth/register/phone': { json: { ok: true, tokens: TOKENS, account: ACCOUNT } },
      '/api/v8/my/profile': { json: { ok: true, account: ACCOUNT } },
    })
    const { done } = await mount(stub)
    await click('还没有账号？去注册')
    await click('手机验证码')
    await type(0, '13800138888')
    await type(1, 'new-user')
    await click('获取验证码')
    expect(stub.bodies[0]).toEqual({ phone: '13800138888', purpose: 'register' })
    await type(2, '123456')
    await click('注册并登录')
    expect(stub.calls).toContain('/api/v8/auth/register/phone')
    expect(done()).toBe(1)
  })
})
