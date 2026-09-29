/** Replayable observations for a local plan draft; not a quote or submission. */
import type { ComputePlanDraft } from './protocol.ts'

/** Wire identifier shared with the conversation task-card projection. */
export const PLAN_DRAFT_CARD_META_PROTOCOL = 'qianshou.task-card.v1' as const

/** Bounded fields persisted on `tool/result.meta` for `compute_plan_draft`. */
export interface PlanDraftCardMeta {
  protocol: typeof PLAN_DRAFT_CARD_META_PROTOCOL
  cardId: string
  title: string
  capabilityId: string
  budgetMinor: number
  currency: 'CNY'
  maxNodes: number | null
  createdAt: string
  reason: string
}

/**
 * Project a local draft into replayable card observations without quoting or submitting.
 * @param draft - Host-validated local plan receipt.
 * @returns JSON-safe metadata for the conversation task card.
 */
export function planDraftCardMeta(draft: ComputePlanDraft): PlanDraftCardMeta {
  return {
    protocol: PLAN_DRAFT_CARD_META_PROTOCOL,
    cardId: draft.id,
    title: draft.request.goal,
    capabilityId: draft.request.capabilityId,
    budgetMinor: draft.request.budgetMinor,
    currency: draft.request.currency,
    maxNodes: draft.request.maxNodes,
    createdAt: draft.createdAt,
    reason: draft.reason,
  }
}
