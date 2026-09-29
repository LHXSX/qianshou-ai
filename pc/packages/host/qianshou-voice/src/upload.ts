/** Bounded streaming upload independent of Content-Length and transport cancellation callbacks. */
import { VoiceFailure } from './failure.ts'
import type { VoiceErrorCode } from './types.ts'
import { MAX_AUDIO_BYTES } from './wav.ts'

/**
 * Read one request body with a byte cap and independent upload deadline.
 * @param request - Authenticated Connection request.
 * @param lifetime - Request, Session and plugin cancellation combined by the owner.
 * @param timeoutMs - Maximum upload duration before cancellation.
 * @param maxBytes - Maximum accepted body size regardless of the declared Content-Length.
 * @param invalid - Failure code reported for an absent (400) or oversized (413) body.
 * @returns Complete bounded bytes; never a partial successful upload.
 */
export async function readBoundedBody(request: Request, lifetime: AbortSignal, timeoutMs: number, maxBytes: number,
  invalid: VoiceErrorCode): Promise<Buffer> {
  lifetime.throwIfAborted()
  const reader = request.body?.getReader()
  if (!reader) throw new VoiceFailure(invalid, 400)
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new VoiceFailure('VOICE_TIMEOUT', 504)) }, timeoutMs)
  timer.unref()
  const signal = AbortSignal.any([lifetime, deadline.signal])
  const bytes = Buffer.allocUnsafe(maxBytes)
  let total = 0
  let complete = false
  const cancel = (): void => {
    // A carrier's cancel callback may remain pending after releasing its reader.
    void reader.cancel(signal.reason).catch((error: unknown) => { void error })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const aborted = (): void => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'))
        }
        signal.addEventListener('abort', aborted, { once: true })
        void reader.read().then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
      })
      signal.throwIfAborted()
      if (chunk.done) { complete = true; break }
      if (total + chunk.value.byteLength > maxBytes) throw new VoiceFailure(invalid, 413)
      bytes.set(chunk.value, total)
      total += chunk.value.byteLength
    }
    return bytes.subarray(0, total)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    reader.releaseLock()
  }
}

/**
 * Read one WAV upload with the audio protocol cap and independent upload deadline.
 * @param request - Authenticated Connection request.
 * @param lifetime - Request, Session and plugin cancellation combined by the owner.
 * @param timeoutMs - Maximum upload duration before cancellation.
 * @returns Complete bounded audio bytes; never a partial successful upload.
 */
export function readAudioBody(request: Request, lifetime: AbortSignal, timeoutMs: number): Promise<Buffer> {
  return readBoundedBody(request, lifetime, timeoutMs, MAX_AUDIO_BYTES, 'INVALID_AUDIO')
}
