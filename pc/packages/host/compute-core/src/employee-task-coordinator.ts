/**
 * Local employee-task admission coordinator.
 *
 * This module is the seam between a verified dispatch adapter and the pure
 * scheduler. It owns no network, model, filesystem workspace, prompt, upload,
 * or human-approval behavior. Durable effects are limited to atomic task-store
 * records for accepted attempts and terminal admission refusals.
 */
import { ComputeError } from './errors.ts'
import { isVerifiedTaskAssignment, taskFingerprint, type VerifiedComputeTaskAssignment } from './envelope-security.ts'
import { decideSchedulerCycle, type SchedulerAction, type SchedulerCycleDecision, type SchedulerOffer } from './scheduler.ts'
import type { ContributorPolicy, ContributorSnapshot } from './contributor-policy.ts'
import type { ComputeTaskEvent, ComputeTaskState } from './task-state.ts'
import { ComputeTaskStore } from './task-store.ts'

/** Offer marker produced by an authenticated dispatch adapter after verification. */
export interface VerifiedEmployeeTaskOffer extends SchedulerOffer, VerifiedComputeTaskAssignment {}

/** Inputs that can change between coordinator ticks; no hidden policy defaults. */
export interface EmployeeTaskCoordinateInput {
  offer: VerifiedEmployeeTaskOffer
  now: string
  policy: ContributorPolicy
  snapshot: ContributorSnapshot
  availableCapabilities: ReadonlySet<string>
  capabilityPluginDigest?: string
}

/** One local admission result suitable for a transport adapter to encode. */
export interface EmployeeTaskCoordinationResult {
  decision: SchedulerCycleDecision
  action: SchedulerAction
  /** Accepted local state, or null when the offer was refused. */
  state: ComputeTaskState | null
}

/**
 * Serialize local admission ticks and atomically persist admission outcomes.
 *
 * Calls are serialized per coordinator so a stale active-task snapshot cannot
 * admit two copies in this process. The task store's file lock provides the
 * same invariant across processes. `close()` rejects queued work and drains the
 * currently running operation without touching any transport or executor.
 */
export class EmployeeTaskCoordinator {
  private closed = false
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly store: ComputeTaskStore) {}

  /** Decide and atomically write accepted or terminal-refused local state.
   * @param input - Verified offer and current policy/resource snapshot.
   * @returns Serialized admission decision and any persisted local state.
   */
  coordinate(input: EmployeeTaskCoordinateInput): Promise<EmployeeTaskCoordinationResult> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const run = this.tail.then(async () => {
      if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
      assertVerifiedOffer(input.offer)
      const activeTasks = await this.store.list()
      const decision = decideSchedulerCycle({
        now: input.now,
        policy: input.policy,
        snapshot: input.snapshot,
        offers: [input.offer],
        activeTasks,
        availableCapabilities: input.availableCapabilities,
        ...(input.capabilityPluginDigest === undefined
          ? {}
          : { capabilityPluginDigest: input.capabilityPluginDigest }),
        maxOffers: 1,
      })
      const action = decision.actions[0]
      if (!action) throw new ComputeError('COMPUTE_SCHEDULER_EMPTY', 503)
      const envelope = input.offer.envelope
      if (action.type === 'refuse') {
        // Policy and concurrency refusals are intentionally ephemeral: a
        // later idle tick may accept the same still-valid lease. Terminal
        // validation/capability refusals are recorded to stop replay storms.
        if (action.taskId === null || !terminalRefusal(action.reason)) return { decision, action, state: null }
        const refused: ComputeTaskState = {
          taskId: action.taskId as ComputeTaskState['taskId'],
          attempt: action.attempt as number,
          envelopeFingerprint: taskFingerprint(envelope),
          idempotencyKey: envelope.idempotencyKey,
          status: 'OFFERED',
          leaseExpiresAt: null,
          progress: 0,
          updatedAt: input.now,
        }
        const recorded = await this.store.refuse(refused, action.reason, input.now)
        return { decision, action, state: recorded.state }
      }

      const offered: ComputeTaskState = {
        taskId: action.taskId as ComputeTaskState['taskId'],
        attempt: action.attempt,
        envelopeFingerprint: action.envelopeFingerprint,
        idempotencyKey: envelope.idempotencyKey,
        status: 'OFFERED',
        leaseExpiresAt: null,
        progress: 0,
        updatedAt: input.now,
      }
      try {
        const admitted = await this.store.admit(offered, action.leaseExpiresAt, input.now, { maxConcurrency: input.policy.maxConcurrency })
        return { decision, action, state: admitted.state }
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'COMPUTE_TASK_CONCURRENCY_LIMIT') {
          const refusal: SchedulerAction = { type: 'refuse', taskId: action.taskId, attempt: action.attempt, reason: 'CONCURRENCY_LIMIT' }
          return { decision, action: refusal, state: null }
        }
        throw error
      }
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Reject new ticks and wait for the one currently serialized operation. */
  async close(): Promise<void> {
    this.closed = true
    await this.tail
  }

  /** Apply a user or dispatch lifecycle action through the same task store used for admission. */
  transition(taskId: string, attempt: number, event: ComputeTaskEvent, now: string): Promise<ComputeTaskState> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    return this.store.transition(taskId, attempt, event, now)
  }
}

function terminalRefusal(reason: Exclude<SchedulerAction, { type: 'accept' }>['reason']): boolean {
  return reason === 'DEADLINE_EXPIRED' || reason === 'LEASE_INVALID' || reason === 'INVALID_ENVELOPE' || reason === 'CAPABILITY_UNAVAILABLE' || reason === 'OFFER_INVALID'
}

function assertVerifiedOffer(offer: VerifiedEmployeeTaskOffer): void {
  if (!isVerifiedTaskAssignment(offer)) {
    throw new ComputeError('COMPUTE_TASK_NOT_VERIFIED', 401)
  }
  let computed: string
  try { computed = taskFingerprint(offer.envelope) } catch { throw new ComputeError('COMPUTE_TASK_NOT_VERIFIED', 401) }
  if (computed !== offer.envelopeFingerprint) {
    throw new ComputeError('COMPUTE_TASK_NOT_VERIFIED', 401)
  }
}
