/** Inline video research activity. Mount, refresh and restoration never submit work. */
import { useEffect, useId, useRef, useState } from 'react'
import type { VideoTrialCall } from './video-trial-store.ts'
import type { VideoTrialJob, VideoTrialTransport, VideoTrialPhase } from './video-trial-transport.ts'
import type { VideoTrialKey } from './video-trial-locales.ts'
import css from './VideoTrialCard.module.css'

type Text = (key: VideoTrialKey) => string
type Phase = VideoTrialPhase | 'connecting' | 'checking' | 'loading'
function rejectionKey(call: VideoTrialCall): VideoTrialKey {
  switch (call.rejectionCode) {
    case 'VIDEO_TRIAL_GATEWAY_UNAVAILABLE': return 'gatewayUnavailable'
    case 'VIDEO_TRIAL_PROFILE_UNAVAILABLE': return 'profileUnavailable'
    case 'VIDEO_TRIAL_IMAGE_UNAVAILABLE': return 'imageUnavailable'
    case 'VIDEO_TRIAL_INPUT_UNAVAILABLE': return 'inputUnavailable'
    case 'VIDEO_TRIAL_STORE_FULL': return 'storeUnavailable'
    case 'VIDEO_TRIAL_DISABLED':
    case 'VIDEO_TRIAL_CLOSED': return 'disabled'
    default: return call.rejection ?? 'refused'
  }
}
function Progress({ phase, submittedAt, progress, t }: { phase: Phase; submittedAt?: string; progress?: number; t: Text }) {
  const [observed] = useState(Date.now)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()) }, 1000); return () => { clearInterval(timer) } }, [])
  const seconds = Math.max(0, Math.floor((now - (submittedAt === undefined ? observed : Date.parse(submittedAt))) / 1000))
  return <div className={css.progress} data-video-trial-phase={phase}>
    <p role="status">{t(phase)}{progress === undefined ? '' : ` · ${progress}%`}</p>
    <div className={css.track} role="progressbar" aria-label={t('progress')} aria-valuetext={t(phase)}
      {...(progress === undefined ? {} : { 'aria-valuenow': progress, 'aria-valuemin': 0, 'aria-valuemax': 100 })}>
      <span className={progress === undefined ? css.pulse : css.value} style={progress === undefined ? undefined : { width: `${progress}%` }} />
    </div>
    <small aria-live="off">{t(submittedAt === undefined ? 'observed' : 'elapsed')} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</small>
  </div>
}
/** Show checked media and explicit repeat controls while keeping the original result intact. */
export function VideoTrialCard({ call, transport, isSubmitting, onRegenerate, t }: {
  call: VideoTrialCall
  transport: VideoTrialTransport
  isSubmitting: (id: string) => boolean
  onRegenerate?: (call: VideoTrialCall) => Promise<boolean>
  t: Text
}) {
  const [savedJob, setJob] = useState<VideoTrialJob | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [mediaError, setMediaError] = useState(false)
  const [media, setMedia] = useState<{ id: string; sessionId: string; url: string } | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [repeatFailed, setRepeatFailed] = useState(false)
  const repeatLock = useRef(false)
  const pendingRefresh = useRef<{ id: string; sessionId: string } | null>(null)
  const qualityHint = useId()
  const request = call.request
  const job = request !== null && savedJob?.id === request.id && savedJob.sessionId === call.sessionId ? savedJob : null
  const video = job !== null && media?.id === job.id && media.sessionId === call.sessionId ? media : null
  useEffect(() => {
    setUncertain(false)
    if (pendingRefresh.current !== null
      && (pendingRefresh.current.id !== request?.id || pendingRefresh.current.sessionId !== call.sessionId)) {
      pendingRefresh.current = null
    }
    if (request === null || (call.submission === 'pending' && isSubmitting(request.id))) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let retryDelivery = pendingRefresh.current !== null
    pendingRefresh.current = null
    const read = async (): Promise<void> => {
      try {
        const retry = retryDelivery; retryDelivery = false
        const value = retry ? await transport.read(request, controller.signal, true) : await transport.read(request, controller.signal)
        if (controller.signal.aborted) return
        setJob(value); setUncertain(false)
        if (value.status === 'running') timer = setTimeout(() => { void read() }, 1500)
      } catch { if (!controller.signal.aborted) setUncertain(true) }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [request?.id, call.sessionId, call.submission, epoch, isSubmitting, transport])
  useEffect(() => {
    setMedia(null); setMediaError(false)
    if (job?.status !== 'completed') return
    const controller = new AbortController()
    let url: string | undefined
    void transport.video(job, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob); setMedia({ id: job.id, sessionId: job.sessionId, url })
    }).catch(() => { if (!controller.signal.aborted) setMediaError(true) })
    return () => { controller.abort(); if (url !== undefined) URL.revokeObjectURL(url) }
  }, [job?.id, job?.sessionId, job?.status, job?.result?.sha256, epoch, transport])
  const phase: Phase | null = request === null || uncertain ? null : job === null
    ? call.submission === 'pending' ? 'connecting' : 'checking' : job.status === 'running' ? job.timing.phase
      : job.status === 'completed' && video === null && !mediaError ? 'loading' : null
  return <section className={css.activity} data-video-trial-call={call.id} data-video-trial-session={call.sessionId}>
    <p className={css.prompt}>{call.prompt}</p>
    <small>{t('title')} · {t('settings')}</small>
    <small>{t(call.source.kind === 'attachment' ? 'firstFrameAttached' : call.source.kind === 'reuse' ? 'firstFrameReused' : 'firstFrameGenerated')}</small>
    {request === null && <>
      <p role="alert">{t(rejectionKey(call))}</p>
      {call.rejectionCode !== undefined && <details><summary>{t('details')}</summary><code>{call.rejectionCode}</code></details>}
    </>}
    {phase !== null && <Progress key={call.id} phase={phase} {...(job === null ? {} : { submittedAt: job.timing.submittedAt })}
      {...(job?.status === 'running' && job.progress !== undefined ? { progress: job.progress } : {})} t={t} />}
    {uncertain && <p role="alert">{t('uncertain')}</p>}
    {job?.status === 'running' && job.errorCode !== undefined && <p role="alert">{t('uncertain')}</p>}
    {job?.status === 'failed' && <p role="alert">{t(job.errorCode === 'VIDEO_TRIAL_OUTCOME_UNKNOWN' ? 'uncertain' : 'failed')}</p>}
    {job?.errorCode !== undefined && <details><summary>{t('details')}</summary><code>{job.errorCode}</code></details>}
    {job?.status === 'completed' && <>
      <p role="status">{t('completed')}</p>
      {video !== null && <>
        <video className={css.video} controls preload="metadata" src={video.url} aria-label={t('completed')}
          onError={() => { setMediaError(true) }} />
        <div className={css.actions}>
          {onRegenerate !== undefined && <button type="button" disabled={regenerating} onClick={() => {
            if (repeatLock.current) return
            repeatLock.current = true; setRegenerating(true); setRepeatFailed(false)
            void onRegenerate(call).then((ok) => { if (!ok) setRepeatFailed(true) }).catch(() => { setRepeatFailed(true) })
              .finally(() => { repeatLock.current = false; setRegenerating(false) })
          }}>{t(regenerating ? 'regenerating' : 'regenerate')}</button>}
          <button type="button" disabled aria-describedby={qualityHint}>{t('clearer')}</button>
          <button type="button" disabled aria-describedby={qualityHint}>{t('hd')}</button>
          <a href={video.url} download={`qianshou-video-${job.id}.mp4`}>{t('download')}</a>
        </div>
        <small id={qualityHint}>{t('qualityUnavailable')}</small>
        {repeatFailed && <p role="alert">{t('regenerateFailed')}</p>}
      </>}
      {mediaError && <p role="alert">{t('mediaError')}</p>}
    </>}
    {request !== null && <button type="button" className={css.refresh} onClick={() => {
      pendingRefresh.current = { id: request.id, sessionId: call.sessionId }
      setEpoch(value => value + 1)
    }}>{t('refresh')}</button>}
  </section>
}
