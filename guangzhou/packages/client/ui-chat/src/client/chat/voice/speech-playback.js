const listeners = new Set();
let playbackId = 0;
let current;
/**
 * Observe actual playback and synchronously replay its latest active start, without taking ownership.
 * @param listener - Presentation-only consumer; errors cannot interrupt speech.
 * @returns Idempotent unsubscription, with no audio or task side effects.
 */
export function subscribeSpeechPlayback(listener) {
    listeners.add(listener);
    if (current !== undefined) {
        try {
            listener(current);
        }
        catch { /* Initial visual state is optional, like subsequent observations. */ }
    }
    return () => { listeners.delete(listener); };
}
function publish(event) {
    for (const listener of listeners) {
        try {
            listener(event);
        }
        catch { /* Optional visualization must never break owned audio cleanup. */ }
    }
}
/**
 * Announce an actual media playing or system utterance start event.
 * @param source - Player and an independent WAV copy, or the system-voice marker.
 * @returns A once-only terminal event publisher for this playback identity.
 */
export function startSpeechPlayback(source) {
    const id = ++playbackId;
    let ended = false;
    current = { type: 'start', playbackId: id, ...source };
    publish(current);
    return (type) => {
        if (ended)
            return;
        ended = true;
        if (current?.playbackId === id)
            current = undefined;
        publish({ type, playbackId: id });
    };
}
//# sourceMappingURL=speech-playback.js.map