// @vitest-environment jsdom
/**
 * Rendered-account-page coverage for the behaviours the user actually asked
 * for: see the state, sign in, complete a 2FA step, register, sign out, and
 * read the account and balance.
 *
 * Every case drives the real controller over a scripted transport, so the
 * assertions cover the rendered page *and* the exact request it produced — a
 * page that looked right while calling the wrong route would fail here.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AccountSection, type AccountSectionProps } from '../src/client/AccountSection.tsx'
import { AccountController } from '../src/client/account-store.ts'
import type { AccountMode } from '../src/client/account-store.ts'
import type { AccountProfile } from '../src/client/account-wire.ts'
import { accountZh, type AccountKey } from '../src/client/locales.ts'

afterEach(cleanup)

/** The account the Host forwards from upstream. */
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

/** Answer one call with a JSON body and a status (`Response.json` takes a ResponseInit). */
const respond = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } })

const signedOut = (): Response => respond({ ok: true, state: 'signed-out', account: null })
const signedIn = (account: AccountProfile = profile): Response =>
  respond({ ok: true, state: 'authenticated', account })
const accepted = (body: unknown): Response => respond(body)

/** One recorded request; the body is the JSON the page actually sent. */
interface Call { readonly url: string; readonly body: unknown }

/** Render the section over a scripted transport, one answer per request. */
function bench(answers: Array<Response | (() => Promise<Response>)>) {
  const calls: Call[] = []
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const raw = typeof init?.body === 'string' ? init.body : 'null'
    calls.push({ url, body: JSON.parse(raw) as unknown })
    const next = answers.shift()
    if (next === undefined) throw new Error(`unexpected request: ${url}`)
    return typeof next === 'function' ? await next() : next
  })
  const controller = new AccountController(transport)
  const t = (key: AccountKey): string => accountZh[key]
  const unused = (() => { throw new Error('the account page uses no global standard hook') }) as never
  const props = {
    t,
    close: vi.fn(),
    refresh: () => controller.refresh(),
    verify: () => controller.verify(),
    login: (username: string, password: string) => controller.login(username, password),
    submitTotp: (code: string, trustDevice: boolean) => controller.submitTotp(code, trustDevice),
    backToCredentials: () => { controller.backToCredentials() },
    register: (password: string, username: string, email: string) => controller.register(password, username, email),
    showForm: (mode: AccountMode) => { controller.showForm(mode) },
    logout: () => controller.logout(),
    useSnapshot: bindSnapshotSelector(controller.store),
    useSessions: unused,
    useWorkspaces: unused,
    useResource: unused,
    usePanelInfo: (selector: (value: { activePanelId: null }) => unknown) => selector({ activePanelId: null }),
  } as unknown as AccountSectionProps
  render(<AccountSection {...props} />)
  return { controller, calls, props }
}

/** Let the mount-time observation and any click-driven call settle. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

const field = (key: AccountKey): HTMLInputElement => screen.getByLabelText(accountZh[key]) as HTMLInputElement
const button = (key: AccountKey): HTMLElement => screen.getByRole('button', { name: accountZh[key] })
const typeIn = (key: AccountKey, value: string): void => {
  fireEvent.change(field(key), { target: { value } })
}
const click = async (key: AccountKey): Promise<void> => {
  await act(async () => { fireEvent.click(button(key)) })
  await settle()
}

describe('account page: signed-out state', () => {
  it('renders the Host\'s not-signed-in state and asks the Host for it on mount', async () => {
    const { calls } = bench([signedOut()])
    await settle()
    expect(calls.map(call => call.url)).toEqual(['/api/qianshou/account/state'])
    expect(screen.getByText(accountZh['status.signedOut'])).toBeTruthy()
    expect(screen.getByText(accountZh['signedOutHint'])).toBeTruthy()
    // The credentials form is the only action offered, and no signed-in
    // affordance or balance exists yet.
    expect(screen.getByText(accountZh['login'])).toBeTruthy()
    expect(screen.queryByText(accountZh['status.signedIn'])).toBeNull()
    expect(screen.queryByText(accountZh['logout'])).toBeNull()
    expect(screen.queryByText(accountZh['refresh'])).toBeNull()
    expect(screen.queryByText(accountZh['balance'])).toBeNull()
  })

  it('says it is still reading before the first observation lands', () => {
    bench([new Promise(() => new Response()) as unknown as Response])
    expect(screen.getByText(accountZh['status.loading'])).toBeTruthy()
  })

  it('keeps the Host\'s sentence when the state read fails', async () => {
    bench([respond({ ok: false, message: '读不到账号信息（可能没登录或网络不通）。' }, 401)])
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('读不到账号信息（可能没登录或网络不通）。')
  })
})

describe('account page: sign-in', () => {
  it('switches to the signed-in state with the account and balance after a successful login', async () => {
    const { calls } = bench([
      signedOut(),
      accepted({ ok: true, twoFactor: false, account: profile }),
      signedIn(),
    ])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    await click('login.submit')
    expect(calls.map(call => call.url)).toEqual([
      '/api/qianshou/account/state', '/api/qianshou/account/login', '/api/qianshou/account/state',
    ])
    expect(calls[1]?.body).toEqual({ username: 'owner', password: 'pw-123456' })
    expect(screen.getByText(accountZh['status.signedIn'])).toBeTruthy()
    expect(screen.getByText('owner')).toBeTruthy()
    expect(screen.getByText('owner@example.com')).toBeTruthy()
    // The balance is stated twice on purpose: once beside the state, once in
    // the account facts.
    expect(screen.getAllByText('12.50')).toHaveLength(2)
    expect(screen.getByText(accountZh['logout'])).toBeTruthy()
    // The password field is gone with the form, the password is nowhere in the
    // rendered page, and nothing was persisted.
    expect(screen.queryByLabelText(accountZh['password'])).toBeNull()
    expect(document.body.innerHTML).not.toContain('pw-123456')
    expect(window.localStorage.length).toBe(0)
  })

  it('shows the Host\'s own failure sentence and stays signed out', async () => {
    const { calls } = bench([signedOut(), respond({ ok: false, message: '用户名或密码错误' }, 400)])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'wrong')
    await click('login.submit')
    expect(calls.map(call => call.url)).toEqual(['/api/qianshou/account/state', '/api/qianshou/account/login'])
    expect(screen.getByRole('alert').textContent).toBe('用户名或密码错误')
    expect(screen.getByText(accountZh['status.signedOut'])).toBeTruthy()
    expect(screen.queryByText(accountZh['status.signedIn'])).toBeNull()
  })

  it('reports a workbench it cannot reach without inventing a reason', async () => {
    bench([() => Promise.reject(new TypeError('Failed to fetch'))])
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(accountZh['error.unreachable'])
  })

  it('separates an unreadable answer from a refusal that carried no reason', async () => {
    const unreadable = bench([() => Promise.resolve(new Response('<html>not json</html>', { status: 200 }))])
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(accountZh['error.invalid'])
    unreadable.controller.dispose()
    cleanup()
    bench([respond({ ok: false }, 500)])
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(accountZh['error.rejected'])
  })

  it('holds the form while the page is busy with a call it did not start', async () => {
    // The mount read is still in flight, so submitting must not queue a login.
    const { calls } = bench([new Promise(() => {}) as unknown as Response])
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    const form = document.querySelector('form') as HTMLFormElement
    await act(async () => { fireEvent.submit(form) })
    expect(calls.map(call => call.url)).toEqual(['/api/qianshou/account/state'])
    expect((screen.getByRole('button', { name: accountZh['login.busy'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends one login request when the button is clicked twice', async () => {
    let release = (): void => {}
    const held = new Promise<Response>((resolve) => {
      release = () => { resolve(accepted({ ok: true, twoFactor: false, account: profile })) }
    })
    const { calls } = bench([signedOut(), () => held, signedIn()])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    // One node, two clicks: the second lands while the first is still in
    // flight and the page already reports itself busy.
    const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement
    fireEvent.click(submit)
    fireEvent.click(submit)
    await act(async () => { release() })
    await settle()
    expect(calls.filter(call => call.url.endsWith('/login'))).toHaveLength(1)
  })

  it('disables the submit button until both fields are filled', async () => {
    bench([signedOut()])
    await settle()
    expect((button('login.submit') as HTMLButtonElement).disabled).toBe(true)
    typeIn('login.identifier', 'owner')
    expect((button('login.submit') as HTMLButtonElement).disabled).toBe(true)
    typeIn('password', 'pw')
    expect((button('login.submit') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('account page: two-step verification', () => {
  it('moves to the code step on twoFactor:true and does not call it a sign-in', async () => {
    const { calls } = bench([
      signedOut(),
      accepted({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-9', default_method: 'totp' } }),
    ])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    await click('login.submit')
    expect(screen.getByText(accountZh['totp.title'])).toBeTruthy()
    expect(screen.getByText(accountZh['totpRequired'])).toBeTruthy()
    expect(field('totp.code')).toBeTruthy()
    expect(screen.queryByText(accountZh['status.signedIn'])).toBeNull()
    expect(screen.queryByText(accountZh['logout'])).toBeNull()
    // The challenge token stays inside the controller: it is in no request the
    // page has sent yet and in no rendered node.
    expect(calls).toHaveLength(2)
    expect(document.body.innerHTML).not.toContain('ch-9')
  })

  it('completes the sign-in only after the code is verified, and sends the code body', async () => {
    const { calls } = bench([
      signedOut(),
      accepted({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-9', default_method: 'totp' } }),
      accepted({ ok: true, account: profile }),
      signedIn(),
    ])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    await click('login.submit')
    typeIn('totp.code', '123456')
    await click('totp.submit')
    expect(calls.map(call => call.url)).toEqual([
      '/api/qianshou/account/state', '/api/qianshou/account/login',
      '/api/qianshou/account/login-totp', '/api/qianshou/account/state',
    ])
    expect(calls[2]?.body).toEqual({ challengeToken: 'ch-9', code: '123456', trustDevice: true })
    expect(screen.getByText(accountZh['status.signedIn'])).toBeTruthy()
    // The code step is gone, and the code is nowhere in the page.
    expect(screen.queryByLabelText(accountZh['totp.code'])).toBeNull()
    expect(document.body.innerHTML).not.toContain('123456')
  })

  it('sends the trust flag only while the device box is checked', async () => {
    const { calls } = bench([
      signedOut(),
      accepted({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-9', default_method: 'totp' } }),
      accepted({ ok: true, account: profile }),
      signedIn(),
    ])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    await click('login.submit')
    const box = screen.getByRole('checkbox', { name: accountZh['totp.trust'] }) as HTMLInputElement
    // Trusting this browser is the default, and clearing it is honoured.
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(box.checked).toBe(false)
    typeIn('totp.code', '123456')
    await click('totp.submit')
    expect(calls[2]?.body).toEqual({ challengeToken: 'ch-9', code: '123456' })
  })

  it('keeps the code step open with the Host sentence when the code is rejected', async () => {
    const { calls } = bench([
      signedOut(),
      accepted({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-9', default_method: 'totp' } }),
      respond({ ok: false, message: '验证码不正确' }, 400),
    ])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    await click('login.submit')
    typeIn('totp.code', '000000')
    await click('totp.submit')
    expect(screen.getByRole('alert').textContent).toBe('验证码不正确')
    expect(field('totp.code')).toBeTruthy()
    expect(calls).toHaveLength(3)
  })

  it('lets the user leave the code step instead of stranding them there', async () => {
    bench([
      signedOut(),
      accepted({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-9', default_method: 'totp' } }),
    ])
    await settle()
    typeIn('login.identifier', 'owner')
    typeIn('password', 'pw-123456')
    await click('login.submit')
    await click('totp.back')
    expect(screen.queryByLabelText(accountZh['totp.code'])).toBeNull()
    expect(screen.getByText(accountZh['login'])).toBeTruthy()
    expect(screen.getByText(accountZh['status.signedOut'])).toBeTruthy()
  })
})

describe('account page: registration', () => {
  it('tells the user to sign in with the account it just created, and does not sign them in', async () => {
    const { calls } = bench([
      signedOut(),
      accepted({ ok: true, signedIn: false }),
      signedOut(),
    ])
    await settle()
    await click('toRegister')
    typeIn('register.identifier', 'newbie')
    typeIn('register.email', 'new@example.com')
    typeIn('password', 'brand-new-pw')
    await click('register.submit')
    expect(calls.map(call => call.url)).toEqual([
      '/api/qianshou/account/state', '/api/qianshou/account/register', '/api/qianshou/account/state',
    ])
    expect(calls[1]?.body).toEqual({ password: 'brand-new-pw', username: 'newbie', email: 'new@example.com' })
    expect(screen.getByText(accountZh['registered'])).toBeTruthy()
    expect(screen.getByText(accountZh['status.signedOut'])).toBeTruthy()
    expect(screen.queryByText(accountZh['status.signedIn'])).toBeNull()
    // The page is back on the sign-in form with the typed password cleared.
    expect(screen.getByText(accountZh['login'])).toBeTruthy()
    expect(field('password').value).toBe('')
    expect(document.body.innerHTML).not.toContain('brand-new-pw')
  })

  it('keeps the Host\'s sentence when the account cannot be created', async () => {
    const { calls } = bench([signedOut(), respond({ ok: false, message: '密码太短。' }, 400)])
    await settle()
    await click('toRegister')
    typeIn('password', 'x')
    await click('register.submit')
    expect(screen.getByRole('alert').textContent).toBe('密码太短。')
    expect(screen.getByText(accountZh['register'])).toBeTruthy()
    expect(calls).toHaveLength(2)
  })

  it('switches back to the sign-in form from the register form', async () => {
    bench([signedOut()])
    await settle()
    await click('toRegister')
    typeIn('password', 'typed-here')
    await click('toLogin')
    expect(screen.getByText(accountZh['login'])).toBeTruthy()
    expect(field('password').value).toBe('')
  })
})

describe('account page: signed-in facts', () => {
  it('shows an unreported balance as unknown rather than as zero', async () => {
    bench([signedIn({ ...profile, username: '', balance: null })])
    await settle()
    expect(screen.queryByText('0')).toBeNull()
    // Both the status line and the fact row say unknown; the account name
    // falls back to the same honest placeholder.
    expect(screen.getAllByText(accountZh['balance.unknown'])).toHaveLength(3)
  })

  it('reports a signed-in session whose account could not be read', async () => {
    bench([respond({ ok: true, state: 'authenticated', account: null })])
    await settle()
    expect(screen.getByText(accountZh['status.signedIn'])).toBeTruthy()
    expect(screen.getByText(accountZh['account.missing'])).toBeTruthy()
    expect(screen.getByText(accountZh['logout'])).toBeTruthy()
  })

  it('reports an expired session without claiming a sign-in', async () => {
    bench([respond({ ok: true, state: 'expired', account: null })])
    await settle()
    expect(screen.getByText(accountZh['status.expired'])).toBeTruthy()
    expect(screen.queryByText(accountZh['status.signedIn'])).toBeNull()
    expect(screen.getByText(accountZh['login'])).toBeTruthy()
  })

  it('signs out through the Host and drops the account from the page', async () => {
    const { calls } = bench([signedIn(), accepted({ ok: true }), signedOut()])
    await settle()
    expect(screen.getByText('owner')).toBeTruthy()
    await click('logout')
    expect(calls.map(call => call.url)).toEqual([
      '/api/qianshou/account/state', '/api/qianshou/account/logout', '/api/qianshou/account/state',
    ])
    expect(screen.getByText(accountZh['signedOut'])).toBeTruthy()
    expect(screen.getByText(accountZh['status.signedOut'])).toBeTruthy()
    expect(screen.queryByText('owner')).toBeNull()
    expect(screen.queryByText('12.50')).toBeNull()
  })

  it('re-reads the upstream profile when the user asks for a refresh', async () => {
    const { calls } = bench([
      signedIn({ ...profile, balance: '1.00' }),
      signedIn({ ...profile, balance: '9.99' }),
    ])
    await settle()
    expect(screen.getAllByText('1.00')).toHaveLength(2)
    await click('refresh')
    expect(calls[1]?.url).toBe('/api/qianshou/account/me')
    expect(screen.getAllByText('9.99')).toHaveLength(2)
    expect(screen.queryByText('1.00')).toBeNull()
  })

  it('shows the reported last sign-in as a real timestamp', async () => {
    bench([signedIn()])
    await settle()
    const time = document.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe('2026-09-15T10:00:00Z')
    expect(time?.textContent).not.toBe('')
  })
})
