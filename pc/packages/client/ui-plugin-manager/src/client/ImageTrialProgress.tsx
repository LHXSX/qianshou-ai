/** Indeterminate activity and elapsed time derived from actual Host observations. */
import { useEffect, useState } from 'react'
import type { ImageTrialKey } from './image-trial-locales.ts'
import css from './ImageTrialCard.module.css'

export type ImageTrialPhase = 'connecting' | 'checking' | 'queued' | 'generating' | 'receiving' | 'loading'
const phaseKeys: Record<ImageTrialPhase, ImageTrialKey> = {
  connecting: 'phaseConnecting', checking: 'phaseChecking', queued: 'phaseQueued', generating: 'phaseGenerating',
  receiving: 'phaseReceiving', loading: 'imageLoading',
}

function Xiaoka() {
  return <svg className={css.worker} viewBox="0 0 128 100" fill="none" aria-hidden="true" focusable="false">
    <path className={css.workerGround} d="M12 88H116" />
    <g className={css.workerBody}>
      <path className={css.workerLegs} d="M49 70L43 86M70 70L77 86M36 87H46M76 87H86" />
      <rect className={css.workerCard} x="33" y="22" width="52" height="52" rx="14" />
      <path className={css.workerFace} d="M46 38L52 40M66 40L72 38M51 46H52M66 46H67M53 58Q59 54 65 58" />
      <path className={css.workerAntenna} d="M59 22V14M56 12H62" />
      <path className={css.workerArmLeft} d="M35 48L23 54L29 67" />
      <path className={css.workerArmRight} d="M84 48L96 55L91 67" />
      <path className={css.workerSweat} d="M89 28Q96 35 89 37Q82 35 89 28Z" />
    </g>
    <g className={css.workerGear}>
      <path d="M61 73V77M61 91V95M50 84H54M68 84H72M53 76L56 79M66 89L69 92M53 92L56 89M66 79L69 76" />
      <circle cx="61" cy="84" r="7" />
      <circle cx="61" cy="84" r="2" />
    </g>
    <path className={css.workerSpark} d="M17 25V33M13 29H21M102 44V50M99 47H105" />
  </svg>
}

/** Show unknown progress without claiming a percentage, estimate or sampling step.
 * @param props - Observed phase, optional Host start time and localized copy.
 * @returns An accessible activity indicator; unmount stops all animation and timers.
 */
export function ImageTrialProgress({ phase, submittedAt, t }: {
  phase: ImageTrialPhase
  submittedAt?: string
  t: (key: ImageTrialKey) => string
}) {
  const [observedAt] = useState(Date.now)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  const elapsed = Math.max(0, Math.floor((now - (submittedAt === undefined ? observedAt : Date.parse(submittedAt))) / 1000))
  const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const label = t(phaseKeys[phase])
  return <div className={css.progressPanel} data-image-trial-phase={phase}>
    {phase !== 'loading' && <div className={css.workerPanel}>
      <Xiaoka />
      <small>{t('workerWorking')}</small>
    </div>}
    <div className={css.progressDetails}>
      <p role="status" className={css.progressLabel}>{label}</p>
      <div className={css.progressTrack} role="progressbar" aria-label={t('progress')} aria-valuetext={label}>
        <span className={css.progressPulse} />
      </div>
      <p className={css.progressElapsed} aria-live="off">{t(submittedAt === undefined ? 'observedWait' : 'elapsed')} · {duration}</p>
      {phase !== 'loading' && <small className={css.progressHint}>{t('progressHint')}</small>}
    </div>
  </div>
}
