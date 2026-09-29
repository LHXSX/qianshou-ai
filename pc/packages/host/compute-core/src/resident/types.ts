/**
 * Public seams for the resident node runtime.
 *
 * The runtime is the missing orchestration layer above the already-landed parts:
 * `resident-loop.ts` (serialized tick + heartbeat), `scheduler.ts` (pure
 * admission), `employee-task-coordinator.ts` (atomic admission) and the
 * control-plane port bound by `node-contributor`'s `ContributionController`
 * (capability gating, lease binding, decision reporting).
 *
 * Nothing in this module opens a socket, reads a credential, stores a token or
 * claims settlement. Every side effect is an injected seam owned by the host.
 */
import type { ContributorPolicy, ContributorSnapshot } from '../contributor-policy.ts'
import type { ComputeProgressReporter } from '../executor.ts'
import type { ComputeTaskState } from '../task-state.ts'
import type { NodeHeartbeatMessage, NodeTaskOfferMessage, NodeTaskProgressMessage, NodeTaskReturnMessage } from '../node-protocol.ts'
import type { ComputeTaskEnvelope } from '../protocol.ts'

/** Version this runtime emits on contributor control-plane events. */
export const RESIDENT_CONTRIBUTOR_CONTRACT_VERSION = 'qianshou.node-contributor.v1' as const

/** Admission decision emitted without exposing task parameters or input references. */
export interface ResidentDecisionEvent {
  version: typeof RESIDENT_CONTRIBUTOR_CONTRACT_VERSION
  eventId: string
  nodeId: string
  taskId: string | null
  attempt: number | null
  decision: 'accepted' | 'refused' | 'paused' | 'revoked'
  reason?: string
  at: string
}

/** Reference to a core-confirmed earnings entry; this does not settle or pay. */
export interface ResidentEarningsEventReference {
  version: typeof RESIDENT_CONTRIBUTOR_CONTRACT_VERSION
  eventId: string
  nodeId: string
  taskId: string
  attempt: number
  leaseId: string
  acceptanceEvidenceRef: string
  ledgerEntry: unknown
  occurredAt: string
}

/** Durable lifecycle of the resident worker, independent of any socket instance. */
export type ResidentLifecycleState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPING' | 'STOPPED'

/** Stable local reason attached to a recorded admission refusal. */
export type ResidentAdmissionReason =
  | 'ACCEPTED'
  | 'LIFECYCLE_PAUSED'
  | 'LIFECYCLE_STOPPED'
  | 'LEASE_EXPIRED_BEFORE_START'
  | 'CANDIDATE_REJECTED'

/** Immutable binding between one accepted offer and its remote attempt identity. */
export interface ResidentAttempt {
  taskId: string
  attempt: number
  leaseId: string
  leaseExpiresAt: string
  idempotencyKey: string
  envelopeFingerprint: string
  capabilityId: string
  capabilityVersion: string
  capabilityPluginDigest: string
}

/** Result of admitting or refusing one raw dispatch offer. */
export interface ResidentOfferOutcome {
  accepted: boolean
  /** Coarse local classification, stable across modes. */
  reason: ResidentAdmissionReason
  /** Concrete refusal code from the control plane, preserved verbatim for callers. */
  refusal?: string
  state: ComputeTaskState | null
  attempt: ResidentAttempt | null
}

/** Result of one serialized runtime tick. */
export interface ResidentTickOutcome {
  sentHeartbeat: boolean
  /** Sequence assigned to a synthetic heartbeat; null when the periodic loop sent it. */
  heartbeatSequence: number | null
  runningTasks: number
  outcomes: readonly ResidentOfferOutcome[]
}

/** Stable failure codes for a local execution attempt. */
export type ResidentFailureCode =
  | 'LEASE_EXPIRED'
  | 'TRANSPORT_LOST'
  | 'EXECUTION_FAILED'
  | 'OUTPUT_INVALID'
  | 'UPLOAD_FAILED'
  | 'RETURN_FAILED'
  | 'CANCELLED'
  | 'UNRECORDED'

/** Retention of an attempt under the lease; `PRESERVED` may still be resumed. */
export type ResidentFailureDisposition = 'TERMINAL' | 'PRESERVED'

/** Classified failure of one local execution attempt. */
export interface ResidentAttemptFailure {
  code: ResidentFailureCode
  disposition: ResidentFailureDisposition
}

/**
 * Verified local output ready for an upload provider.
 *
 * Reachable today only through {@link ComputeResidentWorkspaceOutputs}, which is
 * **not wired** — read that alias before producing or consuming one.
 */
export interface ResidentVerifiedOutput {
  name: string
  path: string
  bytes: number
  sha256: string
}

/**
 * The outputs a workspace provider hands to the result consumer.
 *
 * **NOT WIRED — no production reader exists in this repository.**
 *
 * `ResidentNodeRuntime` never reads this array. It calls
 * `workspaceProvider.createWorkspace(execution)` *before* anything runs
 * (`resident/runtime.ts:461`) and only then calls
 * `resultConsumer.consume({ execution, workspace, signal })` (`:465`); the
 * consumer's own receipt — not this field — is what travels on
 * `NodeTaskReturnMessage.outputs` (`node-protocol.ts`). Measured readers of
 * `workspace.outputs` in the whole repository: exactly one, the test harness
 * `packages/host/node-contributor/tests/resident/harness.ts`, whose workspace
 * provider *also owns execution* and therefore genuinely can fill it.
 *
 * Consequence for implementors: a workspace provider that does **not** own
 * execution must return an empty array. A non-empty value there would report
 * artifacts the provider cannot observe, and it would not reach any wire anyway.
 * Concretely, a pass-through consumer
 * (`consume: async ({ workspace }) => ({ outputs: workspace.outputs })`) bound to
 * `createResidentAssembly` produces an empty delivery for exactly this reason —
 * the harness works only because its own provider fills the field.
 *
 * Disposition: **pending, deliberately not decided here.** Either this field is
 * deleted (and the harness keeps its receipt in its own state), or it gets a real
 * wire once the node→platform artifact channel is settled. That channel is a
 * cross-repo protocol item — see `contracts/v1/result.schema.json`
 * (`output.kind: "ref"` + `output.uri`) — so it is not a local fix.
 */
export type ComputeResidentWorkspaceOutputs = readonly ResidentVerifiedOutput[]

/** Private per-attempt workspace and its verified outputs. */
export interface ComputeResidentWorkspace {
  path: string
  /** **NOT WIRED** — no production reader; see {@link ComputeResidentWorkspaceOutputs}. */
  outputs: ComputeResidentWorkspaceOutputs
  /** Stop the attempt and remove only files owned by it. */
  close(): Promise<void>
}

/** Source of authorized input bytes; the implementation enforces task/lease authorization. */
export interface ComputeResidentAttemptSource {
  open(task: ComputeTaskEnvelope, input: ComputeTaskEnvelope['inputRefs'][number], signal: AbortSignal): Promise<ReadableStream<Uint8Array>>
}

/** Everything a local capability needs to run exactly one admitted attempt. */
export interface ComputeResidentAttemptExecution {
  task: ComputeTaskEnvelope
  attempt: ResidentAttempt
  signal: AbortSignal
  reportProgress: ComputeProgressReporter
  source: ComputeResidentAttemptSource
  dataSource: unknown
}

/** Host-owned local execution provider; the runtime never resolves a capability itself. */
export interface ComputeResidentWorkspaceProvider {
  createWorkspace(execution: ComputeResidentAttemptExecution): Promise<ComputeResidentWorkspace>
}

/** Sink for verified local outputs; this transfer owns any network authorization. */
export interface ComputeResidentResultConsumer {
  consume(input: {
    execution: ComputeResidentAttemptExecution
    workspace: ComputeResidentWorkspace
    signal: AbortSignal
  }): Promise<{ outputs: readonly { name: string; bytes: number; sha256: string }[] }>
}

/** An offer accepted by the control-plane port, pending local admission. */
export interface ResidentOfferCandidate {
  /** Verified assignment credential minted by the injected offer verifier. */
  offer: unknown
  binding: ResidentAttempt
  /** Local authorization payload carried beside the lease; opaque to this runtime. */
  dataSource?: unknown
}

/** Inbound dispatch frames a resident session may deliver. */
export type ResidentInboundFrame =
  | { type: 'heartbeat'; message: NodeHeartbeatMessage }
  | { type: 'task.progress'; message: NodeTaskProgressMessage }
  | { type: 'task.return'; message: NodeTaskReturnMessage }
  | { type: 'offer.decision'; event: ResidentDecisionEvent }
  | { type: 'offer.earnings'; event: ResidentEarningsEventReference }

/** One raw dispatch offer awaiting verification. */
export interface ResidentOfferRequest {
  /** The authenticated `task.offer` frame as parsed by the transport connector. */
  offer: NodeTaskOfferMessage
  signature: string
  traceId: string
}

/** Result of the control-plane port's verification of one raw offer. */
export interface ResidentOfferVerification {
  accepted: boolean
  code?: string
  candidate?: ResidentOfferCandidate
}

/** One open session; the adapter owns TLS, tokens, reconnect and backoff. */
export interface ResidentSession {
  sendHeartbeat(message: NodeHeartbeatMessage): Promise<void>
  sendProgress(message: NodeTaskProgressMessage): Promise<void>
  sendReturn(message: NodeTaskReturnMessage): Promise<void>
  /** Report an admission decision when the deployment session carries it. */
  sendDecision?(event: ResidentDecisionEvent): Promise<void>
  /** Report a completion reference when the deployment session carries it. */
  sendEarnings?(event: ResidentEarningsEventReference): Promise<void>
  onOffer(handler: (offer: NodeTaskOfferMessage) => void | Promise<void>): () => void
  onDisconnect(handler: (reason?: string) => void): () => void
  close(reason?: string): Promise<void>
}

/** Connector implemented by the deployment transport; it reconnects on its own. */
export interface ResidentSessionConnector {
  connect(signal: AbortSignal): Promise<ResidentSession>
}

/** One observation: the policy snapshot and the heartbeat that publishes it. */
export interface ResidentResourceObservation {
  snapshot: ContributorSnapshot
  heartbeat: NodeHeartbeatMessage
}

/** Platform facts the runtime cannot infer for itself. */
export interface ResidentResourceObserver {
  snapshot(runningTasks: number): Promise<ResidentResourceObservation>
}

/** One local capability the host already self-tested and advertised. */
export interface ResidentCapability {
  capabilityId: string
  version: string
  pluginDigest: string
  dataScope: 'none' | 'task-inputs'
  maxInputBytes: number
  maxOutputBytes: number
  available: boolean
}

/** Local advertisement source; the runtime only reads what the host already verified. */
export interface ResidentCapabilitySource {
  listCapabilities(): readonly ResidentCapability[]
}

/**
 * Control-plane port injected by the host.
 *
 * `node-contributor` binds this to its `ContributionController` +
 * `EmployeeTaskCoordinator`; a loop-only test harness can bind it to a minimal
 * local implementation. The runtime never resolves a capability, caps a policy
 * or writes a decision itself, so this seam is the only path to acceptance.
 */
export interface ResidentControlPort {
  /** Verify one raw offer for this node, mint the admission credential and bind its lease. */
  verifyOffer(request: ResidentOfferRequest): Promise<ResidentOfferVerification>
  /** Publish a redacted advertisement; OFF publishes no capability. */
  advertise(now: string): Promise<void>
  /** Consult the port's own capability/resource gate for one bound candidate. */
  precheck(candidate: ResidentOfferCandidate, input: ResidentPrecheckInput): Promise<ResidentPrecheckResult>
  /** Accept one bound candidate; only `accepted` may be executed. */
  accept(candidate: ResidentOfferCandidate, input: ResidentPrecheckInput): Promise<ResidentAcceptResult>
  /** Report one admission/refusal decision without task contents. */
  reportDecision(event: ResidentDecisionEvent): Promise<void>
  /** Report a completion reference after local verification; never a payment. */
  reportEarnings(event: ResidentEarningsEventReference): Promise<void>
  /** Apply one local lifecycle event to the shared task store. */
  transition(taskId: string, attempt: number, event: ResidentTaskEvent, now: string): Promise<ComputeTaskState>
  /** Read one local attempt record, or null when it does not exist. */
  state(taskId: string, attempt: number): Promise<ComputeTaskState | null>
}

/** Inputs a port may consult for precheck and acceptance. */
export interface ResidentPrecheckInput {
  /** Canonical current UTC timestamp. */
  now: string
  /** Owner policy narrowed by nothing; the port may only narrow it further. */
  policy: ContributorPolicy
  snapshot: ContributorSnapshot
  /** Exact `id@version@digest` keys this node advertises right now. */
  availableCapabilities: ReadonlySet<string>
}

/** Capability/data-scope precheck result from the control plane. */
export interface ResidentPrecheckResult {
  accepted: boolean
  reason: string
}

/** Binding decision for one prechecked candidate. */
export interface ResidentAcceptResult {
  accepted: boolean
  state: ComputeTaskState | null
  /** Stable decision reason recorded for refusals. */
  reason?: string
}

/** Lifecycle events the runtime may ask the port to persist. */
export type ResidentTaskEvent = { type: 'start' } | { type: 'progress'; progress: number } | { type: 'upload' } | { type: 'return' } | { type: 'settle' }

/** Runtime configuration; every field is explicit so deployment policy is inspectable. */
export interface ResidentRuntimeConfig {
  nodeId: string
  agentVersion: string
  policy: ContributorPolicy
  observer: ResidentResourceObserver
  capabilities: ResidentCapabilitySource
  connector: ResidentSessionConnector
  port: ResidentControlPort
  workspace: ComputeResidentWorkspaceProvider
  /** Host-authenticated reader for an admitted attempt's exact input reference. Absent refuses. */
  inputSource?: {
    open(execution: ComputeResidentAttemptExecution, task: ComputeTaskEnvelope,
      input: ComputeTaskEnvelope['inputRefs'][number], signal: AbortSignal): Promise<ReadableStream<Uint8Array>>
  }
  resultConsumer: ComputeResidentResultConsumer
  clock?: () => number
  /** Grace period before `stop()` gives up waiting for in-flight attempts. Default 30000. */
  stopTimeoutMs?: number
  /** Maximum offers buffered locally before the tick admits them. Default 64. */
  maxPendingOffers?: number
  /** Interval between drain checks while `stop()` waits. Default 25. */
  drainStepMs?: number
  /** Retention of an attempt whose lease expired while it was still queued. Default false. */
  keepExpiredQueuedAttempts?: boolean
}

/** One attempt whose runner has not returned yet. Fraction `0` means started, not finished. */
export interface ResidentInFlightAttempt {
  taskId: string
  attempt: number
  taskType: string
  /** Last reported fraction. Stays `0` until the result exists. */
  progress: number
  /** Progress frames sent for this attempt, including the opening `0`. */
  progressEvents: number
  /** UTC timestamp when this attempt entered the runtime. */
  startedAt: string
}

/** Read-only projection of one attempt the runtime currently owns. */
export interface ResidentAttemptRecord {
  taskId: string
  attempt: number
  status: ComputeTaskState['status']
  progress: number
  leaseExpiresAt: string | null
  failureCode: ResidentFailureCode | null
  updatedAt: string
}

/** Stop receipt; `settled` is false when the grace period expired first. */
export interface ResidentStopReceipt {
  settled: boolean
  attempts: readonly ResidentAttemptRecord[]
}

/** The complete resident work loop. */
export interface ResidentRuntime {
  readonly nodeId: string
  state(): ResidentLifecycleState
  activeAttempts(): readonly ResidentAttemptRecord[]
  /** Attempts this runtime still owns and may abort or drain. */
  inFlightCount(): number
  /** Attempts whose runner has not returned. Empty when nothing is executing. */
  inFlightAttempts(): readonly ResidentInFlightAttempt[]
  pendingOfferCount(): number
  policy(): ContributorPolicy
  /** Replace the owner's policy; it takes effect on the next tick. */
  setPolicy(policy: ContributorPolicy): void
  start(): Promise<void>
  /** Run exactly one serialized tick. */
  tickOnce(): Promise<ResidentTickOutcome>
  /** Stop accepting new offers; in-flight attempts continue. */
  pause(): void
  resume(): Promise<void>
  /** Replace the current session/Hello only once no attempt or tick can use it. */
  refreshSessionWhenIdle(): Promise<'refreshed' | 'deferred' | 'unavailable'>
  /** Drain in-flight attempts to a recorded terminal state, then close. */
  stop(reason?: string): Promise<ResidentStopReceipt>
  /** Record dispatch-confirmed completion of one returned attempt. */
  settle(taskId: string, attempt: number, now?: string): Promise<ComputeTaskState>
}
