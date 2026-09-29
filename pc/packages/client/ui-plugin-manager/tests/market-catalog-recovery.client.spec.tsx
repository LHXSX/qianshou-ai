// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketCapabilitiesController, type MarketCapabilityView } from '../src/client/market-capabilities-controller.ts'
import { createMarketMentionSource } from '../src/client/market-mention-source.ts'
import { MarketTaskCall } from '../src/client/MarketTaskCall.tsx'
import type { MarketTaskTransport } from '../src/client/market-task-transport.ts'

afterEach(cleanup)

const capability: MarketCapabilityView = {
  taskType: 'recover-text', capabilityId: 'recover-text', name: '恢复测试', description: '处理文字',
  category: 'text', categoryLabelZh: '文字', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
  requiredParams: [], outputKind: 'inline_json', contractVersion: '1', publisherKind: 'user',
  publisherKinds: ['user'], executionMode: 'device', availability: 'contract_ready',
  requiresQuote: true, executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [],
}

it('retries a failed cold catalog on the next picker request, deduplicates it, then caches only success', async () => {
  const pending = Promise.withResolvers<{ ok: true; value: { capabilities: MarketCapabilityView[] } }>()
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(pending.promise)
  const controller = new MarketCapabilitiesController({ orderAdapterCapabilities: read }, async () => 167)
  await controller.ensureLoaded()
  expect(controller.store.getSnapshot()).toMatchObject({ loaded: true, loading: false, error: true })
  const first = controller.ensureLoaded()
  const second = controller.ensureLoaded()
  expect(first).toBe(second)
  const callCapability = vi.fn(() => true)
  const source = createMarketMentionSource({ capabilities: controller, callCapability })
  const candidates = source.candidates({ sessionId: 'original' } as never, {
    query: '恢复', position: 'leading', drilled: false, signal: new AbortController().signal,
  })
  pending.resolve({ ok: true, value: { capabilities: [capability] } })
  expect(await candidates).toEqual([expect.objectContaining({ label: '恢复测试' })])
  await first
  await controller.ensureLoaded()
  expect(read).toHaveBeenCalledTimes(2)
  expect(callCapability).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot()).toMatchObject({ loaded: true, loading: false, error: false })
  controller.dispose()
})

it('does not trust a failed cached catalog while a retry is pending or after another failure', async () => {
  const pending = Promise.withResolvers<never>()
  const read = vi.fn().mockResolvedValueOnce({ ok: true, value: { capabilities: [capability] } })
    .mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(pending.promise)
  const controller = new MarketCapabilitiesController({ orderAdapterCapabilities: read }, async () => 167)
  await controller.reload()
  await controller.reload()
  const source = createMarketMentionSource({ capabilities: controller, callCapability: vi.fn() })
  const retry = controller.ensureLoaded()
  expect(controller.store.getSnapshot()).toMatchObject({ capabilities: [capability], loading: true })
  expect(source.matchSpace?.({} as never, '@恢复测试')).toBeUndefined()
  pending.reject(new Error('still offline'))
  await retry
  expect(controller.store.getSnapshot()).toMatchObject({ capabilities: [capability], error: true, loading: false })
  expect(source.matchSpace?.({} as never, '@恢复测试')).toBeUndefined()
  controller.dispose()
})

it('offers a metadata-only reconnect without clearing a task draft or quoting and dispatching', async () => {
  const createPlan = vi.fn(), quotePlan = vi.fn(), confirmAndPublish = vi.fn()
  const transport = { taskTypes: vi.fn().mockResolvedValue([{ taskType: capability.taskType,
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true }]),
  createPlan, quotePlan, confirmAndPublish } as unknown as MarketTaskTransport
  const refreshCatalog = vi.fn().mockResolvedValue(undefined)
  const view = render(<MarketTaskCall capability={capability} initialGoal="保留这段需求"
    catalogReady={false} catalogStatus="unavailable" refreshCatalog={refreshCatalog} transport={transport} />)
  const input = await screen.findByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '我改好的需求' } })
  fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
  expect(refreshCatalog).toHaveBeenCalledOnce()
  expect(input.value).toBe('我改好的需求')
  expect(createPlan).not.toHaveBeenCalled()
  expect(quotePlan).not.toHaveBeenCalled()
  expect(confirmAndPublish).not.toHaveBeenCalled()
  view.rerender(<MarketTaskCall capability={capability} initialGoal="保留这段需求"
    catalogReady={false} catalogStatus="not-callable" refreshCatalog={refreshCatalog} transport={transport} />)
  expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull()
  expect(screen.getByText(/这项能力暂时不能调用/)).toBeTruthy()
  expect(screen.getByRole('textbox')).toBe(input)
})
