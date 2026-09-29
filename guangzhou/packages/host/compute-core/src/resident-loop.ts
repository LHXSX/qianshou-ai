/**
 * One transport-neutral tick for an autonomous employee agent.
 *
 * The loop is deliberately pull based: a host adapter decides when to call
 * `tick`, while this module sequences resource observation, heartbeat and
 * verified offer admission. It never opens sockets, accepts credentials,
 * loads plugin code or asks a person to approve an offer.
 */
import { ComputeError } from './errors.ts'
import type { ContributorPolicy, ContributorSnapshot } from './contributor-policy.ts'
import type { EmployeeTaskCoordinationResult, EmployeeTaskCoordinateInput, VerifiedEmployeeTaskOffer } from './employee-task-coordinator.ts'

/** Minimal heartbeat payload for a dispatch transport to encode. */
export interface ResidentHeartbeat {
  now: string
  status: 'IDLE' | 'BUSY' | 'PAUSED'
  runningTasks: number
  availableCapabilities: readonly string[]
}

/** Host owned inputs for one resident tick. */
export interface ResidentTickInput {
  now: string
  policy: ContributorPolicy
  availableCapabilities: ReadonlySet<string>
  snapshot: ContributorSnapshot
  offers: readonly VerifiedEmployeeTaskOffer[]
}

/** Side effects supplied by a concrete node adapter. */
export interface ResidentLoopEffects {
  sendHeartbeat(heartbeat: ResidentHeartbeat): Promise<void>
  coordinate(input: EmployeeTaskCoordinateInput): Promise<EmployeeTaskCoordinationResult>
}

/** Result returned after all offers in a tick have been processed in order. */
export interface ResidentTickResult {
  heartbeat: ResidentHeartbeat
  outcomes: readonly EmployeeTaskCoordinationResult[]
}

/** Build a stable heartbeat without exposing credentials or media data. */
export function createResidentHeartbeat(input: Pick<ResidentTickInput, 'now' | 'snapshot' | 'availableCapabilities'>): ResidentHeartbeat {
  timestamp(input.now)
  validateSnapshot(input.snapshot)
  const capabilities = [...input.availableCapabilities].filter(value => typeof value === 'string').sort()
  return Object.freeze({
    now: input.now,
    status: input.snapshot.runningTasks > 0 ? 'BUSY' : 'IDLE',
    runningTasks: input.snapshot.runningTasks,
    availableCapabilities: Object.freeze(capabilities),
  })
}

/**
 * Serialize resident ticks and keep every offer autonomous and deterministic.
 * Resource observation is intentionally outside this class so platform code
 * can use `ContributorResourceObserver` without coupling the transport.
 */
export class ResidentTaskLoop {
  private closed = false
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly effects: ResidentLoopEffects) {}

  tick(input: ResidentTickInput): Promise<ResidentTickResult> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const run = this.tail.then(async () => {
      if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
      const heartbeat = createResidentHeartbeat(input)
      await this.effects.sendHeartbeat(heartbeat)
      const outcomes: EmployeeTaskCoordinationResult[] = []
      for (const offer of input.offers) {
        outcomes.push(await this.effects.coordinate({
          offer,
          now: input.now,
          policy: input.policy,
          snapshot: input.snapshot,
          availableCapabilities: input.availableCapabilities,
        }))
      }
      return { heartbeat, outcomes: Object.freeze(outcomes) }
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  async close(): Promise<void> {
    this.closed = true
    await this.tail
  }
}

function timestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
}

function validateSnapshot(snapshot: ContributorSnapshot): void {
  if (typeof snapshot.userActive !== 'boolean' || typeof snapshot.voiceActive !== 'boolean'
    || !Number.isFinite(snapshot.cpuPercent) || snapshot.cpuPercent < 0 || snapshot.cpuPercent > 100
    || !Number.isFinite(snapshot.gpuPercent) || snapshot.gpuPercent < 0 || snapshot.gpuPercent > 100
    || !Number.isFinite(snapshot.temperatureC) || snapshot.temperatureC < -100 || snapshot.temperatureC > 300
    || !Number.isSafeInteger(snapshot.diskFreeBytes) || snapshot.diskFreeBytes < 0
    || !Number.isSafeInteger(snapshot.runningTasks) || snapshot.runningTasks < 0) throw new ComputeError('COMPUTE_RESOURCE_SNAPSHOT_INVALID', 503)
}
