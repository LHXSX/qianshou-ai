/** Session-local formal request references and displayed quotes; credentials and media bytes are never persisted. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FORMAL_MEDIA_UUID, formalMediaQuote, isFormalMediaInput, sameFormalMediaInput,
  type FormalMediaAssetIntent, type FormalMediaInput, type FormalMediaQuote } from './formal-media-transport.ts'

export const FORMAL_MEDIA_STORE_KEY = 'qianshou.formal-media-calls'
export interface FormalMediaCall {
  id: string
  sessionId: SessionId
  createdAt: string
  requestId: string
  input: FormalMediaInput
  quote: FormalMediaQuote | null
  submission: 'assets-pending' | 'quoting' | 'quoted' | 'uncertain' | 'submitted' | 'quote-failed'
  taskId: string | null
  assetUploads?: Array<FormalMediaAssetIntent & { status: 'uncertain' | 'registered' }>
  errorCode?: string
}
/** Declare only persisted references and local interaction transitions for one conversation. */
export function createFormalMediaStore() {
  return defineStore({ persist: FORMAL_MEDIA_STORE_KEY, init: (): { calls: FormalMediaCall[] } => ({ calls: [] }),
    actions: {
      add: (draft, call: FormalMediaCall) => {
        if (!draft.calls.some(r => r.id === call.id) && draft.calls.length < 128) draft.calls.push(call)
      },
      save: (draft, call: FormalMediaCall) => {
        const index = draft.calls.findIndex(r => r.id === call.id && r.sessionId === call.sessionId)
        if (index >= 0) draft.calls[index] = call
      },
      remove: (draft, call: FormalMediaCall) => {
        draft.calls = draft.calls.filter(r => r.id !== call.id || r.sessionId !== call.sessionId)
      },
    } })
}
/** Admit cold references without letting storage authorize payment or cross-Session reads. */
export function isFormalMediaCall(value: unknown, sessionId: SessionId): value is FormalMediaCall {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['id', 'sessionId', 'createdAt', 'requestId', 'input', 'quote', 'submission', 'taskId', 'errorCode', 'assetUploads'].includes(key))
    || row.sessionId !== sessionId || typeof row.requestId !== 'string' || !FORMAL_MEDIA_UUID.test(row.requestId)
    || row.id !== `formal-media-${row.requestId}` || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
    || !isFormalMediaInput(row.input) || !['assets-pending', 'quoting', 'quoted', 'uncertain', 'submitted', 'quote-failed'].includes(String(row.submission))
    || (row.taskId !== null && (typeof row.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.taskId)))
    || (row.errorCode !== undefined && (typeof row.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,100}$/u.test(row.errorCode)))) return false
  if (row.quote !== null) {
    try {
      const quote = formalMediaQuote(row.quote, { sessionId, requestId: row.requestId })
      if (!sameFormalMediaInput(quote.input, row.input)) return false
    } catch { return false }
  }
  if (row.assetUploads !== undefined) {
    const input = row.input
    if (!Array.isArray(row.assetUploads) || row.assetUploads.length !== row.input.assets.length
      || !row.assetUploads.every((value, index) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
        const upload = value as Record<string, unknown>
        const asset = input.assets[index]
        return Object.keys(upload).sort().join(',') === 'assetId,mediaType,role,sessionId,sha256,status'
          && asset !== undefined && upload.assetId === asset.asset_id && upload.sessionId === sessionId
          && upload.sha256 === asset.sha256 && upload.role === asset.role && FORMAL_MEDIA_UUID.test(asset.asset_id)
          && ['image/png', 'image/jpeg'].includes(String(upload.mediaType)) && ['registered', 'uncertain'].includes(String(upload.status))
      })) return false
  }
  return true
}
/** Require an exact durable readback before confirming any paid POST. */
export function persistFormalMediaCall(actions: Pick<ReturnType<ReturnType<typeof createFormalMediaStore>['create']>['actions'], 'add' | 'save' | 'remove'>,
  call: FormalMediaCall, update = false): boolean {
  try {
    if (update) actions.save(call); else actions.add(call)
    const raw = localStorage.getItem(`${FORMAL_MEDIA_STORE_KEY}.${call.sessionId}`)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    if (value !== null && typeof value === 'object' && 'calls' in value && Array.isArray(value.calls)
      && value.calls.some(row => isFormalMediaCall(row, call.sessionId) && JSON.stringify(row) === JSON.stringify(call))) return true
  } catch { /* Storage failure cannot authorize a paid request. */ }
  if (!update) actions.remove(call)
  return false
}
