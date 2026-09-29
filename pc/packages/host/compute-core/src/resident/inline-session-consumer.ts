/**
 * Isolated inline-session result consumer for resident attempts.
 *
 * The consumer writes UTF-8 result bytes into the attempt workspace and
 * remembers them for the Edge `shard_result` frame. It never downloads
 * `code_url`, never opens a model request, and never fabricates success when
 * the injected runner is unavailable.
 */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ComputeError } from '../errors.ts'
import type { ComputeResidentResultConsumer } from './types.ts'

/** Injected isolated runner for one inline UTF-8 assignment. */
export interface IsolatedInlineRunner {
  /**
   * Run one admitted inline assignment.
   * @param input - Task type, inline UTF-8 and the attempt abort signal.
   * @returns UTF-8 text that becomes both `result.txt` and the Edge inline output.
   */
  (input: { taskType: string; inlineInput: string; signal: AbortSignal;
    taskParams?: Readonly<Record<string, unknown>> }): Promise<{ text: string }>
}

/** How often an in-flight attempt restates progress `0` so the platform clock stays fresh. */
const INLINE_PROGRESS_BEAT_MS = 15_000

/** Wiring for {@link createInlineSessionConsumer}. */
export interface InlineSessionConsumerOptions {
  /** Isolated runner; the default implementation refuses without calling a model. */
  readonly run: IsolatedInlineRunner
  /** Stores UTF-8 bytes the Edge result frame must send. */
  readonly rememberResult: (taskId: string, text: string, elapsedMs: number) => void
  /** Optional clock for elapsed-ms; defaults to `Date.now`. */
  readonly clock?: () => number
  /**
   * Interval for liveness frames while the runner is still working.
   * Defaults to 15 seconds. The fraction stays `0` until the result exists.
   */
  readonly progressIntervalMs?: number
}

/**
 * Serial progress sender for one attempt.
 * Liveness frames repeat fraction `0`. A late beat cannot run after `stop`.
 */
function openProgress(
  execution: { reportProgress: (progress: number, phase: string) => void | Promise<void> },
  intervalMs: number | undefined,
): {
  report: (progress: number, phase: string, required: boolean) => Promise<void>
  stop: () => Promise<void>
} {
  const interval = intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs >= 5
    ? intervalMs
    : INLINE_PROGRESS_BEAT_MS
  let stopped = false
  let tail: Promise<void> = Promise.resolve()
  const report = (progress: number, phase: string, required: boolean): Promise<void> => {
    const step = tail.then(async () => {
      if (stopped && !required) return
      await execution.reportProgress(progress, phase)
    })
    tail = step.then(() => undefined, () => undefined)
    return step
  }
  const timer = setInterval(() => {
    void report(0, 'working', false).catch(() => {
      // A missed liveness frame leaves the attempt running; the next beat retries.
    })
  }, interval)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
  return {
    report,
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await tail
    },
  }
}

/**
 * Return a runner that refuses without calling a model or inventing output.
 * @returns An isolated runner that always throws `COMPUTE_ISOLATED_SESSION_UNAVAILABLE`.
 */
export function unavailableIsolatedInlineRunner(): IsolatedInlineRunner {
  return async () => {
    throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
  }
}

/**
 * Build a result consumer that runs one isolated inline assignment and remembers UTF-8 bytes.
 * @param options - Isolated runner, result memory and optional clock.
 * @returns A resident result consumer.
 */
export function createInlineSessionConsumer(options: InlineSessionConsumerOptions): ComputeResidentResultConsumer {
  const clock = options.clock ?? Date.now
  return {
    consume: async ({ execution, workspace, signal }) => {
      if (signal.aborted || execution.signal.aborted) throw new ComputeError('COMPUTE_INLINE_SESSION_ABORTED', 499)
      const parameters = execution.task.parameters
      if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
        throw new ComputeError('COMPUTE_INLINE_PARAMETERS_INVALID')
      }
      const fields = parameters as Record<string, unknown>
      if (typeof fields.inlineInput !== 'string' || typeof fields.taskType !== 'string') {
        throw new ComputeError('COMPUTE_INLINE_PARAMETERS_INVALID')
      }
      if (fields.taskParams !== undefined && (fields.taskParams === null
        || typeof fields.taskParams !== 'object' || Array.isArray(fields.taskParams))) {
        throw new ComputeError('COMPUTE_INLINE_PARAMETERS_INVALID')
      }
      const started = clock()
      const progress = openProgress(execution, options.progressIntervalMs)
      let result: { text: string }
      try {
        await progress.report(0, 'started', true)
        result = await options.run({
          taskType: fields.taskType,
          inlineInput: fields.inlineInput,
          signal: execution.signal,
          ...(fields.taskParams === undefined ? {} : {
            taskParams: fields.taskParams as Readonly<Record<string, unknown>>,
          }),
        })
      } finally {
        await progress.stop()
      }
      if (result === null || typeof result !== 'object' || typeof result.text !== 'string') {
        throw new ComputeError('COMPUTE_INLINE_RESULT_INVALID')
      }
      const bytes = Buffer.byteLength(result.text)
      if (bytes > execution.task.maxOutputBytes) throw new ComputeError('COMPUTE_OUTPUT_LIMIT_EXCEEDED', 413)
      const elapsedMs = Math.max(0, clock() - started)
      await writeFile(join(workspace.path, 'result.txt'), result.text, 'utf8')
      const sha256 = createHash('sha256').update(result.text, 'utf8').digest('hex')
      options.rememberResult(execution.task.taskId, result.text, elapsedMs)
      await progress.report(1, 'done', true)
      return { outputs: Object.freeze([{ name: 'result.txt', bytes, sha256 }]) }
    },
  }
}
