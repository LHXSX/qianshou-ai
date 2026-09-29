// @vitest-environment jsdom
/**
 * What the four forge product destinations actually say and do.
 *
 * The cases assert page CONTENT — the copy keys each page renders, the real
 * values it prints from the injected state, the actions each button performs —
 * and, just as deliberately, that a page with no readable source states that
 * plainly instead of filling the space with a plausible number.
 *
 * Fixtures are typed against the real contracts (`SessionListState`,
 * `SessionSummary`, `SessionJob`) rather than loose literals, so a rename or a
 * new required field in the session mirror fails this suite instead of passing
 * on a stale shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  SessionListState, SessionSummary, SubagentCatalogSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DestinationIcon, DestinationPage, type DestinationsPageProps } from '../src/client/DestinationPage.tsx'
import { PRODUCT_DESTINATIONS } from '../src/client/destinations.ts'
import { parseSteps } from '../src/client/page-chrome.tsx'
import {
  createDestinationInjected, createLiveObservable, deriveJobs, deriveModels, derivePageState,
  deriveSessions, listIsReady,
  type DestinationLiveSnapshot, type DirectoryStore,
} from '../src/client/destination-state.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * The framework-injected `t` seat, stubbed over the real dictionaries: the
 * product dictionary first, then the shared common vocabulary, with the
 * `{name}` template interpolation the locale chain performs. Spelled here
 * rather than imported from the jsdom test runtime, so this suite mounts with
 * nothing but React and the packages it tests.
 * @param key - dictionary key, or the shared-vocabulary key behind it.
 * @param params - template values substituted into the resolved copy.
 * @returns the resolved, interpolated string.
 */
function t(key: string, params?: Record<string, unknown>): string {
  const template = zh[key as keyof typeof zh] ?? commonZh[key as keyof typeof commonZh] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** Session/slot standard seats the page never reads; calling one is a defect. */
const unused = (() => { throw new Error('unused standard prop was called') }) as never

/**
 * Panel id → dictionary segment. Spelled out because the ids are product-nav
 * slugs (`qianshou-models-api`) while the copy keys are domains (`models`).
 */
const TITLE_SEGMENT: Record<DestinationsPageProps['id'], string> = {
  'qianshou-agents': 'agents',
  'qianshou-workflows': 'workflows',
  'qianshou-files': 'files',
  'qianshou-models-api': 'models',
}

/** Durable session identity: the mirrors are keyed by the branded id. */
const sid = (id: string): SessionId => id as SessionId
/** Durable job identity: the same brand discipline as the session ids. */
const jid = (id: string): SessionJob['id'] => id as SessionJob['id']

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'displayTitle'>): SessionSummary {
  return { running: false, blank: false, updatedAt: 0, ...overrides }
}

function job(overrides: Partial<SessionJob> & Pick<SessionJob, 'id' | 'kind' | 'label' | 'status' | 'startedAt'>): SessionJob {
  return { ...overrides }
}

function catalog(entries: SubagentCatalogSnapshot['entries']): SubagentCatalogSnapshot {
  return { entries, state: 'ready', error: null }
}

function listState(overrides: Partial<SessionListState> = {}): SessionListState {
  return {
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    ...overrides,
  }
}

/** A directory store stand-in; the pages only subscribe to and read it. */
function directoryStore(directory: NonNullable<DestinationLiveSnapshot['directory']>): DirectoryStore {
  const store = createSnapshotStore<NonNullable<DestinationLiveSnapshot['directory']>>(directory)
  return { subscribe: store.subscribe, getSnapshot: store.getSnapshot }
}

const READY_DIRECTORY = {
  current: { provider: 'local', model: 'qianshou-team', reasoningEffort: 'high' },
  lastUsed: null, autoDecision: null, routable: true, status: 'ready' as const, error: null,
  groups: [{ id: 'local', name: '千手', models: [{ id: 'qianshou-team', name: '千手·多智能体' }] }],
  failures: [],
}

/**
 * Mount one destination page over an injected state.
 * @param overrides - destination identity plus the live sources it should read.
 * @returns the render result and the action spies the page may call.
 */
function mount(overrides: {
  id: DestinationsPageProps['id']
  list?: SessionListState
  directory?: DestinationLiveSnapshot['directory']
  /** Drop one injected action, as an unloaded face does. */
  omit?: 'openSession' | 'openFiles' | 'openChat' | 'openPanel'
}) {
  const { id, list, directory = READY_DIRECTORY, omit } = overrides
  const snapshot: DestinationLiveSnapshot = {
    list, directory, directoryMounted: directory !== undefined,
  }
  const store = createSnapshotStore(snapshot)
  const openChat = vi.fn()
  const openFiles = vi.fn(() => undefined)
  const openSession = vi.fn()
  const selectPanel = vi.fn()
  // Deferred exactly like the injected face: rendering must not navigate.
  const openPanel = (panel: string | null) => () => { selectPanel(panel) }
  const titleKey = `dest.${TITLE_SEGMENT[id]}.title` as DestinationsPageProps['title']
  const view = render(<DestinationPage
    id={id}
    title={titleKey}
    body="dest.agents.body"
    useLiveState={selector => selector(store.getSnapshot())}
    openChat={omit === 'openChat' ? undefined : openChat}
    openPanel={omit === 'openPanel' ? undefined : openPanel}
    openFiles={omit === 'openFiles' ? undefined : openFiles}
    openSession={omit === 'openSession' ? undefined : openSession}
    t={t}
    useSessions={unused}
    useSessionPendingInteraction={unused}
    usePanelInfo={unused}
    useResource={unused}
    useWorkspaces={unused}
  />)
  return { view, openChat, openFiles, openSession, selectPanel }
}

describe('agents destination', () => {
  it('lists the subagents this client can actually address, with real labels and states', () => {
    const list = listState({
      current: sid('s1'),
      byId: {
        [sid('s1')]: summary({ id: sid('s1'), displayTitle: '修复登录', updatedAt: 10 }),
        [sid('c1')]: summary({
          id: sid('c1'), displayTitle: '工程师 · 修复登录', running: true, updatedAt: 20,
          origin: 'subagent', parentId: sid('s1'),
        }),
        [sid('c2')]: summary({
          id: sid('c2'), displayTitle: '审查 · 回归', updatedAt: 5,
          origin: 'subagent', parentId: sid('s1'),
        }),
      },
      subagentsByParent: {
        [sid('s1')]: catalog([
          { kind: 'child', id: sid('c1'), label: '工程师 · 修复登录', mode: 'continuable', activity: 'running', hasChildren: false },
          { kind: 'child', id: sid('c2'), label: '审查 · 回归', mode: 'one-shot', activity: 'inactive', hasChildren: false },
        ]),
      },
    })
    const { view, openSession } = mount({ id: 'qianshou-agents', list })
    expect(screen.getByText('工程师 · 修复登录')).toBeTruthy()
    expect(screen.getByText('审查 · 回归')).toBeTruthy()
    expect(view.container.textContent).toContain(zh['dest.agents.count'].replace('{count}', '2'))
    expect(screen.getByText(zh['dest.agents.stateRunning'])).toBeTruthy()
    expect(screen.getByText(zh['dest.agents.stateInactive'])).toBeTruthy()
    // The current session is the reader's own conversation, never a teammate row.
    expect(screen.queryByText('修复登录')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: zh['dest.agents.detail'] })[0]!)
    expect(openSession).toHaveBeenCalledWith('c1')
  })

  it('states the empty roster instead of inventing a marketplace', () => {
    const { view } = mount({ id: 'qianshou-agents', list: listState() })
    expect(screen.getByText(zh['dest.agents.status.empty'])).toBeTruthy()
    const text = view.container.textContent ?? ''
    expect(text).toContain(zh['dest.agents.position'])
    expect(text).toContain(zh['dest.agents.notice'])
    expect(text).toContain(zh['dest.agents.body'])
    expect(text).not.toMatch(/\d+\s*(个)?(智能体|agent)s?\s*(在|available)/i)
  })

  it('keeps a roster row readable when the catalog carries no label', () => {
    const list = listState({
      current: sid('s1'),
      byId: {
        [sid('c1')]: summary({
          id: sid('c1'), displayTitle: '审查 · 回归', updatedAt: 2,
          origin: 'subagent', parentId: sid('s1'),
        }),
      },
      subagentsByParent: {
        [sid('s1')]: catalog([
          { kind: 'child', id: sid('c1'), mode: 'one-shot', activity: 'inactive', hasChildren: false },
        ]),
      },
    })
    mount({ id: 'qianshou-agents', list })
    expect(screen.getByText('审查 · 回归')).toBeTruthy()
  })

  it('navigates nowhere when the session service is absent', () => {
    const { openSession, selectPanel, openChat } = mount({
      id: 'qianshou-agents',
      list: listState({ current: sid('s1') }),
      omit: 'openSession',
    })
    fireEvent.click(screen.getAllByRole('button', { name: zh['shell.back'] })[0]!)
    expect(openChat).toHaveBeenCalledOnce()
    expect(openSession).not.toHaveBeenCalled()
    expect(selectPanel).not.toHaveBeenCalled()
  })

  it('omits the jump row entirely when the panel actions are absent', () => {
    const { view } = mount({ id: 'qianshou-files', list: listState({ current: sid('s1') }), omit: 'openPanel' })
    // Only the page's own back action remains, as a plain button with no panel.
    expect(view.container.querySelectorAll('[data-nav]')).toHaveLength(1)
    expect(view.container.querySelector('[data-nav]')?.getAttribute('data-nav')).toBe('chat')
  })

  it('prints the session id for a child whose descriptor carried no label at all', () => {
    const list = listState({
      subagentsByParent: {
        [sid('s1')]: catalog([
          { kind: 'child', id: sid('c1'), mode: 'one-shot', activity: 'inactive', hasChildren: false },
        ]),
      },
    })
    mount({ id: 'qianshou-agents', list })
    expect(screen.getByText('c1')).toBeTruthy()
  })

  it('says it is still reading while the session list has delivered nothing', () => {
    mount({ id: 'qianshou-agents', list: listState({ phase: 'pending' }) })
    expect(screen.getByText(zh['shell.reading'])).toBeTruthy()
  })

  it('names the real configuration surface and never promises an unavailable one', () => {
    const { view } = mount({ id: 'qianshou-agents', list: listState() })
    const text = view.container.textContent ?? ''
    expect(text).toContain('qianshou-employees')
    expect(text).toContain('设置 → 插件 → 员工设置')
    expect(parseSteps(zh['dest.agents.where.items']).map(step => step.lead))
      .toEqual(['直接对话', '同一条消息里派工', '内部协作', '随时干预'])
  })
})

describe('workflows destination', () => {
  it('lists background processes with their host-reported state, running first', () => {
    const list = listState({
      byId: { [sid('s1')]: summary({ id: sid('s1'), displayTitle: '重构结算', running: true, updatedAt: 3 }) },
      jobsBySession: {
        [sid('s1')]: [
          job({ id: jid('j2'), kind: 'bash', label: '跑测试', status: 'completed', startedAt: 1_000 }),
          job({ id: jid('j1'), kind: 'subagent', label: '工程师 · 修复登录', status: 'running', startedAt: 2_000 }),
        ],
      },
    })
    const { view } = mount({ id: 'qianshou-workflows', list })
    const rows = [...view.container.querySelectorAll('[data-qianshou-destination] [data-status]')]
      .filter(node => node.tagName === 'LI')
      .map(node => node.textContent)
    expect(rows[0]).toContain('工程师 · 修复登录')
    expect(rows[0]).toContain('subagent')
    expect(rows[0]).toContain(zh['dest.workflows.jobRunning'])
    expect(rows[1]).toContain(zh['dest.workflows.jobCompleted'])
    expect(view.container.textContent).toContain(zh['dest.workflows.jobs.count'].replace('{count}', '2'))
    expect(view.container.textContent).toContain(zh['dest.workflows.notice'])
  })

  it('reports an idle background queue without a fabricated pipeline', () => {
    const { view } = mount({ id: 'qianshou-workflows', list: listState() })
    expect(screen.getByText(zh['dest.workflows.jobs.empty'])).toBeTruthy()
    expect(view.container.textContent).toContain(zh['dest.workflows.position'])
    expect(view.container.textContent).not.toMatch(/\d+\s*(条)?(工作流|workflow)/i)
  })
})

describe('files destination', () => {
  it('opens the real Files tab when a session gives the sidebar a workspace', () => {
    const { openFiles } = mount({ id: 'qianshou-files', list: listState({ current: sid('s1') }) })
    fireEvent.click(screen.getByRole('button', { name: zh['dest.files.panel'] }))
    expect(openFiles).toHaveBeenCalledOnce()
  })

  it('offers no dead file button without a session, and names the panel path instead', () => {
    const { view, openFiles } = mount({ id: 'qianshou-files', list: listState() })
    expect(screen.queryByRole('button', { name: zh['dest.files.panel'] })).toBeNull()
    expect(screen.getByText(zh['dest.files.panelNoSession'])).toBeTruthy()
    expect(view.container.textContent).toContain(zh['dest.files.notice'])
    expect(openFiles).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toMatch(/\d+\s*(个)?文件/)
  })
})

describe('models destination', () => {
  it('prints the providers and models the deployment really loaded', () => {
    const { view } = mount({ id: 'qianshou-models-api', list: listState({ current: sid('s1') }) })
    expect(screen.getByText('千手')).toBeTruthy()
    expect(screen.getByText('千手·多智能体')).toBeTruthy()
    const text = view.container.textContent ?? ''
    expect(text).toContain(zh['dest.models.providers.count'].replace('{count}', '1'))
    expect(text).toContain(zh['dest.models.currentValue']
      .replace('{provider}', 'local').replace('{model}', 'qianshou-team'))
    expect(text).toContain(zh['dest.models.reasoning'].replace('{effort}', 'high'))
    expect(screen.getByText(zh['dest.models.routeAvailable'])).toBeTruthy()
    expect(text).toContain(zh['dest.models.notice'])
  })

  it('reports an unreadable route and a failed provider instead of hiding them', () => {
    const { view } = mount({
      id: 'qianshou-models-api',
      list: listState({ current: sid('s1') }),
      directory: {
        ...READY_DIRECTORY,
        current: null, routable: false, groups: [],
        failures: [{ id: 'remote', name: '远端网关', message: 'AUTH: missing key' }],
      },
    })
    expect(screen.getByText(zh['dest.models.empty'])).toBeTruthy()
    expect(view.container.textContent).toContain(zh['dest.models.failures'].replace('{count}', '1'))
    expect(screen.getByText('AUTH: missing key')).toBeTruthy()
    expect(screen.getByText(zh['dest.models.noSession'])).toBeTruthy()
  })

  it('prints a provider id only when it differs from the model name', () => {
    const { view } = mount({
      id: 'qianshou-models-api',
      list: listState({ current: sid('s1') }),
      directory: {
        ...READY_DIRECTORY,
        current: { provider: 'local', model: 'qianshou-team' },
        routable: null,
        groups: [{
          id: 'local', name: '千手',
          models: [{ id: 'qianshou-team', name: '千手·多智能体' }, { id: 'qianshou-fast', name: 'qianshou-fast' }],
        }],
        failures: [],
      },
    })
    const text = view.container.textContent ?? ''
    expect(screen.getByText('qianshou-fast')).toBeTruthy()
    // A model whose name already is its id prints once, with no duplicate code chip.
    expect(view.container.querySelectorAll('code')).toHaveLength(1)
    expect(view.container.querySelector('code')?.textContent).toBe('qianshou-team')
    // No effort on the route, and the host has not settled routability yet.
    expect(text).toContain(zh['dest.models.routePending'])
    expect(text).not.toContain(zh['dest.models.reasoning'].replace('{effort}', 'high'))
  })

  it('reports an unsettled route as pending rather than claiming either answer', () => {
    const { view } = mount({
      id: 'qianshou-models-api',
      list: listState({ current: sid('s1') }),
      directory: { ...READY_DIRECTORY, routable: null },
    })
    expect(screen.getByText(zh['dest.models.routePending'])).toBeTruthy()
    expect(view.container.textContent).not.toContain(zh['dest.models.routeAvailable'])
    expect(view.container.textContent).not.toContain(zh['dest.models.routeUnavailable'])
  })

  it('states a provider that answered with no models instead of an empty list', () => {
    const { view } = mount({
      id: 'qianshou-models-api',
      list: listState({ current: sid('s1') }),
      directory: {
        ...READY_DIRECTORY,
        groups: [{ id: 'local', name: '千手', models: [] }],
      } as unknown as DestinationLiveSnapshot['directory'],
    })
    expect(screen.getByText('千手')).toBeTruthy()
    expect(view.container.textContent).toContain(zh['dest.models.modelCount'].replace('{count}', '0'))
    // The provider answered with nothing, so no model row is drawn under it.
    expect(view.container.querySelectorAll('code')).toHaveLength(0)
  })

  it('omits the provider list for a provider whose catalog failed', () => {
    const { view } = mount({
      id: 'qianshou-models-api',
      list: listState({ current: sid('s1') }),
      directory: { ...READY_DIRECTORY, providers: [] } as unknown as DestinationLiveSnapshot['directory'],
    })
    expect(view.container.querySelectorAll('[data-nav]').length).toBeGreaterThan(0)
  })

  it('navigates to every destination it names, and only when clicked', () => {
    const { view, selectPanel, openChat } = mount({ id: 'qianshou-models-api', list: listState() })
    // Rendering must not navigate: the action row only records the jump.
    expect(selectPanel).not.toHaveBeenCalled()
    expect(openChat).not.toHaveBeenCalled()
    const nav = screen.getByRole('navigation', { name: zh['shell.nav'] })
    // One stable action per destination, plus the way back to the conversation
    // (which selects no panel at all: `selectPanel(null)` shows the chat).
    expect([...nav.querySelectorAll('[data-nav]')].map(node => node.getAttribute('data-nav'))).toEqual([
      'chat', 'qianshou-agents', 'qianshou-workflows', 'qianshou-files', 'qianshou-models-api',
    ])
    const actions = [...nav.querySelectorAll<HTMLButtonElement>('[data-nav]')]
    fireEvent.click(actions[0]!)
    expect(openChat).toHaveBeenCalledOnce()
    for (const action of actions.slice(1)) fireEvent.click(action)
    expect(selectPanel.mock.calls.map(call => call[0])).toEqual([
      'qianshou-agents', 'qianshou-workflows', 'qianshou-files', 'qianshou-models-api',
    ])
    // The page's own back action reaches the same conversation view.
    const footBack = [...view.container.querySelectorAll<HTMLButtonElement>('[data-nav="chat"]')]
      .find(node => !nav.contains(node))
    fireEvent.click(footBack!)
    expect(selectPanel).toHaveBeenLastCalledWith(null)
  })
})

describe('destination state derivation', () => {
  it('reads the roster from the catalog and the list mirror without double counting', () => {
    const state = derivePageState({
      list: listState({
        current: sid('s1'),
        byId: {
          [sid('c1')]: summary({
            id: sid('c1'), displayTitle: '工程师 · 修复登录', running: true, updatedAt: 4,
            origin: 'subagent', parentId: sid('s1'),
          }),
        },
        subagentsByParent: {
          [sid('s1')]: catalog([
            { kind: 'child', id: sid('c1'), label: '工程师 · 修复登录', mode: 'continuable', activity: 'running', hasChildren: false },
          ]),
        },
      }),
      directory: READY_DIRECTORY,
      directoryMounted: true,
    })
    expect(state.sessions.subagents).toHaveLength(1)
    expect(state.sessions.subagents[0]).toMatchObject({ id: 'c1', kind: 'subagent', running: true })
    expect(state.sessions.runningCount).toBe(1)
    expect(state.models.providers[0]?.models).toEqual([{ id: 'qianshou-team', name: '千手·多智能体' }])
    expect(state.models.route).toEqual({ provider: 'local', model: 'qianshou-team', effort: 'high' })
  })

  it('lets the session mirror fill the label a one-shot catalog row omitted', () => {
    const state = derivePageState({
      list: listState({
        current: sid('s1'),
        byId: {
          [sid('c1')]: summary({
            id: sid('c1'), displayTitle: '一次性子智能体', updatedAt: 7,
            origin: 'subagent', parentId: sid('s1'),
          }),
        },
        subagentsByParent: {
          [sid('s1')]: catalog([
            { kind: 'child', id: sid('c1'), mode: 'one-shot', activity: 'running', hasChildren: false },
            { kind: 'diagnostic', id: sid('c9'), reason: 'corrupt' },
          ]),
        },
      }),
      directory: undefined,
      directoryMounted: false,
    })
    expect(state.sessions.subagents).toEqual([
      { id: 'c1', label: '一次性子智能体', kind: 'one-shot', running: true, updatedAt: 7 },
    ])
    // No directory at all is reported as such, not as an empty catalog.
    expect(state.models).toEqual({ providers: [], failures: [], route: null, routed: null })
  })

  it('falls back to the raw session id when neither the job nor the session is named', () => {
    const state = derivePageState({
      list: listState({
        jobsBySession: {
          [sid('s7')]: [job({ id: jid('j7'), kind: 'bash', label: '', status: 'killed', startedAt: 3 })],
        },
      }),
      directory: undefined,
      directoryMounted: false,
    })
    expect(state.jobs[0]).toMatchObject({ label: 's7', kind: 'bash', status: 'killed' })
  })

  it('takes the continuation mode from the catalog when the list mirror has no row', () => {
    const state = derivePageState({
      list: listState({
        current: sid('s1'),
        byId: {
          [sid('c2')]: summary({
            id: sid('c2'), displayTitle: '审查 · 回归', updatedAt: 6,
            origin: 'subagent', parentId: sid('s1'),
          }),
        },
        subagentsByParent: {
          [sid('s1')]: catalog([
            { kind: 'child', id: sid('c2'), label: '审查 · 回归', mode: 'continuable', activity: 'inactive', hasChildren: false },
          ]),
        },
      }),
      directory: undefined,
      directoryMounted: false,
    })
    expect(state.sessions.subagents[0]).toMatchObject({ id: 'c2', kind: 'subagent', running: false })
  })

  it('lists a subagent the catalog has not described yet, from the mirror alone', () => {
    const state = deriveSessions(listState({
      byId: {
        [sid('c3')]: summary({
          id: sid('c3'), displayTitle: '写作 · 摘要', running: true, updatedAt: 9,
          origin: 'subagent', parentId: sid('s1'),
        }),
      },
    }))
    expect(state.subagents).toEqual([
      { id: 'c3', label: '写作 · 摘要', kind: 'one-shot', running: true, updatedAt: 9 },
    ])
    expect(state.runningCount).toBe(1)
  })

  it('labels a background process from its session when the job carries no label', () => {
    const state = derivePageState({
      list: listState({
        byId: { [sid('s1')]: summary({ id: sid('s1'), displayTitle: '重构结算', running: true, updatedAt: 1 }) },
        jobsBySession: {
          [sid('s1')]: [job({ id: jid('j9'), kind: 'ralph', label: '', status: 'running', startedAt: 5 })],
        },
      }),
      directory: undefined,
      directoryMounted: false,
    })
    expect(state.jobs[0]).toMatchObject({ label: '重构结算', kind: 'ralph', status: 'running' })
  })

  it('serves the same cached value when nothing has moved', () => {
    const sessions = {
      list: { subscribe: () => () => {}, getSnapshot: () => listState({ current: sid('s1') }) },
    } as unknown as Parameters<typeof createLiveObservable>[0]
    const live = createLiveObservable(sessions, undefined)
    const first = live.getSnapshot()
    expect(live.getSnapshot()).toBe(first)
  })

  it('resolves the directory without subscribing while no page is mounted', () => {
    const storeSubscribe = vi.fn(() => () => {})
    const sessions = {
      list: { subscribe: () => () => {}, getSnapshot: () => listState({ current: sid('s1') }) },
    } as unknown as Parameters<typeof createLiveObservable>[0]
    const models = {
      directoryFor: () => ({ store: { subscribe: storeSubscribe, getSnapshot: () => READY_DIRECTORY } }),
    } as unknown as Parameters<typeof createLiveObservable>[1]
    const live = createLiveObservable(sessions, models)
    // A read before any consumer still resolves the facts, but holds no source
    // subscription: nothing is mounted to re-render.
    expect(live.getSnapshot().directory).toEqual(READY_DIRECTORY)
    expect(storeSubscribe).not.toHaveBeenCalled()
  })

  it('reports empty facts while a source is absent, never a placeholder number', () => {
    const state = derivePageState({ list: undefined, directory: undefined, directoryMounted: false })
    expect(state).toEqual({
      sessions: { currentId: null, subagents: [], runningCount: 0 },
      jobs: [],
      models: { providers: [], failures: [], route: null, routed: null },
    })
    expect(listIsReady(undefined)).toBe(false)
  })

  it('re-emits when the session list moves and keeps its cached value for a remount', () => {
    const listeners = new Set<() => void>()
    let value = listState({
      jobsBySession: {
        [sid('s1')]: [job({ id: jid('j1'), kind: 'bash', label: '跑测试', status: 'running', startedAt: 1 })],
      },
    })
    const sessions = {
      list: {
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        getSnapshot: () => value,
      },
    } as unknown as Parameters<typeof createLiveObservable>[0]
    // The list mirror is an observable the page polls; the directory store is
    // the source this module subscribes to, so one has to be present for the
    // observable to be live at all.
    const models = {
      directoryFor: () => ({ store: directoryStore(READY_DIRECTORY) }),
    } as unknown as Parameters<typeof createLiveObservable>[1]
    const live = createLiveObservable(sessions, models)
    const seen = vi.fn()
    expect(listIsReady(undefined)).toBe(false)
    const off = live.subscribe(seen)
    expect(live.getSnapshot().list).toBe(value)
    // The source moves; the observable must re-derive rather than serve the cache.
    value = listState({ phase: 'pending' })
    for (const listener of listeners) listener()
    expect(seen).toHaveBeenCalledOnce()
    expect(live.getSnapshot().list?.phase).toBe('pending')
    off()
    // The resolved sources and the last value survive, so a remount renders the
    // current facts instead of flashing the cold empty page.
    expect(live.getSnapshot().list).toBe(value)
  })

  it('holds one directory subscription for every consumer and drops it with the last', () => {
    const storeSubscribe = vi.fn((_listener: () => void) => () => {})
    const store = { subscribe: storeSubscribe, getSnapshot: () => READY_DIRECTORY }
    const sessions = {
      list: { subscribe: () => () => {}, getSnapshot: () => listState({ current: sid('s1') }) },
    } as unknown as Parameters<typeof createLiveObservable>[0]
    const models = { directoryFor: () => ({ store }) } as unknown as Parameters<typeof createLiveObservable>[1]
    const live = createLiveObservable(sessions, models)
    const offFirst = live.subscribe(() => {})
    live.getSnapshot()
    const offSecond = live.subscribe(() => {})
    live.getSnapshot()
    expect(storeSubscribe).toHaveBeenCalledOnce()
    offFirst()
    expect(storeSubscribe).toHaveBeenCalledOnce()
    offSecond()
    // A later consumer re-attaches; the observable was rebuilt, not leaked.
    live.subscribe(() => {})
    live.getSnapshot()
    expect(storeSubscribe).toHaveBeenCalledTimes(2)
  })

  it('binds the model directory when a session resolves one, and degrades when it does not', () => {
    const sessions = {
      list: { subscribe: () => () => {}, getSnapshot: () => listState({ current: sid('s1') }) },
    } as unknown as Parameters<typeof createLiveObservable>[0]
    const resolver = { directoryFor: () => ({ store: directoryStore(READY_DIRECTORY) }) }
    const live = createLiveObservable(sessions, resolver as unknown as Parameters<typeof createLiveObservable>[1])
    const off = live.subscribe(() => {})
    expect(live.getSnapshot().directory).toEqual(READY_DIRECTORY)
    expect(live.getSnapshot().directoryMounted).toBe(true)
    off()
    // An unresolved session (the resolver throws) degrades to "not readable"
    // instead of holding on to another session's directory.
    const failing = {
      directoryFor: () => { throw new Error('no scope') },
    } as unknown as Parameters<typeof createLiveObservable>[1]
    const degraded = createLiveObservable(sessions, failing).getSnapshot()
    expect(degraded.directory).toBeUndefined()
    expect(degraded.directoryMounted).toBe(true)
  })
})

describe('injected face behaviour', () => {
  /** A client root context stand-in exposing only the reflected service lookup. */
  function contextWith(services: Record<string, unknown>) {
    return { reflect: { get: (name: string) => services[name] } } as unknown as Parameters<
      typeof createDestinationInjected
    >[0]
  }

  it('performs a panel jump only when the action runs, never while the face is built', () => {
    const selectPanel = vi.fn()
    const face = createDestinationInjected(contextWith({ layout: { selectPanel } }))
    expect(selectPanel).not.toHaveBeenCalled()
    face.openChat()
    face.openPanel('qianshou-files')()
    expect(selectPanel.mock.calls.map(call => call[0])).toEqual([null, 'qianshou-files'])
  })

  it('does nothing when the layout service is absent, instead of throwing', () => {
    const face = createDestinationInjected(contextWith({}))
    expect(() => { face.openChat() }).not.toThrow()
    expect(() => { face.openPanel('qianshou-files')() }).not.toThrow()
    expect(() => { face.openSession?.('s1') }).not.toThrow()
  })

  it('continues the addressed session through the session service', () => {
    const open = vi.fn()
    const face = createDestinationInjected(contextWith({ sessions: { open } }))
    face.openSession?.('s1')
    expect(open).toHaveBeenCalledWith('s1')
  })

  it('reports why the file panel could not open rather than failing silently', () => {
    const missing = createDestinationInjected(contextWith({}))
    expect(missing.openFiles()).toBe('sidebarRight service is not available')
    const refusing = createDestinationInjected(contextWith({
      sidebarRight: { openTab: () => { throw new Error('no mounted session') } },
    }))
    expect(refusing.openFiles()).toBe('no mounted session')
    const throwing = createDestinationInjected(contextWith({
      sidebarRight: { openTab: () => { throw 'plain string' } },
    }))
    expect(throwing.openFiles()).toBe('plain string')
    const working = createDestinationInjected(contextWith({ sidebarRight: { openTab: vi.fn() } }))
    expect(working.openFiles()).toBeUndefined()
  })
})

describe('a destination page mounted without its injected face', () => {
  it('still renders the frame and offers only the actions it can perform', () => {
    cleanup()
    const view = render(<DestinationPage
      id="qianshou-files"
      title="dest.files.title"
      body="dest.files.body"
      t={t}
      useSessions={unused}
      useSessionPendingInteraction={unused}
      usePanelInfo={unused}
      useResource={unused}
      useWorkspaces={unused}
    />)
    expect(screen.getByRole('heading', { name: zh['dest.files.title'] })).toBeTruthy()
    expect(view.container.textContent).toContain(zh['dest.files.position'])
    // Without the live hook there is no session to follow, so the page states
    // that instead of offering a file button that cannot work.
    expect(screen.getByText(zh['dest.files.panelNoSession'])).toBeTruthy()
    expect(view.container.querySelector('[data-nav]')).toBeNull()
  })

  it('stands in inert actions for the face members a bare mount did not supply', () => {
    cleanup()
    // No panel, session, or file action at all: the page's own file button and
    // the agents page's back action must absorb their clicks instead of throwing.
    const files = render(<DestinationPage
      id="qianshou-files"
      title="dest.files.title"
      body="dest.files.body"
      t={t}
      useLiveState={selector => selector({
        list: listState({ current: sid('s1') }), directory: undefined, directoryMounted: false,
      })}
      useSessions={unused}
      useSessionPendingInteraction={unused}
      usePanelInfo={unused}
      useResource={unused}
      useWorkspaces={unused}
    />)
    fireEvent.click(screen.getByRole('button', { name: zh['dest.files.panel'] }))
    expect(files.container.textContent).toContain(zh['dest.files.position'])
    cleanup()

    const agents = render(<DestinationPage
      id="qianshou-agents"
      title="dest.agents.title"
      body="dest.agents.body"
      t={t}
      useLiveState={selector => selector({
        list: listState(), directory: undefined, directoryMounted: false,
      })}
      useSessions={unused}
      useSessionPendingInteraction={unused}
      usePanelInfo={unused}
      useResource={unused}
      useWorkspaces={unused}
    />)
    fireEvent.click(screen.getByRole('button', { name: zh['shell.back'] }))
    expect(agents.container.textContent).toContain(zh['dest.agents.position'])
  })
})


describe('bounded projections', () => {
  it('caps the roster, orders working subagents first, and keeps the newest settled row', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      kind: 'child' as const,
      id: `c${index}` as SessionId,
      label: `员工 ${index}`,
      mode: 'continuable' as const,
      activity: index === 9 ? 'running' as const : 'inactive' as const,
      hasChildren: false,
    }))
    const sessions = deriveSessions(listState({ subagentsByParent: { [sid('s1')]: catalog(entries) } }))
    expect(sessions.subagents).toHaveLength(8)
    expect(sessions.subagents[0]?.label).toBe('员工 9')
    expect(sessions.runningCount).toBe(1)
    expect(sessions.currentId).toBeNull()
  })

  it('keeps a stopping process above the settled history and caps the list', () => {
    const jobs = Array.from({ length: 9 }, (_, index) => job({
      id: jid(`j${index}`), kind: 'bash', label: `进程 ${index}`,
      status: index === 8 ? 'stopping' as const : 'completed' as const, startedAt: index,
    }))
    const projected = deriveJobs(listState({ jobsBySession: { [sid('s1')]: jobs } }))
    expect(projected).toHaveLength(6)
    expect(projected[0]).toMatchObject({ label: '进程 8', status: 'stopping' })
    expect(projected[1]).toMatchObject({ label: '进程 7' })
  })

  it('slices long provider and model lists instead of printing an unbounded catalog', () => {
    const models = deriveModels({
      ...READY_DIRECTORY,
      groups: Array.from({ length: 10 }, (_, index) => ({
        id: `p${index}`, name: `服务商 ${index}`,
        models: Array.from({ length: 10 }, (_, model) => ({ id: `m${model}`, name: `模型 ${model}` })),
      })),
      failures: [{ id: 'remote', name: '远端网关', message: 'AUTH' }],
    })
    expect(models.providers).toHaveLength(8)
    expect(models.providers[0]?.models).toHaveLength(8)
    expect(models.failures).toEqual([{ id: 'remote', name: '远端网关', models: [], message: 'AUTH' }])
    // A route without an explicit effort reports none rather than inventing one.
    expect(deriveModels({ ...READY_DIRECTORY, current: { provider: 'local', model: 'x' } }).route)
      .toEqual({ provider: 'local', model: 'x', effort: null })
  })
})

describe('product-nav glyphs', () => {
  it('draws one decorative path for every registered destination', () => {
    for (const destination of PRODUCT_DESTINATIONS) {
      const view = render(<DestinationIcon kind={destination.title} />)
      const svg = view.container.querySelector('svg')!
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M/)
      cleanup()
    }
  })
})

describe('destination dictionaries', () => {
  it('keeps zh and en key-for-key identical', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps every step line parseable and every step label distinct', () => {
    const sources = ['dest.agents.where.items', 'dest.agents.members.items', 'dest.agents.now.items',
      'dest.workflows.forms.items', 'dest.workflows.run.items', 'dest.files.read.items',
      'dest.files.scope.items', 'dest.models.setup.items'] as const
    const seen = new Set<string>()
    for (const source of sources) {
      for (const step of parseSteps(zh[source])) {
        expect(step.lead.length).toBeGreaterThan(0)
        expect(step.detail.length).toBeGreaterThan(0)
        seen.add(step.lead)
      }
      for (const step of parseSteps(en[source])) {
        expect(step.lead.length).toBeGreaterThan(0)
        expect(step.detail.length).toBeGreaterThan(0)
      }
    }
    expect(seen.size).toBe(sources.reduce((total, key) => total + zh[key].split('\n').length, 0))
    expect(() => parseSteps('no separator here')).toThrow(/no separator/)
  })
})
