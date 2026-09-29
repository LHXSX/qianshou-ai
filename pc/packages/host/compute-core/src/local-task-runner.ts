/** Owned staging, execution, result consumption and cleanup for a local capability task. */
import { ComputeError } from './errors.ts'
import { ComputeExecutorRegistry, type ComputeExecutionResult, type ComputeProgressReporter } from './executor.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import { prepareTaskWorkspace, type ComputeTaskInputSource, type ComputeTaskWorkspaceConfig } from './task-workspace.ts'
import { verifyTaskOutputs } from './task-output.ts'
import { parseTaskEnvelope } from './validation.ts'

/** Explicit providers and resource limits for one already-admitted attempt. */
export interface ComputeLocalTaskRequest<T> {
  workspace: ComputeTaskWorkspaceConfig
  source: ComputeTaskInputSource
  signal: AbortSignal
  reportProgress: ComputeProgressReporter
  /** Consume verified files before cleanup, returning a receipt rather than a local path.
   * @param result - Sanitized output references; the transfer provider must enforce its task/lease authorization.
   * @param signal - Task and host-shutdown cancellation.
   * @returns A provider receipt after all reads and uploads have stopped.
   */
  consumeResult(result: ComputeExecutionResult, signal: AbortSignal): Promise<T>
}

/** Own active local attempts so plugin removal cancels and drains every operation. */
export class ComputeLocalTaskRunner {
  private readonly active = new Map<AbortController, Promise<unknown>>()
  private closing: Promise<void> | undefined

  constructor(private readonly executors: ComputeExecutorRegistry) {}

  /** Stage inputs, invoke the exact plugin, verify its files, consume them, and clean up.
   * @param task - Already-admitted immutable assignment; no remote claim is made here.
   * @param request - Host-selected providers, resources and cancellation.
   * @returns The result-consumer receipt after workspace cleanup finishes.
   */
  run<T>(task: ComputeTaskEnvelope, request: ComputeLocalTaskRequest<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, request.signal])
    const operation = Promise.resolve().then(async () => {
      signal.throwIfAborted()
      const admitted = parseTaskEnvelope(task)
      this.executors.resolve(admitted.capabilityId, admitted.capabilityVersion)
      const workspace = await prepareTaskWorkspace(request.workspace, admitted, request.source, signal)
      let receipt: T
      try {
        const result = await this.executors.execute(admitted, { signal, workspacePath: workspace.path, inputs: workspace.inputs, interactionPolicy: 'autonomous', reportProgress: request.reportProgress })
        const verified = await verifyTaskOutputs(workspace.path, result, admitted.maxOutputBytes, signal)
        receipt = await request.consumeResult(verified, signal)
        signal.throwIfAborted()
      } catch (error) {
        try { await workspace.close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'COMPUTE_EXECUTION_AND_CLEANUP_FAILED') }
        throw error
      }
      await workspace.close()
      return receipt
    }).finally(() => { this.active.delete(controller) })
    this.active.set(controller, operation)
    return operation
  }

  /** Abort all attempts and wait for providers, executors and workspace cleanup to finish.
   * @returns When the runner is quiescent; new attempts are rejected permanently.
   */
  close(): Promise<void> {
    if (!this.closing) {
      const operations = [...this.active.values()]
      this.closing = Promise.allSettled(operations).then(() => undefined)
      for (const controller of this.active.keys()) controller.abort(new ComputeError('COMPUTE_CLOSED', 503))
    }
    return this.closing
  }
}
