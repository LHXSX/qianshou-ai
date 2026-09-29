// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceSessionPreview } from '../src/client/session-preview.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

describe('Session previews through the Workspace slot assembly', () => {
  it('publishes exact feature changes into rows and search, retains Host state, and withdraws disposed contributions', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      runtime.ctx.provide('layout', { selectPanel: vi.fn() })
      runtime.releaseWorkspaceSource()
      runtime.remote.provideNamespaces({ directoryPicker: {} })
      const locale = new LocaleRuntime(runtime.ctx)
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      const main = SessionId('main')
      const side = SessionId('side')
      await runtime.sessions.add({ id: main, summary: { displayTitle: 'Main conversation', blank: false, cwd: '/w/alpha' } })
      await runtime.sessions.add({ id: side, summary: { displayTitle: 'fallback', blank: true, cwd: '/w/alpha' } })
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: main }))
      await runtime.workspaces.update((draft) => {
        draft.items = [{ workspaceId: 'alpha' as WorkspaceId, title: 'alpha', path: '/w/alpha', sessionIds: [main, side], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] as never
      })
      await runtime.root.declare({ 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never, SidebarFrame as never)
      const owner = await runtime.mount({ inject: [...inject], apply })
      runtime.renderRoot()
      await screen.findByText('Main conversation')
      expect(screen.queryByText('fallback')).toBeNull()
      let preview: WorkspaceSessionPreview | null = null
      let notify: (sessionId: SessionId) => void = () => {}
      const stop = vi.fn()
      let remove = () => {}
      act(() => {
        remove = runtime.ctx.uiWorkspace.registerSessionPreview({
          read: id => id === side ? preview : null,
          subscribe(listener) { notify = listener; return stop },
        })
      })
      preview = { kind: 'content', title: '@available task', searchText: 'needle submitted', updatedAt: 80 }
      act(() => { notify(side) })
      const row = (await screen.findByText('@available task')).closest('[role="treeitem"]') as HTMLElement
      expect(row.draggable).toBe(false)
      expect(runtime.sessions.list.getSnapshot().byId[side]!.blank).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'needle' } })
      await waitFor(() => { expect(screen.getByText('@available task')).toBeTruthy() })
      act(() => { remove() })
      await waitFor(() => { expect(screen.queryByText('@available task')).toBeNull() })
      expect(stop).toHaveBeenCalledOnce()
      act(() => { notify(side) })
      expect(screen.queryByText('@available task')).toBeNull()
      act(() => { runtime.ctx.uiWorkspace.registerSessionPreview({ read: id => id === side ? preview : null, subscribe: () => stop }) })
      await screen.findByText('@available task')
      await owner.dispose()
      expect(stop).toHaveBeenCalledTimes(2)
      expect(screen.queryByText('@available task')).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })
})
