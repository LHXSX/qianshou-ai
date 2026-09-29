/** Market cards share the existing Session-addressed @ composer and never execute tasks here. */
import type { QianshouMarketSelection } from '@deepseek-ai/dsh-client-ui-qianshou/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MarketCapabilityView } from './market-capabilities-controller.ts'

export interface MarketConversationRequest {
  readonly taskType: string
  readonly expected?: Readonly<MarketCapabilityView>
  readonly goal?: string
  readonly product?: NonNullable<Parameters<QianshouMarketSelection['refreshAndSelect']>[4]>['product']
}
export type EnterMarketConversation = (request: MarketConversationRequest, signal?: AbortSignal) => Promise<boolean>

/** Capture the actual main conversation and cancel when its owner is replaced. */
export function createMarketConversationEntry(deps: {
  readonly selection: QianshouMarketSelection
  currentSession(): SessionId | null
  subscribe(listener: () => void): () => void
  openConversation(): void
}): EnterMarketConversation {
  return async (request, signal) => {
    const sessionId = deps.currentSession()
    if (sessionId === null || signal?.aborted) return false
    const pending = new AbortController()
    const cancel = (): void => { pending.abort() }
    signal?.addEventListener('abort', cancel, { once: true })
    const unsubscribe = deps.subscribe(() => { if (deps.currentSession() !== sessionId) cancel() })
    try {
      const selected = await deps.selection.refreshAndSelect(sessionId, request.taskType, request.expected, pending.signal,
        { ...(request.goal === undefined ? {} : { goal: request.goal }),
          ...(request.product === undefined ? {} : { product: request.product }) })
      if (!selected || pending.signal.aborted || deps.currentSession() !== sessionId) return false
      deps.openConversation()
      return true
    } finally {
      unsubscribe()
      signal?.removeEventListener('abort', cancel)
    }
  }
}
