/** Conservative playback-time speech onset detection over echo-cancelled microphone PCM. */
export declare class PlaybackSpeechGate {
    private frames;
    private seconds;
    private voiced;
    private quiet;
    private noise;
    /** Discard the current playback episode's candidate and pre-roll. */
    reset(): void;
    /**
     * Require sustained, speech-band activity and preserve the utterance onset.
     * @param frame - Echo-cancelled mono microphone samples.
     * @param sampleRate - Source samples per second.
     * @returns Buffered pre-roll and onset after confirmation, otherwise null.
     */
    push(frame: Float32Array, sampleRate: number): readonly Float32Array[] | null;
}
//# sourceMappingURL=barge-in.d.ts.map