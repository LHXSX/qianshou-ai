/**
 * Voice catalog for the local neural speech endpoint: read the host's real
 * speaker list, reuse a previously chosen speaker, and keep the choice in
 * localStorage. The host accepts only bundled CustomVoice speakers, so a
 * selection that the host refuses stays selected with a visible error; only
 * the user can choose another identity.
 */
/** Speaker identifiers the bundled local worker can actually render. */
export declare const KNOWN_VOICES: readonly ["Vivian", "Serena"];
/** One selectable speaker as validated against the host contract. */
export type VoiceId = (typeof KNOWN_VOICES)[number];
/** localStorage key for the user's chosen speaker. */
export declare const VOICE_STORAGE_KEY = "qianshou.dsh.voice.speaker";
/** Window-local last audible neural identity; a preview never changes it. */
export declare const PLAYBACK_VOICE_STORAGE_KEY = "qianshou.dsh.voice.played-speaker";
/**
 * Resolve explicit preference before the last neural identity heard in this window.
 * @returns A supported speaker, or undefined before neural playback has selected one.
 */
export declare function loadPlaybackSpeaker(): VoiceId | undefined;
/**
 * Keep automatic replies and manual read-aloud on the same already-audible identity.
 * @param speaker - Validated speaker whose reply audio actually started playing.
 */
export declare function rememberPlaybackSpeaker(speaker: VoiceId): void;
/** Short utterance used by the preview button; well inside the host character limit. */
export declare const VOICE_PREVIEW_TEXT = "\u4F60\u597D\uFF0C\u6211\u662F\u5343\u624B\u5C0F\u7BA1\u5BB6\uFF0C\u8FD9\u662F\u73B0\u5728\u7684\u58F0\u7EBF\u3002";
/** Partial status payload confirmed by `packages/host/voice-local/src/tts-engine.ts`. */
export interface VoiceStatus {
    readonly available: boolean;
    readonly ready?: boolean | undefined;
    readonly engine?: string | undefined;
    readonly speakers: readonly string[];
    readonly defaultSpeaker: string;
}
/** Resolved catalog for the picker; `speakers` is always the host-reported list. */
export interface VoiceCatalog {
    /** False when neural synthesis is not installed, disabled, unauthenticated, or unreachable. */
    readonly available: boolean;
    /** Host-reported speakers, in host order; empty when the status read failed. */
    readonly speakers: readonly VoiceId[];
    /** Speaker currently used for replies and previews. */
    readonly selected: VoiceId;
    /** True when the selected identity is absent from the available host list. */
    readonly selectionUnavailable: boolean;
}
/** A catalog plus the reason the host status could not be used, for visible reporting. */
export interface VoiceCatalogLoad {
    readonly catalog: VoiceCatalog;
    readonly statusError: boolean;
}
/**
 * Narrow one untrusted value to a supported speaker.
 * @param value - Candidate from storage, status, or a DOM event.
 * @returns the speaker id, or undefined when the host could not render it.
 */
export declare function toVoiceId(value: unknown): VoiceId | undefined;
/**
 * Read the stored speaker without letting storage failures break the picker.
 * @param storage - Storage to read; defaults to the browser localStorage.
 * @returns the stored speaker, or undefined when absent, invalid, or unavailable.
 */
export declare function loadPreferredSpeaker(storage?: Pick<Storage, 'getItem'>): VoiceId | undefined;
/**
 * Persist the chosen speaker; a blocked or full storage is reported, never thrown.
 * @param speaker - Speaker to remember for later sessions.
 * @param storage - Storage to write; defaults to the browser localStorage.
 * @returns true when the value was actually written.
 */
export declare function savePreferredSpeaker(speaker: VoiceId, storage?: Pick<Storage, 'setItem'>): boolean;
/**
 * Pick the speaker this catalog should use, honoring the user over the host default.
 * @param speakers - Host-reported speakers, already validated.
 * @param preferred - Speaker previously chosen by the user or heard in this window.
 * @param fallback - Host default used only before any identity has been selected.
 * @returns the preserved identity and whether the host currently lacks it.
 */
export declare function resolveVoice(speakers: readonly VoiceId[], preferred: VoiceId | undefined, fallback: VoiceId): {
    speaker: VoiceId;
    selectionUnavailable: boolean;
};
/**
 * Read the host status and fold it into a usable catalog.
 * A 404 means neural speech is not installed in this deployment and is treated
 * as plain unavailability; any other non-OK answer is an observable failure.
 * @param signal - Cancels the status read when the panel closes.
 * @param storage - Storage override for tests.
 * @returns the catalog plus whether the host status itself failed.
 */
export declare function loadVoiceCatalog(signal?: AbortSignal, storage?: Pick<Storage, 'getItem'>): Promise<VoiceCatalogLoad>;
/**
 * Synthesize and play one short sample so the user can hear a speaker before
 * committing to it. Failures are surfaced through `onError`, never swallowed.
 * @param text - Short utterance to synthesize.
 * @param speaker - Speaker the host must render; rejected values fail visibly.
 * @param onError - Called for a rejected request, invalid WAV, or playback failure.
 * @param onEnded - Called once when the sample finished playing normally.
 * @param onPlaying - Called once after the media element actually begins playback.
 * @param onSuperseded - Called when another audio output cancels this preview; never success or failure.
 * @returns Idempotent cancellation that stops playback and releases the object URL.
 */
export declare function playVoiceSample(text: string, speaker: VoiceId, onError: () => void, onEnded?: () => void, onPlaying?: () => void, onSuperseded?: () => void): () => void;
//# sourceMappingURL=voice-catalog.d.ts.map