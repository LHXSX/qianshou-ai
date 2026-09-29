/**
 * Polled verification of one submitted shard result against the platform's own record.
 *
 * Why this module exists (C7 N6): `EdgeWorkerConnection.complete` knows only that a
 * `shard_result` frame left this process. The platform sends no acknowledgement frame,
 * so the node used to stay in `sent-awaiting-verification` forever — "回传" and
 * "结算" had no event between them.
 *
 * What it does instead is read the **already-audited** HTTP read side
 * (`GET /api/v8/workloads/{workloadId}` — `supply/edge-api.ts:queryWorkload`, the same
 * projection the catalogue page uses) and compare the workload's shard counters against
 * the counters read **before** the send. It is therefore "轮询核验" and nothing more:
 * no frame was acknowledged, and the read side is per-workload aggregate, so the
 * observation cannot be attributed to one shard. See {@link EdgeResultVerification}.
 *
 * Honesty rules this module is built to keep:
 * - an outcome is `settleable` only when a counter actually moved past the baseline;
 * - an unreadable baseline makes acceptance **impossible** to claim, so the poll is
 *   refused up front rather than degraded into a guess;
 * - `unobservable` / `no-change-within-window` are never success, and every wait is
 *   bounded by both a wall-clock budget and a hard poll cap;
 * - "nothing could be read" is **classified** (工单 6): a terminal `404` ("this workload
 *   does not exist") and a retryable `5xx` ("the platform is broken") are different
 *   answers, and neither of them is acceptance.
 */
import { SupplyError } from '../supply/policy.ts'
import { SupplyHttpError, type SupplyHttpFailureClass } from '../supply/http.ts'
import type { EdgeWorkload } from '../supply/edge-api.ts'
import type {
  EdgeTaskIdentity, PolledVerificationDisposition, PolledVerificationOutcome, WorkloadShardCounters,
} from './types.ts'

/**
 * Machine-readable reason a polled window produced **no** usable projection.
 *
 * The first five members come straight from the transport read side, so the HTTP status
 * (`404` vs `5xx`) survives into the verification conclusion instead of being flattened;
 * the last three are window-local facts. `null` is used on every recorded projection —
 * a class answers "why could nothing be read", never "what was read".
 */
export type PolledVerificationFailureClass = SupplyHttpFailureClass | 'unreadable' | 'no-baseline' | 'aborted'

/**
 * Classes where re-reading the same projection later could still give a different answer.
 *
 * `auth-required` is here because the token provider is consulted per request, so a refresh
 * between polls can legitimately change the outcome. `workload-absent` and `client-rejected`
 * are absent on purpose: those are answers about the request itself, and repeating it verbatim
 * cannot change them.
 */
const RECOVERABLE: ReadonlySet<PolledVerificationFailureClass> = new Set<PolledVerificationFailureClass>([
  'server-fault', 'throttled', 'unreadable', 'auth-required',
])

/**
 * Classes that end the window immediately.
 *
 * A `404` is a **terminal** answer — "this workload does not exist" — so spending the rest of
 * the budget on it would only add polls, not information. This is the behavioural half of
 * "404 是终局、5xx 才是可重试".
 */
const TERMINAL: ReadonlySet<PolledVerificationFailureClass> = new Set<PolledVerificationFailureClass>([
  'workload-absent', 'client-rejected',
])

/** The transport's own class when it has one, else "nothing answered at all". */
function failureClassOfError(error: unknown): PolledVerificationFailureClass {
  return error instanceof SupplyHttpError ? error.failureClass : 'unreadable'
}

/** The authenticated read side. `EdgeSupplyApi` satisfies this structurally; no new endpoint is invented. */
export interface WorkloadStatusReader {
  /** @param id - Platform workload identifier. @param signal - Optional caller cancellation. */
  queryWorkload(id: string, signal?: AbortSignal): Promise<EdgeWorkload>
}

/** Bounded polling policy, plus the two injection points tests need to drive the window. */
export interface PolledVerificationOptions {
  readonly reader: WorkloadStatusReader
  /** The exact tuple the result was sent with; carried through as audit evidence only. */
  readonly identity: EdgeTaskIdentity
  /**
   * Counters read **before** the result was sent, or null when they could not be read.
   *
   * A baseline read after the send cannot distinguish "the platform already counted
   * this shard" from "the platform counted something else", so a missing baseline is
   * refused (see {@link verifySubmittedResult}) instead of being filled in.
   */
  readonly before: WorkloadShardCounters | null
  /** Wall-clock budget for the whole verification. */
  readonly timeoutMs: number
  /** Hard cap on reads, independent of the clock. */
  readonly maxPolls: number
  /** Wait before the first read; the platform needs time to ingest the frame. */
  readonly initialDelayMs: number
  /** Backoff ceiling; each wait doubles from {@link initialDelayMs} up to this value. */
  readonly maxDelayMs: number
  /** Caller cancellation; an aborted verification is reported as a bounded `unobservable`. */
  readonly signal?: AbortSignal
  /** Injectable monotonic-ish clock, so the budget can be driven by tests. */
  readonly now?: () => number
  /** Injectable sleep, so backoff can be observed by tests. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * The verifier's record of one submitted result.
 *
 * Read `attribution` before trusting `outcome`: this read side is aggregate, so even
 * `workload-completed-shard-observed` means "the workload's completed-shard counter
 * advanced", never "the platform confirmed *your* shard".
 */
export interface EdgeResultVerification {
  readonly outcome: PolledVerificationOutcome
  /** Only `settleable` — reachable only from an observed counter movement — may be settled on. */
  readonly disposition: PolledVerificationDisposition
  /** Which read side produced this: the per-workload aggregate projection, not a per-shard one. */
  readonly attribution: 'workload-aggregate-only'
  /** The tuple the result was sent with; recorded so a later per-shard read can be joined onto it. */
  readonly identity: EdgeTaskIdentity
  readonly before: WorkloadShardCounters | null
  /** Last counters read, or null when no read ever produced a usable projection. */
  readonly after: WorkloadShardCounters | null
  /** Reads attempted (successful and failed alike). */
  readonly polls: number
  /** Reads that failed; a non-zero count never turns into success. */
  readonly failedPolls: number
  readonly elapsedMs: number
  /** Stable code for the `unobservable` case, else null. Never an upstream response body. */
  readonly code: string | null
  /** Why nothing could be read, or null whenever a projection actually was read. */
  readonly failureClass: PolledVerificationFailureClass | null
  /**
   * Whether **re-reading the same projection** later could still change this conclusion.
   *
   * Not to be confused with `disposition: 'retryable'`, which is about retrying the *task*
   * after an observed failed shard. This flag is about the *read*: `true` for a transient
   * platform fault or an unread window, `false` for a terminal absence and for every
   * conclusion that was actually observed. It is never a statement about acceptance.
   */
  readonly retryable: boolean
}

/** Outcome-to-disposition mapping; the single place that decides what may follow. */
const DISPOSITION: Record<PolledVerificationOutcome, PolledVerificationDisposition> = {
  'workload-completed-shard-observed': 'settleable',
  'workload-failed-shard-observed': 'retryable',
  'no-change-within-window': 'retained',
  unobservable: 'indeterminate',
}

/**
 * Whether acceptance was actually observed.
 *
 * The reverse-regression gate of this work package: everything that is not an observed
 * counter movement — including `unobservable` and a fully unreadable window — is false.
 * @param verification - Any verification record.
 * @returns True only for an observed workload-level completed-shard movement.
 */
export function isResultAcceptanceObserved(
  verification: Pick<EdgeResultVerification, 'outcome'>,
): boolean {
  return DISPOSITION[verification.outcome] === 'settleable'
}

/**
 * Poll the platform's workload projection until it shows movement past the baseline.
 * @param options - Reader, the pre-send baseline, and the bounded polling policy.
 * @returns The bounded verification record; never a claim the platform did not make.
 */
export async function verifySubmittedResult(options: PolledVerificationOptions): Promise<EdgeResultVerification> {
  const { identity, before, maxPolls, initialDelayMs, maxDelayMs } = options
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
    || !Number.isSafeInteger(maxPolls) || maxPolls < 1
    || !Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0
    || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs
    || identity.workloadId === '') throw new SupplyError('EDGE_VERIFICATION_CONFIG_INVALID')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const startedAt = now()
  const deadline = startedAt + options.timeoutMs
  const base = { attribution: 'workload-aggregate-only' as const, identity, before }
  // Without a pre-send baseline there is nothing to compare against, so no amount of
  // polling could support an acceptance claim. Refuse up front, spend no request, and
  // say why: a fabricated baseline is exactly the failure this work package removes.
  if (before === null) {
    return { ...base, outcome: 'unobservable', disposition: DISPOSITION.unobservable, after: null,
      polls: 0, failedPolls: 0, elapsedMs: 0, code: 'EDGE_VERIFICATION_NO_BASELINE',
      failureClass: 'no-baseline', retryable: false }
  }
  let polls = 0
  let failedPolls = 0
  let delay = initialDelayMs
  let after: WorkloadShardCounters | null = null
  let code: string | null = null
  let failure: PolledVerificationFailureClass | null = null
  while (polls < maxPolls && now() + delay <= deadline) {
    if (options.signal?.aborted) {
      return { ...base, outcome: 'unobservable', disposition: DISPOSITION.unobservable, after,
        polls, failedPolls, elapsedMs: now() - startedAt, code: 'EDGE_VERIFICATION_ABORTED',
        failureClass: 'aborted', retryable: false }
    }
    await sleep(delay)
    delay = Math.min(delay * 2, maxDelayMs)
    polls += 1
    let observed: WorkloadShardCounters
    try {
      const workload = await options.reader.queryWorkload(identity.workloadId, options.signal)
      observed = { completedShards: workload.completedShards, failedShards: workload.failedShards }
    } catch (error) {
      // A read that produced no projection is not evidence about the shard: keep the
      // stable code for the report, keep polling inside the budget, and never let the
      // failure be reinterpreted as an outcome.
      failedPolls += 1
      failure = failureClassOfError(error)
      code = error instanceof SupplyError ? error.code : 'EDGE_VERIFICATION_UNREADABLE'
      // A terminal answer (`404` ≠ `5xx`) ends the window here: more reads cannot change
      // "this workload does not exist", so the budget is not spent pretending otherwise.
      if (TERMINAL.has(failure)) {
        return { ...base, outcome: 'unobservable', disposition: DISPOSITION.unobservable, after,
          polls, failedPolls, elapsedMs: now() - startedAt, code,
          failureClass: failure, retryable: false }
      }
      continue
    }
    code = null
    failure = null
    after = observed
    const movement = classifyMovement(before, observed)
    if (movement !== null) {
      return { ...base, outcome: movement, disposition: DISPOSITION[movement], after,
        polls, failedPolls, elapsedMs: now() - startedAt, code: null,
        failureClass: null, retryable: false }
    }
  }
  // Budget exhausted with no movement. `after === null` means every attempt failed: the
  // window was never observed, which is "unknown", not "not accepted".
  if (after === null) {
    const failureClass = failure ?? 'unreadable'
    return { ...base, outcome: 'unobservable', disposition: DISPOSITION.unobservable, after: null,
      polls, failedPolls, elapsedMs: now() - startedAt, code: code ?? 'EDGE_VERIFICATION_UNREADABLE',
      failureClass, retryable: RECOVERABLE.has(failureClass) }
  }
  return { ...base, outcome: 'no-change-within-window', disposition: DISPOSITION['no-change-within-window'], after,
    polls, failedPolls, elapsedMs: now() - startedAt, code: null,
    // The window closed without movement: not success, but a later read could still see it.
    failureClass: null, retryable: true }
}

/** Compare one reading against the pre-send baseline, or null when nothing moved yet. */
function classifyMovement(
  before: WorkloadShardCounters,
  observed: WorkloadShardCounters,
): PolledVerificationOutcome | null {
  if (observed.completedShards > before.completedShards) return 'workload-completed-shard-observed'
  if (observed.failedShards > before.failedShards) return 'workload-failed-shard-observed'
  return null
}
