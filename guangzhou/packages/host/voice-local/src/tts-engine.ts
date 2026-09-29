/** Serial local synthesis with request cancellation and private, bounded WAV output. */
import { constants } from 'node:fs'
import { access, chmod, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { TtsOptions, TtsSpeaker } from './tts-config.ts'
import { TtsError, TtsProcess } from './tts-process.ts'

interface Job {
  text: string
  speaker: TtsSpeaker
  signal: AbortSignal
  resolve: (bytes: Buffer) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

/** A single local model process shared by a bounded number of admitted requests. */
export class TtsEngine {
  private worker: TtsProcess | undefined
  private queue: Job[] = []
  private active: Promise<void> | undefined
  private lifetime = new AbortController()
  private idleTimer?: ReturnType<typeof setTimeout>
  private stopping: Promise<void> | undefined

  constructor(readonly options: TtsOptions) {}

  /**
   * Probe deployment assets without downloading or starting a model.
   * @returns Asset availability and independently observed loaded-worker readiness.
   */
  async status(): Promise<{ available: boolean; ready: boolean; engine: 'qwen3-tts'; speakers: TtsSpeaker[]; defaultSpeaker: TtsSpeaker }> {
    let available = false
    const assets = this.options.assets
    if (assets && !this.lifetime.signal.aborted) {
      try {
        await Promise.all([
          access(assets.python, constants.X_OK), access(assets.worker, constants.R_OK),
          access(join(assets.model, 'config.json'), constants.R_OK),
          access(join(assets.model, 'model.safetensors'), constants.R_OK),
          access(join(assets.model, 'speech_tokenizer/model.safetensors'), constants.R_OK),
        ])
        const files = await Promise.all([assets.python, assets.worker, join(assets.model, 'model.safetensors'), join(assets.model, 'speech_tokenizer/model.safetensors')].map(path => stat(path)))
        available = files.every(file => file.isFile() && file.size > 0) && (await stat(assets.model)).isDirectory()
      } catch { available = false }
    }
    return { available, ready: this.worker?.loaded ?? false, engine: 'qwen3-tts', speakers: ['Vivian', 'Serena'], defaultSpeaker: this.options.defaultSpeaker }
  }

  /**
   * Admit one bounded request without interrupting a different active request.
   * @param text - Text already validated by the HTTP parser.
   * @param speaker - Allowed preset chosen by the HTTP parser.
   * @param requestSignal - Caller cancellation; an active request force-stops its worker.
   * @returns Complete validated WAV bytes; never a host file path.
   */
  synthesize(text: string, speaker: TtsSpeaker, requestSignal: AbortSignal): Promise<Buffer> {
    if (!this.options.assets) return Promise.reject(new TtsError('TTS_UNAVAILABLE'))
    if (this.lifetime.signal.aborted || requestSignal.aborted) return Promise.reject(new TtsError('REQUEST_ABORTED'))
    if (this.active && this.queue.length >= this.options.maxQueuedRequests) return Promise.reject(new TtsError('TTS_BUSY'))
    clearTimeout(this.idleTimer)
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new TtsError('TTS_TIMEOUT')) }, this.options.requestTimeoutMs)
    timer.unref()
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal, deadline.signal])
    return new Promise<Buffer>((resolve, reject) => {
      const job: Job = {
        text, speaker, signal, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', aborted) },
      }
      const aborted = (): void => {
        const index = this.queue.indexOf(job)
        if (index >= 0) {
          this.queue.splice(index, 1)
          job.cleanup()
          reject(signal.reason instanceof TtsError ? signal.reason : new TtsError('REQUEST_ABORTED'))
        }
      }
      signal.addEventListener('abort', aborted, { once: true })
      this.queue.push(job)
      this.pump()
    })
  }

  /** Abort queued and active requests, then wait for process exit and private file cleanup. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    clearTimeout(this.idleTimer)
    await this.worker?.stop()
    await this.active
    await this.stopping
  }

  private pump(): void {
    if (this.active || this.lifetime.signal.aborted) return
    const job = this.queue.shift()
    if (!job) return
    this.active = this.execute(job).then(job.resolve, job.reject).finally(() => {
      job.cleanup()
      this.active = undefined
      if (this.queue.length) this.pump()
      else if (!this.lifetime.signal.aborted) {
        this.idleTimer = setTimeout(() => {
          const worker = this.worker
          this.worker = undefined
          this.stopping = worker?.stop()
          // Disposal and the next request also await this cleanup.
          void this.stopping?.catch(() => {})
        }, this.options.idleTimeoutMs)
        this.idleTimer.unref()
      }
    })
  }

  private async execute(job: Job): Promise<Buffer> {
    let directory: string | undefined
    let worker: TtsProcess | undefined
    const aborted = (): void => { void worker?.stop() }
    job.signal.addEventListener('abort', aborted, { once: true })
    try {
      job.signal.throwIfAborted()
      await this.stopping
      if (this.worker && !this.worker.loaded) { await this.worker.stop(); this.worker = undefined }
      const assets = this.options.assets
      if (!assets) throw new TtsError('TTS_UNAVAILABLE')
      if (!(await this.status()).available) throw new TtsError('TTS_UNAVAILABLE')
      job.signal.throwIfAborted()
      worker = this.worker ??= await TtsProcess.create(assets)
      if (job.signal.aborted) aborted()
      await worker.ready
      job.signal.throwIfAborted()
      directory = await mkdtemp(join(worker.outputDirectory, 'request-'))
      await chmod(directory, 0o700)
      job.signal.throwIfAborted()
      const outputPath = join(directory, 'speech.wav')
      await worker.generate(randomUUID(), job.text, job.speaker, outputPath)
      job.signal.throwIfAborted()
      const result = await readTtsWav(outputPath, this.options.maxOutputBytes)
      job.signal.throwIfAborted()
      return result
    } catch (error) {
      if (worker) { await worker.stop(); if (this.worker === worker) this.worker = undefined }
      if (job.signal.aborted) throw job.signal.reason instanceof TtsError ? job.signal.reason : new TtsError('REQUEST_ABORTED')
      throw error instanceof TtsError ? error : new TtsError('SYNTHESIS_FAILED')
    } finally {
      job.signal.removeEventListener('abort', aborted)
      if (job.signal.aborted && worker) { await worker.stop(); if (this.worker === worker) this.worker = undefined }
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}

/** Validate the worker's PCM16/24 kHz response before it reaches a browser decoder. */
async function readTtsWav(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 46 || info.size > maxBytes) throw new TtsError('SYNTHESIS_FAILED')
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const wav = bytes.subarray(0, length)
    if (length > maxBytes || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== length) throw new TtsError('SYNTHESIS_FAILED')
    let format = false
    let samples = 0
    let offset = 12
    while (offset + 8 <= length) {
      const size = wav.readUInt32LE(offset + 4)
      const end = offset + 8 + size
      if (end > length) throw new TtsError('SYNTHESIS_FAILED')
      const name = wav.toString('ascii', offset, offset + 4)
      if (name === 'fmt ') {
        format = size >= 16 && wav.readUInt16LE(offset + 8) === 1 && wav.readUInt16LE(offset + 10) === 1
          && wav.readUInt32LE(offset + 12) === 24_000 && wav.readUInt32LE(offset + 16) === 48_000
          && wav.readUInt16LE(offset + 20) === 2 && wav.readUInt16LE(offset + 22) === 16
        if (!format) throw new TtsError('SYNTHESIS_FAILED')
      }
      if (name === 'data') samples += size
      offset = end + size % 2
    }
    if (!format || samples < 2 || samples % 2 !== 0 || offset !== length) throw new TtsError('SYNTHESIS_FAILED')
    return wav
  } finally { await file.close() }
}
