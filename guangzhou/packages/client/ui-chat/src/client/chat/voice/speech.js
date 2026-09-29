import { claimSpeechOutput } from "./speech-ownership.js";
import { speechChunks } from "./speech-chunks.js";
import { readSpeechBytes } from "./speech-bytes.js";
import { startSpeechPlayback } from "./speech-playback.js";
import { toVoiceId, loadPlaybackSpeaker, rememberPlaybackSpeaker } from "./voice-catalog.js";
/**
 * Remove Markdown notation and code blocks without altering the transcript.
 * @param text - Completed assistant reply text.
 * @returns Plain text suitable for speech playback.
 */
export function spokenText(text) {
    return text.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\s{0,3}[#>]+\s*/gm, '')
        .replace(/[*_`~]/g, '').trim();
}
/** Pin an enumerated system voice, allowing a bounded initial inventory update. */
async function systemVoiceFor(speech, language, signal) {
    const choose = () => {
        const voices = speech.getVoices().filter(item => item.lang.toLowerCase().startsWith(language.slice(0, 2).toLowerCase()));
        return voices.find(item => /ting[ -]?ting|婷婷/i.test(item.name))
            ?? voices.find(item => item.lang.toLowerCase() === language.toLowerCase()) ?? voices[0];
    };
    const initial = choose();
    if (initial !== undefined || signal.aborted)
        return initial;
    await new Promise((resolve) => {
        const finish = () => {
            clearTimeout(deadline);
            speech.removeEventListener('voiceschanged', finish);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const deadline = setTimeout(finish, 600);
        speech.addEventListener('voiceschanged', finish);
        signal.addEventListener('abort', finish, { once: true });
    });
    signal.throwIfAborted();
    return choose();
}
/**
 * Read replies with one fixed speaker; use system speech only when no neural speaker is selected.
 * @param text - Completed assistant reply to speak.
 * @param language - Preferred speech language, such as zh-CN.
 * @param onDone - Called after every chunk finishes, or immediately for empty spoken text.
 * @param onError - Called for status, synthesis or playback failure; neural failures never silently fall back.
 * @param requestedSpeaker - Chosen speaker; storage then the host default apply when omitted.
 * An unavailable selected voice fails without changing engines.
 * @param onSuperseded - Separate cancellation notification when another audible output takes over; never completion.
 * @param owner - Capture controller that owns this reply; manual outputs omit it.
 * @returns Idempotent cancellation that suppresses remaining callbacks and chunks.
 */
export function speakReply(text, language, onDone, onError, requestedSpeaker, onSuperseded, owner) {
    const speech = window.speechSynthesis;
    const selectedSpeaker = toVoiceId(requestedSpeaker) ?? loadPlaybackSpeaker();
    const cleaned = spokenText(text);
    if (cleaned === '') {
        onDone();
        return () => { };
    }
    const chunks = speechChunks(cleaned);
    const controller = new AbortController();
    let settled = false;
    let releaseOwnership = () => { };
    const isSettled = () => settled;
    let index = 0;
    let timer;
    let audio;
    let audioUrl;
    let usesSystemVoice = false;
    let currentUtterance;
    let systemVoice;
    let prepared;
    let finishPlayback;
    const endPlayback = (type) => {
        finishPlayback?.(type);
        finishPlayback = undefined;
    };
    const releaseAudio = () => {
        if (audio) {
            audio.onplaying = null;
            audio.onended = null;
            audio.onerror = null;
            try {
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
            }
            catch { /* Detached media may already be closed. */ }
            audio = undefined;
        }
        if (audioUrl !== undefined) {
            URL.revokeObjectURL(audioUrl);
            audioUrl = undefined;
        }
    };
    const cleanup = () => {
        releaseOwnership();
        controller.abort();
        prepared = undefined;
        clearTimeout(timer);
        releaseAudio();
        if (currentUtterance !== undefined) {
            currentUtterance.onstart = null;
            currentUtterance.onend = null;
            currentUtterance.onerror = null;
            currentUtterance = undefined;
        }
        if (usesSystemVoice) {
            try {
                speech.cancel();
            }
            catch { /* An unavailable system engine cannot keep playing. */ }
        }
    };
    const fail = () => {
        if (isSettled())
            return;
        settled = true;
        endPlayback('error');
        cleanup();
        onError();
    };
    const done = () => {
        if (isSettled())
            return;
        settled = true;
        endPlayback('end');
        cleanup();
        onDone();
    };
    const nextSystem = () => {
        if (isSettled())
            return;
        const chunk = chunks[index++];
        if (chunk === undefined) {
            done();
            return;
        }
        try {
            const utterance = new SpeechSynthesisUtterance(chunk);
            currentUtterance = utterance;
            utterance.lang = language;
            if (systemVoice !== undefined)
                utterance.voice = systemVoice;
            utterance.rate = 1.03;
            let ended = false;
            utterance.onstart = () => {
                if (isSettled() || currentUtterance !== utterance || finishPlayback !== undefined)
                    return;
                finishPlayback = startSpeechPlayback({ source: 'system' });
            };
            utterance.onend = () => {
                if (isSettled() || ended)
                    return;
                ended = true;
                endPlayback('end');
                utterance.onstart = null;
                utterance.onend = null;
                utterance.onerror = null;
                currentUtterance = undefined;
                timer = setTimeout(nextSystem, 80);
            };
            utterance.onerror = fail;
            speech.speak(utterance);
        }
        catch {
            fail();
        }
    };
    // A single prepared successor overlaps synthesis with audible playback.
    // Its result is consumed only after the current player ends, including failures.
    const prepareNext = (speaker) => {
        if (prepared !== undefined || isSettled())
            return;
        const chunk = chunks[index++];
        if (chunk === undefined)
            return;
        prepared = (async () => {
            const request = new AbortController();
            let abort;
            let deadline;
            const cancelled = new Promise((_, reject) => {
                abort = () => { request.abort(); reject(new Error('REQUEST_ABORTED')); };
                controller.signal.addEventListener('abort', abort, { once: true });
                deadline = setTimeout(() => { request.abort(); reject(new Error('SYNTHESIS_FAILED')); }, 210_000);
            });
            try {
                const bytes = await Promise.race([fetch('/api/forge/voice/synthesize', {
                        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: chunk, speaker }), signal: request.signal,
                    }).then(async (response) => {
                        if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'audio/wav')
                            throw new Error('SYNTHESIS_FAILED');
                        return await readSpeechBytes(response, request.signal);
                    }), cancelled]);
                return { bytes };
            }
            catch (error) {
                return { error };
            }
            finally {
                clearTimeout(deadline);
                controller.signal.removeEventListener('abort', abort);
            }
        })();
    };
    const nextNeural = async (speaker) => {
        if (isSettled())
            return;
        prepareNext(speaker);
        const next = prepared;
        prepared = undefined;
        if (next === undefined) {
            done();
            return;
        }
        const result = await next;
        if (isSettled())
            return;
        if ('error' in result) {
            fail();
            return;
        }
        try {
            const bytes = result.bytes;
            audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
            const player = new Audio(audioUrl);
            audio = player;
            player.onplaying = () => {
                if (isSettled() || audio !== player || finishPlayback !== undefined)
                    return;
                rememberPlaybackSpeaker(speaker);
                finishPlayback = startSpeechPlayback({ source: 'neural', element: player, wav: bytes.slice().buffer });
                prepareNext(speaker);
            };
            player.onended = () => {
                if (isSettled() || audio !== player)
                    return;
                clearTimeout(timer);
                endPlayback('end');
                releaseAudio();
                void nextNeural(speaker);
            };
            player.onerror = fail;
            timer = setTimeout(fail, 180_000);
            await player.play();
        }
        catch {
            fail();
        }
    };
    const start = async () => {
        timer = setTimeout(fail, 30_000);
        try {
            const response = await fetch('/api/forge/voice/tts/status', { credentials: 'same-origin', signal: controller.signal });
            if (isSettled())
                return;
            let available = false;
            let speaker = 'Vivian';
            if (response.status !== 404) {
                if (!response.ok)
                    throw new Error('SYNTHESIS_FAILED');
                const status = await response.json();
                if (isSettled())
                    return;
                if (!status || typeof status !== 'object' || !('available' in status) || typeof status.available !== 'boolean')
                    throw new Error('SYNTHESIS_FAILED');
                available = status.available;
                if (available) {
                    const reported = 'defaultSpeaker' in status ? toVoiceId(status.defaultSpeaker) : undefined;
                    if (reported === undefined)
                        throw new Error('SYNTHESIS_FAILED');
                    speaker = reported;
                }
            }
            clearTimeout(timer);
            // An unsupported stored choice keeps the host default instead of failing playback.
            if (available) {
                await nextNeural(selectedSpeaker ?? speaker);
            }
            else {
                if (selectedSpeaker !== undefined)
                    throw new Error('SELECTED_VOICE_UNAVAILABLE');
                usesSystemVoice = true;
                systemVoice = await systemVoiceFor(speech, language, controller.signal);
                if (isSettled())
                    return;
                // With no enumerated voice, one utterance avoids reselecting a changing browser default per sentence.
                if (systemVoice === undefined)
                    chunks.splice(0, chunks.length, cleaned);
                speech.cancel();
                nextSystem();
            }
        }
        catch {
            fail();
        }
    };
    const stop = () => {
        if (isSettled())
            return;
        settled = true;
        endPlayback('cancel');
        cleanup();
    };
    releaseOwnership = claimSpeechOutput(() => { stop(); onSuperseded?.(); }, owner);
    if (!isSettled())
        void start();
    return stop;
}
//# sourceMappingURL=speech.js.map