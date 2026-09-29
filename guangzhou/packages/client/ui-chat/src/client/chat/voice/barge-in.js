/** Conservative playback-time speech onset detection over echo-cancelled microphone PCM. */
export class PlaybackSpeechGate {
    frames = [];
    seconds = 0;
    voiced = 0;
    quiet = 0;
    noise = 0.006;
    /** Discard the current playback episode's candidate and pre-roll. */
    reset() {
        this.frames = [];
        this.seconds = 0;
        this.voiced = 0;
        this.quiet = 0;
        this.noise = 0.006;
    }
    /**
     * Require sustained, speech-band activity and preserve the utterance onset.
     * @param frame - Echo-cancelled mono microphone samples.
     * @param sampleRate - Source samples per second.
     * @returns Buffered pre-roll and onset after confirmation, otherwise null.
     */
    push(frame, sampleRate) {
        const duration = frame.length / sampleRate;
        let energy = 0;
        let crossings = 0;
        let previous;
        for (const value of frame) {
            energy += value * value;
            if (previous !== undefined && (value >= 0) !== (previous >= 0))
                crossings++;
            previous = value;
        }
        const rms = Math.sqrt(energy / frame.length);
        const crossingRate = crossings / duration;
        // A click or high-frequency hiss alone must not stop playback. This is an
        // onset heuristic, not speaker identification or a guarantee against echo.
        const speech = rms > Math.max(0.03, this.noise * 4) && crossingRate >= 100 && crossingRate <= 6000;
        this.frames.push(frame.slice());
        this.seconds += duration;
        while (this.frames.length > 1) {
            const first = this.frames[0];
            if (first === undefined || this.seconds - first.length / sampleRate < 0.6)
                break;
            this.frames.shift();
            this.seconds -= first.length / sampleRate;
        }
        if (speech) {
            this.voiced += duration;
            this.quiet = 0;
        }
        else {
            this.quiet += duration;
            if (this.quiet >= 0.08)
                this.voiced = 0;
            if (rms < 0.03)
                this.noise = this.noise * 0.95 + rms * 0.05;
        }
        if (this.voiced < 0.24)
            return null;
        const buffered = this.frames;
        this.reset();
        return buffered;
    }
}
//# sourceMappingURL=barge-in.js.map