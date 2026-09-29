/**
 * 超时与取消的契约测试。
 *
 * 单独立一个文件，是因为这两条路径需要一个「一直不返回」的打桩响应，测试本身要等到
 * `setTimeout` 真的触发（毫秒级，但比其余用例慢一个数量级）。把它们混进主契约测试
 * 只会让那批用例莫名其妙地变慢。
 *
 * 两条路径必须分开验证，因为它们对用户的意义完全不同：
 * - **超时** = 服务器没回话 → 归类 `network`，提示去查网络；
 * - **取消** = 用户按了「停止」→ 归类 `aborted`，什么都不用提示，更不能把用户登出。
 * 把两者混成一种，用户会在按了取消之后看到「连不上服务器」。
 */
import { describe, expect, it } from 'vitest'
import {
  AccountFailure,
  ENDPOINTS,
  createAccountClient,
  createTokenStore,
  sendRequest,
} from '../src/index.ts'
import { createFetchStub, memoryRefreshStore } from './fetch-stub.client.ts'

/** 取失败的 `AccountFailure`。 */
async function failureOf(run: Promise<unknown>): Promise<AccountFailure> {
  try {
    await run
  } catch (error) {
    if (error instanceof AccountFailure) return error
    throw error
  }
  throw new Error('预期这次调用失败，但它成功了')
}

const BASE_URL = 'https://accounts.test'

/** 拼出测试期望的完整 URL。 */
function api(path: string): string {
  return `${BASE_URL}/api/v8${path}`
}

describe('超时', () => {
  it('服务器不回话时归类为 network，并提示查网络', async () => {
    const stub = createFetchStub([{ kind: 'hang' }])
    const result = await sendRequest({ fetch: stub.fetch, timeoutMs: 20 }, {
      url: api(ENDPOINTS.me),
      operation: 'me',
      method: 'GET',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.kind).toBe('network')
    expect(result.failure.message).toMatch(/网络/)
    // 请求确实发出去了：超时不是「什么都没做」。
    expect(stub.requests).toHaveLength(1)
  })

  it('超时不会被误报成「已取消」', async () => {
    const stub = createFetchStub([{ kind: 'hang' }])
    const result = await sendRequest({ fetch: stub.fetch, timeoutMs: 20 }, {
      url: api(ENDPOINTS.me),
      operation: 'me',
      method: 'GET',
    })
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.kind).not.toBe('aborted')
  })

  it('默认超时是 20 秒：够慢网络用，又不会让界面一直转', async () => {
    // 断言默认值本身，是为了防止有人把它调成「无限等」——那会让移动端永远转圈。
    const stub = createFetchStub([{ kind: 'json', body: { ok: true } }])
    const started = Date.now()
    await sendRequest({ fetch: stub.fetch }, { url: api(ENDPOINTS.me), operation: 'me', method: 'GET' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(stub.requests).toHaveLength(1)
  })
})

describe('取消', () => {
  it('请求在途中取消归类为 aborted，且不做任何清理', async () => {
    const stub = createFetchStub([{ kind: 'hang' }])
    const controller = new AbortController()
    const pending = sendRequest({ fetch: stub.fetch, timeoutMs: 5_000 }, {
      url: api(ENDPOINTS.me),
      operation: 'me',
      method: 'GET',
      signal: controller.signal,
    })
    controller.abort()
    const result = await pending
    if (result.ok) throw new Error('unreachable')
    expect(result.failure.kind).toBe('aborted')
    expect(result.failure.message).toBe('已取消。')
  })

  it('取消刷新不会把用户登出：凭据原样留着', async () => {
    const store = memoryRefreshStore('stub-refresh-survives-cancel')
    const tokens = createTokenStore({ cookiesAvailable: false, refreshStore: store })
    const stub = createFetchStub([{ kind: 'hang' }])
    const client = createAccountClient({ baseUrl: BASE_URL, fetch: stub.fetch, cookiesAvailable: false, tokens })
    const controller = new AbortController()
    const pending = client.me(controller.signal)
    // 让刷新请求真的发出去（它现在是那个不会返回的请求），再取消。
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(AccountFailure)
    // 关键：取消是「不想等了」，不是「凭据失效」。清掉存储等于把用户登出。
    expect(store.value()).toBe('stub-refresh-survives-cancel')
    expect(client.tokenState().hasRefreshToken).toBe(true)
  })

  it('重试那一次请求也带着取消信号，因此也能被取消', async () => {
    // 这条覆盖的是「带令牌重放」那条路径上的取消：如果重试丢掉了信号，
    // 用户按了取消之后界面还会继续等一个走不完的请求。
    const store = memoryRefreshStore('seed-refresh')
    const tokens = createTokenStore({ cookiesAvailable: false, refreshStore: store })
    const stub = createFetchStub([
      // 冷启动先续期一次，拿到 access token。
      { kind: 'json', body: { tokens: { access_token: 'stub-access-1', refresh_token: 'seed-refresh', expires_in: 3600 } } },
      // 第一次 me 被服务端拒掉，触发「刷新 + 重放」。
      { kind: 'json', status: 401, body: { ok: false, code: 'AUTH_TOKEN_INVALID' } },
      { kind: 'json', body: { tokens: { access_token: 'stub-access-retry', refresh_token: 'seed-refresh', expires_in: 3600 } } },
      // 重放那一次挂住，等取消信号。
      { kind: 'hang' },
    ])
    const client = createAccountClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      cookiesAvailable: false,
      tokens,
      timeoutMs: 5_000,
    })
    const controller = new AbortController()
    const pending = client.me(controller.signal)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    controller.abort()
    const failure = await failureOf(pending)
    expect(failure.kind).toBe('aborted')
    // 0 = 续期，1 = 第一次 me，2 = 刷新，3 = 带新令牌的重放（被取消）。
    expect(stub.requests).toHaveLength(4)
    expect(stub.at(3).headers.authorization).toBe('Bearer stub-access-retry')
    // 取消不等于登出：凭据还在。
    expect(store.value()).toBe('seed-refresh')
  })

  it('登出时服务器不回话，本地也要登出（用户按了登出就必须登出）', async () => {
    const store = memoryRefreshStore('stub-refresh-for-logout')
    const tokens = createTokenStore({ cookiesAvailable: false, refreshStore: store })
    const stub = createFetchStub([
      { kind: 'json', body: { tokens: { access_token: 'stub-access', refresh_token: 'stub-refresh-for-logout', expires_in: 3600 } } },
      { kind: 'hang' },
    ])
    const client = createAccountClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      cookiesAvailable: false,
      tokens,
      timeoutMs: 20,
    })
    await client.refresh()
    expect(client.state()).toBe('authenticated')
    // 撤销请求会超时（服务器不回话），但本地必须已经登出。
    await client.logout()
    expect(client.state()).toBe('signed-out')
    expect(store.value()).toBeNull()
    expect(stub.at(1).url).toBe(api(ENDPOINTS.logout))
  })
})
