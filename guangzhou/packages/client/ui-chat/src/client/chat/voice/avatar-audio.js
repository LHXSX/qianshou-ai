/** Audio-reactive portrait motion reads decoded playback samples without routing or recording sound. */
import { subscribeSpeechPlayback } from "./speech-playback.js";
const CLOSED = { pose: 'closed', openness: 0 };
const WINDOW_SAMPLES = 512;
/**
 * Estimate mouth energy and broad spectral color from the currently playing PCM window.
 * @param audio - Decoded TTS audio, never microphone capture.
 * @param time - The media element's current playback time in seconds.
 * @returns A limited pre-rendered pose and normalized mouth opening, with silence closed.
 */
export function analyzeAvatarAudio(audio, time) {
    const start = Math.floor(time * audio.sampleRate);
    if (!Number.isFinite(start) || start < 0 || start >= audio.length)
        return CLOSED;
    const samples = audio.getChannelData(0);
    const length = Math.min(WINDOW_SAMPLES, audio.length - start);
    let squareSum = 0;
    for (let index = 0; index < length; index++)
        squareSum += samples[start + index] ** 2;
    const rms = Math.sqrt(squareSum / length);
    if (rms < 0.008)
        return CLOSED;
    // Three broad bands choose visually different poses; they do not identify spoken vowels.
    const energies = [450, 1200, 2600].map(frequency => {
        const coefficient = 2 * Math.cos(2 * Math.PI * frequency / audio.sampleRate);
        let previous = 0;
        let beforePrevious = 0;
        for (let index = 0; index < length; index++) {
            const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1 || 1));
            const current = samples[start + index] * window + coefficient * previous - beforePrevious;
            beforePrevious = previous;
            previous = current;
        }
        return Math.max(0, previous ** 2 + beforePrevious ** 2 - coefficient * previous * beforePrevious);
    });
    const total = energies.reduce((sum, energy) => sum + energy, 0);
    const pose = total > 0 && energies[0] / total > 0.72 ? 'o'
        : total > 0 && energies[2] / total > 0.5 ? 'e' : 'a';
    return { pose, openness: Math.min(1, Math.max(0.2, (rms - 0.008) / 0.09)) };
}
/**
 * Observe live neural playback and close the mouth on silence, mute, pause, completion or disposal.
 * @param onFrame - Render callback; owns no playback, microphone or task controls.
 * @returns Unsubscribe and stop pending frame delivery. Late decoding cannot restart motion.
 */
export function observeAvatarSpeech(onFrame) {
    let active;
    let frameId;
    let disposed = false;
    const reset = (mode) => {
        if (frameId !== undefined)
            cancelAnimationFrame(frameId);
        frameId = undefined;
        onFrame({ mode, ...CLOSED });
    };
    const begin = async (event) => {
        let audio;
        try {
            // Offline decoding cannot seize the media element's output or request a microphone.
            const decoder = new OfflineAudioContext(1, 1, 16_000);
            audio = await decoder.decodeAudioData(event.wav.slice(0));
        }
        catch {
            if (!disposed && active === event)
                reset('unavailable');
            return;
        }
        if (disposed || active !== event)
            return;
        let lastDraw = -Infinity;
        let lastTime = -1;
        let lastAdvance = performance.now();
        let previousPose = 'closed';
        let poseSince = 0;
        let opening = 0;
        const draw = (now) => {
            if (disposed || active !== event)
                return;
            frameId = requestAnimationFrame(draw);
            if (now - lastDraw < 32)
                return;
            const elapsed = Math.min(100, now - lastDraw);
            lastDraw = now;
            const element = event.element;
            if (element.currentTime !== lastTime) {
                lastTime = element.currentTime;
                lastAdvance = now;
            }
            const quiet = element.paused || element.ended || element.muted || element.volume === 0
                || element.readyState < 2 || now - lastAdvance > 120;
            const next = quiet ? CLOSED : analyzeAvatarAudio(audio, element.currentTime);
            if (next.pose === 'closed') {
                previousPose = 'closed';
                opening = 0;
            }
            else {
                if (previousPose === 'closed' || now - poseSince >= 80) {
                    if (next.pose !== previousPose)
                        poseSince = now;
                    previousPose = next.pose;
                }
                opening += (next.openness - opening) * Math.min(1, elapsed / 65);
            }
            onFrame({ mode: 'audio', pose: previousPose, openness: opening });
        };
        frameId = requestAnimationFrame(draw);
    };
    onFrame({ mode: 'idle', ...CLOSED });
    const unsubscribe = subscribeSpeechPlayback(event => {
        if (event.type === 'start') {
            active = event;
            reset(event.source === 'system' ? 'system' : 'loading');
            if (event.source === 'neural')
                void begin(event);
        }
        else if (active?.playbackId === event.playbackId) {
            active = undefined;
            reset('idle');
        }
    });
    return () => {
        if (disposed)
            return;
        disposed = true;
        active = undefined;
        unsubscribe();
        reset('idle');
    };
}
//# sourceMappingURL=avatar-audio.js.map