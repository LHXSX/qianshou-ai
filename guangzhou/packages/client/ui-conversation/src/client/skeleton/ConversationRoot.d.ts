import type { ConversationSlotProps } from '../contract/slots.ts';
/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps;
/** Upper bound on the settling hide: the composer seat stays invisible only
 * while a pending phase can still be believed to resolve. A normal history
 * round-trip on a local Host settles well inside this; a window that does not
 * settle in this budget is stuck (dead stream, client-side assembly error, a
 * parent catalog that never reports), and the input box must not stay hidden
 * behind it. Comfortably above the slowest honest open, so an ordinary load
 * never flashes the composer. */
export declare const SETTLING_HOLD_BUDGET_MS = 5000;
export declare function ConversationRoot({ sessionId, useSession, useSessions, useSessionPendingInteraction, useWorkspaces, useConversation, useInput, useComposerBlock, renderSlot, renderSlotChain, selectWorkspace, inputActions, t, }: ConversationRootProps): import("react").JSX.Element;
//# sourceMappingURL=ConversationRoot.d.ts.map