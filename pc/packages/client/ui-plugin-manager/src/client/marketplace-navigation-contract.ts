/** Profile-owned request data for existing author publication records. */
import type { MarketplacePublicationFocus } from '@deepseek-ai/dsh-client-ui-qianshou/client'
export type { MarketplacePublicationFocus, QianshouMarketplaceNavigation } from '@deepseek-ai/dsh-client-ui-qianshou/client'

export interface MarketplacePublicationRequest {
  readonly destination?: 'mine' | 'publications'
  readonly id: number
  readonly focus: MarketplacePublicationFocus | null
}

export interface MarketplaceNavigationSnapshot {
  readonly request: MarketplacePublicationRequest | null
}
