/**
 * Account-controller behaviour against real `Response` objects on the six
 * workbench routes.
 *
 * What these cases defend, in the order they matter:
 *
 * 1. the exact route, method, credentials and JSON body of every call;
 * 2. the 2FA boundary — a challenge is not a sign-in, and the code step is the
 *    only thing that completes it;
 * 3. the honesty rules — a failed call never publishes a session, a
 *    registration never claims one, and an unreported field is never invented;
 * 4. the secret rules — a password exists only inside the request body, and the
 *    challenge token never leaves the controller except into `login-totp`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_ROUTES, AccountFailure, parseAccount, parseAcknowledged, parseLogin, parseRegister, parseSnapshot,
  toFailure, type AccountProfile,
} from '../src/client/account-wire.ts'
import { AccountController } from '../src/client/account-store.ts'

/** The profile shape the Host forwards from upstream, balance included. */
const profile: AccountProfile = {
  id: 7,
  username: 'owner',
  email: 'owner@example.com',
  role: 'personal',
  status: 'active',
  balance: '12.50',
  created_at: '2026-01-01T00:00:00Z',
  last_login_at: '2026-09-15T10:00:00Z',
}

/** A manual promise, so one test can hold a call open and observe the guard. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

/** Record every call and answer it from a script. */
function scripted(answers: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    const next = answers.shift()
    if (next === undefined) throw new Error(`unexpected request: ${url}`)
    return await next()
  })
  return { transport, calls }
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status })
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown

describe('account wire contract', () => {
  it('reads a signed-out observation without inventing an account', () => {
    expect(parseSnapshot({ ok: true, state: 'signed-out', account: null }, 200))
      .toEqual({ state: 'signed-out', account: null })
  })

  it('keeps the Host sentence of a failure instead of replacing it', () => {
    const failure = (() => {
      try {
        parseSnapshot({ ok: false, message: '用户名或密码错误' }, 400)
        return null
      } catch (error) { return error }
    })()
    expect(failure).toBeInstanceOf(AccountFailure)
    expect((failure as AccountFailure).code).toBe('host')
    expect((failure as AccountFailure).message).toBe('用户名或密码错误')
  })

  it('marks a message-less rejection as a rejection and a non-object body as invalid', () => {
    expect(toFailure(new AccountFailure('host', 'x')).code).toBe('host')
    expect(toFailure(new TypeError('Failed to fetch'))).toMatchObject({ code: 'unreachable', message: 'Failed to fetch' })
    expect(toFailure('boom')).toMatchObject({ code: 'unreachable', message: 'ACCOUNT_REQUEST_FAILED' })
    let thrown: unknown
    try { parseSnapshot({ ok: false }, 500) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ code: 'rejected', message: 'HTTP_500' })
    try { parseSnapshot('nope', 200) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ code: 'invalid' })
  })

  it('rejects an unknown session state rather than mapping it to signed-out', () => {
    expect(() => parseSnapshot({ ok: true, state: 'maybe', account: null }, 200)).toThrow(AccountFailure)
  })

  it('normalizes an incomplete account but refuses an unusable one', () => {
    expect(parseAccount({ id: 'a' })).toEqual({
      id: 'a', username: '', email: '', role: '', status: '', balance: null, created_at: null, last_login_at: null,
    })
    expect(parseAccount({ id: 1, balance: '3' })?.balance).toBe('3')
    expect(parseAccount(null)).toBeNull()
    expect(() => parseAccount({ username: 'no-id' })).toThrow(AccountFailure)
    expect(() => parseAccount({ id: 1, balance: { yuan: 1 } })).toThrow(AccountFailure)
  })

  it('treats a 2FA answer as its own outcome and requires its token', () => {
    expect(parseLogin({ ok: true, twoFactor: false, account: profile }, 200))
      .toEqual({ kind: 'signed-in', account: profile })
    expect(parseLogin({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-1', default_method: 'totp' } }, 200))
      .toEqual({ kind: 'two-factor', challenge: { token: 'ch-1', method: 'totp' } })
    // A missing default_method must not become an invented method.
    expect(parseLogin({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-2' } }, 200))
      .toEqual({ kind: 'two-factor', challenge: { token: 'ch-2', method: 'totp' } })
    expect(() => parseLogin({ ok: true, twoFactor: true, challenge: {} }, 200)).toThrow(AccountFailure)
    expect(() => parseLogin({ ok: true, account: profile }, 200)).toThrow(AccountFailure)
  })

  it('requires the register answer to state whether a session was created', () => {
    expect(parseRegister({ ok: true, signedIn: false }, 200)).toEqual({ signedIn: false })
    expect(() => parseRegister({ ok: true }, 200)).toThrow(AccountFailure)
    expect(parseAcknowledged({ ok: true, account: profile }, 200)).toEqual(profile)
    expect(parseAcknowledged({ ok: true }, 200)).toBeNull()
  })
})

describe('account controller', () => {
  it('reads the Host session state from the real route and publishes it whole', async () => {
    const { transport, calls } = scripted([() => json({ ok: true, state: 'signed-out', account: null })])
    const controller = new AccountController(transport)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({
      session: 'signed-out', account: null, step: 'credentials', loading: false, busy: false, error: null,
    })
    expect(calls.map(call => call.url)).toEqual([ACCOUNT_ROUTES.state])
    expect(calls[0]?.init).toMatchObject({
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    })
    expect(bodyOf(calls[0]?.init)).toEqual({})
    controller.dispose()
  })

  it('publishes the Host sentence, and no session, when the observation fails', async () => {
    const { transport } = scripted([() => json({ ok: false, message: '读不到账号信息（可能没登录或网络不通）。' }, 401)])
    const controller = new AccountController(transport)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({
      session: null, loading: false, error: { kind: 'host', message: '读不到账号信息（可能没登录或网络不通）。' },
    })
    controller.dispose()
  })

  it('reports a transport fault as unreachable and an unreadable body as invalid', async () => {
    const down = new AccountController(vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch') }))
    await down.refresh()
    expect(down.store.getSnapshot().error).toMatchObject({ kind: 'unreachable' })
    down.dispose()
    const broken = new AccountController(vi.fn<typeof fetch>(async () => new Response('<html>', { status: 502 })))
    await broken.refresh()
    expect(broken.store.getSnapshot().error).toMatchObject({ kind: 'invalid', message: 'HTTP_502' })
    broken.dispose()
  })

  it('signs in with the password in the request body only, then takes the Host\'s own session state', async () => {
    const { transport, calls } = scripted([
      () => json({ ok: true, twoFactor: false, account: profile }),
      () => json({ ok: true, state: 'authenticated', account: profile }),
    ])
    const controller = new AccountController(transport)
    await controller.login('owner', 'correct-horse')
    expect(calls.map(call => call.url)).toEqual([ACCOUNT_ROUTES.login, ACCOUNT_ROUTES.state])
    expect(bodyOf(calls[0]?.init)).toEqual({ username: 'owner', password: 'correct-horse' })
    expect(controller.store.getSnapshot()).toMatchObject({
      session: 'authenticated', account: profile, step: 'credentials', notice: null, error: null,
    })
    controller.dispose()
  })

  it('stops at the 2FA challenge: no session is published until the code step completes', async () => {
    const { transport, calls } = scripted([
      () => json({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-1', default_method: 'totp' } }),
      () => json({ ok: true, account: profile }),
      () => json({ ok: true, state: 'authenticated', account: profile }),
    ])
    const controller = new AccountController(transport)
    await controller.login('owner', 'correct-horse')
    expect(controller.store.getSnapshot()).toMatchObject({
      step: 'totp', notice: 'totpRequired', session: null, account: null,
    })
    await controller.submitTotp('123456', true)
    expect(calls.map(call => call.url)).toEqual([ACCOUNT_ROUTES.login, ACCOUNT_ROUTES.loginTotp, ACCOUNT_ROUTES.state])
    expect(bodyOf(calls[1]?.init)).toEqual({ challengeToken: 'ch-1', code: '123456', trustDevice: true })
    expect(controller.store.getSnapshot()).toMatchObject({ step: 'credentials', session: 'authenticated', account: profile })
    controller.dispose()
  })

  it('sends no trust flag when the device box is clear, and no code step survives a failure', async () => {
    const { transport, calls } = scripted([
      () => json({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-2', default_method: 'totp' } }),
      () => json({ ok: false, message: '验证码不正确' }, 400),
    ])
    const controller = new AccountController(transport)
    await controller.login('owner', 'correct-horse')
    await controller.submitTotp('000000', false)
    expect(bodyOf(calls[1]?.init)).toEqual({ challengeToken: 'ch-2', code: '000000' })
    expect(controller.store.getSnapshot()).toMatchObject({
      step: 'totp', error: { kind: 'host', message: '验证码不正确' },
    })
    controller.dispose()
  })

  it('refuses to verify a code while another call is still running', async () => {
    const held = deferred<Response>()
    const { transport, calls } = scripted([
      () => json({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-3', default_method: 'totp' } }),
      () => held.promise,
    ])
    const controller = new AccountController(transport)
    await controller.login('owner', 'pw')
    const verifying = controller.verify()
    await controller.submitTotp('123456', true)
    expect(calls.map(call => call.url)).toEqual([ACCOUNT_ROUTES.login, ACCOUNT_ROUTES.me])
    held.resolve(json({ ok: true, state: 'authenticated', account: profile }))
    await verifying
    expect(controller.store.getSnapshot()).toMatchObject({ step: 'totp', session: 'authenticated' })
    controller.dispose()
  })

  it('keeps the session it had when the sign-out call itself fails', async () => {
    const { transport } = scripted([
      () => json({ ok: true, state: 'authenticated', account: profile }),
      () => json({ ok: false, message: '退出登录失败，请稍后再试。' }, 400),
    ])
    const controller = new AccountController(transport)
    await controller.refresh()
    await controller.logout()
    expect(controller.store.getSnapshot()).toMatchObject({
      session: 'authenticated', account: profile, error: { kind: 'host', message: '退出登录失败，请稍后再试。' },
    })
    controller.dispose()
  })

  it('verifies nothing when no challenge is pending, and can leave the code step', async () => {
    const { transport } = scripted([])
    const controller = new AccountController(transport)
    await controller.submitTotp('123456', true)
    expect(transport).not.toHaveBeenCalled()
    await controller.login('owner', 'pw')
    controller.backToCredentials()
    expect(controller.store.getSnapshot()).toMatchObject({ step: 'credentials', notice: null })
    controller.dispose()
  })

  it('creates an account without claiming a session, then asks the user to sign in', async () => {
    const { transport, calls } = scripted([
      () => json({ ok: true, signedIn: false }),
      () => json({ ok: true, state: 'signed-out', account: null }),
    ])
    const controller = new AccountController(transport)
    await controller.register('new-password', 'newbie', 'new@example.com')
    expect(calls.map(call => call.url)).toEqual([ACCOUNT_ROUTES.register, ACCOUNT_ROUTES.state])
    expect(bodyOf(calls[0]?.init)).toEqual({ password: 'new-password', username: 'newbie', email: 'new@example.com' })
    expect(controller.store.getSnapshot()).toMatchObject({
      session: 'signed-out', account: null, step: 'credentials', notice: 'registered', error: null,
    })
    controller.dispose()
  })

  it('omits blank optional register fields and never predicts a sign-in the Host did not confirm', async () => {
    const { transport, calls } = scripted([
      () => json({ ok: true, signedIn: true }),
      () => json({ ok: true, state: 'authenticated', account: profile }),
    ])
    const controller = new AccountController(transport)
    await controller.register('pw', '', '')
    expect(bodyOf(calls[0]?.init)).toEqual({ password: 'pw' })
    // The Host said it created a session and the observation agrees: the page
    // must not tell the user to sign in again.
    expect(controller.store.getSnapshot()).toMatchObject({ session: 'authenticated', notice: null })
    controller.dispose()
  })

  it('signs out through the Host and clears the account it was showing', async () => {
    const { transport, calls } = scripted([
      () => json({ ok: true, state: 'authenticated', account: profile }),
      () => json({ ok: true }),
      () => json({ ok: true, state: 'signed-out', account: null }),
    ])
    const controller = new AccountController(transport)
    await controller.refresh()
    await controller.logout()
    expect(calls.map(call => call.url)).toEqual([ACCOUNT_ROUTES.state, ACCOUNT_ROUTES.logout, ACCOUNT_ROUTES.state])
    expect(controller.store.getSnapshot()).toMatchObject({ session: 'signed-out', account: null, notice: 'signedOut' })
    controller.dispose()
  })

  it('re-reads the upstream profile on demand and keeps the shown account when that read fails', async () => {
    const { transport, calls } = scripted([
      () => json({ ok: true, state: 'authenticated', account: { ...profile, balance: '1.00' } }),
      () => json({ ok: true, state: 'authenticated', account: { ...profile, balance: '9.99' } }),
      () => json({ ok: false, message: '读不到账号信息（可能没登录或网络不通）。' }, 401),
    ])
    const controller = new AccountController(transport)
    await controller.refresh()
    await controller.verify()
    expect(calls[1]?.url).toBe(ACCOUNT_ROUTES.me)
    expect(controller.store.getSnapshot().account?.balance).toBe('9.99')
    await controller.verify()
    expect(controller.store.getSnapshot()).toMatchObject({
      account: { balance: '9.99' }, error: { kind: 'host', message: '读不到账号信息（可能没登录或网络不通）。' },
    })
    controller.dispose()
  })

  it('keeps a known account when a later observation omits it, and drops it on sign-out', async () => {
    const { transport } = scripted([
      () => json({ ok: true, state: 'authenticated', account: profile }),
      () => json({ ok: true, state: 'authenticated', account: null }),
      () => json({ ok: true, state: 'signed-out', account: null }),
    ])
    const controller = new AccountController(transport)
    await controller.refresh()
    await controller.refresh()
    expect(controller.store.getSnapshot().account).toEqual(profile)
    await controller.refresh()
    expect(controller.store.getSnapshot().account).toBeNull()
    controller.dispose()
  })

  it('refuses every call kind while one is already in flight', async () => {
    const pending = deferred<Response>()
    const { transport } = scripted([() => pending.promise])
    const controller = new AccountController(transport)
    const first = controller.refresh()
    await controller.verify()
    await controller.login('owner', 'pw')
    await controller.register('pw', 'owner', '')
    await controller.logout()
    expect(transport).toHaveBeenCalledTimes(1)
    pending.resolve(json({ ok: true, state: 'signed-out', account: null }))
    await first
    expect(controller.store.getSnapshot()).toMatchObject({ session: 'signed-out', busy: false })
    controller.dispose()
  })

  it('suppresses a late answer once the plugin has left', async () => {
    const pending = deferred<Response>()
    const { transport } = scripted([() => pending.promise])
    const controller = new AccountController(transport)
    const first = controller.refresh()
    controller.dispose()
    pending.resolve(json({ ok: true, state: 'authenticated', account: profile }))
    await first
    // The observation landed after disposal: a late answer must not resurrect
    // a section that is gone.
    expect(controller.store.getSnapshot()).toMatchObject({ session: null, busy: true })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('suppresses a late failure, so an aborted call is never shown as the user\'s error', async () => {
    const pending = deferred<Response>()
    const { transport } = scripted([() => pending.promise])
    const controller = new AccountController(transport)
    const first = controller.refresh()
    controller.dispose()
    pending.reject(new TypeError('aborted'))
    await first
    expect(controller.store.getSnapshot()).toMatchObject({ session: null, error: null, loading: true })
  })

  it('refuses a second call while one is in flight, and every call after disposal', async () => {
    const pending = deferred<Response>()
    const { transport } = scripted([() => pending.promise])
    const controller = new AccountController(transport)
    const first = controller.refresh()
    expect(controller.store.getSnapshot().busy).toBe(true)
    await controller.refresh()
    expect(transport).toHaveBeenCalledTimes(1)
    pending.resolve(json({ ok: true, state: 'signed-out', account: null }))
    await first
    expect(controller.store.getSnapshot().busy).toBe(false)
    controller.dispose()
    await controller.refresh()
    await controller.logout()
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
