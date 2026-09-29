// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentTasks, AgentTaskList, resetDismissedTasks, type AgentTasksProps } from '../src/client/AgentTasks.tsx'
import { zh, en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  resetDismissedTasks()
})

function fixture(entries: object[] = []) {
  const state = { byId: {}, subagentsByParent: { parent: { state: 'ready', error: null, parentAvailable: true, entries } } }
  const actions = { observe: vi.fn(), refresh: vi.fn(), openAside: vi.fn(), openTasks: vi.fn(), close: vi.fn() }
  const props = { sessionId: 'parent', useSessions: (select: (value: typeof state) => unknown) => select(state),
    t: makeTranslate(zh), ...actions } as unknown as AgentTasksProps
  return { state, props, ...actions }
}

describe('Qianshou agent task window', () => {

  it('hides an empty task trigger for ordinary assistants but retains CEO manual delegation', () => {
    const f = fixture()
    const view = render(<AgentTasks {...f.props} />)
    expect(view.queryByRole('button', { name: zh.tasks })).toBeNull()
    Object.assign(f.state.byId, { parent: { projectionValues: { agentPreset: 'qianshou-ceo' } } })
    view.rerender(<AgentTasks {...f.props} />)
    expect(view.getByRole('button', { name: zh.tasks })).toBeTruthy()
  })

  it('reveals new or restarted child work without repeatedly reopening a dismissed column', () => {
    const f = fixture()
    const view = render(<AgentTasks {...f.props} />)
    expect(f.openTasks).not.toHaveBeenCalled()
    const child = { id: 'child-live', origin: 'subagent', parentId: 'parent', running: true }
    Object.assign(f.state.byId, { 'child-live': child })
    view.rerender(<AgentTasks {...f.props} />)
    expect(f.openTasks).toHaveBeenCalledTimes(1)
    view.rerender(<AgentTasks {...f.props} />)
    expect(f.openTasks).toHaveBeenCalledTimes(1)
    child.running = false
    view.rerender(<AgentTasks {...f.props} />)
    expect(f.openTasks).toHaveBeenCalledTimes(1)
    child.running = true
    view.rerender(<AgentTasks {...f.props} />)
    expect(f.openTasks).toHaveBeenCalledTimes(2)
  })

  it('shows an honest empty state and releases catalog observation on unload', () => {
    const f = fixture()
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByText('CEO 尚未派发子代理任务')).toBeTruthy()
    expect(f.observe).toHaveBeenCalledWith('parent', true)
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    expect(f.refresh).toHaveBeenCalledWith('parent')
    view.unmount()
    expect(f.observe).toHaveBeenLastCalledWith('parent', false)
  })

  it('reveals catalog-only one-shot children that have no root-list row', () => {
    const f = fixture()
    const view = render(<AgentTasks {...f.props} />)
    f.state.subagentsByParent.parent.entries.push({ kind: 'child', id: 'one-shot', activity: 'running', mode: 'one-shot' })
    view.rerender(<AgentTasks {...f.props} />)
    expect(f.openTasks).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('follows real catalog activity and opens the addressed child in the side panel', () => {
    const child = { kind: 'child', id: 'child-1', label: '界面专家 · 设计工作台', activity: 'running', mode: 'continuable', hasChildren: false }
    const f = fixture([child])
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByText(/运行状态： 执行中/)).toBeTruthy()
    child.activity = 'inactive'
    view.rerender(<AgentTaskList {...f.props} close={f.close} />)
    // A settled continuable child is idle, not merely "not running": the label
    // must say which of the distinct states the row is actually in.
    expect(view.getByText(/运行状态： 待命可续/)).toBeTruthy()
    expect(view.queryByText(/运行状态： 暂未运行/)).toBeNull()
    expect(view.queryByText('已完成')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /界面专家/ }))
    expect(f.openAside).toHaveBeenCalledWith({ parentSessionId: 'parent', childSessionId: 'child-1', mode: 'continuable' })
    expect(view.getByText('运行模式： 可继续会话')).toBeTruthy()
  })

  it('names each distinct child state instead of collapsing them into one label', () => {
    const f = fixture([
      { kind: 'child', id: 'live', label: '运行中的子代理', activity: 'running', mode: 'continuable', hasChildren: false },
      { kind: 'child', id: 'idle', label: '待命的子代理', activity: 'inactive', mode: 'continuable', hasChildren: false },
      { kind: 'child', id: 'settled', label: '一次性子代理', activity: 'inactive', mode: 'one-shot', hasChildren: false },
      { kind: 'child', id: 'fresh', label: '刚创建的子代理', activity: 'inactive', mode: 'continuable', hasChildren: false },
    ])
    Object.assign(f.state.byId, {
      fresh: { id: 'fresh', origin: 'subagent', parentId: 'parent', running: false, blank: true },
      settled: { id: 'settled', origin: 'subagent', parentId: 'parent', running: false, blank: false },
    })
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByText(/运行状态： 执行中/)).toBeTruthy()
    expect(view.getByText(/运行状态： 待命可续/)).toBeTruthy()
    expect(view.getByText(/运行状态： 已完成/)).toBeTruthy()
    expect(view.getByText(/运行状态： 从未启动/)).toBeTruthy()
    // One shared sentence for every one of them is the defect under repair.
    expect(view.queryByText(/运行状态： 暂未运行/)).toBeNull()
    expect(view.queryAllByText(/运行状态：/)).toHaveLength(4)
  })

  it('ships both dictionaries with the identical status vocabulary', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of ['running', 'neverStarted', 'resumable', 'finished'] as const) {
      expect(en[key]).not.toBe(zh[key])
      expect(en[key]).not.toBe('')
    }
  })

  it('keeps unavailable records explicit', () => {
    const f = fixture([{ kind: 'diagnostic', reason: 'unavailable' }])
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByRole('alert').textContent).toBe('一条任务记录暂不可用。')
    expect(view.queryByText('CEO 尚未派发子代理任务')).toBeNull()
  })

  it('shows the task text and removes a settled child without opening it', () => {
    const child = { kind: 'child', id: 'child-hide', label: '界面专家 · 设计工作台', activity: 'inactive', mode: 'one-shot', hasChildren: false }
    const f = fixture([child])
    Object.assign(f.state.byId, {
      'child-hide': {
        id: 'child-hide',
        displayTitle: 'child-hide',
        projectionValues: { turnOutline: [{ prompt: '核对侧栏在窄宽度下的止损文案' }] },
      },
    })
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByText('核对侧栏在窄宽度下的止损文案')).toBeTruthy()
    expect(view.getByText('界面专家 · 设计工作台')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    expect(f.openAside).not.toHaveBeenCalled()
    expect(view.queryByText('核对侧栏在窄宽度下的止损文案')).toBeNull()
    const saved = localStorage.getItem('qianshou-dismissed-subagents:parent')
    expect(saved).toContain('child-hide')
    view.unmount()
    resetDismissedTasks()
    localStorage.setItem('qianshou-dismissed-subagents:parent', saved ?? '')
    const again = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(again.queryByText('界面专家 · 设计工作台')).toBeNull()
  })

  it('clears settled children and keeps a running child on the list', () => {
    const f = fixture([
      { kind: 'child', id: 'live', label: '运行中的子代理', activity: 'running', mode: 'continuable', hasChildren: false },
      { kind: 'child', id: 'settled', label: 'WP-C1 侧栏风险止损', activity: 'inactive', mode: 'one-shot', hasChildren: false },
    ])
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByText('WP-C1 侧栏风险止损')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '执行中，结束后可删除' }))
    expect(view.getByText('运行中的子代理')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '清理已结束' }))
    expect(view.queryByText('WP-C1 侧栏风险止损')).toBeNull()
    expect(view.getByText('运行中的子代理')).toBeTruthy()
    expect(view.getByRole('button', { name: '清理已结束' })).toHaveProperty('disabled', true)
  })

  it('uses the task half of a role label when the session has no prompt yet', () => {
    const f = fixture([
      { kind: 'child', id: 'named', label: '界面专家 · 设计工作台', activity: 'inactive', mode: 'continuable', hasChildren: false },
    ])
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByText('界面专家')).toBeTruthy()
    expect(view.getByText('设计工作台')).toBeTruthy()
  })

  it('does not report an empty task list when its catalog could not load', () => {
    const f = fixture()
    f.state.subagentsByParent.parent.state = 'error'
    const view = render(<AgentTaskList {...f.props} close={f.close} />)
    expect(view.getByRole('alert').textContent).toBe('暂时无法读取任务状态，请刷新重试。')
    expect(view.queryByText('CEO 尚未派发子代理任务')).toBeNull()
  })
})
