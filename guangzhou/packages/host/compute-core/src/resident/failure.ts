/**
 * Failure classification for one local attempt.
 *
 * The loop must never report a failed attempt as a completed one. This module
 * maps an observed failure to a legal local record by *querying* the shared
 * `transitionTask` reducer instead of re-deriving the lifecycle table, and it
 * returns null rather than forcing an illegal step.
 */
import { ComputeError } from '../errors.ts'
import { transitionTask, type ComputeTaskEvent, type ComputeTaskState, type ComputeTaskStatus } from '../task-state.ts'
import type { ResidentAttemptFailure, ResidentFailureCode, ResidentFailureDisposition } from './types.ts'

/** Ordered descent paths used when a lease already forbids normal lifecycle events. */
type ResidentFailureEventType = 'fail' | 'offline' | 'expire'

/** Candidate event paths per failure code, most specific first. */
const FAILURE_PATH: Record<ResidentFailureCode, readonly ResidentFailureEventType[]> = {
  LEASE_EXPIRED: ['expire', 'offline', 'fail'],
  TRANSPORT_LOST: ['offline', 'expire', 'fail'],
  EXECUTION_FAILED: ['fail', 'offline', 'expire'],
  OUTPUT_INVALID: ['fail', 'offline', 'expire'],
  UPLOAD_FAILED: ['fail', 'offline', 'expire'],
  RETURN_FAILED: ['fail', 'offline', 'expire'],
  CANCELLED: ['fail', 'offline', 'expire'],
  UNRECORDED: ['fail', 'offline', 'expire'],
}

/** Status each failure event records when it is legal. */
const EVENT_STATUS: Record<ResidentFailureEventType, ComputeTaskStatus> = {
  fail: 'FAILED',
  offline: 'OFFLINE',
  expire: 'EXPIRED',
}

/**
 * Classify one execution failure without touching durable state.
 * @param error - Failure thrown by the workspace, executor, upload or transport.
 * @param options - Transport loss, whether the local attempt started, and the failure stage.
 * @returns The stable code and the retention needed to avoid a false completion.
 */
export function classifyResidentFailure(
  error: unknown,
  options: { transportLost: boolean; started: boolean; stage?: ResidentFailureCode },
): ResidentAttemptFailure {
  if (options.transportLost) return { code: 'TRANSPORT_LOST', disposition: 'PRESERVED' }
  const code = error instanceof ComputeError ? error.code : ''
  if (code === 'COMPUTE_CLOSED' || code === 'COMPUTE_NODE_SESSION_CLOSED') return { code: 'CANCELLED', disposition: 'TERMINAL' }
  if (code === 'COMPUTE_TASK_LEASE_EXPIRED' || code === 'COMPUTE_NODE_LEASE_EXPIRED') return { code: 'LEASE_EXPIRED', disposition: 'TERMINAL' }
  if (!options.started) return { code: options.stage ?? 'UNRECORDED', disposition: 'PRESERVED' }
  if (code.startsWith('COMPUTE_OUTPUT_') || code === 'COMPUTE_RESULT_INVALID' || code.startsWith('COMPUTE_ASSET_')) {
    return { code: 'OUTPUT_INVALID', disposition: 'TERMINAL' }
  }
  return { code: options.stage ?? 'EXECUTION_FAILED', disposition: 'TERMINAL' }
}

/**
 * Resolve the durable record one classified failure may write.
 * @param state - Current recorded attempt (its lease field feeds the reducer guard).
 * @param failure - Classified failure.
 * @param now - Canonical current UTC timestamp.
 * @returns The event and target status, or null when the current status forbids every step.
 */
export function resolveResidentFailureTransition(
  state: ComputeTaskState,
  failure: ResidentAttemptFailure,
  now: string,
): { event: ComputeTaskEvent; status: ComputeTaskStatus } | null {
  const probe = transitionProbe(state, now)
  for (const event of FAILURE_PATH[failure.code]) {
    if (probe(event)) return { event: eventOf(event), status: EVENT_STATUS[event] }
  }
  return null
}

/**
 * Run one classification branch that may itself fail while still being classified.
 * @param classify - Branch that produces the disposition.
 * @returns The branch outcome, never a caller-fatal error.
 */
export function withResidentDisposition(classify: () => ResidentAttemptFailure): ResidentAttemptFailure {
  try {
    return classify()
  } catch (error) {
    return classifyResidentFailure(error, { transportLost: false, started: true })
  }
}

/**
 * Check whether a lease forbids every lifecycle event except `expire`.
 * @param state - Current recorded attempt.
 * @param now - Canonical current UTC timestamp.
 * @returns True when the lease has passed and only `expire` remains legal.
 */
export function leaseForbidsEvents(state: ComputeTaskState, now: string): boolean {
  return state.leaseExpiresAt !== null && Date.parse(now) > Date.parse(state.leaseExpiresAt)
}

/** Build a reducer parity probe for one attempt at one instant. */
function transitionProbe(state: ComputeTaskState, now: string): (event: ResidentFailureEventType) => boolean {
  return (event) => {
    try {
      transitionTask(state, eventOf(event), now)
      return true
    } catch { return false }
  }
}

/** Event payload for a probe; only the reducer's legality rules are read. */
function eventOf(event: ResidentFailureEventType): ComputeTaskEvent {
  if (event === 'offline') return { type: 'offline' }
  if (event === 'expire') return { type: 'expire' }
  return { type: 'fail' }
}

/** Codes that must never be presented to dispatch as a successful completion. */
export const RESIDENT_FAILURE_CODES: readonly ResidentFailureCode[] = Object.freeze([
  'LEASE_EXPIRED', 'TRANSPORT_LOST', 'EXECUTION_FAILED', 'OUTPUT_INVALID',
  'UPLOAD_FAILED', 'RETURN_FAILED', 'CANCELLED', 'UNRECORDED',
])

/** Every failure disposition is explicit so retention is auditable. */
export const RESIDENT_FAILURE_DISPOSITIONS: readonly ResidentFailureDisposition[] = Object.freeze(['TERMINAL', 'PRESERVED'])
