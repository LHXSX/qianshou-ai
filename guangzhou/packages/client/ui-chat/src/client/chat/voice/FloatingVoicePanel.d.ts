/** Session-owned voice controls presented by the interactive character stage. */
import type { ReactNode } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
interface FloatingVoicePanelProps extends PropsLocale<'chat'> {
    readonly state: string;
    readonly status: string;
    readonly activity?: string | undefined;
    readonly onClose: () => void;
    readonly onInterrupt?: (() => void) | undefined;
    readonly revealControls?: boolean | undefined;
    readonly children: ReactNode;
}
/**
 * Project real voice activity onto a transparent, movable full-body character.
 * @param props - Existing controller state and actions; children remain mounted when tucked away.
 * @returns Character chrome without creating a microphone, task, or playback owner.
 */
export declare function FloatingVoicePanel({ state, status, activity, onClose, onInterrupt, revealControls, children, t, }: FloatingVoicePanelProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=FloatingVoicePanel.d.ts.map