/** Describe the verified task type without exposing a customer's input or result. */
import type { NodeTranslate } from './NodeStatusPanel.tsx'
import { formatDuration } from './types.ts'

export function orderTaskName(taskType: string, t: NodeTranslate): string {
  if (taskType === 'word_count') return t('orderTaskWordCount')
  return taskType || t('intakeTaskUnknown')
}

export function orderTaskDescription(taskType: string, t: NodeTranslate): string {
  if (taskType === 'word_count') return t('orderTaskWordCountDescription')
  return t('orderTaskOtherDescription')
}

/** Preserve subsecond work instead of rounding a completed order down to 00:00:00. */
export function orderTaskDuration(elapsedMs: number | null, t: NodeTranslate): string {
  if (elapsedMs === null) return t('intakeDurationUnknown')
  return elapsedMs < 1000 ? `${elapsedMs} ${t('orderHistoryMilliseconds')}` : formatDuration(elapsedMs / 1000)
}
