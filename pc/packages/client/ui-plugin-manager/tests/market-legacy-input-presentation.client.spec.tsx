// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketTaskCall } from '../src/client/MarketTaskCall.tsx'
import { createMarketInputPresentationLoader, type MarketInputPresentationRemote } from '../src/client/market-legacy-input-presentation.ts'
import { parseMarketInputRule } from '../src/client/market-input-form.ts'
import type { MarketCapabilitiesView, MarketCapabilityView } from '../src/client/market-capabilities-controller.ts'
import type { MarketTaskTransport, MarketTaskType } from '../src/client/market-task-transport.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const identity = { productId: '11111111-1111-4111-8111-111111111111', taskType: 'old_arbitrary_input_v1',
  version: '1.0.0', artifactDigest: `sha256:${'a'.repeat(64)}` }
const schema = { type: 'object', additionalProperties: false, required: ['input_key'],
  properties: { input_key: { type: 'string', title: '输入内容', minLength: 1, maxLength: 16384 } } }
const presentation = { rule: parseMarketInputRule(schema), fixed: { format: 'plain', strict: true, count: 2 } }
const available = { ...identity, status: 'available' as const,
  contentSchemaJson: JSON.stringify(schema), fixedInputJson: JSON.stringify(presentation.fixed) }
const capability: MarketCapabilityView = { taskType: identity.taskType, capabilityId: 'text.custom',
  name: '任意旧技能', description: '真实机器键不叫 text', category: 'text', categoryLabelZh: '文字',
  acceptedInputKinds: ['inline'], defaultInputKind: 'inline', requiredParams: [], outputKind: 'inline_json',
  contractVersion: 'v1', publisherKind: 'user', publisherKinds: ['user'], executionMode: 'device',
  availability: 'contract_ready', requiresQuote: true, executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY',
  products: [{ productId: identity.productId, publicationId: '22222222-2222-4222-8222-222222222222',
    ownerId: 167, version: identity.version, salePriceYuan: '0.50', availableToPurchase: true }] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function loaderFixture() {
  let owner: number | null = 167
  let view: MarketCapabilitiesView = { capabilities: [{ ...capability, products: [...capability.products] }],
    loaded: true, loading: false, error: false }
  const remote = {
    orderAdapterProducts: vi.fn<MarketInputPresentationRemote['orderAdapterProducts']>().mockResolvedValue({ ok: true,
      value: { products: [{ id: identity.productId, taskType: identity.taskType,
        version: identity.version, artifactDigest: identity.artifactDigest }] } }),
    readMarketOrderInputPresentation: vi.fn<MarketInputPresentationRemote['readMarketOrderInputPresentation']>()
      .mockResolvedValue({ ok: true, value: available }),
  } satisfies MarketInputPresentationRemote
  const readOwner = vi.fn(async () => owner)
  return { remote, readOwner, load: createMarketInputPresentationLoader(remote, () => view, readOwner),
    setOwner(next: number | null) { owner = next },
    changeCatalog(change: (view: MarketCapabilitiesView) => MarketCapabilitiesView) { view = change(view) } }
}

function transport(taskType = identity.taskType, outer: { minLength?: number; maxLength?: number } = {}) {
  const contract: MarketTaskType = { taskType, acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true,
    inlineForm: { title: '旧机器输入', mediaType: 'application/json', minLength: 1, maxLength: 16384, ...outer } }
  return {
    taskTypes: vi.fn<MarketTaskTransport['taskTypes']>().mockResolvedValue([contract]),
    createPlan: vi.fn<MarketTaskTransport['createPlan']>().mockResolvedValue('plan_1'),
    quotePlan: vi.fn<MarketTaskTransport['quotePlan']>().mockResolvedValue({ planId: 'plan_1', quoteId: 'quote_1',
      taskType, currency: 'CNY', amountYuan: '0.50', balanceEnough: true, expiresAt: new Date(Date.now() + 60000).toISOString() }),
    confirmAndPublish: vi.fn<MarketTaskTransport['confirmAndPublish']>(),
    findWorkload: vi.fn<MarketTaskTransport['findWorkload']>(), readWorkload: vi.fn<MarketTaskTransport['readWorkload']>(),
    readResult: vi.fn<MarketTaskTransport['readResult']>(), readAcceptance: vi.fn<MarketTaskTransport['readAcceptance']>(),
    decideAcceptance: vi.fn<MarketTaskTransport['decideAcceptance']>(),
  } satisfies MarketTaskTransport
}

it('binds all four source identities from the unique current catalog and exposes the real arbitrary input key', async () => {
  const f = loaderFixture()
  expect(await f.load(identity.taskType, new AbortController().signal)).toEqual(presentation)
  expect(f.remote.orderAdapterProducts).toHaveBeenCalledOnce()
  expect(f.remote.readMarketOrderInputPresentation).toHaveBeenCalledExactlyOnceWith(identity)
})

it.each(['productId', 'taskType', 'version', 'artifactDigest'] as const)('refuses a returned stale %s', async (key) => {
  const f = loaderFixture()
  f.remote.readMarketOrderInputPresentation.mockResolvedValue({ ok: true,
    value: { ...available, [key]: key === 'artifactDigest' ? `sha256:${'b'.repeat(64)}` : 'different' } })
  expect(await f.load(identity.taskType, new AbortController().signal)).toBeNull()
})

it.each(['unloaded', 'loading', 'error', 'duplicate-task', 'duplicate-product', 'missing-product'] as const)('refuses %s catalog before source access', async (kind) => {
  const f = loaderFixture()
  f.changeCatalog(view => ({ ...view,
    loaded: kind !== 'unloaded', loading: kind === 'loading', error: kind === 'error',
    capabilities: kind === 'duplicate-task' ? [...view.capabilities, capability]
      : [{ ...capability, products: kind === 'duplicate-product' ? [...capability.products, ...capability.products]
        : kind === 'missing-product' ? [] : capability.products }] }))
  expect(await f.load(identity.taskType, new AbortController().signal)).toBeNull()
  expect(f.remote.orderAdapterProducts).not.toHaveBeenCalled()
  expect(f.remote.readMarketOrderInputPresentation).not.toHaveBeenCalled()
})

it.each(['owner', 'abort', 'catalog'] as const)('ignores a late source reply after %s changes', async (kind) => {
  const f = loaderFixture()
  const reply = deferred<Awaited<ReturnType<MarketInputPresentationRemote['readMarketOrderInputPresentation']>>>()
  f.remote.readMarketOrderInputPresentation.mockReturnValue(reply.promise)
  const abort = new AbortController()
  const loaded = f.load(identity.taskType, abort.signal)
  await waitFor(() => { expect(f.remote.readMarketOrderInputPresentation).toHaveBeenCalledOnce() })
  if (kind === 'owner') f.setOwner(168)
  if (kind === 'abort') abort.abort()
  if (kind === 'catalog') f.changeCatalog(view => ({ ...view, capabilities: [{ ...capability,
    products: [{ ...capability.products[0]!, version: '2.0.0' }] }] }))
  reply.resolve({ ok: true, value: available })
  expect(await loaded).toBeNull()
})

it('refuses stale or duplicate product rows and stops source access after owner changes during the product read', async () => {
  const f = loaderFixture()
  f.remote.orderAdapterProducts.mockResolvedValue({ ok: true, value: { products: [
    { id: identity.productId, taskType: identity.taskType, version: '2.0.0', artifactDigest: identity.artifactDigest },
  ] } })
  expect(await f.load(identity.taskType, new AbortController().signal)).toBeNull()
  f.remote.orderAdapterProducts.mockResolvedValue({ ok: true, value: { products: Array.from({ length: 2 }, () => ({
    id: identity.productId, taskType: identity.taskType, version: identity.version, artifactDigest: identity.artifactDigest,
  })) } })
  expect(await f.load(identity.taskType, new AbortController().signal)).toBeNull()
  const products = deferred<Awaited<ReturnType<MarketInputPresentationRemote['orderAdapterProducts']>>>()
  f.remote.orderAdapterProducts.mockReturnValue(products.promise)
  const loaded = f.load(identity.taskType, new AbortController().signal)
  f.setOwner(168)
  products.resolve({ ok: true, value: { products: [{ id: identity.productId, taskType: identity.taskType,
    version: identity.version, artifactDigest: identity.artifactDigest }] } })
  expect(await loaded).toBeNull()
  expect(f.remote.readMarketOrderInputPresentation).not.toHaveBeenCalled()
})

it.each([
  { contentSchemaJson: 'not JSON' },
  { contentSchemaJson: JSON.stringify({ ...schema, required: [] }) },
  { contentSchemaJson: JSON.stringify({ ...schema, properties: { a: { type: 'string' }, b: { type: 'string' } } }) },
  { fixedInputJson: '{"input_key":"must not override"}' },
  { fixedInputJson: '{"__proto__":"unsafe"}' },
  { fixedInputJson: '{"nested":{"data":"not primitive"}}' },
  { fixedInputJson: '{"invalid":1e999}' },
  { status: 'unavailable' as const },
])('rejects unsupported response format %# without weakening the legacy contract', async (change) => {
  const f = loaderFixture()
  f.remote.readMarketOrderInputPresentation.mockResolvedValue({ ok: true, value: { ...available, ...change } })
  expect(await f.load(identity.taskType, new AbortController().signal)).toBeNull()
})

it('quotes ordinary Chinese input under an arbitrary signed sample key and merges fixed values without dispatch', async () => {
  const remote = transport()
  const load = vi.fn(async () => presentation)
  render(<MarketTaskCall capability={capability} transport={remote} loadInputPresentation={load} />)
  const input = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '输入内容' })
  expect(screen.queryByLabelText('旧机器输入')).toBeNull()
  expect(remote.createPlan).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '你好千手🙂' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(identity.taskType,
    JSON.stringify({ ...presentation.fixed, input_key: '你好千手🙂' }), expect.any(AbortSignal), {})
  expect(remote.quotePlan).toHaveBeenCalledOnce()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it.each([
  { title: 'UTF-8 byte ceiling', outer: {}, value: '中'.repeat(5460) },
  { title: 'outer maximum including fixed fields', outer: { maxLength: 60 }, value: 'a'.repeat(20) },
  { title: 'outer minimum', outer: { minLength: 80 }, value: 'a' },
])('preserves $title after merging signed fixed fields', async ({ outer, value }) => {
  const remote = transport(identity.taskType, outer)
  render(<MarketTaskCall capability={capability} transport={remote} loadInputPresentation={async () => presentation} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '输入内容' }), { target: { value } })
  const quote = screen.getByRole<HTMLButtonElement>('button', { name: '查看单次报价' })
  expect(quote.disabled).toBe(true)
  fireEvent.click(quote)
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('keeps unavailable legacy machine JSON behind a closed advanced option without automatic quotes', async () => {
  const remote = transport()
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="普通中文需求"
    loadInputPresentation={async () => null} />)
  const advanced = await screen.findByText('高级输入')
  expect(advanced.closest('details')?.open).toBe(false)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '查看单次报价' }).disabled).toBe(true)
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('aborts the old pending presentation when changing tasks and preserves the new controls', async () => {
  const pending = deferred<typeof presentation>()
  const old = transport()
  const next = transport('new_arbitrary_v1')
  const load = vi.fn(async (taskType: string, _signal: AbortSignal) => taskType === identity.taskType ? pending.promise
    : { rule: parseMarketInputRule({ ...schema, required: ['new_key'],
      properties: { new_key: { type: 'string', title: '新内容', minLength: 1, maxLength: 100 } } }), fixed: {} })
  const view = render(<MarketTaskCall capability={capability} transport={old} loadInputPresentation={load} />)
  await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
  const oldSignal = load.mock.calls[0]![1]
  view.rerender(<MarketTaskCall capability={{ ...capability, taskType: 'new_arbitrary_v1' }}
    transport={next} loadInputPresentation={load} />)
  const input = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '新内容' })
  fireEvent.change(input, { target: { value: '只保留新的输入' } })
  expect(oldSignal.aborted).toBe(true)
  await act(async () => { pending.resolve(presentation) })
  expect(screen.queryByRole('textbox', { name: '输入内容' })).toBeNull()
  expect(input.value).toBe('只保留新的输入')
  expect(old.createPlan).not.toHaveBeenCalled()
  expect(next.confirmAndPublish).not.toHaveBeenCalled()
})
