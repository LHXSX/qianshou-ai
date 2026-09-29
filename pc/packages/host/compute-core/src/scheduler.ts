/** Pure admission loop for autonomous employee-task scheduling.
 *
 * The scheduler decides only. Network transport, signature verification, task-store
 * writes, input staging, execution, upload and settlement remain separate plugins.
 */
import { ComputeError } from './errors.ts'
import { decideContribution, type ContributorDecision, type ContributorDecisionReason, type ContributorPolicy, type ContributorSnapshot } from './contributor-policy.ts'
import { parseTaskEnvelope } from './validation.ts'
import { taskFingerprint } from './envelope-security.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import type { ComputeTaskState } from './task-state.ts'

/** One offer received from a verified dispatch adapter. */
export interface SchedulerOffer {
  envelope: ComputeTaskEnvelope
  attempt: number
  /** Digest selected by dispatch from the node advertisement, when available. */
  capabilityPluginDigest?: string
  /** Lease proposed by the dispatch layer; acceptance must be before this instant. */
  leaseExpiresAt: string
  receivedAt: string
}

/** Stable local reason for declining an offer before execution. */
export type SchedulerRefusalReason =
  | Exclude<ContributorDecisionReason, 'READY'>
  | 'DUPLICATE' | 'DEADLINE_EXPIRED' | 'LEASE_INVALID' | 'INVALID_ENVELOPE'
  | 'CAPABILITY_UNAVAILABLE' | 'OFFER_INVALID' | 'ANCHOR_NOT_CONFIRMED'

/** A side-effect-free action for the transport/store adapter to apply. */
export type SchedulerAction =
  | { type: 'accept'; taskId: string; attempt: number; leaseExpiresAt: string; envelopeFingerprint: string; interactionPolicy: 'autonomous'; priority: 'main-conversation-first' }
  | { type: 'refuse'; taskId: string | null; attempt: number | null; reason: SchedulerRefusalReason }

/** Inputs to one deterministic scheduler tick. */
export interface SchedulerCycleInput {
  now: string
  policy: ContributorPolicy
  snapshot: ContributorSnapshot
  offers: readonly SchedulerOffer[]
  activeTasks: readonly ComputeTaskState[]
  /** Exact capability/version keys advertised by node-local executors. */
  availableCapabilities: ReadonlySet<string>
  /** Digest selected for the current node when the verified offer omits it. */
  capabilityPluginDigest?: string
  /** Explicit upper bound for offers considered during this tick. */
  maxOffers: number
}

/** Decision returned by one scheduler tick; no files, prompts or network calls are touched. */
export interface SchedulerCycleDecision {
  admission: ContributorDecision
  actions: readonly SchedulerAction[]
}

/**
 * Evaluate offers for an idle employee agent. Main conversation work remains the
 * priority because every accepted action is marked autonomous and policy gates
 * user/voice activity before any task is admitted.
 * @param input - Current policy, resource snapshot, offers and active attempts.
 * @returns Side-effect-free admission decision and actions.
 */
export function decideSchedulerCycle(input: SchedulerCycleInput): SchedulerCycleDecision {
  const now = timestamp(input.now)
  if (input.capabilityPluginDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.capabilityPluginDigest)) throw new ComputeError('COMPUTE_CAPABILITY_DIGEST_INVALID')
  if (!Number.isSafeInteger(input.maxOffers) || input.maxOffers < 1 || input.maxOffers > 256) throw new ComputeError('COMPUTE_SCHEDULER_LIMIT_INVALID')
  const admission = decideContribution(input.policy, input.snapshot)
  const actions: SchedulerAction[] = []
  const seen = new Set<string>()
  const existing = new Set(input.activeTasks.map(task => `${task.taskId}\u0000${task.attempt}`))
  const ordered = [...input.offers].slice(0, input.maxOffers)
  // Admission is evaluated against the current snapshot. Reserve one slot per
  // accepted offer so a single cycle cannot exceed the configured concurrency.
  const availableSlots = Math.max(0, input.policy.maxConcurrency - input.snapshot.runningTasks)
  let acceptedCount = 0

  for (const offer of ordered) {
    const identity = offerIdentity(offer)
    if (identity === null) { actions.push({ type: 'refuse', taskId: null, attempt: null, reason: 'OFFER_INVALID' }); continue }
    const [taskId, attempt] = identity
    const key = `${taskId}\u0000${attempt}`
    if (seen.has(key) || existing.has(key)) { actions.push({ type: 'refuse', taskId, attempt, reason: 'DUPLICATE' }); continue }
    seen.add(key)
    let envelope: ComputeTaskEnvelope
    try { envelope = parseTaskEnvelope(offer.envelope) } catch { actions.push({ type: 'refuse', taskId, attempt, reason: 'INVALID_ENVELOPE' }); continue }
    // An anchor task is safe to dispatch only after the owner has confirmed the
    // shared consistency reference. Draft anchors are storable for planning but
    // must fail closed at the scheduler boundary.
    if (envelope.fanOut?.kind === 'anchor' && envelope.anchor?.status !== 'confirmed') {
      actions.push({ type: 'refuse', taskId, attempt, reason: 'ANCHOR_NOT_CONFIRMED' })
      continue
    }
    if (Date.parse(envelope.deadlineAt) <= Date.parse(now)) { actions.push({ type: 'refuse', taskId, attempt, reason: 'DEADLINE_EXPIRED' }); continue }
    if (!validLease(offer.leaseExpiresAt, now, envelope.deadlineAt)) { actions.push({ type: 'refuse', taskId, attempt, reason: 'LEASE_INVALID' }); continue }
    const capabilityKey = `${envelope.capabilityId}@${envelope.capabilityVersion}`
    const digest = offer.capabilityPluginDigest ?? input.capabilityPluginDigest
    // New advertisements use an exact id/version/digest key. Legacy local
    // loops may still expose id/version keys until their node adapter upgrades.
    // Once a digest-backed key exists for a capability, an offer without the
    // selected digest is refused instead of guessing between node versions.
    const digestPrefix = `${capabilityKey}@`
    const hasDigestAdvertisement = [...input.availableCapabilities].some(key => key.startsWith(digestPrefix))
    const capabilityAvailable = digest
      ? input.availableCapabilities.has(`${capabilityKey}@${digest}`)
      : !hasDigestAdvertisement && input.availableCapabilities.has(capabilityKey)
    if (!capabilityAvailable) { actions.push({ type: 'refuse', taskId, attempt, reason: 'CAPABILITY_UNAVAILABLE' }); continue }
    if (!admission.accepted) {
      // `READY` is not a refusal reason; guard the impossible malformed decision
      // defensively so an invalid policy adapter cannot admit by accident.
      const reason: SchedulerRefusalReason = admission.reason === 'READY' ? 'POLICY_DENIED' : admission.reason
      actions.push({ type: 'refuse', taskId, attempt, reason }); continue
    }
    if (acceptedCount >= availableSlots) {
      actions.push({ type: 'refuse', taskId, attempt, reason: 'CONCURRENCY_LIMIT' }); continue
    }
    actions.push({ type: 'accept', taskId, attempt, leaseExpiresAt: offer.leaseExpiresAt, envelopeFingerprint: taskFingerprint(envelope), interactionPolicy: 'autonomous', priority: 'main-conversation-first' })
    acceptedCount++
  }
  return { admission, actions }
}

function offerIdentity(offer: SchedulerOffer): [string, number] | null {
  const raw: unknown = offer
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  if (!Number.isSafeInteger(item.attempt) || (item.attempt as number) < 1 || (item.attempt as number) > 1_000_000
    || typeof item.receivedAt !== 'string' || typeof item.leaseExpiresAt !== 'string') return null
  try { timestamp(item.receivedAt); timestamp(item.leaseExpiresAt) } catch { return null }
  const value = item.envelope
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).taskId !== 'string') return null
  if (item.capabilityPluginDigest !== undefined && (typeof item.capabilityPluginDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.capabilityPluginDigest))) return null
  return [(value as Record<string, unknown>).taskId as string, item.attempt as number]
}

function validLease(lease: string, now: string, deadline: string): boolean {
  return Date.parse(lease) > Date.parse(now) && Date.parse(lease) <= Date.parse(deadline)
}

function timestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
  return value
}
