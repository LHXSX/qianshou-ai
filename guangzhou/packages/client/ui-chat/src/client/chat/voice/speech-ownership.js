/** One audible output owner shared by automatic replies, read-aloud and voice previews. */
let active;
const listeners = new Set();
/**
 * Take exclusive output ownership and cancel the previous owner without completing it.
 * @param supersede - Stop this owner's audio/queue and notify its UI when another owner takes over.
 * @param owner - Stable capture-controller identity, omitted for manual outputs.
 * @returns Idempotent release that cannot revoke a newer owner's claim.
 */
export function claimSpeechOutput(supersede, owner) {
    const previous = active;
    const own = { supersede };
    active = own;
    try {
        previous?.supersede();
    }
    catch { /* A disposed output's UI cannot prevent its replacement. */ }
    if (active === own)
        for (const listener of listeners) {
            try {
                listener(owner);
            }
            catch { /* A detached capture view cannot take over the new output. */ }
        }
    return () => { if (active === own)
        active = undefined; };
}
/**
 * Observe new output ownership so capture controllers can pause before another output starts.
 * @param listener - Synchronous capture guard; the owner's own identity can be ignored.
 * @returns Idempotent unsubscription.
 */
export function subscribeSpeechClaims(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
//# sourceMappingURL=speech-ownership.js.map