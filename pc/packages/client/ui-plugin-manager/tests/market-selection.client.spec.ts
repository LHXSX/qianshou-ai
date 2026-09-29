import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { MarketCapabilitiesController, type MarketCapabilityView } from '../src/client/market-capabilities-controller.ts'
import { createMarketSelection } from '../src/client/market-selection.ts'
import { createMarketMentionSource } from '../src/client/market-mention-source.ts'

const item: MarketCapabilityView = {
  taskType: 'image.generate', capabilityId: 'image.generate', name: '官方出图', description: '生成图片',
  category: 'image', categoryLabelZh: '图片', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
  requiredParams: [], outputKind: 'artifact', contractVersion: 'task.v1', publisherKind: 'official',
  publisherKinds: ['official'], executionMode: 'cloud', availability: 'contract_ready', requiresQuote: true,
  executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [],
}

function bench() {
  const remote = { orderAdapterCapabilities: vi.fn().mockResolvedValue({ ok: true, value: { capabilities: [item] } }) }
  const catalog = new MarketCapabilitiesController(remote)
  const state = { phase: 'plain', draft: '画一只小猫\n保留我的要求' }
  const write = vi.fn((draft: string) => { state.draft = draft })
  const focus = vi.fn()
  const selectProduct = vi.fn(() => true)
  const session = SessionId('original-session')
  const input = { scope: {}, selectProduct, compose: (reference: string) => {
    if (state.phase !== 'plain' && state.phase !== 'claimed') return false
    const prefix = `${reference} `
    write(state.draft.startsWith(prefix) ? state.draft : prefix + state.draft)
    focus(); return true
  } }
  const selection = createMarketSelection(catalog, id => id === session ? input : undefined)
  return { remote, catalog, state, write, focus, selectProduct, session, selection }
}

it('refreshes the same @ parser catalog and preserves the original draft without invoking a task', async () => {
  const b = bench()
  b.remote.orderAdapterCapabilities.mockResolvedValueOnce({ ok: true, value: { capabilities: [] } })
  await b.catalog.ensureLoaded()
  const call = vi.fn()
  const source = createMarketMentionSource({ capabilities: b.catalog, callCapability: call })
  expect(await b.selection.refreshAndSelect(b.session, item.taskType)).toBe(true)
  expect(b.remote.orderAdapterCapabilities).toHaveBeenCalledTimes(2)
  expect(b.state.draft).toBe('@官方出图 画一只小猫\n保留我的要求')
  expect(b.focus).toHaveBeenCalledOnce()
  expect(await source.matchEnter?.({ sessionId: b.session }, b.state.draft,
    new AbortController().signal, { attachments: 0 })).toMatchObject({ claim: { token: '@官方出图 ' } })
  expect(call).not.toHaveBeenCalled()
})

it('accepts an unchanged cached card after refresh and binds it to the displayed publication version', async () => {
  const b = bench()
  await b.catalog.ensureLoaded()
  expect(await b.selection.refreshAndSelect(b.session, item.taskType, item)).toBe(true)
  expect(b.state.draft).toBe('@官方出图 画一只小猫\n保留我的要求')
})

const product = { productId: 'product-1', publicationId: 'publication-1', ownerId: 167,
  version: '1.2', salePriceYuan: '6.20', availableToPurchase: true }
it.each([
  { ...item, capabilityId: 'different-provider', products: [product] },
  { ...item, contractVersion: 'task.v2', products: [product] },
  { ...item, products: [{ ...product, publicationId: 'different-publication' }] },
  { ...item, products: [{ ...product, version: '1.3' }] },
  { ...item, products: [{ ...product, ownerId: 168 }] },
  { ...item, products: [{ ...product, salePriceYuan: '8.00' }] },
])('refuses a changed cached card identity before composing any draft %#', async (current) => {
  const b = bench()
  const expected = { ...item, products: [product] }
  b.remote.orderAdapterCapabilities.mockResolvedValueOnce({ ok: true, value: { capabilities: [current] } })
  expect(await b.selection.refreshAndSelect(b.session, item.taskType, expected)).toBe(false)
  expect(b.write).not.toHaveBeenCalled()
  expect(b.state.draft).toBe('画一只小猫\n保留我的要求')
})

it('uses text edited during refresh and keeps a repeated selection from adding a second prefix', async () => {
  const b = bench()
  let answer!: (value: unknown) => void
  b.remote.orderAdapterCapabilities.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  const pending = b.selection.refreshAndSelect(b.session, item.taskType)
  b.state.draft = '用户刚刚输入的新要求'
  answer({ ok: true, value: { capabilities: [item] } })
  expect(await pending).toBe(true)
  expect(b.state.draft).toBe('@官方出图 用户刚刚输入的新要求')
  expect(await b.selection.refreshAndSelect(b.session, item.taskType)).toBe(true)
  expect(b.state.draft).toBe('@官方出图 用户刚刚输入的新要求')
})

it.each([
  { ok: false, error: { message: 'unavailable' } },
  { ok: true, value: { capabilities: [] } },
  { ok: true, value: { capabilities: [{ ...item, availability: 'paused' }] } },
  { ok: true, value: { capabilities: [{ ...item, formReady: false }] } },
  { ok: true, value: { capabilities: [item, { ...item, taskType: 'duplicate' }] } },
  { ok: true, value: { capabilities: [item, { ...item, name: '官方出图 高级', taskType: 'prefix' }] } },
])('leaves the draft untouched when the current catalog cannot uniquely execute the choice %#', async (answer) => {
  const b = bench()
  b.remote.orderAdapterCapabilities.mockResolvedValueOnce(answer)
  expect(await b.selection.refreshAndSelect(b.session, item.taskType)).toBe(false)
  expect(b.write).not.toHaveBeenCalled()
  expect(b.focus).not.toHaveBeenCalled()
})

it('keeps a submitting composer and a missing Session untouched', async () => {
  const b = bench()
  b.state.phase = 'submitting'
  expect(await b.selection.refreshAndSelect(b.session, item.taskType)).toBe(false)
  expect(await b.selection.refreshAndSelect(SessionId('different-session'), item.taskType)).toBe(false)
  expect(b.write).not.toHaveBeenCalled()
})

it('only the latest selection writes when catalog reads finish out of order', async () => {
  const b = bench()
  const resolves: Array<(value: unknown) => void> = []
  b.remote.orderAdapterCapabilities.mockImplementation(() => new Promise((resolve) => { resolves.push(resolve) }))
  const first = b.selection.refreshAndSelect(b.session, item.taskType)
  const second = b.selection.refreshAndSelect(b.session, item.taskType)
  resolves[1]!({ ok: true, value: { capabilities: [item] } })
  expect(await second).toBe(true)
  resolves[0]!({ ok: true, value: { capabilities: [item] } })
  expect(await first).toBe(false)
  expect(b.write).toHaveBeenCalledOnce()
})

it('lets the originating composer accept a new selection while an unsent command is selected', async () => {
  const b = bench()
  b.state.phase = 'claimed'
  expect(await b.selection.refreshAndSelect(b.session, item.taskType)).toBe(true)
  expect(b.focus).toHaveBeenCalledOnce()
})


it('refuses an old selector after its provider is disposed while refreshing', async () => {
  const remote = { orderAdapterCapabilities: vi.fn().mockResolvedValue({ ok: true, value: { capabilities: [item] } }) }
  const catalog = new MarketCapabilitiesController(remote)
  await catalog.ensureLoaded()
  let alive = true
  const input = { scope: {}, compose: vi.fn(() => true) }
  const selection = createMarketSelection(catalog, () => alive ? input : undefined)
  let resolve!: (value: unknown) => void
  remote.orderAdapterCapabilities.mockImplementationOnce(() => new Promise((finish) => { resolve = finish }))
  const pending = selection.refreshAndSelect(SessionId('original-session'), item.taskType)
  alive = false; catalog.dispose()
  resolve({ ok: true, value: { capabilities: [item] } })
  expect(await pending).toBe(false)
  expect(input.compose).not.toHaveBeenCalled()
})

it('refuses a new binding for the same Session ID after catalog refresh', async () => {
  const b = bench()
  let scope = {}
  const compose = vi.fn(() => true)
  const selection = createMarketSelection(b.catalog, () => ({ scope, compose }))
  let resolve!: (value: unknown) => void
  b.remote.orderAdapterCapabilities.mockImplementationOnce(() => new Promise((finish) => { resolve = finish }))
  const pending = selection.refreshAndSelect(b.session, item.taskType)
  scope = {}
  resolve({ ok: true, value: { capabilities: [item] } })
  expect(await pending).toBe(false)
  expect(compose).not.toHaveBeenCalled()
})

it('never composes after the picker cancels a hanging check, including a late valid response', async () => {
  const b = bench()
  const response = Promise.withResolvers<unknown>()
  b.remote.orderAdapterCapabilities.mockImplementationOnce(() => response.promise)
  const abort = new AbortController()
  const pending = b.selection.refreshAndSelect(b.session, item.taskType, item, abort.signal)
  abort.abort()
  response.resolve({ ok: true, value: { capabilities: [item] } })
  expect(await pending).toBe(false)
  expect(b.write).not.toHaveBeenCalled()
  expect(b.state.draft).toBe('画一只小猫\n保留我的要求')
})

it('coalesces concurrent displayed catalog reads but still refreshes authority before selection', async () => {
  const b = bench()
  const response = Promise.withResolvers<unknown>()
  b.remote.orderAdapterCapabilities.mockImplementationOnce(() => response.promise)
  const first = b.selection.listAbilities!()
  const second = b.selection.listAbilities!()
  expect(b.remote.orderAdapterCapabilities).toHaveBeenCalledOnce()
  response.resolve({ ok: true, value: { capabilities: [item] } })
  expect(await first).toEqual([item]); expect(await second).toEqual([item])
  expect(await b.selection.listAbilities!()).toEqual([item])
  expect(b.remote.orderAdapterCapabilities).toHaveBeenCalledOnce()
  expect(await b.selection.refreshAndSelect(b.session, item.taskType)).toBe(true)
  expect(b.remote.orderAdapterCapabilities).toHaveBeenCalledTimes(2)
})

it.each(['productId', 'publicationId', 'version', 'ownerId'] as const)('refuses a selected product whose %s changed without touching the draft', async (field) => {
  const b = bench()
  b.remote.orderAdapterCapabilities.mockResolvedValueOnce({ ok: true,
    value: { capabilities: [{ ...item, products: [{ ...product,
      ...field === 'ownerId' ? { ownerId: 168 } : { [field]: 'changed' } }] }] } })
  expect(await b.selection.refreshAndSelect(b.session, item.taskType, undefined, undefined, { product })).toBe(false)
  expect(b.write).not.toHaveBeenCalled()
})

it('selects a multi-file-only contract and revalidates the specific product without buying it', async () => {
  const b = bench()
  const files = { ...item, acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file', products: [product] }
  b.remote.orderAdapterCapabilities.mockResolvedValueOnce({ ok: true, value: { capabilities: [files] } })
  expect(await b.selection.refreshAndSelect(b.session, item.taskType, files, undefined, { product })).toBe(true)
  expect(b.selectProduct).toHaveBeenCalledExactlyOnceWith(files, product, undefined)
  expect(b.state.draft).toBe('画一只小猫\n保留我的要求')
  expect(b.write).not.toHaveBeenCalled()
})

it('never converts an exact product choice into an unbound @ name when no product card is available', async () => {
  const b = bench()
  const compose = vi.fn(() => true)
  const selection = createMarketSelection(b.catalog, () => ({ scope: {}, compose }))
  b.remote.orderAdapterCapabilities.mockResolvedValueOnce({ ok: true,
    value: { capabilities: [{ ...item, products: [product] }] } })
  expect(await selection.refreshAndSelect(b.session, item.taskType, undefined, undefined, { product })).toBe(false)
  expect(compose).not.toHaveBeenCalled()
})

it('forwards the optional original goal to the composer and refuses oversized goals before a catalog read', async () => {
  const b = bench()
  const compose = vi.fn(() => true)
  const scope = {}
  const stable = createMarketSelection(b.catalog, () => ({ scope, compose }))
  expect(await stable.refreshAndSelect(b.session, item.taskType, undefined, undefined, { goal: '检查这份文件' })).toBe(true)
  expect(compose).toHaveBeenCalledExactlyOnceWith('@官方出图', '检查这份文件')
  expect(await stable.refreshAndSelect(b.session, item.taskType, undefined, undefined, { goal: 'x'.repeat(8001) })).toBe(false)
  expect(b.remote.orderAdapterCapabilities).toHaveBeenCalledOnce()
})
