/** Private local task inputs; network authorization stays with the input provider. */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ComputeError } from './errors.ts'
import type { ComputeInputReference } from './executor.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import { parseTaskEnvelope } from './validation.ts'

/** Deployment-owned root and aggregate input-byte allowance for one attempt. */
export interface ComputeTaskWorkspaceConfig {
  rootPath: string
  maxInputBytes: number
}

/** Streaming input provider bound by the host to an authenticated task and lease. */
export interface ComputeTaskInputSource {
  /** Open only the given task input; URLs, tokens and account paths stay in the provider.
   * @param task - Validated task whose reference is being staged.
   * @param input - Exact reference from that envelope.
   * @param signal - Cancellation shared with the task execution.
   * @returns A byte stream whose size and digest the workspace verifies independently.
   */
  open(task: ComputeTaskEnvelope, input: ComputeTaskEnvelope['inputRefs'][number], signal: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

/** A private attempt directory with verified inputs; this is not an OS process sandbox. */
export interface ComputeTaskWorkspace {
  readonly path: string
  readonly inputs: readonly ComputeInputReference[]
  /** Remove only this attempt after every executor and transfer has stopped.
   * @returns Once owned files have been removed; repeated calls share the cleanup outcome.
   */
  close(): Promise<void>
}

/** Stage all inputs before exposing a workspace to the unified executor.
 * @param config - Explicit storage location and byte limit.
 * @param task - Assignment envelope, revalidated before any filesystem effects.
 * @param source - Host-selected provider that fetches only authorized input references.
 * @param signal - Cancellation for setup and all input streams.
 * @returns A workspace with frozen input metadata and idempotent cleanup.
 */
export async function prepareTaskWorkspace(
  config: ComputeTaskWorkspaceConfig,
  task: ComputeTaskEnvelope,
  source: ComputeTaskInputSource,
  signal: AbortSignal,
): Promise<ComputeTaskWorkspace> {
  if (!isAbsolute(config.rootPath) || config.rootPath.includes('\0')
    || !Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes < 0) throw new ComputeError('COMPUTE_WORKSPACE_CONFIG_INVALID')
  const admitted = parseTaskEnvelope(task)
  let total = 0
  const names = new Set<string>()
  for (const input of admitted.inputRefs) {
    total += input.bytes
    if (!Number.isSafeInteger(total) || total > config.maxInputBytes) throw new ComputeError('COMPUTE_INPUT_LIMIT_EXCEEDED', 413)
    if (names.has(input.name)) throw new ComputeError('COMPUTE_INPUT_NAME_DUPLICATE')
    names.add(input.name)
  }
  signal.throwIfAborted()
  await mkdir(config.rootPath, { recursive: true, mode: 0o700 })
  const root = await realpath(config.rootPath)
  const path = await mkdtemp(join(root, 'compute-'))
  const identity = await lstat(path)
  let cleanup: Promise<void> | undefined
  const close = (): Promise<void> => {
    cleanup ??= removeOwnedDirectory(path, identity.dev, identity.ino)
    return cleanup
  }
  try {
    await chmod(path, 0o700)
    const inputs: ComputeInputReference[] = []
    for (const [index, input] of admitted.inputRefs.entries()) {
      signal.throwIfAborted()
      // Input names are logical IDs. They never select filesystem paths.
      const destination = join(path, `input-${index}`)
      const stream = await source.open(admitted, input, signal)
      await stageInput(stream, destination, input, signal)
      inputs.push(Object.freeze({ ...input, path: destination }))
    }
    signal.throwIfAborted()
    return Object.freeze({ path, inputs: Object.freeze(inputs), close })
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'COMPUTE_WORKSPACE_SETUP_AND_CLEANUP_FAILED') }
    throw error
  }
}

async function stageInput(stream: ReadableStream<Uint8Array>, path: string, expected: ComputeTaskEnvelope['inputRefs'][number], signal: AbortSignal): Promise<void> {
  const reader = stream.getReader()
  const cancel = () => { void reader.cancel().catch(() => { /* Stream teardown can fail after the source has already closed. */ }) }
  signal.addEventListener('abort', cancel, { once: true })
  let file: Awaited<ReturnType<typeof open>> | undefined
  let complete = false
  try {
    signal.throwIfAborted()
    file = await open(path, 'wx', 0o600)
    const digest = createHash('sha256')
    let bytes = 0
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > expected.bytes) throw new ComputeError('COMPUTE_INPUT_SIZE_MISMATCH', 422)
      digest.update(chunk.value)
      await file.writeFile(chunk.value)
    }
    if (bytes !== expected.bytes) throw new ComputeError('COMPUTE_INPUT_SIZE_MISMATCH', 422)
    if (digest.digest('hex') !== expected.sha256) throw new ComputeError('COMPUTE_INPUT_DIGEST_MISMATCH', 422)
    await file.chmod(0o400)
    complete = true
  } finally {
    signal.removeEventListener('abort', cancel)
    try {
      if (!complete) await reader.cancel().catch(() => { /* Preserve the staging failure when source cancellation also fails. */ })
    } finally {
      reader.releaseLock()
      await file?.close()
    }
  }
}

async function removeOwnedDirectory(path: string, device: number, inode: number): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>
  try { current = await lstat(path) } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (current.isSymbolicLink()) { await unlink(path); return }
  if (!current.isDirectory() || current.dev !== device || current.ino !== inode) throw new ComputeError('COMPUTE_WORKSPACE_REPLACED', 409)
  await rm(path, { recursive: true })
}
