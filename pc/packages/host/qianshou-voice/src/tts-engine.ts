/** Single-slot local synthesis with request cancellation and private, bounded WAV output. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { VoiceFailure } from './failure.ts'
import { TTS_SPEAKERS, type TtsAssets, type TtsOptions } from './tts-config.ts'
import { TtsProcess } from './tts-process.ts'
import type { TtsSpeaker, TtsStatus } from './types.ts'

/** Model output protocol: PCM16 mono at 24 kHz. */
export const TTS_SAMPLE_RATE = 24000

/**
 * Check worker launch assets and model files without loading the model or claiming audible output.
 * @param assets - Explicit Host-owned launch paths.
 * @returns Whether every required file is an accessible regular file inside a model directory.
 */
export async function ttsAvailable(assets: TtsAssets): Promise<boolean> {
  const files = [assets.python, assets.worker, join(assets.model, 'config.json'), join(assets.model, 'model.safetensors'),
    join(assets.model, 'speech_tokenizer/model.safetensors')]
  try {
    await Promise.all([access(assets.python, constants.X_OK), ...files.slice(1).map(file => access(file, constants.R_OK))])
    const [model, ...entries] = await Promise.all([stat(assets.model), ...files.map(file => stat(file))])
    return model.isDirectory() && entries.every(entry => entry.isFile() && entry.size > 0)
  } catch (error) {
    // A missing or inaccessible configured resource is a visible resources-missing status.
    void error
    return false
  }
}

/** One persistent worker shared by strictly serial requests; a concurrent request is refused, never queued. */
export class TtsEngine {
  private worker: TtsProcess | undefined
  private active: Promise<unknown> | undefined
  private readonly lifetime = new AbortController()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private stopping: Promise<void> | undefined

  constructor(readonly options: TtsOptions) {}

  /**
   * Report whether a synthesis currently owns the slot.
   * @returns Whether a request is active from admission through process and file cleanup.
   */
  busy(): boolean { return this.active !== undefined }

  /**
   * Probe configured assets without starting a worker or downloading anything.
   * @returns Whitelisted availability information; `available` never means a listening test passed.
   */
  async status(): Promise<TtsStatus> {
    const assets = this.options.assets
    const available = assets !== undefined && !this.lifetime.signal.aborted && await ttsAvailable(assets)
    return { available, reason: available ? 'ready' : assets === undefined ? 'not-configured' : 'resources-missing',
      ready: this.worker?.loaded ?? false, busy: this.busy(), engine: 'qwen3-tts', speakers: TTS_SPEAKERS,
      defaultSpeaker: this.options.defaultSpeaker, maxTextChars: this.options.maxTextChars,
      maxOutputBytes: this.options.maxOutputBytes, sampleRate: TTS_SAMPLE_RATE }
  }

  /**
   * Synthesize one validated text while owning the single slot until process and file cleanup finish.
   * @param text - Text already validated by the route.
   * @param speaker - Allowed preset chosen by the route.
   * @param requestSignal - Caller cancellation; aborting kills the worker mid-generation.
   * @returns Complete validated WAV bytes; never a Host file path.
   */
  synthesize(text: string, speaker: TtsSpeaker, requestSignal: AbortSignal): Promise<Buffer> {
    const assets = this.options.assets
    if (assets === undefined) return Promise.reject(new VoiceFailure('TTS_UNAVAILABLE', 503))
    if (this.lifetime.signal.aborted || requestSignal.aborted) return Promise.reject(new VoiceFailure('REQUEST_ABORTED', 499))
    if (this.active) return Promise.reject(new VoiceFailure('TTS_BUSY', 429))
    clearTimeout(this.idleTimer)
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new VoiceFailure('TTS_TIMEOUT', 504)) }, this.options.requestTimeoutMs)
    timer.unref()
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal, deadline.signal])
    const task = this.execute(assets, text, speaker, signal).finally(() => {
      clearTimeout(timer)
      this.active = undefined
      if (!this.lifetime.signal.aborted) {
        this.idleTimer = setTimeout(() => { void this.releaseIdleWorker() }, this.options.idleTimeoutMs)
        this.idleTimer.unref()
      }
    })
    this.active = task
    return task
  }

  /**
   * Abort the active request, then wait for process exit and private file cleanup.
   * @returns Completion after quiescence.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort(new VoiceFailure('REQUEST_ABORTED', 499))
    clearTimeout(this.idleTimer)
    await this.worker?.stop()
    await Promise.allSettled([this.active, this.stopping])
  }

  private async releaseIdleWorker(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker === undefined) return
    this.stopping = worker.stop()
    await this.stopping
  }

  private async execute(assets: TtsAssets, text: string, speaker: TtsSpeaker, signal: AbortSignal): Promise<Buffer> {
    let directory: string | undefined
    let worker: TtsProcess | undefined
    const aborted = (): void => { void worker?.stop() }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      signal.throwIfAborted()
      await this.stopping
      if (this.worker && !this.worker.loaded) { await this.worker.stop(); this.worker = undefined }
      if (!await ttsAvailable(assets)) throw new VoiceFailure('TTS_UNAVAILABLE', 503)
      signal.throwIfAborted()
      worker = this.worker ??= await TtsProcess.create(assets)
      if (signal.aborted) aborted()
      await worker.ready
      signal.throwIfAborted()
      directory = await mkdtemp(join(worker.outputDirectory, 'request-'))
      await chmod(directory, 0o700)
      signal.throwIfAborted()
      const outputPath = join(directory, 'speech.wav')
      await worker.generate(randomUUID(), text, speaker, outputPath)
      signal.throwIfAborted()
      const result = await readTtsWav(outputPath, this.options.maxOutputBytes)
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (worker) { await worker.stop(); if (this.worker === worker) this.worker = undefined }
      if (signal.aborted) throw signal.reason instanceof VoiceFailure ? signal.reason : new VoiceFailure('REQUEST_ABORTED', 499)
      throw error instanceof VoiceFailure ? error : new VoiceFailure('SYNTHESIS_FAILED', 500)
    } finally {
      signal.removeEventListener('abort', aborted)
      if (signal.aborted && worker) { await worker.stop(); if (this.worker === worker) this.worker = undefined }
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}

/** Validate the worker's PCM16 mono 24 kHz WAV before it reaches a browser decoder. */
async function readTtsWav(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 46 || info.size > maxBytes) throw new VoiceFailure('SYNTHESIS_FAILED', 500)
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const wav = bytes.subarray(0, length)
    if (length > maxBytes || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
      || wav.readUInt32LE(4) + 8 !== length) throw new VoiceFailure('SYNTHESIS_FAILED', 500)
    let format = false
    let samples = 0
    let offset = 12
    while (offset + 8 <= length) {
      const size = wav.readUInt32LE(offset + 4)
      const end = offset + 8 + size
      if (end > length) throw new VoiceFailure('SYNTHESIS_FAILED', 500)
      const name = wav.toString('ascii', offset, offset + 4)
      if (name === 'fmt ') {
        format = size >= 16 && wav.readUInt16LE(offset + 8) === 1 && wav.readUInt16LE(offset + 10) === 1
          && wav.readUInt32LE(offset + 12) === TTS_SAMPLE_RATE && wav.readUInt32LE(offset + 16) === TTS_SAMPLE_RATE * 2
          && wav.readUInt16LE(offset + 20) === 2 && wav.readUInt16LE(offset + 22) === 16
        if (!format) throw new VoiceFailure('SYNTHESIS_FAILED', 500)
      }
      if (name === 'data') samples += size
      offset = end + size % 2
    }
    if (!format || samples < 2 || samples % 2 !== 0 || offset !== length) throw new VoiceFailure('SYNTHESIS_FAILED', 500)
    return wav
  } finally { await file.close() }
}
