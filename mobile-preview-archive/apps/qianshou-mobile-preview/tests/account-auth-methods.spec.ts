// @vitest-environment jsdom
/** Login method navigation and registration use the real Shanghai account client contract. */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAccountClient, createTokenStore } from '@deepseek-ai/dsh-client-account'
import { createAccountDialog } from '../src/components/account-dialog.ts'

const text = {
  account: '账号登录', phone: '手机号登录', wechat: '微信号登录', register: '注册账号', submit: '提交注册',
  identity: '用户名（可选）', email: '邮箱（可选）', password: '设置密码', confirm: '确认密码',
}
const styles = readFileSync('apps/qianshou-mobile-preview/src/styles.css', 'utf8')
const skin = readFileSync('apps/qianshou-mobile-preview/src/concept-skin.css', 'utf8')

function harness() {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname
    calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    if (path.endsWith('/auth/register')) return Response.json({ ok: true, account: null })
    throw new Error(`UNEXPECTED_ENDPOINT ${path}`)
  })
  const client = createAccountClient({ baseUrl: 'https://app.example.test', prefix: '/account-api/api/v8', fetch: fetcher, tokens: createTokenStore({ cookiesAvailable: false }) })
  const dialog = document.createElement('dialog')
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false }
  const component = createAccountDialog({
    client, dialog, currentAccount: () => null,
    reader: { profile: async () => ({ display_name: null, phone: null, language: null, country: null }), sessions: async () => [] },
    onAuthenticated: vi.fn(), onSignedOut: vi.fn(), onConnections: vi.fn(), onNotice: vi.fn(),
  })
  document.body.append(dialog)
  return { dialog, component, calls, fetcher }
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('mobile account entry methods', () => {
  it('keeps four login entries stacked under the form, not in a horizontal row', () => {
    const h = harness(); h.component.open()
    const form = h.dialog.querySelector('.login-form')
    const methods = h.dialog.querySelector('[data-testid="auth-methods"]')
    expect(form).not.toBeNull()
    expect(methods).not.toBeNull()
    expect(Boolean(form && methods && (form.compareDocumentPosition(methods) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
    expect([...methods!.querySelectorAll('button')].map(item => item.textContent)).toEqual([
      text.account, text.phone, text.wechat, text.register,
    ])
    expect(styles).not.toMatch(/\.auth-methods\s*\{[^}]*grid-template-columns:\s*repeat\(3/)
    expect(skin).not.toMatch(/\.auth-methods\s*\{[^}]*grid-template-columns:\s*repeat\(3/)
    expect(skin).toMatch(/\.account-dialog-login[^{]*\{[^}]*height:\s*100dvh/)
    expect(skin).toMatch(/\.account-dialog-login[^{]*\{[^}]*inset:\s*0/)
    expect(skin).not.toMatch(/\.account-dialog\s*\{[^}]*height:\s*100dvh/)
    expect(skin).toMatch(/\.auth-method\s*\{[^}]*text-align:\s*center/)
    expect(skin).toMatch(/\.auth-method-phone/)
    expect(skin).toMatch(/\.auth-method-wechat/)
    expect([...h.dialog.querySelectorAll<HTMLButtonElement>('.auth-legal-link')].map(item => item.textContent)).toEqual(['《用户协议》', '《隐私政策》'])
    expect(h.dialog.querySelector('.auth-manifesto')?.textContent).toBe('无极问道\n千手执棋')
    expect(h.dialog.querySelector('.auth-intro')?.nextElementSibling?.classList.contains('login-form')).toBe(true)
    expect(h.dialog.querySelector('[data-testid="auth-legal-terms"]')).toBeNull()
    ;[...h.dialog.querySelectorAll<HTMLButtonElement>('.auth-legal-link')].find(item => item.textContent?.includes('用户协议'))?.click()
    expect(h.dialog.querySelector('[data-testid="auth-legal-terms"]')?.textContent).toContain('沈阳千手执棋')
  })

  it('opens the real phone flow while keeping unconfigured WeChat login unavailable', () => {
    const h = harness(); h.component.open()
    const phone = [...h.dialog.querySelectorAll('button')].find(item => item.textContent?.includes(text.phone))
    const wechat = [...h.dialog.querySelectorAll('button')].find(item => item.textContent?.includes(text.wechat))
    expect(phone?.getAttribute('aria-disabled')).toBe(null)
    expect(wechat?.getAttribute('aria-disabled')).toBe('true')
    phone?.click()
    expect(h.dialog.textContent).toContain('手机验证码登录')
    expect(h.dialog.querySelector('input[aria-label="中国大陆手机号"]')).not.toBeNull()
    expect(h.dialog.querySelector('.login-form')).not.toBeNull()
    expect(h.calls).toHaveLength(0)
    ;[...h.dialog.querySelectorAll('button')].find(item => item.textContent === '返回账号登录')?.click()
    ;[...h.dialog.querySelectorAll('button')].find(item => item.textContent?.includes(text.wechat))?.click()
    expect(h.dialog.textContent).toContain('微信登录待配置，请先使用账号登录。')
    expect(h.calls).toHaveLength(0)
  })

  it('submits registration to Shanghai, then returns to login without auto-authenticating', async () => {
    const h = harness(); h.component.open()
    const register = [...h.dialog.querySelectorAll('button')].find(item => item.textContent?.includes('注册'))
    register?.click()
    expect(h.dialog.textContent).toContain('创建千手账号')
    const find = (label: string): HTMLInputElement => h.dialog.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    find(text.identity).value = 'new-user'
    find(text.email).value = 'new@example.test'
    find(text.password).value = 'private-password'
    find(text.confirm).value = 'private-password'
    const form = h.dialog.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => { expect(h.calls.some(call => call.path.endsWith('/auth/register'))).toBe(true) })
    expect(h.calls.find(call => call.path.endsWith('/auth/register'))?.body).toEqual({
      password: 'private-password', username: 'new-user', email: 'new@example.test', remember_me: false,
    })
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('注册请求已提交') })
    expect(h.dialog.querySelector('input[aria-label="密码"]')).not.toBeNull()
  })

  it('requires an identity before making a registration request', async () => {
    const h = harness(); h.component.open()
    ;[...h.dialog.querySelectorAll('button')].find(item => item.textContent?.includes('注册'))?.click()
    const find = (label: string): HTMLInputElement => h.dialog.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    find(text.password).value = 'private-password'; find(text.confirm).value = 'private-password'
    h.dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => { expect(h.dialog.textContent).toContain('请至少填写用户名或邮箱') })
    expect(h.calls.some(call => call.path.endsWith('/auth/register'))).toBe(false)
  })
})
