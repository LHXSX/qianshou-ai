/** Local display preferences; never deletes or changes a child conversation. */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

/** Hidden completed versions, indexed by child session id within one root conversation. */
export type TeamDismissals = ReadonlyMap<string, string>
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>
const PREFIX = 'qianshou.team-dismissals.v1.'
const MAX_RECORDS = 2000

function storage(): PreferenceStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

/**
 * Identify the observed task version so later work can return to the monitor.
 * @param summary - The real session summary, if currently available.
 * @returns The version fingerprint, or undefined when it cannot be established.
 */
export function teamRecordVersion(summary: SessionSummary | undefined): string | undefined {
  if (summary === undefined || !Number.isFinite(summary.updatedAt)) return undefined
  const activity = summary.projectionValues?.employeeActivity
  return JSON.stringify([summary.updatedAt, activity?.at ?? null, activity?.phase ?? null,
    summary.projectionValues?.subagentTiming?.settledMs ?? null])
}

/**
 * Load bounded, well-formed preferences for this root conversation.
 * @param rootId - Root conversation whose display choices are read.
 * @param target - Browser preference storage, replaceable for isolated verification.
 * @returns Stored versions, or an empty map if storage is unavailable or malformed.
 */
export function loadTeamDismissals(rootId: string, target = storage()): TeamDismissals {
  try {
    const raw = target?.getItem(PREFIX + encodeURIComponent(rootId))
    if (!raw || raw.length > 512_000) return new Map()
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.length > MAX_RECORDS) return new Map()
    return new Map(value.filter((entry): entry is [string, string] => Array.isArray(entry)
      && entry.length === 2 && typeof entry[0] === 'string' && entry[0].length <= 512
      && typeof entry[1] === 'string' && entry[1].length <= 256))
  } catch { return new Map() }
}

/**
 * Save this root's reversible display choices.
 * @param rootId - Root conversation whose display choices are written.
 * @param entries - Hidden completed task versions.
 * @param target - Browser preference storage, replaceable for isolated verification.
 * @returns Whether storage accepted the update; callers report failure inline.
 */
export function saveTeamDismissals(rootId: string, entries: TeamDismissals, target = storage()): boolean {
  if (target === undefined) return false
  try {
    target.setItem(PREFIX + encodeURIComponent(rootId), JSON.stringify([...entries].slice(-MAX_RECORDS)))
    return true
  } catch { return false }
}

/**
 * Retire hidden versions when work resumes or a newer task arrives.
 * @param entries - Current hidden versions.
 * @param rows - Actual observed session activity and version snapshots.
 * @returns The existing map when unchanged, otherwise the remaining hidden versions.
 */
export function reconcileTeamDismissals(
  entries: TeamDismissals,
  rows: readonly { readonly id: string; readonly running: boolean; readonly version: string | undefined }[],
): TeamDismissals {
  let next: Map<string, string> | undefined
  for (const row of rows) {
    const previous = entries.get(row.id)
    if (previous === undefined || (!row.running && (row.version === undefined || row.version === previous))) continue
    next ??= new Map(entries)
    next.delete(row.id)
  }
  return next ?? entries
}
