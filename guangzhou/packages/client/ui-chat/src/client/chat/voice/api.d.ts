/**
 * Query the authenticated same-origin voice engine; failures use a localizable code.
 * @param signal - Cancels the request when voice mode ends or the session changes.
 * @returns Whether the local transcription engine is available.
 */
export declare function voiceStatus(signal: AbortSignal): Promise<boolean>;
/**
 * Upload one local PCM16 WAV segment to the authenticated same-origin engine.
 * @param audio - One mono 16 kHz PCM16 WAV utterance.
 * @param signal - Cancels transcription on pause, stop, or navigation.
 * @returns Trimmed recognized text; endpoint failures reject with a localizable code.
 */
export declare function transcribeVoice(audio: Blob, signal: AbortSignal): Promise<string>;
//# sourceMappingURL=api.d.ts.map