/** Authenticated Connection routes for optional, locally installed neural speech. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { TtsOptions, TtsSpeaker } from './tts-config.ts'
import type { VoiceActivityProjection } from './activity.ts'
import { TtsEngine } from './tts-engine.ts'
import { TtsError } from './tts-process.ts'

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers })
const bodyLimit = 16 * 1024

/**
 * Register independently disposable synthesis routes on the authenticated Connection.
 * @param ctx - Plugin context supplying Connection.
 * @param options - Resolved host-controlled worker settings.
 * @param uploadTimeoutMs - Maximum duration of JSON-body admission.
 * @param activity - The plugin's voice-activity projection; every admitted request holds one slot for its lifetime.
 */
export function registerTtsRoutes(ctx: Context, options: TtsOptions, uploadTimeoutMs: number, activity: VoiceActivityProjection): void {
  const engine = new TtsEngine(options)
  const lifetime = new AbortController()
  const pending = new Set<Promise<Response>>()

  async function synthesize(request: Request): Promise<Response> {
    if (request.signal.aborted || lifetime.signal.aborted) return json({ error: 'REQUEST_ABORTED' }, 499)
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return json({ error: 'INVALID_TEXT' }, 415)
    if (Number(request.headers.get('content-length')) > bodyLimit) return json({ error: 'INVALID_TEXT' }, 413)
    const signal = AbortSignal.any([request.signal, lifetime.signal])
    // A slot covers the real work of one admitted synthesis: reading the request and running local inference.
    // Request-shape refusals above are not voice activity and never reach here.
    const release = activity.hold()
    try {
      const input = await readJsonBody(request, signal, uploadTimeoutMs)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TtsError('INVALID_TEXT')
      const keys = Object.keys(input)
      if (keys.some(key => key !== 'text' && key !== 'speaker')) throw new TtsError('INVALID_TEXT')
      if (!('text' in input) || typeof input.text !== 'string' || !input.text.trim() || Array.from(input.text).length > options.maxTextChars) throw new TtsError('INVALID_TEXT')
      const speaker = 'speaker' in input ? input.speaker : options.defaultSpeaker
      if (speaker !== 'Vivian' && speaker !== 'Serena') throw new TtsError('INVALID_TEXT')
      const result = await engine.synthesize(input.text, speaker satisfies TtsSpeaker, signal)
      return new Response(new Uint8Array(result), { headers: { ...headers, 'Content-Type': 'audio/wav', 'Content-Length': String(result.byteLength) } })
    } catch (error) {
      if (signal.aborted) return json({ error: 'REQUEST_ABORTED' }, 499)
      const code = error instanceof TtsError ? error.code : 'SYNTHESIS_FAILED'
      const status = {
        INVALID_TEXT: 400, TTS_UNAVAILABLE: 503, TTS_BUSY: 429, TTS_TIMEOUT: 504, REQUEST_ABORTED: 499, SYNTHESIS_FAILED: 500,
      }[code]
      return json({ error: code }, status)
    } finally { release() }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/forge/voice/tts/status', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => json(await engine.status()),
  }), 'forge-voice: neural status')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/forge/voice/synthesize', methods: ['POST'], requestBody: 'streaming',
    fetch: (request) => {
      if (pending.size >= options.maxQueuedRequests + 1) return Promise.resolve(json({ error: 'TTS_BUSY' }, 429))
      const task = synthesize(request)
      pending.add(task)
      void task.then(() => pending.delete(task), () => pending.delete(task))
      return task
    },
  }), 'forge-voice: neural synthesis')
  ctx.effect(() => async () => {
    lifetime.abort()
    await engine.dispose()
    await Promise.allSettled([...pending])
  }, 'forge-voice: stop neural worker')
}

/** Read JSON without trusting Content-Length or retaining an unbounded chunk list. */
async function readJsonBody(request: Request, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new TtsError('INVALID_TEXT')
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new TtsError('TTS_TIMEOUT')) }, timeoutMs)
  timer.unref()
  const combined = AbortSignal.any([signal, deadline.signal])
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { reject(combined.reason instanceof Error ? combined.reason : new TtsError('REQUEST_ABORTED')) }
    combined.addEventListener('abort', abort, { once: true })
  })
  let complete = false
  try {
    const bytes = Buffer.allocUnsafe(bodyLimit)
    let length = 0
    while (true) {
      combined.throwIfAborted()
      const chunk = await Promise.race([reader.read(), cancelled])
      combined.throwIfAborted()
      if (chunk.done) { complete = true; break }
      if (length + chunk.value.length > bodyLimit) throw new TtsError('INVALID_TEXT')
      bytes.set(chunk.value, length)
      length += chunk.value.length
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) } catch { throw new TtsError('INVALID_TEXT') }
  } finally {
    clearTimeout(timer)
    combined.removeEventListener('abort', abort)
    if (!complete) {
      // Carrier cancellation may stay pending; it cannot retain a host synthesis slot.
      void reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}
