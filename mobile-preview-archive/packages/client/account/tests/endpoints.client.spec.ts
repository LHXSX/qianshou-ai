/**
 * 传输层、令牌层与其余端点的契约测试。
 *
 * 这一批端点的共同点是「没有返回值可断言」——改密码、撤销会话、信任设备、TOTP 开关
 * 的成功表现都是 `void`。所以测试**只能**靠请求本身证明接线正确：方法、路径、字段名、
 * bearer 头，以及敏感值有没有被遮住。这也正是它们最容易被写错的地方。
 */
import { describe, expect, it } from 'vitest'
import {
  ACCESS_EXPIRY_SKEW_MS,
  AccountFailure,
  FAILURE_COPY,
  DEFAULT_TIMEOUT_MS,
  ENDPOINTS,
  createAccountClient,
  createTokenStore,
  sendRequest,
  type AccountClient,
} from '../src/index.ts'
import {
  createFetchStub,
  errorReply,
  memoryRefreshStore,
  tokenReply,
  type FetchStub,
  type StubReply,
} from './fetch-stub.client.ts'

const BASE_URL = 'https://accounts.test'

/** 拼出测试期望的完整 URL。 */
function api(path: string): string {
  return `${BASE_URL}/api/v8${path}`
}

/** 建一个已登录的客户端，并返回剩下的打桩响应队列。 */
async function loggedIn(replies: readonly StubReply[], options: {
  readonly cookiesAvailable?: boolean
  readonly refreshSeed?: string | null
} = {}): Promise<{ client: AccountClient; stub: FetchStub; store: ReturnType<typeof memoryRefreshStore> }> {
  const stub = createFetchStub([tokenReply(), ...replies])
  const store = memoryRefreshStore(options.refreshSeed ?? null)
  const tokens = createTokenStore({
    cookiesAvailable: options.cookiesAvailable ?? true,
    refreshStore: store,
  })
  const client = createAccountClient({
    baseUrl: BASE_URL,
    fetch: stub.fetch,
    cookiesAvailable: options.cookiesAvailable ?? true,
    tokens,
  })

  await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
  return { client, stub, store }
}

/** 取失败的 `AccountFailure`。 */
async function failureOf(run: () => Promise<unknown>): Promise<AccountFailure> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AccountFailure) return error
    throw error
  }
  throw new Error('预期这次调用失败，但它成功了')
}

/** 一个成功的空业务响应。 */
const OK: StubReply = { kind: 'json', body: { ok: true } }

describe('改密码', () => {
  it('两个字段都发给 PUT /auth/me，且带上 bearer', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.changePassword({ password: 'stub-new-secret', old_password: 'stub-old-secret' })
    const request = stub.last()
    expect(request.method).toBe('PUT')
    expect(request.url).toBe(api(ENDPOINTS.me))
    expect(request.headers.authorization).toBe('Bearer access-token-value')
    expect(request.json).toEqual({ password: 'stub-new-secret', old_password: 'stub-old-secret' })
  })

  it('只改密码不传旧密码时也不硬塞字段', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.changePassword({ password: 'stub-new-secret' })
    expect(stub.last().json).toEqual({ password: 'stub-new-secret' })
  })

  it('上游把新口令回显在错误里也不会漏出去', async () => {
    const { client } = await loggedIn([errorReply({ status: 422, code: 'VALIDATION_ERROR', message: '密码不符合要求: stub-new-secret' })])
    const failure = await failureOf(() => client.changePassword({ password: 'stub-new-secret', old_password: 'stub-old-secret' }))
    expect(failure.message).not.toContain('stub-new-secret')
    expect(failure.message).not.toContain('stub-old-secret')
  })
})

describe('登出', () => {
  it('先通知服务器撤销会话，再清本地令牌', async () => {
    const { client, stub, store } = await loggedIn([OK], { cookiesAvailable: false, refreshSeed: 'stub-refresh' })
    await client.logout()
    expect(stub.last().method).toBe('POST')
    expect(stub.last().url).toBe(api(ENDPOINTS.logout))
    expect(client.state()).toBe('signed-out')
    expect(client.tokenState().hasAccessToken).toBe(false)
    expect(store.value()).toBeNull()
  })

  it('服务器撤销失败也照样登出：用户按了登出就必须登出', async () => {
    const { client, store } = await loggedIn([{ kind: 'network-error' }], { cookiesAvailable: false, refreshSeed: 'stub-refresh' })
    await client.logout()
    expect(client.state()).toBe('signed-out')
    expect(client.tokenState().hasAccessToken).toBe(false)
    expect(store.value()).toBeNull()
  })
})

describe('会话管理', () => {
  it('列出会话并归一化', async () => {
    const { client, stub } = await loggedIn([{ kind: 'json', body: { ok: true, sessions: [{ id: 'pc-1', device_name: '电脑', is_current: true }] } }])
    const sessions = await client.listSessions()
    expect(stub.last().method).toBe('GET')
    expect(stub.last().url).toBe(api(ENDPOINTS.sessions))
    expect(sessions).toEqual([expect.objectContaining({ id: 'pc-1', device: '电脑', current: true })])
  })

  it('列出节点走 GET /workers，并归一化 capabilities', async () => {
    const { client, stub } = await loggedIn([{
      kind: 'json',
      body: [{ id: 'mac-1', owner_id: 167, status: 'ONLINE', capabilities: { os: 'macos' } }],
    }])
    const workers = await client.listWorkers()
    expect(stub.last().method).toBe('GET')
    expect(stub.last().url).toBe(api(ENDPOINTS.workers))
    expect(workers).toEqual([expect.objectContaining({ id: 'mac-1', owner_id: 167, os: 'macos' })])
  })

  it('宿主摊平后的 {ok, workers} 信封仍能列出 os', async () => {
    const { client } = await loggedIn([{
      kind: 'json',
      body: {
        ok: true,
        workers: [{
          id: 'mac-1', owner_id: 167, name: null, status: 'ONLINE', last_seen: null,
          os: 'macos', hostname: 'ceo.local', window_origin: null,
        }],
      },
    }])
    expect(await client.listWorkers()).toEqual([expect.objectContaining({ id: 'mac-1', os: 'macos' })])
  })

  it('撤销单个会话用 DELETE 加会话 id', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.revokeSession('pc-1')
    expect(stub.last().method).toBe('DELETE')
    expect(stub.last().url).toBe(api('/auth/sessions/pc-1'))
  })

  it('「撤销其它会话」用不带 id 的 DELETE，语义是保留当前这条', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.revokeOtherSessions()
    expect(stub.last().method).toBe('DELETE')
    expect(stub.last().url).toBe(api(ENDPOINTS.sessions))
  })

  it('信任设备带三个必填字段，且口令与动态码都被遮盖', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.trustDevice('pc-1', { code: '654321', current_password: 'stub-current-secret', duration: 2592000 })
    const request = stub.last()
    expect(request.method).toBe('PUT')
    expect(request.url).toBe(api('/auth/sessions/pc-1/trust'))
    expect(request.json).toEqual({ code: '654321', current_password: 'stub-current-secret', duration: 2592000 })
  })

  it('信任设备失败时错误里不含口令与动态码', async () => {
    const { client } = await loggedIn([errorReply({ status: 400, code: 'BAD_CODE', message: '动态码 654321 不正确（stub-current-secret）' })])
    const failure = await failureOf(() => client.trustDevice('pc-1', { code: '654321', current_password: 'stub-current-secret', duration: 60 }))
    expect(failure.message).not.toContain('654321')
    expect(failure.message).not.toContain('stub-current-secret')
  })
})

describe('TOTP 开关', () => {
  it('读状态走 GET /auth/totp/status', async () => {
    const { client, stub } = await loggedIn([{ kind: 'json', body: { ok: true, enabled: true, confirmed: true } }])
    const status = await client.totpStatus()
    expect(stub.last().method).toBe('GET')
    expect(stub.last().url).toBe(api(ENDPOINTS.totpStatus))
    expect(status?.enabled).toBe(true)
  })

  it('状态里没有 enabled 时返回 null，界面必须按「未知」处理', async () => {
    const { client } = await loggedIn([{ kind: 'json', body: { ok: true } }])
    await expect(client.totpStatus()).resolves.toBeNull()
  })

  it('开始绑定只发 current_password，返回值原样交给调用方', async () => {
    const payload = { ok: true, secret: 'AAAA', otpauth_url: 'otpauth://totp/x' }
    const { client, stub } = await loggedIn([{ kind: 'json', body: payload }])
    const result = await client.totpSetup('stub-current-secret')
    expect(stub.last().method).toBe('POST')
    expect(stub.last().url).toBe(api(ENDPOINTS.totpSetup))
    expect(stub.last().json).toEqual({ current_password: 'stub-current-secret' })
    // 绑定要用 secret 画二维码，本包不替调用方猜字段名，原样透传。
    expect(result).toEqual(payload)
  })

  it('确认绑定发 setup_token 与动态码', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.totpConfirm('stub-setup-token-value', '123456')
    expect(stub.last().url).toBe(api(ENDPOINTS.totpConfirm))
    expect(stub.last().json).toEqual({ setup_token: 'stub-setup-token-value', code: '123456' })
  })

  it('关闭 2FA 发动态码与当前口令', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.totpDisable({ code: '123456', current_password: 'stub-current-secret' })
    expect(stub.last().url).toBe(api(ENDPOINTS.totpDisable))
    expect(stub.last().json).toEqual({ code: '123456', current_password: 'stub-current-secret' })
  })

  it('关闭 2FA 的失败文案里不含动态码与口令', async () => {
    const { client } = await loggedIn([errorReply({ status: 400, code: 'BAD_CODE', message: 'code 123456 rejected with stub-current-secret' })])
    const failure = await failureOf(() => client.totpDisable({ code: '123456', current_password: 'stub-current-secret' }))
    expect(failure.message).not.toContain('123456')
    expect(failure.message).not.toContain('stub-current-secret')
  })
})

describe('安全日志与资料', () => {
  it('安全日志走 GET /auth/security-logs', async () => {
    const { client, stub } = await loggedIn([{ kind: 'json', body: { ok: true, logs: [{ id: '1', event: 'login', ip: '1.2.3.4' }] } }])
    const logs = await client.securityLogs()
    expect(stub.last().url).toBe(api(ENDPOINTS.securityLogs))
    expect(logs).toEqual([expect.objectContaining({ id: '1', event: 'login', ip: '1.2.3.4' })])
  })

  it('资料更新走 PUT /my/profile，字段可选', async () => {
    const { client, stub } = await loggedIn([{ kind: 'json', body: { ok: true } }])
    await client.setProfile({ display_name: '老王', language: 'zh-CN' })
    expect(stub.last().method).toBe('PUT')
    expect(stub.last().url).toBe(api(ENDPOINTS.profile))
    expect(stub.last().json).toEqual({ display_name: '老王', language: 'zh-CN' })
  })

  it('资料更新支持嵌套的通知偏好', async () => {
    const { client, stub } = await loggedIn([OK])
    await client.setProfile({ notification_prefs: { task_done: true } })
    expect(stub.last().json).toEqual({ notification_prefs: { task_done: true } })
  })
})

describe('令牌存储', () => {
  it('body 模式下写盘、清盘都可断言', async () => {
    const store = memoryRefreshStore()
    const tokens = createTokenStore({ cookiesAvailable: false, refreshStore: store })
    await tokens.write({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 60 })
    expect(store.value()).toBe('r')
    expect(tokens.readRefresh()).toBe('r')
    await tokens.clear()
    expect(store.value()).toBeNull()
    expect(tokens.describe()).toMatchObject({ hasAccessToken: false, hasRefreshToken: false })
  })

  it('cookie 模式下一律不写盘：保住 httpOnly 的全部价值', async () => {
    const store = memoryRefreshStore()
    const tokens = createTokenStore({ cookiesAvailable: true, refreshStore: store })
    await tokens.write({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 60 })
    expect(store.writes()).toBe(0)
    expect(store.value()).toBeNull()
  })

  it('body 模式拿不到 refresh token 时清掉旧凭据，不留上一个账号的令牌', async () => {
    const store = memoryRefreshStore('previous-account-refresh')
    const tokens = createTokenStore({ cookiesAvailable: false, refreshStore: store })
    await tokens.write({ access_token: 'a', refresh_token: null, token_type: 'Bearer', expires_in: 60 })
    expect(store.value()).toBeNull()
  })

  it('冷启动 hydrate 会读回持久化的 refresh token', async () => {
    const store = memoryRefreshStore('persisted-refresh')
    const tokens = createTokenStore({ cookiesAvailable: false, refreshStore: store })
    expect(tokens.readRefresh()).toBeNull()
    await tokens.hydrate()
    expect(tokens.readRefresh()).toBe('persisted-refresh')
  })

  it('cookie 模式的 hydrate 不读回任何东西：长期凭据不在 JS 手里', async () => {
    const store = memoryRefreshStore('should-not-be-read')
    const tokens = createTokenStore({ cookiesAvailable: true, refreshStore: store })
    await tokens.hydrate()
    expect(tokens.readRefresh()).toBeNull()
  })

  it('hydrate 是幂等的，不会每次请求都读一次盘', async () => {
    let reads = 0
    const tokens = createTokenStore({
      cookiesAvailable: false,
      refreshStore: {
        read: async () => { reads += 1; return 'r' },
        write: async () => undefined,
        clear: async () => undefined,
      },
    })
    await Promise.all([tokens.hydrate(), tokens.hydrate(), tokens.hydrate()])
    await tokens.hydrate()
    expect(reads).toBe(1)
  })

  it('空串不会被当成有效的 refresh token', async () => {
    const tokens = createTokenStore({
      cookiesAvailable: false,
      refreshStore: { read: async () => '', write: async () => undefined, clear: async () => undefined },
    })
    await tokens.hydrate()
    expect(tokens.readRefresh()).toBeNull()
  })

  it('没有持久化端口也能工作：只是长期凭据活不过页面关闭', async () => {
    const tokens = createTokenStore({ cookiesAvailable: false })
    await tokens.write({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 60 })
    expect(tokens.readRefresh()).toBe('r')
    await tokens.hydrate()
    expect(tokens.readRefresh()).toBe('r')
  })

  it('access token 到期判定带 30 秒提前量', async () => {
    let now = 1_000_000
    const tokens = createTokenStore({ cookiesAvailable: true, now: () => now })
    expect(tokens.isAccessExpired()).toBe(true)
    await tokens.write({ access_token: 'a', refresh_token: null, token_type: 'Bearer', expires_in: 60 })
    expect(tokens.isAccessExpired()).toBe(false)
    now += 60_000
    expect(tokens.isAccessExpired()).toBe(true)
    now += 30_000
    // 边界：正好落在 `expires_in - 30s` 上时算过期，避免请求在途中失效。
    expect(tokens.isAccessExpired()).toBe(true)
    expect(ACCESS_EXPIRY_SKEW_MS).toBe(30_000)
  })

  it('显式指定 refreshSource 时以调用方为准', () => {
    // 宿主可能比我们更清楚 cookie 能不能用（例如 Tauri 有自己的 cookie 罐）。
    expect(createTokenStore({ cookiesAvailable: true, refreshSource: 'body' }).source()).toBe('body')
    expect(createTokenStore({ cookiesAvailable: false, refreshSource: 'cookie' }).source()).toBe('cookie')
  })
})

describe('传输层', () => {
  it('GET 与 DELETE 不带请求体，也不带 content-type', async () => {
    const stub = createFetchStub([OK, OK])
    await sendRequest({ fetch: stub.fetch }, { url: api(ENDPOINTS.me), operation: 'me', method: 'GET' })
    await sendRequest({ fetch: stub.fetch }, { url: api(ENDPOINTS.sessions), operation: 'sessions', method: 'DELETE' })
    for (const request of stub.requests) {
      expect(request.body).toBeNull()
      expect(request.headers['content-type']).toBeUndefined()
    }
  })

  it('每个请求都带 accept 与 credentials: include', async () => {
    const stub = createFetchStub([OK])
    await sendRequest({ fetch: stub.fetch }, { url: api(ENDPOINTS.me), operation: 'me', method: 'GET' })
    expect(stub.last().headers.accept).toBe('application/json')
    expect(stub.last().credentials).toBe('include')
  })

  it('额外请求头能被合入（例如宿主注入的设备标识）', async () => {
    const stub = createFetchStub([OK])
    await sendRequest({ fetch: stub.fetch }, {
      url: api(ENDPOINTS.me),
      operation: 'me',
      method: 'GET',
      headers: { 'x-device-id': 'this-device' },
    })
    expect(stub.last().headers['x-device-id']).toBe('this-device')
  })

  it('超时归类为 network，而不是「已取消」', async () => {
    const stub = createFetchStub([{ kind: 'network-error' }])
    const result = await sendRequest({ fetch: stub.fetch, timeoutMs: 5 }, {
      url: api(ENDPOINTS.me),
      operation: 'me',
      method: 'GET',
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('network')
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000)
  })

  it('2xx 的空响应体也算不可解析，不会被当成成功', async () => {
    const stub = createFetchStub([{ kind: 'empty', status: 200 }])
    const result = await sendRequest({ fetch: stub.fetch }, { url: api(ENDPOINTS.logout), operation: 'logout', method: 'POST' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('unparseable')
  })

  it('成功时返回已解析的响应体与真实状态码', async () => {
    const stub = createFetchStub([{ kind: 'json', status: 201, body: { ok: true, id: 9 } }])
    const result = await sendRequest({ fetch: stub.fetch }, { url: api(ENDPOINTS.register), operation: 'register', method: 'POST', body: {} })
    expect(result).toEqual({ ok: true, status: 201, payload: { ok: true, id: 9 } })
  })
})

describe('不可读的响应头与不可解析的刷新响应', () => {
  /** 造一个读取响应头就会抛错的 Response：部分宿主在跨域未暴露响应头时是这样。 */
  function headersThrowing(status: number, body: string): Response {
    const response = new Response(body, { status, headers: { 'content-type': 'text/html' } })
    Object.defineProperty(response, 'headers', {
      value: { get: () => { throw new TypeError('headers are not readable') } },
    })
    return response
  }

  it('响应头不可读时，不可解析的失败依然给出，只是少一条 content-type 线索', async () => {
    const stub = createFetchStub([])
    const fetch = async (): Promise<Response> => headersThrowing(200, '<!doctype html>')
    const result = await sendRequest({ fetch }, { url: api(ENDPOINTS.login), operation: 'login', method: 'POST', body: { password: 'x' } })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure.kind).toBe('unparseable')
    expect(!result.ok && result.failure.message).not.toContain('text/html')
    void stub
  })

  it('响应头不可读时，失败分类仍按状态码进行', async () => {
    const fetch = async (): Promise<Response> => headersThrowing(401, JSON.stringify({ ok: false, code: 'AUTH_TOKEN_INVALID' }))
    const result = await sendRequest({ fetch }, { url: api(ENDPOINTS.login), operation: 'login', method: 'POST', body: {} })
    expect(!result.ok && result.failure.kind).toBe('invalid-credentials')
    expect(!result.ok && result.failure.retryAfterSeconds).toBeUndefined()
  })

  it('刷新响应 2xx 却没有令牌时，会话进入 expired 而不是留着半截状态', async () => {
    // cookie 的被拒最典型的形态就是「服务端说 ok、但什么都没给」。此时必须收尾。
    const { client, stub } = await loggedIn([
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      { kind: 'json', body: { ok: true } },
    ])
    const failure = await failureOf(() => client.me())
    expect(failure.kind).toBe('unauthorized')
    expect(client.state()).toBe('expired')
    expect(stub.at(2).url).toBe(api(ENDPOINTS.refresh))
  })

  it('手动调 refresh 在 cookie 被拒时会再走一次请求体', async () => {
    const { client, stub } = await loggedIn([
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-fallback' }),
    ])
    await expect(client.refresh()).resolves.toBe(true)
    expect(stub.at(1).json).toEqual({})
    expect(stub.at(2).json).toEqual({ refresh_token: 'refresh-token-value' })
  })

  it('body 模式下没有 refresh token 时，手动 refresh 直接失败且不留假会话', async () => {
    const stub = createFetchStub([])
    const client = createAccountClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      cookiesAvailable: false,
      tokens: createTokenStore({ cookiesAvailable: false, refreshSource: 'body' }),
    })
    // 内存里塞一个 refresh token，再切到没有它的状态是做不到的——所以这里用真实路径：
    // 冷启动本来就没有长期凭据，refresh 必须失败而不是发出一个空请求。
    await expect(client.refresh()).resolves.toBe(false)
    expect(stub.requests).toHaveLength(0)
    expect(client.state()).toBe('signed-out')
  })

  it('从未登录过时，受保护请求直接失败：状态保持 signed-out，且不发任何请求', async () => {
    // 「本来没登录」和「登录过期了」必须分开：前者该显示登录页，后者该先说明原因。
    const stub = createFetchStub([])
    const client = createAccountClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      cookiesAvailable: true,
      tokens: createTokenStore({ cookiesAvailable: true, refreshSource: 'cookie' }),
    })
    const failure = await failureOf(() => client.me())
    expect(failure.kind).toBe('unauthorized')
    expect(client.state()).toBe('signed-out')
    // 唯一发出去的请求是那次刷新探测：cookie 是 httpOnly 的，JS 无从判断浏览器手里到底有没有，
    // 所以只能问一次；问不到就当未登录，而不是硬造一个「过期」提示。
    expect(stub.requests).toHaveLength(1)
    expect(stub.at(0).url).toBe(api(ENDPOINTS.refresh))
    expect(stub.at(0).json).toEqual({})
  })

  it('长期凭据被服务端拒绝时，报「登录已过期」而不是「还没登录」', async () => {
    // 冷启动时内存里没有 access token，只有存储里的长期凭据。
    // 必须探测一次：httpOnly cookie 在不在，JS 看不到，只能问服务端。
    const stub = createFetchStub([errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' })])
    const client = createAccountClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      cookiesAvailable: false,
      refreshStore: memoryRefreshStore('stale-refresh-value'),
    })
    const failure = await failureOf(() => client.me())
    expect(failure.kind).toBe('unauthorized')
    expect(failure.status).toBe(401)
    expect(stub.requests).toHaveLength(1)
    expect(stub.at(0).json).toEqual({ refresh_token: 'stale-refresh-value' })
    // 存储里那份就是「这次续期」的证据，所以状态是「过期」而不是「从未登录」。
    expect(client.state()).toBe('expired')
    expect(client.tokenState().hasRefreshToken).toBe(false)
  })

  it('重开页面（同一份存储、新的客户端）仍能续期成功', async () => {
    // 这条是「杀进程重开还是登录态」的机制证明：access token 只在内存里，
    // 靠的是存储里的长期凭据换回来。
    const store = memoryRefreshStore()
    const firstStub = createFetchStub([
      tokenReply({ access: 'stub-access-first', refresh: 'stub-refresh-persisted' }),
    ])
    const first = createAccountClient({ baseUrl: BASE_URL, fetch: firstStub.fetch, cookiesAvailable: false, refreshStore: store })
    await first.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(store.value()).toBe('stub-refresh-persisted')

    const secondStub = createFetchStub([
      tokenReply({ access: 'stub-access-second', refresh: 'stub-refresh-persisted' }),
      { kind: 'json', body: { ok: true, account: { id: 42, username: 'qianshou-user' } } },
    ])
    const second = createAccountClient({ baseUrl: BASE_URL, fetch: secondStub.fetch, cookiesAvailable: false, refreshStore: store })
    expect(second.state()).toBe('signed-out')
    await expect(second.me()).resolves.toMatchObject({ id: 42 })
    expect(secondStub.at(0).json).toEqual({ refresh_token: 'stub-refresh-persisted' })
    expect(second.state()).toBe('authenticated')
  })

  it('令牌存储自相矛盾时（刷新说成功、却读不到 access token）不发裸请求', async () => {
    const stub = createFetchStub([tokenReply({ access: 'stub-access' })])
    // 一个「写进去就丢」的存储：模拟宿主存储实现有缺陷的情形。
    const broken = {
      readAccess: () => null,
      readRefresh: () => 'stub-refresh',
      write: async () => undefined,
      clear: async () => undefined,
      isAccessExpired: () => true,
      hydrate: async () => undefined,
      describe: () => ({
        hasAccessToken: false,
        hasRefreshToken: true,
        refreshSource: 'body' as const,
        accessExpiresAt: null,
        accessExpiresIn: null,
      }),
      source: () => 'body' as const,
    }
    const client = createAccountClient({ baseUrl: BASE_URL, fetch: stub.fetch, tokens: broken })
    const failure = await failureOf(() => client.me())
    expect(failure.kind).toBe('unauthorized')
    // 只发了那一次刷新。刷新之后仍然读不到 access token，于是如实把失败交回去，
    // **没有**带着空 bearer 去打受保护端点——那种请求在服务端看来就是一个匿名访问。
    expect(stub.requests.map(request => request.url)).toEqual([api(ENDPOINTS.refresh)])
  })

  it('tokensOf 兼容顶层平铺的令牌字段，但绝不读 agent_token', async () => {
    const { tokensOf } = await import('../src/index.ts')
    expect(tokensOf({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 10 })).toEqual({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 10,
    })
    // 只有 agent_token 时必须判定为「没有令牌」：它不是独立凭据。
    expect(tokensOf({ ok: true, agent_token: 'r' })).toBeNull()
    expect(tokensOf(null)).toBeNull()
    expect(tokensOf({ tokens: { access_token: 'a' } })).toEqual({
      access_token: 'a',
      refresh_token: null,
      token_type: 'Bearer',
      expires_in: 0,
    })
  })

  it('校验失败里没有任何可识别的字段时，退回通用文案而不是拼一个空冒号', async () => {
    const { client } = await loggedIn([errorReply({ status: 422, code: 'VALIDATION_ERROR', errors: [null, 'x', { loc: [] }, { loc: ['body', 'unknown'] }] })])
    const failure = await failureOf(() => client.setProfile({ display_name: 'x' }))
    expect(failure.kind).toBe('invalid-request')
    expect(failure.message).toContain('服务器要求')
  })
})

describe('客户端装配与余下的分支', () => {
  it('不传 tokens / cookiesAvailable 时也能工作，并默认按 cookie 模式处理', async () => {
    const stub = createFetchStub([tokenReply()])
    const client = createAccountClient({ baseUrl: BASE_URL, fetch: stub.fetch, refreshStore: memoryRefreshStore() })
    expect(client.tokenState().refreshSource).toBe('cookie')
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(client.state()).toBe('authenticated')
  })

  it('自建客户端：不传 tokens 但传 prefix 与 timeoutMs 时两个覆盖都生效', async () => {
    const stub = createFetchStub([tokenReply(), { kind: 'json', body: { ok: true, account: { id: 5 } } }])
    const client = createAccountClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      prefix: '/edge/v8',
      timeoutMs: 1000,
    })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(stub.at(0).url).toBe(`${BASE_URL}/edge/v8/auth/login`)
    await expect(client.me()).resolves.toMatchObject({ id: 5 })
    expect(stub.at(1).url).toBe(`${BASE_URL}/edge/v8/auth/me`)
  })

  it('绕过客户端直接用会话层：prefix 与 timeoutMs 同样可覆盖', async () => {
    const session = await import('../src/session.ts')
    const stub = createFetchStub([{ kind: 'json', body: { ok: true } }])
    const direct = session.createSession({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      tokens: createTokenStore({ cookiesAvailable: true }),
      prefix: '/edge/v8',
      timeoutMs: 1000,
    })
    await direct.requestPublic({ path: ENDPOINTS.register, operation: 'register', method: 'POST', body: {} })
    expect(stub.at(0).url).toBe(`${BASE_URL}/edge/v8/auth/register`)
  })

  it('403 但文案里没有「停用」字样时，仍然给出账号状态那条中文说明', async () => {
    const { client } = await loggedIn([errorReply({ status: 403, code: 'FORBIDDEN', message: 'permission denied' })])
    const failure = await failureOf(() => client.listSessions())
    expect(failure.kind).toBe('account-disabled')
    expect(failure.message).toMatch(/[\u4e00-\u9fff]/)
  })

  it('422 里没有任何可识别的字段时，退回通用中文文案', async () => {
    const { client } = await loggedIn([errorReply({ status: 422, code: 'VALIDATION_ERROR', errors: [{ loc: ['body', 'nothing_known'] }] })])
    const failure = await failureOf(() => client.setProfile({ display_name: 'x' }))
    expect(failure.kind).toBe('invalid-request')
    expect(failure.message).toMatch(/[\u4e00-\u9fff]/)
  })

  it('prefix 与 timeoutMs 可以被宿主覆盖', async () => {
    const stub = createFetchStub([{ kind: 'json', body: { ok: true, account: { id: 1 } } }])
    const client = createAccountClient({
      baseUrl: 'https://accounts.test',
      fetch: stub.fetch,
      prefix: '/edge/v8',
      timeoutMs: 5,
      cookiesAvailable: false,
    })
    await client.register({ password: 'stub-password-not-real' })
    expect(stub.last().url).toBe('https://accounts.test/edge/v8/auth/register')
  })

  it('markExpired 是给宿主用的显式状态冻结', async () => {
    const stub = createFetchStub([tokenReply()])
    const client = createAccountClient({ baseUrl: BASE_URL, fetch: stub.fetch, cookiesAvailable: true })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(client.state()).toBe('authenticated')
    // 宿主自己发现凭据失效（例如它自己的网络层收到 401）时可以主动冻结状态。
    client.tokens.readAccess()
    const session = await import('../src/session.ts')
    const direct = session.createSession({ baseUrl: BASE_URL, fetch: stub.fetch, tokens: client.tokens })
    direct.markAuthenticated()
    direct.markExpired()
    expect(direct.state()).toBe('expired')
  })
})

it('上游用错误码表达「需要 2FA」时也认得出', async () => {
  const { client } = await loggedIn([errorReply({ status: 401, code: 'TWO_FACTOR_REQUIRED', message: '该账号需要二次验证' })])
  const failure = await failureOf(() => client.me())
  expect(failure.kind).toBe('two-factor-required')
  expect(failure.message).toBe('该账号需要二次验证')
})

it('409 且上游没有给文案时，用本包的「已被占用」说明', async () => {
  const { client } = await loggedIn([{ kind: 'json', status: 409, body: { ok: false, code: 'USER_EXISTS' } }])
  const failure = await failureOf(() => client.register({ password: 'stub-password-not-real', username: 'taken' }))
  expect(failure.kind).toBe('account-taken')
  expect(failure.message).toBe(FAILURE_COPY['account-taken'])
})

it('响应体不是对象时按「没有错误信息」处理，不试图读字段', async () => {
  // 上游（或中间的代理）回了 401 但体是一个 JSON 字符串／数字，不是对象。
  const stub = createFetchStub([{ kind: 'json', status: 401, body: 'nope' }])
  const result = await sendRequest({ fetch: stub.fetch }, { url: api(ENDPOINTS.me), operation: 'me', method: 'GET' })
  expect(result.ok).toBe(false)
  expect(!result.ok && result.failure.kind).toBe('unauthorized')
})

it('成功响应里没有 account 字段时返回 null，不去别处找账号对象', async () => {
  // `account` 不是对象（上游换了形状或中间层改写）：必须返回 null，不能崩、也不能乱认。
  const stub = createFetchStub([{ kind: 'json', body: { ok: true, tokens: { access_token: 'a', expires_in: 10 }, account: 'nope' } }])
  const client = createAccountClient({ baseUrl: BASE_URL, fetch: stub.fetch, cookiesAvailable: true })
  const result = await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
  expect(result.kind).toBe('tokens')
  expect(result.kind === 'tokens' && result.account).toBeNull()
})

it('安全日志条目不是对象时被丢掉,不崩', async () => {
  const { client } = await loggedIn([{ kind: 'json', body: { ok: true, logs: ['x', null, { id: '1', event: 'login' }] } }])
  const logs = await client.securityLogs()
  expect(logs).toHaveLength(1)
  expect(logs[0]?.event).toBe('login')
})

it('会话条目不是对象时被丢掉,不崩', async () => {
  const { client } = await loggedIn([{ kind: 'json', body: { ok: true, sessions: [7, { id: 's1' }] } }])
  const sessions = await client.listSessions()
  expect(sessions).toHaveLength(1)
})

it('公开请求带 body / secrets / signal 时三个可选字段都能透传', async () => {
  const session = await import('../src/session.ts')
  const stub = createFetchStub([{ kind: 'json', body: { ok: true } }])
  const controller = new AbortController()
  const direct = session.createSession({
    baseUrl: BASE_URL,
    fetch: stub.fetch,
    tokens: createTokenStore({ cookiesAvailable: true }),
  })
  await direct.requestPublic({
    path: ENDPOINTS.login,
    operation: 'login',
    method: 'POST',
    body: { username: 'qianshou-user', password: 'stub-password-not-real' },
    secrets: ['stub-password-not-real'],
    signal: controller.signal,
  })
  expect(stub.at(0).json).toEqual({ username: 'qianshou-user', password: 'stub-password-not-real' })
})

it('刷新请求能收到外部取消信号：取消后归类为 aborted', async () => {
  const session = await import('../src/session.ts')
  const stub = createFetchStub([{ kind: 'network-error' }])
  const tokens = createTokenStore({
    cookiesAvailable: false,
    refreshSource: 'body',
    refreshStore: memoryRefreshStore('stub-refresh-for-abort'),
  })
  const direct = session.createSession({ baseUrl: BASE_URL, fetch: stub.fetch, tokens })
  const controller = new AbortController()
  controller.abort()
  await expect(direct.refresh(controller.signal)).resolves.toBe(false)
  expect(stub.requests).toHaveLength(1)
  expect(stub.at(0).url).toBe(api(ENDPOINTS.refresh))
  // 取消刷新不该把状态说成「已过期」：用户只是不想等，凭据可能还是好的。
  expect(direct.state()).toBe('signed-out')
})

it('成功响应体不是对象时不崩：归一化拿不到账号就返回 null', async () => {
  const stub = createFetchStub([{ kind: 'json', body: 42 }])
  const client = createAccountClient({ baseUrl: BASE_URL, fetch: stub.fetch, cookiesAvailable: true })
  await expect(client.register({ password: 'stub-password-not-real' })).resolves.toBeNull()
})

it('公开请求不带 secrets 时也照常发送', async () => {
  const session = await import('../src/session.ts')
  const stub = createFetchStub([{ kind: 'json', body: { ok: true } }])
  const direct = session.createSession({
    baseUrl: BASE_URL,
    fetch: stub.fetch,
    tokens: createTokenStore({ cookiesAvailable: true }),
  })
  await direct.requestPublic({ path: ENDPOINTS.register, operation: 'register', method: 'POST', body: { password: 'x' } })
  expect(stub.at(0).json).toEqual({ password: 'x' })
})

it('409 且上游既没有可识别文案也没有可识别错误码时，仍按「已被占用」处理', async () => {
  const { client } = await loggedIn([{ kind: 'json', status: 409, body: { ok: false } }])
  const failure = await failureOf(() => client.register({ password: 'stub-password-not-real' }))
  expect(failure.kind).toBe('account-taken')
  expect(failure.message).toBe(FAILURE_COPY['account-taken'])
})

it('重试那一次请求也能被取消：取消信号一路带到重试上', async () => {
  const { client, stub } = await loggedIn([
    errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
    tokenReply({ access: 'stub-access-retry', refresh: 'refresh-token-value' }),
    { kind: 'hang' },
  ])
  const controller = new AbortController()
  const pending = client.me(controller.signal)
  // 等到重试那一步真的发出去（前两步是 me、refresh），再取消。
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  controller.abort()
  const failure = await failureOf(() => pending)
  expect(failure.kind).toBe('aborted')
  // 0 = 登录，1 = 第一次 me（401），2 = 刷新，3 = 重试（被取消的那次）。
  expect(stub.requests).toHaveLength(4)
  expect(stub.at(2).url).toBe(api(ENDPOINTS.refresh))
  expect(stub.at(3).url).toBe(api(ENDPOINTS.me))
  expect(stub.at(3).headers.authorization).toBe('Bearer stub-access-retry')
})

it('409 且上游给了文案时，把上游那句话原样给用户', async () => {
  const { client } = await loggedIn([errorReply({ status: 409, code: 'USER_EXISTS', message: '用户名已被占用，换一个' })])
  const failure = await failureOf(() => client.register({ password: 'stub-password-not-real', username: 'taken' }))
  expect(failure.kind).toBe('account-taken')
  expect(failure.message).toBe('用户名已被占用，换一个')
})

it('401 且上游给了中文文案时，用上游那句话（比我们的猜测更贴切）', async () => {
  const { client } = await loggedIn([errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID', message: '该会话已被管理员撤销' })])
  const failure = await failureOf(() => client.me())
  expect(failure.kind).toBe('unauthorized')
  expect(failure.message).toBe('该会话已被管理员撤销')
})

it('503 且上游没给文案时，用本包的服务器不可用说明', async () => {
  const { client } = await loggedIn([{ kind: 'json', status: 503, body: { ok: false, code: 'UPSTREAM_DOWN' } }])
  const failure = await failureOf(() => client.me())
  expect(failure.kind).toBe('server-error')
  expect(failure.message).toBe(FAILURE_COPY['server-error'])
})

it('2FA 挑战响应里没有文案时，用本包说明', async () => {
  const { client } = await loggedIn([{ kind: 'json', status: 401, body: { ok: false, code: 'TWO_FACTOR_REQUIRED' } }])
  const failure = await failureOf(() => client.me())
  expect(failure.kind).toBe('two-factor-required')
  expect(failure.message).toBe(FAILURE_COPY['two-factor-required'])
})

it('校验错误的 loc 不是数组时跳过该条，不崩也不瞎猜字段', async () => {
  const { client } = await loggedIn([errorReply({
    status: 422,
    code: 'VALIDATION_ERROR',
    errors: [{ loc: 'body.password' }, { loc: ['body', 'email'] }],
  })])
  const failure = await failureOf(() => client.register({ password: 'stub-password-not-real' }))
  expect(failure.kind).toBe('invalid-request')
  // 只认得那一条 loc 是数组的：邮箱提示在，凭据提示不在。
  expect(failure.message).toContain('邮箱')
  expect(failure.message).not.toContain('密码')
})

it('同一字段在多个校验错误里重复出现时只提示一次', async () => {
  const { client } = await loggedIn([errorReply({
    status: 422,
    code: 'VALIDATION_ERROR',
    errors: [{ loc: ['body', 'password'] }, { loc: ['body', 'password'] }],
  })])
  const failure = await failureOf(() => client.changePassword({ password: 'stub-new-secret' }))
  expect(failure.kind).toBe('invalid-request')
  // 「密码：至少 6 位。」只出现一次，不是两句一样的话。
  expect(failure.message.split('密码').length - 1).toBe(1)
})

it('400 带可识别的字段名时也给出字段提示（不只是 422）', async () => {
  // 这条必须走一个客户端**真的能提交**的字段：`FIELD_COPY` 的字段名映射是
  // password / old_password / username / email / company / code / duration / …，
  // 而 `PUT /my/profile` 的六个字段（display_name、phone、language、country、
  // avatar_url、notification_prefs）**都没有提示文案**——用它们做断言，等于要求
  // 客户端对从不会发生的字段名给出提示。注意 `loc` 是嵌套数组，类型上过得了，
  // 只有真跑一次才会露出「文案认不出这个字段」。
  const { client } = await loggedIn([errorReply({
    status: 400,
    code: 'BAD_REQUEST',
    // 两条指向同一字段：列表里所有可识别的字段都要出现，但只出现一次。
    errors: [{ loc: ['body', 'password'] }, { loc: ['body', 'password'] }],
  })])
  const failure = await failureOf(() => client.changePassword({ password: 'stub-new-secret' }))
  expect(failure.kind).toBe('invalid-request')
  expect(failure.message.split('密码').length - 1).toBe(1)
})
