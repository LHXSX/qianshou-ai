/** Read-only Workspace previews of this feature's exact Session call references. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkspaceSessionPreview, WorkspaceSessionPreviewProvider,
} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  CONVERSATION_MARKET_STORE_KEY, isConversationMarketCall,
  type ConversationMarketCall,
} from './conversation-market-store.ts'

// Security bounds for an untrusted browser-local preview, not for task execution.
const MAX_PREVIEW_BYTES = 1024 * 1024
const MAX_PREVIEW_ROWS = 128

function callPreview(call: ConversationMarketCall): WorkspaceSessionPreview {
  const characters = Array.from(`@${call.capability.name} ${call.goal}`.replace(/\s+/gu, ' ').trim())
  const title = characters.length > 48 ? `${characters.slice(0, 47).join('')}…` : characters.join('')
  return { kind: 'content', title, searchText: characters.slice(0, 512).join(''),
    updatedAt: Date.parse(call.createdAt) }
}

/** Read a single persisted Session without constructing a store or restoring Host references. */
function readStoredPreview(sessionId: SessionId): WorkspaceSessionPreview | null {
  try {
    const raw = globalThis.localStorage.getItem(`${CONVERSATION_MARKET_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    if (raw.length > MAX_PREVIEW_BYTES || new TextEncoder().encode(raw).byteLength > MAX_PREVIEW_BYTES) {
      return { kind: 'unavailable' }
    }
    const saved: unknown = JSON.parse(raw)
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)
      || !('calls' in saved) || !Array.isArray(saved.calls)) return { kind: 'unavailable' }
    const rows: unknown[] = saved.calls
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - MAX_PREVIEW_ROWS); i--) {
      const row = rows[i]
      if (isConversationMarketCall(row, sessionId)) return callPreview(row)
    }
    return rows.length === 0 ? null : { kind: 'unavailable' }
  } catch (_failure) {
    // An unreadable history cannot authorize reusing its Session as empty.
    return { kind: 'unavailable' }
  }
}

/** Create the feature-owned provider and post-commit invalidation channel.
 * @returns Read-only provider plus publication and lifetime operations; none writes storage or a Session log.
 */
export function createConversationMarketPreview() {
  const listeners = new Set<(sessionId: SessionId) => void>()
  const observed = new Set<SessionId>()
  const committed = new Map<SessionId, WorkspaceSessionPreview>()
  let storageWindow: Window | undefined
  let live = true
  const changed = (sessionId: SessionId): void => {
    if (!live) return
    for (const notify of listeners) {
      try { notify(sessionId) } catch (_failure) {
        // One Workspace subscriber cannot discard an already committed request.
        console.error('market Session preview notification failed')
      }
    }
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null) {
      for (const sessionId of observed) changed(sessionId)
    } else {
      const prefix = `${CONVERSATION_MARKET_STORE_KEY}.`
      if (event.key.startsWith(prefix)) changed(event.key.slice(prefix.length) as SessionId)
    }
  }
  const stopStorage = (): void => {
    storageWindow?.removeEventListener('storage', onStorage)
    storageWindow = undefined
  }
  const provider: WorkspaceSessionPreviewProvider = {
    read: (sessionId) => {
      if (!live) return null
      observed.add(sessionId)
      return committed.get(sessionId) ?? readStoredPreview(sessionId)
    },
    subscribe: (notify) => {
      if (!live) return () => {}
      const listener = (sessionId: SessionId): void => { notify(sessionId) }
      listeners.add(listener)
      if (storageWindow === undefined && typeof window !== 'undefined') {
        storageWindow = window
        storageWindow.addEventListener('storage', onStorage)
      }
      return (): void => {
        listeners.delete(listener)
        if (listeners.size === 0) stopStorage()
      }
    },
  }
  return {
    provider,
    /** Publish only after the existing store action commits the request, including when persistence fails. */
    recorded(call: ConversationMarketCall): void {
      if (!live) return
      committed.set(call.sessionId, isConversationMarketCall(call, call.sessionId)
        ? callPreview(call) : { kind: 'unavailable' })
      changed(call.sessionId)
    },
    changed,
    /** Retire all subscriptions and derived live previews; late writers remain inert. */
    dispose(): void {
      if (!live) return
      live = false
      listeners.clear()
      stopStorage()
      committed.clear()
      observed.clear()
    },
  }
}
