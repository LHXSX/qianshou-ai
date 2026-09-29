/** CEO task navigation and a docked, session-backed specialist catalog. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import css from './AgentTasks.module.css'
import { ChildFileChanges } from './ChildFileChanges.tsx'
import { DelegationForm, type DelegationActions } from './DelegationForm.tsx'
import type { QianshouKey } from './locales.ts'

type HeaderRuntime = PropsRuntime<'conversation.session.header.actions'>
type SessionIdentity = HeaderRuntime['sessionId']

/** Address of an existing child; navigation never creates a task. */
export interface TaskAddress {
  parentSessionId: SessionIdentity
  childSessionId: SessionIdentity
  mode: 'one-shot' | 'continuable'
}

/** Host-backed catalog and dock navigation actions. */
export interface AgentTaskActions extends DelegationActions {
  observe: (parent: SessionIdentity, open: boolean) => void
  refresh: (parent: SessionIdentity) => void
  openAside: (address: TaskAddress) => void
  openTasks: (session: SessionIdentity, automatic?: boolean) => void
  openChanges: (address: string) => void
  collapseTasks: () => void
}

/** Shares used by the session-header entry point. */
export type AgentTasksProps = HeaderRuntime & PropsLocale<'qianshou.brand'> & AgentTaskActions

/**
 * One catalog-driven child row, narrowed to the fields this panel reports on.
 * `activity` is a live liveness sample rather than a durable outcome, so every
 * status the panel prints stays derived from it plus the session list.
 */
type CatalogChild = {
  kind: 'child'
  id: string
  activity: 'running' | 'inactive'
  mode: 'one-shot' | 'continuable'
}

/**
 * Parents whose task column is currently observing its catalog.
 *
 * The open column is the only consumer that calls `observe(parent, true)`, which
 * is also what subscribes the parent to the Host's live membership push. While
 * that subscription is live, the header's polling fallback below has nothing
 * left to discover, and every read it starts republishes a `loading` catalog
 * over rows the user is already reading.
 */
const observingColumns = new Map<SessionIdentity, number>()

/** Register one mounted task column as a catalog observer for its parent. */
function holdCatalogObservation(parent: SessionIdentity): () => void {
  observingColumns.set(parent, (observingColumns.get(parent) ?? 0) + 1)
  return () => {
    const remaining = (observingColumns.get(parent) ?? 1) - 1
    if (remaining > 0) observingColumns.set(parent, remaining)
    else observingColumns.delete(parent)
  }
}

/** Whether an open task column already owns the catalog subscription. */
function columnObserves(parent: SessionIdentity): boolean {
  return (observingColumns.get(parent) ?? 0) > 0
}

const DISMISSED_PREFIX = 'qianshou-dismissed-subagents:'
const EMPTY_DISMISSED: ReadonlySet<string> = new Set()
const dismissedSnapshots = new Map<string, ReadonlySet<string>>()
const dismissedListeners = new Set<() => void>()

/** Storage key for one parent's hidden child ids. */
function dismissedKey(parent: string): string {
  return `${DISMISSED_PREFIX}${parent}`
}

/** Child ids this browser has removed from the task list. */
function readDismissed(parent: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(dismissedKey(parent))
    if (raw === null) return EMPTY_DISMISSED
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EMPTY_DISMISSED
    const ids = parsed.filter((id): id is string => typeof id === 'string' && id !== '')
    return ids.length === 0 ? EMPTY_DISMISSED : new Set(ids)
  } catch {
    // A broken or blocked store leaves the list unfiltered for this load.
    return EMPTY_DISMISSED
  }
}

/** Cached dismissal set. `useSyncExternalStore` requires a stable snapshot. */
function dismissedSnapshot(parent: string): ReadonlySet<string> {
  const cached = dismissedSnapshots.get(parent)
  if (cached !== undefined) return cached
  const loaded = readDismissed(parent)
  dismissedSnapshots.set(parent, loaded)
  return loaded
}

/** Remember a dismissal set and tell every open task list. */
function publishDismissed(parent: string, next: ReadonlySet<string>): void {
  const current = dismissedSnapshot(parent)
  if (current.size === next.size && [...current].every(id => next.has(id))) return
  dismissedSnapshots.set(parent, next)
  try {
    if (next.size === 0) localStorage.removeItem(dismissedKey(parent))
    else localStorage.setItem(dismissedKey(parent), JSON.stringify([...next]))
  } catch {
    // The in-memory set still hides the row until the page is closed.
  }
  for (const listener of dismissedListeners) listener()
}

/** Subscribe to dismissal changes for `useSyncExternalStore`. */
function subscribeDismissed(listener: () => void): () => void {
  dismissedListeners.add(listener)
  return () => { dismissedListeners.delete(listener) }
}

/**
 * Drop remembered dismissals so one test cannot hide another test's rows.
 * @returns nothing.
 */
export function resetDismissedTasks(): void {
  dismissedSnapshots.clear()
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null && key.startsWith(DISMISSED_PREFIX)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // jsdom without storage has nothing to clear.
  }
  for (const listener of dismissedListeners) listener()
}

/** Hide one settled child. A later run of the same id puts it back. */
function dismissOne(parent: string, id: string): void {
  const next = new Set(dismissedSnapshot(parent))
  next.add(id)
  publishDismissed(parent, next)
}

/** Hide every child that is not running. */
function dismissSettled(parent: string, ids: readonly string[]): void {
  const next = new Set(dismissedSnapshot(parent))
  for (const id of ids) next.add(id)
  publishDismissed(parent, next)
}

/**
 * Dismissed ids for one parent. A running id is removed so live work stays visible.
 * @param parent - catalog parent session.
 * @param runningKey - sorted running child ids joined by `|`.
 * @returns the ids hidden from the list.
 */
function useDismissedIds(parent: string, runningKey: string): ReadonlySet<string> {
  const dismissed = useSyncExternalStore(
    subscribeDismissed,
    () => dismissedSnapshot(parent),
    () => dismissedSnapshot(parent),
  )
  useEffect(() => {
    const running = runningKey.split('|').filter(Boolean)
    if (running.length === 0) return
    const next = new Set(dismissedSnapshot(parent))
    let changed = false
    for (const id of running) {
      if (next.delete(id)) changed = true
    }
    if (changed) publishDismissed(parent, next)
  }, [parent, runningKey])
  return dismissed
}

/** Session fields this list can turn into a task excerpt. */
interface ExcerptRow {
  readonly id?: string
  readonly title?: string
  readonly displayTitle?: string
  readonly projectionValues?: object
}

/** Last non-empty turn-outline prompt, when the projection is present. */
function outlinePrompt(values: object | undefined): string {
  if (values === undefined || !('turnOutline' in values)) return ''
  const turns = (values as { turnOutline?: unknown }).turnOutline
  if (!Array.isArray(turns)) return ''
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const entry: unknown = turns[index]
    if (typeof entry !== 'object' || entry === null || !('prompt' in entry) || typeof entry.prompt !== 'string') continue
    const prompt = entry.prompt.trim()
    if (prompt !== '') return prompt
  }
  return ''
}

/** Text after a role separator, when the label itself carries the task. */
function taskHalf(label: string): string {
  const marker = label.indexOf('·')
  if (marker < 0) return ''
  const role = label.slice(0, marker).trim()
  const task = label.slice(marker + 1).trim()
  if (role === '' || task === '') return ''
  return task
}

/**
 * Task text that is not already the row title.
 * Prefers the child's first-prompt preview, then a distinct session title,
 * then the task half of a `角色 · 任务` label.
 * @param row - session summary for the child, when the list has one.
 * @param label - catalog creation label.
 * @returns the excerpt, or `''` when the label is the only text.
 */
function taskExcerpt(row: ExcerptRow | undefined, label: string): string {
  const prompt = outlinePrompt(row?.projectionValues)
  if (prompt !== '' && prompt !== label) return prompt
  const titled = (row?.displayTitle ?? row?.title ?? '').trim()
  if (titled !== '' && titled !== label && titled !== row?.id) return titled
  return taskHalf(label)
}

/** Split a role label so the task half is the body, not a second copy of the title. */
function taskHeading(label: string, excerpt: string): { title: string; body: string } {
  if (excerpt === '') return { title: label, body: '' }
  const marker = label.indexOf('·')
  if (marker >= 0 && label.slice(marker + 1).trim() === excerpt) {
    const role = label.slice(0, marker).trim()
    if (role !== '') return { title: role, body: excerpt }
  }
  return { title: label, body: excerpt }
}

/**
 * The one status this panel can evidence for a catalog child.
 * @param entry - catalog child row.
 * @param neverStarted - whether its session exists with an empty log.
 * @returns the dictionary key naming the child's actual state.
 */
function childStatus(entry: CatalogChild, neverStarted: boolean): QianshouKey {
  if (entry.activity === 'running') return 'running'
  if (neverStarted) return 'neverStarted'
  // A settled one-shot child is a read-only record; a settled continuable child
  // can still accept a follow-up. Neither is a claim of acceptance.
  return entry.mode === 'continuable' ? 'resumable' : 'finished'
}

/**
 * Open the task column on a new delegation or a child beginning another run.
 * Closing it does not cause unchanged running tasks to reopen it repeatedly.
 */
export function AgentTasks({ sessionId, useSessions, refresh, openTasks, t }: AgentTasksProps) {
  const parent = useSessions((state) => {
    const current = state.byId[sessionId]
    return current?.origin === 'subagent' ? current.parentId ?? sessionId : sessionId
  })
  const signature = useSessions((state) => {
    const children = new Map(Object.values(state.byId)
      .filter(row => row.origin === 'subagent' && row.parentId === parent)
      .map(row => [row.id, row.running] as const))
    // One-shot children may exist only in the parent catalog, not the root list.
    for (const entry of state.subagentsByParent[parent]?.entries ?? []) {
      if (entry.kind === 'child') children.set(entry.id, entry.activity === 'running')
    }
    return [...children].map(([id, running]) => `${id}:${running ? '1' : '0'}`).sort().join('|')
  })
  const parentRunning = useSessions(state => state.byId[parent]?.running === true)
  const ceo = useSessions(state => state.byId[parent]?.projectionValues?.agentPreset === 'qianshou-ceo')
  const previous = useRef<{ parent: SessionIdentity; rows: Map<string, boolean> }>()
  const rows = new Map(signature.split('|').filter(Boolean).map((value) => {
    const split = value.lastIndexOf(':')
    return [value.slice(0, split), value.slice(split + 1) === '1'] as const
  }))
  const runningKey = [...rows].flatMap(([id, running]) => running ? [id] : []).sort().join('|')
  const dismissed = useDismissedIds(parent, runningKey)
  const visibleCount = [...rows].filter(([id, running]) => running || !dismissed.has(id)).length
  const live = parentRunning || [...rows.values()].some(Boolean)
  useEffect(() => {
    refresh(parent)
    if (!live) return
    // A closed catalog has no membership push subscription. Refresh while work
    // is live so a later one-shot delegation can reveal the column again — but
    // yield to an open column, which already receives that push and would
    // otherwise have a `loading` catalog republished over its own rows once a
    // second.
    const timer = setInterval(() => {
      if (!columnObserves(parent)) refresh(parent)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [live, parent, refresh])
  useEffect(() => {
    const next = new Map(signature.split('|').filter(Boolean).map((value) => {
      const split = value.lastIndexOf(':')
      return [value.slice(0, split), value.slice(split + 1) === '1'] as const
    }))
    const before = previous.current?.parent === parent ? previous.current.rows : undefined
    const started = [...next].some(([id, running]) => before === undefined
      ? running : !before.has(id) || (running && !before.get(id)))
    previous.current = { parent, rows: next }
    refresh(parent)
    if (started) openTasks(sessionId, true)
  }, [parent, signature, refresh, openTasks, sessionId])
  // Only CEO mode exposes manual delegation. Other assistants should not spend
  // header space on an empty task column; a new task opens the column itself.
  if (visibleCount === 0 && !ceo) return null
  return <div className={css.root} data-qianshou-tasks>
    <button className={css.trigger} type="button" onClick={() => { openTasks(sessionId) }}>
      {t('tasks')}{visibleCount > 0 && <span>{visibleCount}</span>}
    </button>
  </div>
}

/** Catalog props kept independent of dock chrome for lifecycle checks. */
export type AgentTaskListProps = Pick<HeaderRuntime, 'sessionId' | 'useSessions'>
  & PropsLocale<'qianshou.brand'> & AgentTaskActions & { close: () => void }

/** Show authoritative task status inside a layout-owned column, never an overlay. */
export function AgentTaskList({
  sessionId, useSessions, observe, refresh, openAside, openChanges, close, dispatch, t,
}: AgentTaskListProps) {
  const parent = useSessions((state) => {
    const current = state.byId[sessionId]
    return current?.origin === 'subagent' ? current.parentId ?? sessionId : sessionId
  })
  const catalog = useSessions(state => state.subagentsByParent[parent])
  const ceo = useSessions(state => state.byId[parent]?.projectionValues?.agentPreset === 'qianshou-ceo')
  // Blank child sessions are the durable "created, never ran" bit. Selecting the
  // joined ids keys this re-render to that bit alone, not to every list update.
  const neverStarted = useSessions((state) => {
    const blank: string[] = []
    for (const row of state.subagentsByParent[parent]?.entries ?? []) {
      if (row.kind === 'child' && state.byId[row.id]?.blank === true) blank.push(row.id)
    }
    return blank.join('|')
  })
  const neverStartedIds = new Set(neverStarted.split('|').filter(Boolean))
  const [view, setView] = useState<'tasks' | 'dispatch'>('tasks')
  const entries = catalog?.entries ?? []
  const runningKey = entries
    .flatMap(entry => entry.kind === 'child' && entry.activity === 'running' ? [entry.id] : [])
    .sort()
    .join('|')
  const dismissed = useDismissedIds(parent, runningKey)
  const visible = entries.filter(entry => entry.kind !== 'child' || entry.activity === 'running' || !dismissed.has(entry.id))
  const settledIds = entries.flatMap(entry => entry.kind === 'child' && entry.activity !== 'running' ? [entry.id] : [])
  const canClear = settledIds.some(id => !dismissed.has(id))
  const excerpts = useSessions((state) => {
    const pairs: string[] = []
    for (const entry of state.subagentsByParent[parent]?.entries ?? []) {
      if (entry.kind !== 'child') continue
      pairs.push(entry.id, taskExcerpt(state.byId[entry.id], entry.label ?? ''))
    }
    return pairs.join('\u0000')
  })
  const excerptById = new Map<string, string>()
  const excerptParts = excerpts.split('\u0000')
  for (let index = 0; index + 1 < excerptParts.length; index += 2) {
    const id = excerptParts[index]
    const body = excerptParts[index + 1]
    if (id !== undefined && body !== undefined) excerptById.set(id, body)
  }
  // A refresh keeps its previous entries, so the loading notice belongs only to
  // the case with nothing to show yet; announcing it over a loaded list blanks
  // and refills the column once per background read.
  const loading = catalog === undefined || (catalog.state === 'loading' && entries.length === 0)
  useEffect(() => {
    const release = holdCatalogObservation(parent)
    observe(parent, true)
    return () => { observe(parent, false); release() }
  }, [parent, observe])
  return <section className={css.panel} role="region" aria-label={t('tasks')} data-qianshou-task-panel>
    <header><div><strong>{t('tasks')}</strong><p>{t('tasksSubtitle')}</p></div>
      <div className={css.headerActions}>
        <button type="button" className={css.clear} disabled={!canClear} onClick={() => { dismissSettled(parent, settledIds) }}>{t('clearFinished')}</button>
        <button type="button" className={css.dismiss} onClick={close} aria-label={t('close')}>×</button>
      </div></header>
    {ceo && <nav className={css.views} aria-label={t('taskViews')}>
      <button type="button" aria-pressed={view === 'tasks'} onClick={() => { setView('tasks') }}>{t('taskList')}</button>
      <button type="button" aria-pressed={view === 'dispatch'} onClick={() => { setView('dispatch') }}>{t('dispatchSettings')}</button>
    </nav>}
    <div className={css.scroll} aria-busy={catalog?.state === 'loading' || undefined}>
      {view === 'dispatch' && ceo
        ? <DelegationForm key={parent} parent={parent} dispatch={dispatch} t={t} />
        : <div className={css.body}>
          {catalog?.state === 'error' && <p role="alert">{t('tasksError')}</p>}
          {catalog?.parentAvailable === false && <p role="status">{t('parentUnavailable')}</p>}
          {loading
            ? <p role="status">{t('loading')}</p>
            : catalog.state === 'ready' && catalog.parentAvailable !== false && entries.length === 0
          && <div className={css.empty}><strong>{t('tasksEmpty')}</strong><p>{t('tasksEmptyHint')}</p></div>}
          {visible.map((entry, index) => {
            if (entry.kind === 'diagnostic') return <p key={`diagnostic-${String(index)}`} role="alert">{t('taskUnavailable')}</p>
            const label = entry.label ?? t('unnamedTask')
            const heading = taskHeading(label, excerptById.get(entry.id) ?? '')
            const running = entry.activity === 'running'
            return <article key={entry.id} className={css.task}>
              <div className={css.taskTop}>
                <button className={css.taskOpen} type="button"
                  onClick={() => { openAside({ parentSessionId: parent, childSessionId: entry.id, mode: entry.mode }) }}>
                  <span className={css.taskTitle}>{heading.title}</span>
                  {heading.body !== '' && <p className={css.taskBody}>{heading.body}</p>}
                  <span className={css.meta}>
                    <span className={css.status}><i data-running={running} />
                      {t('statusLabel')} {t(childStatus(entry, neverStartedIds.has(entry.id)))}</span>
                    <span className={css.status}>{t('modeLabel')} {t(entry.mode === 'continuable' ? 'continuable' : 'history')}</span>
                  </span>
                  <span className={css.open}>{t('openTask')}</span>
                </button>
                <button type="button" className={css.delete} disabled={running}
                  aria-label={running ? t('deleteRunning') : t('deleteTask')}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (running) return
                    dismissOne(parent, entry.id)
                  }}>{t('deleteTask')}</button>
              </div>
            </article>
          })}
          {visible.some(entry => entry.kind === 'child') && <ChildFileChanges parent={parent} entries={visible} open={openChanges} t={t} />}
        </div>}
    </div>
    <footer><span>{t('evidenceHint')}</span><button type="button" onClick={() => { refresh(parent) }}>{t('refresh')}</button></footer>
  </section>
}

/** Shares supplied to one docked task tab. */
export type AgentTaskPanelProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'qianshou.brand'> & AgentTaskActions

/** Bind the task catalog's close control to its owning dock tab. */
export function AgentTaskPanel(props: AgentTaskPanelProps) {
  const { tab } = props.useTabInfo()
  // The last tab already collapses the column. Collapse first so a stale
  // mounted binding cannot toggle that freshly closed column open again.
  return <AgentTaskList {...props} close={() => { props.collapseTasks(); tab.actions.close() }} />
}
