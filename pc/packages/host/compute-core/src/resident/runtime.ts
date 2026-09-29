/**
 * Resident work loop for a contributing node.
 *
 * Assembled from the already-landed parts, none of which is reimplemented here:
 * - `ResidentTaskLoop` serializes one tick and publishes the heartbeat;
 * - `scheduler.decideSchedulerCycle` / `contributor-policy.decideContribution` decide
 *   inside the control-plane port's coordinator;
 * - `EmployeeTaskCoordinator` (behind the port) performs the atomic task-store admission;
 * - `ContributionController` (behind the port) gates capabilities, binds the lease and
 *   writes decisions;
 * - `ComputeLocalTaskRunner` (behind the workspace provider) stages, executes and
 *   verifies local work.
 *
 * Everything the loop cannot own is injected: session connector, control-plane
 * port, resource observer, workspace provider and result consumer. Nothing here
 * opens a socket, reads a credential, pays, settles, or asks a human to approve
 * an offer.
 */
import { ComputeError } from '../errors.ts'
import type { VerifiedEmployeeTaskOffer } from '../employee-task-coordinator.ts'
import { createResidentHeartbeat, ResidentTaskLoop } from '../resident-loop.ts'
import type { ContributorPolicy } from '../contributor-policy.ts'
import type { SchedulerAction } from '../scheduler.ts'
import type { ComputeProgressReporter } from '../executor.ts'
import type { NodeHeartbeatMessage, NodeTaskOfferMessage, NodeTaskProgressMessage } from '../node-protocol.ts'
import type { ComputeTaskState } from '../task-state.ts'
import { admitResidentOffer } from './admission.ts'
import { classifyResidentFailure, resolveResidentFailureTransition } from './failure.ts'
import type {
  ComputeResidentWorkspace,
  ComputeResidentAttemptExecution,
  ResidentAttempt,
  ResidentInFlightAttempt,
  ResidentAttemptFailure,
  ResidentAttemptRecord,
  ResidentControlPort,
  ResidentLifecycleState,
  ResidentOfferCandidate,
  ResidentOfferOutcome,
  ResidentResourceObservation,
  ResidentRuntime,
  ResidentRuntimeConfig,
  ResidentDecisionEvent,
  ResidentSession,
  ResidentStopReceipt,
  ResidentTaskEvent,
  ResidentTickOutcome,
} from './types.ts'
import { RESIDENT_CONTRIBUTOR_CONTRACT_VERSION } from './types.ts'

/** Default grace period `stop()` waits for in-flight attempts to reach a recorded terminal state. */
const DEFAULT_STOP_TIMEOUT_MS = 30_000
/** Default bound on raw offers buffered before the tick admits them. */
const DEFAULT_MAX_PENDING_OFFERS = 64
/** Default interval between drain checks while `stop()` waits for in-flight attempts. */
const DEFAULT_DRAIN_STEP_MS = 25
const MAX_TIMER_MS = 2_147_483_647

interface AttemptRuntime {
  binding: ResidentAttempt
  envelope: VerifiedEmployeeTaskOffer['envelope']
  dataSource: unknown
  controller: AbortController
  progress: number
  sequence: number
  startedAt: string
}

/**
 * Owns the resident lifecycle: connect, tick, admit, execute, return, drain.
 */
export class ResidentNodeRuntime implements ResidentRuntime {
  /** Provider-issued node identity; used for lease binding and decision reporting only. */
  readonly nodeId: string

  private readonly clockNow: () => number
  private readonly stopTimeoutMs: number
  private readonly maxPendingOffers: number
  private readonly keepExpiredQueuedAttempts: boolean
  private readonly drainStepMs: number
  private readonly config: ResidentRuntimeConfig
  private readonly candidates = new Map<string, ResidentOfferCandidate>()
  private readonly attempts = new Map<string, AttemptRuntime>()
  private readonly records = new Map<string, ResidentAttemptRecord>()
  private policyValue: ContributorPolicy
  private lifecycle: ResidentLifecycleState = 'IDLE'
  private session: ResidentSession | null = null
  private loop: ResidentTaskLoop | null = null
  private stopController: AbortController | null = null
  private offDisconnect: (() => void) | null = null
  private observed: ResidentResourceObservation | null = null
  /** Candidates the current tick handed to the loop; null outside a tick. */
  private dispatching: Map<string, ResidentOfferCandidate> | null = null
  /** Admission outcomes of the current tick; null outside a tick. */
  private dispatchOutcomes: Map<string, ResidentOfferOutcome> | null = null
  private stopping: Promise<ResidentStopReceipt> | null = null
  /** A requested Hello refresh blocks new admission until the old session is replaced. */
  private refreshRequested = false
  private refreshing: Promise<void> | null = null
  private activeTicks = 0

  /**
   * Construct a runtime without touching the network, the filesystem or the store file.
   * @param config - Explicit local policy, capabilities and injected seams.
   */
  constructor(config: ResidentRuntimeConfig) {
    this.config = config
    this.nodeId = identity(config.nodeId, 'COMPUTE_RESIDENT_NODE_ID_INVALID')
    identity(config.agentVersion, 'COMPUTE_RESIDENT_AGENT_VERSION_INVALID')
    for (const [seam, method, code] of [
      [config.observer, 'snapshot', 'COMPUTE_RESIDENT_OBSERVER_INVALID'],
      [config.capabilities, 'listCapabilities', 'COMPUTE_RESIDENT_CAPABILITIES_INVALID'],
      [config.connector, 'connect', 'COMPUTE_RESIDENT_CONNECTOR_INVALID'],
      [config.port, 'verifyOffer', 'COMPUTE_RESIDENT_PORT_INVALID'],
      [config.workspace, 'createWorkspace', 'COMPUTE_RESIDENT_WORKSPACE_INVALID'],
      [config.resultConsumer, 'consume', 'COMPUTE_RESIDENT_CONSUMER_INVALID'],
    ] as const) {
      assertSeam(seam, method, code)
    }
    this.policyValue = Object.freeze({ ...config.policy })
    this.clockNow = config.clock ?? (() => Date.now())
    this.stopTimeoutMs = boundedMs(config.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS)
    this.maxPendingOffers = boundedCount(config.maxPendingOffers, DEFAULT_MAX_PENDING_OFFERS)
    this.keepExpiredQueuedAttempts = config.keepExpiredQueuedAttempts ?? false
    this.drainStepMs = boundedMs(config.drainStepMs, DEFAULT_DRAIN_STEP_MS)
  }

  /** Current durable lifecycle state. */
  state(): ResidentLifecycleState { return this.lifecycle }

  /** Owner's current contribution policy. */
  policy(): ContributorPolicy { return this.policyValue }

  /** Replace the owner's policy; it takes effect on the next tick and next admission. */
  setPolicy(policy: ContributorPolicy): void {
    this.policyValue = Object.freeze({ ...policy })
  }

  /** Number of verified offers buffered for the next tick. */
  pendingOfferCount(): number { return this.candidates.size }

  /** Attempts still owned as in-flight work; zero means every attempt is recorded. */
  inFlightCount(): number { return this.attempts.size }

  /** Attempts whose runner has not returned. Fraction stays at the last reported value. */
  inFlightAttempts(): readonly ResidentInFlightAttempt[] {
    return [...this.attempts.values()].map(runtime => Object.freeze({
      taskId: runtime.binding.taskId,
      attempt: runtime.binding.attempt,
      taskType: taskTypeOf(runtime.envelope.parameters),
      progress: runtime.progress,
      progressEvents: runtime.sequence,
      startedAt: runtime.startedAt,
    }))
  }

  /** Read-only projection of every attempt this runtime has admitted, executed or parked. */
  activeAttempts(): readonly ResidentAttemptRecord[] {
    return [...this.records.values()].map(record => Object.freeze({ ...record }))
  }

  /** Connect one session, bind the control plane and publish the first heartbeat. */
  async start(): Promise<void> {
    if (this.lifecycle === 'RUNNING' || this.lifecycle === 'PAUSED') return
    if (this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED') throw new ComputeError('COMPUTE_RESIDENT_STOPPED', 409)
    this.lifecycle = 'RUNNING'
    await this.connect()
  }

  /** Run exactly one serialized tick: heartbeat, then admit every buffered offer in order. */
  async tickOnce(): Promise<ResidentTickOutcome> {
    // A refresh swaps the socket/Hello; no tick may publish or admit on the old
    // session during that swap. A tick already underway makes refresh defer.
    if (this.refreshing) await this.refreshing
    this.activeTicks += 1
    try { return await this.runTickOnce() }
    finally {
      this.activeTicks -= 1
      this.scheduleRefresh()
    }
  }

  private async runTickOnce(): Promise<ResidentTickOutcome> {
    if (this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED') throw new ComputeError('COMPUTE_RESIDENT_STOPPED', 409)
    if (this.lifecycle === 'IDLE') await this.start()
    // Reconnecting is the driver's decision, never this runtime's: `pause()` + `resume()` is the
    // documented seam (see "does not auto-reconnect or accept work until a new session exists"),
    // so a tick with no session reports that fact instead of silently opening a second socket.
    if (!this.session) throw new ComputeError('COMPUTE_RESIDENT_NOT_CONNECTED', 503)
    const now = this.now()
    this.observed = await this.config.observer.snapshot(this.attempts.size)
    const availableCapabilities = capabilityKeys(this.observed.heartbeat)
    const pending = this.drainPending()
    if (this.lifecycle === 'PAUSED' || this.refreshRequested) {
      // A paused node still proves liveness but never enters the admission path.
      await this.publish(createResidentHeartbeat({ now, snapshot: this.observed.snapshot, availableCapabilities }), 'PAUSED')
      const paused = this.refuse('LIFECYCLE_PAUSED')
      for (const candidate of pending) await this.reportRefusal(candidate, paused)
      return {
        sentHeartbeat: true,
        heartbeatSequence: null,
        runningTasks: this.attempts.size,
        outcomes: pending.map(() => paused),
      }
    }
    this.loop ??= this.openLoop()
    // Hand the loop the exact candidates this tick drained; the loop's effect only
    // reads them synchronously, so an offer is admitted by at most one tick.
    this.dispatching = new Map(pending.map(candidate => [attemptKey(candidate.binding.taskId, candidate.binding.attempt), candidate]))
    this.dispatchOutcomes = new Map()
    let outcomes: ResidentOfferOutcome[]
    try {
      const tick = await this.loop.tick({
        now,
        policy: this.policyValue,
        snapshot: this.observed.snapshot,
        availableCapabilities,
        offers: pending.map(candidate => candidate.offer as VerifiedEmployeeTaskOffer),
      })
      // Mapped while the tick's admission outcomes are still recorded.
      outcomes = tick.outcomes.map((result, index) => this.outcomeFor(result, pending[index]))
    } finally {
      this.dispatching = null
      this.dispatchOutcomes = null
    }
    return { sentHeartbeat: true, heartbeatSequence: null, runningTasks: this.attempts.size, outcomes }
  }

  /** Stop accepting new offers. In-flight attempts continue to completion. */
  pause(): void {
    if (this.lifecycle === 'RUNNING') this.lifecycle = 'PAUSED'
  }

  /** Resume accepting new offers after a pause. */
  async resume(): Promise<void> {
    if (this.lifecycle !== 'PAUSED') return
    this.lifecycle = 'RUNNING'
    if (!this.session) await this.connect()
  }

  /**
   * Refresh the connector's Hello snapshot without interrupting an existing order.
   * Busy attempts keep their current session through return/recording; new offers
   * are refused until the old session is safely replaced. Repeated requests while
   * a replacement is in progress request one more fresh snapshot afterwards.
   */
  async refreshSessionWhenIdle(): Promise<'refreshed' | 'deferred' | 'unavailable'> {
    if (this.lifecycle === 'IDLE' || this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED') {
      return 'unavailable'
    }
    this.refreshRequested = true
    if (this.attempts.size > 0 || this.activeTicks > 0 || this.refreshing) return 'deferred'
    await this.replaceSessionWhenIdle()
    return this.isStopping() ? 'unavailable' : 'refreshed'
  }

  /** Record dispatch-confirmed completion of one returned attempt. */
  async settle(taskId: string, attempt: number, now = this.now()): Promise<ComputeTaskState> {
    const state = await this.config.port.transition(taskId, attempt, { type: 'settle' }, now)
    this.track(state)
    return state
  }

  /**
   * Drain in-flight attempts to a recorded terminal state, then close.
   *
   * In-flight work is never killed silently: the runtime first waits up to
   * `stopTimeoutMs` for each attempt to finish and be recorded. Only attempts
   * still running when the grace period expires are cancelled and recorded as
   * `CANCELLED`, which is never reportable as a returned result.
   * @param reason - Optional diagnostic forwarded to the session close.
   * @returns Whether every attempt was recorded inside the grace period, plus the records.
   */
  stop(reason?: string): Promise<ResidentStopReceipt> {
    if (this.stopping) return this.stopping
    this.refreshRequested = false
    this.lifecycle = 'STOPPING'
    this.stopController?.abort(stopAbortError())
    this.stopping = (async () => {
      const settled = await this.drain(this.stopTimeoutMs)
      for (const [key, attempt] of [...this.attempts]) {
        await this.recordFailure(key, attempt, { code: 'CANCELLED', disposition: 'TERMINAL' })
      }
      for (const _candidate of this.drainPending()) this.refuse('LIFECYCLE_STOPPED')
      this.candidates.clear()
      this.offDisconnect?.()
      this.offDisconnect = null
      const session = this.session
      this.session = null
      try { await session?.close(reason) } catch { /* the peer may already be gone */ }
      const loop = this.loop
      this.loop = null
      await loop?.close().catch(() => { /* queued ticks are already drained above */ })
      this.lifecycle = 'STOPPED'
      return { settled, attempts: this.activeAttempts() }
    })()
    return this.stopping
  }

  private async connect(): Promise<void> {
    if (this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED') throw new ComputeError('COMPUTE_RESIDENT_STOPPED', 409)
    const controller = new AbortController()
    this.stopController = controller
    const session = await this.config.connector.connect(controller.signal)
    if (this.isStopping() || controller.signal.aborted) {
      try { await session.close('stopped') } catch { /* a late connection may already be gone */ }
      throw new ComputeError('COMPUTE_RESIDENT_STOPPED', 409)
    }
    this.session = session
    this.offDisconnect = session.onDisconnect((disconnectReason) => { this.handleDisconnect(session, disconnectReason) })
    session.onOffer(offer => this.receiveOffer(offer))
    this.observed = await this.config.observer.snapshot(this.attempts.size)
    await this.config.port.advertise(this.now())
  }

  /** Start a requested replacement only after no attempt or tick owns the socket. */
  private scheduleRefresh(): void {
    if (!this.refreshRequested || this.refreshing || this.activeTicks > 0 || this.attempts.size > 0) return
    if (this.lifecycle === 'IDLE' || this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED') return
    void this.replaceSessionWhenIdle().catch(() => {
      // A failed replacement leaves the runtime PAUSED with no session. The
      // deployment driver may explicitly resume/reconnect with fresh credentials.
    })
  }

  private async replaceSessionWhenIdle(): Promise<void> {
    if (this.refreshing) return this.refreshing
    if (!this.refreshRequested || this.activeTicks > 0 || this.attempts.size > 0) return
    const replacement = (async () => {
      this.refreshRequested = false
      // Buffered offers belong to the old connection. Refuse them before close;
      // none may be silently carried across a new Hello and executor snapshot.
      for (const candidate of this.drainPending()) {
        await this.reportRefusal(candidate, this.refuse('LIFECYCLE_PAUSED'))
      }
      this.offDisconnect?.()
      this.offDisconnect = null
      const oldSession = this.session
      try { await oldSession?.close('capability-refresh') } catch { /* old peer may already be gone */ }
      if (this.session === oldSession) this.session = null
      const oldLoop = this.loop
      this.loop = null
      await oldLoop?.close().catch(() => {})
      if (this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED') return
      try { await this.connect() }
      catch (error) {
        // A failed Hello must never leave the node apparently RUNNING with no
        // session. The existing driver can explicitly resume on its next turn.
        if (!this.isStopping()) this.lifecycle = 'PAUSED'
        throw error
      }
    })()
    this.refreshing = replacement
    try { await replacement }
    finally {
      if (this.refreshing === replacement) this.refreshing = null
      this.scheduleRefresh()
    }
  }

  private openLoop(): ResidentTaskLoop {
    return new ResidentTaskLoop({
      sendHeartbeat: async (heartbeat) => {
        await this.publish(heartbeat, this.lifecycle === 'PAUSED' ? 'PAUSED' : heartbeat.status)
      },
      coordinate: async (input) => {
        const candidate = this.takeCandidate(input.offer)
        if (!candidate) {
          return {
            decision: { admission: { accepted: false, reason: 'POLICY_DENIED' }, actions: [] },
            action: { type: 'refuse', taskId: input.offer.envelope.taskId, attempt: input.offer.attempt, reason: 'OFFER_INVALID' },
            state: null,
          }
        }
        // A refused or rejected admission is control flow. A throwing port (for
        // example a store that already holds an incompatible record) must become
        // a refusal too, never an exception that abandons the rest of the tick.
        const outcome = await admitResidentOffer(
          {
            candidate,
            now: input.now,
            policy: input.policy,
            snapshot: input.snapshot,
            availableCapabilities: input.availableCapabilities,
          },
          { port: this.config.port, gate: () => this.gate(), keepExpired: this.keepExpiredQueuedAttempts },
        ).catch(() => this.portFailure(candidate))
        // The concrete admission outcome is recorded so the tick can report the
        // exact refusal code instead of a generic fallback.
        this.dispatchOutcomes?.set(attemptKey(candidate.binding.taskId, candidate.binding.attempt), outcome)
        if (outcome.accepted) this.startAttempt(candidate, outcome.state)
        else await this.reportRefusal(candidate, outcome)
        return {
          decision: { admission: { accepted: outcome.accepted, reason: outcome.accepted ? 'READY' : 'POLICY_DENIED' }, actions: [] },
          action: outcome.accepted
            ? {
              type: 'accept',
              taskId: candidate.binding.taskId,
              attempt: candidate.binding.attempt,
              leaseExpiresAt: candidate.binding.leaseExpiresAt,
              envelopeFingerprint: candidate.binding.envelopeFingerprint,
              interactionPolicy: 'autonomous',
              priority: 'main-conversation-first',
            }
            : { type: 'refuse', taskId: candidate.binding.taskId, attempt: candidate.binding.attempt, reason: 'POLICY_DENIED' },
          state: outcome.state,
        }
      },
    })
  }

  /**
   * Tell the deployment session that one delivered offer was refused.
   *
   * Why the runtime reports this at all: a refusal decided by policy (owner is using the machine,
   * resource ceilings, paused lifecycle) used to exist only in this process's projection, so the
   * scheduler kept the shard `DISPATCHED` until its lease expired — escrow held and a user waiting
   * for work that would never run. Reporting is best-effort by design: the seam is optional, and a
   * transport that cannot carry a decision must never turn an admission outcome into a failed tick.
   * @param candidate - The buffered offer this outcome belongs to.
   * @param outcome - The concrete admission outcome, including its stable refusal code.
   */
  private async reportRefusal(candidate: ResidentOfferCandidate, outcome: ResidentOfferOutcome): Promise<void> {
    const session = this.session
    if (session?.sendDecision === undefined) return
    const event: ResidentDecisionEvent = {
      version: RESIDENT_CONTRIBUTOR_CONTRACT_VERSION,
      // The attempt tuple is already unique per delivered offer and is what a reader can join on.
      eventId: attemptKey(candidate.binding.taskId, candidate.binding.attempt),
      nodeId: this.nodeId,
      taskId: candidate.binding.taskId,
      attempt: candidate.binding.attempt,
      decision: 'refused',
      reason: outcome.refusal ?? outcome.reason,
      at: this.now(),
    }
    try { await session.sendDecision(event) } catch { /* the decision stays recorded locally */ }
  }

  private gate(): 'ACCEPT_NEW' | 'PAUSED' | 'STOPPED' {
    if (this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED') return 'STOPPED'
    if (this.lifecycle === 'PAUSED' || this.refreshRequested || this.refreshing) return 'PAUSED'
    return 'ACCEPT_NEW'
  }

  private refuse(reason: 'LIFECYCLE_STOPPED' | 'LIFECYCLE_PAUSED'): ResidentOfferOutcome {
    return { accepted: false, reason, state: null, attempt: null }
  }

  private outcomeFor(
    result: { action: SchedulerAction; state: ComputeTaskState | null },
    candidate: ResidentOfferCandidate | undefined,
  ): ResidentOfferOutcome {
    if (result.action.type === 'accept') {
      return { accepted: true, reason: 'ACCEPTED', state: result.state, attempt: candidate?.binding ?? null }
    }
    // The admission decision is the authority for refusal reasons; the loop's
    // action only carries a coarse code, so it is never used to overwrite it.
    const recorded = candidate
      ? this.dispatchOutcomes?.get(attemptKey(candidate.binding.taskId, candidate.binding.attempt))
      : undefined
    if (recorded) return recorded
    const gate = this.gate()
    if (gate !== 'ACCEPT_NEW') {
      return {
        accepted: false,
        reason: gate === 'PAUSED' ? 'LIFECYCLE_PAUSED' : 'LIFECYCLE_STOPPED',
        refusal: gate === 'PAUSED' ? 'LIFECYCLE_PAUSED' : 'LIFECYCLE_STOPPED',
        state: result.state,
        attempt: candidate?.binding ?? null,
      }
    }
    // Last resort: the loop refused an offer whose candidate the runtime no
    // longer holds, so the loop's own concrete code is the only authority left.
    return {
      accepted: false,
      reason: 'CANDIDATE_REJECTED',
      refusal: result.action.type === 'refuse' ? result.action.reason : 'OFFER_INVALID',
      state: result.state,
      attempt: candidate?.binding ?? null,
    }
  }

  /** Outcome for an admission call that the port rejected outright. */
  private portFailure(candidate: ResidentOfferCandidate): ResidentOfferOutcome {
    return {
      accepted: false,
      reason: 'CANDIDATE_REJECTED',
      refusal: 'COMPUTE_RESIDENT_ADMISSION_REJECTED',
      state: null,
      attempt: candidate.binding,
    }
  }

  private takeCandidate(offer: VerifiedEmployeeTaskOffer): ResidentOfferCandidate | undefined {
    return this.dispatching?.get(attemptKey(offer.envelope.taskId, offer.attempt))
  }

  /** Route one authenticated wire offer through the control-plane port. */
  private async receiveOffer(message: NodeTaskOfferMessage): Promise<void> {
    const verification = await this.config.port.verifyOffer({
      offer: message,
      signature: message.signature,
      traceId: message.envelope.taskId,
    })
    if (!verification.accepted || !verification.candidate) return
    const candidate = verification.candidate
    if (this.refreshRequested || this.refreshing) {
      await this.reportRefusal(candidate, this.refuse('LIFECYCLE_PAUSED'))
      return
    }
    // Every replay reaches admission: the task-store identity check (inside the
    // coordinator) is the single authority that answers DUPLICATE, so dispatch
    // always gets an explicit refusal instead of silence.
    if (this.candidates.size >= this.maxPendingOffers) return
    this.candidates.set(candidate.binding.taskId, candidate)
  }

  private startAttempt(candidate: ResidentOfferCandidate, state: ComputeTaskState | null): void {
    const runtime: AttemptRuntime = {
      binding: candidate.binding,
      envelope: (candidate.offer as VerifiedEmployeeTaskOffer).envelope,
      dataSource: candidate.dataSource,
      controller: new AbortController(),
      progress: 0,
      sequence: 0,
      startedAt: this.now(),
    }
    this.attempts.set(attemptKey(candidate.binding.taskId, candidate.binding.attempt), runtime)
    this.track(state)
    void this.runAttempt(runtime).catch(() => { /* every failure path is recorded inside runAttempt */ })
  }

  private async runAttempt(runtime: AttemptRuntime): Promise<void> {
    const key = attemptKey(runtime.binding.taskId, runtime.binding.attempt)
    try {
      await this.transition(runtime, { type: 'start' })
      const reportProgress: ComputeProgressReporter = async (progress, phase) => {
        runtime.sequence += 1
        runtime.progress = progress
        const message: NodeTaskProgressMessage = {
          type: 'task.progress',
          taskId: runtime.binding.taskId,
          attempt: runtime.binding.attempt,
          sequence: runtime.sequence,
          progress,
          phase,
        }
        const session = this.session
        if (!session) throw new ComputeError('COMPUTE_RESIDENT_NOT_CONNECTED', 503)
        await session.sendProgress(message)
        await this.transition(runtime, { type: 'progress', progress })
      }
      const execution: ComputeResidentAttemptExecution = {
        task: runtime.envelope,
        attempt: runtime.binding,
        signal: runtime.controller.signal,
        reportProgress,
        source: {
          open: async (task, input, signal) => {
            if (this.config.inputSource === undefined) {
              throw new ComputeError('COMPUTE_RESIDENT_INPUT_PROVIDER_REQUIRED', 503)
            }
            return this.config.inputSource.open(execution, task, input, signal)
          },
        },
        dataSource: runtime.dataSource,
      }
      const workspace = await this.config.workspace.createWorkspace(execution)
      let receipt: { outputs: readonly { name: string; bytes: number; sha256: string }[] }
      try {
        this.throwIfAborted(runtime)
        receipt = await this.config.resultConsumer.consume({ execution, workspace, signal: runtime.controller.signal })
        this.throwIfAborted(runtime)
      } finally {
        try { await workspace.close() } catch { /* a failed cleanup must not hide the attempt outcome */ }
      }
      await this.upload(runtime, receipt)
    } catch (error) {
      await this.recordFromThrow(key, runtime, error)
    }
  }

  private async upload(runtime: AttemptRuntime,
    receipt: { outputs: readonly { name: string; bytes: number; sha256: string }[] }): Promise<void> {
    const key = attemptKey(runtime.binding.taskId, runtime.binding.attempt)
    try {
      await this.transition(runtime, { type: 'upload' })
      const session = this.session
      if (!session) throw new ComputeError('COMPUTE_RESIDENT_NOT_CONNECTED', 503)
      await session.sendReturn({
        type: 'task.return',
        taskId: runtime.binding.taskId,
        attempt: runtime.binding.attempt,
        outputs: receipt.outputs,
      })
    } catch (error) {
      await this.recordFromThrow(key, runtime, error, 'UPLOAD_FAILED')
      return
    }
    try {
      await this.transition(runtime, { type: 'return' })
      // Released only after the RETURNED record is durable, so a graceful stop
      // cannot return before the attempt's outcome is written.
      this.attempts.delete(key)
      this.scheduleRefresh()
    } catch (error) {
      await this.recordFromThrow(key, runtime, error, 'RETURN_FAILED')
    }
  }

  private async recordFromThrow(key: string, runtime: AttemptRuntime, error: unknown, stage?: ResidentAttemptFailure['code']): Promise<void> {
    const failure = classifyResidentFailure(error, {
      transportLost: error instanceof Error && error.name === 'ResidentTransportError',
      started: true,
      ...(stage === undefined ? {} : { stage }),
    })
    await this.recordFailure(key, runtime, failure)
  }

  private async recordFailure(key: string, runtime: AttemptRuntime, failure: ResidentAttemptFailure): Promise<void> {
    if (!this.attempts.has(key)) return
    let state: ComputeTaskState | null
    try { state = await this.config.port.state(runtime.binding.taskId, runtime.binding.attempt) } catch { state = null }
    if (state && state.status !== 'RETURNED' && state.status !== 'SETTLED') {
      const transition = resolveResidentFailureTransition(state, failure, this.now())
      if (transition) {
        try {
          const recorded = await this.config.port.transition(runtime.binding.taskId,
            runtime.binding.attempt, transition.event as ResidentTaskEvent, this.now())
          this.track(recorded, failure.code)
          // Released only after the terminal record is durable, so a graceful
          // stop can never return before the attempt's outcome is written.
          this.attempts.delete(key)
          this.scheduleRefresh()
          return
        } catch { /* fall through to a local-only record */ }
      }
    }
    this.attempts.delete(key)
    this.records.set(key, {
      taskId: runtime.binding.taskId,
      attempt: runtime.binding.attempt,
      status: state?.status ?? 'ACCEPTED',
      progress: runtime.progress,
      leaseExpiresAt: runtime.binding.leaseExpiresAt,
      failureCode: failure.code,
      updatedAt: this.now(),
    })
    this.scheduleRefresh()
  }

  private async transition(runtime: AttemptRuntime, event: ResidentTaskEvent): Promise<ComputeTaskState> {
    try {
      const state = await this.config.port.transition(runtime.binding.taskId, runtime.binding.attempt, event, this.now())
      this.track(state)
      return state
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'COMPUTE_TASK_LEASE_EXPIRED') runtime.controller.abort(error)
      throw error
    }
  }

  private track(state: ComputeTaskState | null, failureCode?: ResidentAttemptFailure['code']): void {
    if (!state) return
    const key = attemptKey(state.taskId, state.attempt)
    const previous = this.records.get(key)
    this.records.set(key, {
      taskId: state.taskId,
      attempt: state.attempt,
      status: state.status,
      progress: state.progress,
      leaseExpiresAt: state.leaseExpiresAt,
      failureCode: failureCode ?? previous?.failureCode ?? null,
      updatedAt: state.updatedAt,
    })
  }

  private handleDisconnect(session: ResidentSession, reason?: string): void {
    if (this.session !== session) return
    this.session = null
    this.loop = null
    for (const [key, attempt] of [...this.attempts]) {
      attempt.controller.abort(transportError(reason))
      void this.recordFailure(key, attempt, { code: 'TRANSPORT_LOST', disposition: 'PRESERVED' })
    }
    this.scheduleRefresh()
  }

  private async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.attempts.size > 0 && Date.now() < deadline) await sleep(this.drainStepMs)
    return this.attempts.size === 0
  }

  private throwIfAborted(runtime: AttemptRuntime): void {
    const reason: unknown = runtime.controller.signal.reason
    if (reason === undefined) return
    throw reason instanceof Error ? reason : cancellationError()
  }

  private async publish(
    heartbeat: { now: string; status: 'IDLE' | 'BUSY' | 'PAUSED'; runningTasks: number },
    status: 'IDLE' | 'BUSY' | 'PAUSED',
  ): Promise<void> {
    void heartbeat
    const session = this.session
    if (!session) return
    const observed = this.observed ?? await this.config.observer.snapshot(this.attempts.size)
    const message: NodeHeartbeatMessage = {
      ...observed.heartbeat,
      runningTasks: this.attempts.size,
      capabilities: status === 'PAUSED' ? [] : observed.heartbeat.capabilities,
    }
    await session.sendHeartbeat(message)
  }

  /** Take every candidate received since the previous tick; each is admitted at most once. */
  private drainPending(): ResidentOfferCandidate[] {
    const pending = [...this.candidates.values()]
    this.candidates.clear()
    return pending
  }

  private now(): string { return new Date(this.clockNow()).toISOString() }

  private isStopping(): boolean { return this.lifecycle === 'STOPPING' || this.lifecycle === 'STOPPED' }
}

function capabilityKeys(heartbeat: NodeHeartbeatMessage): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const capability of heartbeat.capabilities) {
    keys.add(`${capability.capabilityId}@${capability.version}@${capability.pluginDigest}`)
  }
  return keys
}

function attemptKey(taskId: string, attempt: number): string { return `${taskId}\u0000${attempt}` }

function taskTypeOf(parameters: unknown): string {
  if (parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)) {
    const taskType = (parameters as { taskType?: unknown }).taskType
    if (typeof taskType === 'string' && taskType !== '') return taskType
  }
  return ''
}

function identity(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw new ComputeError(code)
  return value
}

function boundedMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) throw new ComputeError('COMPUTE_RESIDENT_LIMITS_INVALID')
  return value
}

function boundedCount(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) throw new ComputeError('COMPUTE_RESIDENT_LIMITS_INVALID')
  return value
}

function assertSeam(value: unknown, method: string, code: string): void {
  if (value === null || typeof value !== 'object' || typeof (value as Record<string, unknown>)[method] !== 'function') {
    throw new ComputeError(code)
  }
}

function stopAbortError(): Error {
  const error = new ComputeError('COMPUTE_RESIDENT_STOPPED', 503)
  Object.defineProperty(error, 'name', { value: 'AbortError' })
  return error
}

function transportError(reason?: string): Error {
  const error = new ComputeError('COMPUTE_RESIDENT_TRANSPORT_LOST', 503)
  if (reason !== undefined) error.message = reason
  Object.defineProperty(error, 'name', { value: 'ResidentTransportError' })
  return error
}

function cancellationError(): Error {
  const error = new ComputeError('COMPUTE_CLOSED', 503)
  Object.defineProperty(error, 'name', { value: 'AbortError' })
  return error
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Workspace and port helpers exposed so hosts can type their seams without re-declaring them. */
export type { ComputeResidentWorkspace, ResidentControlPort }
