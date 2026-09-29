/**
 * Control-plane binding for the resident node runtime.
 *
 * `compute-core` defines the resident runtime and the *structural*
 * `ResidentControlPort` it needs. This module is the upper layer that answers
 * that port with the real, already-tested pieces:
 * - `ContributionController` — capability/data-scope gate, policy narrowing,
 *   lease binding, decision and inventory reporting;
 * - `EmployeeTaskCoordinator` — atomic task-store admission;
 * - `ComputeTaskStore` — durable attempt records read back through the port.
 *
 * The dependency direction stays one-way: `node-contributor → compute-core`.
 */
import {
  ComputeError,
  EmployeeTaskCoordinator,
  parseNodeTaskLease,
  verifyTaskAssignment,
  type ComputeTaskSignatureVerifier,
  type ComputeTaskState,
  type ComputeTaskStore,
  type ContributorPolicy,
  type VerifiedEmployeeTaskOffer,
} from '@deepseek-ai/dsh-compute-core'
import { RESIDENT_CONTRIBUTOR_CONTRACT_VERSION } from '@deepseek-ai/dsh-compute-core/resident'
import type {
  ResidentAcceptResult,
  ResidentControlPort,
  ResidentDecisionEvent,
  ResidentEarningsEventReference,
  ResidentOfferCandidate,
  ResidentOfferRequest,
  ResidentOfferVerification,
  ResidentPrecheckInput,
  ResidentPrecheckResult,
  ResidentTaskEvent,
} from '@deepseek-ai/dsh-compute-core/resident'
import { ContributionController, type ContributionCapability, type ContributionTransport } from './index.ts'

/** Owner-side facts the binding needs for one node. */
export interface ResidentControlPortOptions {
  nodeId: string
  agentVersion: string
  policy: ContributorPolicy
  coordinator: EmployeeTaskCoordinator
  store: ComputeTaskStore
  /** Locally self-tested capabilities; the controller re-validates every field. */
  capabilities: () => readonly ContributionCapability[]
  transport: ContributionTransport
  /** Authenticated dispatch key verifier; it owns the key material. */
  verifySignature: ComputeTaskSignatureVerifier
  /** Lease metadata the deployment carried beside the signed offer. */
  leaseOf: (taskId: string, attempt: number, expiresAt: string) => unknown
}

/** Select the locally verified plugin digest from the deployment lease payload, when present. */
function digestOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const digest = (value as Record<string, unknown>).capabilityPluginDigest
  return typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest) ? digest : undefined
}

/** The bound port plus the controller that backs it. */
export interface ResidentControlPortBinding {
  port: ResidentControlPort
  controller: ContributionController
}

/**
 * Bind the resident runtime's control-plane port to the real controller.
 * @param options - Owner policy, capability source, coordinator, store, transport and key verifier.
 * @returns A port implementation plus the controller that backs it.
 */
export function createResidentControlPort(options: ResidentControlPortOptions): ResidentControlPortBinding {
  const controller = new ContributionController({
    nodeId: options.nodeId,
    agentVersion: options.agentVersion,
    policy: options.policy,
    capabilitySource: { listCapabilities: () => options.capabilities() },
    coordinator: options.coordinator,
    transport: options.transport,
  })
  const leaseOf = (taskId: string, attempt: number, expiresAt: string): unknown =>
    options.leaseOf(taskId, attempt, expiresAt)
  const offerOf = (candidate: ResidentOfferCandidate): VerifiedEmployeeTaskOffer => {
    const offer = candidate.offer as VerifiedEmployeeTaskOffer
    if (!offer || typeof offer !== 'object' || !('envelope' in offer)) throw new ComputeError('COMPUTE_RESIDENT_OFFER_INVALID')
    return offer
  }

  const port: ResidentControlPort = {
    verifyOffer: async (request: ResidentOfferRequest): Promise<ResidentOfferVerification> => {
      try {
        const level = leaseOf(request.offer.envelope.taskId, request.offer.attempt, request.offer.leaseExpiresAt)
        // The exact plugin digest is part of the signed assignment value
        // (`assignmentFingerprint`), but the wire frame carries no digest field,
        // so it must be read from the deployment's out-of-band lease payload
        // before the signature can be checked at all.
        const digest = digestOf(level)
        // `receivedAt` is the dispatch-issued timestamp carried on the signed
        // assignment; it is never replaced with a local receive time.
        const credential = await verifyTaskAssignment({
          envelope: request.offer.envelope,
          attempt: request.offer.attempt,
          ...(digest === undefined ? {} : { capabilityPluginDigest: digest }),
          leaseExpiresAt: request.offer.leaseExpiresAt,
          receivedAt: request.offer.receivedAt,
        }, request.signature, options.verifySignature)
        const lease = parseNodeTaskLease(level)
        if (lease.taskId !== credential.envelope.taskId
          || lease.attempt !== credential.attempt
          || lease.expiresAt !== credential.leaseExpiresAt
          || lease.idempotencyKey !== credential.envelope.idempotencyKey) {
          return { accepted: false, code: 'COMPUTE_CONTRIBUTOR_LEASE_BINDING_INVALID' }
        }
        return {
          accepted: true,
          candidate: {
            offer: credential,
            binding: {
              taskId: credential.envelope.taskId,
              attempt: credential.attempt,
              leaseId: lease.leaseId,
              leaseExpiresAt: lease.expiresAt,
              idempotencyKey: lease.idempotencyKey,
              envelopeFingerprint: credential.envelopeFingerprint,
              capabilityId: credential.envelope.capabilityId,
              capabilityVersion: credential.envelope.capabilityVersion,
              // Read from the same out-of-band lease payload that the signature
              // covered. An absent digest stays empty, which makes the scheduler
              // refuse instead of guessing between node versions.
              capabilityPluginDigest: digest ?? '',
            },
            dataSource: { lease: level },
          },
        }
      } catch (error) {
        return { accepted: false, code: error instanceof ComputeError ? error.code : 'COMPUTE_RESIDENT_OFFER_INVALID' }
      }
    },
    advertise: async (now: string): Promise<void> => { await controller.advertise(now) },
    precheck: async (candidate: ResidentOfferCandidate, input: ResidentPrecheckInput): Promise<ResidentPrecheckResult> => {
      // Refusals decided here never reach the controller, so this port reports
      // them itself with the same contract version the controller uses.
      const refuse = async (reason: ResidentPrecheckResult['reason']): Promise<ResidentPrecheckResult> => {
        await options.transport.reportDecision?.({
          version: RESIDENT_CONTRIBUTOR_CONTRACT_VERSION,
          eventId: `refused:${candidate.binding.taskId}:${candidate.binding.attempt}:${input.now}`,
          nodeId: options.nodeId,
          taskId: candidate.binding.taskId,
          attempt: candidate.binding.attempt,
          decision: 'refused',
          reason,
          at: input.now,
        })
        return { accepted: false, reason }
      }
      if (input.policy.mode === 'OFF') return await refuse('CAPABILITY_UNAVAILABLE')
      const envelope = offerOf(candidate).envelope
      const capability = options.capabilities().find(item => item.capabilityId === envelope.capabilityId && item.version === envelope.capabilityVersion)
      if (!capability || !capability.available) return await refuse('CAPABILITY_UNAVAILABLE')
      const inputBytes = envelope.inputRefs.reduce((sum, ref) => sum + ref.bytes, 0)
      if (inputBytes > capability.maxInputBytes
        || envelope.maxOutputBytes > capability.maxOutputBytes
        || (capability.dataScope === 'none' && envelope.inputRefs.length > 0)) {
        return await refuse('DATA_SCOPE_OR_RESOURCE_LIMIT')
      }
      return { accepted: true, reason: 'READY' }
    },
    accept: async (candidate: ResidentOfferCandidate, input: ResidentPrecheckInput): Promise<ResidentAcceptResult> => {
      const result = await controller.acceptOffer({
        offer: offerOf(candidate),
        lease: parseNodeTaskLease(leaseOf(candidate.binding.taskId, candidate.binding.attempt, candidate.binding.leaseExpiresAt)),
        now: input.now,
        policy: input.policy,
        snapshot: input.snapshot,
      })
      if (result.coordination.action.type !== 'accept') {
        return { accepted: false, state: result.coordination.state, reason: result.coordination.action.reason }
      }
      return { accepted: true, state: result.coordination.state }
    },
    reportDecision: async (event: ResidentDecisionEvent): Promise<void> => {
      await options.transport.reportDecision?.(event)
    },
    reportEarnings: async (event: ResidentEarningsEventReference): Promise<void> => {
      // The runtime only forwards a reference the controller already verified as
      // COMPLETED; `ledgerEntry` is validated by the controller's own parser.
      await options.transport.reportEarnings?.(event as never)
    },
    transition: async (taskId: string, attempt: number, event: ResidentTaskEvent, now: string): Promise<ComputeTaskState> => {
      return await options.coordinator.transition(taskId, attempt, event, now)
    },
    state: async (taskId: string, attempt: number): Promise<ComputeTaskState | null> => {
      return await options.store.get(taskId, attempt)
    },
  }
  return { port, controller }
}
