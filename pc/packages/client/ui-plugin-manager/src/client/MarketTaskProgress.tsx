/** Display observed workload progress without estimating generation completion. */
import { useEffect, useState } from 'react'
import type { MarketTaskWorkload } from './market-task-transport.ts'
import type { MarketTaskProgressLabels } from './market-task-progress-locales.ts'
import css from './OrderProductsPanel.module.css'

function elapsedTime(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  const tail = String(seconds % 60).padStart(2, '0')
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}:${tail}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`
}

/** Terminal execution has no active progress animation; acceptance and settlement stay separate. */
export function MarketTaskProgress({ workload, disconnected, labels, videoTask = false }: {
  workload: MarketTaskWorkload | null
  disconnected: boolean
  labels: MarketTaskProgressLabels
  videoTask?: boolean
}) {
  const finished = ['DONE', 'FAILED', 'CANCELLED', 'CANCELED', 'QUARANTINED'].includes(workload?.status ?? '')
  const [now, setNow] = useState(() => Date.now())
  const created = workload?.createdAt === undefined ? NaN : Date.parse(workload.createdAt)
  useEffect(() => {
    if (finished || !Number.isFinite(created)) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [finished, created])
  if (finished) return null
  const stage = workload?.status === 'RUNNING' ? workload.executionStage : undefined
  const waiting = stage === 'waiting' || workload?.status === 'WAITING_FOR_WORKERS'
  const checking = stage === 'checking'
  const executing = stage === 'executing'
  const preparing = workload?.status === 'NORMALIZING'
  const label = disconnected ? labels.taskProgressUnconfirmed
    : waiting ? videoTask ? labels.taskVideoWaiting : labels.taskProgressWaiting
      : executing ? videoTask ? labels.taskVideoExecuting : labels.taskProgressExecuting
        : checking ? videoTask ? labels.taskVideoChecking : labels.taskProgressChecking
          : preparing ? videoTask ? labels.taskVideoPreparing : labels.taskProgressPreparing
            : labels.taskProgressUnconfirmed
  // A zero aggregate is common while a provider is generating its only output.
  // Keep activity visible rather than inventing a duration-based percentage.
  const observed = workload?.progress
  const knownStage = stage === 'waiting' || stage === 'executing' || stage === 'checking'
    || workload?.status === 'WAITING_FOR_WORKERS' || workload?.status === 'NORMALIZING'
  const value = !disconnected && knownStage && (!videoTask || !waiting && !preparing)
    && typeof observed === 'number' && Number.isFinite(observed)
    && observed > 0 && observed <= 1 ? observed : null
  const percent = value === null ? null : Math.round(value * 100)
  const caption = disconnected ? labels.taskProgressDisconnected
    : videoTask ? waiting ? labels.taskVideoQueueUnknown
      : checking ? labels.taskVideoCheckingHint
        : value === null ? labels.taskVideoNoPercent : labels.taskVideoPercentHint
      : value === null ? labels.taskProgressNoPercent : labels.taskProgressLabel
  return <div className={css.progress} data-disconnected={disconnected || undefined}>
    <div className={css.progressHeading}>
      <strong>{label}</strong>
      {percent !== null && <span>{percent}%</span>}
    </div>
    <div className={css.progressTrack} role="progressbar" aria-label={labels.taskProgressLabel}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : value * 100}
      aria-valuetext={disconnected ? labels.taskProgressDisconnected : label}>
      <span className={css.progressFill} data-indeterminate={value === null || undefined}
        style={value === null ? undefined : { width: `${value * 100}%` }} />
    </div>
    <div className={css.progressCaption}>
      <span>{caption}</span>
      {Number.isFinite(created) && <span>{labels.taskProgressElapsed.replace('{time}', elapsedTime(now - created))}</span>}
    </div>
  </div>
}
