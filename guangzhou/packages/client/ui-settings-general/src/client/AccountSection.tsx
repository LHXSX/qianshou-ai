/**
 * The account section: the desktop workbench's sign-in entry.
 *
 * It renders the Host's own session state (never a locally inferred one) and
 * the six calls the Host exposes. Three behaviours are load-bearing:
 *
 * - **2FA is a separate step.** While the store reports the `totp` step the
 *   page shows the code form and no signed-in state; there is no path that
 *   reads a challenge as a completed sign-in.
 * - **Registration does not sign in.** The page says so in words the Host
 *   confirmed (it reports `signedIn: false`), and it asks the user to sign in
 *   with the account just created.
 * - **Secrets are write-only here.** The password and the code live in this
 *   component's state only until the call returns, are cleared in every
 *   branch, are rendered as `type="password"` / one-time-code inputs, and
 *   never reach a log, storage, or the URL.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, IconRefreshOutline16, IconUserOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountError, AccountMode, AccountSectionState } from './account-store.ts'
import css from './AccountSection.module.css'

/** Actions and observations the section reads, all owned by one controller. */
export interface AccountSectionInjected {
  hooks: {
    /** Account snapshot bound by the UI renderer as `useSnapshot`. */
    snapshot: HostObservable<AccountSectionState>
  }
  /** Re-read the Host's session state. */
  refresh: () => Promise<void>
  /** Re-read the upstream profile (the fresh-balance path). */
  verify: () => Promise<void>
  /** Password sign-in; may stop at the 2FA step. */
  login: (username: string, password: string) => Promise<void>
  /** Complete the 2FA step. */
  submitTotp: (code: string, trustDevice: boolean) => Promise<void>
  /** Leave the 2FA step without signing in. */
  backToCredentials: () => void
  /** Create an account; never signs it in. */
  register: (password: string, username: string, email: string) => Promise<void>
  /** Switch between the sign-in and register forms. */
  showForm: (mode: AccountMode) => void
  /** Sign out and clear the Host's local credentials. */
  logout: () => Promise<void>
}

/** Composed slot props: section owner share, `settings.account` copy, injected face. */
export type AccountSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.account'>
  & InjectFace<AccountSectionInjected>

/** The shortest code the upstream TOTP flow accepts. */
const CODE_LENGTH = 6

/** Localize one failure: the Host's own sentence, or this page's own copy. */
function errorText(error: AccountError, t: AccountSectionProps['t']): string {
  if (error.kind === 'host') return error.message
  return t(error.kind === 'unreachable' ? 'error.unreachable' : error.kind === 'invalid' ? 'error.invalid' : 'error.rejected')
}

/** Balance to display: the reported value verbatim, or an explicit unknown. */
function balanceText(account: AccountSectionState['account'], unknown: string): string {
  const balance = account?.balance ?? null
  return balance === null || balance === '' ? unknown : String(balance)
}

/**
 * Render the account page.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the account section element tree.
 */
export function AccountSection(props: AccountSectionProps) {
  const { t } = props
  const state = props.useSnapshot(snapshot => snapshot)
  const [identifier, setIdentifier] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [trust, setTrust] = useState(true)
  // The controller refuses overlapping calls; this ref only keeps a double
  // click from queueing a second attempt before `busy` has been published.
  const submitting = useRef(false)

  useEffect(() => { void props.refresh() }, [props.refresh])

  const account = state.account
  const mode = state.mode
  const totp = state.step === 'totp'
  const signedIn = !totp && state.session === 'authenticated'
  const statusKey = totp ? 'totp.title'
    : signedIn ? 'status.signedIn'
      : state.session === 'expired' ? 'status.expired'
        : state.session === 'signed-out' ? 'status.signedOut' : 'status.loading'
  const canSubmit = totp
    ? code.trim().length >= CODE_LENGTH
    : mode === 'register'
      ? password.length > 0
      : identifier.trim().length > 0 && password.length > 0

  /** Run one call; every secret leaves this component's state afterwards. */
  async function run(action: () => Promise<void>): Promise<void> {
    if (submitting.current || state.busy) return
    submitting.current = true
    try { await action() } finally {
      submitting.current = false
      setPassword('')
      setCode('')
    }
  }

  return <section className={css.section} aria-label={t('title')}>
    <div className={css.heading}>
      <IconUserOutline16 size={16} />
      <h2 className={css.title}>{t('title')}</h2>
    </div>
    <p className={css.lead}>{t('lead')}</p>

    <div className={css.status} role="status">
      <span className={css.statusLabel}>{t('status')}</span>
      <strong className={css.statusValue}>{t(statusKey)}</strong>
      {signedIn && account !== null && <span className={css.balance}>
        {t('balance')} <strong>{balanceText(account, t('balance.unknown'))}</strong>
      </span>}
    </div>
    {state.notice !== null && <p className={css.notice} role="status">{t(state.notice)}</p>}
    {state.error !== null && <p className={css.error} role="alert">{errorText(state.error, t)}</p>}

    {totp && <form className={css.form} onSubmit={(event) => { event.preventDefault(); void run(() => props.submitTotp(code, trust)) }}>
      <label className={css.field}><span>{t('totp.code')}</span>
        <Input
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          spellCheck={false}
          onChange={(event) => { setCode(event.target.value) }}
        />
      </label>
      <label className={css.check}>
        <input type="checkbox" checked={trust} onChange={(event) => { setTrust(event.target.checked) }} />
        <span>{t('totp.trust')}</span>
      </label>
      <div className={css.actions}>
        <Button type="submit" variant="primary" disabled={!canSubmit || state.busy}>
          {t(state.busy ? 'totp.busy' : 'totp.submit')}
        </Button>
        <Button type="button" onClick={() => { props.backToCredentials() }}>{t('totp.back')}</Button>
      </div>
    </form>}

    {!totp && !signedIn && <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      void run(() => mode === 'register'
        ? props.register(password, identifier.trim(), email.trim())
        : props.login(identifier.trim(), password))
    }}>
      <h3 className={css.formTitle}>{t(mode === 'register' ? 'register' : 'login')}</h3>
      <label className={css.field}><span>{t(mode === 'register' ? 'register.identifier' : 'login.identifier')}</span>
        <Input
          value={identifier}
          autoComplete="username"
          spellCheck={false}
          onChange={(event) => { setIdentifier(event.target.value) }}
        />
      </label>
      {mode === 'register' && <label className={css.field}><span>{t('register.email')}</span>
        <Input
          value={email}
          type="email"
          autoComplete="email"
          spellCheck={false}
          onChange={(event) => { setEmail(event.target.value) }}
        />
      </label>}
      <label className={css.field}><span>{t('password')}</span>
        <Input
          value={password}
          type="password"
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          onChange={(event) => { setPassword(event.target.value) }}
        />
      </label>
      <div className={css.actions}>
        <Button type="submit" variant="primary" disabled={!canSubmit || state.busy}>
          {t(mode === 'register' ? (state.busy ? 'register.busy' : 'register.submit') : state.busy ? 'login.busy' : 'login.submit')}
        </Button>
        <Button type="button" onClick={() => {
          props.showForm(mode === 'register' ? 'login' : 'register')
          setPassword('')
        }}>{t(mode === 'register' ? 'toLogin' : 'toRegister')}</Button>
      </div>
    </form>}

    {signedIn && (account === null
      ? <p className={css.hint}>{t('account.missing')}</p>
      : <dl className={css.facts}>
        <div><dt>{t('account')}</dt><dd>{account.username === '' ? t('balance.unknown') : account.username}</dd></div>
        {account.email !== '' && <div><dt>{t('email')}</dt><dd>{account.email}</dd></div>}
        {account.role !== '' && <div><dt>{t('role')}</dt><dd>{account.role}</dd></div>}
        <div><dt>{t('balance')}</dt><dd>{balanceText(account, t('balance.unknown'))}</dd></div>
        {account.last_login_at !== null && <div><dt>{t('lastLogin')}</dt>
          <dd><time dateTime={account.last_login_at}>{new Date(account.last_login_at).toLocaleString()}</time></dd>
        </div>}
      </dl>)}
    {!totp && !signedIn && state.session === 'signed-out' && <p className={css.hint}>{t('signedOutHint')}</p>}

    {signedIn && <div className={css.actions}>
      <Button type="button" icon={<IconRefreshOutline16 size={14} />} disabled={state.busy}
        onClick={() => { void run(() => props.verify()) }}>
        {t(state.busy ? 'refresh.busy' : 'refresh')}
      </Button>
      <Button type="button" disabled={state.busy} onClick={() => { void run(() => props.logout()) }}>
        {t(state.busy ? 'logout.busy' : 'logout')}
      </Button>
    </div>}
  </section>
}
