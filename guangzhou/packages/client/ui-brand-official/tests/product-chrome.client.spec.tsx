// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ProductRail } from '../src/client/ProductRail.tsx'
import { DestinationIcon, DestinationPage } from '../src/client/DestinationPage.tsx'
import { en, zh } from '../src/client/locales.ts'
import { PRODUCT_DESTINATIONS } from '../src/client/destinations.ts'

afterEach(cleanup)

const unused = (() => { throw new Error('unused') }) as never

// The `t` seat is `LocaleKeysOf<'forge.brand'>`, i.e. this package's own
// dictionary **plus the shared common vocabulary** (`close`, `cancel`, …).
// Resolving through both dictionaries is what the real locale chain does, so
// the stub cannot be a bare `key => zh[key]`.
const t = makeTranslate(zh, commonZh)

/**
 * Session standard-kit seats for a session-scope slot component.
 *
 * `ProductRail` occupies `sidebar.right.tab.guide` (scope: `session`), so its
 * props type carries every `SessionStandardProps` member the mounted UI
 * adapters merge in — `useSession`/`sessionId`/`useProjection` (ui-session),
 * `useConversation`/`useInput`/`inputActions` (ui-conversation), `useChat`
 * (ui-chat), `useTrajectory` (ui-trajectory). The rail itself reads **none** of
 * them; it renders only the injected catalog. They are therefore supplied as
 * `never`: calling one is a real defect and must throw here, not be papered
 * over with a fabricated snapshot. Left without an annotation on purpose — the
 * spread hands these seven identities to the call site, which type-checks them
 * against the framework's `SessionStandardProps` while they stay unimplemented.
 */
const sessionKit = {
  useSession: unused,
  sessionId: unused,
  useProjection: unused,
  useConversation: unused,
  useInput: unused,
  inputActions: unused,
  useChat: unused,
  useTrajectory: unused,
}

function mountRail(
  directory: ModelDirectoryState | null,
  load = vi.fn(),
  openModels = vi.fn(),
  openChat = vi.fn(),
  openTasks = vi.fn(),
  selectModel = vi.fn(),
) {
  const store = directory === null ? null : createSnapshotStore(directory)
  return render(<ProductRail
    {...sessionKit}
    t={t}
    directory={store}
    load={load}
    openChat={openChat}
    openModels={openModels}
    openTasks={openTasks}
    selectModel={selectModel}
    useSessions={unused}
    useSessionPendingInteraction={unused}
    usePanelInfo={unused}
    useResource={unused}
    useTabInfo={unused}
    useWorkspaces={unused}
  />)
}

describe('Qianshou product chrome', () => {
  it('lists catalog model names and never invents third-party product labels', () => {
    const load = vi.fn()
    const selectModel = vi.fn()
    mountRail({
      current: { provider: 'local', model: 'qianshou-team' },
      lastUsed: null, autoDecision: null, routable: true, failures: [], status: 'ready', error: null,
      groups: [{
        id: 'local', name: 'Qianshou',
        models: [
          { id: 'qianshou-team', name: '千手·多智能体' },
          { id: 'qianshou-research', name: '千手·研究', description: '长文本' },
        ],
      }],
    }, load, vi.fn(), vi.fn(), vi.fn(), selectModel)
    expect(load).toHaveBeenCalledOnce()
    expect(screen.getByText('千手·多智能体')).toBeTruthy()
    expect(screen.getByText('千手·研究')).toBeTruthy()
    expect(screen.getByText('Qianshou')).toBeTruthy()
    expect(screen.getByText('长文本')).toBeTruthy()
    expect(screen.queryByText('GPT-4o')).toBeNull()
    expect(screen.getByText(zh['rail.modelsHint'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /千手·研究/ }))
    expect(selectModel).toHaveBeenCalledWith('local', 'qianshou-research')
  })

  it('shows the empty catalog copy when no session directory is mounted', () => {
    const openModels = vi.fn()
    const openChat = vi.fn()
    const openTasks = vi.fn()
    mountRail(null, vi.fn(), openModels, openChat, openTasks)
    expect(screen.getByText(zh['rail.modelsEmpty'])).toBeTruthy()
    expect(screen.getByText(zh['rail.tasksEmpty'])).toBeTruthy()
    expect(screen.getByText(zh['rail.toolSearch'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['rail.modelsMore'] }))
    expect(openModels).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh['rail.tasksAll'] }))
    expect(openTasks).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh['rail.toolSearch'] }))
    expect(openChat).toHaveBeenCalledOnce()
  })

  it.each(PRODUCT_DESTINATIONS)('renders an honest empty state for $id', (destination) => {
    const view = render(<DestinationPage
      t={t}
      id={destination.id}
      title={destination.title}
      body={destination.body}
      openChat={vi.fn()}
      openPanel={() => vi.fn()}
      openFiles={() => undefined}
      useSessions={unused}
      useSessionPendingInteraction={unused}
      usePanelInfo={unused}
      useResource={unused}
      useWorkspaces={unused}
    />)
    expect(view.getByRole('heading', { name: zh[destination.title] })).toBeTruthy()
    expect(view.getByText(zh[destination.body])).toBeTruthy()
    expect(view.container.textContent).not.toMatch(/GPT-4o|使用人数/)
    const icon = render(<DestinationIcon kind={destination.title} />)
    expect(icon.container.querySelector('svg')).not.toBeNull()
    icon.unmount()
  })

  it('keeps English product identity without DeepSeek or Fish copy', () => {
    expect(en.name).toBe('Qianshou AI')
    expect(Object.values(en).join(' ')).not.toMatch(/DeepSeek Harness|Fish|DSH Local/)
  })
})
