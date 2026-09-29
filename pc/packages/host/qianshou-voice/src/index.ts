/** Local ASR status, authenticated Session-bound PCM uploads and optional local neural speech. */
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from 'zod'
import { VoiceFailure } from './failure.ts'
import { VoiceActivityProjection } from './activity.ts'
import { transcribeVoice, voiceAvailable } from './engine.ts'
import { admitSession, assertCurrent, type VoiceSessionGuard } from './guard.ts'
import { resolveTtsOptions } from './tts-config.ts'
import { TtsEngine } from './tts-engine.ts'
import { registerTtsRoutes } from './tts-routes.ts'
import { readAudioBody } from './upload.ts'
import { MAX_AUDIO_BYTES, voicePcm } from './wav.ts'
import type { VoiceConfig, VoiceEngineOptions, VoiceStatus } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { qianshouVoice: QianshouVoice }
}

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (data: unknown, status = 200): Response => Response.json(data, { status, headers })

/** Host-local transcription; no audio, transcript or process output enters Session history. */
export class QianshouVoice extends TypertRemoteService {
  static inject = ['connection', 'sessions']
  static Config: Schema<VoiceConfig> = Schema.object({
    binaryPath: Schema.string().default(''),
    modelPath: Schema.string().default(''),
    uploadTimeoutMs: Schema.number().step(1).min(1).max(600000).default(30000),
    recognitionTimeoutMs: Schema.number().step(1).min(1).max(600000).default(90000),
    threads: Schema.number().step(1).min(1).max(32).default(4),
    maxResultBytes: Schema.number().step(1).min(16).max(1048576).default(65536),
    maxProcessOutputBytes: Schema.number().step(1).min(1024).max(16777216).default(2097152),
    ttsPythonPath: Schema.string().default(''),
    ttsWorkerPath: Schema.string().default(''),
    ttsModelPath: Schema.string().default(''),
    ttsDefaultSpeaker: Schema.union(['Vivian', 'Serena']).default('Vivian'),
    ttsMaxTextChars: Schema.number().step(1).min(1).max(500).default(500),
    ttsRequestTimeoutMs: Schema.number().step(1).min(1).max(600000).default(180000),
    ttsMaxOutputBytes: Schema.number().step(1).min(46).max(67108864).default(8388608),
    ttsIdleTimeoutMs: Schema.number().step(1).min(1).max(3600000).default(300000),
  })
  private readonly lifetime = new AbortController()
  private readonly activity = new VoiceActivityProjection()
  private readonly options: VoiceEngineOptions | undefined
  private active: { session: Session; controller: AbortController } | undefined
  private readonly pending = new Set<Promise<Response>>()

  constructor(ctx: Context, private readonly config: VoiceConfig) {
    super(ctx, 'qianshouVoice')
    ctx.provide('voiceActivity', this.activity)
    const paths = [config.binaryPath, config.modelPath]
    if (paths.some(Boolean) && !paths.every(path => isAbsolute(path) && !path.includes('\0'))) {
      throw new TypeError('qianshou-voice requires paired absolute binaryPath and modelPath')
    }
    this.options = config.binaryPath === '' ? undefined : { binary: config.binaryPath, model: config.modelPath,
      timeoutMs: config.recognitionTimeoutMs, threads: config.threads, maxResultBytes: config.maxResultBytes,
      maxProcessOutputBytes: config.maxProcessOutputBytes }
    const tts = new TtsEngine(resolveTtsOptions(config))
    ctx.on('session/disposed', (session) => {
      if (this.active?.session === session) this.active.controller.abort(new VoiceFailure('SESSION_UNAVAILABLE', 409))
    })
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/qianshou/voice/transcribe', methods: ['POST'], requestBody: 'streaming',
      fetch: (request) => {
        const task = this.recognize(request)
        this.pending.add(task)
        void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
        return task
      },
    }), 'qianshou-voice: audio upload')
    ctx.effect(() => async () => {
      this.lifetime.abort(new VoiceFailure('REQUEST_ABORTED', 499))
      await Promise.allSettled([...this.pending])
    }, 'qianshou-voice: recognizer lifetime')
    registerTtsRoutes(ctx, tts, config.uploadTimeoutMs, this.activity)
  }

  /**
   * Read local asset accessibility and current admission limits without loading the model.
   * @returns Safe availability information; no filesystem paths or credentials.
   */
  @Remote
  async status(): Promise<VoiceStatus> {
    const available = this.options !== undefined && await voiceAvailable(this.options)
    return { available, busy: this.active !== undefined, reason: available ? 'ready'
      : this.options === undefined ? 'not-configured' : 'assets-unavailable', backend: 'whisper.cpp', language: 'zh',
    maxAudioBytes: MAX_AUDIO_BYTES, maxDurationSeconds: 120, minDurationSeconds: 0.1 }
  }

  private async recognize(request: Request): Promise<Response> {
    const cancelled = (): boolean => request.signal.aborted || this.lifetime.signal.aborted
    if (cancelled()) return json({ error: 'REQUEST_ABORTED' }, 499)
    if (this.active) return json({ error: 'VOICE_BUSY' }, 429)
    let guard: VoiceSessionGuard
    try { guard = admitSession(this.ctx, new URL(request.url)) } catch (error) {
      return json({ error: error instanceof VoiceFailure ? error.code : 'SESSION_UNAVAILABLE' }, 409)
    }
    if (!/^audio\/(wav|wave|x-wav)$/i.test(request.headers.get('content-type')?.split(';')[0]?.trim() ?? '')) {
      return json({ error: 'INVALID_AUDIO' }, 415)
    }
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_AUDIO_BYTES)) return json({ error: 'INVALID_AUDIO' }, 413)
    const operation = { session: guard.session, controller: new AbortController() }
    this.active = operation
    const release = this.activity.hold()
    const signal = AbortSignal.any([request.signal, this.lifetime.signal, operation.controller.signal])
    try {
      if (!this.options || !await voiceAvailable(this.options)) throw new VoiceFailure('VOICE_UNAVAILABLE', 503)
      const bytes = await readAudioBody(request, signal, this.config.uploadTimeoutMs)
      assertCurrent(this.ctx, guard)
      const pcm = voicePcm(bytes)
      if (!pcm) throw new VoiceFailure('INVALID_AUDIO', 400)
      if (pcm.every(byte => byte === 0)) return json({ text: '' })
      const text = await transcribeVoice(bytes, this.options, signal)
      signal.throwIfAborted()
      assertCurrent(this.ctx, guard)
      return json({ text })
    } catch (error) {
      if (cancelled()) return json({ error: 'REQUEST_ABORTED' }, 499)
      if (operation.controller.signal.aborted) return json({ error: 'SESSION_UNAVAILABLE' }, 409)
      if (error instanceof VoiceFailure) return json({ error: error.code }, error.status)
      return json({ error: 'TRANSCRIPTION_FAILED' }, 500)
    } finally {
      if (this.active === operation) this.active = undefined
      release()
    }
  }
}

export default QianshouVoice
