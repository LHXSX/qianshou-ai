/** Authenticated Guangzhou admin projection of Shanghai marketplace reviews. */
import { postJson } from '@/api/client'
import { ENDPOINTS } from '@/api/endpoints'

/** Queue visibility and Shanghai review-write authorization are independent. */
export interface MarketplaceReviewQueue<T> {
  readonly ok: true
  readonly items: readonly T[]
  readonly reviewAuthorized: boolean
  readonly readDelegated: boolean
  readonly reviewActionsAvailable?: boolean
}

export function shanghaiReviewWritable(queue: MarketplaceReviewQueue<unknown> | undefined): boolean {
  return queue?.reviewAuthorized === true && queue.readDelegated === false
}

export function reviewAuthorityHint(queue: MarketplaceReviewQueue<unknown> | undefined): string {
  if (queue?.readDelegated === true) {
    return '当前仅通过广州只读委托查看队列；中央服务器尚未授权此账号提交审核。通过与驳回均不可用，请先取得中央服务器审核授权。'
  }
  return '中央服务器审核写授权尚未确认。可查看队列，但通过与驳回保持禁用；请刷新并核对中央服务器账号权限。'
}

export interface MarketplaceReviewItem {
  readonly id: number
  readonly slug?: string
  readonly name: string
  readonly summary?: string
  readonly author_name?: string
  readonly category?: string
  readonly launch_kind?: string
  readonly task_type?: string
  readonly pricing_model?: string
  readonly price?: number | string
  readonly status: string
  readonly sha256?: string
  readonly updated_at?: string
  readonly can_approve?: boolean
  readonly review_issues: readonly string[]
}

export const listMarketplaceReviews = (limit = 50) =>
  postJson<MarketplaceReviewQueue<MarketplaceReviewItem>>(ENDPOINTS.marketReviews, { limit })

export const moderateMarketplaceReview = (appId: number, action: 'approve' | 'reject', note: string) =>
  postJson<{ ok: true; item: MarketplaceReviewItem; auditId: number | string }>(ENDPOINTS.marketReview, { appId, action, note })

export interface OrderPublicationReviewItem {
  readonly id: string
  readonly owner_id: number
  readonly name: string
  readonly task_type: string
  readonly output_kind?: string
  readonly category?: string
  readonly description?: string
  readonly version?: string
  readonly artifact_digest?: string
  readonly price_yuan?: string
  readonly sale_price_yuan?: string | null
  readonly market_product_id?: string
  readonly market_product_status?: string
  readonly currency?: 'CNY'
  readonly status: string
  readonly can_approve: boolean
  readonly can_submit_review?: boolean
  readonly required_evidence?: readonly string[]
  readonly evidence_status?: Readonly<Record<string, 'missing' | 'valid' | 'invalid'>>
  readonly review_reasons: readonly string[]
}

export const listOrderPublications = () =>
  postJson<MarketplaceReviewQueue<OrderPublicationReviewItem>>(ENDPOINTS.marketOrderPublications)

export const reviewOrderPublication = (publicationId: string, action: 'approve' | 'reject', note: string) =>
  postJson<{ ok: true; item: OrderPublicationReviewItem; auditId: number | string }>(
    ENDPOINTS.marketOrderPublicationReview, { publicationId, action, note })

export interface OrderAdapterProductReviewItem {
  readonly id: string
  readonly publication_id: string
  readonly owner_id: number
  readonly name: string
  readonly task_type: string
  readonly category?: string
  readonly description?: string
  readonly version?: string
  readonly artifact_digest?: string
  readonly archive_digest?: string
  readonly archive_size_bytes?: number
  readonly sale_price_yuan?: string
  readonly currency: 'CNY'
  readonly status: string
  readonly can_approve: boolean
  readonly available_to_purchase?: boolean
  readonly review_reasons: readonly string[]
}

export const listOrderAdapterProducts = () =>
  postJson<MarketplaceReviewQueue<OrderAdapterProductReviewItem>>(ENDPOINTS.marketOrderAdapterProducts)

export const reviewOrderAdapterProduct = (productId: string, action: 'approve' | 'reject', note: string) =>
  postJson<{ ok: true; item: OrderAdapterProductReviewItem; auditId: number | string }>(
    ENDPOINTS.marketOrderAdapterProductReview, { productId, action, note })

/** Explicit metadata visibility actions; approval and financial history stay separate. */
export type PublicationLifecycleAction = 'withdraw' | 'delist' | 'archive' | 'restore'
export interface ManagedOrderPublication {
  readonly publication_id: string
  readonly owner_id: number
  readonly name: string
  readonly task_type: string
  readonly status: 'review' | 'approved' | 'rejected'
  readonly lifecycle: {
    readonly state: 'active' | 'withdrawn' | 'delisted'
    readonly archived: boolean
    readonly revision: number
    readonly allowed_actions: readonly PublicationLifecycleAction[]
    readonly blocking_reasons: readonly ('active-orders' | 'pending-install')[]
  }
}
export const listManagedOrderPublications = () =>
  postJson<MarketplaceReviewQueue<ManagedOrderPublication>>(ENDPOINTS.marketManagedOrderPublications)
export const manageOrderPublication = (publicationId: string, action: PublicationLifecycleAction, expectedRevision: number, note: string) =>
  postJson<{ ok: true; item: ManagedOrderPublication; auditId: number | string }>(ENDPOINTS.marketOrderPublicationLifecycle,
    { publicationId, action, expectedRevision, note })
