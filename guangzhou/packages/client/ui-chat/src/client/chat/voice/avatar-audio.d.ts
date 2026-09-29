/** Pre-rendered mouth poses; these amplitude/spectrum estimates are not phoneme recognition. */
export type AvatarMouthPose = 'closed' | 'a' | 'o' | 'e';
/** A frame describes actual playback availability and the local mouth overlay. */
export interface AvatarAudioFrame {
    readonly mode: 'idle' | 'loading' | 'audio' | 'system' | 'unavailable';
    readonly pose: AvatarMouthPose;
    readonly openness: number;
}
/**
 * Estimate mouth energy and broad spectral color from the currently playing PCM window.
 * @param audio - Decoded TTS audio, never microphone capture.
 * @param time - The media element's current playback time in seconds.
 * @returns A limited pre-rendered pose and normalized mouth opening, with silence closed.
 */
export declare function analyzeAvatarAudio(audio: AudioBuffer, time: number): Pick<AvatarAudioFrame, 'pose' | 'openness'>;
/**
 * Observe live neural playback and close the mouth on silence, mute, pause, completion or disposal.
 * @param onFrame - Render callback; owns no playback, microphone or task controls.
 * @returns Unsubscribe and stop pending frame delivery. Late decoding cannot restart motion.
 */
export declare function observeAvatarSpeech(onFrame: (frame: AvatarAudioFrame) => void): () => void;
//# sourceMappingURL=avatar-audio.d.ts.map