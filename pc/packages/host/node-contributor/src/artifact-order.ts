/** Explicit local artifact adapters; SKILL.md prose and marketplace names are never executors. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { ComputeError, verifyTaskOutputs } from '@deepseek-ai/dsh-compute-core'
import type { EdgeArtifactManifest } from '@deepseek-ai/dsh-compute-core/src/edge-worker/types.ts'
import type { ComputeResidentResultConsumer } from '@deepseek-ai/dsh-compute-core/resident'
import { isPublishedNativeH3Adapter, nativeH3AdapterMatchesLease } from './native-h3-publication.ts'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import type { NativeH3TaskLeaseV2 } from '@deepseek-ai/dsh-compute-core/native-h3-task-lease'

const MAX_RECIPE_BYTES = 16_384
const MAX_MEDIA_BYTES = 16 * 1024 * 1024
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const OBJECT_VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u

export type ArtifactOutputFormat = 'gif' | 'mp4'

/** A code-owned adapter that has passed its own output proof before it is selected. */
export interface ArtifactOrderAdapter {
  readonly taskType: string
  readonly inputKind: 'inline'
  readonly outputKind: 'artifact_ref'
  readonly contractVersion: 'v1' | 'v2'
  readonly artifactDigest: string
  /** Source plus the pinned runtime/dependency bytes actually executed. */
  readonly packageDigest: string
  readonly outputFormats: readonly ArtifactOutputFormat[]
  /** Native adapters own their strict public input contract; the legacy default is the SVG recipe. */
  readonly maxInputBytes?: number
  readonly prepareRequest?: (inline: string, parameters: Readonly<Record<string, unknown>>) => {
    readonly recipeJson: string
    readonly outputFormat: ArtifactOutputFormat
  }
  run(input: {
    readonly recipeJson: string
    readonly outputFormat: ArtifactOutputFormat
    readonly workspacePath: string
    readonly signal: AbortSignal
    readonly nativeDeviceLease?: NativeH3TaskLeaseV2
  }): Promise<{ readonly path: string; readonly filename: string; readonly contentType: 'image/gif' | 'video/mp4' }>
}

/** The current authenticated worker session owns the lease; the adapter never receives it. */
export interface ArtifactOrderUploadPort {
  /** Read the server assignment's original credential, never buyer JSON or a newest-adapter guess. */
  nativeDeviceLease?(taskId: string, attempt: number): NativeH3TaskLeaseV2 | undefined
  upload(taskId: string, attempt: number, input: {
    readonly filename: string
    readonly contentType: 'image/gif' | 'video/mp4'
    readonly bytes: Uint8Array
  }, signal: AbortSignal): Promise<EdgeArtifactManifest>
  remember(taskId: string, artifact: EdgeArtifactManifest, elapsedMs: number): void
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Refuse undeclared or malformed adapters before any task can call their code. */
export function validateArtifactOrderAdapter(adapter: ArtifactOrderAdapter): void {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u.test(adapter.taskType)
    || adapter.inputKind !== 'inline' || adapter.outputKind !== 'artifact_ref'
    || !['v1', 'v2'].includes(adapter.contractVersion)
    || (adapter.contractVersion === 'v2' && !isPublishedNativeH3Adapter(adapter))
    || !DIGEST.test(adapter.artifactDigest)
    || !DIGEST.test(adapter.packageDigest)
    || !Array.isArray(adapter.outputFormats) || adapter.outputFormats.length < 1
    || adapter.outputFormats.length > 2 || new Set(adapter.outputFormats).size !== adapter.outputFormats.length
    || adapter.outputFormats.some(format => format !== 'gif' && format !== 'mp4')
    || (adapter.maxInputBytes !== undefined && (!Number.isSafeInteger(adapter.maxInputBytes)
      || adapter.maxInputBytes < 1 || adapter.maxInputBytes > 64 * 1024))
    || (adapter.prepareRequest !== undefined && typeof adapter.prepareRequest !== 'function')
    || typeof adapter.run !== 'function') {
    throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_INVALID')
  }
}

/**
 * Execute only one explicitly selected adapter, verify the output on disk, upload it under
 * the active worker lease, then remember its tiny reference for the WebSocket return.
 * Native H3 and the separately verified SVG provider share this lease-bound upload path.
 */
export function createArtifactOrderConsumer(adapter: ArtifactOrderAdapter, port: ArtifactOrderUploadPort): ComputeResidentResultConsumer {
  validateArtifactOrderAdapter(adapter)
  return {
    async consume({ execution, workspace, signal }) {
      signal.throwIfAborted()
      const fields = execution.task.parameters
      const nativeDeviceLease = adapter.contractVersion === 'v2'
        ? port.nativeDeviceLease?.(execution.task.taskId, execution.attempt.attempt) : undefined
      if (adapter.contractVersion === 'v2' && (!nativeH3AdapterMatchesLease(adapter, nativeDeviceLease)
        || !record(fields) || fields.nativeDeviceLease === undefined
        || canonicalNativeH3ReviewJson(fields.nativeDeviceLease) !== canonicalNativeH3ReviewJson(nativeDeviceLease))) {
        throw new ComputeError('H3_NATIVE_TASK_LEASE_INVALID', 409)
      }
      if (!record(fields) || fields.taskType !== adapter.taskType || typeof fields.inlineInput !== 'string'
        || Buffer.byteLength(fields.inlineInput, 'utf8') < 1
        || Buffer.byteLength(fields.inlineInput, 'utf8') > (adapter.maxInputBytes ?? MAX_RECIPE_BYTES)
        || (fields.taskParams !== undefined && !record(fields.taskParams))) {
        throw new ComputeError('COMPUTE_ARTIFACT_PARAMETERS_INVALID', 422)
      }
      const params = (fields.taskParams ?? {})
      let request: { recipeJson: string; outputFormat: ArtifactOutputFormat }
      if (adapter.prepareRequest !== undefined) request = adapter.prepareRequest(fields.inlineInput, params)
      else {
        if (Object.keys(params).length !== 1 || (params.output_format !== 'gif' && params.output_format !== 'mp4')) {
          throw new ComputeError('COMPUTE_ARTIFACT_PARAMETERS_INVALID', 422)
        }
        let recipe: unknown
        try { recipe = JSON.parse(fields.inlineInput) } catch { throw new ComputeError('COMPUTE_ARTIFACT_PARAMETERS_INVALID', 422) }
        if (!record(recipe) || recipe.kind !== adapter.taskType) throw new ComputeError('COMPUTE_ARTIFACT_PARAMETERS_INVALID', 422)
        request = { recipeJson: fields.inlineInput, outputFormat: params.output_format }
      }
      const outputFormat = request.outputFormat
      if (!adapter.outputFormats.includes(outputFormat)) throw new ComputeError('COMPUTE_ARTIFACT_PARAMETERS_INVALID', 422)
      const started = Date.now()
      await execution.reportProgress(0, 'started')
      const produced = await adapter.run({
        ...request, workspacePath: workspace.path, signal,
        ...nativeDeviceLease === undefined ? {} : { nativeDeviceLease },
      })
      const expectedFilename = `result.${outputFormat}`
      const expectedMime = outputFormat === 'gif' ? 'image/gif' : 'video/mp4'
      if (produced.filename !== expectedFilename || produced.contentType !== expectedMime) {
        throw new ComputeError('COMPUTE_ARTIFACT_OUTPUT_INVALID', 422)
      }
      const st = await lstat(produced.path)
      if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > MAX_MEDIA_BYTES) {
        throw new ComputeError('COMPUTE_ARTIFACT_OUTPUT_INVALID', 422)
      }
      const bytes = await readFile(produced.path)
      if (bytes.byteLength !== st.size) throw new ComputeError('COMPUTE_ARTIFACT_OUTPUT_CHANGED', 422)
      if (outputFormat === 'gif' && bytes.subarray(0, 6).toString('ascii') !== 'GIF89a'
        || outputFormat === 'mp4' && bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
        throw new ComputeError('COMPUTE_ARTIFACT_OUTPUT_INVALID', 422)
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const verified = await verifyTaskOutputs(workspace.path, {
        outputs: [{ name: expectedFilename, path: await realpath(produced.path), bytes: bytes.byteLength, sha256 }],
      }, Math.min(execution.task.maxOutputBytes, MAX_MEDIA_BYTES), signal)
      if (verified.outputs.length !== 1) throw new ComputeError('COMPUTE_ARTIFACT_OUTPUT_INVALID', 422)
      signal.throwIfAborted()
      const artifact = await port.upload(execution.task.taskId, execution.attempt.attempt, {
        filename: expectedFilename, contentType: expectedMime, bytes,
      }, signal)
      if (artifact.filename !== expectedFilename || artifact.content_type !== expectedMime
        || artifact.size_bytes !== bytes.byteLength || artifact.sha256 !== sha256
        || !OBJECT_VERSION.test(artifact.object_version_id)
        || artifact.object_version_id.toLowerCase() === 'null') {
        throw new ComputeError('COMPUTE_ARTIFACT_UPLOAD_MISMATCH', 422)
      }
      port.remember(execution.task.taskId, artifact, Math.max(0, Date.now() - started))
      await execution.reportProgress(1, 'done')
      return { outputs: Object.freeze([{ name: expectedFilename, bytes: bytes.byteLength, sha256 }]) }
    },
  }
}
