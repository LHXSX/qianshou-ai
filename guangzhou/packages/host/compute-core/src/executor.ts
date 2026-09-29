/** Agent-owned local execution seam for installable compute capability plugins. */
import { ComputeError } from './errors.ts'
import { ComputeCapabilityId, type ComputeTaskEnvelope } from './protocol.ts'
import { parseTaskEnvelope } from './validation.ts'

/** A bounded input reference staged in the executor's controlled workspace. */
export interface ComputeInputReference {
  name: string
  path: string
  bytes: number
  sha256: string
}

/** A result reference; the caller owns uploading bytes to the artifact service. */
export interface ComputeOutputReference {
  name: string
  path: string
  bytes: number
  sha256: string
}

/** Progress callback exposed to one capability execution. */
export type ComputeProgressReporter = (progress: number, phase: string) => void | Promise<void>

/** Resources granted to a local executor for one task. */
export interface ComputeExecutionContext {
  signal: AbortSignal
  workspacePath: string
  inputs: readonly ComputeInputReference[]
  /** Worker tasks never expose human approval, questions, or steering. */
  interactionPolicy: 'autonomous'
  reportProgress: ComputeProgressReporter
}

/** Result metadata returned by a capability plugin without copying media bytes. */
export interface ComputeExecutionResult {
  outputs: readonly ComputeOutputReference[]
  metadata?: Readonly<Record<string, string>>
}

/** Plugin contribution implemented by a node-provided native capability runner.
 *
 * The host does not ship or infer any concrete model/media capability. A node
 * advertises an exact capability/version only after its own agent has verified
 * the local plugin/runtime and registers the corresponding executor.
 */
export interface ComputeExecutor {
  capabilityId: ComputeCapabilityId
  version: string
  execute(task: ComputeTaskEnvelope, context: ComputeExecutionContext): Promise<ComputeExecutionResult>
}

/** Registry that the unified agent uses to select and run exact plugin versions. */
export class ComputeExecutorRegistry {
  private readonly executors = new Map<string, ComputeExecutor>()

  /** Register one exact capability/version pair and return its disposer.
   * @param executor - Plugin contribution owned by the current agent process.
   * @returns A disposer that removes only this contribution.
   */
  register(executor: ComputeExecutor): () => void {
    if (!identity(executor.version) || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(executor.version)) {
      throw new ComputeError('COMPUTE_EXECUTOR_VERSION_INVALID')
    }
    if (typeof executor.execute !== 'function') throw new ComputeError('COMPUTE_EXECUTOR_INVALID')
    const key = executorKey(executor.capabilityId, executor.version)
    if (this.executors.has(key)) throw new ComputeError('COMPUTE_EXECUTOR_DUPLICATE')
    this.executors.set(key, executor)
    return () => { if (this.executors.get(key) === executor) this.executors.delete(key) }
  }

  /** List installed contributions for capability advertisement.
   * @returns Exact capability/version pairs currently registered.
   */
  list(): readonly Pick<ComputeExecutor, 'capabilityId' | 'version'>[] {
    return [...this.executors.values()].map(({ capabilityId, version }) => ({ capabilityId, version }))
  }

  /** Select an exact version; no implicit fallback or downgrade is permitted.
   * @param capabilityId - Capability identity to resolve.
   * @param version - Exact plugin version to resolve.
   * @returns The matching executor.
   */
  resolve(capabilityId: ComputeCapabilityId, version: string): ComputeExecutor {
    const executor = this.executors.get(executorKey(capabilityId, version))
    if (!executor) throw new ComputeError('COMPUTE_EXECUTOR_UNAVAILABLE', 409)
    return executor
  }

  /** Validate the envelope, select the exact plugin, and run it in the supplied workspace.
   * @param task - Versioned task envelope to execute.
   * @param context - Controlled workspace, inputs, cancellation and progress context.
   * @returns Plugin result metadata after execution and validation.
   */
  async execute(task: ComputeTaskEnvelope, context: ComputeExecutionContext): Promise<ComputeExecutionResult> {
    const admitted = parseTaskEnvelope(task)
    const executor = this.resolve(admitted.capabilityId, admitted.capabilityVersion)
    if ((context as { interactionPolicy?: unknown }).interactionPolicy !== 'autonomous') {
      throw new ComputeError('COMPUTE_HUMAN_INTERACTION_FORBIDDEN', 409)
    }
    if (!context.workspacePath || context.workspacePath.includes('\0')) throw new ComputeError('COMPUTE_WORKSPACE_INVALID')
    context.signal.throwIfAborted()
    let lastProgress = 0
    const reportProgress: ComputeProgressReporter = async (progress, phase) => {
      if (!Number.isFinite(progress) || progress < lastProgress || progress > 1 || !identity(phase)) {
        throw new ComputeError('COMPUTE_PROGRESS_INVALID')
      }
      lastProgress = progress
      await context.reportProgress(progress, phase)
    }
    const result = await executor.execute(admitted, { ...context, reportProgress })
    context.signal.throwIfAborted()
    validateResult(result, admitted.maxOutputBytes)
    return result
  }
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function executorKey(capabilityId: ComputeCapabilityId, version: string): string { return `${capabilityId}\u0000${version}` }

function validateResult(value: unknown, maxOutputBytes: number): asserts value is ComputeExecutionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_RESULT_INVALID')
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.outputs) || result.outputs.length > 256) throw new ComputeError('COMPUTE_RESULT_INVALID')
  let bytes = 0
  const names = new Set<string>()
  for (const value of result.outputs) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_RESULT_INVALID')
    const output = value as Record<string, unknown>
    const outputBytes = output.bytes
    if (!identity(output.name) || typeof output.path !== 'string' || !output.path || output.path.length > 4096 || output.path.includes('\0') || typeof outputBytes !== 'number' || !Number.isSafeInteger(outputBytes) || outputBytes < 0
      || typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(output.sha256)) throw new ComputeError('COMPUTE_RESULT_INVALID')
    if (names.has(output.name)) throw new ComputeError('COMPUTE_RESULT_INVALID')
    names.add(output.name)
    bytes += outputBytes
    if (!Number.isSafeInteger(bytes) || bytes > maxOutputBytes) throw new ComputeError('COMPUTE_OUTPUT_LIMIT_EXCEEDED', 413)
  }
  if (result.metadata !== undefined && (typeof result.metadata !== 'object' || result.metadata === null || Array.isArray(result.metadata))) {
    throw new ComputeError('COMPUTE_RESULT_INVALID')
  }
  if (result.metadata !== undefined) {
    const entries = Object.entries(result.metadata)
    if (entries.length > 64 || entries.some(([key, value]) => !identity(key) || typeof value !== 'string' || value.length > 2048)
      || JSON.stringify(result.metadata).length > 16384) throw new ComputeError('COMPUTE_RESULT_INVALID')
  }
}
