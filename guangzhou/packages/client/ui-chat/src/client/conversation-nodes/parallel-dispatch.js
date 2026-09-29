import { chatNode } from "./common.js";
/** Log-only independent-task receipts remain visible without starting a parent turn. */
export const parallelDispatchDefinition = {
    kind: 'parallel-dispatch',
    target: 'chat',
    match: event => event.type === 'parallel/dispatched'
        ? { id: String(event.data.requestId), role: 'start' }
        : null,
    start: (_context, match) => {
        if (match.event.type !== 'parallel/dispatched')
            throw new Error('parallel-dispatch requires parallel/dispatched');
        return { receipt: match.event.data, seq: match.event.seq, time: match.event.time };
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined ? null
        : chatNode(context, 'parallel-dispatch', context.state.seq, context.state, { location: { kind: 'session' } }),
};
/**
 * Register the durable independent-task acceptance presentation.
 * @param ctx - Owning UI Conversation context.
 */
export function registerParallelDispatchConversationNode(ctx) {
    ctx.uiConversation.events.register(parallelDispatchDefinition);
}
//# sourceMappingURL=parallel-dispatch.js.map