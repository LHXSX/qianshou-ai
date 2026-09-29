/** Authenticated, Session-bound Connection routes for optional local neural speech. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import { VoiceFailure } from './failure.ts'
import type { VoiceActivityProjection } from './activity.ts'
import { admitSession, assertCurrent, type VoiceSessionGuard } from './guard.ts'
import { TTS_SPEAKERS, type TtsOptions } from './tts-config.ts'
import type { TtsEngine } from './tts-engine.ts'
import { readBoundedBody } from './upload.ts'
import type { TtsSpeaker } from './types.ts'

/** Route paths registered on the shared authenticated Connection. */
export const TTS_STATUS_PATH = '/api/qianshou/voice/tts/status'
/** Synthesis route; accepts `application/json` `{ text, speaker? }` and returns `audio/wav`. */
export const TTS_SYNTHESIZE_PATH = '/api/qianshou/voice/tts/synthesize'
/** Maximum JSON request body regardless of declared Content-Length. */
export const MAX_TTS_REQUEST_BYTES = 16 * 1024

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers })
const failure = (error: unknown): Response => error instanceof VoiceFailure ? json({ error: error.code }, error.status)
  : json({ error: 'SYNTHESIS_FAILED' }, 500)

/** Validate the JSON request; only `text` and a bundled `speaker` preset are accepted. */
function parseSynthesisRequest(bytes: Buffer, options: TtsOptions): { text: string; speaker: TtsSpeaker } {
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (error) {
    void error
    throw new VoiceFailure('INVALID_TEXT', 400)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VoiceFailure('INVALID_TEXT', 400)
  if (Object.keys(input).some(key => key !== 'text' && key !== 'speaker')) throw new VoiceFailure('INVALID_TEXT', 400)
  if (!('text' in input) || typeof input.text !== 'string') throw new VoiceFailure('INVALID_TEXT', 400)
  const text = input.text.trim()
  if (text === '' || Array.from(text).length > options.maxTextChars) throw new VoiceFailure('INVALID_TEXT', 400)
  const speaker: unknown = 'speaker' in input ? input.speaker : options.defaultSpeaker
  if (!TTS_SPEAKERS.some(preset => preset === speaker)) throw new VoiceFailure('INVALID_TEXT', 400)
  return { text, speaker: speaker as TtsSpeaker }
}

/**
 * Register status and synthesis routes that share the ASR routes' Session admission and cancel on disposal.
 * @param ctx - Plugin context supplying Connection and the SessionStore.
 * @param engine - Engine owned by the caller; disposal here aborts its work and awaits quiescence.
 * @param uploadTimeoutMs - Maximum duration of JSON body admission.
 * @param activity - Shared reading of accepted ASR and TTS work.
 */
export function registerTtsRoutes(ctx: Context, engine: TtsEngine, uploadTimeoutMs: number, activity: VoiceActivityProjection): void {
  const lifetime = new AbortController()
  const pending = new Set<Promise<Response>>()
  let active: { session: Session; controller: AbortController } | undefined

  async function status(request: Request): Promise<Response> {
    if (request.signal.aborted || lifetime.signal.aborted) return json({ error: 'REQUEST_ABORTED' }, 499)
    try { admitSession(ctx, new URL(request.url)) } catch (error) { return failure(error) }
    return json(await engine.status())
  }

  async function synthesize(request: Request): Promise<Response> {
    const cancelled = (): boolean => request.signal.aborted || lifetime.signal.aborted
    if (cancelled()) return json({ error: 'REQUEST_ABORTED' }, 499)
    if (active || engine.busy()) return json({ error: 'TTS_BUSY' }, 429)
    let guard: VoiceSessionGuard
    try { guard = admitSession(ctx, new URL(request.url)) } catch (error) { return failure(error) }
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return json({ error: 'INVALID_TEXT' }, 415)
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_TTS_REQUEST_BYTES)) return json({ error: 'INVALID_TEXT' }, 413)
    const operation = { session: guard.session, controller: new AbortController() }
    active = operation
    const release = activity.hold()
    const signal = AbortSignal.any([request.signal, lifetime.signal, operation.controller.signal])
    try {
      if (!(await engine.status()).available) throw new VoiceFailure('TTS_UNAVAILABLE', 503)
      const bytes = await readBoundedBody(request, signal, uploadTimeoutMs, MAX_TTS_REQUEST_BYTES, 'INVALID_TEXT')
      assertCurrent(ctx, guard)
      const { text, speaker } = parseSynthesisRequest(bytes, engine.options)
      const wav = await engine.synthesize(text, speaker, signal)
      signal.throwIfAborted()
      assertCurrent(ctx, guard)
      return new Response(new Uint8Array(wav), { headers: { ...headers, 'Content-Type': 'audio/wav', 'Content-Length': String(wav.byteLength) } })
    } catch (error) {
      if (cancelled()) return json({ error: 'REQUEST_ABORTED' }, 499)
      if (operation.controller.signal.aborted) return json({ error: 'SESSION_UNAVAILABLE' }, 409)
      return failure(error)
    } finally {
      if (active === operation) active = undefined
      release()
    }
  }

  const track = (handler: (request: Request) => Promise<Response>) => (request: Request): Promise<Response> => {
    const task = handler(request)
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  ctx.on('session/disposed', (session) => {
    if (active?.session === session) active.controller.abort(new VoiceFailure('SESSION_UNAVAILABLE', 409))
  })
  ctx.effect(() => ctx.connection.fetch.register({ path: TTS_STATUS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: track(status) }),
    'qianshou-voice: neural speech status')
  ctx.effect(() => ctx.connection.fetch.register({ path: TTS_SYNTHESIZE_PATH, methods: ['POST'], requestBody: 'streaming', fetch: track(synthesize) }),
    'qianshou-voice: neural speech synthesis')
  ctx.effect(() => async () => {
    lifetime.abort(new VoiceFailure('REQUEST_ABORTED', 499))
    await engine.dispose()
    await Promise.allSettled([...pending])
  }, 'qianshou-voice: neural speech worker lifetime')
}
