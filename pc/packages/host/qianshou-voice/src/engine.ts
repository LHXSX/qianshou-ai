/** Host-local whisper.cpp process ownership and private, bounded audio exchange. */
import { execFile, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceFailure } from './failure.ts'
import type { VoiceEngineOptions } from './types.ts'

/**
 * Check resource accessibility without loading model weights or claiming recognition success.
 * @param options - Explicit Host-owned binary and model locations.
 * @returns Whether the executable and model are accessible.
 */
export async function voiceAvailable(options: VoiceEngineOptions): Promise<boolean> {
  try {
    const [binary, model] = await Promise.all([stat(options.binary), stat(options.model),
      access(options.binary, constants.X_OK), access(options.model, constants.R_OK)])
    return binary.isFile() && model.isFile()
  } catch (error) {
    // A missing or inaccessible configured resource is a visible unavailable status.
    void error
    return false
  }
}

async function run(input: string, output: string, options: VoiceEngineOptions, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const deadline = new AbortController()
  let child: ChildProcess
  const executed = new Promise<void>((resolve, reject) => {
    child = execFile(options.binary, ['-m', options.model, '-f', input, '-l', 'zh', '-nt', '-otxt', '-of', output,
      '-t', String(options.threads)], {
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      maxBuffer: options.maxProcessOutputBytes, killSignal: 'SIGKILL',
    }, (error) => { if (error) reject(new VoiceFailure('TRANSCRIPTION_FAILED', 500)); else resolve() })
  })
  const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
  const abort = (): void => { child.kill('SIGKILL') }
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { deadline.abort(); abort() }, options.timeoutMs)
  timer.unref()
  if (signal.aborted) abort()
  try {
    const [result] = await Promise.allSettled([executed, closed])
    signal.throwIfAborted()
    if (deadline.signal.aborted) throw new VoiceFailure('VOICE_TIMEOUT', 504)
    if (result.status === 'rejected') throw result.reason
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Recognize bounded PCM audio and wait for process closure and temporary-file cleanup on every outcome.
 * @param bytes - Previously admitted complete WAV bytes.
 * @param options - Explicit native recognizer settings.
 * @param signal - Request and owner cancellation.
 * @returns Recognized text suitable for a draft; never dispatches a model or message.
 */
export async function transcribeVoice(bytes: Buffer, options: VoiceEngineOptions, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'qianshou-voice-'))
  try {
    await chmod(directory, 0o700)
    const input = join(directory, 'speech.wav'), output = join(directory, 'transcript')
    await writeFile(input, bytes, { flag: 'wx', mode: 0o600 })
    await run(input, output, options, signal)
    const file = await open(`${output}.txt`, 'r')
    let text: string
    try {
      if ((await file.stat()).size > options.maxResultBytes) throw new VoiceFailure('RESULT_TOO_LARGE', 413)
      const buffer = Buffer.alloc(options.maxResultBytes + 1)
      let total = 0
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total)
        if (bytesRead === 0) break
        total += bytesRead
      }
      if (total > options.maxResultBytes) throw new VoiceFailure('RESULT_TOO_LARGE', 413)
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)).trim()
    } finally { await file.close() }
    signal.throwIfAborted()
    if (/^\s*\[[^\]]*\]\s*$/.test(text)) text = ''
    if (Buffer.byteLength(JSON.stringify({ text }), 'utf8') > options.maxResultBytes) throw new VoiceFailure('RESULT_TOO_LARGE', 413)
    return text
  } finally { await rm(directory, { recursive: true, force: true }) }
}
