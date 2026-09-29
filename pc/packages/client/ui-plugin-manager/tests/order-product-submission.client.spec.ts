import { expect, it, vi } from 'vitest'
import { OrderPublicationController, type OrderPublicationRemote, type OrderPublicationItem,
  type SellerOrderProduct } from '../src/client/order-publication-controller.ts'

const publicationId = '416dfb88-ea17-4a36-98b5-e1c08edd3c55'
const key = 'skill:user-agents:generic-scan'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  let owner: string | null | undefined = '167'
  let archiveStatus: 'confirmed' | 'pending' | undefined = 'confirmed'
  let fields: Partial<Pick<OrderPublicationItem, 'publicationId' | 'salePriceYuan'
    | 'marketProductId' | 'marketProductStatus'>> = {}
  let ledgerAvailable = true
  const unavailable = async () => ({ ok: false as const, error: { message: 'unused' } })
  const product: SellerOrderProduct = { id: '6651ee49-3c6a-4047-8422-aea5c0c33fbf', publicationId,
    status: 'review', salePriceYuan: '0.00', canApprove: false, reviewReasons: [] }
  const send = vi.fn(async (input: { publicationId: string; salePriceYuan: string }) => ({ ok: true as const,
    value: { ...product, salePriceYuan: input.salePriceYuan } }))
  const remote: OrderPublicationRemote = {
    account: { state: async () => owner === undefined ? { ok: false, error: { message: 'unavailable' } }
      : { ok: true, value: { account: owner === null ? null : { id: owner } } } },
    catalog: { previewInstalledOrderSkillPrice: unavailable, localCandidates: unavailable,
      checkLocalCandidateInstall: unavailable, localOrderPublicationDraft: unavailable,
      saveLocalOrderPublicationDraft: unavailable, submitInstalledOrderSkill: unavailable,
      retryInstalledOrderSkillArchive: unavailable, startOrderReviewSamples: unavailable,
      orderSources: unavailable, selectOrderSource: unavailable, submitSellerOrderProduct: send,
      myOrderSkillPublications: async () => ({ ok: true, value: { items: [{
        source: 'user-agents', name: 'generic-scan', publicationId, status: 'approved', taskType: 'scan_v1',
        artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [], ...fields,
        ...(archiveStatus === undefined ? {} : { archiveStatus }),
      }] } }),
      mySellerOrderProducts: async () => ledgerAvailable ? { ok: true, value: { items: [] } }
        : { ok: false, error: { message: 'unavailable' } },
    },
    manager: { inspect: unavailable, installBundle: unavailable, setBundleEnabled: unavailable, checkBundle: unavailable },
  }
  const controller = new OrderPublicationController(remote)
  return { controller, remote, send, product, owner: (value: typeof owner) => { owner = value },
    archive: (value: typeof archiveStatus) => { archiveStatus = value },
    fields: (value: typeof fields) => { fields = value }, ledger: (value: boolean) => { ledgerAvailable = value } }
}

it('requires explicit canonical zero or bounded price and leaves the approved publication unchanged', async () => {
  const f = fixture()
  await f.controller.refreshSkillPublications()
  const row = f.controller.store.getSnapshot().items[key]
  expect(row?.archiveStatus).toBe('confirmed')
  for (const price of ['', ' ', '0', '0.0', '-0.01', '1.001', '100000.01']) {
    expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', price)).toBe(false)
  }
  expect(f.send).not.toHaveBeenCalled()
  expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')).toBe(true)
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ publicationId, salePriceYuan: '0.00' })
  expect(f.controller.store.getSnapshot().items[key]).toBe(row)
  expect(f.controller.store.getSnapshot().sellerProducts[publicationId]?.status).toBe('review')
  f.controller.dispose()
})

it('does not infer a missing archive, absent ledger or known product marker as permission to submit', async () => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => { f.archive(undefined) },
    (f: ReturnType<typeof fixture>) => { f.archive('pending') },
    (f: ReturnType<typeof fixture>) => { f.ledger(false) },
    (f: ReturnType<typeof fixture>) => { f.fields({ marketProductId: 'existing-product' }) },
    (f: ReturnType<typeof fixture>) => { f.fields({ marketProductStatus: 'rejected' }) },
  ]) {
    const f = fixture(); setup(f)
    await f.controller.refreshSkillPublications()
    expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')).toBe(false)
    expect(f.send).not.toHaveBeenCalled()
    f.controller.dispose()
  }
})

it('retains an already explicit locked sale price without replacing it with a new price', async () => {
  const f = fixture(); f.fields({ salePriceYuan: '12.30' })
  await f.controller.refreshSkillPublications()
  expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')).toBe(false)
  expect(f.send).not.toHaveBeenCalled()
  expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', '12.30')).toBe(true)
  f.controller.dispose()
})

it('disables cached submission synchronously while a fresh ledger is loading', async () => {
  const f = fixture(); await f.controller.refreshSkillPublications()
  const paused = deferred<Awaited<ReturnType<NonNullable<OrderPublicationRemote['catalog']['mySellerOrderProducts']>>>>()
  f.remote.catalog.mySellerOrderProducts = () => paused.promise
  const loading = f.controller.refreshSkillPublications()
  expect(f.controller.store.getSnapshot().refreshing).toBe(true)
  expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')).toBe(false)
  expect(f.send).not.toHaveBeenCalled()
  paused.resolve({ ok: true, value: { items: [] } }); await loading
  f.controller.dispose()
})

it('clears account-owned rows when identity changes before submission or fails to read', async () => {
  for (const owner of ['168', null, undefined]) {
    const f = fixture(); await f.controller.refreshSkillPublications(); f.owner(owner)
    expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')).toBe(false)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.controller.store.getSnapshot().items[key]).toBeUndefined()
    expect(f.controller.store.getSnapshot().busyKey).toBeNull()
    f.controller.dispose()
  }
})

it('ignores replies after owner change, fresh read supersession or disposal without a second submission', async () => {
  for (const transition of ['owner', 'refresh', 'dispose'] as const) {
    const f = fixture(); await f.controller.refreshSkillPublications()
    const paused = deferred<Awaited<ReturnType<NonNullable<OrderPublicationRemote['catalog']['submitSellerOrderProduct']>>>>()
    const send = vi.fn(() => paused.promise); f.remote.catalog.submitSellerOrderProduct = send
    const pending = f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    expect(await f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')).toBe(false)
    if (transition === 'owner') f.owner('168')
    if (transition === 'refresh') await f.controller.refreshSkillPublications()
    if (transition === 'dispose') f.controller.dispose()
    const before = f.controller.store.getSnapshot()
    paused.resolve({ ok: true, value: f.product })
    expect(await pending).toBe(false)
    expect(send).toHaveBeenCalledOnce()
    expect(f.controller.store.getSnapshot().sellerProducts).toEqual({})
    if (transition === 'dispose') expect(f.controller.store.getSnapshot()).toBe(before)
    else expect(f.controller.store.getSnapshot().busyKey).toBeNull()
    f.controller.dispose()
  }
})

it('does not retain another owner reply across a publication refresh', async () => {
  const f = fixture(); await f.controller.refreshSkillPublications()
  const paused = deferred<Awaited<ReturnType<OrderPublicationRemote['catalog']['myOrderSkillPublications']>>>()
  f.remote.catalog.myOrderSkillPublications = () => paused.promise
  const loading = f.controller.refreshSkillPublications(); f.owner('168')
  paused.resolve({ ok: true, value: { items: [{ source: 'user-agents', name: 'generic-scan', publicationId,
    status: 'approved', taskType: 'scan_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [], archiveStatus: 'confirmed' }] } })
  await loading
  expect(f.controller.store.getSnapshot().items[key]).toBeUndefined()
  expect(f.controller.store.getSnapshot().sellerProductsUnavailable).toBe(true)
  f.controller.dispose()
})

it('does not let an old owner finally clear the next owner submission busy token', async () => {
  const f = fixture(); await f.controller.refreshSkillPublications()
  type Reply = Awaited<ReturnType<NonNullable<OrderPublicationRemote['catalog']['submitSellerOrderProduct']>>>
  const oldReply = deferred<Reply>(); const nextReply = deferred<Reply>()
  const send = vi.fn(() => send.mock.calls.length === 1 ? oldReply.promise : nextReply.promise)
  f.remote.catalog.submitSellerOrderProduct = send
  const old = f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')
  await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
  const nextId = '416dfb88-ea17-4a36-98b5-e1c08edd3c56'
  f.owner('168'); f.fields({ publicationId: nextId })
  await f.controller.refreshSkillPublications()
  const next = f.controller.submitSkillProduct('user-agents', 'generic-scan', '0.00')
  await vi.waitFor(() => { expect(send).toHaveBeenCalledTimes(2) })
  oldReply.resolve({ ok: true, value: f.product }); expect(await old).toBe(false)
  expect(f.controller.store.getSnapshot().busyKey).toBe(key)
  expect(f.controller.store.getSnapshot().sellerProducts).toEqual({})
  nextReply.resolve({ ok: true, value: { ...f.product, publicationId: nextId } })
  expect(await next).toBe(true)
  expect(f.controller.store.getSnapshot().busyKey).toBeNull()
  expect(f.controller.store.getSnapshot().sellerProducts[publicationId]).toBeUndefined()
  expect(f.controller.store.getSnapshot().sellerProducts[nextId]?.publicationId).toBe(nextId)
  f.controller.dispose()
})
