/** Per-Session market call display history; authoritative quotes and results remain in the Host. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MarketTaskContinuation } from './MarketTaskCall.tsx'
import { isMarketTaskDraft } from './market-task-draft.ts'

export interface ConversationMarketCall {
  id: string
  sessionId: SessionId
  createdAt: string
  capability: { taskType: string; capabilityId: string; name: string; category: string }
  /** Explicitly selected listing; generic @ requests omit this identity. */
  selectedProduct?: { productId: string; publicationId: string; ownerId: number; version: string }
  /** Local creative preparation created while no reviewed public video task was callable. */
  draftOnly?: true
  /** Explicit @出视频 entry, distinct from selecting a video capability or product in the market. */
  directVideoEntry?: true
  goal: string
  /** Account captured for optional picker history, never an authorization grant. Legacy rows omit it. */
  usageOwner?: number
  continuation: MarketTaskContinuation
}

interface ConversationMarketState {
  calls: ConversationMarketCall[]
}

/** Browser storage namespace shared with this feature's read-only Session preview. */
export const CONVERSATION_MARKET_STORE_KEY = 'qianshou.market-calls'

/** Declare browser-local Session call references and their complete write set.
 * @returns A handle instantiated by the Slot renderer for each Session.
 */
export function createConversationMarketStore() {
  return defineStore({
    init: (): ConversationMarketState => ({ calls: [] }),
    persist: CONVERSATION_MARKET_STORE_KEY,
    actions: {
      addCall: (draft, call: ConversationMarketCall) => {
        if (!Array.isArray(draft.calls)) throw new Error('MARKET_CALL_HISTORY_INVALID')
        if (!draft.calls.some(item => item.id === call.id)) draft.calls.push(call)
      },
      captureUsageOwner: (draft, id: string, owner: number) => {
        const call = draft.calls.find(item => item.id === id)
        if (call !== undefined && call.usageOwner === undefined) call.usageOwner = owner
      },
      continueCall: (draft, id: string, continuation: MarketTaskContinuation) => {
        if (!Array.isArray(draft.calls)) throw new Error('MARKET_CALL_HISTORY_INVALID')
        const call = draft.calls.find(item => item.id === id)
        if (call !== undefined) call.continuation = continuation
      },
    },
  })
}

/** Validate the saved display metadata before restoring a Host reference.
 * @param value - Browser-local JSON loaded by the declared store.
 * @param sessionId - Session that owns the current slot.
 * @returns Whether the row may be rendered and reconciled in this Session.
 */
export function isConversationMarketCall(value: unknown, sessionId: SessionId): value is ConversationMarketCall {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const capability = row.capability
  const continuation = row.continuation
  if (row.sessionId !== sessionId || typeof row.id !== 'string' || !/^market-call-[0-9a-f-]{36}$/u.test(row.id)
    || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
    || typeof row.goal !== 'string' || row.goal.length > 8000
    || capability === null || typeof capability !== 'object' || Array.isArray(capability)
    || continuation === null || typeof continuation !== 'object' || Array.isArray(continuation)) return false
  if (row.usageOwner !== undefined && (typeof row.usageOwner !== 'number'
    || !Number.isSafeInteger(row.usageOwner) || row.usageOwner < 1)) return false
  if (row.draftOnly !== undefined && (row.draftOnly !== true || row.selectedProduct !== undefined)) return false
  if (row.directVideoEntry !== undefined
    && (row.directVideoEntry !== true || row.selectedProduct !== undefined)) return false
  if (row.selectedProduct !== undefined) {
    if (row.selectedProduct === null || typeof row.selectedProduct !== 'object'
      || Array.isArray(row.selectedProduct)) return false
    const selected = row.selectedProduct as Record<string, unknown>
    if (Object.keys(selected).sort().join(',') !== 'ownerId,productId,publicationId,version'
      || ['productId', 'publicationId', 'version'].some(key =>
        typeof selected[key] !== 'string' || (selected[key] as string).length < 1
          || (selected[key] as string).length > 256)
      || !Number.isSafeInteger(selected.ownerId) || (selected.ownerId as number) < 1) return false
  } else if (row.goal.length < 1) return false
  const product = capability as Record<string, unknown>
  if (['taskType', 'capabilityId', 'name', 'category'].some(key =>
    typeof product[key] !== 'string' || product[key].length < 1 || product[key].length > 256)) return false
  if (row.directVideoEntry === true && (product.capabilityId !== 'video.render'
    || product.category !== 'video')) return false
  const saved = continuation as Record<string, unknown>
  if (saved.draft !== undefined && !isMarketTaskDraft(saved.draft)) return false
  const reference = (id: unknown): boolean => id === null || (typeof id === 'string'
    && /^[A-Za-z0-9._-]{1,128}$/u.test(id) && id !== '.' && id !== '..')
  if (!reference(saved.planId) || !reference(saved.workloadId)
    || !['idle', 'uncertain', 'submitted'].includes(String(saved.submission))
    || (saved.submission === 'uncertain' && saved.planId === null)
    || (saved.submission === 'submitted' && saved.workloadId === null)
    || (saved.amountYuan !== undefined && (typeof saved.amountYuan !== 'string'
      || !/^(?:0|[1-9]\d*)\.\d{2}$/u.test(saved.amountYuan)))) return false
  if (saved.decision !== undefined) {
    if (saved.decision === null || typeof saved.decision !== 'object' || Array.isArray(saved.decision)) return false
    const decision = saved.decision as Record<string, unknown>
    if (!['accept', 'reject'].includes(String(decision.decision)) || typeof decision.key !== 'string'
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(decision.key)) return false
  }
  return true
}
