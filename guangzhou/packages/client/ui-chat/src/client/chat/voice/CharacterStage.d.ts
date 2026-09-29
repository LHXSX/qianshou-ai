import type { ReactNode } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { type CharacterFrame } from './character-position.ts';
/** Character chrome is independent from microphone and task ownership. */
export interface CharacterStageProps extends PropsLocale<'chat'> {
    readonly state: 'idle' | 'listening' | 'speaking' | 'busy';
    readonly status: string;
    readonly onClose: () => void;
    readonly onInterrupt?: (() => void) | undefined;
    readonly revealControls?: boolean | undefined;
    readonly renderCharacter: (frame: CharacterFrame) => ReactNode;
    readonly children?: ReactNode;
}
/**
 * Render a movable character without intercepting clicks through its canvas.
 * @param props - Renderer, real controller status, and owner-provided voice controls.
 * @returns A body portal; only the control strip and expanded details accept pointer input.
 */
export declare function CharacterStage({ state, status, onClose, onInterrupt, revealControls, renderCharacter, children, t }: CharacterStageProps): import("react").ReactPortal;
//# sourceMappingURL=CharacterStage.d.ts.map