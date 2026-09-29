/**
 * Query the authenticated same-origin voice engine; failures use a localizable code.
 * @param signal - Cancels the request when voice mode ends or the session changes.
 * @returns Whether the local transcription engine is available.
 */
export async function voiceStatus(signal) {
    const response = await fetch('/api/forge/voice/status', { credentials: 'same-origin', signal });
    if (!response.ok)
        throw new Error('VOICE_UNAVAILABLE');
    const body = await response.json();
    return typeof body === 'object' && body !== null && 'available' in body && body.available === true;
}
/**
 * Upload one local PCM16 WAV segment to the authenticated same-origin engine.
 * @param audio - One mono 16 kHz PCM16 WAV utterance.
 * @param signal - Cancels transcription on pause, stop, or navigation.
 * @returns Trimmed recognized text; endpoint failures reject with a localizable code.
 */
export async function transcribeVoice(audio, signal) {
    const response = await fetch('/api/forge/voice/transcribe', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal,
    });
    const body = await response.json();
    if (!response.ok) {
        const code = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : 'TRANSCRIPTION_FAILED';
        throw new Error(code);
    }
    if (typeof body !== 'object' || body === null || !('text' in body) || typeof body.text !== 'string')
        throw new Error('TRANSCRIPTION_FAILED');
    return body.text.trim();
}
//# sourceMappingURL=api.js.map