import type { Context } from '@deepseek-ai/cordis';
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
/** Durable acceptance evidence, independent of the parent's model turns. */
export interface ParallelDispatchData {
    readonly receipt: SessionEventMap['parallel/dispatched'];
    readonly seq: number;
    readonly time: number;
}
declare module '../contract/chat-nodes.ts' {
    interface ChatNodeDataMap {
        /** Original human submission and its accepted independent child address. */
        'parallel-dispatch': ParallelDispatchData;
    }
}
/** Log-only independent-task receipts remain visible without starting a parent turn. */
export declare const parallelDispatchDefinition: ConversationNodeDefinition<ParallelDispatchData>;
/**
 * Register the durable independent-task acceptance presentation.
 * @param ctx - Owning UI Conversation context.
 */
export declare function registerParallelDispatchConversationNode(ctx: Context): void;
//# sourceMappingURL=parallel-dispatch.d.ts.map