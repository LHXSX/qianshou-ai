// @vitest-environment jsdom
/** External content must elect the complete shell before Chat has mounted. */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatTimelineEntry, ChatTimelineEntryProps } from '../src/client/contract/timeline-entries.ts'
import { apply, inject } from '../src/client/apply.ts'

usePinnedBrowserLanguages('zh-CN')
const SID = SessionId('fresh-feature')
const OTHER = SessionId('fresh-other')
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function FeatureCard({ entryId, sessionId }: ChatTimelineEntryProps) {
  return <article aria-label={`card ${entryId}`}>{sessionId} / {entryId}</article>
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.ctx.provide('layout', { closeRightbar: vi.fn(), openRightbar: vi.fn() } as never)
  runtime.ctx.provide('sidebarRight', { openResource: vi.fn(), openTab: vi.fn() } as never)
  runtime.ctx.provide('sidebarRightTabs', { register: vi.fn(() => () => {}) } as never)
  runtime.ctx.provide('resources', { register: vi.fn(() => () => {}) } as never)
  runtime.ctx.provide('uiWorkspace', { openSession: vi.fn(), openWorkspace: vi.fn() } as never)
  runtime.remote.provideNamespaces({ session: { openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })) } })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
  for (const id of [SID, OTHER]) await runtime.sessions.add({
    id, summary: { blank: true, displayTitle: `title ${id}` },
    snapshot: { blank: true, awaitingFirstTurn: true, promptAttempted: false, running: false },
    session: { prompt },
  })
  const first = runtime.sessions.retain(SID)
  const other = runtime.sessions.retain(OTHER)
  await Promise.all([first.ready, other.ready])
  await runtime.root.declare({ main: { kind: 'keyed', scope: 'root' },
    'conversation.approval.detail': { kind: 'single', scope: 'session' } },
  function Root({ SessionProvider, renderSlot }: PropsRenderSlots<'main' | 'conversation.approval.detail'>) {
    const [selected, select] = useState(first)
    return <><button onClick={() => { select(first) }}>first Session</button>
      <button onClick={() => { select(other) }}>other Session</button>
      <SessionProvider session={selected}>{renderSlot('main', {}, { entryKey: 'conversation' })}</SessionProvider></>
  })
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  const owner = await runtime.mount({ inject: [...inject], apply })
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view', id: 'other', label: 'Other View',
    }, () => <div>other registered view</div>))
    ctx.slots.inject('conversation.chat.timelineEntry', () => ctx.slots.register({
      name: 'conversation.chat.timelineEntry', key: 'feature',
    }, FeatureCard))
  } })
  return { runtime, first, other, owner, prompt }
}

function provider(runtime: SlotTestRuntime, initial: readonly ChatTimelineEntry[] = []) {
  const rows = new Map<SessionId, readonly ChatTimelineEntry[]>([[SID, initial]])
  let notify: (id: SessionId) => void = () => {}
  const stop = vi.fn()
  const remove = runtime.ctx.chatTimelineEntries.register({ id: 'feature',
    read: id => rows.get(id) ?? [], subscribe: (listener) => { notify = listener; return stop },
  })
  return { remove, stop, publish(id: SessionId, entries: readonly ChatTimelineEntry[]) {
    rows.set(id, entries); notify(id)
  }, late: (id: SessionId) => { notify(id) } }
}

describe('fresh, unjoined Session through the complete Conversation assembly', () => {
  it('keeps invalid and empty content blank, then opens Header, View and Chat without a Host turn', async () => {
    const b = await bench()
    try {
      const p = provider(b.runtime)
      const view = b.runtime.renderRoot()
      expect(view.container.querySelector('[data-phase="hero"]')).not.toBeNull()
      expect(view.container.querySelector('[data-chat-flow]')).toBeNull()
      expect(screen.queryByRole('tablist')).toBeNull()
      act(() => { p.publish(SID, [{ id: 'invalid', createdAt: 0 }]) })
      expect(screen.queryByRole('tablist')).toBeNull()
      expect(b.runtime.ctx.uiConversation.binding(SID).snapshot.getSnapshot().activeTargets.size).toBe(0)
      act(() => { p.publish(SID, [{ id: 'request', createdAt: 100 }]) })
      const card = await screen.findByRole('article', { name: 'card request' })
      expect(card.closest('[data-chat-flow]')).not.toBeNull()
      expect(card.closest('[data-chat-turn]')).toBeNull()
      expect(screen.getByRole('tab', { name: '对话' })).toBeDefined()
      expect(screen.getByText(`title ${SID}`)).toBeDefined()
      expect(view.container.querySelector('[data-phase="active"]')).not.toBeNull()
      expect(b.runtime.sessions.binding(SID)?.session.getSnapshot()).toMatchObject({
        blank: true, awaitingFirstTurn: true, promptAttempted: false, running: false,
      })
      expect(b.runtime.sessions.binding(SID)?.eventSource.getSnapshot().entries).toEqual([])
      expect(b.prompt).not.toHaveBeenCalled()
      act(p.remove)
      await waitFor(() => { expect(screen.queryByRole('tablist')).toBeNull() })
      expect(view.container.querySelector('[data-phase="hero"]')).not.toBeNull()
      expect(view.container.querySelector('[data-chat-flow]')).toBeNull()
      expect(p.stop).toHaveBeenCalledTimes(1)
      act(() => { p.publish(SID, [{ id: 'late', createdAt: 101 }]) })
      expect(screen.queryByRole('article')).toBeNull()
    } finally { await b.runtime.dispose() }
  })

  it('reads already persisted valid entries before mounting Chat and scopes later activity to the selected Session', async () => {
    const b = await bench()
    try {
      const p = provider(b.runtime, [{ id: 'persisted', createdAt: 100 }])
      const view = b.runtime.renderRoot()
      expect(await screen.findByRole('article', { name: 'card persisted' })).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'other Session' }))
      await waitFor(() => { expect(view.container.querySelector('[data-phase="hero"]')).not.toBeNull() })
      expect(screen.queryByRole('tablist')).toBeNull()
      act(() => { p.publish(SID, [{ id: 'old-session', createdAt: 110 }]) })
      expect(screen.queryByRole('article')).toBeNull()
      act(() => { p.publish(OTHER, [{ id: 'second', createdAt: 120 }]) })
      expect((await screen.findByRole('article', { name: 'card second' })).textContent).toBe(`${OTHER} / second`)
      expect(screen.queryByRole('article', { name: 'card old-session' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'first Session' }))
      expect((await screen.findByRole('article', { name: 'card old-session' })).textContent).toBe(`${SID} / old-session`)
      expect(b.runtime.sessions.binding(SID)?.eventSource.getSnapshot().entries).toEqual([])
      expect(b.runtime.sessions.binding(OTHER)?.eventSource.getSnapshot().entries).toEqual([])
      expect(b.prompt).not.toHaveBeenCalled()
    } finally { await b.runtime.dispose() }
  })

  it('withdraws the activity subscription when the Chat provider is disposed', async () => {
    const b = await bench()
    try {
      const p = provider(b.runtime, [{ id: 'request', createdAt: 100 }])
      const view = b.runtime.renderRoot()
      await screen.findByRole('article', { name: 'card request' })
      await act(async () => { await b.owner.dispose() })
      expect(b.runtime.ctx.uiConversation.binding(SID).snapshot.getSnapshot().activeTargets.size).toBe(0)
      expect(view.container.querySelector('[data-phase="hero"]')).not.toBeNull()
      act(() => { p.late(SID) })
      expect(screen.queryByRole('article')).toBeNull()
      expect(p.stop).toHaveBeenCalledTimes(1)
    } finally { await b.runtime.dispose() }
  })
})
