// @vitest-environment jsdom
/** Conversation assembly acceptance independent of Tool presentation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { useLayoutEffect, useState } from 'react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  RemoteError, SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope,
} from '@deepseek-ai/dsh-client-test-runtime'
import { InputHub } from '../src/client/input/hub.ts'
import { apply, inject, type EmptyWorkspaceOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationContentEntryOwnerProps } from '../src/client/contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

// jsdom implements no Range geometry (Lexical's scroll-into-view measures the
// caret with one once the surface is genuinely contenteditable).
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})


usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
const resizeObservers: ResizeObserverStub[] = []
class ResizeObserverStub {
  targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) { resizeObservers.push(this) }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(): void {}
  disconnect(): void { this.targets.clear() }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  resizeObservers.length = 0
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

type AppRootProps = PropsRenderSlots<'main'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('main', {}, { entryKey: 'conversation' })}</>
}

const LAYOUT_CHILDREN = {
  'main': { kind: 'keyed', scope: 'root' },
} as const

function provideWorkspaceNavigation(runtime: SlotTestRuntime): (id: SessionId) => void {
  let mainReference: ReturnType<typeof runtime.sessions.retain> | undefined
  const openSession = (id: SessionId): void => {
    const next = runtime.sessions.retain(id, { source: 'mainView' })
    mainReference?.release()
    mainReference = next
  }
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: vi.fn(async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      beforeOpen(SID)
      openSession(SID)
    }),
    openSession,
  } as never)
  return openSession
}

function WorkspaceProbe({ open }: EmptyWorkspaceOwnerProps) {
  const [count, setCount] = useState(0)
  return (
    <button data-testid="workspace-probe" onClick={() => { setCount(value => value + 1) }}>
      {String(open)}:{count}
    </button>
  )
}

async function bench(opts?: { blank?: boolean }) {
  const runtime = await SlotTestRuntime.create()
  const openSession = provideWorkspaceNavigation(runtime)
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
    ...(opts?.blank === undefined ? {} : { snapshot: { blank: opts.blank } }),
    session: {
      loadOlder: vi.fn<ISession['loadOlder']>(),
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  openSession(SID)
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

function TaskEntry({ reportPresence }: ConversationContentEntryOwnerProps) {
  useLayoutEffect(() => {
    reportPresence('task-entry', true)
    return () => { reportPresence('task-entry', false) }
  }, [reportPresence])
  return <article>Requested task, quote and result</article>
}

function scrollGeometry(scrollport: HTMLElement) {
  let height = 100
  let top = 0
  Object.defineProperties(scrollport, {
    clientHeight: { get: () => 100 },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(value, height - 100)) },
    },
  })
  return { grow(value: number): void { height = value } }
}

describe('Session task entry following through the assembled Conversation owner', () => {
  it.each([true, false])('follows task growth with blank=%s and preserves an upward reader', async (blank) => {
    const runtime = await bench({ blank })
    runtime.slots.register({ name: 'conversation.content.entries', id: 'task-entry' }, TaskEntry)
    runtime.slots.register({ name: 'conversation.view', id: 'chat' }, () => <article>Existing transcript</article>)
    await runtime.flush()
    const view = runtime.renderRoot()
    const scrollport = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const entries = view.container.querySelector<HTMLElement>('[data-conversation-content-entries]')!
    const geometry = scrollGeometry(scrollport)
    const observer = resizeObservers.find(candidate => candidate.targets.has(entries))!
    expect(entries.hidden).toBe(false)
    expect(view.queryByText('Existing transcript') !== null).toBe(!blank)

    geometry.grow(300)
    act(() => { observer.callback([], {} as ResizeObserver) })
    expect(scrollport.scrollTop).toBe(200)
    scrollport.scrollTop = 50
    fireEvent.scroll(scrollport)
    geometry.grow(500)
    act(() => { observer.callback([], {} as ResizeObserver) })
    expect(scrollport.scrollTop).toBe(50)
    await runtime.dispose()
    expect(observer.targets.size).toBe(0)
  })

  it('follows the replacement Session scrollport and silences the retired observer', async () => {
    const runtime = await bench({ blank: true })
    runtime.slots.register({ name: 'conversation.content.entries', id: 'task-entry' }, TaskEntry)
    const view = runtime.renderRoot()
    const scrollport = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const entries = view.container.querySelector<HTMLElement>('[data-conversation-content-entries]')!
    const geometry = scrollGeometry(scrollport)
    const previous = resizeObservers.find(candidate => candidate.targets.has(entries))!
    const nextId = 's2' as SessionId
    await runtime.sessions.add({
      id: nextId,
      summary: { title: 'Other', displayTitle: 'Other', cwd: '/other', blank: true },
      snapshot: { blank: true },
      session: { loadOlder: vi.fn<ISession['loadOlder']>(), prompt: vi.fn<ISession['prompt']>() },
    })
    const navigation = runtime.ctx.get('uiWorkspace') as { openSession(id: SessionId): void }
    act(() => { navigation.openSession(nextId) })
    await runtime.flush()
    const nextScrollport = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const nextEntries = view.container.querySelector<HTMLElement>('[data-conversation-content-entries]')!
    const nextGeometry = scrollGeometry(nextScrollport)
    expect(nextScrollport).not.toBe(scrollport)
    expect(previous.targets.size).toBe(0)
    const current = resizeObservers.find(candidate => candidate.targets.has(nextEntries))!
    expect(current).not.toBe(previous)
    geometry.grow(400)
    act(() => { previous.callback([], {} as ResizeObserver) })
    expect(scrollport.scrollTop).toBe(0)
    nextGeometry.grow(400)
    act(() => { current.callback([], {} as ResizeObserver) })
    expect(nextScrollport.scrollTop).toBe(300)
    await runtime.dispose()
    nextGeometry.grow(600)
    act(() => { current.callback([], {} as ResizeObserver) })
    expect(nextScrollport.scrollTop).toBe(300)
  })
})

describe('resident composer', () => {
  it('renders the locked view state while no session exists at all', async () => {
    const runtime = await SlotTestRuntime.create()
    provideWorkspaceNavigation(runtime)
    runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    runtime.slots.register({ name: 'conversation.hero.workspace' }, WorkspaceProbe)
    const view = runtime.renderRoot()
    const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(textarea).not.toBeNull()
    expect(textarea!.getAttribute('aria-disabled')).not.toBe('true')
    expect(textarea!.getAttribute('contenteditable')).not.toBe('true')
    expect(textarea!.getAttribute('aria-haspopup')).toBe('menu')
    expect(view.getByTestId('workspace-probe').textContent).toBe('false:0')
    fireEvent.click(textarea!)
    expect(view.getByTestId('workspace-probe').textContent).toBe('true:0')
    expect(textarea!.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: '选择工作区' }))
    fireEvent.keyDown(textarea!, { key: 'Enter' })
    expect(view.getByTestId('workspace-probe').textContent).toBe('true:0')
    expect(view.getByRole('button', { name: '选择工作区' })).toBeTruthy()
    await runtime.dispose()
  })

  it('keeps the complete Hero tree mounted when the first Workspace session appears', async () => {
    const runtime = await SlotTestRuntime.create()
    const openSession = provideWorkspaceNavigation(runtime)
    runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.workspaces.update((draft) => {
      draft.items = [{ workspaceId: 'w1', title: 'Proj', path: '/proj', sessionIds: [SID] }] as never
    })
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    runtime.slots.register({ name: 'conversation.hero.workspace' }, WorkspaceProbe)
    const view = runtime.renderRoot()

    const root = view.container.querySelector('[data-phase="hero"]')!
    const scrollBody = view.container.querySelector('[data-conversation-scroll]')!
    const composerSeat = view.container.querySelector('[data-composer-seat]')!
    const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    const workspaceChip = view.getByRole('button', { name: '选择工作区' })
    const workspaceProbe = view.getByTestId('workspace-probe')
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    expect(textarea.getAttribute('contenteditable')).not.toBe('true')

    fireEvent.click(workspaceChip)
    fireEvent.click(workspaceProbe)
    expect(workspaceProbe.textContent).toBe('true:1')

    await runtime.sessions.add({
      id: SID,
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj', blank: true },
      snapshot: { blank: true },
    })
    openSession(SID)
    await runtime.flush()

    expect(view.container.querySelector('[data-phase="hero"]')).toBe(root)
    expect(view.container.querySelector('[data-conversation-scroll]')).toBe(scrollBody)
    expect(view.container.querySelector('[data-composer-seat]')).toBe(composerSeat)
    expect(view.container.querySelector<HTMLDivElement>('[data-composer-input]')).toBe(textarea)
    expect(view.getByRole('button', { name: '选择工作区' })).toBe(workspaceChip)
    expect(view.getByTestId('workspace-probe')).toBe(workspaceProbe)
    expect(workspaceProbe.textContent).toBe('true:1')
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    expect(textarea.getAttribute('contenteditable')).toBe('true')
    await runtime.dispose()
  })

  it('the textarea survives the blank→active conversion as the same DOM node', async () => {
    const runtime = await bench({ blank: true })
    await runtime.workspaces.update((draft) => {
      draft.items = [{ workspaceId: 'w1', title: 'Proj', path: '/proj', sessionIds: [SID] }] as never
    })
    const view = runtime.renderRoot()
    const hero = view.container.querySelector<HTMLDivElement>('[data-composer-input]')
    expect(hero).not.toBeNull()
    expect(hero!.getAttribute('aria-disabled')).not.toBe('true')

    await runtime.sessions.updateSessionSnapshot(SID, (draft) => {
      draft.blank = false
    })
    expect(view.container.querySelector<HTMLDivElement>('[data-composer-input]')).toBe(hero)
    await runtime.dispose()
  })
})

describe('prompt rejection through the assembled composer', () => {
  it('renders the promptError alert strip and keeps the draft in the machine', async () => {
    const runtime = await SlotTestRuntime.create()
    const openSession = provideWorkspaceNavigation(runtime)
    runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const prompt = vi.fn<ISession['prompt']>(async () => ({
      ok: false,
      error: new RemoteError('session/agent-busy', 'prompt rejected before acceptance', { reason: 'busy' }),
    }))
    await runtime.sessions.add({
      id: SID,
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
      session: { prompt, loadOlder: vi.fn<ISession['loadOlder']>() },
    })
    openSession(SID)
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    const composer = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    // Write through the assembled input resolver (contenteditable change
    // events carry no value; the resolver is the public draft write path).
    const conversation = runtime.ctx.get('conversation') as { input: unknown }
    const shell = (conversation.input as InputHub).shell(SID)
    act(() => { shell.setDraft('do not lose this') })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })

    await runtime.sessions.updateSessionSnapshot(SID, (draft) => {
      draft.promptError = {
        op: 'send',
        error: new RemoteError('session/agent-busy', 'prompt rejected before acceptance', { reason: 'busy' }),
      }
    })
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('prompt rejected before acceptance (session/agent-busy)')
    await waitFor(() => {
      expect(shell.snapshot.draft).toBe('do not lose this')
    })
    await runtime.dispose()
  })
})

describe('title projection across assembled surfaces', () => {
  it('one summary update re-labels the current-session crumb', async () => {
    const runtime = await bench()
    const view = runtime.renderRoot()
    const hierarchy = view.getByRole('navigation', { name: '会话层级' })
    expect(within(hierarchy).getByRole('button', { name: 'S' }).hasAttribute('disabled')).toBe(true)

    await runtime.sessions.updateSummary(SID, { displayTitle: '修订标题', title: '修订标题' })
    await waitFor(() => {
      expect(within(hierarchy).getByRole('button', { name: '修订标题' }).hasAttribute('disabled')).toBe(true)
    })
    expect(within(hierarchy).queryByRole('button', { name: 'S' })).toBeNull()
    await runtime.dispose()
  })
})
