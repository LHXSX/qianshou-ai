// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketCapabilitiesPanel } from '../src/client/MarketCapabilitiesPanel.tsx'
import { MarketCapabilitiesController, type MarketCapabilityView } from '../src/client/market-capabilities-controller.ts'
import { zh } from '../src/client/marketplace-locales.ts'
import type { EnterMarketConversation } from '../src/client/market-conversation-entry.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const official: MarketCapabilityView = {
  taskType: 'image_generate_v1', capabilityId: 'image.generate', name: '官方出图',
  description: '按一句话生成图片', category: 'image', categoryLabelZh: '图片',
  acceptedInputKinds: ['inline'], defaultInputKind: 'inline', requiredParams: [],
  outputKind: 'artifact_ref', contractVersion: 'task-registry.v1',
  publisherKind: 'official', publisherKinds: ['official'], executionMode: 'cloud',
  availability: 'unavailable', requiresQuote: true,
  executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [],
}

it('groups official and user abilities by Chinese category and leaves paused official service uncallable', () => {
  const user: MarketCapabilityView = { ...official, taskType: 'text_reverse_v1', name: '文字反转',
    description: '反转文字', category: 'text', categoryLabelZh: '文字',
    publisherKind: 'user', publisherKinds: ['user'], executionMode: 'device',
    availability: 'contract_ready' }
  const reload = vi.fn()
  render(<MarketCapabilitiesPanel view={{ capabilities: [official, user], loaded: true,
    loading: false, error: false }} reload={reload} />)
  expect(screen.queryByText('官方出图')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: zh.marketShowUnavailable }))
  expect(screen.getByText('官方出图')).toBeTruthy()
  expect(screen.getByText('文字反转')).toBeTruthy()
  expect(screen.getByText('暂未开放')).toBeTruthy()
  const buttons = screen.getAllByRole('button', { name: zh.marketConversationUse })
  expect(buttons[0]).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByRole('combobox', { name: '筛选能力分类' }), { target: { value: '图片' } })
  expect(screen.getByText('官方出图')).toBeTruthy()
  expect(screen.queryByText('文字反转')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(reload).toHaveBeenCalledOnce()
})

it('shows the real catalog validation failure from an awaited Remote answer and clears it after a corrected refresh', async () => {
  const orderAdapterCapabilities = vi.fn().mockResolvedValueOnce({ ok: false, error: {
    code: 'gateway/internal', message: 'QIANSHOU_CATALOG_market-capabilities-invalid', details: {},
  } }).mockResolvedValueOnce({ ok: true, value: { capabilities: [official] } })
  const controller = new MarketCapabilitiesController({ orderAdapterCapabilities })
  await controller.ensureLoaded()
  expect(controller.store.getSnapshot()).toMatchObject({ error: true, errorKind: 'invalid' })
  const view = render(<MarketCapabilitiesPanel view={controller.store.getSnapshot()} reload={vi.fn()} />)
  expect(screen.getByRole('alert').textContent).toContain('平台能力目录的数据暂不兼容')
  expect(screen.getByRole('alert').textContent).not.toContain('检查连接')
  await controller.reload()
  view.rerender(<MarketCapabilitiesPanel view={controller.store.getSnapshot()} reload={vi.fn()} />)
  expect(controller.store.getSnapshot().errorKind).toBeUndefined()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: zh.marketShowUnavailable }))
  expect(screen.getByText('官方出图')).toBeTruthy()
  controller.dispose()
})

it('routes a file-only skill and the focused goal to the current conversation without rendering an inline quotation form', async () => {
  const files = { ...official, availability: 'contract_ready' as const,
    acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file' }
  const enter = vi.fn<EnterMarketConversation>(async () => true)
  const view = render(<MarketCapabilitiesPanel view={{ capabilities: [files], loaded: true,
    loading: false, error: false }} reload={vi.fn()} enterConversation={enter}
    focusTaskType={files.taskType} focusGoal="检查所附文档" />)
  expect(view.container.querySelector('[data-skill-cover]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.marketConversationUse }))
  await waitFor(() => expect(enter).toHaveBeenCalledOnce())
  expect(enter.mock.calls[0]?.[0]).toEqual({ taskType: files.taskType, expected: files, goal: '检查所附文档' })
  expect(view.container.querySelector('textarea, input[type="file"]')).toBeNull()
  expect(screen.queryByText('获取报价')).toBeNull()
})

it('keeps other cards selectable and cancels the previous choice instead of locking every card during verification', async () => {
  const first = { ...official, availability: 'contract_ready' as const }
  const second = { ...first, taskType: 'second', name: '文件审查' }
  const requests: Array<{ signal: AbortSignal | undefined; finish: (value: boolean) => void }> = []
  const enter = vi.fn<EnterMarketConversation>((_request, signal) => new Promise<boolean>(finish => { requests.push({ signal, finish }) }))
  render(<MarketCapabilitiesPanel view={{ capabilities: [first, second], loaded: true,
    loading: true, error: false }} reload={vi.fn()} enterConversation={enter} />)
  const buttons = screen.getAllByRole('button', { name: zh.marketConversationUse })
  fireEvent.click(buttons[0]!)
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(buttons[1]).toHaveProperty('disabled', false)
  fireEvent.click(buttons[1]!)
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[0]?.signal?.aborted).toBe(true)
  await act(async () => { requests[0]!.finish(false); requests[1]!.finish(true) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getAllByRole('button', { name: zh.marketConversationUse }).every(button => !button.hasAttribute('disabled'))).toBe(true)
})

it('times out a stalled check, cancels its authority and ignores a late success', async () => {
  vi.useFakeTimers()
  const item = { ...official, availability: 'contract_ready' as const }
  const result = Promise.withResolvers<boolean>()
  const enter = vi.fn<EnterMarketConversation>(() => result.promise)
  render(<MarketCapabilitiesPanel view={{ capabilities: [item], loaded: true, loading: false, error: false }}
    reload={vi.fn()} enterConversation={enter} />)
  fireEvent.click(screen.getByRole('button', { name: zh.marketConversationUse }))
  await act(async () => { await Promise.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  expect(enter.mock.calls[0]?.[1]?.aborted).toBe(true)
  expect(screen.getByRole('button', { name: zh.marketConversationUse })).toHaveProperty('disabled', false)
  expect(screen.getByRole('alert').textContent).toBe(zh.marketConversationFailed)
  await act(async () => { result.resolve(true) })
  expect(screen.getByRole('alert').textContent).toBe(zh.marketConversationFailed)
})

it('retains connection failures separately from invalid catalog data, including rejected async calls', async () => {
  const controller = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn()
    .mockRejectedValue(new Error('QIANSHOU_CATALOG_market-capabilities-unavailable')) })
  await controller.ensureLoaded()
  expect(controller.store.getSnapshot()).toMatchObject({ error: true, errorKind: 'unavailable' })
  render(<MarketCapabilitiesPanel view={controller.store.getSnapshot()} reload={vi.fn()} />)
  expect(screen.getByRole('alert').textContent).toContain('检查连接')
  controller.dispose()
})
