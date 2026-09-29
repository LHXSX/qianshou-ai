/** Session-header owner controls; temporary link material is cleared when this view closes. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionGrantCreated, ConnectionGrantInput, ConnectionOwnerState } from '@deepseek-ai/dsh-api-remotes/client'
type SessionId = ConnectionGrantInput['sessionId']
import css from './ConnectEntry.module.css'

/** Owner actions only; no bearer-based viewer action is exposed in this component. */
export interface ConnectInjected {
  state(this: void, sessionId: SessionId): Promise<ConnectionOwnerState>
  create(this: void, input: ConnectionGrantInput): Promise<ConnectionGrantCreated>
  revoke(this: void, sessionId: SessionId, grantId: string): Promise<void>
}
/** Existing session/header context plus the isolated owner operations. */
export type ConnectEntryProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'qianshou.sessionConnect'> & InjectFace<ConnectInjected>

/** Match Host `identifier`: 1–256 chars, no C0 controls or DEL; blank after trim means omit. */
function optionalBindingId(raw: string): { ok: true; value?: string } | { ok: false } {
  const value = raw.trim()
  if (!value) return { ok: true }
  if (value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) return { ok: false }
  return { ok: true, value }
}

function hasConfiguredHttps(origin: string): boolean {
  try { return new URL(origin).protocol === 'https:' }
  catch { return false }
}

/**
 * Render an explicit, default-read-only connection grant for this Session.
 * @param props - Existing selected Session and authenticated owner operations.
 * @returns Session action and its scoped modal.
 */
export function ConnectEntry({ sessionId, useSessions, state: loadState, create, revoke, t }: ConnectEntryProps) {
  const session = useSessions(value => value.byId[sessionId])
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [value, setValue] = useState<ConnectionOwnerState>(), [secret, setSecret] = useState('')
  const [error, setError] = useState(''), [copyState, setCopyState] = useState('')
  const [label, setLabel] = useState(''), [mode, setMode] = useState<'read' | 'text'>('read'), [duration, setDuration] = useState(60)
  const [deviceId, setDeviceId] = useState(''), [pcId, setPcId] = useState('')
  const generation = useRef(0)
  const close = (): void => {
    generation.current++; setOpen(false); setBusy(false); setValue(undefined)
    setSecret(''); setError(''); setCopyState('')
    setLabel(''); setMode('read'); setDuration(60); setDeviceId(''); setPcId('')
  }
  useEffect(() => {
    generation.current++; setOpen(false); setSecret(''); setValue(undefined); setBusy(false)
    setLabel(''); setMode('read'); setDuration(60); setDeviceId(''); setPcId('')
    return () => { generation.current++ }
  }, [sessionId])
  const refresh = async (): Promise<void> => {
    const owner = generation.current
    setBusy(true); setError('')
    try { const next = await loadState(sessionId); if (owner === generation.current) setValue(next) }
    catch (_reason) { if (owner === generation.current) setError(t('failed')) }
    finally { if (owner === generation.current) setBusy(false) }
  }
  const createGrant = async (): Promise<void> => {
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > Math.min(1440, value?.maxDurationMinutes ?? 1440)) {
      setError(t('invalid')); return
    }
    const device = optionalBindingId(deviceId), pc = optionalBindingId(pcId)
    if (!device.ok || !pc.ok) { setError(t('invalidId')); return }
    const owner = generation.current
    setBusy(true); setError(''); setSecret(''); setCopyState('')
    try {
      const input: ConnectionGrantInput = { sessionId, label: label.trim() || t('defaultLabel'), mode, durationMinutes: duration }
      if (device.value !== undefined) input.deviceId = device.value
      if (pc.value !== undefined) input.pcId = pc.value
      const result = await create(input)
      if (owner !== generation.current) return
      if (!value) throw new Error('Connection status not loaded')
      setSecret(new URL(result.path, value.origin).href)
      setValue({ ...value, grants: [result.grant, ...value.grants] })
    } catch (_reason) { if (owner === generation.current) setError(t('failed')) }
    finally { if (owner === generation.current) setBusy(false) }
  }
  const revokeGrant = async (id: string): Promise<void> => {
    const owner = generation.current
    setBusy(true); setError('')
    try {
      await revoke(sessionId, id)
      if (owner !== generation.current) return
      // Any one-time link currently displayed may refer to the revoked grant; clear it conservatively.
      setSecret(''); setCopyState('')
      const next = await loadState(sessionId)
      if (owner === generation.current) setValue(next)
    } catch (_reason) { if (owner === generation.current) setError(t('failed')) }
    finally { if (owner === generation.current) setBusy(false) }
  }
  const copySecret = async (): Promise<void> => {
    const owner = generation.current
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(secret)
      if (owner === generation.current) setCopyState(t('copied'))
    } catch { if (owner === generation.current) setCopyState(t('copyFailed')) }
  }
  if (!session || session.origin === 'subagent') return null
  const https = value !== undefined && hasConfiguredHttps(value.origin)
  return <>
    <button type="button" className={css.trigger} onClick={() => { setOpen(true); void refresh() }}>{t('title')}</button>
    <Modal open={open} title={t('title')} closeLabel={t('close')} onClose={close} className={css.dialog ?? ''} contentClassName={css.panel ?? ''}>
      {secret ? <section className={css.secret} aria-label={t('createdTitle')}>
        <div className={css.secretHeader}><strong>{t('createdTitle')}</strong><span>{t('oneTime')}</span></div>
        <p className={css.hint}>{t('createdHint')}</p>
        <textarea aria-label={t('link')} readOnly value={secret} onFocus={(event) => { event.target.select() }} />
        <button type="button" className={css.copyPrimary} onClick={() => { void copySecret() }}>{t('copy')}</button>
        <span role="status">{copyState}</span>
        <p className={css.hint}>{https ? t('httpsCheck') : t('localOnly')}</p>
        <p className={css.hint}>{t('linkWarning')}</p>
        <button type="button" className={css.createAnother} onClick={() => { setSecret(''); setCopyState('') }}>{t('createAnother')}</button>
      </section> : <>
        <section className={css.reachabilityCard} aria-label={t('reachabilityTitle')}>
          <span className={css.eyebrow}>{t('reachabilityTitle')}</span>
          {!value ? <p role="status">{error ? t('reachabilityUnknown') : t('loading')}</p> : <>
            <strong>{https ? t('httpsConfigured') : t('localDevice')}</strong>
            <p>{https ? t('httpsCheck') : t('localOnly')}</p>
            <code>{value.origin}</code>
          </>}
        </section>
        {error && <div className={css.error} role="alert">{error}
          {!value && <button type="button" onClick={() => { void refresh() }} disabled={busy}>{t('retry')}</button>}
        </div>}
        {value && !value.available && <p role="alert" className={css.error}>{t('unavailable')}</p>}
        <form className={css.form} onSubmit={(event) => { event.preventDefault(); if (!busy) void createGrant() }}>
          <div className={css.createIntro}><h3>{t('introTitle')}</h3><p>{t('description')}</p></div>
          <details className={css.advanced}><summary>{t('advanced')}</summary>
            <div className={css.advancedFields}>
              <label>{t('label')}<input value={label} maxLength={80} placeholder={t('labelPlaceholder')} onChange={(event) => { setLabel(event.target.value) }} disabled={busy} /></label>
              <div className={css.row}><label>{t('mode')}<select value={mode} onChange={(event) => { setMode(event.target.value === 'text' ? 'text' : 'read') }} disabled={busy}>
                <option value="read">{t('read')}</option><option value="text">{t('text')}</option>
              </select></label><label>{t('duration')}<input type="number" min={1} max={Math.min(1440, value?.maxDurationMinutes ?? 1440)} value={duration}
                onChange={(event) => { setDuration(Number(event.target.value)) }} disabled={busy} /></label></div>
              <details className={css.deviceSettings}><summary>{t('deviceSettings')}</summary>
                <p className={css.hint}>{t('bindingNote')}</p>
                <div className={css.row}><label>{t('deviceId')}<input value={deviceId} maxLength={256} placeholder={t('deviceIdPlaceholder')} onChange={(event) => { setDeviceId(event.target.value) }} disabled={busy} /></label>
                  <label>{t('pcId')}<input value={pcId} maxLength={256} placeholder={t('pcIdPlaceholder')} onChange={(event) => { setPcId(event.target.value) }} disabled={busy} /></label></div>
              </details>
            </div>
          </details>
          {mode === 'text' && <p className={css.notice}>{t('permission')}</p>}
          <button className={css.primary} type="submit" disabled={busy || !value?.available}>{busy ? t('creating') : mode === 'read' ? t('createRead') : t('createText')}</button>
        </form>
      </>}
      <details className={css.history}>
        <summary>{t('grants')} · {value?.grants.length ?? 0}</summary>
        <div className={css.historyBody}>
          <div className={css.grantHeading}><p className={css.hint}>{t('noSecret')}</p><button type="button" onClick={() => { void refresh() }} disabled={busy}>{t('refresh')}</button></div>
          {value?.grants.length === 0 && <p className={css.empty}>{t('empty')}</p>}
          <ul className={css.grants}>{value?.grants.map(grant => <li key={grant.id}>
        <div className={css.row}><strong>{grant.label}</strong><span>{grant.revoked ? t('revoked') : grant.expiresAt <= Date.now() ? t('expired') : t('active')}</span></div>
        <p>{grant.mode === 'read' ? t('read') : t('text')} · {t('expires')} {new Date(grant.expiresAt).toLocaleString()}</p>
        <p className={css.hint}>{t('lastAccess')} {grant.lastAccessAt === null ? t('never') : new Date(grant.lastAccessAt).toLocaleString()} · {t('received')} {grant.acceptedCommands}</p>
        {grant.deviceId !== null && <p className={css.hint}>{t('deviceId')} {grant.deviceId}</p>}
        {grant.pcId !== null && <p className={css.hint}>{t('pcId')} {grant.pcId}</p>}
        {!grant.revoked && grant.expiresAt > Date.now() && <button type="button" disabled={busy} onClick={() => { void revokeGrant(grant.id) }}>{t('revoke')}</button>}
          </li>)}</ul>
        </div>
      </details>
    </Modal>
  </>
}
