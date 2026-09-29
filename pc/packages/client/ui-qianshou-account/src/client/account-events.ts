/** Public local identity invalidation, without exposing account credentials. */
export interface QianshouAccountEvents {
  /**
   * Invalidate account-bound views after the Host confirms an identity transition.
   * @mode emit
   * @param accountId - Confirmed current account ID, or null after sign-out.
   */
  'qianshou-account/identity-changed'(accountId: string | null): void
}

declare module '@deepseek-ai/cordis' {
  interface Events extends QianshouAccountEvents {}
}
