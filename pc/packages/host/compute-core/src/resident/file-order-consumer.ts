/** File result consumer inside the ordinary resident authorization and attempt lifecycle. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ComputeError } from '../errors.ts'
import type { EdgeArtifactManifest } from '../edge-worker/types.ts'
import { parseEdgeFileContract, type EdgeFileContract } from '../edge-worker/file-task-contract.ts'
import type { ComputeResidentResultConsumer } from './types.ts'

/** Host-owned ports retain the private lease. Guest code receives neither these ports nor credentials. */
export interface FileOrderRuntimePorts {
  read(input: { slot: string; maxBytes: number; contentTypes: readonly string[];
    contractSha256: string; fileSchemaSha256: string; trustedStorageHostname: string }, signal: AbortSignal):
    Promise<{ contentType: string; sha256: string; bytes: Uint8Array }>
  upload(input: { filename: string; contentType: string; bytes: Uint8Array;
    contractSha256: string; fileSchemaSha256: string }, signal: AbortSignal): Promise<EdgeArtifactManifest>
}
/** One installed, independently attested file runtime selected by its exact task declaration. */
export interface FileOrderRuntimeRunner {
  (input: { taskType: string; inlineInput: string; fileContract: EdgeFileContract;
    ports: FileOrderRuntimePorts; signal: AbortSignal }): Promise<EdgeArtifactManifest>
}

/** Execute a file runtime, then retain only its upload manifest as the resident result.
 * @param options - Exact installed provider, current session ports and result memory.
 * @returns A consumer that refuses missing file metadata or task parameters.
 */
export function createFileOrderConsumer(options: {
  run: FileOrderRuntimeRunner
  ports(taskId: string, attempt: number): FileOrderRuntimePorts
  remember(taskId: string, artifact: EdgeArtifactManifest, elapsedMs: number): void
}): ComputeResidentResultConsumer {
  return { async consume({ execution, workspace, signal }) {
    const fields = execution.task.parameters as Record<string, unknown> | null
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)
      || typeof fields.taskType !== 'string' || typeof fields.inlineInput !== 'string'
      || Buffer.byteLength(fields.inlineInput) < 1 || Buffer.byteLength(fields.inlineInput) > 16 * 1024
      || (fields.taskParams !== undefined && (fields.taskParams === null || typeof fields.taskParams !== 'object'
        || Array.isArray(fields.taskParams) || Object.keys(fields.taskParams).length !== 0))) {
      throw new ComputeError('COMPUTE_FILE_PARAMETERS_INVALID', 422)
    }
    const raw = fields.fileContract as EdgeFileContract
    const contract = parseEdgeFileContract(raw, fields.taskType, raw?.account_id)
    const lifetime = AbortSignal.any([signal, execution.signal])
    lifetime.throwIfAborted()
    const started = Date.now()
    await execution.reportProgress(0, 'started')
    let pending = Promise.resolve()
    let stopped = false
    const timer = setInterval(() => {
      pending = pending.then(async () => {
        if (!stopped && !lifetime.aborted) await execution.reportProgress(0, 'running')
      }).catch(() => undefined)
    }, 5_000)
    timer.unref?.()
    let artifact: EdgeArtifactManifest
    try {
      artifact = await options.run({ taskType: fields.taskType, inlineInput: fields.inlineInput, fileContract: contract,
        ports: options.ports(execution.task.taskId, execution.attempt.attempt), signal: lifetime })
    } finally { stopped = true; clearInterval(timer); await pending }
    lifetime.throwIfAborted()
    if (artifact.schema !== 'artifact.v1' || artifact.account_id !== contract.account_id
      || artifact.size_bytes < 1 || artifact.size_bytes > 16 * 1024) throw new ComputeError('COMPUTE_FILE_RESULT_INVALID', 422)
    const encoded = JSON.stringify(artifact)
    const bytes = Buffer.byteLength(encoded)
    if (bytes > execution.task.maxOutputBytes) throw new ComputeError('COMPUTE_OUTPUT_LIMIT_EXCEEDED', 413)
    await writeFile(join(workspace.path, 'result.json'), encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    options.remember(execution.task.taskId, artifact, Math.max(0, Date.now() - started))
    await execution.reportProgress(1, 'done')
    return { outputs: Object.freeze([{ name: 'result.json', bytes, sha256: createHash('sha256').update(encoded).digest('hex') }]) }
  } }
}
