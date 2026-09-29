/**
 * Combine short sentences without delaying the first audio behind a long passage.
 * @param text - Plain speech text.
 * @returns Lossless Unicode chunks: a substantive first sentence up to 48 code points, then 120.
 */
export function speechChunks(text) {
    const chunks = [];
    let pending = [];
    const flush = () => { if (pending.length > 0) {
        chunks.push(pending.join(''));
        pending = [];
    } };
    for (const sentence of text.match(/[^。！？.!?\n]*[。！？.!?\n]+|[^。！？.!?\n]+$/gu) ?? []) {
        const remaining = Array.from(sentence);
        while (remaining.length > 0) {
            const limit = chunks.length === 0 ? 48 : 120;
            if (pending.length > 0 && remaining.length <= limit && pending.length + remaining.length > limit) {
                flush();
                continue;
            }
            pending.push(...remaining.splice(0, limit - pending.length));
            if (pending.length === limit)
                flush();
        }
        if (chunks.length === 0 && pending.length >= 10)
            flush();
    }
    flush();
    return chunks;
}
//# sourceMappingURL=speech-chunks.js.map