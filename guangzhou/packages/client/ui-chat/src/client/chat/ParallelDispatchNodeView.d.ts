import type { SessionParallelValue } from '@deepseek-ai/dsh-api-session-controller/types';
import type { ChatNodeViewProps } from '../contract/slots.ts';
/** Navigation runs only after the user selects an accepted child's record. */
export interface ParallelDispatchInjected {
    openChild: (address: Pick<SessionParallelValue, 'parentSessionId' | 'childSessionId' | 'mode'>) => void;
}
/**
 * Show a durable independent-task submission without impersonating a CEO reply.
 * @param props - Accepted receipt, attachment presentation and explicit child navigation.
 * @returns the original message when recorded, followed by its dispatch receipt.
 */
export declare function ParallelDispatchNodeView({ node, renderMessageImages, openFile, openSkill, openChild, t, }: ChatNodeViewProps<'parallel-dispatch'> & ParallelDispatchInjected): import("react").JSX.Element;
//# sourceMappingURL=ParallelDispatchNodeView.d.ts.map