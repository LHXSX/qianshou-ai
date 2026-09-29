import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Host-controlled recognizer assets and the maximum process lifetime. */
export interface VoiceEngineOptions {
  binary: string
  model: string
  timeoutMs: number
}

/**
 * Probe installed assets without starting a model or opening a microphone.
 * @param options - Host-controlled executable and model paths.
 * @returns Whether the executable is accessible and the model is readable; not an accuracy check.
 */
export async function voiceAvailable(options: VoiceEngineOptions): Promise<boolean> {
  try {
    await Promise.all([access(options.binary, constants.X_OK), access(options.model, constants.R_OK)])
    return true
  } catch { return false }
}

/**
 * Run a bounded local recognizer with private files and no inherited Host secrets.
 * @param bytes - WAV bytes validated by the request owner.
 * @param options - Host-controlled recognizer paths and timeout.
 * @param signal - Cancellation that force-stops the owned recognizer process.
 * @returns Its trimmed transcript, or an empty string for empty/non-speech output.
 * @throws On cancellation, process failure, timeout or file I/O failure; private files are cleaned after process close.
 */
export async function transcribeVoice(bytes: Uint8Array, options: VoiceEngineOptions, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'forge-voice-'))
  try {
    await chmod(directory, 0o700)
    const input = join(directory, 'speech.wav')
    const output = join(directory, 'transcript')
    await writeFile(input, bytes, { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    let closed!: Promise<void>
    const execution = new Promise<void>((resolve, reject) => {
      const child = execFile(options.binary, ['-m', options.model, '-f', input, '-l', 'zh', '-nt', '-otxt', '-of', output, '-t', '4'], {
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      }, error => { if (error) reject(error); else resolve() })
      // Abort can reject execFile's callback before stdio closes. The private
      // directory belongs to the process until its actual close event.
      const abort = (): void => { child.kill('SIGKILL') }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      closed = new Promise<void>(resolveClosed => {
        child.once('close', () => {
          signal.removeEventListener('abort', abort)
          resolveClosed()
        })
      })
    })
    await Promise.allSettled([execution, closed])
    await execution
    signal.throwIfAborted()
    const text = (await readFile(`${output}.txt`, 'utf8')).trim()
    // Do not turn a silence marker or a hallucinated non-speech event into an action.
    if (!text || /^\s*\[[^\]]*\]\s*$/.test(text)) return ''
    return text
  } finally {
    // This directory is exclusively created here and never accepted from the caller.
    await rm(directory, { recursive: true, force: true })
  }
}
