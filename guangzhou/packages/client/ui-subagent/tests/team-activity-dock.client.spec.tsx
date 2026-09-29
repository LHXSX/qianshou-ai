// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TeamActivityDock, type TeamActivityDockProps } from '../src/client/TeamActivityDock.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
const ROOT = 'ceo' as SessionId
const CHILD = 'writer' as SessionId
function fixture() {
  const child: SessionSummary = { id: CHILD, parentId: ROOT, origin: 'subagent', running: true,
    displayTitle: '写作员工 · 产品介绍', blank: false, updatedAt: 1,
    projectionValues: { modelSelection: { lastUsed: { provider: 'cloud-a', model: 'writer-pro' }, next: null },
      employeeActivity: { phase: 'tools', tools: { one: 'web_search' }, update: '正在核对产品资料。', at: 1 } },
  }
  const state: SessionListState = { ids: [ROOT, CHILD], current: ROOT, phase: 'ready',
    byId: { [CHILD]: child }, jobsBySession: {}, currentAddress: undefined,
    subagentsByParent: { [ROOT]: { entries: [{ kind: 'child', id: CHILD, label: child.displayTitle,
      activity: 'running', mode: 'continuable', hasChildren: false }], state: 'ready', parentAvailable: true, error: null } },
  }
  const release = vi.fn()
  const props = { sessionId: ROOT, compact: false, useSessions: <T,>(select: (state: SessionListState) => T): T => select(state),
    t: makeTranslate(zh), observe: vi.fn(() => release), openChild: vi.fn(), removeChild: vi.fn(() => Promise.resolve()), refresh: vi.fn(),
  } as unknown as TeamActivityDockProps
  return { state, props, release }
}

describe('compact team dock', () => {
  it('keeps new work folded in a narrow column until the user opens it', () => {
    const { props, state } = fixture()
    const view = render(<TeamActivityDock {...props} compact />)
    expect(screen.queryByRole('complementary', { name: '团队动态' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开团队：1 人执行中，共 1 项任务' }))
    const panel = screen.getByRole('complementary', { name: '团队动态' })
    expect(view.container.contains(panel)).toBe(true)
    expect(within(panel).getByText('正在核对产品资料。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起为状态条' }))
    state.byId = { ...state.byId, [CHILD]: { ...state.byId[CHILD]!, updatedAt: 2 } }
    view.rerender(<TeamActivityDock {...props} compact />)
    expect(screen.queryByRole('complementary', { name: '团队动态' })).toBeNull()
  })
  it('opens on delegated work with real tool, model and public progress', () => {
    const { props } = fixture()
    render(<TeamActivityDock {...props} />)
    const panel = screen.getByRole('complementary', { name: '团队动态' })
    expect(within(panel).getByText('写作员工 · 产品介绍')).toBeTruthy()
    expect(within(panel).getByText('web_search')).toBeTruthy()
    expect(within(panel).getByText('cloud-a / writer-pro')).toBeTruthy()
    expect(within(panel).getByText('正在核对产品资料。')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '记录 ↗' }))
    expect(props.openChild).toHaveBeenCalledWith({ parentSessionId: ROOT, childSessionId: CHILD, mode: 'continuable' })
  })
  it('keeps a count rail after collapse and does not reopen on routine progress', () => {
    const { props, state } = fixture()
    const view = render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '收起为状态条' }))
    state.byId = { ...state.byId, [CHILD]: { ...state.byId[CHILD]!, updatedAt: 2 } }
    view.rerender(<TeamActivityDock {...props} />)
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.getByRole('button', { name: '展开团队：1 人执行中，共 1 项任务' })).toBeTruthy()
  })
  it('restores keyboard focus to the rail on Escape and links the toggle to its panel', () => {
    const { props } = fixture()
    render(<TeamActivityDock {...props} />)
    const panel = screen.getByRole('complementary', { name: '团队动态' })
    const details = within(panel).getByRole('button', { name: '记录 ↗' })
    details.focus()
    fireEvent.keyDown(details, { key: 'Escape' })
    const rail = screen.getByRole('button', { name: '展开团队：1 人执行中，共 1 项任务' })
    expect(document.activeElement).toBe(rail)
    expect(rail.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(rail.getAttribute('aria-controls')!)).toBe(panel)
    expect(panel.hidden).toBe(true)
    fireEvent.click(rail)
    const collapse = screen.getByRole('button', { name: '收起为状态条' })
    expect(document.activeElement).toBe(collapse)
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(collapse.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.hidden).toBe(false)
    fireEvent.click(collapse)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开团队：1 人执行中，共 1 项任务' }))
  })
  it('does not move focus from the composer when new work automatically reveals the monitor', () => {
    const { props, state } = fixture()
    const view = render(<><input aria-label="任务输入" /><TeamActivityDock {...props} /></>)
    fireEvent.click(screen.getByRole('button', { name: '收起为状态条' }))
    const input = screen.getByRole('textbox', { name: '任务输入' })
    input.focus()
    const id = 'reviewer' as SessionId
    state.byId = { ...state.byId, [id]: { ...state.byId[CHILD]!, id, displayTitle: '审校员工', updatedAt: 3 } }
    view.rerender(<><input aria-label="任务输入" /><TeamActivityDock {...props} /></>)
    expect(screen.getByRole('complementary', { name: '团队动态' })).toBeTruthy()
    expect(document.activeElement).toBe(input)
  })
  it('marks completion on the collapsed rail without declaring CEO acceptance', () => {
    const { props, state } = fixture()
    const view = render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '收起为状态条' }))
    state.byId = { ...state.byId, [CHILD]: { ...state.byId[CHILD]!, running: false,
      projectionValues: { employeeActivity: { phase: 'completed', tools: {}, update: '文章草稿完成。', at: 2 } } } }
    view.rerender(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '展开团队：0 人执行中，共 1 项任务' }))
    expect(screen.getByText('本轮完成 · 待命')).toBeTruthy()
    expect(screen.queryByText('验收通过')).toBeNull()
  })
  it('automatically reveals a newly assigned worker after collapse', () => {
    const { props, state } = fixture()
    const view = render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '收起为状态条' }))
    const id = 'reviewer' as SessionId
    state.byId = { ...state.byId, [id]: { ...state.byId[CHILD]!, id, displayTitle: '审校员工', updatedAt: 3 } }
    view.rerender(<TeamActivityDock {...props} />)
    expect(screen.getByRole('complementary')).toBeTruthy()
    expect(screen.getByText('审校员工')).toBeTruthy()
  })
  it('never includes another team and releases catalog observation on unmount', () => {
    const { props, state, release } = fixture()
    const id = 'unrelated' as SessionId
    state.byId = { ...state.byId, [id]: { ...state.byId[CHILD]!, id, parentId: 'other' as SessionId,
      displayTitle: '其他项目员工' } }
    const view = render(<TeamActivityDock {...props} />)
    expect(screen.queryByText('其他项目员工')).toBeNull()
    view.unmount()
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('shows failures and retains a retry control when catalog loading fails', () => {
    const { props, state } = fixture()
    state.subagentsByParent = { [ROOT]: { ...state.subagentsByParent[ROOT]!, state: 'error', error: null } }
    render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '任务目录同步失败，点击重试' }))
    expect(props.refresh).toHaveBeenCalledWith(ROOT)
  })
  it('removes an ended row only from the monitor, persists it, and can restore its original execution record', () => {
    const { props, state } = fixture()
    state.byId[CHILD] = { ...state.byId[CHILD]!, running: false, updatedAt: 10,
      projectionValues: { employeeActivity: { phase: 'completed', tools: {}, update: '可审计的结果', at: 10 } } }
    const view = render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '展开团队：0 人执行中，共 1 项任务' }))
    fireEvent.click(screen.getByRole('button', { name: '仅隐藏 写作员工 · 产品介绍 的记录' }))
    expect(screen.queryByText('可审计的结果')).toBeNull()
    expect(screen.getByText('暂无显示的记录')).toBeTruthy()
    expect(screen.getByRole('button', { name: '恢复 1 条记录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy()
    expect(state.byId[CHILD]?.projectionValues?.employeeActivity?.update).toBe('可审计的结果')
    expect(props.openChild).not.toHaveBeenCalled()
    view.unmount()
    render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '展开团队：0 人执行中，共 0 项任务' }))
    expect(screen.queryByText('可审计的结果')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '恢复 1 条记录' }))
    expect(screen.getByText('可审计的结果')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '记录 ↗' }))
    expect(props.openChild).toHaveBeenCalledWith({ parentSessionId: ROOT, childSessionId: CHILD, mode: 'continuable' })
  })

  it('keeps display hiding separate from confirmed persisted team removal', async () => {
    const { props, state } = fixture()
    state.byId[CHILD] = { ...state.byId[CHILD]!, running: false, projectionValues: {} }
    state.subagentsByParent = { ...state.subagentsByParent, [ROOT]: { ...state.subagentsByParent[ROOT]!, entries: [{ kind: 'child', id: CHILD,
      label: '写作员工 · 产品介绍', activity: 'inactive', mode: 'continuable', hasChildren: false }] } }
    render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '展开团队：0 人执行中，共 1 项任务' }))
    expect(screen.getByRole('button', { name: '仅隐藏 写作员工 · 产品介绍 的记录' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '将 写作员工 · 产品介绍 移出团队' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/原会话和执行记录保留/)).toBeTruthy()
    expect(props.removeChild).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '确认移出团队' })) })
    expect(props.removeChild).toHaveBeenCalledWith({ parentSessionId: ROOT, childSessionId: CHILD, mode: 'continuable' })
    expect(localStorage.length).toBe(0)
  })

  it('cleans finished records in one reversible batch while keeping active and blocked work visible', () => {
    const { props, state } = fixture()
    const phases = ['idle', 'completed', 'error', 'stopped', 'blocked'] as const
    for (const [i, phase] of phases.entries()) {
      const id = `old-${i}` as SessionId
      state.byId[id] = { ...state.byId[CHILD]!, id, displayTitle: phase, running: false, updatedAt: 10+i,
        projectionValues: { employeeActivity: { phase, tools: {}, update: `结果 ${phase}`, at: 10+i } } }
    }
    render(<TeamActivityDock {...props} />)
    expect(screen.queryByRole('button', { name: '仅隐藏 写作员工 · 产品介绍 的记录' })).toBeNull()
    expect(screen.queryByRole('button', { name: '从面板移除 blocked 的记录' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '隐藏已结束记录' }))
    expect(screen.getByText('写作员工 · 产品介绍')).toBeTruthy()
    expect(screen.getByText('结果 blocked')).toBeTruthy()
    expect(screen.queryByText('结果 error')).toBeNull()
    expect(screen.getByRole('button', { name: '恢复 4 条记录' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    for (const phase of phases) expect(screen.getByText(`结果 ${phase}`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '恢复 4 条记录' })).toBeNull()
  })

  it('shows a reused employee on new activity and never reapplies its retired hidden version', async () => {
    const { props, state } = fixture()
    state.byId[CHILD] = { ...state.byId[CHILD]!, running: false, projectionValues: {} }
    const view = render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '展开团队：0 人执行中，共 1 项任务' }))
    fireEvent.click(screen.getByRole('button', { name: '隐藏已结束记录' }))
    expect(screen.queryByText('写作员工 · 产品介绍')).toBeNull()
    state.byId = { ...state.byId, [CHILD]: { ...state.byId[CHILD]!, running: true } }
    await act(async () => { view.rerender(<TeamActivityDock {...props} />) })
    expect(screen.getByText('写作员工 · 产品介绍')).toBeTruthy()
    state.byId = { ...state.byId, [CHILD]: { ...state.byId[CHILD]!, running: false } }
    view.rerender(<TeamActivityDock {...props} />)
    expect(screen.getByText('写作员工 · 产品介绍')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '隐藏已结束记录' }))
    state.byId = { ...state.byId, [CHILD]: { ...state.byId[CHILD]!, updatedAt: 20 } }
    view.rerender(<TeamActivityDock {...props} />)
    expect(screen.getByText('写作员工 · 产品介绍')).toBeTruthy()
  })

  it('does not offer removal while state is reconnecting and reports persistence failure inline', () => {
    const { props, state } = fixture()
    state.byId[CHILD] = { ...state.byId[CHILD]!, running: false, projectionValues: {} }
    state.phase = 'pending'
    const view = render(<TeamActivityDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '展开团队：0 人执行中，共 1 项任务' }))
    expect(screen.queryByRole('button', { name: '隐藏已结束记录' })).toBeNull()
    state.phase = 'ready'
    view.rerender(<TeamActivityDock {...props} />)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    fireEvent.click(screen.getByRole('button', { name: '隐藏已结束记录' }))
    expect(screen.getByRole('alert').textContent).toBe('显示偏好未保存，刷新后可能恢复。')
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy()
  })

})
