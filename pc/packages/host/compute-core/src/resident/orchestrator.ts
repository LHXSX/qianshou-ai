/**
 * The orchestration layer: one task is decomposed into four roles that may not
 * do each other's job — **Scout → Worker → Verifier → Courier**.
 *
 * Why this module exists (工单 4 of `千手PC算力节点-开发手册.md`, plus C1/C3 of 工单 7):
 * today `onOffer` runs the offer straight through `execute-offer.ts`'s built-in runner, so
 * there is no layer between "the executor ran" and "the result leaves the machine". The
 * measured cost of that shape is in this repository: two `word_count` implementations
 * returned different documents, one of them read as `null` by the real consumer-side reader,
 * and the user paid, saw `DONE` and could not open the deliverable (see
 * `resident/verification.ts`'s header). E5 landed the criterion; this module lands the
 * **role separation that forces the criterion to be applied to every task**.
 *
 * The role boundaries are structural, not conventions:
 *
 * | Role | Does | Cannot, because it has no way to |
 * |---|---|---|
 * | Scout | reads the local environment, returns a **recommendation list** and "can I do this" | declare a capability or open a gate: its report is a value, and the orchestrator never writes advertisement state |
 * | Worker | runs the task in the caller-authorized workspace and returns a **claim** (`reportedSuccess`/`bytes`/`sha256`) | say where the artifact is or that it is good: it never sees the contract, and its claim is carried into the verifier's report as evidence to falsify |
 * | Verifier | reads the artifact **itself** and judges it against the contract via `verifyResidentArtifact` | be replaced by the worker's claim: the only delivery path is `mayDeliverResidentResult(report) === true`, and no other criterion is minted here |
 * | Courier | receives **only** a `passed` report and takes it | be reached on any other verdict: it is called on exactly one branch of this file |
 *
 * Deliberate properties:
 *
 * 1. **不许自证.** {@link mayReleaseOrchestratedResult} is the single terminal gate, and it is
 *    true only when the terminal state is `delivered` *and* the verifier's own report passes
 *    `mayDeliverResidentResult`. `undetermined` is `unknown`, never a pass — mirroring
 *    `isResultAcceptanceObserved` in `edge-worker/polled-verification.ts`.
 * 2. **失败隔离.** No role failure escapes as a rejection: every role call is raced against the
 *    task's wall-clock budget and caught, and the run converges to one explicit terminal state
 *    with a disposition (`settled` / `retryable` / `terminal` / `needs-human` / `unknown`).
 *    Only parameter validation and an over-limit refusal throw, and they throw before any role runs.
 * 3. **有界且保守.** Concurrency, per-task wall clock and queue depth are parameters with
 *    conservative defaults ({@link RESIDENT_ORCHESTRATION_DEFAULT_LIMITS}); over the limit the
 *    run is queued or refused with a stable code — never dropped silently.
 * 4. **可观测.** The result carries a machine-readable trace of **all four steps** (status,
 *    timestamps, artifact reference, verifier verdict, error) plus `unreached`, the steps that
 *    never ran. A trace is never partial.
 *
 * Honesty about the last hop: `delivered` means "the verifier passed this artifact and the
 * courier took it". It is **not** a claim that the platform accepted the result — a local send
 * receipt is not platform acceptance (工单 6). Nothing in this module opens a socket, mints a
 * credential or claims settlement.
 */
import { ComputeError } from '../errors.ts'
import type { ResidentArtifactReference, ResidentVerificationBaseline, ResidentVerificationContract, ResidentVerificationOutcome, ResidentVerificationReport, ResidentArtifactBytesReader } from './verification.ts'
import {
  captureResidentVerificationBaseline,
  mayDeliverResidentResult,
  nodeArtifactBytesReader,
  verifyResidentArtifact,
} from './verification.ts'

/** The four roles, in the only order they may run. */
export const RESIDENT_ORCHESTRATION_STEPS: readonly ResidentOrchestrationStepId[] = Object.freeze([
  'scout', 'worker', 'verifier', 'courier',
] as const)

/** One role in the pipeline. */
export type ResidentOrchestrationStepId = 'scout' | 'worker' | 'verifier' | 'courier'

/**
 * Terminal status of one step.
 * `not-run` means the step never started (an earlier step already decided); the step record
 * still exists, so a missing step is a structural impossibility rather than a convention.
 */
export type ResidentOrchestrationStepStatus = 'not-run' | 'ok' | 'failed' | 'blocked' | 'unknown'

/**
 * Terminal state of one orchestrated task.
 *
 * Every value other than `delivered` is a non-delivery: the artifact did not leave with the
 * verifier's approval. There is deliberately no "probably fine" member.
 */
export type ResidentOrchestrationTerminal =
  /** The verifier passed the artifact and the courier took it. The only deliverable state. */
  | 'delivered'
  /** The scout said this node cannot do the task; refused early, before any execution. */
  | 'scout-refused'
  /** The scout itself failed: whether the node could do the task was never established. */
  | 'scout-failed'
  /** The worker threw, or reported failure. Retryable; never upgraded to a delivery. */
  | 'worker-failed'
  /** The verifier read the artifact and it provably violates the contract. */
  | 'verifier-rejected'
  /** The verifier could not obtain the facts. **Unknown — never a success.** */
  | 'verifier-undetermined'
  /** The facts were obtained but no machine criterion can judge them (e.g. no contract/reader). */
  | 'verifier-needs-human'
  /** The task's wall clock ran out. Unknown unless the verifier had already passed. */
  | 'timed-out'
  /** The artifact was verified but the courier threw or refused: not released, retryable. */
  | 'courier-failed'
  /** An unexpected failure inside the orchestration itself. Unknown. */
  | 'internal-error'

/** What the terminal state permits next. Only `settled` means "nothing more to do". */
export type ResidentOrchestrationDisposition =
  | 'settled'
  | 'retryable'
  | 'terminal'
  | 'needs-human'
  | 'unknown'

/** Artifact reference recorded on a step: what the **verifier** measured, never what a worker claimed. */
export interface ResidentOrchestrationArtifactRef {
  readonly name: string
  readonly bytes: number | null
  readonly sha256: string | null
}

/** The verifier's verdict, as recorded in the trace. */
export interface ResidentOrchestrationVerdict {
  readonly outcome: ResidentVerificationOutcome
  readonly code: ResidentVerificationReport['code']
}

/** Local diagnostic of a failing role; never a stack trace and never upstream content. */
export interface ResidentOrchestrationStepError {
  readonly name: string
  readonly code: string | null
}

/** One step of the trace. Frozen; a verdict is evidence, not a draft. */
export interface ResidentOrchestrationStep {
  readonly id: ResidentOrchestrationStepId
  readonly status: ResidentOrchestrationStepStatus
  readonly detail: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly durationMs: number | null
  readonly artifact: ResidentOrchestrationArtifactRef | null
  readonly verdict: ResidentOrchestrationVerdict | null
  readonly error: ResidentOrchestrationStepError | null
}

/** Result of one orchestrated task. Frozen; it is the audit record the owner can read. */
export interface ResidentOrchestrationResult {
  readonly taskId: string
  readonly attempt: number
  readonly terminal: ResidentOrchestrationTerminal
  readonly disposition: ResidentOrchestrationDisposition
  /** Stable local reason code; see {@link RESIDENT_ORCHESTRATION_REASONS}. */
  readonly reason: string
  /** True only when {@link mayReleaseOrchestratedResult} released the artifact. */
  readonly delivered: boolean
  readonly scout: ResidentScoutReport | null
  /** The verifier's own report, including its `executorClaim` evidence. Null until it ran. */
  readonly verification: ResidentVerificationReport | null
  readonly courier: ResidentCourierReceipt | null
  /** All four steps, in canonical order. */
  readonly trace: readonly ResidentOrchestrationStep[]
  /** Steps whose status is `not-run`, i.e. what a non-delivery rests on. */
  readonly unreached: readonly ResidentOrchestrationStepId[]
  readonly observedAt: string
}

/** One task to orchestrate. Inputs stay opaque to the orchestrator; roles receive them. */
export interface ResidentOrchestrationRequest {
  readonly taskId: string
  readonly attempt: number
  readonly taskType: string
  /** Workspace the caller has already authorized for this attempt; owned by the host. */
  readonly workspacePath: string
  /** Task input, opaque here; forwarded to the scout and the worker. */
  readonly payload?: unknown
}

/** One capability the scout observed. A suggestion: it cannot declare or enable anything. */
export interface ResidentScoutRecommendation {
  readonly capabilityId: string
  /** Whether this node's own probe found the capability usable right now. */
  readonly available: boolean
  /** Local note for the owner; never sent upstream by this module. */
  readonly note: string
}

/** The scout's product: a recommendation list and a local "can I do this" answer. */
export interface ResidentScoutReport {
  /** False refuses the task early, with {@link reason}. The scout decides only this. */
  readonly canRun: boolean
  readonly reason: string
  readonly recommendations: readonly ResidentScoutRecommendation[]
}

/** Input of the scout step. */
export interface ResidentScoutInput {
  readonly request: ResidentOrchestrationRequest
  readonly signal: AbortSignal
}

/** Role 1. Reads the local environment; opens no gate and changes no declaration. */
export interface ResidentOrchestratorScout {
  scout(input: ResidentScoutInput): Promise<ResidentScoutReport>
}

/**
 * Input of the worker step.
 *
 * The worker is told the artifact **name** but never the contract, and it cannot name a
 * location: the verifier reads `workspacePath`/`artifactName` itself, so a worker cannot
 * point the verdict at a file of its choosing.
 */
export interface ResidentWorkInput {
  readonly request: ResidentOrchestrationRequest
  readonly scout: ResidentScoutReport
  readonly workspacePath: string
  readonly artifactName: string
  readonly signal: AbortSignal
}

/**
 * The worker's **claim** about what it produced.
 *
 * There is no `success` field by design: this is evidence handed to the verifier, which
 * falsifies it. `reportedSuccess: false` is authoritative (it can only make things worse).
 */
export interface ResidentWorkReceipt {
  readonly reportedSuccess: boolean
  /** Bytes the worker claims, or null when it claims none. */
  readonly bytes: number | null
  /** sha256 the worker claims, or null when it claims none. */
  readonly sha256: string | null
}

/** Role 2. Runs the task in the authorized workspace; decides nothing and delivers nothing. */
export interface ResidentOrchestratorWorker {
  work(input: ResidentWorkInput): Promise<ResidentWorkReceipt>
}

/** What the courier reports back. `accepted: false` is a refusal, not a delivery. */
export interface ResidentCourierReceipt {
  readonly accepted: boolean
  /** Local transport reference, or null. A local receipt is not platform acceptance. */
  readonly reference: string | null
}

/** Input of the courier step; `report` is guaranteed to have `outcome: 'passed'`. */
export interface ResidentCourierInput {
  readonly request: ResidentOrchestrationRequest
  readonly report: ResidentVerificationReport
  readonly workspacePath: string
  readonly signal: AbortSignal
}

/** Role 4. Transports an already-verified artifact; has no criterion of its own. */
export interface ResidentOrchestratorCourier {
  deliver(input: ResidentCourierInput): Promise<ResidentCourierReceipt>
}

/** Resource ceilings for the whole orchestrator. Every field is explicit so policy is inspectable. */
export interface ResidentOrchestrationLimits {
  /** Tasks allowed to run at once. */
  readonly maxConcurrentTasks: number
  /** Wall-clock budget of one task, covering all four steps. */
  readonly taskTimeoutMs: number
  /** Tasks allowed to wait. Over the limit a run is refused, never dropped. */
  readonly maxQueueDepth: number
}

/**
 * Conservative defaults, chosen to match what this node already is rather than what it could
 * be: the measured baseline advertises one CPU slot, a 1 MiB output ceiling and single
 * concurrency, so the orchestrator starts at one task at a time, a 30 s wall clock and a
 * short queue. Raising these is a deliberate, reviewable edit.
 */
export const RESIDENT_ORCHESTRATION_DEFAULT_LIMITS: ResidentOrchestrationLimits = Object.freeze({
  maxConcurrentTasks: 1,
  taskTimeoutMs: 30_000,
  maxQueueDepth: 4,
})

/** Stable local failure codes thrown before any role runs. */
export const RESIDENT_ORCHESTRATION_FAILURE_CODES = Object.freeze({
  /** The request is not orchestratable (identity, attempt, task type or workspace missing). */
  requestInvalid: 'COMPUTE_ORCHESTRATION_REQUEST_INVALID',
  /** Ceilings are absent, non-integral or out of range. */
  limitsInvalid: 'COMPUTE_ORCHESTRATION_LIMITS_INVALID',
  /** The queue is full: this task was refused explicitly instead of being dropped. */
  queueFull: 'COMPUTE_ORCHESTRATION_QUEUE_FULL',
} as const)

/** Stable reason recorded on every result; one per terminal state. */
export const RESIDENT_ORCHESTRATION_REASONS = Object.freeze({
  delivered: 'RESIDENT_ORCHESTRATION_DELIVERED',
  scoutRefused: 'RESIDENT_ORCHESTRATION_SCOUT_REFUSED',
  scoutFailed: 'RESIDENT_ORCHESTRATION_SCOUT_FAILED',
  workerFailed: 'RESIDENT_ORCHESTRATION_WORKER_FAILED',
  verifierRejected: 'RESIDENT_ORCHESTRATION_VERIFIER_REJECTED',
  verifierUndetermined: 'RESIDENT_ORCHESTRATION_VERIFIER_UNDETERMINED',
  verifierNeedsHuman: 'RESIDENT_ORCHESTRATION_VERIFIER_NEEDS_HUMAN',
  contractMissing: 'RESIDENT_ORCHESTRATION_CONTRACT_MISSING',
  timedOut: 'RESIDENT_ORCHESTRATION_TIMED_OUT',
  courierFailed: 'RESIDENT_ORCHESTRATION_COURIER_FAILED',
  courierRefused: 'RESIDENT_ORCHESTRATION_COURIER_REFUSED',
  internalError: 'RESIDENT_ORCHESTRATION_INTERNAL_ERROR',
} as const)

/** Wiring for {@link createResidentOrchestrator}. */
export interface ResidentOrchestrationOptions {
  readonly scout: ResidentOrchestratorScout
  readonly worker: ResidentOrchestratorWorker
  readonly courier: ResidentOrchestratorCourier
  /**
   * The artifact contract for one request, or null when no criterion exists.
   *
   * Called **before** the worker starts: the contract owns the artifact name, so a run
   * without a contract has no name to produce and is refused rather than half-executed.
   * Returning null refuses the delivery — assuming a contract is the defect this removes.
   */
  readonly contractFor: (request: ResidentOrchestrationRequest) => ResidentVerificationContract | null
  /** Artifact byte source used by the verifier; defaults to the real bytes on disk. */
  readonly artifactReader?: ResidentArtifactBytesReader
  /** Ceilings; omitted fields take {@link RESIDENT_ORCHESTRATION_DEFAULT_LIMITS}. */
  readonly limits?: Partial<ResidentOrchestrationLimits>
  /** Injectable clock for trace timestamps and the wall-clock budget. */
  readonly clock?: () => number
  /** Observer of every settled step. A throwing observer cannot break a run. */
  readonly onStep?: (step: ResidentOrchestrationStep, request: ResidentOrchestrationRequest) => void
}

/** Live occupancy of the orchestrator, for visibility (工单 5's read-only surface reads this). */
export interface ResidentOrchestrationCapacity {
  readonly running: number
  readonly queued: number
  readonly maxConcurrentTasks: number
  readonly maxQueueDepth: number
}

/** The orchestration entry point. */
export interface ResidentOrchestrator {
  /**
   * Orchestrate exactly one task.
   *
   * Resolves for every role failure (see {@link ResidentOrchestrationResult.terminal}).
   * Rejects only for {@link RESIDENT_ORCHESTRATION_FAILURE_CODES}: an unorchestratable
   * request or a full queue — refusals that must be visible to the caller.
   */
  run(request: ResidentOrchestrationRequest): Promise<ResidentOrchestrationResult>
  /** Current occupancy; never a claim about the platform. */
  capacity(): ResidentOrchestrationCapacity
}

/**
 * The single terminal gate.
 *
 * True only when the terminal state is `delivered` **and** the verifier's own report passes
 * `mayDeliverResidentResult` — so a forged result cannot release an artifact that was never
 * judged. `undetermined`, `needs-human` and `failed` are all false, as is a missing report.
 * @param result - Terminal state plus the verifier report (or just its outcome).
 * @returns Whether the artifact may leave the machine.
 */
export function mayReleaseOrchestratedResult(result: {
  readonly terminal: ResidentOrchestrationTerminal
  readonly verification: Pick<ResidentVerificationReport, 'outcome'> | null
}): boolean {
  return result.terminal === 'delivered'
    && result.verification !== null
    && mayDeliverResidentResult(result.verification)
}

/** Mutable step record while a run is in flight; frozen into a {@link ResidentOrchestrationStep} at the end. */
interface StepRecord {
  readonly id: ResidentOrchestrationStepId
  status: ResidentOrchestrationStepStatus
  detail: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  artifact: ResidentOrchestrationArtifactRef | null
  verdict: ResidentOrchestrationVerdict | null
  error: ResidentOrchestrationStepError | null
}

/** Outcome of one role call bounded by the task's remaining wall clock. */
type StepOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'timeout' }

/** One queued task waiting for a slot. */
interface QueuedRun {
  readonly request: ResidentOrchestrationRequest
  readonly resolve: (result: ResidentOrchestrationResult) => void
  readonly reject: (error: unknown) => void
}

/**
 * Create one orchestrator.
 * @param options - The three role seams, the contract lookup, ceilings, clock and observer.
 * @returns An orchestrator whose `run` never rejects for a role failure.
 */
export function createResidentOrchestrator(options: ResidentOrchestrationOptions): ResidentOrchestrator {
  const clock = options.clock ?? Date.now
  const artifactReader = options.artifactReader ?? nodeArtifactBytesReader
  const limits = resolveLimits(options.limits)
  const queue: QueuedRun[] = []
  let running = 0

  const capacity = (): ResidentOrchestrationCapacity => Object.freeze({
    running, queued: queue.length, maxConcurrentTasks: limits.maxConcurrentTasks, maxQueueDepth: limits.maxQueueDepth,
  })

  /** Give a finished task's slot to the next waiter, if any. */
  const release = (): void => {
    running -= 1
    const next = queue.shift()
    if (next === undefined) return
    running += 1
    // `execute` never rejects; the catch keeps a broken seam from wedging the queue forever.
    void execute(next.request).then(next.resolve, next.reject).finally(release)
  }

  const admit = (request: ResidentOrchestrationRequest): Promise<ResidentOrchestrationResult> => {
    if (running < limits.maxConcurrentTasks) {
      running += 1
      return execute(request).finally(release)
    }
    if (queue.length >= limits.maxQueueDepth) {
      throw new ComputeError(
        RESIDENT_ORCHESTRATION_FAILURE_CODES.queueFull, 429,
        `${running} running, ${queue.length} queued, depth ${limits.maxQueueDepth}`,
      )
    }
    return new Promise<ResidentOrchestrationResult>((resolve, reject) => { queue.push({ request, resolve, reject }) })
  }

  async function execute(request: ResidentOrchestrationRequest): Promise<ResidentOrchestrationResult> {
    const startedMs = clock()
    const deadline = startedMs + limits.taskTimeoutMs
    const observedAt = new Date(startedMs).toISOString()
    const controller = new AbortController()
    const records: StepRecord[] = RESIDENT_ORCHESTRATION_STEPS.map(id => ({
      id, status: 'not-run' as const, detail: 'never reached', startedAt: null, finishedAt: null,
      durationMs: null, artifact: null, verdict: null, error: null,
    }))
    const step = (id: ResidentOrchestrationStepId): StepRecord => {
      const found = records.find(record => record.id === id)
      if (found === undefined) throw new ComputeError(RESIDENT_ORCHESTRATION_FAILURE_CODES.limitsInvalid, 500, `unknown step ${id}`)
      return found
    }
    /** The only place a step's timestamps are set, so a trace can never be half-written. */
    const settle = (
      id: ResidentOrchestrationStepId,
      status: ResidentOrchestrationStepStatus,
      detail: string,
      extra: { artifact?: ResidentOrchestrationArtifactRef | null; verdict?: ResidentOrchestrationVerdict | null; error?: ResidentOrchestrationStepError | null } = {},
    ): void => {
      const record = step(id)
      const now = clock()
      record.startedAt = record.startedAt ?? new Date(now).toISOString()
      record.finishedAt = new Date(now).toISOString()
      record.durationMs = Math.max(0, now - Date.parse(record.startedAt))
      record.status = status
      record.detail = detail
      record.artifact = extra.artifact ?? null
      record.verdict = extra.verdict ?? null
      record.error = extra.error ?? null
      try {
        options.onStep?.(freezeStep(record), request)
      } catch { /* 观察者不许拖垮主流程 */ }
    }
    const remaining = (): number => deadline - clock()
    /** Wall clock exhausted: stop cooperative roles and let the caller converge to a timeout. */
    const expire = (): void => { controller.abort() }

    const finalize = (input: {
      terminal: ResidentOrchestrationTerminal
      disposition: ResidentOrchestrationDisposition
      reason: string
      scout?: ResidentScoutReport | null
      verification?: ResidentVerificationReport | null
      courier?: ResidentCourierReceipt | null
    }): ResidentOrchestrationResult => {
      const verification = input.verification ?? null
      const trace = Object.freeze(records.map(freezeStep))
      const unreached = Object.freeze(records.filter(record => record.status === 'not-run').map(record => record.id))
      return Object.freeze({
        taskId: request.taskId,
        attempt: request.attempt,
        terminal: input.terminal,
        disposition: input.disposition,
        reason: input.reason,
        // 交付与否只由这一个闸门决定：终态 + Verifier 自己的报告。
        delivered: mayReleaseOrchestratedResult({ terminal: input.terminal, verification }),
        scout: input.scout ?? null,
        verification,
        courier: input.courier ?? null,
        trace,
        unreached,
        observedAt,
      })
    }

    try {
      // ── ① Scout：只出建议，无开闸权 ────────────────────────────────────────────
      const scouted = await raceWithin(remaining(), expire, () => options.scout.scout({ request, signal: controller.signal }))
      if (scouted.kind === 'timeout') {
        settle('scout', 'unknown', 'the scout did not answer before the task deadline')
        return finalize({ terminal: 'timed-out', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.timedOut })
      }
      if (scouted.kind === 'error') {
        settle('scout', 'failed', describeError(scouted.error), { error: stepErrorOf(scouted.error) })
        return finalize({ terminal: 'scout-failed', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.scoutFailed })
      }
      const scout = scouted.value
      if (!isScoutReport(scout)) {
        settle('scout', 'failed', 'the scout returned a report this orchestrator cannot read')
        return finalize({ terminal: 'scout-failed', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.scoutFailed })
      }
      if (!scout.canRun) {
        settle('scout', 'blocked', `the scout refused this task: ${scout.reason}`)
        return finalize({
          terminal: 'scout-refused', disposition: 'terminal', reason: RESIDENT_ORCHESTRATION_REASONS.scoutRefused, scout,
        })
      }
      settle('scout', 'ok', `${scout.recommendations.length} recommendation(s); suggestions only, no declaration or gate was touched`)

      // ── 契约：产物名由契约拥有，先定判据再动手 ─────────────────────────────────
      step('verifier').startedAt = new Date(clock()).toISOString()
      let contract: ResidentVerificationContract | null
      try {
        contract = options.contractFor(request)
      } catch (error) {
        const record = step('verifier')
        record.status = 'failed'
        record.finishedAt = new Date(clock()).toISOString()
        record.detail = `the artifact contract could not be resolved: ${describeError(error)}`
        record.error = stepErrorOf(error)
        return finalize({ terminal: 'internal-error', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.internalError, scout })
      }
      if (contract === null) {
        const record = step('verifier')
        record.status = 'blocked'
        record.finishedAt = new Date(clock()).toISOString()
        record.detail = 'no artifact contract is registered for this task type, so no criterion exists and the worker has no artifact name to produce'
        return finalize({
          terminal: 'verifier-needs-human', disposition: 'needs-human', reason: RESIDENT_ORCHESTRATION_REASONS.contractMissing, scout,
        })
      }
      const reference: ResidentArtifactReference = { workspacePath: request.workspacePath, name: contract.artifactName }
      const baselineRead = await raceWithin(remaining(), expire, async (): Promise<ResidentVerificationBaseline | null> =>
        await captureResidentVerificationBaseline({ reference, artifactReader, clock }))
      if (baselineRead.kind === 'timeout') {
        settle('verifier', 'unknown', 'the pre-claim baseline could not be read before the task deadline')
        return finalize({ terminal: 'timed-out', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.timedOut, scout })
      }
      // A read that failed for any reason other than absence is null, and null refuses acceptance.
      const baseline = baselineRead.kind === 'ok' ? baselineRead.value : null

      // ── ② Worker：在授权工作区里跑；只报claim，不判定、不回传 ────────────────────
      const worked = await raceWithin(remaining(), expire, () => options.worker.work({
        request, scout, workspacePath: request.workspacePath, artifactName: contract.artifactName, signal: controller.signal,
      }))
      if (worked.kind === 'timeout') {
        settle('worker', 'unknown', 'the worker did not answer before the task deadline')
        return finalize({ terminal: 'timed-out', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.timedOut, scout })
      }
      if (worked.kind === 'error') {
        settle('worker', 'failed', describeError(worked.error), { error: stepErrorOf(worked.error) })
        return finalize({
          terminal: 'worker-failed', disposition: 'retryable', reason: RESIDENT_ORCHESTRATION_REASONS.workerFailed, scout,
        })
      }
      const receipt = worked.value
      if (!isWorkReceipt(receipt)) {
        settle('worker', 'failed', 'the worker returned a receipt this orchestrator cannot read')
        return finalize({
          terminal: 'worker-failed', disposition: 'retryable', reason: RESIDENT_ORCHESTRATION_REASONS.workerFailed, scout,
        })
      }
      settle('worker', receipt.reportedSuccess ? 'ok' : 'failed', receipt.reportedSuccess
        ? `the worker claims success (${receipt.bytes ?? 'no'} bytes, ${receipt.sha256 ?? 'no'} sha256) — evidence for the verifier, not a verdict`
        : 'the worker reported failure; the verifier records it and nothing is upgraded to a pass')

      // ── ③ Verifier：自己读产物，按既有契约判定（不另造判据） ─────────────────────
      const verified = await raceWithin(remaining(), expire, () => verifyResidentArtifact({
        reference,
        contract,
        baseline,
        claim: { reportedSuccess: receipt.reportedSuccess, bytes: receipt.bytes, sha256: receipt.sha256 },
        artifactReader,
        workloadId: request.taskId,
        clock,
      }))
      if (verified.kind === 'timeout') {
        settle('verifier', 'unknown', 'the verifier did not finish judging before the task deadline')
        return finalize({ terminal: 'timed-out', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.timedOut, scout })
      }
      if (verified.kind === 'error') {
        // 判据自己塌了：事实没拿到 ⇒ 未知，绝不当成功。
        settle('verifier', 'failed', `the verifier itself failed: ${describeError(verified.error)}`, { error: stepErrorOf(verified.error) })
        return finalize({ terminal: 'internal-error', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.internalError, scout })
      }
      const report = verified.value
      const verdict: ResidentOrchestrationVerdict = { outcome: report.outcome, code: report.code }
      const measured: ResidentOrchestrationArtifactRef = {
        name: report.artifact.name, bytes: report.artifact.bytes, sha256: report.artifact.sha256,
      }
      settle(
        'verifier',
        report.outcome === 'passed' ? 'ok' : report.outcome === 'undetermined' ? 'unknown' : 'blocked',
        `the verifier read the artifact itself: ${report.outcome}/${report.code}; ${report.checks.length} check(s) ran, ${report.unreached.length} never ran`,
        { artifact: measured, verdict },
      )
      // 唯一的交付分支：Verifier 的产物判定是唯一依据（铁律：不许自证）。
      if (!mayDeliverResidentResult(report)) {
        const [terminal, disposition, reason] = nonDeliveryOf(report.outcome)
        return finalize({ terminal, disposition, reason, scout, verification: report })
      }

      // ── ④ Courier：只送已过校验的产物 ─────────────────────────────────────────
      const delivered = await raceWithin(remaining(), expire, () => options.courier.deliver({
        request, report, workspacePath: request.workspacePath, signal: controller.signal,
      }))
      if (delivered.kind === 'timeout') {
        settle('courier', 'unknown', 'the courier did not answer before the task deadline', { artifact: measured })
        return finalize({
          terminal: 'timed-out', disposition: 'retryable', reason: RESIDENT_ORCHESTRATION_REASONS.timedOut, scout, verification: report,
        })
      }
      if (delivered.kind === 'error') {
        settle('courier', 'failed', describeError(delivered.error), { artifact: measured, error: stepErrorOf(delivered.error) })
        return finalize({
          terminal: 'courier-failed', disposition: 'retryable', reason: RESIDENT_ORCHESTRATION_REASONS.courierFailed, scout, verification: report,
        })
      }
      const receiptOfCourier = delivered.value
      if (!isCourierReceipt(receiptOfCourier) || !receiptOfCourier.accepted) {
        settle('courier', 'blocked', 'the courier refused the verified artifact', { artifact: measured })
        return finalize({
          terminal: 'courier-failed', disposition: 'retryable', reason: RESIDENT_ORCHESTRATION_REASONS.courierRefused,
          scout, verification: report, courier: isCourierReceipt(receiptOfCourier) ? receiptOfCourier : null,
        })
      }
      settle('courier', 'ok', 'the verified artifact was handed to the courier; a local receipt is not platform acceptance', { artifact: measured })
      return finalize({
        terminal: 'delivered', disposition: 'settled', reason: RESIDENT_ORCHESTRATION_REASONS.delivered,
        scout, verification: report, courier: receiptOfCourier,
      })
    } catch (error) {
      // 编排层自身的意外：收敛成明确终态，主流程不崩。
      const record = records.find(candidate => candidate.status === 'not-run') ?? records[records.length - 1]
      if (record !== undefined) {
        const now = clock()
        record.startedAt = record.startedAt ?? new Date(now).toISOString()
        record.finishedAt = new Date(now).toISOString()
        record.status = 'failed'
        record.detail = `the orchestration itself failed: ${describeError(error)}`
        record.error = stepErrorOf(error)
      }
      return finalize({ terminal: 'internal-error', disposition: 'unknown', reason: RESIDENT_ORCHESTRATION_REASONS.internalError })
    }
  }

  return {
    run: async (request: ResidentOrchestrationRequest): Promise<ResidentOrchestrationResult> => {
      validateRequest(request)
      return await admit(request)
    },
    capacity,
  }
}

/** Terminal state, disposition and reason for one non-`passed` verdict. */
function nonDeliveryOf(outcome: ResidentVerificationOutcome): readonly [
  ResidentOrchestrationTerminal, ResidentOrchestrationDisposition, string,
] {
  if (outcome === 'undetermined') {
    return ['verifier-undetermined', 'unknown', RESIDENT_ORCHESTRATION_REASONS.verifierUndetermined]
  }
  if (outcome === 'needs-human') {
    return ['verifier-needs-human', 'needs-human', RESIDENT_ORCHESTRATION_REASONS.verifierNeedsHuman]
  }
  return ['verifier-rejected', 'terminal', RESIDENT_ORCHESTRATION_REASONS.verifierRejected]
}

/**
 * Run one role call under the task's remaining wall clock.
 *
 * The timeout branch is the reason a hung role cannot wedge the pipeline: the guard wins the
 * race, the caller converges to `timed-out`, and the cooperative role is told to stop through
 * the aborted signal. A role that ignores its signal cannot keep the slot either — the run has
 * already been decided by the time the abandoned promise settles.
 */
async function raceWithin<T>(remainingMs: number, expire: () => void, run: () => Promise<T>): Promise<StepOutcome<T>> {
  const work = (async (): Promise<StepOutcome<T>> => {
    try {
      return { kind: 'ok', value: await run() }
    } catch (error) {
      return { kind: 'error', error }
    }
  })()
  if (remainingMs <= 0) {
    expire()
    void work.then(() => { /* the abandoned branch is already decided */ })
    return { kind: 'timeout' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<StepOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs)
  })
  const outcome = await Promise.race([work, guard])
  if (timer !== undefined) clearTimeout(timer)
  if (outcome.kind === 'timeout') {
    expire()
    void work.then(() => { /* the abandoned branch is already decided */ })
  }
  return outcome
}

/** Freeze one settled record into the trace element callers read. */
function freezeStep(record: StepRecord): ResidentOrchestrationStep {
  return Object.freeze({
    id: record.id,
    status: record.status,
    detail: record.detail,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    artifact: record.artifact === null ? null : Object.freeze({ ...record.artifact }),
    verdict: record.verdict === null ? null : Object.freeze({ ...record.verdict }),
    error: record.error === null ? null : Object.freeze({ ...record.error }),
  })
}

/** Validate the ceilings; an invalid ceiling is refused rather than silently defaulted. */
function resolveLimits(given: Partial<ResidentOrchestrationLimits> | undefined): ResidentOrchestrationLimits {
  const merged: ResidentOrchestrationLimits = { ...RESIDENT_ORCHESTRATION_DEFAULT_LIMITS, ...(given ?? {}) }
  if (!isPositiveInteger(merged.maxConcurrentTasks) || !isPositiveInteger(merged.taskTimeoutMs) || !isNonNegativeInteger(merged.maxQueueDepth)) {
    throw new ComputeError(
      RESIDENT_ORCHESTRATION_FAILURE_CODES.limitsInvalid, 500,
      `maxConcurrentTasks=${merged.maxConcurrentTasks} taskTimeoutMs=${merged.taskTimeoutMs} maxQueueDepth=${merged.maxQueueDepth}`,
    )
  }
  return Object.freeze(merged)
}

/** Refuse a request the orchestrator could not even start; throws before any role runs. */
function validateRequest(request: ResidentOrchestrationRequest | null | undefined): void {
  const bad = request === null || request === undefined
    || !isBoundedText(request.taskId, 200)
    || !isPositiveInteger(request.attempt)
    || !isBoundedText(request.taskType, 200)
    || !isBoundedText(request.workspacePath, 4_096)
  if (bad) {
    throw new ComputeError(
      RESIDENT_ORCHESTRATION_FAILURE_CODES.requestInvalid, 400,
      'taskId, a positive attempt, taskType and workspacePath are required',
    )
  }
}

/** Whether a value is a non-empty string of at most `max` characters. */
function isBoundedText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

/** Whether a value is a safe integer of at least 1. */
function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Whether a value is a safe integer of at least 0. */
function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Whether a scout's answer is a readable report; an unreadable answer is a scout failure. */
function isScoutReport(value: unknown): value is ResidentScoutReport {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<ResidentScoutReport>
  return typeof candidate.canRun === 'boolean'
    && typeof candidate.reason === 'string'
    && Array.isArray(candidate.recommendations)
}

/** Whether a worker's answer is a readable claim; an unreadable claim is a worker failure. */
function isWorkReceipt(value: unknown): value is ResidentWorkReceipt {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<ResidentWorkReceipt>
  return typeof candidate.reportedSuccess === 'boolean'
    && (candidate.bytes === null || typeof candidate.bytes === 'number')
    && (candidate.sha256 === null || typeof candidate.sha256 === 'string')
}

/** Whether a courier's answer is a readable receipt. */
function isCourierReceipt(value: unknown): value is ResidentCourierReceipt {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<ResidentCourierReceipt>
  return typeof candidate.accepted === 'boolean'
    && (candidate.reference === null || typeof candidate.reference === 'string')
}

/** Local-only diagnostic text; never a stack trace and never upstream content. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.name : 'non-error throw'
}

/** Stable identity of a failing role's error for the trace. */
function stepErrorOf(error: unknown): ResidentOrchestrationStepError {
  if (!(error instanceof Error)) return { name: 'non-error throw', code: null }
  const code = (error as { code?: unknown }).code
  return { name: error.constructor?.name ?? error.name, code: typeof code === 'string' ? code : null }
}
