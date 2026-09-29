/** Account inputs are ephemeral component state and never enter conversation drafts. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  IconDownloadOutline16, IconGlobeOutline14, IconInfoOutline14, IconSettingsOutline16, IconUserOutline16,
  Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountController } from './controller.ts'
import { AccountExitConfirmation, type AccountExitIntent } from './AccountExitConfirmation.tsx'
import { AccountHome } from './AccountHome.tsx'
import { LoginCard } from './LoginCard.tsx'
import css from './AccountPanel.module.css'

const BRAND_MARK_SRC = '/brand/qianshou-mark.png'

/** Shared action/store face for Settings and the sidebar account menu. */
export interface AccountInjected {
  controller: AccountController
  hooks: { account: AccountController['store'] }
}
export type AccountPanelProps = InjectFace<AccountInjected> & PropsLocale<'qianshou.account'> & {
  /** The containing modal already supplies the account heading. */
  hideTitle?: boolean
}

/** Render real account status and the password/TOTP steps supplied by its Host. */
export function AccountPanel({ controller, useAccount, t, hideTitle = false }: AccountPanelProps) {
  const { snapshot, busy, failed } = useAccount(state => state)
  const [exitIntent, setExitIntent] = useState<AccountExitIntent | null>(null)
  const [code, setCode] = useState('')
  const [trust, setTrust] = useState(false)
  useEffect(() => { void controller.load() }, [controller])
  const twoFactor = snapshot?.phase === 'two-factor-required'
  const signedIn = snapshot?.account !== null && snapshot?.account !== undefined
  const authError = failed ? t('connection-failed') : snapshot?.failure ? t(snapshot.failure) : null
  const showRetry = failed || snapshot?.phase === 'unavailable' || snapshot?.phase === 'expired' || snapshot?.restorable === true
  return <section className={css.panel} data-qianshou-account>
    {signedIn ? <>
      {!hideTitle && <h2>{t('title')}</h2>}
      {failed && <p role="alert">{t('connection-failed')}</p>}
      {snapshot?.failure && <p role="alert">{t(snapshot.failure)}</p>}
      {snapshot && <AccountHome controller={controller} busy={busy} snapshot={snapshot} t={t} />}
    </> : <div className={css.authShell}>
      <div className={css.authCard}>
        <header className={css.authHeader}>
          <img className={css.authMark} src={BRAND_MARK_SRC} alt="" aria-hidden="true" />
          <span className={css.authEyebrow}>{t('title')}</span>
          <h2>{t(twoFactor ? 'securityTitle' : 'welcomeTitle')}</h2>
          <p>{t(twoFactor ? 'securityHint' : 'welcomeHint')}</p>
        </header>
        <p className={css.authStatus} role="status" data-error={authError !== null}>
          <span aria-hidden="true" />{snapshot === null ? t('loading') : t(snapshot.phase)}
        </p>
        {authError && <p className={css.authAlert} role="alert">{authError}</p>}
        {twoFactor ? <form className={`${css.form} ${css.authForm}`} onSubmit={(event) => {
          event.preventDefault()
          void controller.verify(code, trust); setCode('')
        }}>
          <label>{t('code')}<input aria-label={t('code')} value={code} inputMode="numeric" autoComplete="one-time-code"
            maxLength={6} required disabled={busy} onChange={(event) => { setCode(event.target.value) }} /></label>
          <label className={css.check}><input type="checkbox" checked={trust} disabled={busy}
            onChange={(event) => { setTrust(event.target.checked) }} />{t('trust')}</label>
          <button type="submit" className={css.authSubmit} disabled={busy}>{busy ? t('busy') : t('verify')}</button>
          <button type="button" className={css.authTextButton} onClick={() => { setCode(''); void controller.cancel() }}>{t('cancel')}</button>
        </form> : <LoginCard controller={controller} busy={busy} t={t} />}
        {showRetry && <div className={css.authFooter}>
          <button type="button" disabled={busy} onClick={() => { void controller.reconnect() }}>{t('retryConnection')}</button>
          {snapshot?.restorable && <button type="button" disabled={busy} onClick={() => { setExitIntent({ ownerId: null, kind: 'logout' }) }}>{t('logout')}</button>}
        </div>}
      </div>
    </div>}
    <AccountExitConfirmation controller={controller} intent={exitIntent} busy={busy} failed={failed} t={t}
      onClose={() => { setExitIntent(null) }} />
    <details className={`${css.accountDetails} ${signedIn ? '' : css.authDetails}`}>
      <summary>{t('accountDetails')}</summary>
      <p className={css.hint}>{t('selectionHint')}</p>
      {signedIn && <p className={css.hint}>{t(snapshot.restorable ? 'restoreHint' : 'sessionHint')}</p>}
      <p className={css.hint}>{t('storageHint')}</p>
    </details>
  </section>
}

/** The sidebar account chip goes straight to the account home; secondary actions stay in a short menu. */
export function AccountEntry(props: AccountPanelProps & PropsRuntime<'sidebar.footer.action'>) {
  const [open, setOpen] = useState(false)
  const [exitIntent, setExitIntent] = useState<AccountExitIntent | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const aboutDialog = useRef<HTMLDialogElement | null>(null)
  const { snapshot, busy, failed } = props.useAccount(state => state)
  useEffect(() => {
    void props.controller.load()
    const timer = setInterval(() => { void props.controller.load() }, 5000)
    return () => { clearInterval(timer) }
  }, [props.controller])
  const signedIn = snapshot?.account !== null && snapshot?.account !== undefined
  const label = snapshot?.account?.username ?? props.t('title')
  const avatarSeed = snapshot?.account?.id ?? 'qianshou'
  const avatarVariant = Array.from(avatarSeed).reduce((value, character) => (value * 31 + character.codePointAt(0)!) % 5, 0)
  const status = failed ? props.t('connection-failed') : snapshot === null ? props.t('loading') : props.t(snapshot.phase)
  const desktopCarrier = (globalThis as typeof globalThis & {
    dshDesktop?: { protocolVersion?: number; updates?: unknown }
  }).dshDesktop
  const desktopUpdates = desktopCarrier?.protocolVersion === 1 && desktopCarrier.updates !== undefined
  useEffect(() => { if (aboutOpen) aboutDialog.current?.showModal() }, [aboutOpen])
  const menuAction = (sectionId: 'general' | 'qianshou-account') => {
    setOpen(false)
    window.dispatchEvent(new CustomEvent('qianshou:open-settings', { detail: { sectionId } }))
  }
  const items: MenuEntry[] = [
    { id: 'identity', disabled: true, label: <span className={css.menuIdentity} data-qianshou-account-menu>
      <span className={css.menuAvatar} data-avatar-variant={signedIn ? avatarVariant : undefined} aria-hidden="true">{signedIn
        ? label.slice(0, 1).toLocaleUpperCase()
        : <img src={BRAND_MARK_SRC} alt="" />}</span>
      <span className={css.menuIdentityText}>
        <strong title={label}>{label}</strong>
        <small className={css.menuStatus} data-authenticated={signedIn && !failed && snapshot?.phase === 'authenticated'}
          data-error={failed || snapshot?.phase === 'unavailable'}>{status}</small>
      </span>
    </span> },
    { type: 'separator', id: 'identity-line' },
    { id: 'account', label: signedIn ? props.t('accountAndPlan') : props.t('login'), icon: <IconUserOutline16 /> },
    { id: 'cloud', label: props.t('cloudLink'), icon: <IconGlobeOutline14 size={16} /> },
    { type: 'separator', id: 'preferences-line' },
    { id: 'settings', label: props.t('settings'), icon: <IconSettingsOutline16 /> },
    ...(desktopUpdates ? [{ id: 'update', label: props.t('checkUpdate'), icon: <IconDownloadOutline16 /> }] : []),
    { type: 'separator', id: 'support-line' },
    { id: 'help', label: props.t('help'), icon: <IconInfoOutline14 size={16} /> },
    { id: 'about', label: props.t('about') },
  ]
  const footer: MenuEntry[] = signedIn ? [{ id: 'logout', label: props.t('logout'), danger: true, disabled: busy }] : []
  return <>
    <Menu open={open} onClose={() => { setOpen(false) }} side="top" portal autoFocus items={items} footer={footer} className={css.entryMenuRoot}
      onSelect={(id) => {
        if (id === 'account') menuAction('qianshou-account')
        if (id === 'settings') menuAction('general')
        if (id === 'update') {
          setOpen(false)
          window.dispatchEvent(new Event('qianshou:open-update'))
        }
        if (id === 'cloud') {
          window.open('https://app.qianshousuanli.com', '_blank', 'noopener,noreferrer')
          setOpen(false)
        }
        if (id === 'help') {
          window.open('https://qianshousuanli.com/#/downloads', '_blank', 'noopener,noreferrer')
          setOpen(false)
        }
        if (id === 'about') { setOpen(false); setAboutOpen(true) }
        if (id === 'logout') {
          setOpen(false)
          if (snapshot?.account) setExitIntent({ ownerId: snapshot.account.id, kind: 'logout' })
        }
      }}
      anchor={<span className={css.entryGroup}>
        <button type="button" className={`${css.entry} ${props.wide ? '' : css.entryCompact}`}
          data-qianshou-account-entry aria-label={props.t('open')} title={label}
          onClick={() => { menuAction('qianshou-account') }}>
          <span className={css.entryAvatar} data-avatar-variant={signedIn ? avatarVariant : undefined} aria-hidden="true">{signedIn
            ? label.slice(0, 1).toLocaleUpperCase()
            : <img src={BRAND_MARK_SRC} alt="" />}</span>
          {props.wide && <span className={css.entryText}><strong className={css.entryLabel}>{label}</strong>
            <small>{snapshot === null ? props.t('loading') : props.t(snapshot.phase)}</small></span>}
        </button>
        {props.wide && <button type="button" className={css.entryMore} aria-label={props.t('accountMenu')}
          aria-haspopup="menu" aria-expanded={open} title={props.t('accountMenu')}
          onClick={() => { setOpen(value => !value) }}>
          <span aria-hidden="true">⋯</span>
        </button>}
      </span>} />
    <AccountExitConfirmation controller={props.controller} intent={exitIntent} busy={busy} failed={failed} t={props.t}
      onClose={() => { setExitIntent(null) }} />
    {aboutOpen && <dialog ref={aboutDialog} className={css.aboutDialog}
      aria-label={props.t('about')} onClose={() => { setAboutOpen(false) }}>
      <img className={css.aboutMark} src={BRAND_MARK_SRC} alt="" aria-hidden="true" />
      <h2>{props.t('about')}</h2>
      <p>{props.t('aboutDescription')}</p>
      <p className={css.aboutVersion}>{props.t('aboutVersion', {
        version: process.env.DSH_CLIENT_VERSION ?? props.t('aboutVersionUnknown'),
      })}</p>
      <div className={css.aboutLinks}>
        <a href="https://qianshousuanli.com" target="_blank" rel="noreferrer">{props.t('officialSite')}</a>
        <a href="https://qianshousuanli.com/#/terms" target="_blank" rel="noreferrer">{props.t('terms')}</a>
        <a href="https://qianshousuanli.com/#/privacy" target="_blank" rel="noreferrer">{props.t('privacy')}</a>
      </div>
      <button type="button" onClick={() => { aboutDialog.current?.close() }}>{props.t('close')}</button>
    </dialog>}
  </>
}
