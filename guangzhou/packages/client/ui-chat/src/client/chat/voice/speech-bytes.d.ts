/**
 * Read a bounded same-origin WAV response, even when Content-Length is absent or false.
 * @param response - Authenticated audio response.
 * @param signal - Cancels reading and releases the response carrier.
 * @returns Complete RIFF/WAVE bytes within the 32 MiB bound.
 */
export declare function readSpeechBytes(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
//# sourceMappingURL=speech-bytes.d.ts.map