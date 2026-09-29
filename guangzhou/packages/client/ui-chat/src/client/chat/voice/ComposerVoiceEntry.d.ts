import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
/** Delivery routes already owned by the voice interaction controller. */
export type VoiceDelivery = 'manager' | 'parallel' | 'current';
/** Presentation callbacks do not access microphone, playback, or task services. */
export interface ComposerVoiceEntryProps extends PropsLocale<'chat'> {
    readonly delivery: VoiceDelivery;
    readonly isSubagent: boolean;
    readonly onStartConversation: () => void;
    readonly onStartDictation: () => void;
    readonly onDeliveryChange: (delivery: VoiceDelivery) => void;
}
/**
 * Present a microphone action and an optional menu inside the resident composer.
 * @param props - current delivery choice and controller-owned actions.
 * @returns compact controls that open no microphone until a start action.
 */
export declare function ComposerVoiceEntry({ t, delivery, isSubagent, onStartConversation, onStartDictation, onDeliveryChange, }: ComposerVoiceEntryProps): import("react").JSX.Element;
//# sourceMappingURL=ComposerVoiceEntry.d.ts.map