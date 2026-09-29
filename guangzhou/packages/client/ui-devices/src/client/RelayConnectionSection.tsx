import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayState } from './relay-controller.ts'
import type { DevicesKey } from './locales.ts'
import css from './RelayConnectionSection.module.css'

type Props = PropsLocale<'qianshou.devices'> & {
  state: RelayState
  act: (action: 'import' | 'enable' | 'disable') => Promise<void>
}
const phases: Record<RelayState['status']['phase'], DevicesKey> = {
  unconfigured: 'relayUnconfigured', disabled: 'relayDisabled', connecting: 'relayConnecting', online: 'relayOnline', error: 'relayFailed',
}
const errors: Record<string, DevicesKey> = {
  INVALID_ENROLLMENT: 'relayInvalid', INVALID_RELAY_RESOURCES: 'relayResources', SECURE_STORAGE_UNAVAILABLE: 'relayStorage',
  REGISTRATION_UNREADABLE: 'relayUnreadable', RELAY_STOP_FAILED: 'relayStopFailed', RELAY_DISABLE_BEFORE_IMPORT: 'relayDisableFirst',
}
/** Optional native relay controls keep direct coordinator invitations available. */
export function RelayConnectionSection({ state, act, t }: Props) {
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false)
  const error = state.error ?? state.status.error
  async function copyAddress() {
    setCopyError(false)
    if (state.status.phase !== 'online' || !state.status.endpoint) return
    try { await navigator.clipboard.writeText(state.status.endpoint); setCopied(true) }
    catch { setCopyError(true) }
  }
  return <section className={css.panel} aria-label={t('relayTitle')} data-device-relay>
    <div className={css.heading}><h2>{t('relayTitle')}</h2>
      <span className={css.status} role="status" data-online={state.status.phase === 'online'}>{t(state.available ? phases[state.status.phase] : 'relayDesktopOnly')}</span></div>
    <p>{t('relayDescription')}</p>
    {state.available ? <>
      <div className={css.actions}>
        <Button size="sm" disabled={state.busy || state.status.enabled} onClick={() => { setCopied(false); void act('import') }}>{t('relayImport')}</Button>
        <Button size="sm" variant={state.status.enabled ? 'outline' : 'primary'} disabled={state.busy || !state.status.configured}
          onClick={() => { setCopied(false); void act(state.status.enabled ? 'disable' : 'enable') }}>{t(state.status.enabled ? 'relayDisable' : 'relayEnable')}</Button>
        <Button size="sm" disabled={state.status.phase !== 'online'} onClick={() => { void copyAddress() }}>{t(copied ? 'copied' : 'relayCopyAddress')}</Button>
      </div>
      {state.status.endpoint && <code className={css.address}>{state.status.endpoint}</code>}
      {error && <p role="alert">{t(errors[error] ?? 'relayFailedHint')}</p>}
      {copyError && <p role="alert">{t('copyFailed')}</p>}
      <small>{t(state.status.phase === 'online' ? 'relayOnlineHint' : 'relayImportHint')}</small>
    </> : <small>{t('relayBrowserHint')}</small>}
  </section>
}
