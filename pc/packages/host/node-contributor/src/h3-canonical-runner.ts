/** Fixed canonical submission and witnessed delivery; no retry or platform authority is created. */
import { createHash } from 'node:crypto'
import { request, type IncomingMessage } from 'node:http'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { canonicalH3Endpoint, type H3CanonicalIdentity } from './h3-canonical-protocol.ts'
import { parseH3OwnerRuntimeIdentity, parseH3WitnessedJob, type H3OwnerRuntimeIdentity,
  type H3WitnessedJobExpectation } from './h3-owner-witness.ts'
import { readH3WitnessedJob, readH3WitnessedMedia } from './h3-canonical-transport.ts'

/** Immutable local measurements captured by the fixed provider, not an author-selected executor. */
export interface H3CanonicalExecution {
  readonly adapterBase: string
  readonly identity: H3CanonicalIdentity
  readonly owner: H3OwnerRuntimeIdentity
  readonly firstFrame: Buffer
  readonly negative: string
  readonly assertCurrent: (signal: AbortSignal) => Promise<void>
}

/** Host-owned execution deadlines; callers cannot change routes, byte limits or submit count. */
export interface H3CanonicalRunOptions {
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
}

function fail(code: string): never { throw new ComputeError(code, 409) }

async function submit(url: URL, bytes: Buffer, signal: AbortSignal): Promise<unknown> {
  if (bytes.length > 32 * 1024 * 1024) fail('H3_CANONICAL_INPUT_INVALID')
  let response: IncomingMessage | undefined
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const operation = request(url, { method: 'POST', agent: false, signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity',
          'Content-Length': String(bytes.length) } }, resolve)
      operation.once('error', reject)
      operation.end(bytes)
    })
    if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0]?.trim() !== 'application/json'
      || (response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity')) {
      fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
    }
    const declared = response.headers['content-length']
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > 64 * 1024)) {
      fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
    }
    const chunks: Buffer[] = []; let total = 0
    for await (const part of response) {
      const value: unknown = part
      if (typeof value !== 'string' && !(value instanceof Uint8Array)) fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > 64 * 1024) fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
      chunks.push(chunk)
    }
    if (declared !== undefined && total !== Number(declared)) fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
    const text = Buffer.concat(chunks).toString('utf8')
    if (!Buffer.from(text).equals(Buffer.concat(chunks))) fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
    return JSON.parse(text) as unknown
  } catch {
    fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
  } finally { response?.destroy() }
}

/** Submit exactly once, poll only that witnessed job, and copy verified bytes into its private workspace.
 * @param measured - Fixed software and same-owner measurements captured before entering the reservation.
 * @param input - Bounded prompt, reproducible seed, trusted workspace and cancellation.
 * @param options - Host deadlines used by production and CPU-only HTTP fixtures.
 * @returns Exclusive result.mp4 after same-witness terminal metadata and media bytes agree.
 */
export async function runH3CanonicalExecution(measured: H3CanonicalExecution, input: {
  readonly prompt: string
  readonly seed: number
  readonly workspacePath: string
  readonly signal: AbortSignal
}, options: H3CanonicalRunOptions = {}): Promise<{
  readonly path: string
  readonly filename: 'result.mp4'
  readonly contentType: 'video/mp4'
  readonly sha256: string
  readonly jobId: string
}> {
  const timeout = options.timeoutMs ?? 900_000
  const pollInterval = options.pollIntervalMs ?? 1_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000
    || !Number.isSafeInteger(pollInterval) || pollInterval < 1 || pollInterval > 10_000
    || !input.prompt.isWellFormed() || Array.from(input.prompt.trim()).length < 1
    || Array.from(input.prompt.trim()).length > 7000 || !Number.isSafeInteger(input.seed)
    || input.seed < 0 || input.seed > 2147483647 || !measured.negative.isWellFormed()
    || Array.from(measured.negative).length > 3000 || measured.firstFrame.length <= 8
    || measured.firstFrame.length > 16 * 1024 * 1024
    || !measured.firstFrame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail('H3_CANONICAL_INPUT_INVALID')
  }
  const url = canonicalH3Endpoint(measured.adapterBase, { kind: 'jobs' })
  const owner = parseH3OwnerRuntimeIdentity(measured.owner, measured.identity)
  const abort = new AbortController()
  const cancel = (): void => { abort.abort() }
  const timer = setTimeout(cancel, timeout)
  input.signal.addEventListener('abort', cancel, { once: true })
  const deadline = Date.now() + timeout
  const readOptions = () => ({ signal: abort.signal, timeoutMs: Math.max(1, Math.min(180_000, deadline - Date.now())) })
  try {
    input.signal.throwIfAborted(); abort.signal.throwIfAborted()
    const directory = await lstat(input.workspacePath)
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(input.workspacePath) !== input.workspacePath) {
      fail('H3_CANONICAL_WORKSPACE_INVALID')
    }
    await measured.assertCurrent(abort.signal)
    const body = Buffer.from(JSON.stringify({ workflow: 'qs_new4', steps: 4, tier: null, preset: 'landscape_C', seconds: 5,
      prompt: input.prompt.trim(), negative: measured.negative, seed: input.seed,
      ref_images: [{ role: 'first', url: 'data:image/png;base64,' + measured.firstFrame.toString('base64') }],
      expected: { executionRecipeSha256: measured.identity.executionRecipeSha256, modelSha256: measured.identity.modelSha256 },
      ownerRuntimeWitnessSha256: owner.ownerRuntimeWitnessSha256 }))
    const packet = await submit(url, body, abort.signal)
    if (packet === null || typeof packet !== 'object' || !('job_id' in packet) || typeof packet.job_id !== 'string') {
      fail('H3_CANONICAL_SUBMISSION_UNKNOWN')
    }
    const expected: H3WitnessedJobExpectation = { jobId: packet.job_id, adapterBase: measured.adapterBase,
      identity: measured.identity, owner, comfyFfmpegSha256: owner.comfyFfmpegSha256,
      deliveryFfmpegSha256: owner.deliveryFfmpegSha256 }
    let status = parseH3WitnessedJob(packet, expected)
    while (status.state === 'queued' || status.state === 'running') {
      await delay(pollInterval, undefined, { signal: abort.signal })
      status = await readH3WitnessedJob(expected, readOptions())
    }
    if (status.state !== 'completed') fail('H3_CANONICAL_EXECUTION_UNKNOWN')
    const bytes = await readH3WitnessedMedia(expected, status, readOptions())
    await measured.assertCurrent(abort.signal); abort.signal.throwIfAborted()
    const current = await lstat(input.workspacePath)
    if (current.dev !== directory.dev || current.ino !== directory.ino || current.isSymbolicLink()
      || await realpath(input.workspacePath) !== input.workspacePath) fail('H3_CANONICAL_WORKSPACE_INVALID')
    const path = join(input.workspacePath, 'result.mp4')
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    return { path, filename: 'result.mp4', contentType: 'video/mp4',
      sha256: createHash('sha256').update(bytes).digest('hex'), jobId: status.jobId }
  } catch (error) {
    if (error instanceof ComputeError) throw error
    fail('H3_CANONICAL_EXECUTION_UNKNOWN')
  } finally { clearTimeout(timer); input.signal.removeEventListener('abort', cancel) }
}
