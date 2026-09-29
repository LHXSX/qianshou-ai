/** One owner-approved, local-only Mac drawing trial with a durable chat artifact.
 *
 * This Host helper deliberately does not install a package, advertise supply,
 * create a Shanghai lease, or append a conversation event. The caller must use
 * a trusted session writer to present the returned attachment to the owner.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { ComputeError } from './errors.ts'
import type { ComputeExecutionResult, ComputeProgressReporter } from './executor.ts'
import { runAuthorizedLocalTask, type LocalExecutionReceipt } from './local-execution-admission.ts'
import type { ComputeLocalTaskRunner } from './local-task-runner.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import { parseTaskEnvelope } from './validation.ts'

const CAPABILITY_ID = 'video.drawn-mac-5s'
const CAPABILITY_VERSION = '0.1.0'
const VIDEO_NAME = 'drawn-video-5s.mp4'
const MAX_VIDEO_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024
const DIGEST = /^[a-f0-9]{64}$/u

/** File references are content-addressed, serializable values, never paths. */
export interface LocalVideoFileRef {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/** The mounted attachment provider supplies the durable store and later resolves its own reference. */
export interface LocalVideoAttachmentStore<Ref extends LocalVideoFileRef> {
  saveFileStream(input: { readonly data: AsyncIterable<Uint8Array>; readonly signal?: AbortSignal; readonly name?: string }): Promise<Ref>
  fileHostPath(ref: Ref): string | undefined
}

export interface StoredMacDrawnVideo<Ref extends LocalVideoFileRef> {
  readonly kind: 'local-mac-drawn-video'
  readonly mediaType: 'video/mp4'
  readonly durationSeconds: 5
  readonly capabilityId: typeof CAPABILITY_ID
  readonly capabilityVersion: typeof CAPABILITY_VERSION
  readonly sha256: string
  readonly attachment: Ref
}

/**
 * Execute only the exact reviewed Mac drawing capability after local owner admission.
 * The verified MP4 is streamed into durable attachment storage before the task
 * workspace is removed. The receipt contains no task workspace or local path.
 */
export function runAuthorizedMacDrawnVideoTrial<Ref extends LocalVideoFileRef>(input: {
  readonly runner: Pick<ComputeLocalTaskRunner, 'run'>
  readonly approval: unknown
  readonly task: ComputeTaskEnvelope
  readonly workspaceRootPath: string
  readonly attachments: LocalVideoAttachmentStore<Ref>
  readonly signal: AbortSignal
  readonly reportProgress: ComputeProgressReporter
  readonly now: string
  readonly localNodeId: string
  readonly pluginDigest: string
}): Promise<LocalExecutionReceipt<StoredMacDrawnVideo<Ref>>> {
  const task = parseTaskEnvelope(input.task)
  if (task.capabilityId !== CAPABILITY_ID || task.capabilityVersion !== CAPABILITY_VERSION
    || task.inputRefs.length !== 0 || task.maxOutputBytes > MAX_VIDEO_BYTES) {
    throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_TASK_INVALID', 422)
  }
  if (!isAbsolute(input.workspaceRootPath) || input.workspaceRootPath.includes('\0')) {
    throw new ComputeError('COMPUTE_WORKSPACE_CONFIG_INVALID', 422)
  }
  return runAuthorizedLocalTask({
    runner: input.runner, approval: input.approval, task,
    now: input.now, localNodeId: input.localNodeId, pluginDigest: input.pluginDigest,
    request: {
      workspace: { rootPath: input.workspaceRootPath, maxInputBytes: 0 },
      source: { open: async () => { throw new ComputeError('COMPUTE_DRAWN_VIDEO_INPUT_REFS_FORBIDDEN', 422) } },
      signal: input.signal, reportProgress: input.reportProgress,
      consumeResult: (result, signal) => persistVideo(result, input.attachments, signal),
    },
  })
}

/** Resolve only a Host-stored content reference for a trusted session media link. */
export function macDrawnVideoHostPath<Ref extends LocalVideoFileRef>(
  result: StoredMacDrawnVideo<Ref>, store: Pick<LocalVideoAttachmentStore<Ref>, 'fileHostPath'>,
): string {
  if (result.kind !== 'local-mac-drawn-video' || result.mediaType !== 'video/mp4'
    || result.durationSeconds !== 5 || result.capabilityId !== CAPABILITY_ID
    || result.capabilityVersion !== CAPABILITY_VERSION || !DIGEST.test(result.sha256)
    || result.attachment.name !== VIDEO_NAME || result.attachment.bytes < 1
    || result.attachment.bytes > MAX_VIDEO_BYTES
    || result.attachment.attachmentId !== `sha256:${result.sha256}`) {
    throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_REFERENCE_INVALID', 422)
  }
  const path = store.fileHostPath(result.attachment)
  if (path === undefined || !isAbsolute(path) || path.includes('\0') || !path.endsWith(`/${VIDEO_NAME}`)) {
    throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_PATH_UNAVAILABLE', 503)
  }
  return path
}

async function persistVideo<Ref extends LocalVideoFileRef>(
  result: ComputeExecutionResult, store: LocalVideoAttachmentStore<Ref>, signal: AbortSignal,
): Promise<StoredMacDrawnVideo<Ref>> {
  const output = result.outputs[0]
  if (result.outputs.length !== 1 || output === undefined || output.name !== VIDEO_NAME
    || !isAbsolute(output.path) || !DIGEST.test(output.sha256)
    || !Number.isSafeInteger(output.bytes) || output.bytes < 1 || output.bytes > MAX_VIDEO_BYTES
    || result.metadata?.mediaType !== 'video/mp4' || result.metadata.durationSeconds !== '5'
    || result.metadata.renderer !== 'macos-appkit-drawing') {
    throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_RESULT_INVALID', 422)
  }
  signal.throwIfAborted()
  const file = await open(output.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size !== output.bytes) {
      throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_FILE_INVALID', 422)
    }
    // MP4 boxes start with a big-endian box length followed by the ftyp box.
    const header = Buffer.alloc(12)
    const first = await file.read(header, 0, header.length, 0)
    if (first.bytesRead !== header.length || header.toString('ascii', 4, 8) !== 'ftyp'
      || header.readUInt32BE(0) < 12) {
      throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_FILE_INVALID', 422)
    }
    let consumed = false
    const chunks = async function* (): AsyncIterable<Uint8Array> {
      const digest = createHash('sha256')
      const buffer = Buffer.alloc(CHUNK_BYTES)
      let offset = 0
      while (offset < before.size) {
        signal.throwIfAborted()
        const read = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
        if (read.bytesRead === 0) throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_FILE_CHANGED', 422)
        const chunk = Buffer.from(buffer.subarray(0, read.bytesRead))
        offset += read.bytesRead
        digest.update(chunk)
        yield chunk
      }
      const after = await file.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || digest.digest('hex') !== output.sha256) {
        throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_FILE_CHANGED', 422)
      }
      consumed = true
    }
    const attachment = await store.saveFileStream({ data: chunks(), signal, name: VIDEO_NAME })
    if (!consumed || attachment.name !== VIDEO_NAME || attachment.bytes !== output.bytes
      || attachment.attachmentId !== `sha256:${output.sha256}`) {
      throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_STORE_MISMATCH', 422)
    }
    // A non-local backend cannot be shown through the current authenticated /api/file route.
    const savedPath = store.fileHostPath(attachment)
    if (savedPath === undefined || !isAbsolute(savedPath) || savedPath.includes('\0')
      || !savedPath.endsWith(`/${VIDEO_NAME}`) || savedPath === output.path) {
      throw new ComputeError('COMPUTE_LOCAL_VIDEO_TRIAL_PATH_UNAVAILABLE', 503)
    }
    signal.throwIfAborted()
    return Object.freeze({ kind: 'local-mac-drawn-video', mediaType: 'video/mp4', durationSeconds: 5,
      capabilityId: CAPABILITY_ID, capabilityVersion: CAPABILITY_VERSION,
      sha256: output.sha256, attachment: Object.freeze({ ...attachment }) })
  } finally { await file.close() }
}
