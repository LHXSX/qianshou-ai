// @vitest-environment jsdom
/** Home choices retain the existing selection and refusal semantics. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentPresetSeat, type AgentPresetSeatProps } from '../src/client/AgentPresetSeat.tsx'
import { AgentPresetHeader, type AgentPresetHeaderProps } from '../src/client/AgentPresetHeader.tsx'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import { zh } from '../src/client/locales.ts'

const options: AgentPresetSeatState['options'] = [
  { id: 'qianshou-ceo', name: 'CEO 模式', trust: 'system' },
  { id: 'qianshou-skill-creator', name: '技能助手', trust: 'system' },
  { id: 'qianshou-call', name: '调用模式', trust: 'system' },
]
afterEach(() => { cleanup(); vi.unstubAllEnvs() })
function mount(config: { current?: string; roster?: AgentPresetSeatState['options']; refusal?: string; child?: boolean } = {}) {
  const current = config.current ?? 'qianshou-ceo'
  const seat = createSnapshotStore<AgentPresetSeatState>({ current, options: config.roster ?? options,
    showPicker: true, busy: false, error: null, introduce: false })
  const session = { blank: true, origin: config.child ? 'subagent' : 'root',
    retainedBy: { mainView: 1 }, projectionValues: { agentPreset: current } }
  const sessions = createSnapshotStore({ byId: { s1: session } })
  const select = vi.fn(async () => config.refusal)
  const common = { sessionId: 's1', useAgentPresetSeat: bindSnapshotSelector(seat),
    useSessions: bindSnapshotSelector(sessions),
    load: vi.fn(async () => {}), select, t: (key: keyof typeof zh, params?: Record<string, string>) =>
      zh[key].replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match) }
  render(<>
    <AgentPresetSeat {...({ ...common, introduced: vi.fn(),
      useSessionRetainInfo: <Selected,>(selector: (info: { retainedBy: { mainView: number } }) => Selected) =>
        selector({ retainedBy: { mainView: 1 } }),
    } as unknown as AgentPresetSeatProps)} />
    <AgentPresetHeader {...({ ...common, useSessions: bindSnapshotSelector(sessions) } as unknown as AgentPresetHeaderProps)} />
  </>)
  return { select }
}

it('shows each real mode once and selects the actual call preset through the original callback', async () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const { select } = mount()
  const group = screen.getByRole('group', { name: '对话模式' })
  expect(group.className).toContain('homeModes')
  expect(group.querySelectorAll('button > span > strong')).toHaveLength(3)
  expect(group.querySelectorAll('button > span > small')).toHaveLength(3)
  expect(document.querySelector('[data-qianshou-composer-modes]')).toBeNull()
  expect(screen.getAllByRole('button')).toHaveLength(3)
  expect(screen.getByRole('button', { name: /^CEO 模式/ }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: /^调用模式/ }))
  await waitFor(() => { expect(select).toHaveBeenCalledExactlyOnceWith('qianshou-call') })
  expect(screen.queryByRole('button', { name: /智能体类型/ })).toBeNull()
})

it('reports a refused selection and retains the actual current choice', async () => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const { select } = mount({ refusal: '组件尚未载入' })
  fireEvent.click(screen.getByRole('button', { name: /^技能助手/ }))
  await waitFor(() => { expect(select).toHaveBeenCalledExactlyOnceWith('qianshou-skill-creator') })
  expect(await screen.findByText(/组件尚未载入/)).toBeTruthy()
  expect(screen.getByRole('button', { name: /^CEO 模式/ }).getAttribute('aria-pressed')).toBe('true')
})

it.each(['upstream', 'incomplete', 'custom', 'child'] as const)('preserves the existing selection boundary for %s', (kind) => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', kind === 'upstream' ? 'default' : 'qianshou')
  mount(kind === 'incomplete' ? { roster: options.slice(0, 2) }
    : kind === 'custom' ? { current: 'my-preset', roster: [...options, { id: 'my-preset', name: '我的模式', trust: 'user' }] }
      : kind === 'child' ? { child: true } : {})
  expect(screen.queryByRole('group', { name: '对话模式' })).toBeNull()
  if (kind === 'child') expect(screen.queryByRole('button', { name: /智能体类型/ })).toBeNull()
  else expect(screen.getByRole('button', { name: /智能体类型/ })).toBeTruthy()
})
