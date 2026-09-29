/**
 * Take exclusive output ownership and cancel the previous owner without completing it.
 * @param supersede - Stop this owner's audio/queue and notify its UI when another owner takes over.
 * @param owner - Stable capture-controller identity, omitted for manual outputs.
 * @returns Idempotent release that cannot revoke a newer owner's claim.
 */
export declare function claimSpeechOutput(supersede: () => void, owner?: symbol): () => void;
/**
 * Observe new output ownership so capture controllers can pause before another output starts.
 * @param listener - Synchronous capture guard; the owner's own identity can be ignored.
 * @returns Idempotent unsubscription.
 */
export declare function subscribeSpeechClaims(listener: (owner: symbol | undefined) => void): () => void;
//# sourceMappingURL=speech-ownership.d.ts.map