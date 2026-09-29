/** Private JSONL transport for one host-configured, persistent Python model worker. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TtsOptions, TtsSpeaker } from './tts-config.ts'

/** Public failures contain codes, never worker diagnostics or host paths. */
export class TtsError extends Error {
  constructor(readonly code: 'TTS_UNAVAILABLE' | 'TTS_BUSY' | 'TTS_TIMEOUT' | 'REQUEST_ABORTED' | 'INVALID_TEXT' | 'SYNTHESIS_FAILED') {
    super(code)
    this.name = 'TtsError'
  }
}

/** One serial, JSONL-speaking subprocess; callers own deadlines and output files. */
export class TtsProcess {
  /** Resolves only after the worker acknowledges a successful model load. */
  readonly ready: Promise<void>
  /** Resolves after process close and private-root removal. */
  readonly closed: Promise<void>
  /** Whether a live worker has acknowledged load and has not failed. */
  loaded = false
  private child: ChildProcessWithoutNullStreams
  private failure: Error | undefined
  private acceptReady!: () => void
  private rejectReady!: (error: Error) => void
  private pending: { id: string; path: string; resolve: () => void; reject: (error: Error) => void } | undefined
  private buffer = ''
  private diagnosticBytes = 0

  /**
   * Acquire a private output root before starting the configured executable.
   * @param assets - Trusted, validated local deployment paths.
   * @returns A worker whose close promise includes private-root removal.
   */
  static async create(assets: NonNullable<TtsOptions['assets']>): Promise<TtsProcess> {
    const directory = await mkdtemp(join(tmpdir(), 'qianshou-tts-'))
    try {
      await chmod(directory, 0o700)
      // macOS exposes /var through /private/var; both peers use one canonical root.
      return new TtsProcess(assets, await realpath(directory))
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  private constructor(assets: NonNullable<TtsOptions['assets']>, readonly outputDirectory: string) {
    this.ready = new Promise<void>((resolve, reject) => { this.acceptReady = resolve; this.rejectReady = reject })
    // Loading can fail before the request reaches its first await.
    void this.ready.catch(() => {})
    this.child = spawn(assets.python, ['-u', assets.worker, '--model', assets.model, '--output-dir', outputDirectory], {
      cwd: dirname(assets.worker), shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: homedir(),
        PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_TELEMETRY: '1',
      },
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => { this.receive(chunk) })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.diagnosticBytes += chunk.length
      if (this.diagnosticBytes > 1024 * 1024) this.fail(new TtsError('SYNTHESIS_FAILED'))
    })
    this.child.stdin.on('error', () => { this.fail(new TtsError('SYNTHESIS_FAILED')) })
    this.child.once('error', () => { this.fail(new TtsError('SYNTHESIS_FAILED')) })
    this.closed = new Promise<void>((resolve) => {
      this.child.once('close', () => {
        this.loaded = false
        this.fail(new TtsError('SYNTHESIS_FAILED'))
        resolve()
      })
    }).then(() => rm(outputDirectory, { recursive: true, force: true }))
    // Cleanup is also awaited by stop; observe spontaneous-exit cleanup failures.
    void this.closed.catch(() => {})
  }

  /**
   * Request one result after ready; the engine serializes requests.
   * @param id - Host-generated request identifier.
   * @param text - Validated text, never a prompt for voice cloning.
   * @param speaker - One of the two allowed preset speakers.
   * @param outputPath - Exclusively owned temporary WAV destination.
   * @returns Completion after the worker confirms this exact output path.
   */
  generate(id: string, text: string, speaker: TtsSpeaker, outputPath: string): Promise<void> {
    if (this.failure || !this.loaded || this.pending) return Promise.reject(this.failure ?? new TtsError('SYNTHESIS_FAILED'))
    this.diagnosticBytes = 0
    return new Promise<void>((resolve, reject) => {
      this.pending = { id, path: outputPath, resolve, reject }
      this.child.stdin.write(`${JSON.stringify({ id, text, speaker, outputPath })}\n`, (error) => {
        if (error) this.fail(new TtsError('SYNTHESIS_FAILED'))
      })
    })
  }

  /** Stop the owned process group and wait until its pipes are closed. */
  async stop(): Promise<void> {
    this.fail(new TtsError('REQUEST_ABORTED'))
    await this.closed
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.loaded = false
    this.rejectReady(error)
    this.pending?.reject(error)
    this.pending = undefined
    if (this.child.pid && process.platform !== 'win32') {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch {
        // The process group may already have exited; the close event still settles cleanup.
        this.child.kill('SIGKILL')
      }
    } else this.child.kill('SIGKILL')
  }

  private receive(chunk: string): void {
    if (this.failure) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 16 * 1024) { this.fail(new TtsError('SYNTHESIS_FAILED')); return }
    let end: number
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let message: unknown
      try { message = JSON.parse(line) } catch { this.fail(new TtsError('SYNTHESIS_FAILED')); return }
      if (!message || typeof message !== 'object') { this.fail(new TtsError('SYNTHESIS_FAILED')); return }
      if ('type' in message && message.type === 'ready' && !this.loaded && !this.pending) {
        this.loaded = true
        this.acceptReady()
      } else if (this.pending && 'id' in message && message.id === this.pending.id && 'ok' in message) {
        if (message.ok !== true || !('path' in message) || message.path !== this.pending.path) {
          this.fail(new TtsError('SYNTHESIS_FAILED')); return
        }
        const pending = this.pending
        this.pending = undefined
        pending.resolve()
      } else { this.fail(new TtsError('SYNTHESIS_FAILED')); return }
    }
  }
}
