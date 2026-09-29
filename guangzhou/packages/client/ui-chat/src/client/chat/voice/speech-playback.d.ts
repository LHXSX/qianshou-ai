/** Playback-only observations for visual consumers; never opens or samples a microphone. */
export type SpeechPlaybackEvent = {
    readonly type: 'start';
    readonly playbackId: number;
    readonly source: 'neural';
    readonly element: HTMLAudioElement;
    readonly wav: ArrayBuffer;
} | {
    readonly type: 'start';
    readonly playbackId: number;
    readonly source: 'system';
} | {
    readonly type: 'end' | 'cancel' | 'error';
    readonly playbackId: number;
};
type PlaybackSource = {
    readonly source: 'neural';
    readonly element: HTMLAudioElement;
    readonly wav: ArrayBuffer;
} | {
    readonly source: 'system';
};
type PlaybackEnd = 'end' | 'cancel' | 'error';
/**
 * Observe actual playback and synchronously replay its latest active start, without taking ownership.
 * @param listener - Presentation-only consumer; errors cannot interrupt speech.
 * @returns Idempotent unsubscription, with no audio or task side effects.
 */
export declare function subscribeSpeechPlayback(listener: (event: SpeechPlaybackEvent) => void): () => void;
/**
 * Announce an actual media playing or system utterance start event.
 * @param source - Player and an independent WAV copy, or the system-voice marker.
 * @returns A once-only terminal event publisher for this playback identity.
 */
export declare function startSpeechPlayback(source: PlaybackSource): (type: PlaybackEnd) => void;
export {};
//# sourceMappingURL=speech-playback.d.ts.map