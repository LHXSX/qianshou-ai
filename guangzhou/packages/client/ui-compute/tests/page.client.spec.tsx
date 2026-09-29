// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputePage, type ComputePageProps } from '../src/client/ComputePage.tsx'
import type { ComputeState } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'
import { capability, deferred, draft, status } from './fixtures.ts'

afterEach(cleanup)
function bench(change: Partial<ComputeState> = {}) {
  const state: ComputeState = {
    connection: status, capabilities: [capability], drafts: [], loading: false, saving: false, error: null, ...change,
  }
  const actions = { refresh: vi.fn(async () => {}), saveDraft: vi.fn(async () => true), confirmDraft: vi.fn(async () => true), publishDraft: vi.fn(async () => true) }
  const t = (key: keyof typeof zh, values?: Record<string, string>) => Object.entries(values ?? {})
    .reduce<string>((text, [name, value]) => text.replace(`{${name}}`, value), zh[key])
  const props = { ...actions, t, useCompute: <S,>(select: (snapshot: ComputeState) => S) => select(state) }
  const view = render(<ComputePage {...props as unknown as ComputePageProps} />)
  return {
    actions,
    store: {
      update(mutator: (snapshot: ComputeState) => void) {
        mutator(state)
        view.rerender(<ComputePage {...props as unknown as ComputePageProps} />)
      },
    },
  }
}
function fill() {
  fireEvent.change(screen.getByLabelText(zh.selectedCapability), { target: { value: capability.id } })
  fireEvent.change(screen.getByLabelText(zh.goal), { target: { value: '处理五张图片' } })
  fireEvent.change(screen.getByLabelText(zh.budget), { target: { value: '1.50' } })
}
describe('shared compute workspace', () => {
  it('renders an unconfigured empty state without made-up capability, price, or executable offer', () => {
    bench({ connection: { ...status, configured: false, message: '请配置核心连接' }, capabilities: [] })
    expect(screen.getByText(zh.disconnected)).toBeTruthy()
    expect(screen.getByText(zh.noCapabilities)).toBeTruthy()
    expect(screen.getByText(zh.draftOnly)).toBeTruthy()
    const saveButton = screen.getByRole('button', { name: zh.saveDraft })
    expect(saveButton instanceof HTMLButtonElement && saveButton.disabled).toBe(true)
    expect(screen.queryByText(/0\.50|预计.*分钟|立即执行|确认付款/)).toBeNull()
  })
  it('saves only the explicit requirements and shows the saved budget distinctly from no quote', async () => {
    const { store, actions } = bench()
    fill()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.saveDraft })) })
    expect(actions.saveDraft).toHaveBeenCalledWith(draft.request)
    act(() => { store.update((snapshot) => { snapshot.drafts = [draft] }) })
    expect(screen.getByText(zh.noQuote)).toBeTruthy()
    expect(screen.getByText(zh.draftStatus)).toBeTruthy()
    expect(screen.getByText('￥1.50')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /执行|付款|使用推荐/ })).toBeNull()
  })
  it('shows a locally confirmed draft with a publish control', async () => {
    const { actions } = bench({ drafts: [{ ...draft, authorization: 'approved' }] })
    expect(screen.getByText(zh.draftStatusApproved)).toBeTruthy()
    expect(screen.queryByText(zh.draftStatus)).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.cardPublish })) })
    expect(actions.publishDraft).toHaveBeenCalledWith(draft.id)
  })
  it('shows a published workload identity without a second publish control', () => {
    bench({ drafts: [{ ...draft, authorization: 'approved', workloadId: 'workload-1' as never, request: { ...draft.request, maxNodes: 2 } }] })
    expect(screen.getByText(zh.draftStatusPublished)).toBeTruthy()
    expect(screen.getByText(`${zh.cardWorkload}: workload-1`)).toBeTruthy()
    expect(screen.getByText(zh.nodeCount.replace('{count}', '2'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.cardPublish })).toBeNull()
  })
  it('refreshes, selects a capability tile, and reports invalid save input', async () => {
    const unavailable = { ...capability, id: 'missing', name: '离线能力', available: false, unavailableReason: '节点离线' }
    const { actions } = bench({
      capabilities: [capability, unavailable],
      error: { code: 'INVALID_COMPUTE_RESPONSE', message: 'bad' },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.refresh })) })
    expect(actions.refresh).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(capability.name) }))
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: zh.saveDraft }).closest('form') as HTMLFormElement) })
    expect(screen.getByText(zh.invalid)).toBeTruthy()
    expect(screen.getByText('节点离线')).toBeTruthy()
    expect(screen.queryByText(zh.authRequired)).toBeNull()
  })
  it('blocks save while loading and falls unknown capability names back to the stored id', () => {
    bench({ loading: true, drafts: [{ ...draft, request: { ...draft.request, capabilityId: 'gone' as never } }] })
    expect(screen.getByText(zh.loading)).toBeTruthy()
    expect(screen.getByText('gone')).toBeTruthy()
    const refresh = screen.getByRole('button', { name: zh.refresh })
    expect(refresh instanceof HTMLButtonElement && refresh.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.saveDraft }))
  })
  it('shows a locally declined draft without an execution control', () => {
    bench({ drafts: [{ ...draft, authorization: 'declined' }] })
    expect(screen.getByText(zh.draftStatusDeclined)).toBeTruthy()
    expect(screen.queryByText(zh.draftStatusApproved)).toBeNull()
  })
  it('keeps failed input editable and blocks rapid clicks before the controller publishes saving', async () => {
    const { actions } = bench()
    fill()
    const pending = deferred<boolean>()
    actions.saveDraft.mockReturnValue(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: zh.saveDraft }))
    fireEvent.click(screen.getByRole('button', { name: zh.saveDraft }))
    expect(actions.saveDraft).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(false) })
    expect(screen.getByLabelText(zh.goal)).toHaveProperty('value', '处理五张图片')
    expect(screen.getByLabelText(zh.budget)).toHaveProperty('value', '1.50')
  })
  it('does not call a stale catalog available when refresh fails and displays authorization error', () => {
    bench({ connection: null, capabilities: [], error: { code: 'AUTH_REQUIRED', message: '请重新验证' } })
    expect(screen.getByRole('alert').textContent).toContain(zh.authRequired)
    expect(screen.getByRole('alert').textContent).toContain('请重新验证')
    expect(screen.getByText(zh.unknown)).toBeTruthy()
  })
  it('supports a user node ceiling without representing allocated nodes', async () => {
    const { actions } = bench()
    fill()
    fireEvent.change(screen.getByLabelText(zh.nodes), { target: { value: 'manual' } })
    fireEvent.change(screen.getByLabelText(zh.nodeLimit), { target: { value: '3' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.saveDraft })) })
    expect(actions.saveDraft).toHaveBeenCalledWith({ ...draft.request, maxNodes: 3 })
    expect(screen.getByText(zh.nodesHint)).toBeTruthy()
  })
})
