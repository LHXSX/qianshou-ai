/** Trusted embedding ports; the preview never invents a cloud protocol or trusts a reported PC URL. */
import type { AccountWorker } from '@deepseek-ai/dsh-client-account'
import type { PcWindowPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import type { MobileAgentSessionPort } from './window/mobile-workspace-types.ts'

/** An embedding application supplies authenticated Agent and PC transports before loading main.ts. */
export interface MobilePreviewHost {
  readonly agent?: MobileAgentSessionPort
  readonly authorizePc?: (worker: AccountWorker, accountId: string, signal: AbortSignal) => Promise<PcWindowPort>
}
declare global {
  interface Window { qianshouMobileHost?: MobilePreviewHost }
  const __ACCOUNT_ORIGIN__: string
  const __MOBILE_AGENT_HTTP__: boolean
}
