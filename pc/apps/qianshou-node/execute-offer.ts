/**
 * Built-in node execution reports start and measured duration using the assigned Edge lease.
 *
 * Why this file no longer tokenizes anything itself: it used to carry a second
 * `word_count` implementation that answered with `{counts, total}`. The platform
 * merges the shard payload's `result_lines` (`workload-result.ts:75-83` is the
 * reader side; the shipped document is produced by
 * `resident/isolated-inline-runner.ts`), so that private shape merged to nothing:
 * the task showed DONE and the owner could not open the deliverable. One task
 * type must have one producer, and it must be the one the resident node ships.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createIsolatedInlineRunner,
  hasIsolatedInlineRunner,
  type EdgeResultSent,
  type EdgeTaskOffer,
  type EdgeWorkerPort,
} from '@deepseek-ai/dsh-compute-core'
import { courierAccepts, leaveOffer, runBoundedWorker, tryEnterOffer, verifyArtifactFile } from './offer-roles.ts'

/**
 * The shipped in-process runner: the same `word_count` document the resident node
 * (`node-contributor/src/edge-binding.ts`, `plugin.ts`) sends. Built once per
 * process; without an injected agent, only `word_count` and its `text.transform`
 * alias are runnable — {@link hasIsolatedInlineRunner} is the shared answer to
 * which types those are.
 */
const runIsolated = createIsolatedInlineRunner()

/**
 * Run an admitted inline offer; unsupported inputs are refused before reporting execution.
 *
 * Awaiting the shipped runner is what keeps this development node byte-compatible
 * with the resident node; a refusal still happens before the start frame is sent.
 * @param offer - Parsed offer whose assignment and lease are owned by the connection.
 * @param signal - Connection cancellation; an aborted assignment produces no late result.
 * @param connection - Authenticated transport retaining the original lease credentials.
 * @returns A send receipt on success, or undefined after a reported refusal/failure; failed progress/refusal sends propagate.
 */
export async function executeNodeOffer(
  offer: EdgeTaskOffer,
  signal: AbortSignal,
  connection: Pick<EdgeWorkerPort, 'reportProgress' | 'complete' | 'reject'>,
): Promise<EdgeResultSent | undefined> {
  signal.throwIfAborted()
  if (!hasIsolatedInlineRunner(offer.taskType)) {
    connection.reject(offer, { code: 'EDGE_TASK_SCOPE_DENIED', message: 'Task type has no built-in node executor' })
    return undefined
  }
  if (offer.inputKind !== 'inline' || offer.inlineInput === null || offer.inputRef !== '' || offer.inputRefs.length > 0) {
    connection.reject(offer, { code: 'EDGE_INPUT_UNSUPPORTED', message: 'Built-in node execution requires inline text without file references' })
    return undefined
  }
  if (!tryEnterOffer()) {
    connection.reject(offer, { code: 'EDGE_CONCURRENCY_LIMIT', message: 'This node is already running its one inline offer' })
    return undefined
  }

  const startedAt = performance.now()
  const directory = await mkdtemp(join(tmpdir(), 'qianshou-node-task-'))
  const timeout = AbortSignal.timeout(offer.timeoutSeconds * 1000)
  const scoped = AbortSignal.any([signal, timeout])
  let started = false
  let beat: ReturnType<typeof setInterval> | undefined
  try {
    connection.reportProgress(offer, 0)
    started = true
    beat = setInterval(() => {
      try { connection.reportProgress(offer, 0) }
      catch { /* a missed liveness frame leaves the attempt running; the next beat retries */ }
    }, 15_000)
    if (typeof beat === 'object' && beat !== null && 'unref' in beat) beat.unref()
    const worker = await runBoundedWorker(() => runIsolated({
      taskType: offer.taskType, inlineInput: offer.inlineInput ?? '', signal: scoped,
    }).then(result => result.text))
    if (!worker.claimedOk) {
      connection.reject(offer, { code: 'EDGE_EXECUTION_FAILED', message: 'Built-in node execution or result submission failed' })
      return undefined
    }
    const artifact = join(directory, 'result.txt')
    await writeFile(artifact, worker.text, { mode: 0o600, flag: 'wx' })
    const verdict = await verifyArtifactFile(artifact)
    if (!courierAccepts(verdict, worker.claimedOk)) {
      connection.reject(offer, { code: 'EDGE_VERIFICATION_BLOCKED', message: verdict.code })
      return undefined
    }
    scoped.throwIfAborted()
    const elapsedMs = Math.round(performance.now() - startedAt)
    return connection.complete(offer, { inlineOutputUtf8: worker.text, elapsedMs })
  } catch (error) {
    if (!started) throw error
    signal.throwIfAborted()
    connection.reject(offer, { code: 'EDGE_EXECUTION_FAILED', message: 'Built-in node execution or result submission failed' })
    return undefined
  } finally {
    if (beat !== undefined) clearInterval(beat)
    leaveOffer()
    await rm(directory, { recursive: true, force: true })
  }
}
