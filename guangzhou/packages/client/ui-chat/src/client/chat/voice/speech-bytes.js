/**
 * Read a bounded same-origin WAV response, even when Content-Length is absent or false.
 * @param response - Authenticated audio response.
 * @param signal - Cancels reading and releases the response carrier.
 * @returns Complete RIFF/WAVE bytes within the 32 MiB bound.
 */
export async function readSpeechBytes(response, signal) {
    const maximum = 32 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maximum)
        throw new Error('SYNTHESIS_FAILED');
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('SYNTHESIS_FAILED');
    let abort;
    const cancelled = new Promise((_, reject) => {
        abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('REQUEST_ABORTED')); };
        signal.addEventListener('abort', abort, { once: true });
    });
    let complete = false;
    try {
        const bytes = new Uint8Array(maximum);
        let length = 0;
        while (true) {
            signal.throwIfAborted();
            const chunk = await Promise.race([reader.read(), cancelled]);
            signal.throwIfAborted();
            if (chunk.done) {
                complete = true;
                break;
            }
            if (length + chunk.value.length > maximum)
                throw new Error('SYNTHESIS_FAILED');
            bytes.set(chunk.value, length);
            length += chunk.value.length;
        }
        const header = new DataView(bytes.buffer);
        if (length < 46 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'RIFF'
            || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'WAVE' || header.getUint32(4, true) + 8 !== length)
            throw new Error('SYNTHESIS_FAILED');
        return bytes.slice(0, length);
    }
    finally {
        signal.removeEventListener('abort', abort);
        if (!complete) {
            // A stalled carrier cancellation callback cannot keep this playback alive.
            void reader.cancel().catch(() => { });
        }
        reader.releaseLock();
    }
}
//# sourceMappingURL=speech-bytes.js.map