/** Inline official quote confirmation; mounting and restoring only query the original request. */
import { useEffect, useRef, useState } from 'react'
import type { FormalMediaCall } from './formal-media-store.ts'
import type { FormalMediaState, FormalMediaTransport } from './formal-media-transport.ts'
import type { FormalMediaKey } from './formal-media-locales.ts'
import css from './VideoTrialCard.module.css'

/** Display an immutable original message, a quoted amount and read-only task receipts. */
export function FormalMediaCard({ call, transport, onConfirm, onQuote, t }: {
  call: FormalMediaCall
  transport: FormalMediaTransport
  onConfirm: (call: FormalMediaCall) => Promise<boolean>
  onQuote: (call: FormalMediaCall) => Promise<boolean>
  t: (key: FormalMediaKey) => string
}) {
  const [state, setState] = useState<FormalMediaState | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [media, setMedia] = useState<{ requestId: string; sessionId: string; sha256: string; url: string } | null>(null)
  const [mediaError, setMediaError] = useState(false)
  const lock = useRef(false)
  const activeUrl = useRef<string | null>(null)
  const [clock, setClock] = useState(Date.now())
  const current = state?.requestId === call.requestId && state.sessionId === call.sessionId ? state : null
  useEffect(() => {
    setError(false)
    if (call.submission !== 'submitted' && call.submission !== 'uncertain') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const result = await transport.state(call, controller.signal)
        if (controller.signal.aborted) return
        setState(result); setError(false)
        if (!['FAILED', 'CANCELLED'].includes(result.status) && (!result.deliveryAvailable || result.status !== 'DONE')) {
          timer = setTimeout(() => { void read() }, result.pollIntervalMs)
        }
      } catch { if (!controller.signal.aborted) setError(true) }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [call.requestId, call.sessionId, call.submission, transport, epoch])
  useEffect(() => {
    setMediaError(false)
    activeUrl.current = null
    if (current === null || !current.deliveryAvailable || current.resultMetadata === null) return
    const expected = current.resultMetadata
    const controller = new AbortController()
    let url: string | undefined
    void transport.media(current, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      activeUrl.current = url
      setMedia({ requestId: current.requestId, sessionId: current.sessionId, sha256: expected.sha256, url })
    }, () => { if (!controller.signal.aborted) setMediaError(true) })
    return () => {
      controller.abort()
      if (activeUrl.current === url) activeUrl.current = null
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [current?.requestId, current?.sessionId, current?.deliveryAvailable, current?.resultMetadata?.sha256, transport, epoch])
  const act = async (action: (call: FormalMediaCall) => Promise<boolean>) => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try { await action(call) } catch { setError(true) } finally { lock.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (call.quote === null || call.submission !== 'quoted') return
    const delay = Date.parse(call.quote.expiresAt) - Date.now()
    if (delay <= 0) { setClock(Date.now()); return }
    const timer = setTimeout(() => { setClock(Date.now()) }, delay + 1)
    return () => { clearTimeout(timer) }
  }, [call.quote?.expiresAt, call.submission])
  const expired = call.quote !== null && Date.parse(call.quote.expiresAt) <= Math.max(clock, Date.now())
  const phase = current?.phase as FormalMediaKey | undefined
  const shown = media !== null && media.requestId === call.requestId && media.sessionId === call.sessionId
    && media.sha256 === current?.resultMetadata?.sha256 ? media : null
  return <article className={css.activity} data-qianshou-formal-media={call.requestId}>
    <strong>{t('title')}</strong><p className={css.prompt}>{call.input.prompt}</p>
    {call.submission === 'quoting' && <p role="status">{t('quoting')}</p>}
    {call.submission === 'quote-failed' && <p role="alert">{t('quoteFailed')}</p>}
    {call.submission === 'assets-pending' && <>
      <p role="status">{t('assetsPending')}</p>
      <button type="button" disabled={busy} onClick={() => { void act(onQuote) }}>{t('assetStatus')}</button>
    </>}
    {call.quote !== null && <p>{t('quote')} · ¥{call.quote.amountYuan} · {call.quote.currency}</p>}
    {(call.submission === 'quoted' || call.submission === 'quote-failed' || call.submission === 'quoting') && <div className={css.actions}>
      {call.submission === 'quoted' && call.quote !== null && <button type="button" disabled={busy || expired || !call.quote.balanceEnough}
        onClick={() => { void act(onConfirm) }}>{t(busy ? 'confirming' : 'confirm')}</button>}
      <button type="button" disabled={busy} onClick={() => { void act(onQuote) }}>{t('reQuote')}</button>
    </div>}
    {call.submission === 'quoted' && expired && <p role="status">{t('expired')}</p>}
    {call.submission === 'quoted' && call.quote?.balanceEnough === false && <p role="status">{t('balance')}</p>}
    {(call.submission === 'uncertain' || error) && <p role="alert">{t('uncertain')}</p>}
    {current !== null && <div className={css.progress}>
      <p role="status">{t(phase ?? 'waiting')}{current.progress === null ? '' : ` · ${Math.round(current.progress * 100)}%`}</p>
      {!['FAILED', 'CANCELLED', 'DONE'].includes(current.status) && <div className={css.track} role="progressbar"
        aria-label={t('progress')} aria-valuetext={t(phase ?? 'waiting')}
        {...(current.progress === null ? {} : { 'aria-valuenow': Math.round(current.progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 })}>
        <span className={current.progress === null ? css.pulse : css.value}
          style={current.progress === null ? undefined : { width: `${current.progress * 100}%` }} />
      </div>}
      <small>{t('elapsed')} · {Math.floor(current.elapsedSeconds / 60)}:{String(current.elapsedSeconds % 60).padStart(2, '0')}</small>
    </div>}
    {shown !== null && current?.resultMetadata !== null && current?.resultMetadata !== undefined && <>
      {current.resultMetadata.capability === 'video' ? <video className={css.video} src={shown.url} controls preload="metadata"
        onError={() => { if (activeUrl.current === shown.url) setMediaError(true) }} />
        : <img className={css.video} src={shown.url} alt={call.input.prompt}
          onError={() => { if (activeUrl.current === shown.url) setMediaError(true) }} />}
      <a href={shown.url} download={`qianshou-${shown.sha256}.${current.resultMetadata.contentType === 'video/mp4' ? 'mp4'
        : current.resultMetadata.contentType === 'image/png' ? 'png' : 'jpg'}`}>{t('download')}</a>
    </>}
    {mediaError && <p role="alert">{t('previewFailed')}</p>}
    {(call.submission === 'uncertain' || call.submission === 'submitted') && <button type="button" onClick={() => { setEpoch(value => value + 1) }}>{t('refresh')}</button>}
  </article>
}
