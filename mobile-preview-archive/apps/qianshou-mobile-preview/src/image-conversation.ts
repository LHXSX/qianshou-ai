/** Image clarification, progress and rewrite context belong to an account and Session. */
import type { ImageIntentPlan } from '@deepseek-ai/dsh-client-compute-trigger'
import type { GeneratedImageTurn, PendingImageExchange } from './components/message-view.ts'

export interface ImageConversation {
  readonly accountId: string
  readonly sessionKey: string
  readonly images: GeneratedImageTurn[]
  readonly exchanges: PendingImageExchange[]
  readonly notices: { readonly id: string; readonly text: string; readonly reply: string; readonly at: number }[]
  lastPlan: ImageIntentPlan | null
  lastImageAt: number
  userTurnsSinceImage: number
}

/** A view switch does not move an outstanding image request into another Session. */
export function createImageConversations(): {
  get(accountId: string, sessionKey: string): ImageConversation
  forAccount(accountId: string): readonly ImageConversation[]
  remove(accountId: string, sessionKey: string): void
  clear(): void
} {
  const states = new Map<string, ImageConversation>()
  return {
    get(accountId, sessionKey) {
      const key = JSON.stringify([accountId, sessionKey])
      let state = states.get(key)
      if (state === undefined) {
        state = { accountId, sessionKey, images: [], exchanges: [], notices: [], lastPlan: null, lastImageAt: 0, userTurnsSinceImage: 0 }
        states.set(key, state)
      }
      return state
    },
    forAccount: accountId => [...states.values()].filter(state => state.accountId === accountId),
    remove: (accountId, sessionKey) => { states.delete(JSON.stringify([accountId, sessionKey])) },
    clear: () => { states.clear() },
  }
}
