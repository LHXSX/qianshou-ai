/**
 * 与既有账号体系的**契约对照**测试。
 *
 * 本服务不 import `@deepseek-ai/dsh-client-account`（那是给浏览器与宿主插件用的，
 * 带 cookie/token 存储），而是自己发四个请求。代价是**路径可能漂移**：
 * 上游改一个字，我们就是 404，而 404 会被分类成"上游不可用"——
 * 一个看起来像网络问题的配置错误。所以这里把两边的常量逐字对照。
 */
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_API_ORIGIN as CLIENT_ORIGIN,
  ACCOUNT_API_PREFIX as CLIENT_PREFIX,
  ENDPOINTS as CLIENT_ENDPOINTS,
  accountUrl as clientAccountUrl,
} from '../../../client/account/src/endpoints.ts'
import {
  ACCOUNT_API_ORIGIN,
  ACCOUNT_API_PREFIX,
  UPSTREAM_PATHS,
  createAccountUpstream,
  extractAccount,
  extractChallenge,
  extractTokens,
  requiresTwoFactor,
} from '../src/account-upstream.ts'

describe('上游契约对照', () => {
  it('基址与前缀与既有账号客户端一致', () => {
    expect(ACCOUNT_API_ORIGIN).toBe(CLIENT_ORIGIN)
    expect(ACCOUNT_API_PREFIX).toBe(CLIENT_PREFIX)
  })

  it('四条路径与既有账号客户端的 ENDPOINTS 逐字一致', () => {
    expect(UPSTREAM_PATHS.login).toBe(CLIENT_ENDPOINTS.login)
    expect(UPSTREAM_PATHS.loginTotp).toBe(CLIENT_ENDPOINTS.loginTotp)
    expect(UPSTREAM_PATHS.me).toBe(CLIENT_ENDPOINTS.me)
    expect(UPSTREAM_PATHS.logout).toBe(CLIENT_ENDPOINTS.logout)
  })

  it('拼出来的地址与既有客户端的拼接函数一致', () => {
    expect(`${ACCOUNT_API_ORIGIN}${ACCOUNT_API_PREFIX}${UPSTREAM_PATHS.login}`)
      .toBe(clientAccountUrl(CLIENT_ORIGIN, CLIENT_ENDPOINTS.login))
  })
})

describe('上游响应解析（只认能认的，不编缺省值）', () => {
  it('令牌对可以从顶层或 data.tokens 里取到', () => {
    expect(extractTokens({ tokens: { access_token: 'a', refresh_token: 'r' } })).toEqual({ access: 'a', refresh: 'r' })
    expect(extractTokens({ data: { tokens: { access_token: 'a' } } })).toEqual({ access: 'a', refresh: null })
    expect(extractTokens({ tokens: { accessToken: 'a' } })).toEqual({ access: 'a', refresh: null })
    expect(extractTokens({})).toBeNull()
  })

  it('账号 id 能从 account / user / data.account 里取到，数字与字符串都认', () => {
    expect(extractAccount({ account: { id: 167, username: 'admin' } })).toEqual({ id: '167', displayName: 'admin', role: 'personal' })
    expect(extractAccount({ user: { account_id: '167', nickname: '张三', role: 'pro' } })).toEqual({ id: '167', displayName: '张三', role: 'pro' })
    expect(extractAccount({ data: { account: { id: '167' } } })).toEqual({ id: '167', displayName: '167', role: 'personal' })
    // 认不出 id 就是认不出——不猜一个出来。
    expect(extractAccount({ account: { username: 'admin' } })).toBeNull()
  })

  it('两步验证的挑战令牌与判定', () => {
    expect(requiresTwoFactor({ two_factor_required: true })).toBe(true)
    expect(requiresTwoFactor({ two_factor: { challenge: 'x' } })).toBe(true)
    expect(requiresTwoFactor({ challenge_token: 'x' })).toBe(true)
    expect(requiresTwoFactor({ tokens: { access_token: 'a' } })).toBe(false)
    expect(extractChallenge({ challenge_token: 'x' })).toBe('x')
    expect(extractChallenge({ two_factor: { challenge_token: 'y' } })).toBe('y')
    expect(extractChallenge({})).toBeNull()
  })
})

describe('登录失败的分类（本服务最容易被搞混的一段）', () => {
  /** 造一个只回固定响应的 fetch。 */
  const stub = (status: number, payload: unknown, options: { readonly throwNetwork?: boolean } = {}): typeof fetch =>
    async () => {
      if (options.throwNetwork === true) throw new Error('socket hang up')
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    }

  const build = (
    status: number,
    payload: unknown,
    options: { readonly throwNetwork?: boolean } = {},
  ): ReturnType<typeof createAccountUpstream> =>
    createAccountUpstream({ baseUrl: 'https://accounts.test', fetch: stub(status, payload, options) })

  it('401/422 → invalid（上游明确拒绝）', async () => {
    expect((await build(401, { message: '账号或密码不对。' }).login({ username: 'a', password: 'b' })).kind).toBe('invalid')
    expect((await build(422, {}).login({ username: 'a', password: 'b' })).kind).toBe('invalid')
  })

  it('429 → rate-limited', async () => {
    expect((await build(429, { message: '太快了' }).login({ username: 'a', password: 'b' })).kind).toBe('rate-limited')
  })

  it('网络异常与 5xx → unavailable（**不是**"请重新登录"）', async () => {
    expect((await build(0, {}, { throwNetwork: true }).login({ username: 'a', password: 'b' })).kind).toBe('unavailable')
    expect((await build(500, {}).login({ username: 'a', password: 'b' })).kind).toBe('unavailable')
  })

  it('2xx 但没有令牌 → unavailable（不留"已登录但没有令牌"的半成品）', async () => {
    const outcome = await build(200, { ok: true }).login({ username: 'a', password: 'b' })
    expect(outcome.kind).toBe('unavailable')
  })

  it('2xx 带令牌与账号 → ok', async () => {
    const outcome = await build(200, { tokens: { access_token: 'a', refresh_token: 'r' }, account: { id: 167 } }).login({ username: 'a', password: 'b' })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.account.id).toBe('167')
      expect(outcome.tokens.access).toBe('a')
    }
  })

  it('核验：401 → unauthorized；网络故障 → unavailable（保会话，不误踢人）', async () => {
    const upstream = build(401, {})
    expect((await upstream.verify({ access: 'a', refresh: null })).kind).toBe('unauthorized')
    const broken = build(0, {}, { throwNetwork: true })
    expect((await broken.verify({ access: 'a', refresh: null })).kind).toBe('unavailable')
  })
})
