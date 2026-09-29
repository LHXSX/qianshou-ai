// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAccountClient, createTokenStore } from '@deepseek-ai/dsh-client-account'
import { createAccountDialog } from '../src/components/account-dialog.ts'
import { createFetchStub, memoryRefreshStore, tokenReply, type StubReply } from '../../../packages/client/account/tests/fetch-stub.client.ts'

const account = { id: 42, username: 'sms-user', email: '', role: 'user', status: 'active', balance: '0.00', created_at: null, last_login_at: null }
const sent: StubReply = { kind: 'json', body: { ok: true, phone: '138****8888', purpose: 'login', expires_in: 300, resend_after: 60 } }
function harness(replies: readonly StubReply[]) {
  const stub = createFetchStub(replies)
  const client = createAccountClient({ baseUrl: 'https://accounts.test', fetch: stub.fetch,
    tokens: createTokenStore({ cookiesAvailable: false, refreshStore: memoryRefreshStore() }) })
  const dialog = document.createElement('dialog')
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false }
  const authenticated = vi.fn()
  const component = createAccountDialog({ client, dialog, currentAccount: () => null,
    reader: { profile: async () => ({ display_name: null, phone: null, language: null, country: null }), sessions: async () => [] },
    onAuthenticated: authenticated, onSignedOut: vi.fn(), onNotice: vi.fn() })
  document.body.append(dialog); component.open()
  const click = (label: string): void => {
    const button = [...dialog.querySelectorAll('button')].find(item => item.textContent === label)
    if (!button) throw new Error(`Missing ${label}`)
    button.click()
  }
  const field = (label: string): HTMLInputElement => {
    const input = dialog.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    if (!input) throw new Error(`Missing field ${label}`)
    return input
  }
  const submit = (): void => { dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }
  return { client, component, dialog, stub, authenticated, click, field, submit }
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('mobile phone verification', () => {
  it('sends a purpose-bound SMS then authenticates only after token and /me', async () => {
    const h = harness([sent, tokenReply(), { kind: 'json', body: { ok: true, account } }])
    h.click('手机号登录')
    h.field('中国大陆手机号').value = '13800138888'
    h.click('获取验证码')
    await vi.waitFor(() => expect(h.dialog.textContent).toContain('138****8888'))
    expect(h.stub.at(0).json).toEqual({ phone: '13800138888', purpose: 'login' })
    expect(h.authenticated).not.toHaveBeenCalled()
    h.field('短信验证码').value = '123456'; h.submit()
    await vi.waitFor(() => expect(h.authenticated).toHaveBeenCalledWith(expect.objectContaining({ id: 42 })))
    expect(h.stub.at(1).json).toEqual({ phone: '13800138888', code: '123456', remember_me: false })
    expect(h.client.state()).toBe('authenticated')
    h.component.dispose()
  })

  it('keeps failed sends on the page and does not claim delivery', async () => {
    const h = harness([{ kind: 'json', status: 503, body: { ok: false, detail: 'not configured' } }])
    h.click('手机号登录'); h.field('中国大陆手机号').value = '13800138888'; h.click('获取验证码')
    await vi.waitFor(() => expect(h.dialog.textContent).toContain('短信通道暂不可用'))
    expect(h.dialog.textContent).not.toContain('验证码已发送至')
    expect(h.authenticated).not.toHaveBeenCalled()
    h.component.dispose()
  })

  it('continues a phone first factor through TOTP before authentication', async () => {
    const h = harness([{ kind: 'json', body: { ok: true, two_factor_required: true, challenge_token: 'sms-challenge',
      challenge_expires_in: 300, account_id: 42, available_methods: [{ method: 'totp' }], default_method: 'totp' } },
      tokenReply(), { kind: 'json', body: { ok: true, account } }])
    h.click('手机号登录'); h.field('中国大陆手机号').value = '13800138888'; h.field('短信验证码').value = '123456'; h.submit()
    await vi.waitFor(() => expect(h.dialog.textContent).toContain('请输入验证器中的 6 位验证码'))
    expect(h.authenticated).not.toHaveBeenCalled()
    expect(h.client.tokens.readAccess()).toBe(null)
    h.field('动态验证码').value = '654321'; h.submit()
    await vi.waitFor(() => expect(h.authenticated).toHaveBeenCalledWith(expect.objectContaining({ id: 42 })))
    expect(h.stub.at(1).json).toMatchObject({ challenge_token: 'sms-challenge', code: '654321' })
    h.component.dispose()
  })

  it('registers by phone only after an explicit register code', async () => {
    const h = harness([{ kind: 'json', body: { ok: true, phone: '138****8888', purpose: 'register', expires_in: 300, resend_after: 60 } },
      tokenReply(), { kind: 'json', body: { ok: true, account } }])
    h.click('手机号登录'); h.click('还没有账号？手机号注册')
    h.field('中国大陆手机号').value = '13800138888'; h.field('用户名（可选）').value = 'sms-user'
    h.click('获取验证码')
    await vi.waitFor(() => expect(h.dialog.textContent).toContain('138****8888'))
    expect(h.stub.at(0).json).toEqual({ phone: '13800138888', purpose: 'register' })
    h.field('短信验证码').value = '123456'; h.submit()
    await vi.waitFor(() => expect(h.authenticated).toHaveBeenCalledWith(expect.objectContaining({ id: 42 })))
    expect(h.stub.at(1).json).toEqual({ phone: '13800138888', code: '123456', username: 'sms-user', remember_me: false })
    h.component.dispose()
  })
})
