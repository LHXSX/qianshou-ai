/** Optional marketplace navigation consumed by the intake page. */
export interface MarketplacePublicationFocus {
  readonly source: 'user-dsh' | 'user-agents'
  readonly name: string
}

/** Navigate to existing skill management panels without submitting or activating a skill. */
export interface QianshouMarketplaceNavigation {
  /**
   * Retain the latest request and select the existing publication management panel.
   * @param focus - Exact canonical skill source and name, or absent for all records.
   * @returns Whether the live owner accepted the request. False means invalid or
   * unavailable; true does not assert that a publication exists or was read.
   */
  openPublications(focus?: MarketplacePublicationFocus): boolean
  /** Open the saved local skill's existing trial and publication actions.
   * @param focus - Exact user root and skill command.
   * @returns Whether the live navigation owner accepted this local management request.
   */
  openMySkill?(focus: MarketplacePublicationFocus): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    qianshouMarketplaceNavigation: QianshouMarketplaceNavigation
  }
}
