/**
 * Local admission for one raw dispatch offer.
 *
 * This module owns two things and nothing else:
 * 1. the *local* lifecycle/lease gate — a paused or stopped node, or a lease that
 *    already died while the offer was queued, is refused before any store write;
 * 2. the ordering of the control-plane port's `precheck` and `accept`.
 *
 * Capability matching, policy narrowing, atomic task-store admission and lease
 * binding all stay in the port implementation (`node-contributor` binds the real
 * `ContributionController` + `EmployeeTaskCoordinator`).
 */
import type { ContributorPolicy, ContributorSnapshot } from '../contributor-policy.ts'
import type { NodeTaskLease } from '../node-lease.ts'
import type { ResidentAttempt, ResidentOfferCandidate, ResidentOfferOutcome, ResidentControlPort } from './types.ts'

/** Reads the current admission gate from the runtime lifecycle. */
export type ResidentAdmissionGate = () => 'ACCEPT_NEW' | 'PAUSED' | 'STOPPED'

/** Inputs for one local admission decision. */
export interface ResidentAdmissionInput {
  candidate: ResidentOfferCandidate
  now: string
  policy: ContributorPolicy
  snapshot: ContributorSnapshot
  availableCapabilities: ReadonlySet<string>
}

/** Options for {@link admitResidentOffer}. */
export interface ResidentAdmissionOptions {
  port: ResidentControlPort
  gate: ResidentAdmissionGate
  /** Whether an expired queued attempt is parked locally for the remote record. */
  keepExpired: boolean
  /** Releases the lease bookkeeping for one refused candidate. */
  release?(leaseId: string): void
}

/**
 * Apply the local gate, then precheck and accept through the control-plane port.
 * @param input - Candidate, current policy, snapshot and advertised capabilities.
 * @param options - Port, lifecycle gate, retention and lease release.
 * @returns The admission outcome; refusals are control flow with a stable reason.
 */
export async function admitResidentOffer(
  input: ResidentAdmissionInput,
  options: ResidentAdmissionOptions,
): Promise<ResidentOfferOutcome> {
  const { candidate } = input
  const gate = options.gate()
  if (gate !== 'ACCEPT_NEW') {
    options.release?.(candidate.binding.leaseId)
    return {
      accepted: false,
      reason: gate === 'PAUSED' ? 'LIFECYCLE_PAUSED' : 'LIFECYCLE_STOPPED',
      state: null,
      attempt: null,
    }
  }
  // A lease that already died while the offer was queued cannot be saved by the
  // machine going idle, so it is decided before the capability/resource gate.
  if (!freshLease(candidate.binding.leaseExpiresAt, input.now)) {
    // A lease that died while queued may never start local work. The attempt is
    // either dropped entirely or parked as a refusal the dispatch layer can read.
    if (!options.keepExpired) {
      options.release?.(candidate.binding.leaseId)
      return { accepted: false, reason: 'LEASE_EXPIRED_BEFORE_START', refusal: 'LEASE_INVALID', state: null, attempt: null }
    }
    const parked = await options.port.accept(candidate, {
      now: input.now,
      policy: input.policy,
      snapshot: input.snapshot,
      availableCapabilities: input.availableCapabilities,
    })
    return {
      accepted: false,
      reason: 'LEASE_EXPIRED_BEFORE_START',
      refusal: parked.reason ?? 'LEASE_INVALID',
      state: parked.state,
      attempt: null,
    }
  }
  const precheck = await options.port.precheck(candidate, {
    now: input.now,
    policy: input.policy,
    snapshot: input.snapshot,
    availableCapabilities: input.availableCapabilities,
  })
  if (!precheck.accepted) {
    options.release?.(candidate.binding.leaseId)
    // The port's concrete code is preserved: `CANDIDATE_REJECTED` alone cannot
    // distinguish "contribution off" from "capability missing" or "disk low".
    return { accepted: false, reason: 'CANDIDATE_REJECTED', refusal: precheck.reason, state: null, attempt: null }
  }
  const admitted = await options.port.accept(candidate, {
    now: input.now,
    policy: input.policy,
    snapshot: input.snapshot,
    availableCapabilities: input.availableCapabilities,
  })
  if (!admitted.accepted) {
    options.release?.(candidate.binding.leaseId)
    return {
      accepted: false,
      reason: 'CANDIDATE_REJECTED',
      refusal: admitted.reason ?? 'OFFER_INVALID',
      state: admitted.state,
      attempt: candidate.binding,
    }
  }
  return { accepted: true, reason: 'ACCEPTED', state: admitted.state, attempt: candidate.binding }
}

/**
 * Build the durable local binding for one bound lease and credential.
 * @param fields - Verified attempt identity facts.
 * @returns A frozen binding the runtime can persist and reconcile against.
 */
export function residentAttemptOf(fields: {
  taskId: string
  attempt: number
  lease: NodeTaskLease
  envelopeFingerprint: string
  capabilityId: string
  capabilityVersion: string
  capabilityPluginDigest: string
}): ResidentAttempt {
  return Object.freeze({
    taskId: fields.taskId,
    attempt: fields.attempt,
    leaseId: fields.lease.leaseId,
    leaseExpiresAt: fields.lease.expiresAt,
    idempotencyKey: fields.lease.idempotencyKey,
    envelopeFingerprint: fields.envelopeFingerprint,
    capabilityId: fields.capabilityId,
    capabilityVersion: fields.capabilityVersion,
    capabilityPluginDigest: fields.capabilityPluginDigest,
  })
}

function freshLease(leaseExpiresAt: string, now: string): boolean {
  return Date.parse(leaseExpiresAt) > Date.parse(now)
}
