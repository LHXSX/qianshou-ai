// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NodeIntakePage } from '../src/client/node-status/NodeIntakePage.tsx'
import { OrderSourcesPanel } from '../src/client/node-status/OrderSourcesPanel.tsx'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import type { IntakeOrderSources, IntakeSupplyOrder } from '../src/client/node-status/supply-transport.ts'
import type { IntakeDashboardData } from '../src/client/node-status/IntakeDashboard.tsx'
import { zh } from '../src/client/node-status/locales.ts'
import { parseNodeStatus } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

const controllers: NodeStatusController[] = []
afterEach(() => { cleanup(); controllers.splice(0).forEach(controller => { controller.dispose() }) })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function controller() {
  const value = new NodeStatusController({ transport: createStubTransport([]), intervalMs: 60_000 })
  controllers.push(value)
  return value
}

function sources(enabled = false): IntakeOrderSources {
  return { complete: true, sources: [
    { id: 'builtin:word_count', kind: 'builtin', source: 'builtin', title: '本机词频统计', description: '统计词频',
      category: 'text', loadState: 'active', capabilityId: 'text.transform', taskType: 'word_count', serviceId: 'node',
      selectable: false, eligible: true, enabled, reason: 'ready' },
    { id: 'skill:user-dsh:image', kind: 'skill', source: 'user-dsh', title: '我的图片助手', description: '处理图片',
      category: 'image', loadState: 'active', capabilityId: null, taskType: null, serviceId: null,
      selectable: false, eligible: false, enabled: false, reason: 'platform-task-unmapped' },
    { id: 'skill:user-dsh:approved', kind: 'skill', source: 'user-dsh', title: '已审核文字技能', description: '处理文字',
      category: 'text', loadState: 'active', capabilityId: null, taskType: null, serviceId: null,
      selectable: false, eligible: false, enabled: false, reason: 'publication-approved', authorProductId: 'product-1' },
  ] }
}

const order = (enabled = false) => ({ mode: 'idle' as const, maxConcurrency: 1,
  enabledServiceCount: enabled ? 1 : 0, enabledServiceIds: enabled ? ['node'] : [] })

describe('retained intake display with current authorization', () => {
  it('keeps the selected category, card node, details and scroll through refresh failure and recovery', async () => {
    const pending = deferred<IntakeOrderSources>()
    const listSources = vi.fn().mockResolvedValueOnce(sources()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(sources())
    const transport = { read: async () => order(), set: vi.fn(), setTextService: vi.fn(), listSources }
    const view = render(<NodeIntakePage controller={controller()} t={makeTranslate(zh)} supplyTransport={transport} dashboard={null} />)
    await view.findByText('我的图片助手')
    const panel = view.container.querySelector('[data-order-sources-state]') as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: '图 · 1' }))
    const card = panel.querySelector('[data-order-source-id="skill:user-dsh:image"]') as HTMLElement
    const details = card.querySelector('details')!
    details.open = true
    const page = view.container.querySelector('main')!
    page.scrollTop = 420
    fireEvent.click(within(panel).getByRole('button', { name: zh.intakeRefresh }))
    await waitFor(() => expect(listSources).toHaveBeenCalledTimes(2))
    expect(panel.querySelector('[data-order-source-id="skill:user-dsh:image"]')).toBe(card)
    expect(details.open).toBe(true)
    expect(page.scrollTop).toBe(420)
    expect(within(panel).getByRole('button', { name: '图 · 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(panel).queryByText(zh.orderSourcesLoading)).toBeNull()
    expect(within(panel).getByText(zh.orderSourcesUpdating)).toBeTruthy()
    await act(async () => { pending.reject(new Error('offline')); await pending.promise.catch(() => {}) })
    expect(within(panel).getByText(zh.orderSourcesRefreshFailed)).toBeTruthy()
    expect(panel.querySelector('[data-order-source-id="skill:user-dsh:image"]')).toBe(card)
    fireEvent.click(within(panel).getByRole('button', { name: zh.intakeRefresh }))
    await waitFor(() => expect(panel.getAttribute('data-order-sources-state')).toBe('ready'))
    expect(panel.querySelector('[data-order-source-id="skill:user-dsh:image"]')).toBe(card)
    expect(within(panel).getByRole('button', { name: '图 · 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(page.scrollTop).toBe(420)
  })

  it('marks the changed item while retaining all cards and waits for the fresh source read before enabling again', async () => {
    const pending = deferred<IntakeOrderSources>()
    let enabled = false
    const listSources = vi.fn().mockResolvedValueOnce(sources()).mockReturnValueOnce(pending.promise)
    const setTextService = vi.fn(async (next: boolean) => { enabled = next; return order(next) })
    const view = render(<NodeIntakePage controller={controller()} t={makeTranslate(zh)} dashboard={null}
      supplyTransport={{ read: async () => order(enabled), set: vi.fn(), setTextService, listSources }} />)
    const toggle = await view.findByRole('switch', { name: '本机词频统计' })
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
    const selected = toggle.closest('li')!
    const other = view.container.querySelector('[data-order-source-id="skill:user-dsh:image"]')!
    fireEvent.click(toggle)
    await waitFor(() => expect(listSources).toHaveBeenCalledTimes(2))
    expect(selected.getAttribute('aria-busy')).toBe('true')
    expect(other.getAttribute('aria-busy')).toBe('false')
    expect(view.container.querySelector('[data-order-source-id="skill:user-dsh:image"]')).toBe(other)
    expect(view.queryByText(zh.orderSourcesLoading)).toBeNull()
    expect(toggle.hasAttribute('disabled')).toBe(true)
    fireEvent.click(toggle)
    expect(setTextService).toHaveBeenCalledExactlyOnceWith(true)
    await act(async () => { pending.resolve(sources(true)); await pending.promise })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(toggle.closest('li')).toBe(selected)
    expect(selected.getAttribute('aria-busy')).toBe('false')
  })

  it('uses author activation for a verified author grant whose master switch is off', async () => {
    const c = controller()
    let ownerOn = false
    const activateAuthorSource = vi.fn(async () => { ownerOn = true; return order(true) })
    const data = sources().sources[2]!
    const view = render(<NodeIntakePage controller={c} t={makeTranslate(zh)} dashboard={null} supplyTransport={{
      read: async () => ({ ...order(true), mode: ownerOn ? 'idle' : 'off' }),
      listSources: async () => ({ complete: true, sources: [{ ...data, reason: 'ready', eligible: true,
        enabled: true, serviceId: 'node' }] }),
      set: vi.fn(), setTextService: vi.fn(), activateAuthorSource,
    }} />)
    const enable = await view.findByRole('button', { name: zh.orderAuthorEnable })
    await waitFor(() => expect(enable.hasAttribute('disabled')).toBe(false))
    fireEvent.click(enable)
    await waitFor(() => expect(activateAuthorSource).toHaveBeenCalledExactlyOnceWith(data.id))
    await waitFor(() => expect(view.getByRole('switch', { name: zh.intakeMasterSwitch }).getAttribute('aria-checked')).toBe('true'))
  })

  it.each(['loading', 'unavailable'] as const)('disables cached grant, source selection and author activation while %s', phase => {
    const data = sources()
    const selectable = { ...data.sources[1]!, id: 'bundle:other', kind: 'plugin' as const,
      source: 'profile-bundle' as const, selectable: true, reason: 'not-selected' as const }
    const onToggle = vi.fn(), onSelect = vi.fn(), onActivateAuthor = vi.fn()
    const view = render(<OrderSourcesPanel t={makeTranslate(zh)} phase={phase} data={{ ...data, sources: [...data.sources, selectable] }}
      granted={false} busy={false} busyMessage={null} selectionSupported={true} error={null}
      onRefresh={vi.fn()} onToggle={onToggle} onSelect={onSelect} onActivateAuthor={onActivateAuthor} />)
    const buttons = [view.getByRole('switch', { name: '本机词频统计' }),
      view.container.querySelector('[data-order-source-select]')!, view.container.querySelector('[data-order-source-activate]')!]
    for (const button of buttons) { expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button) }
    expect(onToggle).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onActivateAuthor).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-order-source-eligible="true"]')).toBeNull()
    expect(view.getAllByText(zh.orderSourceQualificationPending)).toHaveLength(4)
  })

  it('drops retained display for a replaced transport and ignores its late response', async () => {
    const old = deferred<IntakeOrderSources>()
    const oldTransport = { read: async () => order(), set: vi.fn(), setTextService: vi.fn(),
      listSources: vi.fn().mockResolvedValueOnce(sources()).mockReturnValueOnce(old.promise) }
    const c = controller()
    const view = render(<NodeIntakePage controller={c} t={makeTranslate(zh)} supplyTransport={oldTransport} dashboard={null} />)
    await view.findByText('我的图片助手')
    fireEvent.click(within(view.container.querySelector('[data-order-sources-state]') as HTMLElement).getByRole('button', { name: zh.intakeRefresh }))
    await waitFor(() => expect(oldTransport.listSources).toHaveBeenCalledTimes(2))
    const next = deferred<IntakeOrderSources>()
    const newTransport = { ...oldTransport, listSources: vi.fn(() => next.promise) }
    view.rerender(<NodeIntakePage controller={c} t={makeTranslate(zh)} supplyTransport={newTransport} dashboard={null} />)
    expect(view.queryByText('我的图片助手')).toBeNull()
    expect(view.getByText(zh.orderSourcesLoading)).toBeTruthy()
    await act(async () => { next.resolve({ complete: true, sources: [] }); await next.promise })
    await act(async () => { old.resolve(sources(true)); await old.promise })
    expect(view.getByText(zh.orderSourcesEmpty)).toBeTruthy()
    expect(view.queryByText('我的图片助手')).toBeNull()
  })

  it('retains historical CNY figures and expanded records after a dashboard refresh fails', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())!
    const c = new NodeStatusController({ transport: createStubTransport([{ kind: 'snapshot', snapshot }]), intervalMs: 60_000 })
    controllers.push(c)
    const dashboard: IntakeDashboardData = { schema: 'qianshou.node-dashboard.v1', worker_id: snapshot.connection.workerId!,
      history_scope: 'current_shard_assignment', counts: { orders: 1, executions: 1, succeeded: 1, failed: 0,
        cancelled: 0, pending_resolution: 0, avg_success_elapsed_ms: 2 }, earnings: { currency: 'CNY', settled_node_compute: '0.4875' },
      plugin_calls: null, plugin_calls_note: '', total: 1, limit: 20, offset: 0,
      items: [{ shard_id: 'shard-1', workload_id: 'task-1', task_type: 'word_count', status: 'done', attempts: 1,
        dispatched_at: null, started_at: null, completed_at: null, elapsed_ms: 2, settled_node_compute_cny: '0.4875' }] }
    const pending = deferred<IntakeDashboardData>()
    const read = vi.fn().mockResolvedValueOnce(dashboard).mockReturnValueOnce(pending.promise)
    const view = render(<NodeIntakePage controller={c} t={makeTranslate(zh)} dashboardTransport={{ read }} />)
    await act(async () => { await c.poll() })
    await view.findByText('0.4875 CNY')
    const record = view.container.querySelector('details.intakeHistoryDetail') ?? view.getByText('task-1').closest('details')!
    ;(record as HTMLDetailsElement).open = true
    fireEvent.click(view.getByRole('button', { name: zh.intakeRefresh }))
    await act(async () => { pending.reject(new Error('offline')); await pending.promise.catch(() => {}) })
    expect(view.getByText('0.4875 CNY')).toBeTruthy()
    expect(view.getByText(zh.intakeDataUnavailable)).toBeTruthy()
    expect(view.getByText('task-1').closest('details')).toBe(record)
    expect((record as HTMLDetailsElement).open).toBe(true)
  })

  it.each(['worker', 'owner'] as const)('clears source and supply authorization for another %s even with the same Host transport', async identity => {
    const snapshot = parseNodeStatus(onlineSnapshot())!
    const c = controller()
    c.accept({ kind: 'snapshot', snapshot })
    const oldSources = deferred<IntakeOrderSources>()
    const newSources = deferred<IntakeOrderSources>()
    const newOrder = deferred<IntakeSupplyOrder>()
    const transport = {
      read: vi.fn().mockResolvedValueOnce(order(true)).mockReturnValueOnce(newOrder.promise),
      listSources: vi.fn().mockResolvedValueOnce(sources(true)).mockReturnValueOnce(oldSources.promise).mockReturnValueOnce(newSources.promise),
      set: vi.fn(), setTextService: vi.fn(),
    }
    const view = render(<NodeIntakePage controller={c} t={makeTranslate(zh)} dashboard={null} supplyTransport={transport} />)
    await view.findByText('我的图片助手')
    const master = view.getByRole('switch', { name: zh.intakeMasterSwitch })
    expect(master.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(view.container.querySelector('[data-order-sources-state]') as HTMLElement).getByRole('button', { name: zh.intakeRefresh }))
    await waitFor(() => expect(transport.listSources).toHaveBeenCalledTimes(2))
    act(() => { c.accept({ kind: 'snapshot', snapshot: {
      ...snapshot, connection: { ...snapshot.connection,
        ...(identity === 'worker' ? { workerId: 'another-worker' } : { ownerId: 168 }) },
    } }) })
    expect(view.queryByText('我的图片助手')).toBeNull()
    expect(view.getByText(zh.orderSourcesLoading)).toBeTruthy()
    expect(master.hasAttribute('disabled')).toBe(true)
    expect(master.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(transport.read).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(transport.listSources).toHaveBeenCalledTimes(3))
    await act(async () => { oldSources.resolve(sources(true)); await oldSources.promise })
    expect(view.queryByText('我的图片助手')).toBeNull()
    await act(async () => {
      newOrder.resolve({ ...order(), mode: 'off' })
      newSources.resolve({ complete: true, sources: [] })
      await Promise.all([newOrder.promise, newSources.promise])
    })
    expect(view.getByText(zh.orderSourcesEmpty)).toBeTruthy()
    expect(master.getAttribute('aria-checked')).toBe('false')
    expect(transport.set).not.toHaveBeenCalled()
    expect(transport.setTextService).not.toHaveBeenCalled()
  })

  it.each(['owner', 'transport'] as const)('clears historical earnings for another %s even when the worker id stays the same', async identity => {
    const snapshot = parseNodeStatus(onlineSnapshot())!
    const c = controller()
    c.accept({ kind: 'snapshot', snapshot })
    const dashboard: IntakeDashboardData = { schema: 'qianshou.node-dashboard.v1', worker_id: snapshot.connection.workerId!,
      history_scope: 'current_shard_assignment', counts: { orders: 1, executions: 1, succeeded: 1, failed: 0,
        cancelled: 0, pending_resolution: 0, avg_success_elapsed_ms: 2 }, earnings: { currency: 'CNY', settled_node_compute: '0.4875' },
      plugin_calls: null, plugin_calls_note: '', total: 1, limit: 20, offset: 0, items: [] }
    const old = deferred<IntakeDashboardData>(), next = deferred<IntakeDashboardData>()
    const first = { read: vi.fn().mockResolvedValueOnce(dashboard).mockReturnValueOnce(old.promise) }
    const second = { read: vi.fn(() => next.promise) }
    const view = render(<NodeIntakePage controller={c} t={makeTranslate(zh)} dashboardTransport={first} />)
    await view.findByText('0.4875 CNY')
    fireEvent.click(view.getByRole('button', { name: zh.intakeRefresh }))
    await waitFor(() => expect(first.read).toHaveBeenCalledTimes(2))
    if (identity === 'owner') {
      first.read.mockReturnValueOnce(next.promise)
      act(() => { c.accept({ kind: 'snapshot', snapshot: { ...snapshot,
        connection: { ...snapshot.connection, ownerId: 168 } } }) })
    } else view.rerender(<NodeIntakePage controller={c} t={makeTranslate(zh)} dashboardTransport={second} />)
    expect(view.queryByText('0.4875 CNY')).toBeNull()
    await act(async () => { old.resolve(dashboard); await old.promise })
    expect(view.queryByText('0.4875 CNY')).toBeNull()
    await act(async () => { next.resolve({ ...dashboard, earnings: { currency: 'CNY', settled_node_compute: '0.0000' } }); await next.promise })
    expect(view.getByText('0.0000 CNY')).toBeTruthy()
  })
})
