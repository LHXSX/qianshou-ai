/** Session-local references only: no image or video bytes are persisted in browser storage. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { VIDEO_TRIAL_UUID, type VideoTrialReference } from './video-trial-transport.ts'
export const VIDEO_TRIAL_STORE_KEY = 'qianshou.video-trials'
export interface VideoTrialCall {
  id: string
  sessionId: SessionId
  createdAt: string
  prompt: string
  request: VideoTrialReference | null
  source: { kind: 'generated' } | { kind: 'attachment'; mediaType: 'image/png' | 'image/jpeg'; sha256: string }
    | { kind: 'reuse'; jobId: string }
  submission: 'pending' | 'settled'
  rejection?: 'busy' | 'refused'
  rejectionCode?: string
}
/** Declare only add/update/remove for recoverable per-Session trial references. */
export function createVideoTrialStore() {
  return defineStore({ init: (): { calls: VideoTrialCall[] } => ({ calls: [] }), persist: VIDEO_TRIAL_STORE_KEY,
    actions: {
      add: (draft, call: VideoTrialCall) => { if (!draft.calls.some(row => row.id === call.id)) draft.calls.push(call) },
      save: (draft, call: VideoTrialCall) => {
        const index = draft.calls.findIndex(row => row.id === call.id && row.sessionId === call.sessionId)
        if (index >= 0) draft.calls[index] = call
      },
      remove: (draft, call: VideoTrialCall) => {
        draft.calls = draft.calls.filter(row => row.id !== call.id || row.sessionId !== call.sessionId)
      },
    } })
}
/** Check identity and bounded, byte-free request fields before recovering a saved job. */
export function isVideoTrialCall(value: unknown, sessionId: SessionId): value is VideoTrialCall {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (row.sessionId !== sessionId || typeof row.id !== 'string' || !row.id.startsWith('video-trial-')
    || !VIDEO_TRIAL_UUID.test(row.id.slice('video-trial-'.length)) || typeof row.createdAt !== 'string'
    || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.prompt !== 'string' || row.prompt.length > 4000
    || typeof row.submission !== 'string' || !['pending', 'settled'].includes(row.submission)
    || row.source === null || typeof row.source !== 'object' || Array.isArray(row.source)) return false
  const source = row.source as Record<string, unknown>
  if (source.kind === 'attachment') {
    if (typeof source.mediaType !== 'string' || !['image/png', 'image/jpeg'].includes(source.mediaType)
      || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.sha256)
      || Object.keys(source).sort().join(',') !== 'kind,mediaType,sha256') return false
  } else if (source.kind === 'reuse') {
    if (typeof source.jobId !== 'string' || !VIDEO_TRIAL_UUID.test(source.jobId)
      || Object.keys(source).sort().join(',') !== 'jobId,kind') return false
  } else if (source.kind !== 'generated' || Object.keys(source).join(',') !== 'kind') return false
  if (row.rejection !== undefined && (typeof row.rejection !== 'string'
    || !['busy', 'refused'].includes(row.rejection) || row.request !== null)) return false
  if (row.rejectionCode !== undefined && (row.rejection === undefined || typeof row.rejectionCode !== 'string'
    || !/^VIDEO_TRIAL_[A-Z_]{1,80}$/u.test(row.rejectionCode))) return false
  if (row.request === null) return true
  if (row.request === undefined || typeof row.request !== 'object' || Array.isArray(row.request)) return false
  const request = row.request as Record<string, unknown>
  return typeof request.id === 'string' && VIDEO_TRIAL_UUID.test(request.id) && row.id === `video-trial-${request.id}`
    && request.sessionId === sessionId && request.prompt === row.prompt && request.seconds === 5
    && request.orientation === 'landscape' && request.quality === 'fast'
    && Object.keys(request).every(key => ['id', 'sessionId', 'prompt', 'seconds', 'orientation', 'quality', 'reuseJobId'].includes(key))
    && (source.kind === 'reuse' ? request.reuseJobId === source.jobId : request.reuseJobId === undefined)
}
/** Require a durable readback of the exact request before its sole POST. */
export function recordVideoTrialCall(actions: Pick<ReturnType<ReturnType<typeof createVideoTrialStore>['create']>['actions'], 'add' | 'remove'>,
  call: VideoTrialCall): boolean {
  try {
    actions.add(call)
    const raw = localStorage.getItem(`${VIDEO_TRIAL_STORE_KEY}.${call.sessionId}`)
    const saved: unknown = raw === null ? null : JSON.parse(raw)
    if (saved !== null && typeof saved === 'object' && 'calls' in saved && Array.isArray(saved.calls)
      && saved.calls.some(row => isVideoTrialCall(row, call.sessionId) && JSON.stringify(row) === JSON.stringify(call))) return true
  } catch { /* Storage failure cannot authorize external work. */ }
  actions.remove(call)
  return false
}
