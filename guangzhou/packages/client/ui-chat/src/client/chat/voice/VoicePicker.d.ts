import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { VoiceId } from './voice-catalog.ts';
/** Observable preview lifecycle; only playing represents audible media. */
export type VoicePreviewState = 'idle' | 'preparing' | 'playing';
type VoicePickerProps = PropsLocale<'chat'> & {
    /** Reports the selected identity, or null when no identity is known. */
    readonly onVoiceChange?: ((speaker: VoiceId | null) => void) | undefined;
    /** Runs synchronously before synthesis so the capture owner can pause safely. */
    readonly onPreviewStart?: ((cancel: () => void) => void) | undefined;
    readonly onPreviewStateChange?: ((state: VoicePreviewState) => void) | undefined;
};
/**
 * Offer every speaker the host reports and remember the user's choice.
 * The list is never hard-coded: it comes from the authenticated status route,
 * and a stored speaker the host no longer accepts remains selected with
 * a visible notice until the user explicitly chooses another speaker.
 * @param props - framework-injected `t` seat plus the owner's change callback.
 * @returns a labelled speaker select with a preview button and honest status text.
 */
export declare function VoicePicker({ t, onVoiceChange, onPreviewStart, onPreviewStateChange }: VoicePickerProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=VoicePicker.d.ts.map