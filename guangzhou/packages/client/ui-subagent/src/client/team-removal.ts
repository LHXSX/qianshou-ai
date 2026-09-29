/** Known client activity checks for durable team removal; the Host rechecks the complete subtree. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** The selected team branch and its user-visible identity. */
export interface TeamRemovalTarget {
  readonly address: SubagentAddress
  readonly label: string
}

/** Client evidence that removal cannot currently be offered. */
export type TeamRemovalBlocker = 'busy' | 'sync' | 'unavailable'

/**
 * Translate expected Host refusal codes, including work admitted after confirmation opened.
 * @param failure - rejected RPC failure or transport error.
 * @param t - owning locale translator.
 * @returns the actionable failure shown without closing the confirmation.
 */
export function teamRemovalErrorText(failure: unknown, t: TranslateNS<typeof NS>): string {
  const code = typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : undefined
  if (code === 'subagent/busy') return t('remove.racedBusy')
  if (code === 'subagent/retired') return t('remove.alreadyRetired')
  if (code === 'subagent/parent-unavailable') return t('remove.parentUnavailable')
  if (code === 'subagent/retirement-unavailable') return t('remove.blocked.unavailable')
  if (code === 'subagent/unauthorized') return t('remove.unauthorized')
  return failure instanceof Error ? `${t('remove.failed')} ${failure.message}` : t('remove.failed')
}

/**
 * Reject known active descendants and stale membership before showing a confirmation.
 * @param target - exact direct-parent address from the authoritative catalog.
 * @param state - current session/catalog snapshot.
 * @returns a visible blocking reason, or undefined when the Host may check removal.
 */
export function teamRemovalBlocker(
  target: SubagentAddress,
  state: Pick<SessionListState, 'phase' | 'byId' | 'subagentsByParent'>,
): TeamRemovalBlocker | undefined {
  const parent = state.subagentsByParent[target.parentSessionId]
  if (state.phase !== 'ready' || parent?.state !== 'ready') return 'sync'
  const root = parent.entries.find(entry => entry.kind === 'child' && entry.id === target.childSessionId)
  if (root?.kind !== 'child') return 'sync'
  if (root.retireBlocked !== undefined) return root.retireBlocked
  const pending = [target.childSessionId]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const id = pending.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const summary = state.byId[id]
    if (summary?.running) return 'busy'
    for (const catalog of Object.values(state.subagentsByParent)) {
      if (catalog.entries.some(entry => entry.kind === 'child' && entry.id === id && entry.activity === 'running')) return 'busy'
    }
    for (const child of state.subagentsByParent[id]?.entries ?? []) if (child.kind === 'child') pending.push(child.id)
    for (const child of Object.values(state.byId)) if (child.origin === 'subagent' && child.parentId === id) pending.push(child.id)
  }
  return undefined
}
