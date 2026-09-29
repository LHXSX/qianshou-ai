import { type VoiceId } from './voice-catalog.ts';
/**
 * Remove Markdown notation and code blocks without altering the transcript.
 * @param text - Completed assistant reply text.
 * @returns Plain text suitable for speech playback.
 */
export declare function spokenText(text: string): string;
/**
 * Read replies with one fixed speaker; use system speech only when no neural speaker is selected.
 * @param text - Completed assistant reply to speak.
 * @param language - Preferred speech language, such as zh-CN.
 * @param onDone - Called after every chunk finishes, or immediately for empty spoken text.
 * @param onError - Called for status, synthesis or playback failure; neural failures never silently fall back.
 * @param requestedSpeaker - Chosen speaker; storage then the host default apply when omitted.
 * An unavailable selected voice fails without changing engines.
 * @param onSuperseded - Separate cancellation notification when another audible output takes over; never completion.
 * @param owner - Capture controller that owns this reply; manual outputs omit it.
 * @returns Idempotent cancellation that suppresses remaining callbacks and chunks.
 */
export declare function speakReply(text: string, language: string, onDone: () => void, onError: () => void, requestedSpeaker?: VoiceId, onSuperseded?: () => void, owner?: symbol): () => void;
//# sourceMappingURL=speech.d.ts.map