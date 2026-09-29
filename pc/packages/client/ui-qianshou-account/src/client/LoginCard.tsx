/** Signed-out login card. Credentials stay in this form until submit or cancel. */
import { useEffect, useId, useRef, useState } from 'react'
import type { AccountController } from './controller.ts'
import type { AccountKey } from './locales.ts'
import css from './AccountPanel.module.css'

type Method = 'account' | 'phone' | 'register'

/** Match the Host's accepted mainland number shape without changing what the user typed. */
function validPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value.replace(/[\s()-]/g, '').replace(/^\+?86/, ''))
}

/** Copy and Host actions the card is allowed to use. */
export interface LoginCardProps {
  controller: AccountController
  busy: boolean
  t: (key: AccountKey) => string
}

/**
 * Show only sign-in methods backed by the Host.
 * @param props - Host controller, busy flag, and locale copy.
 */
export function LoginCard({ controller, busy, t }: LoginCardProps) {
  const formId = useId()
  const [method, setMethod] = useState<Method>('account')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [localError, setLocalError] = useState<AccountKey | null>(null)
  const phoneValid = validPhone(phone)
  const codeValid = /^\d{6}$/.test(code)
  // A completed SMS request belongs only to the phone and purpose that started it.
  const sendAttempt = useRef(0)
  useEffect(() => () => { sendAttempt.current += 1 }, [])
  const choose = (next: Method): void => {
    sendAttempt.current += 1
    setMethod(next)
    setSent(false)
    setLocalError(null)
    if (next !== 'account') setPassword('')
    setCode('')
  }
  return <div className={css.card}>
    <div className={css.methods} role="tablist" aria-label={t('methodsLabel')} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const methods: Method[] = ['account', 'phone', 'register']
      const index = methods.indexOf(method)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? methods.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + methods.length) % methods.length
      choose(methods[next]!)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    }}>
      {(['account', 'phone', 'register'] as const).map(item => (
        <button key={item} type="button" role="tab" id={`${formId}-${item}-tab`}
          aria-controls={`${formId}-${item}-panel`} aria-selected={method === item} tabIndex={method === item ? 0 : -1}
          className={method === item ? css.methodOn : css.method}
          onClick={() => { choose(item) }}>{t(item === 'account' ? 'methodAccount' : item === 'phone' ? 'methodPhone' : 'methodRegister')}</button>
      ))}
    </div>
    {method === 'account' && <form className={`${css.form} ${css.authForm}`} role="tabpanel"
      id={`${formId}-account-panel`} aria-labelledby={`${formId}-account-tab`} onSubmit={(event) => {
      event.preventDefault()
      void controller.login(username, password)
      setPassword('')
    }}>
      <label>{t('username')}<input aria-label={t('username')} value={username} autoComplete="username" required disabled={busy}
        onChange={(event) => { setUsername(event.target.value) }} /></label>
      <label>{t('password')}<input aria-label={t('password')} type="password" value={password} autoComplete="current-password"
        required disabled={busy} onChange={(event) => { setPassword(event.target.value) }} /></label>
      <button type="submit" className={css.authSubmit} disabled={busy}>{busy ? t('busy') : t('login')}</button>
    </form>}
    {method !== 'account' && <form className={`${css.form} ${css.authForm}`} role="tabpanel"
      id={`${formId}-${method}-panel`} aria-labelledby={`${formId}-${method}-tab`} onSubmit={(event) => {
      event.preventDefault()
      sendAttempt.current += 1
      setSent(false)
      if (!phoneValid || !codeValid) {
        setLocalError(!phoneValid ? 'phoneNumberFormat' : 'phoneCodeFormat')
        return
      }
      setLocalError(null)
      void (method === 'register' ? controller.registerWithPhone(phone, code) : controller.loginWithPhone(phone, code))
    }}>
      <label>{t('phone')}<input aria-label={t('phone')} value={phone} inputMode="tel" autoComplete="tel" required disabled={busy}
        onChange={(event) => { sendAttempt.current += 1; setPhone(event.target.value); setSent(false); setLocalError(null) }} /></label>
      <div className={css.phoneCodeRow}>
        <label>{t('phoneCode')}<input aria-label={t('phoneCode')} value={code} inputMode="numeric" autoComplete="one-time-code"
          aria-describedby={`${formId}-${method}-code-hint`} maxLength={6} required disabled={busy}
          onChange={(event) => { setCode(event.target.value); setLocalError(null) }} /></label>
        <button type="button" className={css.codeButton} disabled={busy || !phoneValid} onClick={async () => {
          const attempt = ++sendAttempt.current
          setSent(false)
          setLocalError(null)
          const succeeded = await controller.sendPhoneCode(phone, method === 'register' ? 'register' : 'login')
          if (attempt === sendAttempt.current && succeeded) setSent(true)
        }}>{t(method === 'register' ? 'sendRegisterCode' : 'sendLoginCode')}</button>
      </div>
      <p id={`${formId}-${method}-code-hint`} className={css.hint}>{t('phoneCodeHint')}</p>
      {sent && <p role="status" className={css.authHint}>{t(method === 'register' ? 'registerCodeSent' : 'loginCodeSent')}</p>}
      {localError && <p role="alert" className={css.authAlert}>{t(localError)}</p>}
      <button type="submit" className={css.authSubmit} disabled={busy || !phoneValid || !codeValid}>{busy ? t('busy') : t(method === 'register' ? 'register' : 'login')}</button>
    </form>}
  </div>
}
