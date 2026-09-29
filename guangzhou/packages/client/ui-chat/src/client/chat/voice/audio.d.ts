export declare class SpeechSegmenter {
    private frames;
    private preRoll;
    private elapsed;
    private quiet;
    private voiced;
    private started;
    private noise;
    /** Whether speech is currently buffered, used to avoid talking over the user. */
    get speaking(): boolean;
    /** Clear all buffered audio between user turns, playback, and cancellation. */
    reset(): void;
    /**
     * Buffer sustained speech until a 1.1 second pause or the segment duration limit.
     * @param frame - The next mono audio frame.
     * @param sampleRate - Source audio samples per second.
     * @returns One completed utterance, or null while buffering or discarding noise.
     */
    push(frame: Float32Array, sampleRate: number): Float32Array | null;
}
/**
 * Encode mono samples as 16 kHz PCM16 WAV using box-filter downsampling.
 * @param samples - Source mono floating-point audio samples.
 * @param inputRate - Source samples per second.
 * @returns A WAV blob suitable for the local transcription endpoint.
 */
export declare function encodeWav(samples: Float32Array, inputRate: number): Blob;
/** Owned microphone capture and local segmentation controls. */
export interface Microphone {
    /** Whether the acquired track confirms browser echo cancellation. */
    readonly bargeInAvailable: boolean;
    /** Enable ordinary capture, or mute and discard buffered samples. */
    listen(enabled: boolean): void;
    /** Monitor speech during playback only with confirmed echo cancellation; otherwise mute. */
    monitorPlayback(): void;
    /** Whether a user utterance is being captured. */
    isVoicing(): boolean;
    /** Release the stream, audio graph, and all buffers. */
    close(): void;
}
/**
 * Open capture after an explicit user gesture; callers close it on stop or navigation.
 * @param onSegment - Receives a completed WAV segment with capture paused.
 * @param onLost - Reports the browser ending an owned input track.
 * @param onBargeIn - Stops owned playback after speech onset; capture continues with preserved pre-roll.
 * @returns Capture controls; permission or audio-graph failures reject after cleanup.
 */
export declare function openMicrophone(onSegment: (audio: Blob) => void, onLost: () => void, onBargeIn?: () => void): Promise<Microphone>;
//# sourceMappingURL=audio.d.ts.map