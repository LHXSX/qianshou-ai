/** Persist only Session-bound trial drafts and Host request references. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ImageTrialRequest, ImageTrialSize, ImageTrialSteps } from './image-trial-transport.ts'
export const IMAGE_TRIAL_STORE_KEY = 'qianshou.image-trials'
export interface ImageTrialCall {
  id: string
  sessionId: SessionId
  createdAt: string
  prompt: string
  size: ImageTrialSize
  /** Missing on historical cards, which always requested eight steps. */
  steps?: ImageTrialSteps
  request: ImageTrialRequest | null
  /** Pending survives reload for read-only reconciliation; it never authorizes replay. */
  submission?: 'pending' | 'settled'
  rejection?: 'busy' | 'credential' | 'rejected'
}
/** Declare the complete mutation set for one Session's image trial cards.
 * @returns A store handle instantiated by the slot renderer.
 */
export function createImageTrialStore() {
  return defineStore({
    init: (): { calls: ImageTrialCall[] } => ({ calls: [] }),
    persist: IMAGE_TRIAL_STORE_KEY,
    actions: {
      add: (draft, call: ImageTrialCall) => { if (!draft.calls.some(row => row.id === call.id)) draft.calls.push(call) },
      save: (draft, call: ImageTrialCall) => {
        const index = draft.calls.findIndex(row => row.id === call.id && row.sessionId === call.sessionId)
        if (index >= 0) draft.calls[index] = call
      },
      remove: (draft, call: ImageTrialCall) => {
        draft.calls = draft.calls.filter(row => row.id !== call.id || row.sessionId !== call.sessionId)
      },
    },
  })
}
/** Confirm the exact request is recoverable before allowing its first POST.
 * @param actions - The active Session's declared store actions.
 * @param call - New Session-bound request reference.
 * @returns Whether browser storage contains the exact pending request; failures remove its temporary row.
 */
export function recordImageTrialCall(actions: Pick<ReturnType<ReturnType<typeof createImageTrialStore>['create']>['actions'], 'add' | 'remove'>,
  call: ImageTrialCall): boolean {
  try {
    actions.add(call)
    const raw = localStorage.getItem(`${IMAGE_TRIAL_STORE_KEY}.${call.sessionId}`)
    const stored: unknown = raw === null ? null : JSON.parse(raw)
    if (stored !== null && typeof stored === 'object' && 'calls' in stored && Array.isArray(stored.calls)
      && stored.calls.some(row => isImageTrialCall(row, call.sessionId) && row.id === call.id
        && row.submission === 'pending' && row.request !== null && row.request.id === call.request?.id
        && row.prompt === call.prompt && row.size === call.size
        && (row.steps ?? 8) === (call.steps ?? 8))) return true
  } catch {
    // The shared viewing store tolerates storage failure; job submission must remain recoverable.
  }
  actions.remove(call)
  return false
}
/** Validate browser storage before reading a Host job under this Session.
 * @param value - Browser-local persisted row.
 * @param sessionId - Current Session.
 * @returns Whether the row can be restored without cross-Session reads.
 */
export function isImageTrialCall(value: unknown, sessionId: SessionId): value is ImageTrialCall {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as ImageTrialCall
  if (row.sessionId !== sessionId || typeof row.id !== 'string' || !/^image-trial-[0-9a-f-]{36}$/u.test(row.id)
    || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
    || typeof row.prompt !== 'string' || row.prompt.length > 4000
    || !['square', 'landscape', 'portrait'].includes(row.size)) return false
  if (row.submission !== undefined && !['pending', 'settled'].includes(row.submission)) return false
  if (row.steps !== undefined && ![8, 12, 20].includes(row.steps)) return false
  if (row.rejection !== undefined && (!['busy', 'credential', 'rejected'].includes(row.rejection) || row.request !== null)) return false
  return row.request === null || (typeof row.request === 'object'
    && typeof row.request.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(row.request.id)
    && row.request.sessionId === sessionId && row.request.prompt === row.prompt && row.request.size === row.size
    && (row.request.steps ?? 8) === (row.steps ?? 8))
}
