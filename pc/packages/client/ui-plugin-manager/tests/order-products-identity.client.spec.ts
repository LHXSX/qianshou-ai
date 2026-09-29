import { expect, it, vi } from 'vitest'
import { OrderProductsController, type BuyerEntitlementView, type OrderProductView,
  type OrderProductsRemote } from '../src/client/order-products-controller.ts'

const product: OrderProductView = { id: 'good', publicationId: 'pub', ownerId: 2,
  taskType: 'text_reverse_v1', name: '文字反转', description: '处理文字', category: 'text',
  version: '1.0.0', artifactDigest: 'sha256:a', reviewedSellerRuntimeDigest: 'sha256:b',
  salePriceYuan: '1.00', currency: 'CNY', availableToPurchase: true,
  archiveDigest: 'sha256:c', archiveSizeBytes: 100 }
const owned: BuyerEntitlementView = { productId: 'good', entitlementId: 'owner167-entitlement',
  productName: '文字反转', status: 'pending_install', deviceInstalled: false, installExpiresAt: null }
type OwnedRead = NonNullable<OrderProductsRemote['myPurchasedOrderAdapters']>
type Purchase = NonNullable<OrderProductsRemote['purchaseOrderAdapterProduct']>
type Activate = NonNullable<OrderProductsRemote['activatePurchasedOrderAdapter']>

function fixture(initialOwned: BuyerEntitlementView[] = []) {
  let owner: number | null = 167
  const readOwner = vi.fn(async (): Promise<number | null> => owner)
  const list = vi.fn<OrderProductsRemote['orderAdapterProducts']>(async () => ({ ok: true,
    value: { products: [product] } }))
  const mine = vi.fn<OwnedRead>(async () => ({ ok: true,
    value: { items: owner === 167 ? initialOwned : [] } }))
  const seller = vi.fn<NonNullable<OrderProductsRemote['mySellerOrderProducts']>>(async () => ({ ok: true,
    value: { items: owner === 167 ? [{ id: 'seller167-product' }] : [] } }))
  const purchase = vi.fn<Purchase>(async () => ({ ok: false, error: { message: 'NETWORK_UNCERTAIN' } }))
  const activate = vi.fn<Activate>(async () => ({ ok: true,
    value: { productId: 'good', deviceInstalled: true, dispatchEligible: true } }))
  const controller = new OrderProductsController({ orderAdapterProducts: list,
    orderAdapterBuyerReadiness: async () => ({ ok: true, value: { ready: true, reason: null } }),
    myPurchasedOrderAdapters: mine, mySellerOrderProducts: seller,
    purchaseOrderAdapterProduct: purchase, activatePurchasedOrderAdapter: activate }, readOwner)
  return { controller, readOwner, list, mine, seller, purchase, activate,
    setOwner(value: number | null) { owner = value } }
}

it('clears private state immediately and discards a previous owner read after switching accounts', async () => {
  const f = fixture([owned])
  await f.controller.reload()
  expect(f.controller.store.getSnapshot().sellerProductIds).toEqual(['seller167-product'])
  const delayed = Promise.withResolvers<Awaited<ReturnType<OwnedRead>>>()
  f.mine.mockReturnValueOnce(delayed.promise)
  const oldRead = f.controller.reload()
  await vi.waitFor(() => { expect(f.mine).toHaveBeenCalledTimes(2) })
  f.setOwner(168)
  const changed = f.controller.invalidateIdentityAndReload()
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], entitlementsKnown: false,
    sellerProductIds: [], action: null, buyerReadiness: { ready: false } })
  await changed
  delayed.resolve({ ok: true, value: { items: [owned] } })
  await oldRead
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], entitlementsKnown: true,
    sellerProductIds: [], action: null })
  expect(f.purchase).not.toHaveBeenCalled()
  expect(f.activate).not.toHaveBeenCalled()
  f.controller.dispose()
})

it('checks the owner before returning a cached private catalog', async () => {
  const f = fixture([owned])
  await f.controller.ensureLoaded()
  f.setOwner(168)
  await f.controller.ensureLoaded()
  expect(f.list).toHaveBeenCalledTimes(2)
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], sellerProductIds: [], action: null })
  f.controller.dispose()
})

it('refuses an old-owner click even without an identity event', async () => {
  const f = fixture([owned])
  await f.controller.reload()
  f.setOwner(168)
  await f.controller.buyAndActivate('good')
  expect(f.purchase).not.toHaveBeenCalled()
  expect(f.activate).not.toHaveBeenCalled()
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], entitlementsKnown: false,
    action: null, sellerProductIds: [] })
  f.controller.dispose()
})

it('never activates or copies a late purchase receipt into a different account', async () => {
  const f = fixture()
  const delayed = Promise.withResolvers<Awaited<ReturnType<Purchase>>>()
  f.purchase.mockReturnValueOnce(delayed.promise)
  await f.controller.reload()
  const mutation = f.controller.buyAndActivate('good')
  await vi.waitFor(() => { expect(f.purchase).toHaveBeenCalledOnce() })
  f.setOwner(168)
  await f.controller.invalidateIdentityAndReload()
  delayed.resolve({ ok: true, value: { productId: 'good', entitlementId: 'old-purchase', status: 'pending_install' } })
  await mutation
  expect(f.activate).not.toHaveBeenCalled()
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], action: null, sellerProductIds: [] })
  f.controller.dispose()
})

it('never marks a new account ready from a previous account activation response', async () => {
  const f = fixture([owned])
  const delayed = Promise.withResolvers<Awaited<ReturnType<Activate>>>()
  f.activate.mockReturnValueOnce(delayed.promise)
  await f.controller.reload()
  const mutation = f.controller.buyAndActivate('good')
  await vi.waitFor(() => { expect(f.activate).toHaveBeenCalledOnce() })
  f.setOwner(168)
  await f.controller.invalidateIdentityAndReload()
  delayed.resolve({ ok: true, value: { productId: 'good', deviceInstalled: true, dispatchEligible: true } })
  await mutation
  expect(f.purchase).not.toHaveBeenCalled()
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], action: null })
  f.controller.dispose()
})

it('does not reuse another owner purchase key, and account reads never buy automatically', async () => {
  const f = fixture()
  await f.controller.reload()
  await f.controller.buyAndActivate('good')
  const oldKey = f.purchase.mock.calls[0]?.[0].idempotencyKey
  f.setOwner(168)
  await f.controller.invalidateIdentityAndReload()
  expect(f.purchase).toHaveBeenCalledOnce()
  await f.controller.buyAndActivate('good')
  expect(f.purchase).toHaveBeenCalledTimes(2)
  expect(f.purchase.mock.calls[1]?.[0].idempotencyKey).not.toBe(oldKey)
  expect(f.activate).not.toHaveBeenCalled()
  f.controller.dispose()
})

it('preserves an uncertain purchase key for the same owner reconnect without automatic retry', async () => {
  const f = fixture()
  await f.controller.reload()
  await f.controller.buyAndActivate('good')
  const oldKey = f.purchase.mock.calls[0]?.[0].idempotencyKey
  await f.controller.invalidateIdentityAndReload()
  expect(f.purchase).toHaveBeenCalledOnce()
  await f.controller.buyAndActivate('good')
  expect(f.purchase.mock.calls[1]?.[0].idempotencyKey).toBe(oldKey)
  expect(f.activate).not.toHaveBeenCalled()
  f.controller.dispose()
})

it('clears account receipts on logout and stops querying private ownership', async () => {
  const f = fixture([owned])
  await f.controller.reload()
  f.setOwner(null)
  await f.controller.invalidateIdentityAndReload()
  await f.controller.buyAndActivate('good')
  expect(f.mine).toHaveBeenCalledOnce()
  expect(f.seller).toHaveBeenCalledOnce()
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], entitlementsKnown: false,
    sellerProductIds: [], action: null })
  expect(f.purchase).not.toHaveBeenCalled()
  expect(f.activate).not.toHaveBeenCalled()
  f.controller.dispose()
})

it('fails closed on an identity read failure and permits a later explicit read recovery', async () => {
  const f = fixture([owned])
  await f.controller.reload()
  f.readOwner.mockRejectedValueOnce(new Error('IDENTITY_UNAVAILABLE'))
  await f.controller.buyAndActivate('good')
  expect(f.controller.store.getSnapshot()).toMatchObject({ entitlements: [], entitlementsKnown: false,
    sellerProductIds: [], action: null })
  expect(f.purchase).not.toHaveBeenCalled()
  expect(f.activate).not.toHaveBeenCalled()
  await f.controller.ensureLoaded()
  expect(f.controller.store.getSnapshot().entitlements).toEqual([owned])
  f.controller.dispose()
})

it('allows the original owner explicit purchase and activation exactly once', async () => {
  const f = fixture()
  f.purchase.mockResolvedValueOnce({ ok: true, value: { productId: 'good', entitlementId: 'new', status: 'pending_install' } })
  await f.controller.reload()
  await f.controller.buyAndActivate('good')
  expect(f.purchase).toHaveBeenCalledOnce()
  expect(f.activate).toHaveBeenCalledOnce()
  expect(f.controller.store.getSnapshot()).toMatchObject({ action: { productId: 'good', phase: 'ready', owned: true },
    entitlements: [{ entitlementId: 'new', status: 'installed', deviceInstalled: true }] })
  f.controller.dispose()
})
