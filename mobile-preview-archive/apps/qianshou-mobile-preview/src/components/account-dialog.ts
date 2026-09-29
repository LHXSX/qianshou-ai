/** Account UI uses shared Shanghai writes and guarded read projections; secrets live only in active forms. */
import { isAccountFailure, type Account, type AccountClient, type PromotionReader, type WeChatLoginAdapter } from '@deepseek-ai/dsh-client-account'
import { accountCopy as t } from './account-copy.ts'
import { authLegal } from './auth-legal.ts'
import type { AccountReader } from './account-profile.ts'
import type { CommerceReader } from './account-commerce.ts'
import { renderAccountQuota, renderSubscriptionPage, renderRechargePage, renderOrdersPage } from './account-commerce-pages.ts'
import { interactionPreference, setInteractionPreference } from '../interaction-feedback.ts'
import { createUpdateSettings } from '../app-updates.ts'
import { availableMessageSpeechVoices, messageSpeechPreferences, setMessageSpeechPreferences } from '../message-speech.ts'
import './account-pages.css'

/** Account dialog's verified identity and rendering callbacks. */
export interface AccountDialogOptions {
  readonly client: AccountClient
  readonly reader: AccountReader
  readonly dialog: HTMLElement
  /** Application host switches conversation visibility while this page is open. */
  readonly onOpen?: () => void
  readonly onClose?: () => void
  readonly currentAccount: () => Account | null
  readonly onAuthenticated: (account: Account) => void
  readonly onSignedOut: () => void
  readonly onConnections?: () => void
  /** Current connection facts supplied by the application; no guessed online states. */
  readonly connections?: () => readonly { readonly label: string; readonly value: string }[]
  readonly onNotice: (text: string) => void
  /** When true, the initial account gate cannot be dismissed to reveal the shell. */
  readonly requireAuthentication?: () => boolean
  /** Optional authenticated Guangzhou quota projection; absent means read-only unavailable. */
  readonly commerce?: CommerceReader
  /** Optional public WeChat OAuth hand-off. The server exchange remains outside this browser. */
  readonly wechat?: WeChatLoginAdapter
  /** Optional server-owned referral projection; absent stays visibly pending. */
  readonly promotion?: PromotionReader
}
/** Full application pages; profile remains the historical account-home entry. */
export type AccountPage = 'home' | 'profile' | 'security' | 'sessions' | 'commerce' | 'recharge' | 'orders' | 'promotion' | 'settings' | 'connections'
/** Login/settings lifecycle; sync invalidates private views when the embedding identity changes. */
export interface AccountDialog {
  readonly open: (tab?: AccountPage) => void
  readonly sync: () => void
  readonly dispose: () => void
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result
}
const button = (label: string, action: () => void, className = 'text-button'): HTMLButtonElement => {
  const result = node('button', className, label); result.type = 'button'; result.addEventListener('click', action); return result
}
function failureText(error: unknown): string {
  if (error instanceof Error && (error.message === t.phoneInvalid || error.message === t.phoneCodeInvalid)) return error.message
  if (error instanceof Error && error.message === 'REGISTER_IDENTITY_REQUIRED') return t.noIdentity
  if (error instanceof Error && error.message === 'REGISTER_PASSWORD_MISMATCH') return t.passwordMismatch
  if (!isAccountFailure(error)) return t.failed
  if (error.operation === 'login-phone' || error.operation === 'register-phone') return error.message
  if (error.status === 403) return t.forbidden
  if (error.kind === 'unauthorized') return t.expired
  if (error.kind === 'invalid-credentials') return t.loginFailed
  if (error.kind === 'invalid-request') return t.invalid
  if (error.kind === 'rate-limited') return t.limited
  return t.failed
}
function field(form: HTMLElement, name: string, type = 'text', autocomplete = 'off', required = true): HTMLInputElement {
  const label = node('label', '', name); const input = node('input')
  input.type = type; input.autocomplete = autocomplete as AutoFill; input.ariaLabel = name; input.required = required
  if (type === 'password') {
    const row = node('div', 'password-row')
    const toggle = button(t.showPassword, () => {
      const visible = input.type === 'password'; input.type = visible ? 'text' : 'password'
      toggle.textContent = visible ? t.hidePassword : t.showPassword; toggle.setAttribute('aria-pressed', String(visible))
    }, 'password-toggle')
    input.dataset.secret = 'true'; toggle.setAttribute('aria-pressed', 'false')
    row.append(input, toggle); label.append(row)
  } else {
    label.append(input)
  }
  form.append(label)
  return input
}
function codeField(form: HTMLElement): HTMLInputElement {
  const input = field(form, t.totp, 'text', 'one-time-code')
  input.pattern = '[0-9]{6}'
  input.inputMode = 'numeric'
  input.maxLength = 6
  return input
}
/**
 * @param options - Shared account client and verified application identity; no credentials are persisted.
 * @returns Mounted-dialog controller with explicit identity invalidation and teardown.
 */
export function createAccountDialog(options: AccountDialogOptions): AccountDialog {
  const { client, dialog } = options
  let identity = options.currentAccount()?.id ?? null
  let disposed = false
  let generation = 0
  let busy = false
  let challenge: string | null = null
  let pendingNotice: string | null = null
  let reading = new AbortController()
  let tab: AccountPage = 'home'
  let opened = false
  const purchaseIntent: { tier: string | null } = { tier: null }
  dialog.classList.add('account-pages')
  const hide = (): void => {
    if (dialog instanceof HTMLDialogElement) dialog.close()
    else dialog.hidden = true
    if (opened) { opened = false; options.onClose?.() }
  }
  const invalidate = (): void => { generation++; reading.abort(); reading = new AbortController() }
  const close = (force = false): void => {
    if (busy || (!force && options.requireAuthentication?.() === true)) return
    invalidate(); challenge = null; hide(); dialog.replaceChildren()
  }
  const onCancel = (event: Event): void => { event.preventDefault(); close() }
  dialog.addEventListener('cancel', onCancel)
  const resetDialog = (kind: 'login' | 'center'): HTMLElement => {
    invalidate(); dialog.replaceChildren()
    dialog.classList.toggle('account-dialog-login', kind === 'login')
    dialog.classList.toggle('account-dialog-center', kind === 'center')
    if (dialog instanceof HTMLDialogElement) { if (!dialog.open) dialog.showModal() }
    else { dialog.hidden = false; dialog.setAttribute('role', 'region') }
    if (!opened) { opened = true; options.onOpen?.() }
    return dialog
  }
  const header = (title: string, onBack?: () => void): HTMLElement => {
    const panel = resetDialog('center')
    panel.dataset.accountPage = tab
    const bar = node('header', 'account-page-header')
    const back = button('', onBack ?? close, 'account-back')
    back.ariaLabel = t.back
    back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    const heading = node('h2', '', title); heading.id = 'account-page-title'
    panel.setAttribute('aria-labelledby', heading.id)
    bar.append(back, heading, node('span', 'account-header-spacer'))
    panel.append(bar)
    const body = node('div', 'account-page-body'); panel.append(body)
    return body
  }
  const run = (form: HTMLFormElement, label: string, action: () => Promise<void>, errorPrefix = '', hideSubmit = false): void => {
    const error = node('p', 'form-error'); error.setAttribute('role', 'alert')
    const submit = node('button', hideSubmit ? 'primary-button auth-submit-hidden' : 'primary-button', label)
    submit.type = 'submit'
    if (hideSubmit) { submit.hidden = true; submit.tabIndex = -1 }
    form.append(error, submit)
    const setBusy = (next: boolean): void => {
      busy = next
      submit.disabled = next
      for (const control of dialog.querySelectorAll<HTMLButtonElement>('.auth-method-active')) control.disabled = next
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (busy || disposed || !form.checkValidity()) return
      const ticket = generation; setBusy(true); error.textContent = ''
      void action().catch((caught: unknown) => {
        if (ticket === generation && !disposed) error.textContent = errorPrefix + failureText(caught)
      }).finally(() => {
        setBusy(false)
        for (const secret of form.querySelectorAll<HTMLInputElement>('input[data-secret],input[autocomplete="one-time-code"]')) secret.value = ''
      })
    })
  }
  const signOut = async (notice: string): Promise<void> => {
    identity = null
    busy = false
    invalidate(); challenge = null; hide(); dialog.replaceChildren()
    options.onSignedOut(); options.onNotice(notice)
    try { await client.logout() }
    finally { if (options.currentAccount() === null) await client.tokens.clear() }
  }
  const securityChanged = async (ticket: number, owner: Account['id']): Promise<void> => {
    const current = (): boolean => !disposed && ticket === generation && options.currentAccount()?.id === owner
    if (!current()) return
    // The server has revoked every session, including this one. Clear the local pair
    // before logout so no obsolete refresh credential is sent as a new login attempt.
    await client.tokens.clear()
    if (!current()) return
    await signOut(t.reauthenticate)
  }
  const initials = (value: string): string => {
    const trimmed = value.trim()
    if (!trimmed) return '千'
    const chars = Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(trimmed), item => item.segment)
    return chars.length > 1 ? `${chars[0]}${chars[chars.length - 1]}` : chars[0] ?? '千'
  }
  /** User card is identity only. Quota and payment facts come from the commerce reader below. */
  const overview = (panel: HTMLElement, account: Account): void => {
    const hero = node('section', 'account-overview account-hero')
    hero.dataset.testid = 'account-overview'
    hero.setAttribute('aria-labelledby', 'account-overview-title')
    const identity = node('div', 'account-overview-identity')
    const avatar = node('div', 'account-avatar account-avatar-gradient', initials(account.username)); avatar.setAttribute('aria-hidden', 'true')
    const copy = node('div', 'account-overview-copy')
    copy.append(node('span', 'account-status-chip', `● ${t.verifiedAccount}`))
    const heading = node('h3', '', account.username); heading.id = 'account-overview-title'; copy.append(heading)
    const email = node('p', '', account.email || t.unset); copy.append(email)
    identity.append(avatar, copy)
    const accountId = node('small', 'account-overview-id', `${t.accountIdLabel} · ${account.id}`)
    identity.append(accountId)
    hero.append(identity, node('p', 'account-overview-hint', t.accountOverviewHint))
    panel.append(hero)
  }
  const login = (): void => {
    const panel = resetDialog('login')
    const authHero = node('section', 'auth-hero')
    const authMark = node('div', 'auth-mark'); authMark.setAttribute('aria-hidden', 'true')
    for (const tone of ['violet', 'gold', 'pink']) authMark.append(node('i', `brand-bar brand-bar-${tone}`))
    const authCopy = node('div', 'auth-hero-copy')
    authCopy.append(node('strong', '', t.authBrand), node('span', '', t.authTagline))
    authHero.append(authMark, authCopy)
    const intro = node('div', 'auth-intro')
    intro.append(node('h1', 'auth-manifesto', t.authManifesto), node('p', '', t.authWelcome))
    panel.append(authHero, intro)
    if (challenge) panel.append(node('p', 'muted auth-hint', t.totpHint))
    const form = node('form', 'login-form')
    const username = challenge ? null : field(form, t.username, 'text', 'username')
    const password = challenge ? null : field(form, t.password, 'password', 'current-password')
    const code = challenge ? codeField(form) : null
    run(form, challenge ? t.verify : t.login, async () => {
      const ticket = generation
      if (challenge && code) {
        await client.loginTotp({ challenge_token: challenge, code: code.value, trust_device: false, remember_me: false })
        challenge = null }
      else if (username && password) {
        const result = await client.login({ username: username.value.trim(), password: password.value, remember_me: false })
        password.value = ''
        if (disposed || ticket !== generation) { await client.tokens.clear(); return }
        if (result.kind === 'two-factor') { challenge = result.challenge.challenge_token; login(); return }
      }
      const verified = await client.me()
      if (disposed || ticket !== generation) { await client.tokens.clear(); return }
      if (!verified) { await client.logout(); throw new Error('ACCOUNT_NOT_VERIFIED') }
      options.onAuthenticated(verified); identity = verified.id; invalidate(); hide(); dialog.replaceChildren()
    }, t.loginFailed + ' ', !challenge)
    panel.append(form)
    if (!challenge) {
      const methods = node('div', 'auth-methods')
      methods.dataset.testid = 'auth-methods'
      const notice = node('p', 'auth-method-notice')
      notice.setAttribute('role', 'status')
      const showPending = (): void => { notice.textContent = t.methodPending }
      const accountMethod = button(t.accountLogin, () => {
        notice.textContent = ''
        form.requestSubmit()
      }, 'auth-method auth-method-active')
      const phoneMethod = button(t.phoneLogin, () => { if (!busy) showPhoneAuth('login') }, 'auth-method auth-method-phone')
      const wechatMethod = button(t.wechatLogin, () => {
        if (busy) { showPending(); return }
        if (options.wechat === undefined) { notice.textContent = t.wechatUnconfigured; return }
        const started = options.wechat.begin()
        if (started.kind === 'started') {
          notice.textContent = t.wechatRedirecting
          window.location.assign(started.url)
        } else notice.textContent = t.wechatUnconfigured
      }, 'auth-method auth-method-wechat')
      if (options.wechat?.status() === 'unconfigured' || options.wechat === undefined) {
        wechatMethod.setAttribute('aria-disabled', 'true')
      }
      const registerMethod = button(t.register, () => { if (!busy) showRegister(panel, form, methods, notice) }, 'auth-method auth-method-register')
      methods.append(accountMethod, phoneMethod, wechatMethod, registerMethod)
      panel.append(methods, notice)
      if (pendingNotice !== null) { notice.textContent = pendingNotice; pendingNotice = null }
      const legal = node('p', 'auth-legal')
      legal.append(
        document.createTextNode(t.legalLead),
        button(`《${t.termsLink}》`, () => { showLegal('terms') }, 'auth-legal-link'),
        document.createTextNode(t.legalAnd),
        button(`《${t.privacyLink}》`, () => { showLegal('privacy') }, 'auth-legal-link'),
        document.createTextNode('。'),
        node('span', 'auth-session', t.sessionOnly),
      )
      panel.append(legal)
    }
  }
  const showPhoneAuth = (mode: 'login' | 'register'): void => {
    const panel = resetDialog('login')
    const ticket = generation
    const life = reading.signal
    const title = node('h1', 'auth-title', mode === 'login' ? t.phoneAuthTitle : t.phoneRegisterTitle)
    const hint = node('p', 'muted auth-hint', t.phoneAuthHint)
    panel.append(title, hint)
    const form = node('form', 'login-form phone-auth-form')
    const phone = field(form, t.phoneNumber, 'tel', 'tel')
    phone.inputMode = 'tel'; phone.maxLength = 24
    const username = mode === 'register' ? field(form, t.phoneUsername, 'text', 'username', false) : null
    if (username) username.maxLength = 64
    const code = field(form, t.phoneCode, 'text', 'one-time-code')
    code.inputMode = 'numeric'; code.maxLength = 6
    const send = button(t.phoneCodeSend, () => { void sendCode() }, 'account-secondary phone-code-send')
    const status = node('p', 'auth-method-notice'); status.setAttribute('role', 'status')
    form.insertBefore(send, code.parentElement)
    form.append(status)
    const normalizedPhone = (): string => phone.value.replace(/[\s()\-]/gu, '').trim()
    const validPhone = (): string | null => {
      const value = normalizedPhone()
      return /^(?:\+86)?1[3-9]\d{9}$/u.test(value) ? value : null
    }
    let sending = false
    let resendTimer: ReturnType<typeof setTimeout> | undefined
    life.addEventListener('abort', () => { clearTimeout(resendTimer) }, { once: true })
    const sendCode = async (): Promise<void> => {
      if (sending || busy || send.disabled || disposed || life.aborted) return
      const value = validPhone()
      if (value === null) { status.textContent = t.phoneInvalid; return }
      sending = true; send.disabled = true; send.textContent = t.phoneCodeSending; status.textContent = ''
      try {
        const result = await client.sendSms({ phone: value, purpose: mode })
        if (disposed || life.aborted || ticket !== generation) return
        status.textContent = `${t.phoneCodeSent} ${result.phone}。${t.phoneCodeExpired}`
        send.textContent = t.phoneCodeWait
        resendTimer = setTimeout(() => {
          if (disposed || life.aborted || ticket !== generation) return
          send.disabled = false; send.textContent = t.phoneCodeSend
        }, result.resendAfter * 1000)
      } catch (error) {
        if (disposed || life.aborted || ticket !== generation) return
        status.textContent = isAccountFailure(error) ? error.message : t.failed
        send.disabled = false; send.textContent = t.phoneCodeSend
      } finally { sending = false }
    }
    run(form, mode === 'login' ? t.phoneLoginSubmit : t.phoneRegisterSubmit, async () => {
      const value = validPhone()
      if (value === null) throw new Error(t.phoneInvalid)
      if (!/^\d{6}$/u.test(code.value)) throw new Error(t.phoneCodeInvalid)
      if (mode === 'login') {
        const result = await client.loginPhone({ phone: value, code: code.value, remember_me: false })
        if (disposed || life.aborted || ticket !== generation) { if (result.kind === 'tokens') await client.logout(); return }
        if (result.kind === 'two-factor') { challenge = result.challenge.challenge_token; login(); return }
      }
      else await client.registerPhone({ phone: value, code: code.value,
        ...(username?.value.trim() ? { username: username.value.trim() } : {}), remember_me: false })
      if (disposed || life.aborted || ticket !== generation) { await client.logout(); return }
      let verified: Account | null
      try {
        verified = await client.me()
        if (!verified) throw new Error('ACCOUNT_NOT_VERIFIED')
      } catch (error) { await client.logout(); throw error }
      if (disposed || life.aborted || ticket !== generation) { await client.logout(); return }
      options.onAuthenticated(verified); identity = verified.id; invalidate(); hide(); dialog.replaceChildren()
    }, '')
    panel.append(form)
    const switchMode = button(mode === 'login' ? t.phoneRegisterSwitch : t.phoneLoginSwitch,
      () => { if (!busy && !sending) showPhoneAuth(mode === 'login' ? 'register' : 'login') }, 'text-button register-back')
    const back = button(t.backToLogin, () => { if (!busy && !sending) login() }, 'text-button register-back')
    panel.append(switchMode, back)
  }
  const showLegal = (kind: 'terms' | 'privacy'): void => {
    const sheet = node('section', 'auth-legal-sheet')
    sheet.dataset.testid = `auth-legal-${kind}`
    const heading = node('div', 'auth-legal-sheet-bar')
    const back = button(t.back, () => { sheet.remove() }, 'text-button')
    heading.append(node('h2', '', kind === 'terms' ? authLegal.termsTitle : authLegal.privacyTitle), back)
    const body = node('div', 'auth-legal-sheet-body')
    for (const paragraph of kind === 'terms' ? authLegal.terms : authLegal.privacy) body.append(node('p', '', paragraph))
    sheet.append(heading, body)
    dialog.append(sheet)
  }
  const showRegister = (panel: HTMLElement, loginForm: HTMLElement, methods: HTMLElement, notice: HTMLElement): void => {
    loginForm.remove(); methods.remove(); notice.textContent = ''
    let title = panel.querySelector('.auth-title')
    if (title === null) {
      title = node('h1', 'auth-title', t.registerTitle)
      panel.querySelector('.auth-hero')?.after(title)
    } else {
      title.textContent = t.registerTitle
    }
    let hint = panel.querySelector('.auth-hint')
    if (hint === null) {
      hint = node('p', 'muted auth-hint', t.registerHint)
      title.after(hint)
    } else {
      hint.textContent = t.registerHint
    }
    const form = node('form', 'login-form register-form')
    const username = field(form, t.registerUsername, 'text', 'username', false)
    const email = field(form, t.registerEmail, 'email', 'email', false)
    const password = field(form, t.registerPassword, 'password', 'new-password')
    const confirm = field(form, t.registerConfirm, 'password', 'new-password')
    const company = field(form, t.registerCompany, 'text', 'organization', false)
    const validate = (): void => { confirm.setCustomValidity(confirm.value === password.value ? '' : t.passwordMismatch) }
    confirm.addEventListener('input', validate); password.addEventListener('input', validate)
    run(form, t.registerSubmit, async () => {
      validate()
      if (!username.value.trim() && !email.value.trim()) throw new Error('REGISTER_IDENTITY_REQUIRED')
      if (confirm.value !== password.value) throw new Error('REGISTER_PASSWORD_MISMATCH')
      const input = {
        password: password.value,
        ...(username.value.trim() ? { username: username.value.trim() } : {}),
        ...(email.value.trim() ? { email: email.value.trim() } : {}),
        ...(company.value.trim() ? { company: company.value.trim() } : {}),
        remember_me: false,
      }
      await client.register(input)
      pendingNotice = t.registerSuccess
      login()
    }, t.loginFailed + ' ')
    const back = button(t.backToLogin, () => { if (!busy) login() }, 'text-button register-back')
    hint.after(form)
    form.after(back)
  }
  const profile = (content: HTMLElement, notice = ''): void => {
    if (notice) { const receipt = node('p', 'form-success', notice); receipt.setAttribute('role', 'status'); content.append(receipt) }
    const account = options.currentAccount(); if (!account) return
    const foldout = node('section', 'account-profile-form')
    foldout.dataset.testid = 'account-profile-form'
    const summary = node('div', 'account-profile-summary')
    summary.append(node('strong', '', t.profile), node('small', 'muted', t.profileHint))
    foldout.append(summary)
    const fields = node('div', 'account-profile-fields')
    for (const [label, value] of [
      [t.accountName, account.username], [t.email, account.email || t.unset], [t.accountId, String(account.id)],
    ]) {
      const row = node('div', 'setting-row'); row.append(node('span', '', label), node('strong', '', value)); fields.append(row)
    }
    const status = node('p', 'muted', t.loading); status.setAttribute('role', 'status'); fields.append(status)
    foldout.append(fields); content.append(foldout)
    const ticket = generation
    void options.reader.profile(reading.signal).then((data) => {
      if (ticket !== generation || disposed) return
      status.remove()
      const form = node('form', 'profile-form')
      const display = field(form, t.displayName); display.value = data.display_name ?? ''; display.maxLength = 64
      const phone = field(form, t.phone, 'tel')
      phone.value = data.phone ?? ''
      phone.required = false
      phone.pattern = '\\+?[0-9\\-\\s]{6,20}'
      phone.maxLength = 32
      const country = field(form, t.country); country.value = data.country ?? ''; country.maxLength = 64
      // Absent optional profile fields stay empty; saving only submits changed values.
      display.required = false; country.required = false
      const languageLabel = node('label', '', t.language); const language = node('select'); language.ariaLabel = t.language
      for (const value of ['', '简体中文', '繁體中文', 'English']) { const option = node('option', '', value || t.unset)
        option.value = value
        language.append(option) }
      language.value = data.language ?? ''; languageLabel.append(language); form.append(languageLabel)
      run(form, t.save, async () => {
        const patch: Record<string, string> = {}
        for (const [key, value, before] of [['display_name', display.value.trim(), data.display_name], ['phone', phone.value.trim(), data.phone], ['country', country.value.trim(), data.country], ['language', language.value, data.language]] as const) {
          if (value !== (before ?? '')) { if (!value && key !== 'phone') throw new Error('PROFILE_EMPTY_VALUE'); patch[key] = value }
        }
        if (Object.keys(patch).length) await client.setProfile(patch)
        if (ticket !== generation || disposed) return
        content.replaceChildren(); profile(content, t.saved); options.onNotice(t.saved)
      })
      fields.append(form)
    }).catch((error: unknown) => { if (ticket === generation && !disposed) { status.textContent = failureText(error)
      fields.append(button(t.retry, render)) } })
  }
  const passwordForm = (content: HTMLElement): void => {
    const ticket = generation; const owner = options.currentAccount()?.id
    content.append(node('h3', '', t.passwordTitle), node('p', 'muted', t.passwordHint))
    const form = node('form', 'profile-form')
    const old = field(form, t.oldPassword, 'password', 'current-password')
    const password = field(form, t.newPassword, 'password', 'new-password'); password.minLength = 6; password.maxLength = 64
    const confirm = field(form, t.confirmPassword, 'password', 'new-password'); confirm.minLength = 6; confirm.maxLength = 64
    const validate = (): void => { confirm.setCustomValidity(confirm.value === password.value ? '' : t.passwordMismatch) }
    confirm.addEventListener('input', validate); password.addEventListener('input', validate)
    run(form, t.changePassword, async () => { await client.changePassword({ password: password.value, old_password: old.value })
      if (owner !== undefined) await securityChanged(ticket, owner) })
    content.append(form)
  }
  const security = (content: HTMLElement): void => {
    const owner = options.currentAccount()?.id
    const status = node('p', 'muted', t.loading); content.append(node('h3', '', t.totpTitle), status)
    const ticket = generation
    void client.totpStatus().then((value) => {
      if (ticket !== generation || disposed) return
      if (value === null) throw new Error('TOTP_STATUS_MISSING')
      status.textContent = value.enabled ? t.enabled : t.disabled
      content.append(node('p', 'muted', t.securityHint))
      const form = node('form', 'security-list')
      const password = field(form, t.oldPassword, 'password', 'current-password')
      if (value.enabled) {
        const code = codeField(form)
        run(form, t.confirmDisable, async () => { await client.totpDisable({ current_password: password.value, code: code.value })
          if (owner !== undefined) await securityChanged(ticket, owner) })
      } else {
        run(form, t.totpSetup, async () => {
          const raw = await client.totpSetup(password.value)
          if (ticket !== generation || disposed) return
          if (raw === null || typeof raw !== 'object' || !('secret' in raw) || typeof raw.secret !== 'string' || !('setup_token' in raw) || typeof raw.setup_token !== 'string') throw new Error('TOTP_SETUP_INVALID')
          const secret = raw.secret; const setupToken = raw.setup_token
          content.replaceChildren(node('p', 'muted', t.totpHintSetup), node('strong', '', t.secret), node('code', 'totp-secret', secret))
          const verify = node('form', 'security-list'); const code = codeField(verify)
          run(verify, t.confirmTotp, async () => { await client.totpConfirm(setupToken, code.value)
            if (owner !== undefined) await securityChanged(ticket, owner) })
          content.append(verify)
        })
      }
      content.append(form); passwordForm(content)
    }).catch((error: unknown) => { if (ticket === generation && !disposed) { status.textContent = failureText(error)
      content.append(button(t.retry, render))
      passwordForm(content) } })
  }
  const sessions = (content: HTMLElement): void => {
    content.append(node('p', 'muted', t.sessionsHint))
    const status = node('p', 'muted', t.loading); content.append(status)
    const ticket = generation
    const confirm = (parent: HTMLElement, label: string, action: () => Promise<void>): void => {
      if (busy) return
      const form = node('form', 'security-list'); form.append(button(t.cancel, () => { if (!busy) form.remove() }))
      run(form, label, async () => { await action(); if (ticket === generation && !disposed) render() }); parent.append(form)
    }
    void options.reader.sessions(reading.signal).then((rows) => {
      if (ticket !== generation || disposed) return
      status.textContent = rows.length ? '' : t.noSessions
      for (const row of rows) {
        const item = node('div', 'session-row')
        item.append(node('strong', '', row.device ?? t.unknownDevice), node('span', '', row.current ? t.current : row.status === 'active' ? t.active : row.status === 'revoked' ? t.revoked : row.status === 'expired' ? t.expiredSession : t.unknownStatus))
        if (row.ip) item.append(node('small', '', row.ip))
        if (row.lastSeen) { const at = new Date(row.lastSeen)
          if (Number.isFinite(at.getTime())) item.append(node('small', '', `${t.lastSeen} ${at.toLocaleString('zh-CN')}`)) }
        if (!row.current && row.status === 'active') item.append(button(t.revoke, () => { confirm(item, t.confirmRevoke, () => client.revokeSession(row.id)) }))
        content.append(item)
      }
      if (rows.some(row => !row.current && row.status === 'active')) content.append(button(t.revokeOthers, () => { confirm(content, t.confirmOthers, () => client.revokeOtherSessions()) }))
    }).catch((error: unknown) => { if (ticket === generation && !disposed) { status.textContent = failureText(error)
      content.append(button(t.retry, render)) } })
  }
  const promotion = (content: HTMLElement): void => {
    content.classList.add('promotion-module')
    const intro = node('section', 'promotion-hero')
    intro.dataset.testid = 'account-promotion'
    intro.append(node('h3', 'account-module-title', t.promotionTitle), node('p', 'muted', t.promotionHint))
    content.append(intro)
    const pending = node('div', 'account-notice commerce-pending-notice')
    const pendingTitle = node('strong', '', t.promotionPending); const pendingHint = node('span', '', t.promotionPendingHint)
    pending.append(pendingTitle, pendingHint); content.append(pending)
    let inviteUrl: string | null = null
    const copy = button(t.copyInvite, async () => {
      if (!inviteUrl || !navigator.clipboard?.writeText) { options.onNotice(t.promotionUnavailable); return }
      try { await navigator.clipboard.writeText(inviteUrl); options.onNotice(t.copyInvite) } catch { options.onNotice(t.promotionUnavailable) }
    }, 'secondary-button')
    copy.disabled = true; copy.setAttribute('aria-describedby', 'promotion-pending-hint')
    const hint = node('small', 'muted', t.promotionUnavailable); hint.id = 'promotion-pending-hint'; content.append(copy, hint)
    const reader = options.promotion
    if (reader === undefined) return
    pendingTitle.textContent = t.loading; pendingHint.textContent = t.promotionHint
    hint.textContent = t.loading
    const ticket = generation
    void reader.summary(reading.signal).then((snapshot) => {
      if (disposed || ticket !== generation) return
      if (snapshot.status !== 'ready') {
        pendingTitle.textContent = t.promotionPending; pendingHint.textContent = snapshot.message ?? t.promotionPendingHint
        hint.textContent = t.promotionUnavailable
        return
      }
      pending.remove()
      const stats = node('div', 'promotion-stat-grid'); stats.dataset.testid = 'promotion-stats'
      for (const [label, value] of [[t.promotionInvite, snapshot.inviteUrl ?? t.promotionInviteValue], [t.promotionInvited, snapshot.invitedCount === null ? t.promotionInvitedValue : String(snapshot.invitedCount)], [t.promotionReward, snapshot.pendingPoints === null ? t.promotionRewardValue : String(snapshot.pendingPoints)]] as const) {
        const stat = node('div', 'promotion-stat'); stat.append(node('span', '', label), node('strong', '', value)); stats.append(stat)
      }
      content.insertBefore(stats, copy)
      inviteUrl = snapshot.inviteUrl
      copy.disabled = inviteUrl === null
      hint.textContent = snapshot.inviteUrl === null ? t.promotionUnavailable : t.promotionHint
    }).catch(() => {
      if (disposed || ticket !== generation) return
      pendingTitle.textContent = t.promotionPending; pendingHint.textContent = t.promotionPendingHint; hint.textContent = t.promotionUnavailable
    })
  }
  const navigate = (next: AccountPage): void => { if (!busy) { tab = next; render() } }
  const menuRow = (label: string, actionName: string, action: () => void): HTMLButtonElement => {
    const row = button('', action, 'account-menu-row')
    row.dataset.accountAction = actionName
    row.append(node('span', '', label))
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    arrow.setAttribute('viewBox', '0 0 24 24'); arrow.setAttribute('fill', 'none'); arrow.setAttribute('aria-hidden', 'true')
    arrow.innerHTML = '<path d="m9 5 7 7-7 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
    row.append(arrow)
    return row
  }
  const paintSettingsMenu = (panel: HTMLElement): void => {
    panel.append(node('p', 'account-page-intro', t.settingsHint))
    const menu = node('nav', 'account-menu')
    menu.dataset.testid = 'account-settings'; menu.setAttribute('aria-label', t.settings)
    for (const [key, label] of [['profile', t.profile], ['security', t.security], ['sessions', t.sessions], ['promotion', t.promotion]] as const) {
      menu.append(menuRow(label, key, () =>{  navigate(key) }))
    }
    menu.append(menuRow(t.connections, 'connections', () =>{  navigate('connections') }))
    const preferences = node('section', 'account-preferences')
    preferences.append(node('h3', 'account-section-title', t.interactionSettings))
    for (const [name, label, hint] of [
      ['sound', t.soundEffects, t.soundEffectsHint], ['voiceAutoSend', t.voiceAutoSend, t.voiceAutoSendHint],
    ] as const) {
      const row = node('label', 'account-preference')
      const text = node('span'); text.append(node('strong', '', label), node('small', '', hint))
      const control = node('input'); control.type = 'checkbox'; control.setAttribute('role', 'switch')
      control.ariaLabel = label; control.checked = interactionPreference(name)
      control.addEventListener('change', () => { setInteractionPreference(name, control.checked) })
      row.append(text, control); preferences.append(row)
    }
    const speechRow = node('label', 'account-preference account-speech-preference')
    const speechText = node('span'); speechText.append(node('strong', '', t.messageSpeechVoice), node('small', '', t.messageSpeechVoiceHint))
    const speechSelect = node('select')
    speechSelect.ariaLabel = t.messageSpeechVoice
    const systemOption = node('option', '', t.messageSpeechVoiceSystem); systemOption.value = ''; speechSelect.append(systemOption)
    const preferencesValue = messageSpeechPreferences()
    speechSelect.value = preferencesValue.voiceURI ?? ''
    const refreshSpeechVoices = (): void => {
      const selected = speechSelect.value
      for (const option of [...speechSelect.options].slice(1)) option.remove()
      const voices = availableMessageSpeechVoices()
      for (const voice of voices) {
        const option = node('option', '', `${voice.name} · ${voice.lang}${voice.localService ? ' · 本机' : ''}`)
        option.value = voice.voiceURI
        speechSelect.append(option)
      }
      speechSelect.value = voices.some(voice => voice.voiceURI === selected) ? selected : ''
      speechSelect.disabled = voices.length === 0
      speechSelect.title = voices.length ? t.messageSpeechVoiceHint : t.messageSpeechVoiceUnavailable
    }
    refreshSpeechVoices()
    speechSelect.addEventListener('change', () => { setMessageSpeechPreferences({ voiceURI: speechSelect.value || null }) })
    const synthesis = typeof window === 'undefined' ? undefined : window.speechSynthesis
    const onVoicesChanged = (): void => { refreshSpeechVoices() }
    synthesis?.addEventListener?.('voiceschanged', onVoicesChanged)
    reading.signal.addEventListener('abort', () => { synthesis?.removeEventListener?.('voiceschanged', onVoicesChanged) }, { once: true })
    speechRow.append(speechText, speechSelect); preferences.append(speechRow)
    panel.append(menu, preferences, createUpdateSettings(reading.signal), node('p', 'account-version', t.versionLabel))
  }
  const render = (): void => {
    if (disposed) return
    const account = options.currentAccount()
    if (!account) { login(); return }
    if (tab === 'connections') {
      const content = header(t.connections, () =>{  navigate('settings') })
      const rows = options.connections?.() ?? []
      if (!rows.length) content.append(node('p', 'account-page-intro', t.unknown))
      for (const row of rows) {
        const item = node('div', 'setting-row'); item.append(node('span', '', row.label), node('strong', '', row.value)); content.append(item)
      }
      return
    }
    if (tab === 'settings') {
      paintSettingsMenu(header(t.settings, () =>{  navigate('home') }))
      return
    }
    if (tab === 'security' || tab === 'sessions' || tab === 'promotion' || tab === 'profile') {
      const title = tab === 'security' ? t.security : tab === 'sessions' ? t.sessions : tab === 'promotion' ? t.promotion : t.profile
      const content = header(title, () =>{  navigate('settings') })
      content.classList.add('account-detail-page')
      if (tab === 'security') security(content)
      else if (tab === 'sessions') sessions(content)
      else if (tab === 'promotion') promotion(content)
      else profile(content)
      return
    }
    const title = tab === 'commerce' ? t.subscriptionCenter : tab === 'recharge' ? t.rechargeCenter : tab === 'orders' ? t.orders : t.title
    const panel = header(title, tab === 'home' ? undefined : () =>{  navigate(tab === 'orders' ? 'recharge' : 'home') })
    const ticket = generation
    const commerceOptions = { purchaseIntent, container: panel, ...(options.commerce ? { reader: options.commerce } : {}), signal: reading.signal,
      current: () => !disposed && ticket === generation, navigate }
    if (tab === 'commerce') { renderSubscriptionPage(commerceOptions); return }
    if (tab === 'recharge') { renderRechargePage(commerceOptions); return }
    if (tab === 'orders') { renderOrdersPage(commerceOptions); return }
    overview(panel, account)
    renderAccountQuota(commerceOptions)
    const menu = node('nav', 'account-menu'); menu.setAttribute('aria-label', t.accountSection)
    for (const [page, label] of [['profile', t.profile], ['sessions', t.sessions], ['settings', t.settings], ['promotion', t.promotion]] as const) {
      menu.append(menuRow(label, page, () =>{  navigate(page) }))
    }
    panel.append(menu)
    const bottomActions = node('div', 'account-bottom-actions')
    bottomActions.append(button(t.logout, () => {
      if (busy) return; busy = true
      void signOut(t.logoutHint).catch(() => { options.onNotice(t.logoutHint) }).finally(() => { busy = false })
    }, 'danger-button account-logout'))
    panel.append(bottomActions)
  }
  return {
    open: (nextTab = 'home') => {
      if (busy) return
      // Sidebar/avatar still pass 'profile'; that is the account home. Profile form is settings-only.
      tab = nextTab === 'profile' ? 'home' : nextTab
      render()
    },
    sync: () => { const next = options.currentAccount()?.id ?? null
      if (next !== identity) { identity = next; purchaseIntent.tier = null
        invalidate()
        challenge = null
        hide()
        dialog.replaceChildren() } },
    dispose: () => { disposed = true
      invalidate()
      challenge = null
      hide()
      dialog.replaceChildren()
      dialog.removeEventListener('cancel', onCancel) },
  }
}
