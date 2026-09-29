// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, screen } from '@testing-library/react'
import { SlotTestRuntime, stubSettingsScope, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatTimelineEntryProps } from '../src/client/contract/timeline-entries.ts'
import { apply, inject } from '../src/client/apply.ts'

usePinnedBrowserLanguages('zh-CN')
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const SID = SessionId('timeline-session')

function FeatureCard({ entryId, sessionId, createdAt }: ChatTimelineEntryProps) {
  return <article aria-label={`card ${entryId}`}>{sessionId} / {entryId} / {createdAt}</article>
}

describe('feature timeline rows through the actual Chat slot assembly', () => {
  it('renders a feature-only Session in Chat flow, uses its exact scope, and withdraws its lifecycle', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
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
      await runtime.sessions.add({ id: SID, summary: { blank: true, displayTitle: 'feature conversation' },
        snapshot: { blank: true, awaitingFirstTurn: true } })
      const reference = runtime.sessions.retain(SID)
      await reference.ready
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: SID }))
      await runtime.root.declare({ main: { kind: 'keyed', scope: 'root' }, 'conversation.approval.detail': { kind: 'single', scope: 'session' } },
        ({ SessionProvider, renderSlot }: PropsRenderSlots<'main' | 'conversation.approval.detail'>) =>
          <SessionProvider session={reference}>{renderSlot('main', {}, { entryKey: 'conversation' })}</SessionProvider>)
      await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
      const owner = await runtime.mount({ inject: [...inject], apply })
      let notify: (sessionId: SessionId) => void = () => {}
      const stop = vi.fn()
      let rows = [{ id: 'one', createdAt: 100 }]
      const remove = runtime.ctx.chatTimelineEntries.register({
        id: 'feature', read: id => id === SID ? rows : [], subscribe: (listener) => { notify = listener; return stop },
      })
      await runtime.mount({ inject: ['slots'], apply(ctx) {
        ctx.slots.inject('conversation.chat.timelineEntry', () => ctx.slots.register({
          name: 'conversation.chat.timelineEntry', key: 'feature',
        }, FeatureCard))
      } })
      const view = runtime.renderRoot()
      const card = await screen.findByRole('article', { name: 'card one' })
      expect(card.textContent).toBe(`${SID} / one / 100`)
      expect(card.closest('[data-chat-flow]')).not.toBeNull()
      expect(card.closest('[data-chat-turn]')).toBeNull()
      expect(runtime.sessions.binding(SID)?.eventSource.getSnapshot().entries).toEqual([])
      await runtime.sessions.appendEvent(SID, { type: 'event', event: {
        type: 'turn/start', seq: SessionSeq(1), time: 300, data: { turn: 1 },
      } })
      await runtime.sessions.appendEvent(SID, { type: 'event', event: {
        type: 'user/message', seq: SessionSeq(2), time: 301, surfaceOp: 'append', data: {
          id: MessageId('later-prompt'), role: 'user', content: [{ type: 'text', text: 'later Host prompt' }], source: { kind: 'user' },
        },
      } })
      await screen.findByText('later Host prompt')
      rows = [{ id: 'one', createdAt: 999 }, { id: 'two', createdAt: 400 }]
      act(() => { notify(SID) })
      await screen.findByRole('article', { name: 'card two' })
      expect(screen.getByRole('article', { name: 'card one' }).textContent).toBe(`${SID} / one / 100`)
      expect(view.container.querySelectorAll('[data-chat-flow-kind="external"]')).toHaveLength(2)
      const flow = [...view.container.querySelectorAll('[data-chat-flow-key]')]
      expect(flow[0]?.textContent).toContain('/ one / 100')
      expect(flow[1]?.textContent).toContain('later Host prompt')
      expect(flow[2]?.textContent).toContain('/ two / 400')
      act(remove)
      expect(screen.queryByRole('article', { name: 'card one' })).toBeNull()
      expect(stop).toHaveBeenCalledTimes(1)
      act(() => { notify(SID) })
      expect(screen.queryByRole('article', { name: 'card two' })).toBeNull()
      await owner.dispose()
      expect(runtime.ctx.get('chatTimelineEntries')).toBeUndefined()
      reference[Symbol.dispose]()
    } finally { await runtime.dispose() }
  })
})
