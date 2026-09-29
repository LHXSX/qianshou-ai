/**
 * @deepseek-ai/dsh-host-node-contributor — provider-neutral contributor-node controller.
 *
 * The package owns three things:
 * - `index.ts` (this module) — {@link ContributionController}: capability and
 *   data-scope gating, policy narrowing, lease binding and decision reporting;
 * - `resident-port.ts` — the control-plane binding the resident runtime consumes;
 * - `resident-assembly.ts` plus `plugin.ts` — the Cordis plugin entry and its
 *   production assembly point, which construct `ResidentNodeRuntime` in a host.
 */
/** Provider-neutral controller for an explicitly enabled Qianshou contributor node. */
export { discoverLocalMedia, localMediaOrigin, type LocalMediaDiscovery } from './local-media-discovery.ts'
export { MediaNodeChannel, mediaNodeOrigin, type MediaNodeCapability, type MediaNodeHeartbeat,
  type MediaNodeDelivery, type MediaNodeChannelStatus, type MediaNodeChannelOptions } from './media-node-channel.ts'
export { SharingCoordinator, registerSharingRoutes, type SharingCoordinatorOptions } from './sharing-coordinator.ts'
export { SharingRuntime, sharingDownload, sharingHardware } from './sharing-runtime.ts'
export { SharingStore } from './sharing-store.ts'
export type { SharingSnapshot, SharingModeState, SharingMode } from './sharing-types.ts'
export type { MediaNodeExecutionPort } from './media-node-routes.ts'
import {
  ComputeError,
  ComputeCapabilityId,
  EmployeeTaskCoordinator,
  createNodeTaskLeaseState,
  decideContribution,
  isVerifiedTaskAssignment,
  parseNodeTaskLease,
  transitionNodeTaskLease,
  type ContributorPolicy,
  type ContributorSnapshot,
  type EmployeeTaskCoordinationResult,
  type NodeHeartbeatMessage,
  type NodeTaskLease,
  type NodeTaskLeaseState,
  type VerifiedEmployeeTaskOffer,
} from '@deepseek-ai/dsh-compute-core'
import type { ComputeTaskState } from '@deepseek-ai/dsh-compute-core/task-state'
import type { NodeEarningsLedgerEntry } from '@deepseek-ai/dsh-host-billing-contract'
import { parseNodeEarningsLedgerEntry } from '@deepseek-ai/dsh-host-billing-contract'

/** Wire version for contributor-only event references. */
export const CONTRIBUTOR_CONTRACT_VERSION = 'qianshou.node-contributor.v1' as const

/** Lifecycle state projected by a controller; execution remains with the host. */
export type ContributionStatus = 'DISABLED' | 'CHECKING' | 'READY' | 'ADVERTISED' | 'PAUSED' | 'OFFLINE' | 'CLOSED'

/** Minimum local descriptor needed for admission and a redacted heartbeat. */
export interface ContributionCapability {
  capabilityId: string
  version: string
  pluginDigest: string
  /** Input data is already authorized task material; workspace access is never inferred. */
  dataScope: 'none' | 'task-inputs'
  maxInputBytes: number
  maxOutputBytes: number
  available: boolean
}

/** Trusted source of installed, locally self-tested capability descriptors. */
export interface ContributionCapabilitySource {
  listCapabilities(): readonly ContributionCapability[]
}

/** Local facts needed to build a contribution advertisement. */
export interface ContributionInventoryInput {
  nodeId: string
  agentVersion: string
  maxConcurrency: number
  runningTasks: number
  capabilities: readonly ContributionCapability[]
  observedAt: string
}

/** Control-plane report. It contains no paths, credentials, prompts or media bytes. */
export interface ContributionAdvertisement {
  version: typeof CONTRIBUTOR_CONTRACT_VERSION
  nodeId: string
  agentVersion: string
  sentAt: string
  capabilities: readonly { capabilityId: string; version: string; pluginDigest: string }[]
  maxConcurrency: number
  runningTasks: number
  /** Explicit negative guarantees make adapter review mechanical. */
  privacy: { includesUserFiles: false; includesCredentials: false; includesMediaBytes: false }
}

/** Build the minimal node heartbeat from a local inventory. */
export interface ContributionInventory {
  advertisement: ContributionAdvertisement
  heartbeat: NodeHeartbeatMessage
  capabilities: readonly ContributionCapability[]
}

/** Provider-owned control-plane operations; implementations may be local loopback adapters. */
export interface ContributionTransport {
  publishHeartbeat(message: NodeHeartbeatMessage): Promise<void>
  reportDecision?(event: ContributionDecisionEvent): Promise<void>
  reportEarnings?(event: ContributionEarningsEventReference): Promise<void>
}

/** Admission decision emitted without exposing task parameters or input references. */
export interface ContributionDecisionEvent {
  version: typeof CONTRIBUTOR_CONTRACT_VERSION
  eventId: string
  nodeId: string
  taskId: string | null
  attempt: number | null
  decision: 'accepted' | 'refused' | 'paused' | 'revoked'
  reason?: string
  at: string
}

/** Reference to a core-confirmed earnings ledger entry; this does not settle or pay. */
export interface ContributionEarningsEventReference {
  version: typeof CONTRIBUTOR_CONTRACT_VERSION
  eventId: string
  nodeId: string
  taskId: string
  attempt: number
  leaseId: string
  acceptanceEvidenceRef: string
  ledgerEntry: NodeEarningsLedgerEntry
  occurredAt: string
}

/** Inputs to one autonomous offer admission. */
export interface ContributionOfferInput {
  offer: VerifiedEmployeeTaskOffer
  lease: NodeTaskLease
  now: string
  /** Per-offer limits may narrow, but never expand, the owner's configured authorization. */
  policy: ContributorPolicy
  snapshot: ContributorSnapshot
}

/** Result of admission, including the local lease state when accepted. */
export interface ContributionOfferResult {
  coordination: EmployeeTaskCoordinationResult
  lease: NodeTaskLeaseState | null
  status: ContributionStatus
}

/** Dependency bundle for a contribution controller. */
export interface ContributionControllerOptions {
  nodeId: string
  agentVersion: string
  policy: ContributorPolicy
  capabilitySource: ContributionCapabilitySource
  coordinator: EmployeeTaskCoordinator
  transport: ContributionTransport
  clock?: () => string
}

/**
 * Coordinates inventory, autonomous admission, lease binding and safe event references.
 * It has no network, file, model or payment implementation and never asks for runtime approval.
 */
export class ContributionController {
  private readonly nodeId: string
  private readonly agentVersion: string
  private policy: ContributorPolicy
  private readonly capabilitySource: ContributionCapabilitySource
  private readonly coordinator: EmployeeTaskCoordinator
  private readonly transport: ContributionTransport
  private readonly clock: () => string
  private readonly leases = new Map<string, NodeTaskLeaseState>()
  private readonly activeTasks = new Set<string>()
  private statusValue: ContributionStatus = 'DISABLED'
  private closed = false
  private readonly operations = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  /** Create an explicitly configured contributor; `OFF` remains disabled. */
  constructor(options: ContributionControllerOptions) {
    this.nodeId = boundedToken(options.nodeId, 'COMPUTE_CONTRIBUTOR_NODE_ID_INVALID')
    this.agentVersion = boundedToken(options.agentVersion, 'COMPUTE_CONTRIBUTOR_AGENT_VERSION_INVALID')
    this.policy = Object.freeze({ ...options.policy })
    this.capabilitySource = options.capabilitySource
    this.coordinator = options.coordinator
    this.transport = options.transport
    this.clock = options.clock ?? (() => new Date().toISOString())
  }

  /** Current local state; no task contents are retained in this projection. */
  status(): ContributionStatus { return this.statusValue }

  /**
   * Replace the policy used when an offer is admitted.
   * The resident runtime's copy is not this one; both must be updated together.
   * @param policy - The policy that applies on the next offer.
   */
  setPolicy(policy: ContributorPolicy): void {
    this.policy = Object.freeze({ ...policy })
  }

  /** Inventory and redact local capabilities before any control-plane publication. */
  inventory(now = this.clock()): ContributionInventory {
    ensureOpen(this.closed)
    timestamp(now)
    const capabilities = normalizeCapabilities(this.capabilitySource.listCapabilities())
    const available = this.policy.mode === 'OFF' ? [] : capabilities.filter(capability => capability.available)
    const runningTasks = this.runningTaskCount()
    const maxConcurrency = this.policy.maxConcurrency
    const redacted = available.map(capability => ({
      capabilityId: capability.capabilityId,
      version: capability.version,
      pluginDigest: capability.pluginDigest,
    }))
    const advertisement: ContributionAdvertisement = Object.freeze({
      version: CONTRIBUTOR_CONTRACT_VERSION, nodeId: this.nodeId, agentVersion: this.agentVersion, sentAt: now,
      capabilities: Object.freeze(redacted), maxConcurrency, runningTasks,
      privacy: Object.freeze({
        includesUserFiles: false as const,
        includesCredentials: false as const,
        includesMediaBytes: false as const,
      }),
    })
    const heartbeat: NodeHeartbeatMessage = Object.freeze({
      version: 'qianshou.node.v1', nodeId: this.nodeId as NodeHeartbeatMessage['nodeId'],
      agentVersion: this.agentVersion, sentAt: now,
      capabilities: Object.freeze(redacted.map(capability => ({
        capabilityId: ComputeCapabilityId(capability.capabilityId),
        version: capability.version,
        pluginDigest: capability.pluginDigest,
      }))),
      maxConcurrency, runningTasks,
    })
    return Object.freeze({ advertisement, heartbeat, capabilities: Object.freeze(capabilities) })
  }

  /** Publish a redacted heartbeat; OFF advertises no capabilities and stays disabled. */
  advertise(now = this.clock()): Promise<ContributionInventory> {
    return this.track(async () => {
      const value = this.inventory(now)
      this.statusValue = this.policy.mode === 'OFF' ? 'DISABLED' : 'CHECKING'
      try { await this.transport.publishHeartbeat(value.heartbeat) } catch (error) {
        if (!this.closed) this.statusValue = this.policy.mode === 'OFF' ? 'DISABLED' : 'OFFLINE'
        throw error
      }
      ensureOpen(this.closed)
      this.statusValue = this.policy.mode === 'OFF' ? 'DISABLED' : 'ADVERTISED'
      return value
    })
  }

  /**
   * Admit one already signature-verified offer without human interaction.
   * The lease must bind node, task, attempt, expiry and idempotency key exactly.
   */
  acceptOffer(input: ContributionOfferInput): Promise<ContributionOfferResult> {
    return this.track(async () => {
      validateOfferLease(input.offer, input.lease, this.nodeId)
      const policy = restrictedPolicy(this.policy, input.policy, input.snapshot)
      const capability = this.capability(input.offer.envelope.capabilityId, input.offer.envelope.capabilityVersion)
      const inputBytes = input.offer.envelope.inputRefs.reduce((sum, ref) => sum + ref.bytes, 0)
      if (!capability || !capability.available || inputBytes > capability.maxInputBytes
        || input.offer.envelope.maxOutputBytes > capability.maxOutputBytes
        || (capability.dataScope === 'none' && input.offer.envelope.inputRefs.length > 0)) {
        const reason = capability ? 'DATA_SCOPE_OR_RESOURCE_LIMIT' : 'CAPABILITY_UNAVAILABLE'
        const refusal: EmployeeTaskCoordinationResult = {
          decision: { admission: { accepted: false, reason: 'POLICY_DENIED' }, actions: [] },
          action: { type: 'refuse', taskId: input.offer.envelope.taskId, attempt: input.offer.attempt, reason: 'CAPABILITY_UNAVAILABLE' }, state: null,
        }
        await this.reportDecision(input.offer, 'refused', reason, input.now)
        return { coordination: refusal, lease: null, status: this.statusValue }
      }
      const coordination = await this.coordinator.coordinate({
        offer: input.offer,
        now: input.now, policy, snapshot: input.snapshot,
        availableCapabilities: new Set([`${capability.capabilityId}@${capability.version}@${capability.pluginDigest}`]),
        capabilityPluginDigest: capability.pluginDigest,
      })
      if (coordination.action.type !== 'accept') {
        await this.reportDecision(input.offer, 'refused', coordination.action.reason, input.now)
        return { coordination, lease: null, status: this.statusValue }
      }
      const current = this.leases.get(input.lease.leaseId) ?? createLease(input.lease)
      const accepted = transitionNodeTaskLease(current, { type: 'accept', nodeId: this.nodeId as NodeTaskLease['ownerNodeId'], idempotencyKey: input.lease.idempotencyKey, at: input.now })
      this.leases.set(input.lease.leaseId, accepted)
      this.activeTasks.add(`${input.offer.envelope.taskId}\u0000${input.offer.attempt}`)
      if (!this.closed) this.statusValue = 'ADVERTISED'
      await this.reportDecision(input.offer, 'accepted', undefined, input.now)
      return { coordination, lease: accepted, status: this.statusValue }
    })
  }

  /** Record a host-confirmed pause; the caller owns stopping the actual executor. */
  pause(taskId: string, attempt: number, now = this.clock()): Promise<ComputeTaskState> {
    return this.track(async () => {
      timestamp(now)
      const state = await this.coordinator.transition(taskId, attempt, { type: 'pause' }, now)
      ensureOpen(this.closed)
      this.statusValue = 'PAUSED'
      await this.transport.reportDecision?.({ version: CONTRIBUTOR_CONTRACT_VERSION, eventId: `pause:${taskId}:${attempt}:${now}`, nodeId: this.nodeId, taskId, attempt, decision: 'paused', at: now })
      ensureOpen(this.closed)
      return state
    })
  }

  /** Record a dispatch-authorized revoke after the host has drained execution and transfer. */
  revoke(taskId: string, attempt: number, leaseId: string, reason: string, now = this.clock()): Promise<ComputeTaskState> {
    return this.track(async () => {
      timestamp(now)
      const lease = this.leases.get(leaseId)
      if (!lease || lease.taskId !== taskId || lease.attempt !== attempt) throw new ComputeError('COMPUTE_CONTRIBUTOR_LEASE_BINDING_INVALID', 403)
      const revoked = transitionNodeTaskLease(lease, { type: 'revoke', actor: 'dispatch', at: now, reason })
      const state = await this.coordinator.transition(taskId, attempt, { type: 'revoke' }, now)
      this.leases.set(leaseId, revoked)
      this.activeTasks.delete(`${taskId}\u0000${attempt}`)
      ensureOpen(this.closed)
      this.statusValue = this.policy.mode === 'OFF' ? 'DISABLED' : 'ADVERTISED'
      await this.transport.reportDecision?.({ version: CONTRIBUTOR_CONTRACT_VERSION, eventId: `revoke:${leaseId}:${now}`, nodeId: this.nodeId, taskId, attempt, decision: 'revoked', reason, at: now })
      ensureOpen(this.closed)
      return state
    })
  }

  /** Emit a pending earnings reference after core acceptance evidence exists. */
  reportCompleted(event: ContributionEarningsEventReference): Promise<void> {
    return this.track(async () => {
      const parsed = parseEarningsReference(event)
      const lease = this.leases.get(parsed.leaseId)
      if (!lease || lease.state !== 'COMPLETED' || lease.taskId !== parsed.taskId || lease.attempt !== parsed.attempt || lease.ownerNodeId !== parsed.nodeId) throw new ComputeError('COMPUTE_CONTRIBUTOR_COMPLETION_NOT_VERIFIED', 409)
      if (parsed.ledgerEntry.nodeId !== parsed.nodeId || parsed.ledgerEntry.taskId !== parsed.taskId || parsed.ledgerEntry.kind !== 'task_earnings' || parsed.ledgerEntry.status !== 'pending') throw new ComputeError('COMPUTE_CONTRIBUTOR_EARNINGS_REFERENCE_INVALID', 409)
      await this.transport.reportEarnings?.(parsed)
      ensureOpen(this.closed)
    })
  }

  /** Mark a bound lease completed after local execution and output verification. */
  completeLease(leaseId: string, now = this.clock()): NodeTaskLeaseState {
    ensureOpen(this.closed); timestamp(now)
    const current = this.leases.get(leaseId)
    if (!current) throw new ComputeError('COMPUTE_CONTRIBUTOR_LEASE_NOT_FOUND', 404)
    const completed = transitionNodeTaskLease(current, { type: 'complete', nodeId: this.nodeId as NodeTaskLease['ownerNodeId'], at: now })
    this.leases.set(leaseId, completed)
    this.activeTasks.delete(`${current.taskId}\u0000${current.attempt}`)
    return completed
  }

  /** Reject new operations and drain admissions and transport callbacks; no executor is owned here. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.statusValue = 'CLOSED'
      const coordinatorClosing = this.coordinator.close()
      this.closing = Promise.allSettled([...this.operations, coordinatorClosing]).then((results) => {
        const coordinator = results.at(-1)
        if (coordinator?.status === 'rejected') throw coordinator.reason
      })
    }
    return this.closing
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(async () => {
      ensureOpen(this.closed)
      const value = await operation()
      ensureOpen(this.closed)
      return value
    })
    this.operations.add(result)
    void result.then(() => this.operations.delete(result), () => this.operations.delete(result))
    return result
  }

  private capability(id: string, version: string): ContributionCapability | undefined {
    return normalizeCapabilities(this.capabilitySource.listCapabilities()).find(
      item => item.capabilityId === id && item.version === version,
    )
  }
  private runningTaskCount(): number { return this.activeTasks.size }
  private async reportDecision(offer: VerifiedEmployeeTaskOffer, decision: ContributionDecisionEvent['decision'], reason: string | undefined, at: string): Promise<void> {
    ensureOpen(this.closed)
    await this.transport.reportDecision?.({ version: CONTRIBUTOR_CONTRACT_VERSION, eventId: `${decision}:${offer.envelope.taskId}:${offer.attempt}:${at}`, nodeId: this.nodeId, taskId: offer.envelope.taskId, attempt: offer.attempt, decision, ...(reason ? { reason } : {}), at })
  }
}

function restrictedPolicy(owner: ContributorPolicy, requested: ContributorPolicy, snapshot: ContributorSnapshot): ContributorPolicy {
  // Reuse the shared parser before combining numeric limits or mode values.
  decideContribution(owner, snapshot)
  decideContribution(requested, snapshot)
  return {
    mode: owner.mode === 'OFF' || requested.mode === 'OFF' ? 'OFF' : owner.mode,
    maxConcurrency: Math.min(owner.maxConcurrency, requested.maxConcurrency),
    maxCpuPercent: Math.min(owner.maxCpuPercent, requested.maxCpuPercent),
    maxGpuPercent: Math.min(owner.maxGpuPercent, requested.maxGpuPercent),
    maxTemperatureC: Math.min(owner.maxTemperatureC, requested.maxTemperatureC),
    minDiskFreeBytes: Math.max(owner.minDiskFreeBytes, requested.minDiskFreeBytes),
    allowWhileUserActive: owner.allowWhileUserActive && requested.allowWhileUserActive,
  }
}

function validateOfferLease(offer: VerifiedEmployeeTaskOffer, lease: NodeTaskLease, nodeId: string): void {
  if (!isVerifiedTaskAssignment(offer)) throw new ComputeError('COMPUTE_TASK_NOT_VERIFIED', 401)
  const parsed = parseNodeTaskLease(lease)
  if (parsed.ownerNodeId !== nodeId || parsed.taskId !== offer.envelope.taskId || parsed.attempt !== offer.attempt || parsed.expiresAt !== offer.leaseExpiresAt || parsed.idempotencyKey !== offer.envelope.idempotencyKey) throw new ComputeError('COMPUTE_CONTRIBUTOR_LEASE_BINDING_INVALID', 403)
}
function createLease(lease: NodeTaskLease): NodeTaskLeaseState { return createNodeTaskLeaseState(parseNodeTaskLease(lease)) }
function normalizeCapabilities(value: readonly unknown[]): ContributionCapability[] {
  if (!Array.isArray(value) || value.length > 256) throw new ComputeError('COMPUTE_CONTRIBUTOR_CAPABILITIES_INVALID')
  const seen = new Set<string>()
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ComputeError('COMPUTE_CONTRIBUTOR_CAPABILITY_INVALID')
    const item = raw as Record<string, unknown>
    if (!token(item.capabilityId) || !token(item.version)
      || typeof item.pluginDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.pluginDigest)
      || (item.dataScope !== 'none' && item.dataScope !== 'task-inputs')
      || !Number.isSafeInteger(item.maxInputBytes) || (item.maxInputBytes as number) < 0
      || !Number.isSafeInteger(item.maxOutputBytes) || (item.maxOutputBytes as number) < 0
      || typeof item.available !== 'boolean') {
      throw new ComputeError('COMPUTE_CONTRIBUTOR_CAPABILITY_INVALID')
    }
    const key = `${item.capabilityId}\u0000${item.version}`
    if (seen.has(key)) throw new ComputeError('COMPUTE_CONTRIBUTOR_CAPABILITY_DUPLICATE')
    seen.add(key)
    return Object.freeze({
      capabilityId: item.capabilityId,
      version: item.version,
      pluginDigest: item.pluginDigest,
      dataScope: item.dataScope,
      maxInputBytes: item.maxInputBytes as number,
      maxOutputBytes: item.maxOutputBytes as number,
      available: item.available,
    })
  })
}
function parseEarningsReference(value: unknown): ContributionEarningsEventReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_CONTRIBUTOR_EARNINGS_REFERENCE_INVALID')
  const item = value as Record<string, unknown>
  if (item.version !== CONTRIBUTOR_CONTRACT_VERSION || !token(item.eventId)
    || !token(item.nodeId) || !token(item.taskId)
    || !Number.isSafeInteger(item.attempt) || (item.attempt as number) < 1
    || !token(item.leaseId) || !token(item.acceptanceEvidenceRef)
    || typeof item.occurredAt !== 'string') {
    throw new ComputeError('COMPUTE_CONTRIBUTOR_EARNINGS_REFERENCE_INVALID')
  }
  timestamp(item.occurredAt)
  let ledgerEntry: NodeEarningsLedgerEntry
  try { ledgerEntry = parseNodeEarningsLedgerEntry(item.ledgerEntry) } catch { throw new ComputeError('COMPUTE_CONTRIBUTOR_EARNINGS_REFERENCE_INVALID') }
  return Object.freeze({
    version: CONTRIBUTOR_CONTRACT_VERSION,
    eventId: item.eventId,
    nodeId: item.nodeId,
    taskId: item.taskId,
    attempt: item.attempt as number,
    leaseId: item.leaseId,
    acceptanceEvidenceRef: item.acceptanceEvidenceRef,
    ledgerEntry,
    occurredAt: item.occurredAt,
  })
}
function boundedToken(value: unknown, code: string): string { if (!token(value)) throw new ComputeError(code); return value }
function token(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(value) }
function timestamp(value: string): void { const date = new Date(value); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new ComputeError('COMPUTE_CONTRIBUTOR_TIMESTAMP_INVALID') }
function ensureOpen(closed: boolean): void { if (closed) throw new ComputeError('COMPUTE_CLOSED', 503) }

export { createResidentControlPort, type ResidentControlPortBinding, type ResidentControlPortOptions } from './resident-port.ts'
export { createReviewedComfyVideoResidentRoute,
  type ReviewedComfyVideoResidentRoute, type ReviewedComfyVideoResidentRouteOptions,
} from './reviewed-comfy-video-resident-route.ts'
export { createSignedReviewedVideoOfferPort,
  type SignedReviewedVideoOfferPort,
} from './reviewed-video-signed-order.ts'
export { createReviewedVideoHostProbe, submitReviewedVideoSupplyUpdate,
  type ReviewedVideoRuntimeWitness, type ReviewedVideoSampleIdentity,
  type ReviewedVideoSupplyPorts, type ReviewedVideoSupplySnapshot,
} from './reviewed-video-supply-proof.ts'
export { reviewedVideoHostPortOf, type ReviewedVideoHostPort } from './reviewed-video-host-port.ts'
export { createProductReviewedVideoHostPort, createProvisionedReviewedVideoHostPort,
  type ProductReviewedVideoHostProvision, type ReviewedVideoHostProviderOptions }
  from './reviewed-video-host-provider.ts'
export { prepareVideoAssetPlan, VideoAssetPlanFailure,
  type VideoAssetPlan, type VideoAssetPlanRequest } from './reviewed-video-asset-planner.ts'
export {
  createResidentAssembly,
  measuredFreeBytes,
  NODE_CONTRIBUTOR_FAILURES,
  productionGaps,
  type ResidentAssembly,
  type ResidentAssemblyOptions,
  type ResidentAssemblyStatus,
} from './resident-assembly.ts'
export { NodeContributorError } from './errors.ts'
export {
  apply,
  Config,
  inject,
  name,
  NODE_CONTRIBUTOR_SERVICE,
  resolveHarnessHome,
  readContributorAccessToken,
  ownerIdFromStoredAccess,
  resolveIsolatedRoute,
  resolvePolicy,
  resolveWorkspaceRoot,
  unconfiguredLeaseSource,
  unconfiguredVerifier,
  type NodeContributorService,
  type NodeContributorStatus,
} from './plugin.ts'
