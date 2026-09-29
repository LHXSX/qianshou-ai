/** One owner click prepares a local order source; platform publication remains a separate receipt. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocalPluginCandidateView } from './local-plugin-candidates-controller.ts'
import type { PublicationLifecycleAction } from './publication-lifecycle.ts'

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }
type Phase = 'checking' | 'installing' | 'enabling' | 'self-testing' | 'archive-pending' | 'submitted' | 'approved' | 'rejected' | 'ready' | 'blocked' | 'withdrawn' | 'delisted' | 'archived'
export type OrderPublicationReason = 'candidate-changed' | 'adapter-missing' | 'installed-changed'
  | 'review-required' | 'install-failed' | 'restart-required' | 'activation-failed' | 'sample-failed'
  | 'already-authorized' | 'inventory-incomplete' | 'skill-not-found' | 'file-input-unsupported'
  | 'platform-task-unmapped' | 'remote-unavailable' | 'order-auth-required'
  | 'runtime-unavailable' | 'local-verification-failed' | 'platform-route-unavailable'
  | 'sample-insufficient'
  | 'platform-unavailable' | 'publication-conflict' | 'skill-import-unavailable' | 'node-contributor-unavailable'
interface PublicationCommerce {
  readonly salePriceYuan?: string | null
  readonly marketProductId?: string | null
  readonly marketProductStatus?: 'review' | 'published' | 'rejected' | 'suspended' | null
}
export interface PublicationLifecycle {
  readonly state: 'active' | 'withdrawn' | 'delisted'
  readonly archived: boolean
  readonly revision: number
  readonly allowedActions: readonly PublicationLifecycleAction[]
  readonly blockingReasons: readonly string[]
}
export interface PublicationLifecycleReceipt extends PublicationCommerce {
  readonly publicationId: string
  readonly ownerId: number
  readonly name: string
  readonly status: 'review' | 'approved' | 'rejected'
  readonly lifecycle: PublicationLifecycle
}
export interface PublicationLifecycleRequest {
  readonly recordKey: string
  readonly publicationId: string
  readonly expectedRevision: number
  readonly action: PublicationLifecycleAction
}
function publicationPhase(status: 'review' | 'approved' | 'rejected', archiveStatus: 'confirmed' | 'pending' | undefined,
  lifecycle: PublicationLifecycle | undefined): Phase {
  if (lifecycle?.archived) return 'archived'
  if (lifecycle?.state === 'withdrawn') return 'withdrawn'
  if (lifecycle?.state === 'delisted') return 'delisted'
  return status === 'review' ? archiveStatus === 'confirmed' ? 'submitted' : 'archive-pending' : status
}
function commerceFields(row: PublicationCommerce): PublicationCommerce {
  return { ...(row.salePriceYuan === undefined ? {} : { salePriceYuan: row.salePriceYuan }),
    ...(row.marketProductId === undefined ? {} : { marketProductId: row.marketProductId }),
    ...(row.marketProductStatus === undefined ? {} : { marketProductStatus: row.marketProductStatus }) }
}
export interface OrderPublicationItem extends PublicationCommerce { readonly phase: Phase; readonly reason?: OrderPublicationReason;
  readonly runtimeKind?: 'native-h3'
  readonly displayName?: string
  readonly lifecycle?: PublicationLifecycle
  readonly publicationId?: string; readonly reviewReasons?: readonly string[]; readonly reviewSyncStale?: boolean;
  readonly priceYuan?: string
  readonly evidenceStatus?: Readonly<Record<string, 'missing' | 'valid' | 'invalid'>>
  readonly archiveStatus?: 'confirmed' | 'pending'
  readonly packageMigrationRequired?: boolean; readonly archiveError?: string;
  readonly reviewSampleStatus?: 'blocked' | 'pending' | 'running' | 'verified' | 'evidence_deposited' | 'independent_sample_required';
  readonly mediaEvidenceStatus?: 'missing' | 'valid' | 'invalid'; readonly reviewSampleError?: string }
export interface SkillOrderReviewInput {
  displayName: string; purpose: string; configuration: string; priceYuan: string
  salePriceYuan?: string
  expectedArtifactDigest?: string; expectedTaskDefinitionSha256?: string
}
export interface OrderSkillPricePreview {
  taskType: string; artifactDigest: string; priceYuan: string; settingsVersion: number;
  taskDefinitionSha256: string
}
export interface SellerOrderProduct {
  id: string; publicationId: string; status: 'review' | 'published' | 'rejected' | 'suspended';
  salePriceYuan: string; canApprove: boolean; reviewReasons: string[]
}
export interface OrderPublicationReview {
  readonly candidate: LocalPluginCandidateView
  readonly status: 'loading' | 'ready' | 'saving' | 'saved' | 'error'
  readonly name: string
  readonly purpose: string
  readonly category: 'text' | 'data' | 'automation'
  readonly configuration: string
  readonly saleMode: 'free' | 'paid'
  readonly salePriceYuan: string
  readonly error?: 'invalid-fields' | 'unavailable' | undefined
}
export interface OrderPublicationView {
  readonly busyKey: string | null
  readonly refreshing?: boolean
  /** Time of a successful, owner-checked platform review read, distinct from approval time. */
  readonly reviewSyncedAt?: number | undefined
  readonly items: Readonly<Record<string, OrderPublicationItem>>; readonly review?: OrderPublicationReview | null;
  readonly sellerProducts: Readonly<Record<string, SellerOrderProduct>>;
  readonly sellerProductsUnavailable: boolean;
  readonly sellerProductErrors: Readonly<Record<string, string>> }

interface SavedReview { draftId: string; packageDigest: string; name: string; purpose: string;
  category: 'text' | 'data' | 'automation'; configuration: string; salePriceYuan: string | null;
  state: 'local-draft'; savedAt: number }

interface CandidateCheck { packageName: string; packageDigest: string; matched: boolean;
  reason: 'matched' | 'not-installed' | 'changed' | 'adapter-missing' | 'unavailable' }
interface OrderSource { id: string; kind: 'builtin' | 'plugin' | 'skill'; selectable: boolean; eligible: boolean;
  enabled: boolean; serviceId: 'node' | null; reason: string }
interface OrderSources { sources: OrderSource[]; complete: boolean; order: { enabledServiceIds?: string[] } | null }

export interface OrderPublicationRemote {
  account?: { state(): Promise<Answer<{ account: { id: string } | null }>> }
  catalog: {
    previewInstalledOrderSkillPrice(request: { source: 'user-dsh' | 'user-agents'; name: string }):
      Promise<Answer<OrderSkillPricePreview>>
    localCandidates(): Promise<Answer<{ candidates: LocalPluginCandidateView[] }>>
    checkLocalCandidateInstall(request: { draftId: string; packageDigest: string }): Promise<Answer<CandidateCheck>>
    localOrderPublicationDraft(request: { draftId: string; packageDigest: string }): Promise<Answer<SavedReview | null>>
    saveLocalOrderPublicationDraft(request: Omit<SavedReview, 'state' | 'savedAt'>): Promise<Answer<SavedReview>>
    submitInstalledOrderSkill(request: { source: 'user-dsh' | 'user-agents'; name: string } & SkillOrderReviewInput):
      Promise<Answer<{ publicationId: string; status: 'review' | 'approved'; taskType: string;
        artifactDigest: string; priceYuan?: string; reviewReasons: string[]; platformReady: boolean;
        archiveStatus: 'confirmed' | 'pending'; archiveError?: string;
        reviewSampleStatus?: OrderPublicationItem['reviewSampleStatus'];
        mediaEvidenceStatus?: OrderPublicationItem['mediaEvidenceStatus']; reviewSampleError?: string } & PublicationCommerce>>
    retryInstalledOrderSkillArchive(request: { source: 'user-dsh' | 'user-agents'; name: string }):
      Promise<Answer<{ publicationId: string; status: 'review' | 'approved'; taskType: string;
        artifactDigest: string; reviewReasons: string[]; platformReady: boolean;
        archiveStatus: 'confirmed' | 'pending'; archiveError?: string;
        reviewSampleStatus?: OrderPublicationItem['reviewSampleStatus'];
        mediaEvidenceStatus?: OrderPublicationItem['mediaEvidenceStatus']; reviewSampleError?: string } & PublicationCommerce>>
    startOrderReviewSamples(request: { publicationId: string }): Promise<Answer<{
      publicationId: string; status: NonNullable<OrderPublicationItem['reviewSampleStatus']>;
      mediaEvidenceStatus: NonNullable<OrderPublicationItem['mediaEvidenceStatus']> }>>
    myOrderSkillPublications(request?: { includeArchived?: boolean }): Promise<Answer<{ items: Array<{
      source: 'user-dsh' | 'user-agents' | 'platform'; name: string; publicationId: string;
      displayName?: string
      lifecycle?: PublicationLifecycle
      runtimeKind?: 'native-h3'
      status: 'review' | 'approved' | 'rejected'; taskType: string;
      artifactDigest: string; priceYuan?: string; reviewReasons: string[]; packageMigrationRequired?: boolean;
      evidenceStatus?: OrderPublicationItem['evidenceStatus'];
      archiveStatus?: 'confirmed' | 'pending';
      reviewSampleStatus?: OrderPublicationItem['reviewSampleStatus'];
      mediaEvidenceStatus?: OrderPublicationItem['mediaEvidenceStatus'] } & PublicationCommerce> }>>
    manageOrderSkillPublication?(request: { publicationId: string; action: PublicationLifecycleAction;
      expectedRevision: number; note: string }): Promise<Answer<PublicationLifecycleReceipt>>
    mySellerOrderProducts?(): Promise<Answer<{ items: SellerOrderProduct[] }>>
    submitSellerOrderProduct?(request: { publicationId: string; salePriceYuan: string }):
      Promise<Answer<SellerOrderProduct>>
    orderSources(): Promise<Answer<OrderSources>>
    selectOrderSource(request: { sourceId: string }): Promise<Answer<{
      selectedSourceId: string; requiresGrant: boolean }>>
  }
  manager: {
    inspect(path: string): Promise<Answer<{ status: 'accepted' | 'refused'; kind?: string; bundle?: boolean; name?: string }>>
    installBundle(path: string, options: { enabled: false }): Promise<Answer<{ application: string; bundle?: string }>>
    setBundleEnabled(name: string, enabled: true): Promise<Answer<{ application: string }>>
    checkBundle(name: string): Promise<Answer<{ state: string; selected: boolean }>>
  }
}

class Blocked extends Error {
  constructor(readonly reason: OrderPublicationReason) { super(reason) }
}
function value<T>(answer: Answer<T>): T {
  if (!answer.ok) throw new Blocked('remote-unavailable')
  return answer.value
}
function sourceGap(reason: string): OrderPublicationReason {
  if (reason === 'file-input-unsupported') return 'file-input-unsupported'
  if (reason === 'platform-task-unmapped' || reason === 'not-selected') return 'platform-task-unmapped'
  return 'sample-failed'
}
function submission<T>(answer: Answer<T>): T {
  if (answer.ok) return answer.value
  const message = answer.error.message
  if (message.includes('order-auth-required')) throw new Blocked('order-auth-required')
  if (message.includes('order-skill-unavailable')) throw new Blocked('skill-not-found')
  if (message.includes('order-skill-import-unavailable')) throw new Blocked('skill-import-unavailable')
  if (message.includes('order-node-contributor-unavailable')) throw new Blocked('node-contributor-unavailable')
  if (message.includes('order-adapter-invalid')) throw new Blocked('adapter-missing')
  if (message.includes('order-runtime-unavailable')) throw new Blocked('runtime-unavailable')
  if (message.includes('order-local-verification-failed')) throw new Blocked('local-verification-failed')
  if (message.includes('order-review-samples-insufficient')) throw new Blocked('sample-insufficient')
  if (message.includes('order-platform-route-unavailable')) throw new Blocked('platform-route-unavailable')
  if (message.includes('order-platform-contract')) throw new Blocked('platform-task-unmapped')
  if (message.includes('order-publication-conflict')) throw new Blocked('publication-conflict')
  if (message.includes('order-platform-unavailable')) throw new Blocked('platform-unavailable')
  throw new Blocked('remote-unavailable')
}

/** Serialized preparation; neither candidate discovery nor a skill file authorizes platform intake. */
export class OrderPublicationController {
  readonly store = createSnapshotStore<OrderPublicationView>({ busyKey: null, items: {}, review: null,
    sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {} })
  private disposed = false
  private reviewGeneration = 0
  private publicationRefreshGeneration = 0
  private publicationAccountId: string | null | undefined
  private productSubmission: object | null = null
  private lifecycleMutation: object | null = null
  constructor(private readonly remote: OrderPublicationRemote) {}

  private async currentAccountId(): Promise<string | null | undefined> {
    if (this.remote.account === undefined) return undefined
    try {
      const answer = await this.remote.account.state()
      return answer.ok ? answer.value.account?.id ?? null : undefined
    } catch { return undefined }
  }

  private clearAccountPublications(): void {
    const state = this.store.getSnapshot()
    const productKey = this.productSubmission === null && this.lifecycleMutation === null ? null : state.busyKey
    this.productSubmission = null
    this.lifecycleMutation = null
    const items = { ...state.items }
    for (const key of Object.keys(items)) {
      if (items[key]!.publicationId !== undefined) delete items[key]
    }
    this.store.set({ ...state, items, ...(productKey === null ? {} : { busyKey: null }),
      reviewSyncedAt: undefined,
      sellerProducts: {}, sellerProductsUnavailable: true,
      sellerProductErrors: {} })
  }

  /** Recover only author rows confirmed by the platform and matched to current source bytes. */
  async refreshSkillPublications(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.publicationRefreshGeneration
    this.store.set({ ...this.store.getSnapshot(), refreshing: true })
    const accountId = await this.currentAccountId()
    if (this.disposed || generation !== this.publicationRefreshGeneration) return
    if (accountId !== undefined) {
      if (this.publicationAccountId !== undefined && accountId !== this.publicationAccountId) {
        this.clearAccountPublications()
      }
      this.publicationAccountId = accountId
      if (accountId === null) {
        this.clearAccountPublications()
        this.store.set({ ...this.store.getSnapshot(), refreshing: false })
        return
      }
    }
    if (accountId === undefined && this.remote.account !== undefined) {
      this.publicationAccountId = undefined
      this.clearAccountPublications()
      this.store.set({ ...this.store.getSnapshot(), refreshing: false })
      return
    }
    const before = this.store.getSnapshot().items
    let items: Awaited<ReturnType<OrderPublicationRemote['catalog']['myOrderSkillPublications']>> | null = null
    let products: Awaited<ReturnType<NonNullable<OrderPublicationRemote['catalog']['mySellerOrderProducts']>>> | null = null
    let failure = ''
    const responses = await Promise.allSettled([
      this.remote.catalog.myOrderSkillPublications({ includeArchived: true }),
      this.remote.catalog.mySellerOrderProducts?.() ?? Promise.resolve({ ok: false as const,
        error: { message: 'seller-product-ledger-unavailable' } }),
    ])
    if (responses[0]?.status === 'fulfilled') items = responses[0].value
    else if (responses[0]?.status === 'rejected') failure = responses[0].reason instanceof Error
      ? responses[0].reason.message : String(responses[0].reason)
    if (responses[1]?.status === 'fulfilled') products = responses[1].value
    if (this.disposed || generation !== this.publicationRefreshGeneration) return
    const afterAccountId = await this.currentAccountId()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- The owner can unload while the identity read is pending.
    if (this.disposed || generation !== this.publicationRefreshGeneration) return
    if (afterAccountId !== accountId) {
      this.publicationAccountId = afterAccountId
      this.clearAccountPublications()
      this.store.set({ ...this.store.getSnapshot(), refreshing: false })
      return
    }
    const state = this.store.getSnapshot()
    const updated = { ...state.items }
    if (items === null || !items.ok) {
      const authRequired = `${failure} ${items !== null && !items.ok ? items.error.message : ''}`
        .includes('order-auth-required')
      if (authRequired) {
        this.publicationAccountId = null
        this.clearAccountPublications()
        this.store.set({ ...this.store.getSnapshot(), refreshing: false })
        return
      }
      for (const [key, row] of Object.entries(updated)) {
        if (row.publicationId === undefined || row !== before[key]) continue
        updated[key] = { ...row, reviewSyncStale: true }
      }
      this.store.set({ ...state, items: updated, refreshing: false, sellerProductsUnavailable: true })
      return
    }
    for (const key of Object.keys(updated)) {
      if (updated[key]!.publicationId !== undefined && updated[key] === before[key]) delete updated[key]
    }
    for (const row of items.value.items) {
      const key = row.source === 'platform' ? `publication:${row.publicationId}` : `skill:${row.source}:${encodeURIComponent(row.name)}`
      if (state.items[key] !== before[key]) continue
      const phase = publicationPhase(row.status, row.archiveStatus, row.lifecycle)
      const previous = before[key]
      const archiveError = phase === 'archive-pending' && previous?.phase === 'archive-pending'
        && previous.publicationId === row.publicationId ? previous.archiveError : undefined
      updated[key] = { phase,
        ...(row.runtimeKind === 'native-h3' ? { runtimeKind: 'native-h3' as const } : {}),
        ...(archiveError === undefined ? {} : { archiveError }),
        ...(row.displayName === undefined && row.source !== 'platform' ? {} : { displayName: row.displayName ?? row.name }),
        ...(row.lifecycle === undefined ? {} : { lifecycle: row.lifecycle }),
        ...commerceFields(row),
      ...(row.archiveStatus === undefined ? {} : { archiveStatus: row.archiveStatus }),
        publicationId: row.publicationId, reviewReasons: [...row.reviewReasons],
        ...(row.evidenceStatus === undefined ? {} : { evidenceStatus: row.evidenceStatus }),
        ...(row.priceYuan === undefined ? {} : { priceYuan: row.priceYuan }),
        ...(row.reviewSampleStatus === undefined ? {} : { reviewSampleStatus: row.reviewSampleStatus }),
        ...(row.mediaEvidenceStatus === undefined ? {} : { mediaEvidenceStatus: row.mediaEvidenceStatus }),
        ...(row.packageMigrationRequired === true ? { packageMigrationRequired: true } : {}) }
    }
    const sellerProducts: Record<string, SellerOrderProduct> = {}
    if (products?.ok) {
      for (const product of products.value.items) sellerProducts[product.publicationId] = product
    }
    this.store.set({ ...state, items: updated, refreshing: false, reviewSyncedAt: Date.now(),
      sellerProducts: products?.ok ? sellerProducts : state.sellerProducts,
      sellerProductsUnavailable: !products?.ok })
  }

  /** Confirm one server-admitted action for the exact record revision and current signed-in owner. */
  async managePublicationLifecycle(request: PublicationLifecycleRequest): Promise<boolean> {
    const state = this.store.getSnapshot()
    const previous = state.items[request.recordKey]
    const accountId = this.publicationAccountId
    const generation = this.publicationRefreshGeneration
    if (this.disposed || state.busyKey !== null || state.refreshing || previous?.reviewSyncStale
      || previous?.publicationId !== request.publicationId || previous.lifecycle === undefined
      || previous.lifecycle.revision !== request.expectedRevision
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
      || !previous.lifecycle.allowedActions.includes(request.action)
      || typeof accountId !== 'string' || accountId.length === 0
      || this.remote.catalog.manageOrderSkillPublication === undefined) return false
    const operation = {}
    this.lifecycleMutation = operation
    const current = (): boolean => !this.disposed && this.lifecycleMutation === operation
      && this.publicationAccountId === accountId && this.publicationRefreshGeneration === generation
      && this.store.getSnapshot().items[request.recordKey] === previous
    const sameOwner = async (): Promise<boolean> => {
      const owner = await this.currentAccountId()
      if (!current()) return false
      if (owner === accountId) return true
      this.publicationAccountId = owner
      this.clearAccountPublications()
      return false
    }
    this.store.set({ ...state, busyKey: request.recordKey })
    try {
      if (!await sameOwner()) return false
      const answer = await this.remote.catalog.manageOrderSkillPublication({
        publicationId: request.publicationId, action: request.action, expectedRevision: request.expectedRevision,
        note: `PC owner confirms publication ${request.action}`,
      })
      if (!await sameOwner()) return false
      if (!answer.ok) throw new Error('publication-lifecycle-unconfirmed')
      const receipt = answer.value
      if (receipt.publicationId !== request.publicationId || String(receipt.ownerId) !== accountId
        || !Number.isSafeInteger(receipt.lifecycle.revision) || receipt.lifecycle.revision <= request.expectedRevision
        || (request.action === 'withdraw' && receipt.lifecycle.state !== 'withdrawn')
        || (request.action === 'delist' && receipt.lifecycle.state !== 'delisted')
        || (request.action === 'archive' && (!receipt.lifecycle.archived || receipt.lifecycle.state === 'active'))
        || (request.action === 'restore' && (receipt.lifecycle.archived || receipt.lifecycle.state === 'active'))) {
        throw new Error('publication-lifecycle-unconfirmed')
      }
      const latest = this.store.getSnapshot()
      const product = latest.sellerProducts[request.publicationId]
      this.store.set({ ...latest, items: { ...latest.items, [request.recordKey]: { ...previous,
        ...commerceFields(receipt), displayName: receipt.name, lifecycle: receipt.lifecycle,
        phase: publicationPhase(receipt.status, previous.archiveStatus, receipt.lifecycle), reviewSyncStale: false } },
      sellerProducts: product === undefined || receipt.marketProductStatus == null ? latest.sellerProducts
        : { ...latest.sellerProducts, [request.publicationId]: { ...product, status: receipt.marketProductStatus } } })
      return true
    } catch {
      if (await sameOwner()) this.set(request.recordKey, { ...previous, reviewSyncStale: true })
      return false
    } finally {
      if (this.lifecycleMutation === operation) {
        this.lifecycleMutation = null
        this.store.set({ ...this.store.getSnapshot(), busyKey: null })
      }
    }
  }

  /** Submit only an explicit sale price against a fresh, same-owner, archived approval. */
  async submitSkillProduct(source: 'user-dsh' | 'user-agents', name: string,
    salePriceYuan: string): Promise<boolean> {
    const key = `skill:${source}:${encodeURIComponent(name)}`
    const state = this.store.getSnapshot()
    const publication = state.items[key]
    const price = salePriceYuan.trim()
    const accountId = this.publicationAccountId
    const generation = this.publicationRefreshGeneration
    if (this.disposed) return false
    if (state.busyKey !== null || state.refreshing || state.sellerProductsUnavailable
      || publication?.phase !== 'approved' || publication.archiveStatus !== 'confirmed'
      || publication.reviewSyncStale || publication.publicationId === undefined
      || publication.marketProductId != null || publication.marketProductStatus != null
      || state.sellerProducts[publication.publicationId] !== undefined
      || typeof accountId !== 'string' || accountId.length === 0
      || !/^(?:0|[1-9]\d{0,5})\.\d{2}$/u.test(price) || Number(price) > 100000
      || (publication.salePriceYuan != null && publication.salePriceYuan !== price)) {
      this.store.set({ ...state, sellerProductErrors: { ...state.sellerProductErrors, [key]: 'invalid' } })
      return false
    }
    const operation = {}
    this.productSubmission = operation
    const isCurrent = (): boolean => !this.disposed && this.productSubmission === operation
      && generation === this.publicationRefreshGeneration && this.publicationAccountId === accountId
      && this.store.getSnapshot().items[key] === publication
    const sameOwner = async (): Promise<boolean> => {
      const currentOwner = await this.currentAccountId()
      if (!isCurrent()) return false
      if (currentOwner === accountId) return true
      this.publicationAccountId = currentOwner
      this.clearAccountPublications()
      return false
    }
    this.store.set({ ...state, busyKey: key,
      sellerProductErrors: { ...state.sellerProductErrors, [key]: '' } })
    try {
      if (!await sameOwner()) return false
      if (!this.remote.catalog.submitSellerOrderProduct) throw new Error('seller-product-route-unavailable')
      const answer = await this.remote.catalog.submitSellerOrderProduct({
        publicationId: publication.publicationId, salePriceYuan: price })
      if (!await sameOwner()) return false
      if (!answer.ok || answer.value.publicationId !== publication.publicationId
        || answer.value.salePriceYuan !== price) throw new Error(answer.ok ? 'invalid-receipt' : answer.error.message)
      const current = this.store.getSnapshot()
      this.store.set({ ...current, sellerProducts: { ...current.sellerProducts,
        [publication.publicationId]: answer.value } })
      return true
    } catch (error) {
      if (!await sameOwner()) return false
      const current = this.store.getSnapshot()
      this.store.set({ ...current, sellerProductErrors: { ...current.sellerProductErrors,
        [key]: error instanceof Error ? error.message : 'unavailable' } })
      return false
    } finally {
      if (this.productSubmission === operation) {
        this.productSubmission = null
        // Disposal invalidates productSubmission, so this operation can clear only its own live busy state.
        this.store.set({ ...this.store.getSnapshot(), busyKey: null })
      }
    }
  }

  /** Open a review sheet immediately; loading the saved notes and local self-test are separate stages. */
  openReview(candidate: LocalPluginCandidateView): void {
    if (this.disposed) return
    if (candidate.orderAdapter === undefined) {
      this.set(`candidate:${candidate.draftId}`, { phase: 'blocked', reason: 'adapter-missing' })
      return
    }
    const generation = ++this.reviewGeneration
    this.store.set({ ...this.store.getSnapshot(), review: { candidate, status: 'loading',
      name: candidate.displayName, purpose: candidate.description, category: 'text', configuration: '',
      saleMode: 'free', salePriceYuan: '' } })
    void this.loadReview(candidate, generation)
    void this.publishCandidate(candidate)
  }

  private async loadReview(candidate: LocalPluginCandidateView, generation: number): Promise<void> {
    try {
      const saved = value(await this.remote.catalog.localOrderPublicationDraft({
        draftId: candidate.draftId, packageDigest: candidate.packageDigest }))
      if (this.disposed || generation !== this.reviewGeneration) return
      const review = this.store.getSnapshot().review
      if (review?.candidate.draftId !== candidate.draftId) return
      this.store.set({ ...this.store.getSnapshot(), review: saved === null ? { ...review, status: 'ready' }
        : { ...review, status: 'saved', name: saved.name, purpose: saved.purpose,
          category: saved.category, configuration: saved.configuration,
          saleMode: saved.salePriceYuan === null ? 'free' : 'paid', salePriceYuan: saved.salePriceYuan ?? '' } })
    } catch {
      if (this.disposed || generation !== this.reviewGeneration) return
      const review = this.store.getSnapshot().review
      if (review?.candidate.draftId === candidate.draftId) {
        this.store.set({ ...this.store.getSnapshot(), review: { ...review, status: 'error', error: 'unavailable' } })
      }
    }
  }

  editReview(change: Partial<Pick<OrderPublicationReview,
    'name' | 'purpose' | 'category' | 'configuration' | 'saleMode' | 'salePriceYuan'>>): void {
    const review = this.store.getSnapshot().review
    if (this.disposed || review === null || review === undefined || review.status === 'loading' || review.status === 'saving') return
    this.store.set({ ...this.store.getSnapshot(), review: { ...review, ...change, status: 'ready', error: undefined } })
  }

  async saveReview(): Promise<void> {
    const review = this.store.getSnapshot().review
    if (this.disposed || review === null || review === undefined || review.status === 'loading'
      || review.status === 'saving') return
    const price = review.saleMode === 'free' ? null : review.salePriceYuan.trim()
    if (review.name.trim() === '' || review.purpose.trim() === '' || (price !== null
      && (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u.test(price) || Number(price) <= 0 || Number(price) > 100000))) {
      this.store.set({ ...this.store.getSnapshot(), review: { ...review, status: 'error', error: 'invalid-fields' } })
      return
    }
    const generation = this.reviewGeneration
    this.store.set({ ...this.store.getSnapshot(), review: { ...review, status: 'saving', error: undefined } })
    try {
      const saved = value(await this.remote.catalog.saveLocalOrderPublicationDraft({
        draftId: review.candidate.draftId, packageDigest: review.candidate.packageDigest,
        name: review.name, purpose: review.purpose, category: review.category,
        configuration: review.configuration, salePriceYuan: price }))
      if (this.disposed || generation !== this.reviewGeneration) return
      const current = this.store.getSnapshot().review
      if (current?.candidate.draftId !== review.candidate.draftId) return
      this.store.set({ ...this.store.getSnapshot(), review: { ...current, status: 'saved',
        name: saved.name, purpose: saved.purpose, category: saved.category,
        configuration: saved.configuration, saleMode: saved.salePriceYuan === null ? 'free' : 'paid',
        salePriceYuan: saved.salePriceYuan ?? '' } })
    } catch {
      if (this.disposed || generation !== this.reviewGeneration) return
      const current = this.store.getSnapshot().review
      if (current?.candidate.draftId === review.candidate.draftId) {
        this.store.set({ ...this.store.getSnapshot(), review: { ...current, status: 'error', error: 'unavailable' } })
      }
    }
  }

  closeReview(): void {
    this.reviewGeneration++
    if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), review: null })
  }

  private set(key: string, item: OrderPublicationItem): void {
    if (this.disposed) return
    const state = this.store.getSnapshot()
    this.store.set({ ...state, items: { ...state.items, [key]: item } })
  }
  private async run(key: string, action: () => Promise<void>): Promise<void> {
    if (this.disposed || this.store.getSnapshot().busyKey !== null) return
    this.store.set({ ...this.store.getSnapshot(), busyKey: key })
    this.set(key, { phase: 'checking' })
    try { await action() }
    catch (error) { this.set(key, { phase: 'blocked', reason: error instanceof Blocked ? error.reason : 'remote-unavailable' }) }
    finally { if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), busyKey: null }) }
  }
  private async sources(): Promise<OrderSources> {
    const inventory = value(await this.remote.catalog.orderSources())
    if (!inventory.complete || !Array.isArray(inventory.sources)) throw new Blocked('inventory-incomplete')
    return inventory
  }
  private async select(sourceId: string): Promise<void> {
    const before = await this.sources()
    const source = before.sources.find(item => item.id === sourceId)
    if (source === undefined) throw new Blocked('skill-not-found')
    if (!source.eligible) {
      if (!source.selectable) throw new Blocked(sourceGap(source.reason))
      // A grant blocks an actual executor switch, not a read-only explanation of
      // why an unrelated instruction-only skill cannot accept orders.
      if (before.order?.enabledServiceIds?.includes('node')) throw new Blocked('already-authorized')
      const selected = value(await this.remote.catalog.selectOrderSource({ sourceId }))
      if (selected.selectedSourceId !== sourceId || selected.requiresGrant !== true) throw new Blocked('sample-failed')
    }
    const after = await this.sources()
    const verified = after.sources.find(item => item.id === sourceId)
    if (verified?.eligible !== true || verified.serviceId !== 'node') {
      throw new Blocked('sample-failed')
    }
  }

  /** Revalidate the exact saved candidate, install disabled, verify bytes, activate, then run Host self-test. */
  publishCandidate(candidate: LocalPluginCandidateView): Promise<void> {
    const key = `candidate:${candidate.draftId}`
    return this.run(key, async () => {
      const current = value(await this.remote.catalog.localCandidates()).candidates.find(item =>
        item.draftId === candidate.draftId && item.packagePath === candidate.packagePath
          && item.packageName === candidate.packageName && item.packageDigest === candidate.packageDigest
          && item.toolName === candidate.toolName && item.published === false && item.dispatchable === false)
      if (current === undefined) throw new Blocked('candidate-changed')
      const request = { draftId: current.draftId, packageDigest: current.packageDigest }
      const initial = value(await this.remote.catalog.checkLocalCandidateInstall(request))
      if (initial.reason === 'adapter-missing') throw new Blocked('adapter-missing')
      if (initial.reason === 'changed') throw new Blocked('installed-changed')
      if (initial.reason === 'unavailable') throw new Blocked('remote-unavailable')
      const inventory = await this.sources()
      const sourceId = `bundle:${encodeURIComponent(current.packageName)}`
      const existingSource = inventory.sources.find(item => item.id === sourceId)
      // Installing different bytes or choosing a new executor would change the
      // active order path. An already selected and verified source can be checked.
      if (inventory.order?.enabledServiceIds?.includes('node')
        && (!initial.matched || existingSource?.eligible !== true)) throw new Blocked('already-authorized')
      if (!initial.matched) {
        this.set(key, { phase: 'installing' })
        const inspection = value(await this.remote.manager.inspect(current.packagePath))
        if (inspection.status !== 'accepted' || inspection.kind !== 'path' || inspection.bundle !== true
          || inspection.name !== current.packageName) throw new Blocked('review-required')
        const install = value(await this.remote.manager.installBundle(current.packagePath, { enabled: false }))
        if (install.application === 'restart-required') throw new Blocked('restart-required')
        if (install.application !== 'applied' || install.bundle !== current.packageName) throw new Blocked('install-failed')
      }
      const checked = value(await this.remote.catalog.checkLocalCandidateInstall(request))
      if (!checked.matched) throw new Blocked('installed-changed')
      this.set(key, { phase: 'enabling' })
      let load = value(await this.remote.manager.checkBundle(current.packageName))
      if (load.state !== 'active' || !load.selected) {
        const enabled = value(await this.remote.manager.setBundleEnabled(current.packageName, true))
        if (enabled.application !== 'applied') throw new Blocked('activation-failed')
        load = value(await this.remote.manager.checkBundle(current.packageName))
      }
      if (load.state !== 'active' || !load.selected) throw new Blocked('activation-failed')
      if (!value(await this.remote.catalog.checkLocalCandidateInstall(request)).matched) {
        throw new Blocked('installed-changed')
      }
      this.set(key, { phase: 'self-testing' })
      await this.select(sourceId)
      this.set(key, { phase: 'ready' })
    })
  }

  /** Quote the source's machine contract before the user confirms publication. */
  async previewSkillPrice(source: 'user-dsh' | 'user-agents', name: string): Promise<OrderSkillPricePreview> {
    const priced = submission(await this.remote.catalog.previewInstalledOrderSkillPrice({ source, name }))
    if (!/^sha256:[0-9a-f]{64}$/u.test(priced.artifactDigest)
      || !/^sha256:[0-9a-f]{64}$/u.test(priced.taskDefinitionSha256)
      || !/^(?:0|[1-9]\d{0,5})\.\d{2}$/u.test(priced.priceYuan)
      || !Number.isSafeInteger(priced.settingsVersion) || priced.settingsVersion < 1) {
      throw new Blocked('remote-unavailable')
    }
    return priced
  }

  /** A SKILL.md alone is not executable; ask the Host for an actual mapped source and report its gap. */
  async publishSkill(source: 'user-dsh' | 'user-agents', name: string, review?: SkillOrderReviewInput): Promise<void> {
    const key = `skill:${source}:${encodeURIComponent(name)}`
    if (review !== undefined) {
      const previous = this.store.getSnapshot().items[key]
      if (previous?.publicationId !== undefined && ['submitted', 'approved'].includes(previous.phase)) {
        const accountId = await this.currentAccountId()
        if (accountId === undefined || accountId === this.publicationAccountId) return
      }
    }
    return this.run(key, async () => {
      this.set(key, { phase: 'self-testing' })
      if (review !== undefined) {
        const accountId = await this.currentAccountId()
        if (this.remote.account !== undefined && accountId === undefined) throw new Blocked('remote-unavailable')
        if (accountId === null) throw new Blocked('order-auth-required')
        if (accountId !== undefined && accountId !== this.publicationAccountId) {
          this.publicationRefreshGeneration++
          this.publicationAccountId = accountId
          this.clearAccountPublications()
        }
        const receipt = submission(await this.remote.catalog.submitInstalledOrderSkill({ source, name, ...review }))
        if (!/^[0-9a-f-]{36}$/u.test(receipt.publicationId)
          || (receipt.status !== 'review' && receipt.status !== 'approved')) throw new Blocked('remote-unavailable')
        this.set(key, { phase: receipt.status === 'approved' ? 'approved'
          : receipt.archiveStatus === 'confirmed' ? 'submitted' : 'archive-pending',
        ...commerceFields(receipt), archiveStatus: receipt.archiveStatus,
          publicationId: receipt.publicationId,
          ...(receipt.priceYuan === undefined ? {} : { priceYuan: receipt.priceYuan }),
          reviewReasons: [...receipt.reviewReasons],
          ...(receipt.archiveError === undefined ? {} : { archiveError: receipt.archiveError }),
          ...(receipt.reviewSampleStatus === undefined ? {} : { reviewSampleStatus: receipt.reviewSampleStatus }),
          ...(receipt.mediaEvidenceStatus === undefined ? {} : { mediaEvidenceStatus: receipt.mediaEvidenceStatus }),
          ...(receipt.reviewSampleError === undefined ? {} : { reviewSampleError: receipt.reviewSampleError }) })
        return
      }
      await this.select(key)
      this.set(key, { phase: 'ready' })
    })
  }
  /** Continue the same publication after an interrupted archive upload; no new price or submission. */
  async retrySkillArchive(source: 'user-dsh' | 'user-agents', name: string): Promise<void> {
    const key = `skill:${source}:${encodeURIComponent(name)}`
    const previous = this.store.getSnapshot().items[key]
    if (this.disposed || this.store.getSnapshot().busyKey !== null
      || previous?.phase !== 'archive-pending' || previous.publicationId === undefined) return
    const accountId = await this.currentAccountId()
    const current = (): boolean => !this.disposed && this.store.getSnapshot().items[key] === previous
    if (!current()) return
    const sameOwner = async (): Promise<boolean> => {
      const owner = await this.currentAccountId()
      if (this.disposed || this.store.getSnapshot().items[key] !== previous) return false
      if (owner !== accountId) {
        this.publicationAccountId = owner
        this.clearAccountPublications()
        return false
      }
      return true
    }
    if (this.remote.account !== undefined && (accountId == null
      || this.publicationAccountId !== undefined && this.publicationAccountId !== accountId)) {
      this.publicationAccountId = accountId
      this.clearAccountPublications()
      return
    }
    this.store.set({ ...this.store.getSnapshot(), busyKey: key })
    try {
      const receipt = submission(await this.remote.catalog.retryInstalledOrderSkillArchive({ source, name }))
      if (!await sameOwner()) return
      if (receipt.publicationId !== previous.publicationId) throw new Blocked('publication-conflict')
      const { archiveError: _previousArchiveError, reviewSampleError: _previousSampleError, ...retained } = previous
      this.set(key, { ...retained, ...commerceFields(receipt), archiveStatus: receipt.archiveStatus,
        phase: receipt.status === 'approved' ? 'approved'
          : receipt.archiveStatus === 'confirmed' ? 'submitted' : 'archive-pending',
        publicationId: previous.publicationId, reviewReasons: [...receipt.reviewReasons],
        ...(receipt.archiveError === undefined ? {} : { archiveError: receipt.archiveError }),
        ...(receipt.reviewSampleStatus === undefined ? {} : { reviewSampleStatus: receipt.reviewSampleStatus }),
        ...(receipt.mediaEvidenceStatus === undefined ? {} : { mediaEvidenceStatus: receipt.mediaEvidenceStatus }),
        ...(receipt.reviewSampleError === undefined ? {} : { reviewSampleError: receipt.reviewSampleError }) })
    } catch (error) {
      if (!await sameOwner()) return
      this.set(key, { ...previous, archiveError: error instanceof Blocked ? error.reason : 'remote-unavailable' })
    } finally {
      if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), busyKey: null })
    }
  }
  /** Explicit, idempotent recovery for a confirmed source whose review sample did not start. */
  async retryReviewSamples(source: 'user-dsh' | 'user-agents', name: string): Promise<void> {
    const key = `skill:${source}:${encodeURIComponent(name)}`
    const before = this.store.getSnapshot().items[key]
    if (this.disposed || this.store.getSnapshot().busyKey !== null
      || before?.phase !== 'submitted' || before.publicationId === undefined) return
    this.store.set({ ...this.store.getSnapshot(), busyKey: key })
    try {
      const receipt = submission(await this.remote.catalog.startOrderReviewSamples({ publicationId: before.publicationId }))
      if (receipt.publicationId !== before.publicationId) throw new Blocked('publication-conflict')
      const { reviewSampleError: _previousError, ...rest } = before
      this.set(key, { ...rest, reviewSampleStatus: receipt.status,
        mediaEvidenceStatus: receipt.mediaEvidenceStatus })
    } catch (error) {
      this.set(key, { ...before, reviewSampleError: error instanceof Error ? error.message : 'remote-unavailable' })
    } finally {
      if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), busyKey: null })
    }
  }
  dispose(): void { this.disposed = true; this.productSubmission = null; this.lifecycleMutation = null;
    this.reviewGeneration++; this.publicationRefreshGeneration++ }
}
