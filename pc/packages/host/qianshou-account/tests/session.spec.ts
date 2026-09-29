import { describe, expect, it, vi } from 'vitest'
import { AccountProtocol, AccountFailure, accountOf, challengeOf, modelsOf, serverUrl, tokensOf } from '../src/protocol.ts'
import { AccountSession, type AccountStore } from '../src/session.ts'
import { commerceView, quoteCommerce } from '../src/commerce.ts'

const config = { accountOrigin: 'https://account.example', gatewayBase: 'https://gateway.example/api', timeoutMs: 1000 }
const pair = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 }
const identity = { account: { id: 1, username: 'test-user', private: 'not-public' } }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function urlOf(input: Parameters<typeof fetch>[0]): string { return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url }
function fixture(seed: string | null = null) {
  const saved = { refresh: seed, access: null as string | null }
  const store: AccountStore = {
    readRefresh: vi.fn(async () => saved.refresh),
    write: vi.fn(async (refresh: string | null, access: string) => { saved.refresh = refresh; saved.access = access }),
    clear: vi.fn(async () => { saved.refresh = null; saved.access = null }),
  }
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = urlOf(input)
    requests.push({ url, init })
    return Response.json(url.endsWith('/auth/me') ? identity : url.endsWith('/models') ? { data: [{ id: 'test-model' }] } : pair)
  })
  const session = new AccountSession(new AccountProtocol(config, fetcher), store)
  return { session, fetcher, store, saved, requests }
}

describe('account protocol', () => {
  it('recognizes the deployed downgrade conflict without exposing arbitrary server error text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      code: 'RESOURCE_CONFLICT', message: " {'code': 'downgrade-not-allowed', 'message': '当前订阅期间暂不支持降级。'}",
    }, { status: 409 })).mockResolvedValueOnce(Response.json({
      code: 'RESOURCE_CONFLICT', message: 'server-secret',
    }, { status: 409 }))
    const protocol = new AccountProtocol(config, fetcher)
    const current = commerceView({}, null, null, null)
    expect((await quoteCommerce(protocol, 'fixture-access', '1', 'basic', new AbortController().signal,
      current)).commerce.notice).toBe('downgrade-not-allowed')
    expect((await quoteCommerce(protocol, 'fixture-access', '1', 'basic', new AbortController().signal,
      current)).commerce.notice).toBe('unavailable')
  })
  it('accepts the two deployed token envelopes and projects only public identity fields', () => {
    expect(tokensOf(pair)).toEqual({ access: pair.access_token, refresh: pair.refresh_token, expiresIn: 3600 })
    expect(tokensOf({ tokens: pair })).toEqual(tokensOf(pair))
    expect(tokensOf({ ...pair, refresh_token: undefined }).refresh).toBeNull()
    expect(accountOf(identity)).toEqual({ id: '1', username: 'test-user' })
    expect(modelsOf({ data: [{ id: 'a' }, { id: 'a' }] })).toEqual(['a'])
    for (const payload of [{}, { ...pair, expires_in: 0 }, { ...pair, access_token: 'bad\nheader' }]) expect(() => tokensOf(payload)).toThrow('invalid-response')
    expect(() => modelsOf({ data: [] })).toThrow('invalid-response')
    expect(() => challengeOf({ two_factor_required: true })).toThrow('invalid-response')
    expect(() => accountOf({ username: 'x' })).toThrow('invalid-response')
  })
  it('rejects URL credentials and nonlocal cleartext, but permits controlled loopback tests', () => {
    for (const url of ['http://remote.example', 'https://user:password@example.org', 'https://example.org?secret=x']) expect(() => serverUrl(url)).toThrow('route-invalid')
    expect(serverUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000')
  })
  it.each([[401, 'invalid-credentials'], [403, 'invalid-credentials'], [429, 'rate-limited'], [500, 'unavailable'], [400, 'invalid-input']])('redacts login HTTP %s failures', async (status, code) => {
    const protocol = new AccountProtocol(config, async () => Response.json({ message: 'server-secret' }, { status }))
    await expect(protocol.request('/auth/login', 'POST', {}, null, new AbortController().signal)).rejects.toEqual(new AccountFailure(code as AccountFailure['code']))
  })
  it('never forwards thrown network text', async () => {
    const protocol = new AccountProtocol(config, async () => { throw new Error('network-secret') })
    await expect(protocol.request('/auth/me', 'GET', undefined, 'private-access', new AbortController().signal)).rejects.toThrow('unavailable')
  })
})

describe('account lifecycle using controlled HTTP responses', () => {
  it('verifies identity after login and exposes neither tokens nor the submitted password', async () => {
    const { session, saved, requests } = fixture()
    const status = await session.login('test-user', 'fixture-password')
    expect(status).toMatchObject({ phase: 'authenticated', account: { id: '1', username: 'test-user' }, models: [], cloudSelected: false, restorable: true })
    expect(saved.refresh).toBe(pair.refresh_token)
    expect(JSON.stringify(status)).not.toMatch(/fixture-|private/)
    expect(requests.map(row => row.url)).toEqual(['https://account.example/api/v8/auth/login', 'https://account.example/api/v8/auth/me'])
    expect(requests[0]?.init).toMatchObject({ redirect: 'error', credentials: 'omit' })
  })
  it('sends a normalized phone code and signs in on the phone endpoint', async () => {
    const { session, requests } = fixture()
    expect((await session.sendPhoneCode('  +86 (138)-0013-8000 ')).failure).toBeNull()
    expect(requests[0]?.url).toBe('https://account.example/api/v8/auth/sms/send')
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ phone: '13800138000', purpose: 'login' }))
    const status = await session.loginWithPhone('13800138000', '123456')
    expect(status.phase).toBe('authenticated')
    expect(requests.map(row => row.url)).toEqual([
      'https://account.example/api/v8/auth/sms/send',
      'https://account.example/api/v8/auth/login/phone',
      'https://account.example/api/v8/auth/me',
    ])
    expect((await session.sendPhoneCode('12345')).failure).toBe('invalid-input')
    expect((await session.sendPhoneCode('12800138000')).failure).toBe('invalid-input')
    expect(requests).toHaveLength(3)
  })
  it('clears the previous SMS error after a successful retry', async () => {
    const { session, fetcher } = fixture()
    fetcher.mockResolvedValueOnce(Response.json({ Code: 'FLOW_LIMIT' }, { status: 503 }))
    expect((await session.sendPhoneCode('13800138000')).failure).toBe('unavailable')
    expect((await session.sendPhoneCode('13800138000')).failure).toBeNull()
    expect(fetcher.mock.calls.map(call => urlOf(call[0]))).toEqual([
      'https://account.example/api/v8/auth/sms/send',
      'https://account.example/api/v8/auth/sms/send',
    ])
  })
  it('uses a registration-scoped SMS code and the normal authenticated session', async () => {
    const { session, requests, saved } = fixture()
    expect((await session.sendPhoneCode('13800138000', 'register')).failure).toBeNull()
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ phone: '13800138000', purpose: 'register' }))
    const status = await session.registerWithPhone('13800138000', '123456')
    expect(status).toMatchObject({ phase: 'authenticated', account: { id: '1', username: 'test-user' }, restorable: true })
    expect(saved.refresh).toBe(pair.refresh_token)
    expect(requests.map(row => row.url)).toEqual([
      'https://account.example/api/v8/auth/sms/send',
      'https://account.example/api/v8/auth/register/phone',
      'https://account.example/api/v8/auth/me',
    ])
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ phone: '13800138000', code: '123456', remember_me: true }))
  })
  it('reads the five-hour window from the gateway and quotes a plan before payment', async () => {
    const requests: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = urlOf(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/auth/me')) return Response.json(identity)
      if (url.endsWith('/status')) return Response.json({ ok: true, tier: { id: 'max', label: 'Max 版' },
        credit: { remainingSp: 12, windowLimitSp: 600, usedInWindowSp: 600 },
        plans: [{ id: 'max', label: 'Max 版', monthlyYuan: 299, monthlySp: 2990 }] })
      if (url.endsWith('/subscriptions/wallet')) return Response.json({ ok: true, wallet: { currency: 'CNY', balanceFen: 100, balanceYuan: '1.00' } })
      if (url.endsWith('/subscriptions/quote')) return Response.json({ ok: true, quote: { quoteId: 'quote-1', accountId: '1', tier: 'max', label: 'Max 版', months: 1, currency: 'CNY', amountFen: 29900, amountYuan: '299.00', monthlySp: 2990, expiresAt: '2099-01-01T00:00:00.000Z' }, wallet: { currency: 'CNY', balanceFen: 100, balanceYuan: '1.00', shortfallFen: 29800, canPay: false } })
      if (url.endsWith('/subscriptions/purchase')) return Response.json({ ok: false, code: 'insufficient_balance' }, { status: 402 })
      return Response.json(pair)
    })
    const store: AccountStore = { readRefresh: async () => null, write: async () => undefined, clear: async () => undefined }
    const session = new AccountSession(new AccountProtocol(config, fetcher), store)
    expect((await session.login('test-user', 'fixture-password')).phase).toBe('authenticated')
    const billing = await session.billing()
    expect(billing).toMatchObject({ tierLabel: 'Max 版', remainingSp: 12, windowLimitSp: 600, usedInWindowSp: 600, balanceYuan: '1.00' })
    expect(requests).toContain('POST https://gateway.example/api/status')
    expect(requests).toContain('GET https://account.example/api/v8/subscriptions/wallet')
    const quoted = await session.quotePlan('max')
    expect(quoted.quote).toMatchObject({ amountYuan: '299.00', canPay: false })
    expect(requests.at(-1)).toBe('POST https://account.example/api/v8/subscriptions/quote')
    await expect(session.buyPlan()).resolves.toMatchObject({ notice: 'insufficient-balance' })
  })
  it('keeps a 2FA challenge private and sends the code only to the Host-owned challenge', async () => {
    const { session, fetcher, requests } = fixture()
    fetcher.mockResolvedValueOnce(Response.json({ two_factor_required: true, challenge_token: 'fixture-challenge', challenge_expires_in: 90 }))
    const pending = await session.login('test-user', 'fixture-password')
    expect(pending.phase).toBe('two-factor-required')
    expect(JSON.stringify(pending)).not.toContain('fixture-challenge')
    expect((await session.completeTotp('123456', false)).phase).toBe('authenticated')
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ challenge_token: 'fixture-challenge', code: '123456', trust_device: false, remember_me: true }))
  })
  it('restores a durable refresh grant and single-flights concurrent refresh consumers', async () => {
    const { session, fetcher } = fixture('existing-refresh')
    expect((await session.snapshot()).restorable).toBe(true)
    const wait = deferred<Response>(); fetcher.mockReturnValueOnce(wait.promise)
    const first = session.access(); const second = session.access()
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1) })
    wait.resolve(Response.json(pair))
    expect(await Promise.all([first, second])).toEqual([pair.access_token, pair.access_token])
    expect((await session.reconnect()).models).toEqual(['test-model'])
    expect(fetcher).toHaveBeenCalledTimes(3)
    const catalog = fetcher.mock.calls.find(call => urlOf(call[0]).endsWith('/models'))
    expect(catalog?.[1]).toMatchObject({ method: 'POST' })
  })
  it.each([429, 503])('keeps the refresh identity after temporary HTTP %s', async (status) => {
    const { session, fetcher, saved } = fixture('existing-refresh')
    fetcher.mockResolvedValueOnce(Response.json({}, { status }))
    expect((await session.reconnect()).phase).toBe('unavailable')
    expect(saved.refresh).toBe('existing-refresh')
    expect((await session.snapshot()).restorable).toBe(true)
    expect((await session.reconnect()).phase).toBe('authenticated')
  })
  it('clears a rejected refresh grant and prevents reopening an expired account', async () => {
    const { session, fetcher, saved } = fixture('expired-refresh')
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 401 }))
    expect((await session.reconnect()).phase).toBe('expired')
    expect(saved.refresh).toBeNull()
    expect((await session.snapshot()).restorable).toBe(false)
  })
  it('logout aborts its active lifetime and ignores a login response that arrives late', async () => {
    const { session, fetcher, saved } = fixture()
    const wait = deferred<Response>(); fetcher.mockReturnValueOnce(wait.promise)
    const lifetime = session.signal()
    const login = session.login('test-user', 'fixture-password')
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1) })
    const loginLifetime = session.signal()
    await session.logout(); wait.resolve(Response.json(pair)); await login
    expect(lifetime.aborted).toBe(true)
    expect(loginLifetime.aborted).toBe(true)
    expect(saved.refresh).toBeNull()
    expect((await session.snapshot()).phase).toBe('signed-out')
  })
  it('dispose aborts refresh HTTP and prevents a late response from being written', async () => {
    const { session, fetcher, saved, store } = fixture('stored-refresh')
    const wait = deferred<Response>(); fetcher.mockReturnValueOnce(wait.promise)
    const operation = session.access().catch((error: unknown) => error as AccountFailure)
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1) })
    const signal = fetcher.mock.calls[0]?.[1]?.signal
    await session.dispose(); wait.resolve(Response.json(pair))
    expect((await operation as AccountFailure).code).toBe('cancelled')
    expect(signal?.aborted).toBe(true)
    expect(store.write).not.toHaveBeenCalled()
    expect(saved.refresh).toBe('stored-refresh')
  })
  it('compensates an already-running storage write during teardown', async () => {
    const { session, store, saved } = fixture('stored-refresh')
    const write = deferred<undefined>()
    vi.mocked(store.write).mockImplementationOnce(async (refresh, access) => {
      await write.promise; saved.refresh = refresh; saved.access = access
    })
    const operation = session.access().catch((error: unknown) => error as AccountFailure)
    await vi.waitFor(() => { expect(store.write).toHaveBeenCalledTimes(1) })
    const dispose = session.dispose(); write.resolve(undefined); await operation; await dispose
    expect(saved.refresh).toBeNull()
    expect(saved.access).toBeNull()
  })
  it('awaits teardown before a rebuilt owner can persist a replacement account', async () => {
    const { session, store, saved } = fixture('stored-refresh')
    const write = deferred<undefined>()
    vi.mocked(store.write).mockImplementationOnce(async (refresh, access) => {
      await write.promise; saved.refresh = refresh; saved.access = access
    })
    const pending = session.access().catch(() => undefined)
    await vi.waitFor(() => { expect(store.write).toHaveBeenCalledTimes(1) })
    let disposed = false
    const teardown = session.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    write.resolve(undefined); await teardown; await pending
    const rebuilt = new AccountSession(new AccountProtocol(config, async input => Response.json(urlOf(input).endsWith('/auth/me') ? identity : pair)), store)
    expect((await rebuilt.login('new-user', 'fixture-password')).phase).toBe('authenticated')
    expect(saved.refresh).toBe(pair.refresh_token)
    await rebuilt.dispose()
    expect(saved.refresh).toBe(pair.refresh_token)
  })
  it('does not apply an older logout failure to a newer account', async () => {
    const { session, store, fetcher } = fixture()
    await session.login('test-user', 'fixture-password')
    const clear = deferred<undefined>()
    vi.mocked(store.clear).mockImplementationOnce(() => clear.promise)
    const logout = session.logout()
    const login = session.login('new-user', 'fixture-password')
    const oldLogout = deferred<Response>()
    const prior = fetcher.getMockImplementation()!
    fetcher.mockImplementation((input, init) => urlOf(input).endsWith('/auth/logout') ? oldLogout.promise : prior(input, init))
    clear.resolve(undefined); await login
    oldLogout.resolve(Response.json({}, { status: 503 })); await logout
    expect(await session.snapshot()).toMatchObject({ phase: 'authenticated', failure: null })
  })
  it('does not claim authentication when durable storage fails', async () => {
    const { session, store, saved } = fixture()
    vi.mocked(store.write).mockRejectedValueOnce(new Error('private-disk-details'))
    expect(await session.login('test-user', 'fixture-password')).toMatchObject({ phase: 'unavailable', account: null, failure: 'storage-failed', restorable: false })
    expect(saved.refresh).toBeNull()
  })
})
