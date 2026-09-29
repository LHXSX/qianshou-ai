/**
 * Derivation of the forge destination pages' live facts.
 *
 * Every value here comes from a service the client already runs — the session
 * list mirror (`ctx.sessions`), the per-session model directory
 * (`ctx.modelDirectories`) and the layout action face (`ctx.layout`). Nothing is
 * counted, guessed or cached: an empty list means the client really sees no
 * row, and a missing service means the page says "not connected" instead of
 * filling the gap with a plausible number.
 *
 * The mapping is a pure function so it is testable without mounting a slot; the
 * React binding only wires it into the injected `liveState` hook.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {
  JobFact, ModelFacts, ModelRouteFact, PageState, ProviderFact, SessionFacts, SubagentFact,
} from './page-chrome.tsx'

/** Bounded render caps: the pages summarize, they are not tables. */
const MAX_SUBAGENTS = 8
const MAX_JOBS = 6
const MAX_MODELS_PER_PROVIDER = 8
const MAX_PROVIDERS = 8

/** The store slice a page binds; `ModelDirectory.store` satisfies it exactly. */
export interface DirectoryStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ModelDirectoryState
}

/** Snapshot the merged page state reads; both sources are optional. */
export interface DestinationLiveSnapshot {
  list: SessionListState | undefined
  directory: ModelDirectoryState | undefined
  /** False when the deployment exposes no model-directory resolver at all. */
  directoryMounted: boolean
}

/** What the merged observable returns before any source is available. */
const EMPTY_SNAPSHOT: DestinationLiveSnapshot = { list: undefined, directory: undefined, directoryMounted: false }

/**
 * The one observable the destination pages bind through their injected
 * `useLiveState` hook.
 */
export interface DestinationObservable {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => DestinationLiveSnapshot
}

/** Hooks compartment of the destination pages' injected face. */
export interface DestinationHooks {
  liveState: DestinationObservable
}

/** The right-sidebar navigation slice a page action needs. */
interface SidebarRightFace {
  openTab: (kind: string) => void
}

/** Finite navigation actions the destination pages offer. */
export interface DestinationActions {
  /** Select the conversation main panel. */
  openChat: () => void
  /** Select a registered main panel by key. */
  openPanel: (panel: string | null) => () => void
  /** Open the right sidebar's Files tab; returns the refusal reason, or undefined. */
  openFiles: () => string | undefined
  /** Continue one subagent conversation; a no-op when its service is not mounted. */
  openSession: (id: string) => void
}

/** Injected face of every destination page: one hook plus the real actions. */
export type DestinationFace = { hooks: DestinationHooks } & DestinationActions

/**
 * View-side injected share: every member is real in a mounted deployment and
 * absent in a bare unit mount, which is exactly what the optional typing says.
 */
export interface DestinationsInjected {
  useLiveState?: DestinationHook | undefined
  openChat?: (() => void) | undefined
  openPanel?: ((panel: string | null) => () => void) | undefined
  openFiles?: (() => string | undefined) | undefined
  openSession?: ((id: string) => void) | undefined
}

/** The page's own view of the injected selector hook. */
export type DestinationHook = (
  selector: (snapshot: DestinationLiveSnapshot) => DestinationLiveSnapshot,
) => DestinationLiveSnapshot

/**
 * Build the pages' injected face from the live client services. Called once per
 * plugin load: a fresh face per inject call would change the hook identity on
 * every render and restart the mount effect forever.
 * @param ctx - client root context owning the reflected services.
 * @returns the hooks compartment plus the finite navigation actions.
 */
export function createDestinationInjected(ctx: ClientContext): DestinationFace {
  const layoutOf = () => ctx.reflect.get('layout', false)
  const sessionsOf = () => ctx.reflect.get('sessions', false)
  // Reading the layout service (and selecting) happens inside the returned
  // callback, never while building the face: a render must not navigate.
  const openPanel = (panel: string | null) => () => {
    layoutOf()?.selectPanel(panel as never)
  }
  return {
    hooks: {
      liveState: createLiveObservable(
        sessionsOf(),
        ctx.reflect.get('modelDirectories', false),
      ),
    },
    openChat: openPanel(null),
    openPanel,
    openFiles: () => {
      const sidebar = ctx.reflect.get('sidebarRight', false) as SidebarRightFace | undefined
      if (sidebar === undefined) return 'sidebarRight service is not available'
      try {
        sidebar.openTab('files')
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    openSession: (id: string) => { sessionsOf()?.open(id as never) },
  }
}

/**
 * Merge the client's live sources into one observable for the destination pages.
 * @param sessions - the session-list mirror, absent when its plugin is missing.
 * @param modelDirectories - the per-session model resolver, absent likewise.
 * @returns a stable observable whose value is re-derived from the live sources.
 */
export function createLiveObservable(
  sessions: ISessions | undefined,
  modelDirectories: ClientContext['modelDirectories'] | undefined,
): DestinationObservable {
  const listeners = new Set<() => void>()
  let cached: DestinationLiveSnapshot = EMPTY_SNAPSHOT
  let dirty = true
  /** The directory store the cached value came from; a session switch rebinds it. */
  let current: DirectoryStore | undefined
  let offList: (() => void) | undefined
  let offDirectory: (() => void) | undefined
  const changed = (): void => {
    dirty = true
    for (const listener of listeners) listener()
  }
  return {
    subscribe: (listener) => {
      // Sources attach with the first consumer and detach with the last, so a
      // deployment that never opens a destination holds no subscription.
      if (listeners.size === 0) offList = sessions?.list.subscribe(changed)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size !== 0) return
        offList?.()
        offList = undefined
        offDirectory?.()
        offDirectory = undefined
      }
    },
    getSnapshot: () => {
      const list = sessions?.list.getSnapshot()
      const store = resolveStore(modelDirectories, list?.current)
      if (store !== current || (store !== undefined && offDirectory === undefined && listeners.size > 0)) {
        offDirectory?.()
        offDirectory = store !== undefined && listeners.size > 0 ? store.subscribe(changed) : undefined
        current = store
        dirty = true
      }
      if (!dirty) return cached
      // The resolved sources and the last value survive a detach, so a remount
      // renders the current facts instead of flashing the cold empty page.
      cached = { list, directory: store?.getSnapshot(), directoryMounted: modelDirectories !== undefined }
      dirty = false
      return cached
    },
  }
}

function resolveStore(
  resolver: ClientContext['modelDirectories'] | undefined,
  sessionId: string | undefined,
): DirectoryStore | undefined {
  if (resolver === undefined || sessionId === undefined) return undefined
  try {
    return resolver.directoryFor(sessionId as never).store
  } catch {
    // An unknown session resolves no scope; the page then states that the
    // directory is not readable rather than showing a stale one.
    return undefined
  }
}

/** Whether the session list has ever delivered a row (false ⇒ "still reading"). */
export function listIsReady(list: SessionListState | undefined): boolean {
  return list !== undefined && list.phase === 'ready'
}

/**
 * Project the merged snapshot into the four pages' read model.
 * @param snapshot - the observed sources, any of which may be absent.
 * @returns facts the pages can state without inventing anything.
 */
export function derivePageState(snapshot: DestinationLiveSnapshot): PageState {
  return {
    sessions: deriveSessions(snapshot.list),
    jobs: deriveJobs(snapshot.list),
    models: deriveModels(snapshot.directory ?? null),
  }
}

/**
 * Roster projection: a child row the browser can address, running work first.
 * The catalog is authoritative for continuation mode; the list mirror proves the
 * row exists and supplies the human-facing title the catalog may lack.
 * @param list - the session-list value, absent when the mirror is not mounted.
 * @returns bounded roster facts, never a placeholder row.
 */
export function deriveSessions(list: SessionListState | undefined): SessionFacts {
  if (list === undefined) return { currentId: null, subagents: [], runningCount: 0 }
  const currentId = list.current ?? null
  const known = new Map<string, SubagentFact>()
  for (const catalog of Object.values(list.subagentsByParent)) {
    for (const entry of catalog.entries) {
      if (entry.kind !== 'child') continue
      known.set(entry.id, {
        id: entry.id,
        // Continuable children always carry a label; a one-shot child may not.
        label: entry.label,
        kind: entry.mode === 'continuable' ? 'subagent' : 'one-shot',
        running: entry.activity === 'running',
        updatedAt: 0,
      })
    }
  }
  for (const summary of Object.values(list.byId)) {
    if (summary.origin !== 'subagent' || summary.id === currentId) continue
    const existing = known.get(summary.id)
    known.set(summary.id, existing === undefined
      // A row only the mirror knows: the session title is all the identity there is.
      ? { id: summary.id, label: summary.displayTitle, kind: 'one-shot',
        running: summary.running, updatedAt: summary.updatedAt }
      // A row the catalog described: it owns the continuation mode, and its own
      // label wins over the session title whenever it carried one.
      : { ...existing, label: existing.label || summary.displayTitle,
        running: summary.running || existing.running, updatedAt: summary.updatedAt })
  }
  const subagents = [...known.values()]
    .sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_SUBAGENTS)
  return { currentId, subagents, runningCount: subagents.filter(entry => entry.running).length }
}

/**
 * Background-process projection, running work first and bounded for the panel.
 * @param list - the session-list value, absent when the mirror is not mounted.
 * @returns the host-reported processes across every visible session.
 */
export function deriveJobs(list: SessionListState | undefined): JobFact[] {
  if (list === undefined) return []
  const titles = new Map<string, string>()
  for (const summary of Object.values(list.byId)) titles.set(summary.id, summary.displayTitle)
  const jobs: JobFact[] = []
  for (const [sessionId, sessionJobs] of Object.entries(list.jobsBySession)) {
    for (const job of sessionJobs as readonly SessionJob[]) {
      jobs.push({
        id: job.id,
        label: job.label || titles.get(sessionId) || sessionId,
        kind: job.kind,
        status: job.status,
        startedAt: job.startedAt,
      })
    }
  }
  return jobs.sort((a, b) => jobWeight(a) - jobWeight(b) || b.startedAt - a.startedAt).slice(0, MAX_JOBS)
}

/** Running work first, then work still stopping, then every settled record. */
function jobWeight(job: JobFact): number {
  return job.status === 'running' ? 0 : job.status === 'stopping' ? 1 : 2
}

/**
 * Provider projection from the session directory's host catalog.
 * @param directory - the current session's directory value, or null when none resolves.
 * @returns the providers that answered, the ones that failed, and the live route.
 */
export function deriveModels(directory: ModelDirectoryState | null): ModelFacts {
  if (directory === null) return { providers: [], failures: [], route: null, routed: null }
  const providers: ProviderFact[] = directory.groups.slice(0, MAX_PROVIDERS).map(group => ({
    id: group.id,
    name: group.name,
    models: group.models.slice(0, MAX_MODELS_PER_PROVIDER).map(model => ({ id: model.id, name: model.name })),
  }))
  const failures: ProviderFact[] = directory.failures.map(failure => ({
    id: failure.id, name: failure.name, models: [], message: failure.message,
  }))
  return { providers, failures, route: routeOf(directory.current), routed: directory.routable }
}

function routeOf(current: ModelDirectoryState['current']): ModelRouteFact | null {
  if (current === null) return null
  return { provider: current.provider, model: current.model, effort: current.reasoningEffort ?? null }
}
