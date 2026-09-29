// @vitest-environment jsdom
/**
 * C27 regression: the right-column 「子代理任务」 panel must be visually still on a
 * static tree.
 *
 * The harness reproduces the real Session Controller catalog contract instead of
 * stubbing it: every `refreshSubagents` publishes an intermediate
 * `state: 'loading'` snapshot before the authoritative answer lands
 * (`session-controller/src/client/sessions/manager.ts` `refreshSubagents`), and
 * every publication replaces the catalog object, so each subscriber selecting it
 * re-renders. `useSessions` is bound the way the client stack binds it
 * (`ui-renderer/src/client/bind.ts`): a component re-renders only when the
 * SELECTED value changes identity.
 *
 * Catalog reads are held open as explicit deferreds so the test controls the
 * loading→ready interleaving exactly; nothing here depends on timer jitter.
 * These assertions are the工包 acceptance criterion: advancing wall-clock time
 * over an unchanging tree must add no render, no DOM mutation, and no visible
 * re-entry into the loading state.
 */
import { Profiler, useSyncExternalStore, type ProfilerOnRenderCallback } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentTaskList, AgentTasks, resetDismissedTasks, type AgentTaskActions, type AgentTasksProps } from '../src/client/AgentTasks.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  resetDismissedTasks()
})

interface ChildEntry {
  kind: 'child'
  id: string
  label: string
  mode: 'one-shot' | 'continuable'
  activity: 'running' | 'inactive'
  hasChildren: boolean
}
type Entry = ChildEntry | { kind: 'diagnostic'; id: string; reason: string }
interface CatalogSnapshot {
  entries: Entry[]
  parentAvailable: boolean
  state: 'loading' | 'ready' | 'error'
  error: null
}
interface Row {
  running: boolean
  blank: boolean
  parentId?: string
  origin?: 'subagent'
  projectionValues?: { agentPreset?: string }
}
interface ListState {
  byId: Record<string, Row>
  subagentsByParent: Record<string, CatalogSnapshot>
}

/**
 * The Sessions snapshot subset the panel reads, with the manager's
 * object-identity rules: `subagentsByParent` is rebuilt per dirty notification
 * while an untouched catalog keeps its identity.
 */
function sessionsSource() {
  const catalogs = new Map<string, CatalogSnapshot>()
  const inflight = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()
  const outstanding: Array<() => void> = []
  let byId: Record<string, Row> = {}
  let durable: Record<string, Entry[]> = {}
  let state: ListState = { byId, subagentsByParent: {} }

  const markDirty = (): void => {
    state = { byId, subagentsByParent: Object.fromEntries(catalogs) }
    for (const listener of [...listeners]) listener()
  }
  /** A fresh answer with fresh object identities, exactly like one remote read. */
  const answer = (parent: string): Entry[] => (durable[parent] ?? []).map(entry => ({ ...entry }))

  return {
    /** Catalog reads started and not yet answered. */
    get outstandingReads(): number { return outstanding.length },
    /** Mirrors `SessionManager.refreshSubagents`, including the loading publication. */
    refreshSubagents(parent: string): Promise<void> {
      const existing = inflight.get(parent)
      if (existing !== undefined) return existing
      const previous = catalogs.get(parent)
      catalogs.set(parent, {
        entries: previous?.entries ?? [],
        parentAvailable: previous?.parentAvailable ?? true,
        state: 'loading',
        error: null,
      })
      markDirty()
      const operation = new Promise<void>((resolve) => {
        outstanding.push(() => {
          catalogs.set(parent, { entries: answer(parent), parentAvailable: true, state: 'ready', error: null })
          inflight.delete(parent)
          markDirty()
          resolve()
        })
      })
      inflight.set(parent, operation)
      return operation
    },
    /** Answer every catalog read the Host has received, and nothing more. */
    answerReads(): void {
      for (const answerOne of outstanding.splice(0)) answerOne()
    },
    /** Current published catalog state for one parent. */
    catalogState(parent: string): CatalogSnapshot['state'] | undefined {
      return catalogs.get(parent)?.state
    },
    getSnapshot: (): ListState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setRows(rows: Record<string, Row>): void { byId = rows },
    setDurable(parent: string, entries: Entry[]): void { durable = { ...durable, [parent]: entries } },
  }
}

type Host = ReturnType<typeof sessionsSource>

/** The exact binding `bindSnapshotSelector` produces: re-render on selected-value change. */
function selectorHook(host: Host) {
  const subscribe = (listener: () => void): (() => void) => host.subscribe(listener)
  const getSnapshot = (): ListState => host.getSnapshot()
  return function useSessions<S>(select: (snapshot: ListState) => S): S {
    return useSyncExternalStore(subscribe, () => select(getSnapshot()))
  }
}

const CHILD: ChildEntry = {
  kind: 'child', id: 'child-1', label: '界面专家 · 设计工作台',
  mode: 'continuable', activity: 'inactive', hasChildren: false,
}

interface Probe {
  readonly commits: number
  readonly mutationRecords: number
  readonly view: ReturnType<typeof render>
  readonly host: Host
}

/** Mount the header entry point and the docked panel together, as the plugin does. */
async function mountPanel(options: { child?: ChildEntry; parentRunning?: boolean } = {}): Promise<Probe> {
  const host = sessionsSource()
  host.setRows({ parent: { running: options.parentRunning ?? true, blank: false } })
  host.setDurable('parent', [options.child ?? CHILD])

  const counters = { commits: 0, mutationRecords: 0 }
  const onRender: ProfilerOnRenderCallback = () => { counters.commits += 1 }
  const actions = {
    // `observe` is the host's `setSubagentCatalogOpen`: it starts a catalog read
    // and owns the live membership push for that parent.
    observe: vi.fn((parent: string, open: boolean) => { if (open) void host.refreshSubagents(parent) }),
    refresh: vi.fn((parent: string) => { void host.refreshSubagents(parent) }),
    openAside: vi.fn(), openTasks: vi.fn(), openChanges: vi.fn(),
    collapseTasks: vi.fn(), dispatch: vi.fn(), close: vi.fn(),
  } as unknown as AgentTaskActions
  const props = {
    sessionId: 'parent', useSessions: selectorHook(host), t: makeTranslate(zh), ...actions,
  } as unknown as AgentTasksProps

  // The retained-changes reader polls a Host endpoint; hold its payload constant
  // so the tree under measurement never gains new content.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ available: true, entries: [] }),
  })))

  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<>
      <AgentTasks {...props} />
      <Profiler id="qianshou-task-panel" onRender={onRender}>
        <AgentTaskList {...props} close={vi.fn()} />
      </Profiler>
    </>)
  })
  const observer = new MutationObserver((records) => { counters.mutationRecords += records.length })
  observer.observe(view.container, { childList: true, subtree: true, attributes: true, characterData: true })
  return {
    get commits() { return counters.commits },
    get mutationRecords() { return counters.mutationRecords },
    view, host,
  }
}

/** Advance the fake clock and let React commit plus jsdom deliver observer records. */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await act(async () => { await Promise.resolve() })
}

/**
 * Load until the panel's own post-load bookkeeping settles.
 * The panel re-reads the catalog once when the arrived membership changes the
 * signature it derives, so convergence — not a fixed round count — is the exit.
 */
async function loadInitially(probe: Probe): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await advance(0)
    if (probe.host.outstandingReads === 0 && probe.host.catalogState('parent') === 'ready') return
    await act(async () => { probe.host.answerReads() })
  }
  throw new Error('the catalog never converged to a loaded state')
}

describe('C27 · the task panel is visually still on a static tree', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('adds no render and no DOM mutation in each of five idle seconds', async () => {
    const probe = await mountPanel()
    await loadInitially(probe)
    expect(probe.view.getByText(/运行状态：/)).toBeTruthy()

    const perSecond: Array<[commits: number, mutations: number]> = []
    for (let second = 0; second < 5; second += 1) {
      const commits = probe.commits
      const mutations = probe.mutationRecords
      await advance(1_000)
      await act(async () => { probe.host.answerReads() })
      await advance(0)
      perSecond.push([probe.commits - commits, probe.mutationRecords - mutations])
    }

    // `[renders, DOM mutations]` per idle second; a regression reports its own numbers.
    expect(perSecond).toEqual([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]])
  })

  it('never re-enters the loading state over rows it already loaded', async () => {
    const probe = await mountPanel()
    await loadInitially(probe)
    expect(probe.view.getByText(/运行状态：/)).toBeTruthy()
    expect(probe.view.queryByText('正在读取任务…')).toBeNull()

    // One second of idle wall clock: whatever the panel does, its loaded list
    // must stay on screen with no reload notice.
    await advance(1_000)
    const flashes = probe.view.queryByText('正在读取任务…') === null ? 0 : 1
    // The read the poll started (if any) is then answered.
    await act(async () => { probe.host.answerReads() })
    await advance(0)

    // A non-zero flash count means a background re-read still blanks the list.
    expect(flashes).toBe(0)
    expect(probe.view.getByText(/运行状态：/)).toBeTruthy()
  })

  it('keeps loaded rows on screen while an explicit refresh is in flight', async () => {
    const probe = await mountPanel()
    await loadInitially(probe)

    // A membership push or the footer's 刷新 starts a real re-read; the Host
    // answers it only after the panel has had a chance to publish `loading`.
    await act(async () => { void probe.host.refreshSubagents('parent') })
    await advance(0)
    expect(probe.view.queryByText('正在读取任务…')).toBeNull()
    expect(probe.view.getByText(/运行状态：/)).toBeTruthy()

    await act(async () => { probe.host.answerReads() })
    await advance(0)
    expect(probe.view.queryByText('正在读取任务…')).toBeNull()
    expect(probe.view.getByText(/运行状态：/)).toBeTruthy()
  })
})
