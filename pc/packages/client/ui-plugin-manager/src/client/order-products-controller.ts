/** Published order-adapter products are separate from device declarations and SKILL.md files. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

export interface OrderProductView {
  id: string
  publicationId: string
  ownerId: number
  taskType: string
  name: string
  description: string
  category: string
  version: string
  artifactDigest: string
  reviewedSellerRuntimeDigest: string
  salePriceYuan: string
  currency: 'CNY'
  availableToPurchase: boolean
  purchaseBlockReason?: string | null
  archiveDigest: string | null
  archiveSizeBytes: number | null
}

export interface OrderProductsView {
  products: OrderProductView[]
  loaded: boolean
  loading: boolean
  error: 'route_unavailable' | 'unavailable' | 'invalid' | null
  buyerReadiness: { ready: boolean
    reason: 'unsupported-platform' | 'configuration-missing'
    | 'node-offline' | 'client-update' | 'unavailable' | null }
  entitlements: BuyerEntitlementView[]
  entitlementsKnown: boolean
  sellerProductIds?: string[]
  action: { productId: string
    phase: 'purchasing' | 'activating' | 'ready' | 'failed'
    owned: boolean
    reason: OrderPurchaseFailure | null } | null
}

export interface BuyerEntitlementView {
  productId: string
  entitlementId: string
  productName: string
  status: 'pending_install' | 'installed' | 'refunded' | 'unknown'
  deviceInstalled: boolean
  installExpiresAt: string | null
}

export type OrderPurchaseFailure = 'auth' | 'balance_or_changed' | 'node_offline'
  | 'attestor_unavailable' | 'source_invalid' | 'network' | 'refunded' | 'client_update'
  | 'product_not_ready'

export function orderPurchaseFailure(message: string): OrderPurchaseFailure {
  if (message.includes('order-auth-required')) return 'auth'
  if (message.includes('order-purchase-rejected')) return 'balance_or_changed'
  if (message.includes('order-node-contributor-unavailable')) return 'node_offline'
  if (message.includes('order-attestor-unavailable') || message.includes('order-activation-unavailable')) {
    return 'attestor_unavailable'
  }
  if (message.includes('order-install-manifest-invalid') || message.includes('order-local-verification-failed')
    || message.includes('order-install-download-failed')) return 'source_invalid'
  if (message.includes('order-product-unavailable') || message.includes('order-runtime-unavailable')) return 'network'
  if (message.includes('order-install-refunded')) return 'refunded'
  if (message.includes('order-install-not-ready')) return 'product_not_ready'
  return 'client_update'
}

type RemoteValue<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface OrderProductsRemote {
  orderAdapterProducts(): Promise<RemoteValue<{ products: OrderProductView[] }>>
  myPurchasedOrderAdapters?(): Promise<RemoteValue<{ items: BuyerEntitlementView[] }>>
  mySellerOrderProducts?(): Promise<RemoteValue<{ items: { id: string }[] }>>
  orderAdapterBuyerReadiness?(): Promise<RemoteValue<{ ready: boolean
    reason: 'unsupported-platform' | 'configuration-missing' | 'node-offline' | null }>>
  purchaseOrderAdapterProduct?(request: { productId: string
    idempotencyKey: string }): Promise<RemoteValue<{
    productId: string
    entitlementId: string
    status: 'pending_install' | 'installed' | 'refunded'
  }>>
  activatePurchasedOrderAdapter?(request: { productId: string }): Promise<RemoteValue<{
    productId: string
    deviceInstalled: true
    dispatchEligible: true
  }>>
}

export class OrderProductsController {
  readonly store = createSnapshotStore<OrderProductsView>({ products: [], loaded: false, loading: false,
    error: null, action: null, buyerReadiness: { ready: false, reason: 'client-update' },
    entitlements: [], entitlementsKnown: false })
  private disposed = false
  private generation = 0
  private identityRevision = 0
  private owner: number | null | undefined
  private ensurePending: Promise<void> | null = null
  private readonly purchaseKeys = new Map<string, string>()

  constructor(private readonly remote: OrderProductsRemote,
    private readonly readOwner?: () => Promise<number | null>) {}
  dispose(): void { this.disposed = true; this.generation += 1; this.identityRevision += 1 }
  private clearPrivateSnapshot(): void {
    this.store.set({ ...this.store.getSnapshot(), loaded: false, loading: false, error: null,
      entitlements: [], entitlementsKnown: false, sellerProductIds: [], action: null,
      buyerReadiness: { ready: false, reason: 'unavailable' } })
  }
  private adoptOwner(owner: number | null | undefined): void {
    if (owner === this.owner) return
    this.owner = owner
    this.identityRevision += 1
    this.purchaseKeys.clear()
    this.clearPrivateSnapshot()
  }
  private currentRevision(revision: number): boolean {
    return !this.disposed && revision === this.identityRevision
  }
  private currentRead(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }
  /** Clear account state immediately; read only, with no purchase or activation retry.
   * Same-owner reconnects retain idempotency keys for an uncertain prior purchase.
   */
  invalidateIdentityAndReload(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.generation += 1
    this.identityRevision += 1
    this.ensurePending = null
    this.clearPrivateSnapshot()
    return this.reload()
  }
  private async currentIdentity(revision: number, owner: number | null | undefined): Promise<boolean> {
    if (!this.currentRevision(revision)) return false
    if (this.readOwner === undefined) return true
    let observed: number | null
    try { observed = await this.readOwner() }
    catch {
      if (this.currentRevision(revision)) {
        this.generation += 1
        this.identityRevision += 1
        this.clearPrivateSnapshot()
      }
      return false
    }
    if (!this.currentRevision(revision)) return false
    if (observed !== owner) {
      this.generation += 1
      this.adoptOwner(observed)
      return false
    }
    return true
  }
  /** The @ menu and market page share one first catalog read. Explicit refresh stays independent. */
  ensureLoaded(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.ensurePending !== null) return this.ensurePending
    const view = this.store.getSnapshot()
    const pending = view.loaded && view.error === null
      ? this.currentIdentity(this.identityRevision, this.owner).then(current => current ? undefined : this.reload())
      : this.reload()
    this.ensurePending = pending
    void pending.finally(() => { if (this.ensurePending === pending) this.ensurePending = null })
    return pending
  }
  async reload(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: null })
    try {
      if (this.readOwner !== undefined) {
        const owner = await this.readOwner()
        if (!this.currentRead(generation)) return
        this.adoptOwner(owner)
        this.store.set({ ...this.store.getSnapshot(), loading: true, error: null })
      }
      const revision = this.identityRevision
      const owner = this.owner
      const [result, buyer, owned, seller] = await Promise.all([
        this.remote.orderAdapterProducts(),
        this.remote.orderAdapterBuyerReadiness?.().catch(() => ({
          ok: false as const, error: { message: 'READINESS_UNAVAILABLE' },
        })) ?? Promise.resolve({
          ok: false as const, error: { message: 'CLIENT_UPDATE_REQUIRED' },
        }),
        (owner !== null ? this.remote.myPurchasedOrderAdapters?.().catch(() => ({
          ok: false as const, error: { message: 'ENTITLEMENT_UNAVAILABLE' },
        })) : undefined) ?? Promise.resolve({
          ok: false as const, error: { message: 'CLIENT_UPDATE_REQUIRED' },
        }),
        (owner !== null ? this.remote.mySellerOrderProducts?.().catch(() => ({ ok: false as const,
          error: { message: 'SELLER_UNAVAILABLE' } })) : undefined)
          ?? Promise.resolve({ ok: false as const, error: { message: 'SELLER_UNAVAILABLE' } }),
      ])
      if (!this.currentRead(generation)) return
      if (!await this.currentIdentity(revision, owner) || generation !== this.generation) return
      if (!result.ok) throw new Error(result.error.message)
      const buyerReadiness: OrderProductsView['buyerReadiness'] = buyer.ok
        && typeof buyer.value.ready === 'boolean'
        && (buyer.value.reason === null || ['unsupported-platform', 'configuration-missing', 'node-offline']
          .includes(buyer.value.reason))
        ? buyer.value : { ready: false, reason: buyer.ok || this.remote.orderAdapterBuyerReadiness
          ? 'unavailable' : 'client-update' }
      const entitlements = owned.ok && Array.isArray(owned.value.items)
        && owned.value.items.length <= 100
        ? owned.value.items.filter(entry => typeof entry.productId === 'string'
          && typeof entry.entitlementId === 'string' && typeof entry.productName === 'string'
          && ['pending_install', 'installed', 'refunded', 'unknown'].includes(entry.status)
          && typeof entry.deviceInstalled === 'boolean') : []
      const previousAction = this.store.getSnapshot().action
      const action = owned.ok && previousAction?.owned
        && !entitlements.some(item => item.productId === previousAction.productId
          && (item.status === 'pending_install' || item.status === 'installed' || item.status === 'unknown'))
        ? null : previousAction
      this.store.set({ products: result.value.products, loaded: true, loading: false, error: null,
        action, buyerReadiness,
        sellerProductIds: seller.ok && Array.isArray(seller.value.items) && seller.value.items.length <= 1000
          ? seller.value.items.map(item => item.id).filter(id => typeof id === 'string' && id.length <= 128) : [],
        entitlements, entitlementsKnown: owned.ok })
    } catch (error) {
      if (!this.currentRead(generation)) return
      // A failed identity read cannot keep a prior account's private receipts.
      if (this.readOwner !== undefined) {
        this.identityRevision += 1
        this.clearPrivateSnapshot()
      }
      const message = error instanceof Error ? error.message : ''
      const reason = message.includes('order-product-not-found') ? 'route_unavailable'
        : message.includes('order-product-invalid') ? 'invalid' : 'unavailable'
      this.store.set({ ...this.store.getSnapshot(), loaded: true, loading: false, error: reason })
    }
  }

  /** One owner action. The server decides whether its live attestor makes charging safe. */
  async buyAndActivate(productId: string): Promise<void> {
    const revision = this.identityRevision
    const owner = this.owner
    if (!await this.currentIdentity(revision, owner)) return
    const snapshot = this.store.getSnapshot()
    if (!snapshot.loaded || snapshot.loading || snapshot.error !== null || owner === null) return
    if (this.disposed || this.store.getSnapshot().action?.phase === 'purchasing'
      || this.store.getSnapshot().action?.phase === 'activating') return
    const product = this.store.getSnapshot().products.find(item => item.id === productId)
    const previous = this.store.getSnapshot().action
    const durable = this.store.getSnapshot().entitlements.find(item => item.productId === productId)
    if (durable?.status === 'unknown') {
      return
    }
    const alreadyOwned = durable?.status === 'pending_install' || durable?.status === 'installed'
      || (!this.store.getSnapshot().entitlementsKnown && previous?.productId === productId && previous.owned)
    if (!product || !this.store.getSnapshot().buyerReadiness.ready
      || !this.store.getSnapshot().entitlementsKnown
      || (!product.availableToPurchase && !alreadyOwned)) return
    let owned = alreadyOwned
    try {
      if (!owned) {
        this.store.set({ ...this.store.getSnapshot(), action: {
          productId, phase: 'purchasing', owned: false, reason: null } })
        const purchase = this.remote.purchaseOrderAdapterProduct?.bind(this.remote)
        if (!purchase) throw new Error('CLIENT_UPDATE_REQUIRED')
        let key = this.purchaseKeys.get(productId)
        if (key === undefined) {
          key = randomUUID()
          this.purchaseKeys.set(productId, key)
        }
        const result = await purchase({ productId, idempotencyKey: key })
        if (!await this.currentIdentity(revision, owner)) return
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.productId !== productId || !result.value.entitlementId
          || !['pending_install', 'installed', 'refunded'].includes(result.value.status)) {
          throw new Error('CLIENT_UPDATE_REQUIRED')
        }
        if (result.value.status === 'refunded') throw new Error('order-install-refunded')
        owned = true
        this.store.set({ ...this.store.getSnapshot(), entitlements: [
          ...this.store.getSnapshot().entitlements.filter(item => item.productId !== productId),
          { productId, entitlementId: result.value.entitlementId, productName: product.name,
            status: result.value.status, deviceInstalled: false, installExpiresAt: null },
        ] })
      }
      if (!await this.currentIdentity(revision, owner)) return
      this.store.set({ ...this.store.getSnapshot(), action: {
        productId, phase: 'activating', owned: true, reason: null } })
      const activate = this.remote.activatePurchasedOrderAdapter?.bind(this.remote)
      if (!activate) throw new Error('CLIENT_UPDATE_REQUIRED')
      const result = await activate({ productId })
      if (!await this.currentIdentity(revision, owner)) return
      if (!result.ok) throw new Error(result.error.message)
      const receipt: unknown = result.value
      if (receipt === null || typeof receipt !== 'object' || !('productId' in receipt)
        || receipt.productId !== productId || !('deviceInstalled' in receipt) || receipt.deviceInstalled !== true
        || !('dispatchEligible' in receipt) || receipt.dispatchEligible !== true) throw new Error('CLIENT_UPDATE_REQUIRED')
      this.store.set({ ...this.store.getSnapshot(), entitlements: this.store.getSnapshot().entitlements
        .map(item => item.productId === productId
          ? { ...item, status: 'installed' as const, deviceInstalled: true } : item), action: {
        productId, phase: 'ready', owned: true, reason: null } })
    } catch (error) {
      if (!await this.currentIdentity(revision, owner)) return
      const message = error instanceof Error ? error.message : ''
      this.store.set({ ...this.store.getSnapshot(), action: {
        productId, phase: 'failed', owned, reason: orderPurchaseFailure(message) } })
    }
  }
}
