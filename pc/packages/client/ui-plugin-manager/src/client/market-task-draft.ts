/** Browser-local user input only; contracts and quote tickets remain outside the draft. */
import type { MarketInputDraft } from './market-input-form.ts'
import { marketInputFile, type MarketInputFile } from './market-task-transport.ts'
import type { VideoCreativeAnswers } from './VideoCreativeBrief.tsx'

export interface MarketTaskDraft {
  goal: string
  input: MarketInputDraft
  params: Record<string, string | boolean>
  files?: readonly MarketInputFile[]
  inputMode?: 'inline' | 'files'
  videoAnswers?: VideoCreativeAnswers
  videoExpert?: boolean
  /** Chosen after the initial @出视频 sentence; older drafts used videoExpert alone. */
  videoMode?: 'simple' | 'expert'
}

/** Admit only bounded input controls before saving or restoring them. */
export function isMarketTaskDraft(value: unknown): value is MarketTaskDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (typeof row.goal !== 'string' || row.goal.length > 16384
    || !row.params || typeof row.params !== 'object' || Array.isArray(row.params)) return false
  if (row.inputMode !== undefined && row.inputMode !== 'inline' && row.inputMode !== 'files') return false
  if (row.videoExpert !== undefined && typeof row.videoExpert !== 'boolean') return false
  if (row.videoMode !== undefined && row.videoMode !== 'simple' && row.videoMode !== 'expert') return false
  if (row.videoMode !== undefined && row.videoExpert !== undefined
    && row.videoExpert !== (row.videoMode === 'expert')) return false
  if (row.videoAnswers !== undefined) {
    if (row.videoAnswers === null || typeof row.videoAnswers !== 'object' || Array.isArray(row.videoAnswers)) return false
    const answers = row.videoAnswers as Record<string, unknown>
    if (Object.keys(answers).some(key => ![
      'subject', 'motion', 'style', 'purpose', 'story', 'storyboard', 'sound', 'camera', 'avoid', 'duration',
    ].includes(key))
      || ['subject', 'motion', 'style'].some(key => typeof answers[key] !== 'string'
        || (answers[key]).length > 200)
      || ['purpose', 'sound', 'camera', 'avoid', 'duration'].some(key => answers[key] !== undefined
        && (typeof answers[key] !== 'string' || (answers[key] as string).length > 200))
      || ['story', 'storyboard'].some(key => answers[key] !== undefined
        && (typeof answers[key] !== 'string' || (answers[key] as string).length > 600))) return false
  }
  const params = Object.entries(row.params)
  if (row.files !== undefined) {
    if (!Array.isArray(row.files) || row.files.length > 15) return false
    try {
      const files = row.files.map(marketInputFile)
      if (files.reduce((sum, file) => sum + file.bytes, 0) > 16 * 1024 * 1024
        || new Set(files.map(file => file.objectKey)).size !== files.length) return false
    } catch { return false }
  }
  if (params.length > 32 || params.some(([key, item]) =>
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)
    || (typeof item !== 'boolean' && (typeof item !== 'string' || item.length > 16384)))) return false
  let nodes = 0
  const walk = (item: unknown, depth: number): boolean => {
    if (++nodes > 2048 || depth > 6) return false
    if (item === null || typeof item === 'boolean') return true
    if (typeof item === 'string') return item.length <= 16384
    if (Array.isArray(item)) return item.length <= 128 && item.every(child => walk(child, depth + 1))
    if (!item || typeof item !== 'object') return false
    const entries = Object.entries(item)
    return entries.length <= 32 && entries.every(([key, child]) =>
      /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(key)
      && !['__proto__', 'constructor', 'prototype'].includes(key) && walk(child, depth + 1))
  }
  if (!walk(row.input, 0)) return false
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024
}
