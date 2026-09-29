import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatSnapshot } from '../../contract/snapshot.ts';
export interface VoiceInjected {
    status: (signal: AbortSignal) => Promise<boolean>;
    transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>;
    stopAgent: () => void;
    hooks: {
        voiceBlock: ObservableSnapshot<ComposerBlock | undefined>;
    };
}
type VoiceProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'chat'> & InjectFace<VoiceInjected>;
type VoiceReply = {
    readonly seq: number;
    readonly text: string;
};
/**
 * Read the latest closed Turn's final output through at most two Locations.
 * Reactive consumers must also subscribe to its keyed turn-tail data source.
 * @param chat - current framework-owned Chat snapshot.
 * @returns the closed final answer, or null when no final answer is available.
 */
export declare function latestVoiceReply(chat: ChatSnapshot): VoiceReply | null;
/** Local interaction controller. Agent state and approvals remain owned by the existing session. */
export declare function VoiceConversation({ sessionId, useSession, useSessions, useChat, useInput, inputActions, useSessionPendingInteraction, useVoiceBlock, status, transcribe, stopAgent, t, }: VoiceProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=VoiceConversation.d.ts.map