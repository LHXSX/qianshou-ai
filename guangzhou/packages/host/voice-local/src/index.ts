/** Local transcription and optional neural speech on authenticated Connection Fetch. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { transcribeVoice, voiceAvailable, type VoiceEngineOptions } from './engine.ts'
import { MAX_AUDIO_BYTES, validVoiceWav } from './wav.ts'
import { resolveTtsOptions, type TtsConfig } from './tts-config.ts'
import { registerTtsRoutes } from './tts-routes.ts'
import { VoiceActivityProjection } from './activity.ts'

export const name = 'forge-voice-local'
export const inject = ['connection']

/** Bounded uploads, local inference time limits, and optional neural synthesis assets. */
export interface Config extends TtsConfig {
  /** Maximum request-body upload duration in milliseconds; independent of recognition time. */
  uploadTimeoutMs?: number
  /** Maximum local recognizer process duration in milliseconds before forced termination. */
  recognitionTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  uploadTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  recognitionTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(90_000),
  ttsPythonPath: z.string().default(''),
  ttsWorkerPath: z.string().default(''),
  ttsModelPath: z.string().default(''),
  ttsDefaultSpeaker: z.union(['Vivian', 'Serena']).default('Vivian'),
  ttsMaxTextChars: z.number().step(1).min(1).max(2_000).default(500),
  ttsRequestTimeoutMs: z.number().step(1).min(1).max(600_000).default(180_000),
  ttsMaxOutputBytes: z.number().step(1).min(46).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  ttsMaxQueuedRequests: z.number().step(1).min(0).max(8).default(2),
  ttsIdleTimeoutMs: z.number().step(1).min(1).max(3_600_000).default(300_000),
})

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers })

/** Mount local voice routes without changing Session, tool, or approval policy. */
export function apply(ctx: Context, config: Config): void {
  // One projection per plugin fiber: real local voice work is observed here and nowhere else, and a consumer that
  // cannot reach this service must treat voice activity as unknown rather than assume the owner is away.
  const activity = new VoiceActivityProjection()
  ctx.provide('voiceActivity', activity)
  registerTtsRoutes(ctx, resolveTtsOptions(config), config.uploadTimeoutMs ?? 30_000, activity)
  const root = join(homedir(), '.local/share/forge-voice')
  const options: VoiceEngineOptions = {
    binary: process.env.FORGE_WHISPER_BINARY ?? join(root, 'whisper.cpp/build/bin/whisper-cli'),
    model: process.env.FORGE_WHISPER_MODEL ?? join(root, 'models/ggml-small-q5_1.bin'),
    timeoutMs: config.recognitionTimeoutMs ?? 90_000,
  }
  const lifetime = new AbortController()
  const pending = new Set<Promise<Response>>()
  let busy = false

  async function recognize(request: Request): Promise<Response> {
    if (aborted(request, lifetime.signal)) return json({ error: 'REQUEST_ABORTED' }, 499)
    if (busy) return json({ error: 'VOICE_BUSY' }, 429)
    if (!request.headers.get('content-type')?.split(';')[0]?.match(/^audio\/(wav|wave|x-wav)$/)) {
      return json({ error: 'INVALID_AUDIO' }, 415)
    }
    const length = Number(request.headers.get('content-length'))
    if (length > MAX_AUDIO_BYTES) return json({ error: 'INVALID_AUDIO' }, 413)
    busy = true
    // The slot covers the real work this request costs the machine: checking the recognizer, uploading audio and
    // running inference. Early refusals above are not voice activity and never reach here.
    const release = activity.hold()
    try {
      if (!await voiceAvailable(options)) return json({ error: 'VOICE_UNAVAILABLE' }, 503)
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      const bytes = await readAudioBody(request, signal, config.uploadTimeoutMs ?? 30_000)
      if (!validVoiceWav(bytes)) return json({ error: 'INVALID_AUDIO' }, 400)
      const text = await transcribeVoice(bytes, options, signal)
      return json({ text })
    } catch (error) {
      if (aborted(request, lifetime.signal)) return json({ error: 'REQUEST_ABORTED' }, 499)
      if (error instanceof VoiceBodyError) return json({ error: error.code }, error.status)
      const timeout = error instanceof Error && 'killed' in error && error.killed === true
      return json({ error: timeout ? 'VOICE_TIMEOUT' : 'TRANSCRIPTION_FAILED' }, timeout ? 504 : 500)
    } finally { busy = false; release() }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/forge/voice/status', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => json({ available: await voiceAvailable(options), engine: 'whisper.cpp', language: 'zh' }),
  }), 'forge-voice: status')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/forge/voice/transcribe', methods: ['POST'], requestBody: 'streaming',
    fetch: (request) => {
      const task = recognize(request)
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    },
  }), 'forge-voice: transcription')
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([...pending])
  }, 'forge-voice: stop recognizers')
}

/** Whether this request or the plugin lifetime was aborted.
 *
 * Read through a function rather than an inlined comparison: `AbortSignal.aborted` is live state that can change
 * while an await is suspended, so the guard at the top of the handler must not be read as describing the catch
 * block TypeScript analyzes later on.
 * @param request - Request whose carrier signal holds the caller's cancellation.
 * @param lifetimeSignal - Signal aborted when the plugin is disposed.
 * @returns True while either signal has been aborted.
 */
function aborted(request: Request, lifetimeSignal: AbortSignal): boolean {
  return request.signal.aborted || lifetimeSignal.aborted
}

/** Upload errors are separate from recognizer failures so the caller can recover. */
class VoiceBodyError extends Error {
  constructor(readonly code: 'VOICE_TIMEOUT' | 'INVALID_AUDIO', readonly status: number) {
    super(code)
  }
}

/** Read a bounded request body; carrier cancellation must release the voice slot. */
async function readAudioBody(request: Request, lifetime: AbortSignal, timeoutMs: number): Promise<Buffer> {
  lifetime.throwIfAborted()
  const reader = request.body?.getReader()
  if (!reader) throw new VoiceBodyError('INVALID_AUDIO', 400)
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new VoiceBodyError('VOICE_TIMEOUT', 504)) }, timeoutMs)
  timer.unref()
  const signal = AbortSignal.any([lifetime, deadline.signal])
  const bytes = Buffer.allocUnsafe(MAX_AUDIO_BYTES)
  let total = 0
  let complete = false
  const cancel = (): void => {
    // A transport may leave its cancellation callback pending. Releasing the
    // service must not wait for that callback after the reader is cancelled.
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        // The rejection reason is whatever aborted this read: the deadline carries a VoiceBodyError, and any
        // other abort still has to arrive as an Error rather than an untyped value.
        const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new VoiceBodyError('VOICE_TIMEOUT', 504)) }
        signal.addEventListener('abort', aborted, { once: true })
        void reader.read().then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
      })
      signal.throwIfAborted()
      if (chunk.done) { complete = true; break }
      if (total + chunk.value.byteLength > MAX_AUDIO_BYTES) throw new VoiceBodyError('INVALID_AUDIO', 413)
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
