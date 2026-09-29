// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { OrderSelection, OrderSidebar, SealedOrderMain, SealedOrderPanel, type OrderSidebarProps, type SealedOrderMainProps } from '../src/client/SealedOrder.tsx'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import type { IntakeDashboardData } from '../src/client/node-status/IntakeDashboard.tsx'
import { zh } from '../src/client/node-status/locales.ts'
import { parseNodeStatus, type NodeStatusSnapshot } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

afterEach(cleanup)

function snapshot(): NodeStatusSnapshot {
  const value = parseNodeStatus(onlineSnapshot())
  if (value === null) throw new Error('Invalid fixture')
  return value
}

function controller(): NodeStatusController {
  return new NodeStatusController({ transport: createStubTransport([]), intervalMs: 60_000 })
}

function settledDashboard(): IntakeDashboardData {
  return {
    schema: 'qianshou.node-dashboard.v1', worker_id: snapshot().connection.workerId ?? '',
    history_scope: 'current_shard_assignment',
    counts: { executions: 2, orders: 2, succeeded: 2, failed: 0, cancelled: 0,
      pending_resolution: 0, avg_success_elapsed_ms: 2 },
    earnings: { currency: 'CNY', settled_node_compute: '0.9750' },
    plugin_calls: null, plugin_calls_note: '', total: 2, limit: 10, offset: 0,
    items: [{ shard_id: 'shard-done-2', workload_id: 'wl-done-2', task_type: 'word_count',
      status: 'done', attempts: 1, dispatched_at: '2026-09-25T00:02:49Z',
      started_at: '2026-09-25T00:02:50Z', completed_at: '2026-09-25T00:02:50Z',
      elapsed_ms: 2, settled_node_compute_cny: '0.4875' }],
  }
}

describe('sealed order surface', () => {
  it('takes no sidebar space while idle, then shows one live row that opens its task', () => {
    const node = controller()
    const openOrder = vi.fn()
    const props = { wide: true, expandSidebar: vi.fn(), controller: node, openOrder,
      t: makeTranslate(zh) } as unknown as OrderSidebarProps
    const view = render(<OrderSidebar {...props} />)
    expect(view.container.querySelector('[data-order-sidebar]')).toBeNull()
    act(() => { node.accept({ kind: 'snapshot', snapshot: { ...snapshot(), tasks: [], current: null } }) })
    expect(view.container.querySelector('[data-order-sidebar]')).toBeNull()
    act(() => { node.accept({ kind: 'snapshot', snapshot: snapshot() }) })
    expect(view.getAllByRole('button')).toHaveLength(1)
    expect(view.getByText('词频统计')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '查看密封任务 word_count' }))
    expect(openOrder).toHaveBeenCalledExactlyOnceWith({ shardId: 'shard-live-1', attempt: 1 })
    const live = snapshot()
    act(() => { node.accept({ kind: 'snapshot', snapshot: { ...live,
      tasks: [...live.tasks, { ...live.tasks[0]!, shardId: 'shard-live-2', attempt: 2 }] } }) })
    expect(view.getAllByRole('button')).toHaveLength(1)
    expect(view.getByLabelText('2 单')).toBeTruthy()
  })

  it('shows observed progress and honest missing commercial facts without any task command', () => {
    const node = controller()
    act(() => { node.accept({ kind: 'snapshot', snapshot: snapshot() }) })
    const props = { controller: node, t: makeTranslate(zh),
      useTabInfo: () => ({ tab: { navigation: { params: { order: { shardId: 'shard-live-1', attempt: 1 } } } } }),
    } as unknown as Parameters<typeof SealedOrderPanel>[0]
    const view = render(<SealedOrderPanel {...props} />)
    expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
    expect(view.getAllByText('word_count')).toHaveLength(2)
    expect(view.getByText('wl-7f2.shard-live-1')).toBeTruthy()
    expect(view.getByText('未收到插件信息')).toBeTruthy()
    expect(view.getAllByText('待平台确认')).toHaveLength(2)
    expect(view.queryByRole('button')).toBeNull()
    expect(view.queryByRole('textbox')).toBeNull()
    act(() => { node.accept({ kind: 'snapshot', snapshot: { ...snapshot(), tasks: [], current: null } }) })
    expect(view.getByText('这项任务当前已不在运行；最终结果与结算状态以平台回执为准。')).toBeTruthy()
    expect(view.queryByRole('progressbar')).toBeNull()
  })

  it('can open the same sealed view in the main column when no Session surface exists', () => {
    const node = controller()
    act(() => { node.accept({ kind: 'snapshot', snapshot: snapshot() }) })
    const selection = new OrderSelection()
    const props = { controller: node, selection, t: makeTranslate(zh) } as unknown as SealedOrderMainProps
    const view = render(<SealedOrderMain {...props} />)
    expect(view.getByText('从左侧智能接单区选择运行中的任务。')).toBeTruthy()
    act(() => { selection.select({ shardId: 'shard-live-1', attempt: 1 }) })
    expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('keeps a completed receipt in task details while idle history and earnings stay off the sidebar', () => {
    const node = controller()
    act(() => { node.accept({ kind: 'snapshot', snapshot: { ...snapshot(), tasks: [], current: null } }) })
    const openOrder = vi.fn()
    const dashboard = settledDashboard()
    const props = { wide: true, expandSidebar: vi.fn(), controller: node, openOrder,
      t: makeTranslate(zh) } as unknown as OrderSidebarProps
    const sidebar = render(<OrderSidebar {...props} />)
    expect(sidebar.container.querySelector('[data-order-sidebar]')).toBeNull()
    expect(sidebar.queryByText('0.9750 CNY')).toBeNull()
    expect(openOrder).not.toHaveBeenCalled()
    sidebar.unmount()

    const selection = new OrderSelection()
    const detail = render(<SealedOrderMain controller={node} selection={selection}
      dashboard={dashboard} t={makeTranslate(zh)} />)
    act(() => { selection.select({ shardId: 'shard-done-2', attempt: 0 }) })
    expect(detail.getByText('词频统计')).toBeTruthy()
    expect(detail.getByText('0.4875 CNY')).toBeTruthy()
    expect(detail.getByText('2 毫秒')).toBeTruthy()
    expect(detail.getByText('wl-done-2')).toBeTruthy()
    expect(detail.queryByRole('progressbar')).toBeNull()
  })
})
