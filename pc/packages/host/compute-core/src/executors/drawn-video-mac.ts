/** Owner-installed macOS motion-template executor. No model, network, or shell is involved. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ComputeError } from '../errors.ts'
import type { ComputeExecutionContext, ComputeExecutor } from '../executor.ts'
import type { ComputeCapabilityId, ComputeTaskEnvelope } from '../protocol.ts'
import { DRAWN_VIDEO_SWIFT } from './drawn-video-program.ts'

const FPS = 24
const FRAMES = 120
const WIDTH = 1280
const HEIGHT = 720
const MAX_VIDEO_BYTES = 20 * 1024 * 1024
const MAX_LOG_BYTES = 16 * 1024
const CAPABILITY_ID = 'video.drawn-mac-5s'
const CAPABILITY_VERSION = '0.1.0'

/** Absolute, administrator-selected local tools and one exact approved capability identity. */
export interface MacDrawnVideoExecutorConfig {
  readonly capabilityId: ComputeCapabilityId
  readonly version: string
  readonly swiftPath: string
  readonly ffmpegPath: string
  readonly ffprobePath: string
  /** Complete process budget, additionally capped by the task deadline. */
  readonly maxRuntimeMs: number
}

interface DrawnVideoParameters { readonly title: string; readonly subtitle: string }

/** Create a candidate executor; the owner and Host still control registration and supply.
 * @param config - Exact capability/version, executable paths, and runtime limit from trusted installation config.
 * @returns A registerable local executor that writes only a verified MP4 to the task workspace.
 */
export function createMacDrawnVideoExecutor(config: MacDrawnVideoExecutorConfig): ComputeExecutor {
  if (config.capabilityId !== CAPABILITY_ID || config.version !== CAPABILITY_VERSION
    || ![config.swiftPath, config.ffmpegPath, config.ffprobePath].every(path => isAbsolute(path) && !path.includes('\0'))
    || !Number.isSafeInteger(config.maxRuntimeMs) || config.maxRuntimeMs < 1 || config.maxRuntimeMs > 300_000) {
    throw new ComputeError('COMPUTE_DRAWN_VIDEO_CONFIG_INVALID')
  }
  return {
    capabilityId: config.capabilityId,
    version: config.version,
    async execute(task, context) { return executeDrawnVideo(config, task, context) },
  }
}

async function executeDrawnVideo(config: MacDrawnVideoExecutorConfig, task: ComputeTaskEnvelope,
  context: ComputeExecutionContext) {
  if (process.platform !== 'darwin') throw new ComputeError('COMPUTE_DRAWN_VIDEO_PLATFORM_UNSUPPORTED', 409)
  if ((context as { interactionPolicy?: unknown }).interactionPolicy !== 'autonomous') {
    throw new ComputeError('COMPUTE_HUMAN_INTERACTION_FORBIDDEN', 409)
  }
  if (task.capabilityId !== config.capabilityId || task.capabilityVersion !== config.version) {
    throw new ComputeError('COMPUTE_EXECUTOR_UNAVAILABLE', 409)
  }
  if (task.inputRefs.length !== 0 || context.inputs.length !== 0) throw new ComputeError('COMPUTE_DRAWN_VIDEO_INPUT_REFS_FORBIDDEN', 422)
  const parameters = parseParameters(task.parameters)
  if (!isAbsolute(context.workspacePath)) throw new ComputeError('COMPUTE_WORKSPACE_INVALID')
  context.signal.throwIfAborted()
  const deadline = Math.min(Date.parse(task.deadlineAt), Date.now() + config.maxRuntimeMs)
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new ComputeError('COMPUTE_DRAWN_VIDEO_TIMEOUT', 408)
  const directory = join(context.workspacePath, `drawn-video-${randomUUID()}`)
  const frames = join(directory, 'frames')
  const script = join(directory, 'draw.swift')
  const textPath = join(directory, 'text.json')
  const video = join(directory, 'result.mp4')
  let keepVideo = false
  await mkdir(directory, { mode: 0o700 })
  try {
    await mkdir(frames, { mode: 0o700 })
    const source = await open(script, 'wx', 0o600)
    try { await source.writeFile(DRAWN_VIDEO_SWIFT) } finally { await source.close() }
    const textFile = await open(textPath, 'wx', 0o600)
    try { await textFile.writeFile(JSON.stringify(parameters)) } finally { await textFile.close() }
    await runBounded(config.swiftPath, [script, frames, textPath], directory,
      deadline, context.signal)
    await context.reportProgress(0.6, 'frames-drawn')
    await runBounded(config.ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-framerate', String(FPS), '-i', join(frames, 'frame_%03d.png'),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-r', String(FPS), '-frames:v', String(FRAMES), '-an', '-movflags', '+faststart',
      '-fs', String(Math.min(task.maxOutputBytes, MAX_VIDEO_BYTES)), video], directory,
    deadline, context.signal)
    const file = await lstat(video)
    if (!file.isFile() || file.isSymbolicLink() || file.size < 1
      || file.size > Math.min(task.maxOutputBytes, MAX_VIDEO_BYTES)) {
      throw new ComputeError('COMPUTE_DRAWN_VIDEO_OUTPUT_INVALID', 422)
    }
    const probe = await runBounded(config.ffprobePath, ['-v', 'error', '-count_frames',
      '-show_streams', '-show_format', '-of', 'json', video], directory, deadline, context.signal)
    verifyProbe(probe)
    await runBounded(config.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror',
      '-i', video, '-f', 'null', '-'], directory, deadline, context.signal)
    context.signal.throwIfAborted()
    const bytes = await readFile(video)
    if (bytes.byteLength !== file.size) throw new ComputeError('COMPUTE_DRAWN_VIDEO_OUTPUT_INVALID', 422)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await context.reportProgress(1, 'video-verified')
    keepVideo = true
    return { outputs: [{ name: 'drawn-video-5s.mp4', path: video, bytes: file.size, sha256 }],
      metadata: { mediaType: 'video/mp4', width: String(WIDTH), height: String(HEIGHT),
        fps: String(FPS), frames: String(FRAMES), durationSeconds: '5', renderer: 'macos-appkit-drawing' } }
  } finally {
    if (keepVideo) {
      await rm(frames, { recursive: true, force: true })
      await rm(script, { force: true })
      await rm(textPath, { force: true })
    } else {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

function parseParameters(value: unknown): DrawnVideoParameters {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_DRAWN_VIDEO_PARAMETERS_INVALID', 422)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'title' && key !== 'subtitle')
    || !validText(record.title, 16) || !validText(record.subtitle, 32)) {
    throw new ComputeError('COMPUTE_DRAWN_VIDEO_PARAMETERS_INVALID', 422)
  }
  return { title: record.title, subtitle: record.subtitle }
}

function validText(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxChars
    && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= 128
}

function verifyProbe(output: string): void {
  let value: unknown
  try { value = JSON.parse(output) } catch { throw new ComputeError('COMPUTE_DRAWN_VIDEO_PROBE_INVALID', 422) }
  if (!value || typeof value !== 'object') throw new ComputeError('COMPUTE_DRAWN_VIDEO_PROBE_INVALID', 422)
  const report = value as { streams?: unknown; format?: unknown }
  if (!Array.isArray(report.streams) || report.streams.length !== 1 || !report.streams[0]
    || !report.format || typeof report.format !== 'object') throw new ComputeError('COMPUTE_DRAWN_VIDEO_PROBE_INVALID', 422)
  const stream = report.streams[0] as Record<string, unknown>
  const format = report.format as Record<string, unknown>
  const duration = Number(format.duration)
  if (stream.codec_type !== 'video' || stream.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p'
    || stream.width !== WIDTH || stream.height !== HEIGHT || stream.nb_read_frames !== String(FRAMES)
    || stream.avg_frame_rate !== `${FPS}/1` || !Number.isFinite(duration) || Math.abs(duration - 5) > 0.001) {
    throw new ComputeError('COMPUTE_DRAWN_VIDEO_PROBE_INVALID', 422)
  }
}

function scrubbedEnvironment(cwd: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: cwd, TMPDIR: cwd, LANG: 'en_US.UTF-8' }
}

async function runBounded(command: string, args: readonly string[], cwd: string,
  deadline: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new ComputeError('COMPUTE_DRAWN_VIDEO_TIMEOUT', 408)
  const child = spawn(command, [...args], { cwd, env: scrubbedEnvironment(cwd),
    shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const state: { exceeded: boolean; timedOut: boolean; cancelled: boolean } = {
    exceeded: false, timedOut: false, cancelled: false,
  }
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    const pid = child.pid
    if (pid !== undefined) {
      try { process.kill(-pid, 'SIGTERM') } catch (_error) { child.kill('SIGTERM') }
      forceTimer ??= setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL') } catch (_error) { child.kill('SIGKILL') }
      }, 2_000)
    } else child.kill('SIGTERM')
  }
  const onAbort = () => { state.cancelled = true; stop() }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timer = setTimeout(() => { state.timedOut = true; stop() }, remaining)
  const collect = (chunk: Buffer, target: 'stdout' | 'stderr') => {
    if (target === 'stdout') stdout += chunk.toString('utf8')
    else stderr += chunk.toString('utf8')
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_LOG_BYTES) { state.exceeded = true; stop() }
  }
  child.stdout.on('data', (chunk: Buffer) => { collect(chunk, 'stdout') })
  child.stderr.on('data', (chunk: Buffer) => { collect(chunk, 'stderr') })
  try {
    const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let error: Error | undefined
      child.on('error', (caught) => { error = caught })
      child.on('close', (code) => { resolve(error ? { code, error } : { code }) })
    })
    if (state.cancelled || signal.aborted) throw new ComputeError('COMPUTE_DRAWN_VIDEO_ABORTED', 409)
    if (state.timedOut) throw new ComputeError('COMPUTE_DRAWN_VIDEO_TIMEOUT', 408)
    if (state.exceeded) throw new ComputeError('COMPUTE_DRAWN_VIDEO_PROCESS_OUTPUT_LIMIT', 413)
    if (result.error || result.code !== 0) {
      throw new ComputeError('COMPUTE_DRAWN_VIDEO_PROCESS_FAILED', 422,
        result.error instanceof Error ? result.error.message : `exit ${String(result.code)}`)
    }
    return stdout
  } finally {
    clearTimeout(timer)
    if (forceTimer) clearTimeout(forceTimer)
    signal.removeEventListener('abort', onAbort)
  }
}
