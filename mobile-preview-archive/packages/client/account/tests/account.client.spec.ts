/**
 * 账号客户端的契约测试。
 *
 * 两条硬规则贯穿本文件：
 * 1. **绝不碰真实账号。** 所有请求都由 `createFetchStub` 截住，没有任何用例会解析到
 *    `qianshousuanli.com`，也没有任何真实凭据。注册与登录在真实环境里是有副作用的
 *    （造号、累计失败次数、触发限流与风控），契约测试不许做。
 * 2. **断言的是请求本身。** 「字段映射对不对」只能靠检查发出去的请求体来证明；
 *    断言返回值会把「请求发错了但恰好没报错」这种情况漏掉。
 */
import { describe, expect, it } from 'vitest'
import {
  AccountFailure,
  ENDPOINTS,
  REDACTED,
  createAccountClient,
  createSession,
  createTokenStore,
  redactForLog,
  redactText,
  stripEchoes,
  type AccountClient,
} from '../src/index.ts'
import {
  createFetchStub,
  errorReply,
  memoryRefreshStore,
  tokenReply,
  validationReply,
  type FetchStub,
  type StubReply,
} from './fetch-stub.client.ts'

/** 测试基址；刻意不是真实域名，避免任何误发到生产的可能。 */
const BASE_URL = 'https://accounts.test'

/** 拼出测试期望的完整 URL；前缀写在这里而不是各处重复字面量。 */
function api(path: string): string {
  return `${BASE_URL}/api/v8${path}`
}

/** 建一个客户端并把打桩器一起返回。 */
function setup(replies: readonly StubReply[], options: {
  readonly cookiesAvailable?: boolean
  readonly refreshSeed?: string | null
  readonly now?: () => number
} = {}): {
  client: AccountClient
  stub: FetchStub
  store: ReturnType<typeof memoryRefreshStore>
} {
  const stub = createFetchStub(replies)
  const store = memoryRefreshStore(options.refreshSeed ?? null)
  // 每个用例只建**一个**令牌存储，并把它同时交给客户端与断言使用：
  // 建两个的话，断言观察到的就不是客户端真正在用的那个，测出来的东西没有意义。
  const tokens = createTokenStore({
    cookiesAvailable: options.cookiesAvailable ?? true,
    refreshStore: store,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const client = createAccountClient({
    baseUrl: BASE_URL,
    fetch: stub.fetch,
    cookiesAvailable: options.cookiesAvailable ?? true,
    tokens,
  })
  return { client, stub, store }
}

/** 取失败的 `AccountFailure`；不是失败就抛错（而不是返回 undefined 让断言悄悄放过）。 */
async function failureOf(run: () => Promise<unknown>): Promise<AccountFailure> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AccountFailure) return error
    throw error
  }
  throw new Error('预期这次调用失败，但它成功了')
}

describe('注册：请求字段映射', () => {
  it('把五个字段按上游名字发出去，一个都不改名', async () => {
    const { client, stub } = setup([{ kind: 'json', body: { ok: true, account: { id: 7, username: 'new-user' } } }])
    await client.register({
      password: 'stub-password-not-real',
      username: 'new-user',
      email: 'new-user@example.test',
      company: '千手',
      remember_me: true,
    })
    const request = stub.last()
    expect(request.method).toBe('POST')
    expect(request.url).toBe(api(ENDPOINTS.register))
    expect(request.json).toEqual({
      password: 'stub-password-not-real',
      username: 'new-user',
      email: 'new-user@example.test',
      company: '千手',
      remember_me: true,
    })
  })

  it('只给必填的 password 时，不硬塞 username/email', async () => {
    // 上游的事实是 username/email 都可选，注册门槛要尽量低——补空串反而可能撞上唯一约束。
    const { client, stub } = setup([{ kind: 'json', body: { ok: true } }])
    await client.register({ password: 'stub-password-not-real' })
    expect(stub.last().json).toEqual({ password: 'stub-password-not-real' })
  })

  it('注册响应里没有 account 时返回 null，绝不谎称「已登录」', async () => {
    const { client } = setup([{ kind: 'json', body: { ok: true } }])
    await expect(client.register({ password: 'stub-password-not-real' })).resolves.toBeNull()
  })

  it('注册成功返回的 account 被归一化成真实账号 id', async () => {
    const { client } = setup([{ kind: 'json', body: { ok: true, account: { id: 7, username: 'new-user', balance: 0 } } }])
    const account = await client.register({ password: 'stub-password-not-real' })
    expect(account?.id).toBe(7)
    expect(account?.username).toBe('new-user')
  })
})

describe('登录：成功路径与令牌落位', () => {
  it('登录成功后 access token 进内存、refresh 走 cookie、不写盘', async () => {
    const { client, stub, store } = setup([tokenReply({ access: 'stub-access', refresh: 'stub-refresh' })])
    const result = await client.login({ username: 'qianshou-user', password: 'stub-password-not-real', remember_me: true })
    expect(result.kind).toBe('tokens')
    expect(client.tokenState()).toMatchObject({
      hasAccessToken: true,
      refreshSource: 'cookie',
      accessExpiresIn: 7200,
    })
    // 关键的安全断言：cookie 模式下绝不再把长期凭据往 JS 侧存储里塞一份。
    expect(store.writes()).toBe(0)
    expect(store.value()).toBeNull()
    expect(stub.last().credentials).toBe('include')
    expect(stub.last().json).toEqual({ username: 'qianshou-user', password: 'stub-password-not-real', remember_me: true })
  })

  it('返回的账号是归一化后的真实账号（余额来自登录响应，不需要第二次请求）', async () => {
    const { client } = setup([tokenReply()])
    const result = await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(result.kind === 'tokens' && result.account?.id).toBe(42)
    expect(result.kind === 'tokens' && result.account?.balance).toBe(12.5)
  })

  it('`agent_token` 不被当成第二类凭据：它就是 refresh token 的同一个值', async () => {
    const { client } = setup([tokenReply({ access: 'stub-access', refresh: 'stub-refresh', agentToken: 'stub-refresh' })])
    const result = await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(result.kind === 'tokens' && result.tokens.access_token).toBe('stub-access')
    expect(result.kind === 'tokens' && result.tokens.refresh_token).toBe('stub-refresh')
    // 没有任何 API 接受 agent token；客户端唯一的长期凭据来源是 refresh_token。
    expect(JSON.stringify(client.tokenState())).not.toContain('stub-refresh')
  })

  it('登录后状态变成 authenticated', async () => {
    const { client } = setup([tokenReply()])
    expect(client.state()).toBe('signed-out')
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(client.state()).toBe('authenticated')
  })

  it('用户名处填邮箱同样可以登录（上游两种都收）', async () => {
    const { client, stub } = setup([tokenReply()])
    await client.login({ username: 'user@example.test', password: 'stub-password-not-real' })
    expect(stub.last().json?.username).toBe('user@example.test')
  })
})

describe('登录：2FA 分支', () => {
  const challengeBody = {
    ok: true,
    two_factor_required: true,
    challenge_token: 'stub-challenge-token-0123456789',
    challenge_expires_in: 300,
    account_id: 42,
    available_methods: ['totp'],
    default_method: 'totp',
  }

  it('开了 2FA 的账号返回挑战，而不是令牌', async () => {
    const { client } = setup([{ kind: 'json', body: challengeBody }])
    const result = await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(result.kind).toBe('two-factor')
    expect(result.kind === 'two-factor' && result.challenge.challenge_token).toBe('stub-challenge-token-0123456789')
    // 关键：挑战分支绝不能留下一个「半登录」状态。
    expect(client.tokenState().hasAccessToken).toBe(false)
    expect(client.state()).toBe('signed-out')
  })

  it('补验成功后拿到令牌并进入已登录状态', async () => {
    const { client, stub } = setup([tokenReply({ access: 'stub-access-after-totp' })])
    const account = await client.loginTotp({
      challenge_token: 'stub-challenge-token-0123456789',
      code: '123456',
      trust_device: true,
    })
    expect(stub.last().url).toBe(api(ENDPOINTS.loginTotp))
    expect(stub.last().json).toEqual({
      challenge_token: 'stub-challenge-token-0123456789',
      code: '123456',
      trust_device: true,
    })
    expect(client.tokenState().hasAccessToken).toBe(true)
    expect(client.state()).toBe('authenticated')
    expect(account?.id).toBe(42)
  })

  it('完整的两步登录：先挑战、再补验', async () => {
    const { client, stub } = setup([
      { kind: 'json', body: challengeBody },
      tokenReply({ access: 'stub-access-2' }),
    ])
    const first = await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(first.kind).toBe('two-factor')
    if (first.kind !== 'two-factor') throw new Error('unreachable')
    await client.loginTotp({ challenge_token: first.challenge.challenge_token, code: '000000' })
    expect(stub.requests).toHaveLength(2)
    expect(stub.at(0).url).toBe(api(ENDPOINTS.login))
    expect(stub.at(1).url).toBe(api(ENDPOINTS.loginTotp))
  })
})

describe('限流与错误分类', () => {
  it('登录 429 归到 login 桶，并说明登录频次', async () => {
    const { client } = setup([errorReply({ status: 429, code: 'RATE_LIMITED', message: '请求过于频繁' })])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('rate-limited')
    expect(failure.rateLimitScope).toBe('login')
    expect(failure.message).toContain('10 次')
    expect(failure.message).toContain('限流')
  })

  it('注册 429 归到 register 桶，并说明注册频次', async () => {
    const { client } = setup([errorReply({ status: 429, code: 'RATE_LIMITED' })])
    const failure = await failureOf(() => client.register({ password: 'stub-password-not-real' }))
    expect(failure.rateLimitScope).toBe('register')
    expect(failure.message).toContain('5 次')
  })

  it('补验 429 归到 two-factor 桶，并指向动态码', async () => {
    const { client } = setup([errorReply({ status: 429, code: 'RATE_LIMITED' })])
    const failure = await failureOf(() => client.loginTotp({ challenge_token: 'stub-challenge-token-0123456789', code: '123456' }))
    expect(failure.rateLimitScope).toBe('two-factor')
    expect(failure.message).toContain('动态码')
  })

  it('429 带 Retry-After 时把秒数带到错误对象上', async () => {
    const { client } = setup([errorReply({ status: 429, code: 'RATE_LIMITED', headers: { 'retry-after': '42' } })])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.retryAfterSeconds).toBe(42)
  })

  it('没有 Retry-After 时不给一个假秒数', async () => {
    const { client } = setup([errorReply({ status: 429, code: 'RATE_LIMITED' })])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.retryAfterSeconds).toBeUndefined()
  })

  it('登录 401 是「口令不对」，不是「会话过期」', async () => {
    const { client } = setup([errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID', message: '用户名或密码错误' })])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('invalid-credentials')
    expect(failure.message).toBe('用户名或密码错误')
    expect(failure.traceId).toBe('trace-id-for-test')
  })

  it('受保护请求 401 是「登录状态已过期」', async () => {
    const { client, stub } = setup([
      tokenReply({ refresh: 'stub-refresh-for-retry' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-after-refresh', refresh: 'stub-refresh-for-retry' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
    ])
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    const failure = await failureOf(() => client.me())
    expect(failure.kind).toBe('unauthorized')
    expect(failure.status).toBe(401)
    // 401 会自动刷新一次再重试：登录 1 + me 1 + 刷新 1 + 重试 1。
    expect(stub.requests).toHaveLength(4)
    expect(stub.at(2).url).toBe(api(ENDPOINTS.refresh))
    // 重试用的是刷新拿到的**新** access token。
    expect(stub.at(3).headers.authorization).toBe('Bearer stub-access-after-refresh')
    // 服务端坚持说会话无效：刷新救不回来，如实把状态记为过期，界面才会回登录页。
    expect(client.state()).toBe('expired')
  })

  it('账号被停用单独成一类，不与「口令错」混为一谈', async () => {
    const { client } = setup([errorReply({ status: 403, code: 'ACCOUNT_DISABLED', message: '账号已被停用' })])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('account-disabled')
    expect(failure.message).toContain('停用')
  })

  it('用户名或邮箱已占用单独成一类', async () => {
    const { client } = setup([errorReply({ status: 409, code: 'USER_EXISTS', message: '用户名已存在' })])
    const failure = await failureOf(() => client.register({ password: 'stub-password-not-real', username: 'taken' }))
    expect(failure.kind).toBe('account-taken')
    expect(failure.message).toContain('已存在')
  })

  it('上游用文案而不是错误码表达「已占用」时也认得出', async () => {
    const { client } = setup([errorReply({ status: 400, code: 'SOMETHING_NEW', message: '该邮箱已被注册' })])
    const failure = await failureOf(() => client.register({ password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('account-taken')
  })

  it('上游 5xx 归为服务器问题', async () => {
    const { client } = setup([errorReply({ status: 503, code: 'UPSTREAM_DOWN' })])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('server-error')
  })

  it('校验失败给出可照做的中文字段提示，而不是 Pydantic 原文', async () => {
    const { client } = setup([validationReply({ password: 'x' })])
    const failure = await failureOf(() => client.register({ password: 'x' }))
    expect(failure.kind).toBe('invalid-request')
    expect(failure.message).toContain('至少 6 位')
    expect(failure.message).not.toContain('String should have at least')
  })

  it('网络不可达归类为 network，不冒充成鉴权失败', async () => {
    const { client } = setup([{ kind: 'network-error' }])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('network')
    expect(failure.status).toBeUndefined()
  })

  it('用户主动取消归类为 aborted，不报成网络故障', async () => {
    const { client, stub } = setup([
      tokenReply(),
      { kind: 'network-error' },
    ])
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    const controller = new AbortController()
    controller.abort()
    const failure = await failureOf(() => client.me(controller.signal))
    expect(failure.kind).toBe('aborted')
    // 取消不该把会话废掉：用户只是不想等，不是掉线。
    expect(client.state()).toBe('authenticated')
    expect(stub.requests).toHaveLength(2)
  })

  it('2xx 却不是 JSON（地址填错回了一整页 HTML）归为不可解析', async () => {
    const { client } = setup([{ kind: 'raw', text: '<!doctype html><title>欢迎</title>' }])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('unparseable')
    expect(failure.message).toContain('text/html')
  })

  it('失败业务包带 200 状态码时也必须当失败，不能当成功', async () => {
    // 这是「业务包」而不是 OAuth2 错误形状：判定要看 `ok === false`，不能只看 HTTP 状态码。
    // 2xx 不携带分类信息，所以走「请求不成立」这条兜底；关键在于**它没有被当成成功**，
    // 也没有留下一个「已登录但没有令牌」的会话。
    const { client } = setup([{ kind: 'json', status: 200, body: { ok: false, code: 'AUTH_TOKEN_INVALID', message: '凭据不成立' } }])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('invalid-request')
    // 汇报给用户与日志的是**真实**收到的状态码，不是分类时用的代入码。
    expect(failure.status).toBe(200)
    expect(client.tokenState().hasAccessToken).toBe(false)
    expect(client.state()).toBe('signed-out')
  })

  it('读响应体失败时给出「不可解析」，不抛出未处理异常', async () => {
    const { client } = setup([{ kind: 'unreadable' }])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('unparseable')
  })

  it('未知错误码不会被误判成成功，也不会崩', async () => {
    const { client } = setup([errorReply({ status: 418, code: 'SOMETHING_BRAND_NEW' })])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('invalid-request')
    expect(failure.message).toContain('418')
  })

  it('2xx 但没有令牌：如实报不可用，不留半成品会话', async () => {
    const { client } = setup([{ kind: 'json', body: { ok: true, account: { id: 42 } } }])
    const failure = await failureOf(() => client.login({ username: 'qianshou-user', password: 'stub-password-not-real' }))
    expect(failure.kind).toBe('unparseable')
    expect(client.state()).toBe('signed-out')
  })
})

describe('刷新与重试', () => {
  it('401 后走 `/auth/refresh`，再带新 access token 重试一次', async () => {
    const { client, stub } = setup([
      tokenReply({ access: 'stub-access-1' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-2' }),
      { kind: 'json', body: { ok: true, account: { id: 42, username: 'qianshou-user' } } },
    ])
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    const account = await client.me()
    expect(account?.id).toBe(42)
    expect(stub.at(2).url).toBe(api(ENDPOINTS.refresh))
    // 重试必须带**新的** access token，不能把旧的再发一次。
    expect(stub.at(3).headers.authorization).toBe('Bearer stub-access-2')
    expect(client.state()).toBe('authenticated')
  })

  it('cookie 模式下刷新请求体为空，长期凭据只走 httpOnly cookie', async () => {
    const { client, stub } = setup([
      tokenReply({ refresh: 'stub-refresh-value' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-2' }),
      { kind: 'json', body: { ok: true, account: { id: 42 } } },
    ])
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    await client.me()
    const refresh = stub.at(2)
    expect(refresh.json).toEqual({})
    expect(refresh.credentials).toBe('include')
    expect(refresh.body).not.toContain('stub-refresh-value')
  })

  it('cookie 不可用时退化为请求体携带 refresh token，并落盘', async () => {
    const { client, stub, store } = setup([
      tokenReply({ access: 'stub-access', refresh: 'stub-refresh-body' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-2', refresh: 'stub-refresh-body' }),
      { kind: 'json', body: { ok: true, account: { id: 42 } } },
    ], { cookiesAvailable: false })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    expect(store.value()).toBe('stub-refresh-body')
    await client.me()
    expect(stub.at(2).json).toEqual({ refresh_token: 'stub-refresh-body' })
    expect(stub.at(2).credentials).toBe('include')
  })

  it('冷启动时用已保存的 refresh token 直接换出 access token', async () => {
    const { client, stub } = setup([
      tokenReply({ access: 'stub-access-cold' }),
      { kind: 'json', body: { ok: true, account: { id: 42 } } },
    ], { cookiesAvailable: false, refreshSeed: 'stub-refresh-cold' })
    expect(client.state()).toBe('signed-out')
    const account = await client.me()
    expect(account?.id).toBe(42)
    expect(stub.at(0).url).toBe(api(ENDPOINTS.refresh))
    expect(stub.at(0).json).toEqual({ refresh_token: 'stub-refresh-cold' })
    expect(stub.at(1).headers.authorization).toBe('Bearer stub-access-cold')
    expect(client.state()).toBe('authenticated')
  })

  it('access token 未过期时不刷新：不产生多余的刷新请求', async () => {
    const { client, stub } = setup([
      tokenReply({ expiresIn: 7200 }),
      { kind: 'json', body: { ok: true, account: { id: 42 } } },
    ])
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    await client.me()
    expect(stub.requests).toHaveLength(2)
  })

  it('access token 已过期时不打那次注定 401 的请求，先刷新', async () => {
    let now = 1_000_000
    const stub = createFetchStub([
      tokenReply({ access: 'stub-access-1', expiresIn: 60 }),
      tokenReply({ access: 'stub-access-2', expiresIn: 7200 }),
      { kind: 'json', body: { ok: true, account: { id: 42 } } },
    ])
    const client = createAccountClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      cookiesAvailable: true,
      tokens: createTokenStore({ cookiesAvailable: true, now: () => now }),
    })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    now += 60_000
    expect(client.tokens.isAccessExpired()).toBe(true)
    const account = await client.me()
    expect(account?.id).toBe(42)
    expect(stub.at(1).url).toBe(api(ENDPOINTS.refresh))
    expect(stub.at(2).headers.authorization).toBe('Bearer stub-access-2')
  })

  it('cookie 被浏览器拒收时自愈：改走请求体再刷一次', async () => {
    // 浏览器可能因为非安全上下文 / 第三方 cookie 策略没种下 httpOnly cookie，
    // 此时第一次刷新会 401。只要登录响应顺带给了我们令牌值，就应该改道而不是把用户登出。
    const { client, stub } = setup([
      tokenReply({ access: 'stub-access-1', refresh: 'stub-refresh-fallback' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-2', refresh: 'stub-refresh-fallback' }),
      { kind: 'json', body: { ok: true, account: { id: 42 } } },
    ])
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    const account = await client.me()
    expect(account?.id).toBe(42)
    expect(stub.at(2).json).toEqual({})
    expect(stub.at(3).json).toEqual({ refresh_token: 'stub-refresh-fallback' })
    expect(stub.at(4).headers.authorization).toBe('Bearer stub-access-2')
  })

  it('刷新也失败时清空令牌并把状态置为 expired', async () => {
    const { client, store } = setup([
      tokenReply({ refresh: 'stub-refresh-body' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
    ], { cookiesAvailable: false })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    await failureOf(() => client.me())
    expect(client.state()).toBe('expired')
    expect(client.tokenState().hasAccessToken).toBe(false)
    expect(store.value()).toBeNull()
  })

  it('并发请求共享同一次刷新，不会各刷一次把限流打满', async () => {
    const stub = createFetchStub([
      tokenReply({ access: 'stub-access-1' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-2' }),
      { kind: 'json', body: { ok: true, account: { id: 42 } } },
      { kind: 'json', body: { ok: true, sessions: [] } },
    ])
    const client = createAccountClient({ baseUrl: BASE_URL, fetch: stub.fetch, cookiesAvailable: true })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    await Promise.all([client.me(), client.listSessions()])
    const refreshes = stub.requests.filter(request => request.url.endsWith(ENDPOINTS.refresh))
    expect(refreshes).toHaveLength(1)
  })

  it('没有 access token 也没有 refresh token 时如实报「已过期」，不空转', async () => {
    const { client, stub } = setup([], { cookiesAvailable: false })
    const failure = await failureOf(() => client.me())
    expect(failure.kind).toBe('unauthorized')
    expect(stub.requests).toHaveLength(0)
  })

  it('状态订阅能收到 authenticated 与 expired，退订后不再收到', async () => {
    const { client } = setup([
      tokenReply({ refresh: 'stub-refresh-for-expiry' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      tokenReply({ access: 'stub-access-after-refresh', refresh: 'stub-refresh-for-expiry' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
    ])
    const seen: string[] = []
    const unsubscribe = client.subscribe((state) => { seen.push(state) })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    await failureOf(() => client.me())
    unsubscribe()
    expect(seen).toEqual(['authenticated', 'expired'])
    // 退订已经生效：再清一次也不该多出一条记录。
    await client.tokens.clear()
    expect(seen).toEqual(['authenticated', 'expired'])
  })

  it('刷新时网络断了不作废凭据：用户只是没连上，不是被登出', async () => {
    const { client, store } = setup([
      tokenReply({ refresh: 'stub-refresh-keep' }),
      errorReply({ status: 401, code: 'AUTH_TOKEN_INVALID' }),
      { kind: 'network-error' },
    ], { cookiesAvailable: false })
    await client.login({ username: 'qianshou-user', password: 'stub-password-not-real' })
    const failure = await failureOf(() => client.me())
    // 这次请求确实失败了，**如实上报**：失败原因是网络，不是"你的登录过期了"（WP1 A-19）。
    // 早先这里报的是 `unauthorized`，界面于是显示"请重新登录"——用户去重输口令，
    // 而真正的问题只是网线。
    expect(failure.kind).toBe('network')
    // 但凭据没有被清掉：网络恢复后同一次运行还能接着用。
    expect(client.state()).toBe('authenticated')
    expect(store.value()).toBe('stub-refresh-keep')
  })

  it('刷新跨过一次登出：令牌不落地、状态不被改回已登录（WP1 A-17）', async () => {
    // 让刷新请求**卡住**，好在它回来之前完成登出。
    // 手写 fetch 而不是用打桩器：需要精确控制返回时机。
    let releaseRefresh: () => void = () => { /* 下面立刻赋值 */ }
    const gate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const reply = (body: unknown): Response => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/auth/login')) {
        return reply({ ok: true, tokens: { access_token: 'a-1', refresh_token: 'stub-refresh-1', token_type: 'Bearer', expires_in: 7200 } })
      }
      if (url.endsWith('/auth/refresh')) {
        await gate
        return reply({ ok: true, tokens: { access_token: 'a-2', refresh_token: 'stub-refresh-2', token_type: 'Bearer', expires_in: 7200 } })
      }
      if (url.endsWith('/auth/logout')) return reply({ ok: true })
      return reply({ ok: false, code: 'NOT_STUBBED' })
    }
    const store = memoryRefreshStore(null)
    const tokens = createTokenStore({ cookiesAvailable: false, refreshSource: 'body', refreshStore: store })
    const session = createSession({ baseUrl: BASE_URL, fetch: fetchImpl, tokens })
    await tokens.write({ access_token: 'a-1', refresh_token: 'stub-refresh-1', token_type: 'Bearer', expires_in: 7200 })
    session.markAuthenticated()
    const refreshing = session.refresh()
    await session.signOut()
    releaseRefresh()
    await expect(refreshing).resolves.toBe(false)
    // 用户看到的必须是"已登出"：一次迟到的刷新不能把界面改回已登录、也不能留下新凭据。
    expect(session.state()).toBe('signed-out')
    expect(store.value()).toBeNull()
  })
})

describe('凭据绝不外泄', () => {
  /** 刻意选一个好认的假口令：任何地方出现它都是失败。 */
  const FAKE = 'stub-SECRET-password-value'

  it('上游把口令回显在校验错误里，错误对象里也不含它', async () => {
    const { client } = setup([validationReply({ password: FAKE })])
    const failure = await failureOf(() => client.register({ password: FAKE, username: 'someone' }))
    expect(failure.message).not.toContain(FAKE)
    expect(JSON.stringify(failure)).not.toContain(FAKE)
    expect(String(failure)).not.toContain(FAKE)
    expect(failure.stack ?? '').not.toContain(FAKE)
  })

  it('上游用 message 直接回显口令时也会被遮盖', async () => {
    const { client } = setup([errorReply({ status: 400, code: 'WEIRD', message: `password ${FAKE} is invalid` })])
    const failure = await failureOf(() => client.login({ username: 'someone', password: FAKE }))
    expect(failure.message).not.toContain(FAKE)
    expect(failure.message).toContain(REDACTED)
  })

  it('令牌值不会出现在可打印的令牌状态里', async () => {
    const { client } = setup([tokenReply({ access: 'stub-ACCESS-token-value', refresh: 'stub-REFRESH-token-value' })])
    await client.login({ username: 'qianshou-user', password: FAKE })
    const printable = JSON.stringify(client.tokenState())
    expect(printable).not.toContain('stub-ACCESS-token-value')
    expect(printable).not.toContain('stub-REFRESH-token-value')
  })

  it('redactText 遮盖长值时不留下短值的残尾', () => {
    // 先替换短值会把长值切碎，剩下的片段再也匹配不上——这正是要防的错误。
    expect(redactText('abcdef', ['b', 'abcdef'])).toBe(REDACTED)
  })

  it('redactText 对含正则元字符的口令也遮得干净', () => {
    expect(redactText('a$b*c(d)e', ['$b*c(d)'])).toBe(`a${REDACTED}e`)
  })

  it('redactForLog 是给宿主日志用的同一把工具', () => {
    expect(redactForLog(`body={"password":"${FAKE}"}`, [FAKE])).not.toContain(FAKE)
  })

  it('stripEchoes 去掉 message 里回显的字段值', () => {
    expect(stripEchoes('bad input: {"password":"zzz"}')).not.toContain('zzz')
  })

  it('2xx 响应体不是 JSON 的诊断文本里不含提交的口令', async () => {
    const { client } = setup([{ kind: 'raw', text: `<!doctype html><body>${FAKE}` }])
    const failure = await failureOf(() => client.login({ username: 'someone', password: FAKE }))
    // 这条响应体是服务端回显，客户端不能把它塞进错误信息。
    expect(failure.message).not.toContain(FAKE)
  })
})
