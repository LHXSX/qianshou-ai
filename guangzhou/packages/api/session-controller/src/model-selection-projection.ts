/** Durable model-selection intent and request-use projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  ModelSelection,
  ModelSelectionProjection,
  ModelSelectionProjectionState,
} from './types.ts'

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  routing: z.object({ model: z.enum(['auto', 'manual']), effort: z.enum(['auto', 'manual']), candidates: z.array(z.string().min(1)).max(64) }).optional(),
}) as unknown as z.ZodType<ModelSelection>

const decisionSchema = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional(), reason: z.string(), status: z.enum(['selected', 'failed']) })

const modelSelectionProjectionStateSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  pending: modelSelectionSchema.nullable(),
  intent: modelSelectionSchema.nullable().optional(),
  routingDecisions: z.record(z.string(), decisionSchema).optional(),
  autoDecision: decisionSchema.nullable().optional(),
}) as unknown as z.ZodType<ModelSelectionProjectionState>

const modelSelectionProjectionSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  next: modelSelectionSchema.nullable(),
  autoDecision: decisionSchema.nullable().optional(),
}) as unknown as z.ZodType<ModelSelectionProjection>

/**
 * Advance durable model-selection state by one Session event.
 * @param state - selection state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced selection state.
 */
function applyModelSelectionProjection(
  state: ModelSelectionProjectionState,
  event: SessionEvent,
): ModelSelectionProjectionState {
  if (event.type === 'model/selection') {
    return sameSelection(state.pending, event.data)
      ? state
      : { ...state, lastUsed: state.lastUsed, pending: event.data, intent: event.data, autoDecision: null }
  }
  if (event.type === 'model/routing-decision') {
    const { taskId: _taskId, usage: _usage, ...autoDecision } = event.data
    return { ...state, autoDecision, routingDecisions: { ...state.routingDecisions, [event.data.taskId]: autoDecision } }
  }
  if (event.type !== 'request/header') return state
  const lastUsed: ModelSelection = {
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
    ...(event.data.header.config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(event.data.header.config.reasoningEffort) }),
  }
  const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
  return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
    ? state
    : { ...state, lastUsed, pending }
}

const modelSelectionProjection = {
  key: 'modelSelection',
  stateSchema: modelSelectionProjectionStateSchema,
  init: () => ({ lastUsed: null, pending: null }),
  apply: applyModelSelectionProjection,
  wire: {
    viewSchema: modelSelectionProjectionSchema,
    view: state => ({ lastUsed: state.lastUsed, next: state.intent?.routing === undefined ? state.pending ?? state.lastUsed : state.intent,
      ...(state.autoDecision === undefined ? {} : { autoDecision: state.autoDecision }) }),
  },
  stateVersion: 3,
} satisfies ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && JSON.stringify(left.routing) === JSON.stringify(right.routing))
}

/**
 * Register the durable model-selection projection when the registry is present.
 * @param ctx - Session Controller context.
 */
export function installModelSelectionProjection(ctx: Context): void {
  ctx.sessionProjections.register(modelSelectionProjection)
}
