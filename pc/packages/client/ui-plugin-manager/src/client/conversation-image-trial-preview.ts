/** Exact-Session, read-only previews keep media-only conversations visible and occupied. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSessionPreview, WorkspaceSessionPreviewProvider } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { IMAGE_TRIAL_STORE_KEY, isImageTrialCall, type ImageTrialCall } from './image-trial-store.ts'

const MAX_BYTES = 1024 * 1024
const MAX_ROWS = 128

function callPreview(call: ImageTrialCall): WorkspaceSessionPreview {
  const characters = Array.from(`@出图 ${call.prompt}`.replace(/\s+/gu, ' ').trim())
  return { kind: 'content', title: characters.length > 48 ? `${characters.slice(0, 47).join('')}…` : characters.join(''),
    searchText: characters.slice(0, 512).join(''), updatedAt: Date.parse(call.createdAt) }
}

function readStored(sessionId: SessionId): WorkspaceSessionPreview | null {
  try {
    const raw = globalThis.localStorage.getItem(`${IMAGE_TRIAL_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    if (raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES) return { kind: 'unavailable' }
    const saved: unknown = JSON.parse(raw)
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved)
      || !('calls' in saved) || !Array.isArray(saved.calls)) return { kind: 'unavailable' }
    const rows: unknown[] = saved.calls
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - MAX_ROWS); i--) {
      const row = rows[i]
      if (isImageTrialCall(row, sessionId)) return callPreview(row)
    }
    return rows.length === 0 ? null : { kind: 'unavailable' }
  } catch {
    // Unreadable saved content cannot authorize blank-Session reuse.
    return { kind: 'unavailable' }
  }
}

/** Own a Workspace preview without retaining a Session, querying a job or changing its event log.
 * @returns Exact-Session reader and post-persistence invalidation channel.
 */
export function createConversationImageTrialPreview() {
  const listeners = new Set<(sessionId: SessionId) => void>()
  const observed = new Set<SessionId>()
  let storageWindow: Window | undefined
  let live = true
  const changed = (sessionId: SessionId): void => {
    if (!live) return
    for (const notify of listeners) {
      try { notify(sessionId) } catch { console.error('image trial Session preview notification failed') }
    }
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null) {
      for (const sessionId of observed) changed(sessionId)
    } else {
      const prefix = `${IMAGE_TRIAL_STORE_KEY}.`
      if (event.key.startsWith(prefix)) changed(event.key.slice(prefix.length) as SessionId)
    }
  }
  const stopStorage = (): void => {
    storageWindow?.removeEventListener('storage', onStorage)
    storageWindow = undefined
  }
  const provider: WorkspaceSessionPreviewProvider = {
    read(sessionId) {
      if (!live) return null
      observed.add(sessionId)
      return readStored(sessionId)
    },
    subscribe(notify) {
      if (!live) return () => {}
      const listener = (sessionId: SessionId): void => { notify(sessionId) }
      listeners.add(listener)
      if (storageWindow === undefined && typeof window !== 'undefined') {
        storageWindow = window
        storageWindow.addEventListener('storage', onStorage)
      }
      return () => { listeners.delete(listener); if (listeners.size === 0) stopStorage() }
    },
  }
  return { provider, changed,
    dispose(): void {
      if (!live) return
      live = false; stopStorage(); listeners.clear(); observed.clear()
    },
  }
}
