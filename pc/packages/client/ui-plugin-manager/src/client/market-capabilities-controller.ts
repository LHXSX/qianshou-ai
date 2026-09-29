/** Shanghai's task-type catalog is the single @ entry for official and user abilities. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface MarketCapabilityView {
  taskType: string
  capabilityId: string
  name: string
  description: string
  category: string
  categoryLabelZh: string
  acceptedInputKinds: string[]
  defaultInputKind: string
  requiredParams: string[]
  outputKind: string
  contractVersion: string
  publisherKind: 'official' | 'user'
  publisherKinds: Array<'official' | 'user'>
  executionMode: 'device' | 'cloud'
  availability: 'contract_ready' | 'published_no_dispatch_contract' | 'paused' | 'unavailable'
  formReady?: boolean
  requiresQuote: true
  executionQuotePath: '/api/v8/developer/tasks/estimate' | null
  currency: 'CNY'
  products: Array<{
    productId: string
    publicationId: string
    ownerId: number
    version: string
    salePriceYuan: string
    availableToPurchase: boolean
  }>
}

export interface MarketCapabilitiesView {
  capabilities: MarketCapabilityView[]
  loaded: boolean
  loading: boolean
  error: boolean
  errorKind?: 'invalid' | 'unavailable'
}

/** Whether this entry has a currently exposed conversation call contract. */
export function canCallMarketCapability(item: MarketCapabilityView): boolean {
  return item.availability === 'contract_ready' && item.formReady !== false
    && item.executionQuotePath !== null
    && item.acceptedInputKinds.some(kind => kind === 'inline' || kind === 'multi_file')
}

type RemoteValue<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface MarketCapabilitiesRemote {
  orderAdapterCapabilities(): Promise<RemoteValue<{ capabilities: MarketCapabilityView[] }>>
}

export class MarketCapabilitiesController {
  readonly store = createSnapshotStore<MarketCapabilitiesView>({
    capabilities: [], loaded: false, loading: false, error: false,
  })
  private disposed = false
  private generation = 0
  private pending: Promise<void> | null = null
  private owner: number | null | undefined

  constructor(private readonly remote: MarketCapabilitiesRemote,
    private readonly readOwner?: () => Promise<number | null>) {}
  dispose(): void { this.disposed = true; this.generation += 1 }
  ensureLoaded(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending !== null) return this.pending
    const current = this.store.getSnapshot()
    // A completed failed read is not a usable cached catalog. A later explicit
    // picker request may retry; concurrent requests still share one attempt.
    if (current.loaded && !current.error && !current.loading) return Promise.resolve()
    return this.reload()
  }
  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const pending = this.readCatalog()
    this.pending = pending
    void pending.finally(() => { if (this.pending === pending) this.pending = null })
    return pending
  }
  private async readCatalog(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: false })
    let owner: number | null | undefined
    let ownerRead = false
    try {
      if (this.readOwner !== undefined) {
        owner = await this.readOwner()
        if (this.disposed || generation !== this.generation) return
        ownerRead = true
        if (owner !== this.owner) {
          this.owner = owner
          this.store.set({ capabilities: [], loaded: false, loading: true, error: false })
        }
      }
      const result = await this.remote.orderAdapterCapabilities()
      if (this.disposed || generation !== this.generation) return
      if (!result.ok) throw result.error
      if (this.readOwner !== undefined && await this.readOwner() !== owner) throw new Error('catalog-owner-changed')
      if (this.disposed || generation !== this.generation) return
      this.store.set({ capabilities: result.value.capabilities, loaded: true, loading: false, error: false })
    } catch (failure) {
      const sameOwner = this.readOwner === undefined || ownerRead
        && await this.readOwner().then(current => current === owner, () => false)
      if (this.disposed || generation !== this.generation) return
      if (!sameOwner) this.owner = undefined
      const message = failure !== null && typeof failure === 'object' && 'message' in failure
        ? failure.message : undefined
      this.store.set({ capabilities: sameOwner ? this.store.getSnapshot().capabilities : [], loaded: true, loading: false, error: true,
        errorKind: message === 'QIANSHOU_CATALOG_market-capabilities-invalid' ? 'invalid' : 'unavailable' })
    }
  }
}
