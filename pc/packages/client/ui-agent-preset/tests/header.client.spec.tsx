// @vitest-environment jsdom
/** Persistent agent selection labels the real session and announces new-session behavior. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentPresetHeader, type AgentPresetHeaderProps } from '../src/client/AgentPresetHeader.tsx'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

function mount(options: {
  blank?: boolean
  child?: boolean
  showPicker?: boolean
  refusal?: string
  preset?: string
  complete?: boolean
} = {}) {
  const seat = createSnapshotStore<AgentPresetSeatState>({
    showPicker: options.showPicker ?? true, busy: false, error: null, introduce: false,
    current: 'minimal',
    options: [
      { id: 'qianshou-ceo', name: 'CEO 模式', trust: 'system' },
      { id: 'minimal', name: '极简模式', trust: 'system' },
      ...(options.complete ? [
        { id: 'qianshou-skill-creator', name: '技能助手', trust: 'system' as const },
        { id: 'qianshou-call', name: '调用模式', trust: 'system' as const },
      ] : []),
    ],
  })
  const sessions = createSnapshotStore({ byId: {
    s1: { blank: options.blank ?? false, origin: options.child ? 'subagent' : 'root',
      retainedBy: { mainView: 1 }, projectionValues: { agentPreset: options.preset ?? 'qianshou-ceo' } },
  } })
  const select = vi.fn(() => Promise.resolve(options.refusal))
  render(<AgentPresetHeader {...({
    sessionId: 's1', useSessions: bindSnapshotSelector(sessions),
    useAgentPresetSeat: bindSnapshotSelector(seat),
    load: () => Promise.resolve(), select,
    t: (key: keyof typeof zh, params?: Record<string, string>) => zh[key].replace(
      /\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match,
    ),
  } as unknown as AgentPresetHeaderProps)} />)
  return { select }
}

describe('Qianshou persistent agent type', () => {
  it('keeps the original header selector for a started conversation with all three modes', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const { select } = mount({ complete: true })
    expect(document.querySelector('[data-qianshou-composer-modes]')).toBeNull()
    const anchor = screen.getByRole('button', { name: '智能体类型：CEO 模式' })
    expect(anchor.closest('[data-qianshou-preset-header]')).toBeTruthy()
    fireEvent.click(anchor)
    fireEvent.click(screen.getByText('调用模式'))
    await waitFor(() => { expect(select).toHaveBeenCalledExactlyOnceWith('qianshou-call') })
    expect(screen.getByRole('button', { name: '智能体类型：CEO 模式' })).toBeTruthy()
  })

  it('shows the current session preset even when another type is staged', async () => {
    const { select } = mount()
    fireEvent.click(screen.getByRole('button', { name: '智能体类型：CEO 模式' }))
    expect(screen.getAllByText(zh.headerNewSession).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(zh.presetMinimalName))
    await waitFor(() => { expect(select).toHaveBeenCalledWith('minimal') })
    expect(screen.getByRole('button', { name: '智能体类型：CEO 模式' })).toBeTruthy()
  })

  it('selects directly for a blank session without announcing a new conversation', async () => {
    const { select } = mount({ blank: true })
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText(zh.headerNewSession)).toBeNull()
    fireEvent.click(screen.getByText(zh.presetMinimalName))
    await waitFor(() => { expect(select).toHaveBeenCalledWith('minimal') })
  })

  it('keeps child sessions and deployments with selection disabled read-only', () => {
    mount({ child: true })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('CEO 模式')).toBeTruthy()
    cleanup()
    mount({ showPicker: false })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reports a refused selection while keeping the real session label', async () => {
    mount({ blank: true, refusal: '该预设加载失败' })
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText(zh.presetMinimalName))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('该预设加载失败') })
    expect(screen.getByRole('button', { name: '智能体类型：CEO 模式' })).toBeTruthy()
  })

  it('marks a historical plugin creator session as retired', () => {
    mount({ preset: 'qianshou-plugin-creator' })
    expect(screen.getByRole('button', { name: `智能体类型：${zh.retiredCreatorName}` })).toBeTruthy()
  })
})
