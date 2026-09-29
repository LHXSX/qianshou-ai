/** Exact-Session chronological descriptors derived from the owning market-call store. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatTimelineEntry, ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationMarketCall } from './conversation-market-store.ts'

/** Stable keyed-slot and provider identity for market requests. */
export const MARKET_TIMELINE_ID = 'qianshou-market-calls'

/** Mirror committed display rows without another persistence writer or task submission.
 * @returns Chronological descriptors and explicit lifetime operations.
 */
export function createConversationMarketTimeline() {
  const entries = new Map<SessionId, readonly ChatTimelineEntry[]>()
  const listeners = new Set<(sessionId: SessionId) => void>()
  let live = true
  const provider: ChatTimelineEntryProvider = {
    id: MARKET_TIMELINE_ID,
    read: sessionId => entries.get(sessionId) ?? [],
    subscribe: (listener) => {
      if (!live) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    provider,
    /** Publish validated rows from the single owning persisted store. */
    publish(sessionId: SessionId, rows: readonly ConversationMarketCall[]): void {
      if (!live) return
      const previous = entries.get(sessionId)
      const next = rows.map(row => ({ id: row.id, createdAt: Date.parse(row.createdAt) }))
      if (previous !== undefined && previous.length === next.length
        && previous.every((row, index) => {
          const current = next.at(index)
          return current !== undefined && row.id === current.id && row.createdAt === current.createdAt
        })) return
      entries.set(sessionId, next)
      notifySubscribers(listeners, 'market timeline', sessionId)
    },
    /** Withdraw a retired view bridge without deleting its persisted history. */
    release(sessionId: SessionId): void {
      if (!live) return
      if (entries.delete(sessionId)) notifySubscribers(listeners, 'market timeline', sessionId)
    },
    /** Silence late callbacks and retire all feature sources. */
    dispose(): void {
      if (!live) return
      live = false
      entries.clear(); listeners.clear()
    },
  }
}
