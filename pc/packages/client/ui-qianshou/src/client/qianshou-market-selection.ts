/** Session-addressed market selection shared by the ability board and the @ entry. */
import type { MarketCapability, SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/** The market owner refreshes its own parser catalog before composing a reference. */
export interface QianshouMarketSelection {
  /**
   * Read the shared displayed catalog; cached metadata grants no execution authority.
   * @returns Displayed market capabilities after the catalog owner has loaded its current view.
   */
  listAbilities?(): Promise<readonly MarketCapability[]>
  /** Refresh and validate one exact task type, then preserve the current Session draft.
   * @param sessionId - The originating composer Session, retained across the refresh.
   * @param taskType - The exact reviewed catalog identity selected by the user.
   * @param expected - Displayed publication and execution fields to revalidate.
   * @param signal - Abort when the user closes, changes selection, or reaches the waiting limit.
   * @param options - An optional goal for an empty draft and the exact displayed product version to revalidate.
   * @returns True only when an unambiguous reference was composed; false leaves the draft intact.
   */
  refreshAndSelect(sessionId: SessionId, taskType: string, expected?: Readonly<MarketCapability>, signal?: AbortSignal,
    options?: { readonly goal?: string; readonly product?: {
      readonly productId: string; readonly publicationId: string; readonly version: string; readonly ownerId: number
    } }): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Selection only; this service does not execute or approve a paid task. */
    qianshouMarketSelection: QianshouMarketSelection
  }
}
