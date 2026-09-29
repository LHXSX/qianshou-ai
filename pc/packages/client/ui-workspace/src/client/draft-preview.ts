import type { SessionId } from '@deepseek-ai/dsh-session/types'

// The Conversation store persists under this key. Keep the read-only browser
// projection aligned with ui-conversation/src/client/stores.ts; the integration
// test writes through that real store before reading here.
const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** A short label for a saved unsent draft; empty or malformed records stay hidden. */
export function readConversationDraftPreview(sessionId: SessionId): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('draft' in stored)
      || typeof stored.draft !== 'string') return null
    const singleLine = stored.draft.replace(/\s+/g, ' ').trim()
    if (singleLine === '') return null
    const characters = Array.from(singleLine)
    return characters.length > 48 ? `${characters.slice(0, 48).join('')}…` : singleLine
  } catch {
    return null
  }
}
