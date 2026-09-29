/** Owner controls for local login launch and process-scoped sleep prevention. */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopDeviceBridge, DesktopDevicePreferences } from './desktop-device-bridge.ts'
import css from './DesktopDeviceControls.module.css'

type DeviceControlsProps = PropsLocale<'settings'>

function bridge(): DesktopDeviceBridge | undefined {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return undefined
  const carrier = (globalThis as typeof globalThis & { dshDesktop?: { protocolVersion: number; device?: DesktopDeviceBridge } }).dshDesktop
  return carrier?.protocolVersion === 1 ? carrier.device : undefined
}

/** Render only when the native Qianshou device controller is available. */
export function DesktopDeviceControls({ t }: DeviceControlsProps) {
  const native = bridge()
  const [state, setState] = useState<DesktopDevicePreferences>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (native === undefined) return
    let active = true
    void native.status().then((next) => { if (active) setState(next) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [native])

  if (native === undefined) return null
  const update = (name: 'launchAtLogin' | 'keepAwake' | 'automaticUpdates', enabled: boolean): void => {
    setPending(true)
    setError(false)
    void native.set(name, enabled).then(setState).catch(() => { setError(true) }).finally(() => { setPending(false) })
  }

  return (
    <section className={css.card} aria-label={t('device.title')}>
      <div className={css.heading}>
        <div>
          <h3>{t('device.title')}</h3>
          <p>{t('device.intro')}</p>
        </div>
        <span className={css.local}>{t('device.local')}</span>
      </div>
      {state !== undefined && <div className={css.rows}>
        <label className={css.row}>
          <span className={css.copy}><strong>{t('device.autostart')}</strong><small>{state.launchAtLoginAvailable
            ? t('device.autostartDescription') : t('device.autostartUnavailable')}</small></span>
          <input type="checkbox" role="switch" checked={state.launchAtLogin} disabled={pending || !state.launchAtLoginAvailable}
            onChange={(event) => { update('launchAtLogin', event.currentTarget.checked) }} />
        </label>
        <label className={css.row}>
          <span className={css.copy}><strong>{t('device.keepAwake')}</strong><small>{t('device.keepAwakeDescription')}</small></span>
          <input type="checkbox" role="switch" checked={state.keepAwake} disabled={pending}
            onChange={(event) => { update('keepAwake', event.currentTarget.checked) }} />
        </label>
        {state.automaticUpdates !== undefined && <label className={css.row}>
          <span className={css.copy}><strong>{t('device.automaticUpdates')}</strong><small>{t('device.automaticUpdatesDescription')}</small></span>
          <input type="checkbox" role="switch" checked={state.automaticUpdates} disabled={pending}
            onChange={(event) => { update('automaticUpdates', event.currentTarget.checked) }} />
        </label>}
      </div>}
      <p className={css.footnote}>{t('device.powerNotice')}</p>
      {error && <p className={css.error} role="alert">{t('device.error')}</p>}
    </section>
  )
}
