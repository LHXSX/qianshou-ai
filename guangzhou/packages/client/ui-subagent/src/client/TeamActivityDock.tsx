import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { NS } from './locales.ts'
import { loadTeamDismissals, reconcileTeamDismissals, saveTeamDismissals, teamRecordVersion, type TeamDismissals } from './team-dismissals.ts'
import css from './TeamActivityDock.module.css'
import { TeamRemovalDialog } from './TeamRemovalDialog.tsx'
import { teamRemovalBlocker, type TeamRemovalTarget } from './team-removal.ts'

/** Service callbacks; the component consumes snapshots rather than remote transports. */
export interface TeamActivityDockInjected {
  observe: (parentId: SessionId) => () => void
  openChild: (address: SubagentAddress) => void
  removeChild: (address: SubagentAddress) => Promise<void>
  refresh: (parentId: SessionId) => void
}

/** Session-scoped compact monitor mounted beside conversation utilities. */
export type TeamActivityDockProps = PropsRuntime<'conversation.session.sidepanel'>
  & PropsLocale<typeof NS> & TeamActivityDockInjected

/**
 * Auto-reveal newly delegated work while preserving a visible collapsed status rail.
 * @param props - Current session mirrors and catalog/navigation callbacks.
 * @returns A small right-side monitor backed only by real session/catalog facts.
 */
export function TeamActivityDock({ sessionId, compact, useSessions, observe, openChild, removeChild, refresh, t }: TeamActivityDockProps) {
  const summaries = useSessions(state => state.byId)
  const catalogs = useSessions(state => state.subagentsByParent)
  const phase = useSessions(state => state.phase)
  const [removal, setRemoval] = useState<TeamRemovalTarget>()
  const removalState = { phase, byId: summaries, subagentsByParent: catalogs }
  const [expanded, setExpanded] = useState(false)
  const [unread, setUnread] = useState(false)
  const panelId = useId()
  const rail = useRef<HTMLButtonElement>(null)
  const collapseButton = useRef<HTMLButtonElement>(null)
  const focusAfterToggle = useRef<'panel' | 'rail' | null>(null)
  const seen = useRef(new Map<string, boolean>())
  const activeRoot = useRef<SessionId | undefined>(undefined)
  const rootId = useMemo(() => {
    let current = sessionId
    const visited = new Set<SessionId>()
    while (!visited.has(current)) {
      visited.add(current)
      const entry = summaries[current]
      if (entry?.origin !== 'subagent' || entry.parentId === undefined) break
      current = entry.parentId
    }
    return current
  }, [sessionId, summaries])
  const [history, setHistory] = useState<{ rootId: string; entries: TeamDismissals }>(
    () => ({ rootId, entries: loadTeamDismissals(rootId) }))
  const [historySaveFailed, setHistorySaveFailed] = useState(false)
  const [lastDismissed, setLastDismissed] = useState<readonly (readonly [string, string])[]>([])
  const hidden = history.rootId === rootId ? history.entries : new Map<string, string>()
  useEffect(() => {
    setHistory({ rootId, entries: loadTeamDismissals(rootId) }); setLastDismissed([]); setHistorySaveFailed(false)
  }, [rootId])
  const catalog = catalogs[rootId]
  const rows = useMemo(() => {
    const known = new Map((catalog?.entries ?? []).flatMap(entry => entry.kind === 'child'
      ? [[entry.id, entry] as const] : []))
    for (const summary of Object.values(summaries)) {
      if (summary.origin !== 'subagent' || summary.parentId !== rootId || known.has(summary.id)) continue
      // A summary proves work exists, but not its continuation mode: show it
      // without an Open action until the authoritative catalog supplies one.
      known.set(summary.id, { kind: 'child', id: summary.id, label: summary.displayTitle,
        mode: 'one-shot', activity: summary.running ? 'running' : 'inactive', hasChildren: false })
    }
    return [...known.values()].map(entry => ({
      entry, summary: summaries[entry.id],
      running: summaries[entry.id]?.running ?? entry.activity === 'running',
      version: teamRecordVersion(summaries[entry.id]),
      addressKnown: catalog?.entries.some(c => c.kind === 'child' && c.id === entry.id) ?? false,
    })).sort((a, b) => Number(b.running) - Number(a.running)
      || (b.summary?.updatedAt ?? 0) - (a.summary?.updatedAt ?? 0))
  }, [catalog, summaries, rootId])
  const running = rows.filter(row => row.running).length
  const visibleRows = rows.filter(row => row.running || row.version === undefined || hidden.get(row.entry.id) !== row.version)
  const hiddenCount = rows.length - visibleRows.length
  const canDismiss = (row: typeof rows[number]) => phase === 'ready' && !row.running && row.version !== undefined
    && !['thinking', 'tools', 'blocked'].includes(row.summary?.projectionValues?.employeeActivity?.phase ?? 'idle')
  const finishedRows = visibleRows.filter(canDismiss)
  const commitHistory = (entries: TeamDismissals) => {
    setHistory({ rootId, entries }); setHistorySaveFailed(!saveTeamDismissals(rootId, entries))
  }
  const dismiss = (candidates: readonly (typeof rows[number])[]) => {
    const selected = candidates.filter(canDismiss).flatMap(row => row.version === undefined ? [] : [[row.entry.id, row.version] as const])
    if (selected.length === 0) return
    const next = new Map(hidden); for (const [id, version] of selected) next.set(id, version)
    setLastDismissed(selected); commitHistory(next)
    collapseButton.current?.focus({ preventScroll: true })
  }
  const undoAvailable = lastDismissed.some(([id, version]) => hidden.get(id) === version)
  useEffect(() => {
    if (history.rootId !== rootId || phase !== 'ready') return
    const next = reconcileTeamDismissals(history.entries,
      rows.map(row => ({ id: row.entry.id, running: row.running, version: row.version })))
    if (next !== history.entries) {
      setHistory({ rootId, entries: next }); setHistorySaveFailed(!saveTeamDismissals(rootId, next))
    }
  }, [history, phase, rootId, rows])
  const collapse = () => {
    focusAfterToggle.current = 'rail'
    setExpanded(false)
    setUnread(false)
  }
  const expand = () => {
    focusAfterToggle.current = 'panel'
    setExpanded(true)
    setUnread(false)
  }
  useLayoutEffect(() => {
    if (focusAfterToggle.current === null) return
    const target = focusAfterToggle.current === 'rail' ? rail.current : collapseButton.current
    target?.focus({ preventScroll: true })
    focusAfterToggle.current = null
  }, [expanded])
  useEffect(() => observe(rootId), [observe, rootId])
  useEffect(() => {
    if (activeRoot.current !== rootId) {
      activeRoot.current = rootId
      seen.current.clear()
      setExpanded(false)
      setUnread(false)
    }
    let newWork = false
    let completion = false
    for (const row of rows) {
      const wasRunning = seen.current.get(row.entry.id)
      if (row.running && wasRunning !== true) newWork = true
      if (wasRunning === true && !row.running) completion = true
      seen.current.set(row.entry.id, row.running)
    }
    if (newWork) {
      if (compact) setUnread(true)
      else { setExpanded(true); setUnread(false) }
    }
    else if (completion) setUnread(true)
  }, [rows, rootId, compact])
  if (rows.length === 0 && hidden.size === 0 && catalog?.state !== 'error') return null
  const content = <>
    <aside id={panelId} hidden={!expanded} className={css.panel} aria-label={t('dock.title')}
      data-team-dock={expanded ? 'expanded' : undefined}
      data-compact={compact || undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        collapse()
      }}>
      <header className={css.header}>
        <span className={css.emblem} aria-hidden="true">✦</span>
        <div><strong>{t('dock.title')}</strong><span>{t('dock.summary', { count: running, total: visibleRows.length })}</span></div>
        <button ref={collapseButton} type="button" className={css.iconButton} aria-label={t('dock.collapse')}
          aria-expanded="true" aria-controls={panelId} onClick={collapse}>›</button>
      </header>
      <p className={css.hint}>{t('dock.hint')}</p>
      {phase !== 'ready' && <p className={css.notice}>{t('dock.reconnecting')}</p>}
      {catalog?.state === 'error' && <button type="button" className={css.retry}
        onClick={() => { refresh(rootId) }}>{t('dock.retry')}</button>}
      <div className={css.rows}>
        {visibleRows.length === 0 && <p className={css.empty}>{t('dock.empty')}</p>}
        {visibleRows.map((row) => {
          const { entry, summary, running: busy, addressKnown } = row
          const address: SubagentAddress = { parentSessionId: rootId, childSessionId: entry.id, mode: entry.mode }
          const removalBlocked = teamRemovalBlocker(address, removalState)
          const activity = summary?.projectionValues?.employeeActivity
          const route = summary?.projectionValues?.modelSelection?.lastUsed
          const usage = summary?.projectionValues?.tokenUsage
          const input = usage ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0
          const total = usage ? input + usage.outputTokens : undefined
          const totalLabel = total === undefined ? undefined
            : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(total)
          const state = busy ? (activity?.phase === 'tools' ? 'tools' : 'thinking') : activity?.phase ?? 'idle'
          const toolNames = activity ? Object.values(activity.tools).slice(0, 3).join(' · ') : ''
          return <article className={css.card} key={entry.id} data-active={busy || undefined}>
            <div className={css.cardTop}>
              <span className={css.avatar} aria-hidden="true">{(entry.label ?? summary?.displayTitle ?? '·').slice(0, 1)}</span>
              <strong title={entry.label ?? entry.id}>{entry.label ?? summary?.displayTitle ?? entry.id}</strong>
              {canDismiss(row) && <button type="button" className={css.dismiss} title={t('dock.dismissHint')}
                aria-label={t('dock.dismissLabel', { label: entry.label ?? summary?.displayTitle ?? entry.id })}
                onClick={() => { dismiss([row]) }}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>}
            </div>
            <div className={css.status}><span className={css.dot} data-state={state} aria-hidden="true" /><span>{t(`dock.phase.${state}`)}</span>{toolNames && <code>{toolNames}</code>}</div>
            {activity?.update && <p className={css.update}>{activity.update}</p>}
            {totalLabel !== undefined && <div className={css.usage} title={t('dock.usageHint')}>
              {t('dock.tokens', { count: totalLabel })}
              {input > 0 && usage && <span>{t('dock.cache', { percent: Math.round(100 * usage.cacheReadTokens / input) })}</span>}
            </div>}
            <footer className={css.cardFooter}>
              <span title={route ? `${route.provider} / ${route.model}` : undefined}>
                {route ? `${route.provider} / ${route.model}` : t('dock.routePending')}
              </span>
              <button type="button" disabled={!addressKnown || removalBlocked !== undefined}
                title={t(removalBlocked === undefined ? 'remove.short' : `remove.blocked.${removalBlocked}`)}
                aria-label={t('remove.label', { label: entry.label ?? summary?.displayTitle ?? entry.id })}
                onClick={() => { setRemoval({ address, label: entry.label ?? summary?.displayTitle ?? entry.id }) }}>
                {t('remove.short')}
              </button>
              <button type="button" disabled={!addressKnown} onClick={() => {
                openChild({ parentSessionId: rootId, childSessionId: entry.id, mode: entry.mode })
              }}>{t('dock.details')} ↗</button>
            </footer>
          </article>
        })}
      </div>
      <div className={css.footer}>
        <div className={css.footerLine}><span role="status">{unread ? t('dock.updated') : t('dock.live')}</span>
          {finishedRows.length > 0 && <button type="button" onClick={() => { dismiss(finishedRows) }}>{t('dock.clearFinished')}</button>}
        </div>
        {(hidden.size > 0 || undoAvailable) && <div className={css.historyActions}>
          <button type="button" onClick={() => { commitHistory(new Map()); setLastDismissed([]) }}>{t('dock.restoreHidden', { count: hiddenCount || hidden.size })}</button>
          {undoAvailable && <button type="button" onClick={() => {
            const next = new Map(hidden)
            for (const [id, version] of lastDismissed) if (next.get(id) === version) next.delete(id)
            commitHistory(next); setLastDismissed([])
          }}>{t('dock.undoDismiss')}</button>}
        </div>}
        {historySaveFailed && <p className={css.saveFailure} role="alert">{t('dock.historySaveFailed')}</p>}
      </div>
    </aside>
    {!expanded && (
      <button ref={rail} type="button" className={css.rail} data-team-dock="collapsed" data-unread={unread || undefined}
        aria-expanded="false" aria-controls={panelId}
        aria-label={t('dock.expand', { count: running, total: visibleRows.length })} onClick={expand}>
        <span aria-hidden="true">✦</span><strong>{running}</strong><small>{t('dock.working')}</small>
        {unread && <i aria-label={t('dock.updated')} />}
      </button>)}
  </>
  return <>{content}{removal !== undefined && <TeamRemovalDialog key={removal.address.childSessionId}
    target={removal} blocked={teamRemovalBlocker(removal.address, removalState)} removeChild={removeChild}
    onClose={() => { setRemoval(undefined); collapseButton.current?.focus({ preventScroll: true }) }} t={t} />}</>
}
