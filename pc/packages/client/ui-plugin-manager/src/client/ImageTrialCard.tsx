/** Read-only image activity and delivery in the conversation. Submission belongs to its explicit input action. */
import { useEffect, useState } from 'react'
import type { ImageTrialCall } from './image-trial-store.ts'
import type { ImageTrialJob, ImageTrialTransport, ImageTrialSteps } from './image-trial-transport.ts'
import { imageTrialReadFailure } from './image-trial-transport.ts'
import type { ImageTrialKey } from './image-trial-locales.ts'
import { ImageTrialProgress, type ImageTrialPhase } from './ImageTrialProgress.tsx'
import { ImageTrialResult } from './ImageTrialResult.tsx'
import css from './ImageTrialCard.module.css'

interface Props {
  call: ImageTrialCall
  transport: ImageTrialTransport
  isSubmitting: (id: string) => boolean
  onRegenerate?: (call: ImageTrialCall, steps?: ImageTrialSteps) => Promise<boolean>
  t: (key: ImageTrialKey) => string
}

/** Display a saved request without ever generating on mount, refresh or restoration.
 * @param props - Session-bound reference, live submission lookup, local carrier and copy.
 * @returns Inline activity or the delivered image, without parameter controls.
 */
export function ImageTrialCard({ call, transport, isSubmitting, onRegenerate, t }: Props) {
  const [job, setJob] = useState<ImageTrialJob | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [readError, setReadError] = useState<string | undefined>()
  const [epoch, setEpoch] = useState(0)
  const [imageError, setImageError] = useState(false)
  const [image, setImage] = useState<{ url: string; png: Blob } | null>(null)
  const [supportedSteps, setSupportedSteps] = useState<readonly ImageTrialSteps[]>([])
  const id = call.request?.id ?? null
  useEffect(() => {
    const controller = new AbortController()
    setSupportedSteps([])
    void transport.supportedSteps?.(controller.signal).then((steps) => {
      if (!controller.signal.aborted) setSupportedSteps(steps)
    }).catch(() => { /* A failed capability read never authorizes a higher preset. */ })
    return () => { controller.abort() }
  }, [transport])
  useEffect(() => {
    if (call.request === null || (call.submission === 'pending' && isSubmitting(call.request.id))) return
    const expected = call.request
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      try {
        const value = await transport.read(expected, controller.signal)
        if (controller.signal.aborted) return
        setJob(value); setUncertain(false); setReadError(undefined)
        if (value.status === 'running') timer = setTimeout(() => { void read() }, 1500)
      } catch (failure) {
        if (!controller.signal.aborted) { setUncertain(true); setReadError(imageTrialReadFailure(failure)) }
      }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [id, call.sessionId, call.submission, epoch, transport, isSubmitting])

  const status = job?.status
  const phase: ImageTrialPhase | null = uncertain || call.request === null ? null
    : status === 'running' ? job?.timing?.phase ?? 'generating'
      : status === undefined ? call.submission === 'pending' ? 'connecting' : 'checking'
        : status === 'completed' && image === null && !imageError ? 'loading' : null
  useEffect(() => {
    setImage(null); setImageError(false)
    if (job?.status !== 'completed') return
    const controller = new AbortController()
    let url: string | null = null
    void transport.image(job, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob); setImage({ url, png: blob })
    }).catch(() => { if (!controller.signal.aborted) setImageError(true) })
    return () => { controller.abort(); if (url !== null) URL.revokeObjectURL(url) }
  }, [job?.id, job?.status, job?.result?.sha256, epoch, transport])
  return <section className={css.activity} data-image-trial-call={call.id} data-image-trial-session={call.sessionId}
    data-image-trial-read-error={readError}>
    <p className={css.request}>{call.prompt}</p>
    <small className={css.research}>{t('title')}</small>
    {call.request === null && <p role="status">{t(call.rejection ?? 'resend')}</p>}
    {phase !== null && <ImageTrialProgress key={id ?? call.id} phase={phase}
      {...(job?.timing === undefined ? {} : { submittedAt: job.timing.submittedAt })} t={t} />}
    {uncertain && <p role="alert">{t('uncertain')}</p>}
    {job?.status === 'failed' && <><p role="alert">{t(job.timing?.phase === 'receiving'
      && ['IMAGE_TRIAL_OUTCOME_UNKNOWN', 'IMAGE_TRIAL_DELIVERY_UNAVAILABLE', 'IMAGE_TRIAL_STORE_FAILED'].includes(job.errorCode ?? '')
      ? 'deliveryPending' : job.errorCode === 'IMAGE_TRIAL_OUTCOME_UNKNOWN'
        ? 'uncertain' : job.errorCode === 'IMAGE_TRIAL_GATEWAY_UNAVAILABLE' ? 'gatewayUnavailable' : 'failed')}
    </p>{job.errorCode ? <details><summary>{t('diagnostics')}</summary><code>{job.errorCode}</code></details> : null}</>}
    {job?.status === 'completed' && <>
      <p role="status" className={css.resultMeta}>{t('completed')} · {job.width} × {job.height} · {t('stepCount').replace('{steps}', String(job.steps))}</p>
      {image !== null && <ImageTrialResult key={image.url} src={image.url} png={image.png}
        filename={`qianshou-image-${job.id}.png`} width={job.width} height={job.height} onImageError={() => { setImageError(true) }}
        {...(onRegenerate === undefined ? {} : { onRegenerate: () => onRegenerate(call),
          ...(supportedSteps.includes(12) ? { onClearer: () => onRegenerate(call, 12) } : {}),
          ...(supportedSteps.includes(20) ? { onHighDefinition: () => onRegenerate(call, 20) } : {}) })} t={t} />}
      {imageError && <p role="alert">{t('imageError')}</p>}
    </>}
    {call.request !== null && <button type="button" className={css.recheck}
      onClick={() => { setImageError(false); setEpoch(value => value + 1) }}>{t('refresh')}</button>}
  </section>
}
