import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode } from './common.ts'

/** Durable acceptance evidence, independent of the parent's model turns. */
export interface ParallelDispatchData {
  readonly receipt: SessionEventMap['parallel/dispatched']
  readonly seq: number
  readonly time: number
}

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Original human submission and its accepted independent child address. */
    'parallel-dispatch': ParallelDispatchData
  }
}

/** Log-only independent-task receipts remain visible without starting a parent turn. */
export const parallelDispatchDefinition: ConversationNodeDefinition<ParallelDispatchData> = {
  kind: 'parallel-dispatch',
  target: 'chat',
  match: event => event.type === 'parallel/dispatched'
    ? { id: String(event.data.requestId), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'parallel/dispatched') throw new Error('parallel-dispatch requires parallel/dispatched')
    return { receipt: match.event.data, seq: match.event.seq, time: match.event.time }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null
    : chatNode(context, 'parallel-dispatch', context.state.seq, context.state, { location: { kind: 'session' } }),
}

/**
 * Register the durable independent-task acceptance presentation.
 * @param ctx - Owning UI Conversation context.
 */
export function registerParallelDispatchConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(parallelDispatchDefinition)
}
