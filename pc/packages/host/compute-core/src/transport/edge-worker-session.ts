/**
 * Real WebSocket session for the resident loop.
 *
 * `transport/memory-session.ts` is the conformance double: it opens no socket
 * and can only ever prove loop behaviour. This module is the same seam carried
 * over the audited Edge worker socket implemented by `EdgeWorkerConnection`, so
 * the resident runtime can run against a real handshake. It reimplements no
 * part of that protocol: connection, hello/auth, heartbeat interval, lease
 * bookkeeping, frame validation and cancellation all stay in `connection.ts`.
 *
 * Three facts are not shared by the two audited protocols, and this adapter
 * refuses to invent any of them:
 *
 * - the edge frame carries no assignment signature;
 * - the resident seam returns verified output *manifests*, while the edge result
 *   form in `EdgeWorkerConnection` is raw inline UTF-8 bytes;
 * - the node attempt numbering and the edge attempt numbering need not agree.
 *
 * The deployment therefore supplies an {@link EdgeSessionBridge}. Without an
 * endpoint or without that bridge the connector refuses structurally — there is
 * deliberately no configuration under which this module reports a connection it
 * never observed.
 */
import { ComputeError } from '../errors.ts'
import { parseNodeHeartbeat, type NodeHeartbeatMessage, type NodeTaskOfferMessage, type NodeTaskProgressMessage, type NodeTaskReturnMessage } from '../node-protocol.ts'
import { EdgeWorkerConnection, type EdgeWorkerOptions, type OrderAdapterChallengeObservation,
  type NativeH3DeviceKeyObservation, type NativeH3DevicePresenceObservation, type NativeH3AdapterClaim } from '../edge-worker/connection.ts'
import type { ReviewedVideoAdapterAck, ReviewedVideoAdapterUpdate }
  from '../edge-worker/reviewed-video-supply-contract.ts'
export type { OrderAdapterChallengeObservation, NativeH3DeviceKeyObservation,
  NativeH3DevicePresenceObservation, NativeH3AdapterClaim } from '../edge-worker/connection.ts'
import type { EdgeArtifactManifest, EdgeArtifactResult, EdgeInlineResult, EdgeTaskIdentity, EdgeTaskOffer, EdgeWorkerEvent } from '../edge-worker/types.ts'
import { SupplyError } from '../supply/policy.ts'
import type { ResidentDecisionEvent, ResidentSession, ResidentSessionConnector } from '../resident/types.ts'

/** Machine-readable failures of one resident edge session. */
export type ResidentEdgeFailureCode =
  /** No endpoint was configured; nothing was opened. */
  | 'TRANSPORT_NOT_CONFIGURED'
  /** No bridge was configured, so the two mismatched frames cannot be translated honestly. */
  | 'TRANSPORT_BRIDGE_REQUIRED'
  /** The connection rejected the caller's own options before any socket work. */
  | 'TRANSPORT_CONFIG_INVALID'
  /** Socket, handshake deadline, or an authenticated send failed. */
  | 'TRANSPORT_NETWORK_FAILED'
  /** The peer refused this node's credentials. */
  | 'TRANSPORT_AUTH_FAILED'
  /** The peer's frames contradict the audited protocol version or frame set. */
  | 'TRANSPORT_PROTOCOL_INVALID'
  /** The session ended for a local, policy or server-reported reason that is neither of the above. */
  | 'TRANSPORT_SESSION_CLOSED'
  /** The caller aborted. */
  | 'TRANSPORT_ABORTED'
  /** A send was attempted before authentication completed. */
  | 'TRANSPORT_NOT_CONNECTED'
  /** No active edge lease matches this task and attempt. */
  | 'TRANSPORT_LEASE_NOT_ACTIVE'
  /** The bridge refused to encode this result for the edge result form. */
  | 'TRANSPORT_RESULT_REFUSED'
  /** The bridge refused this offer, so no local attempt exists for it. */
  | 'TRANSPORT_OFFER_REFUSED'

/** Which failure classes mean "the connection is gone" and how a caller may react. */
export type ResidentEdgeLinkState = 'not-configured' | 'connecting' | 'ready' | 'failed' | 'closed'

/**
 * Failure of one real edge session.
 *
 * The name is `ResidentTransportError` on purpose: `resident/runtime.ts`
 * classifies exactly that name as `TRANSPORT_LOST` with a `PRESERVED`
 * disposition, so a dropped socket parks the attempt instead of reporting it.
 */
export class EdgeWorkerTransportError extends Error {
  /** Raw edge reason kept for diagnosis; it never contains a token or a frame body. */
  readonly edgeReason: string | undefined

  /** Build one classified transport failure.
   * @param code - Stable classification code.
   * @param state - Link state at the moment of failure.
   * @param edgeReason - Original edge reason, when the failure came from the connection.
   */
  constructor(readonly code: ResidentEdgeFailureCode, readonly state: ResidentEdgeLinkState, edgeReason?: string) {
    super(edgeReason === undefined ? code : `${code} (${edgeReason})`)
    this.name = 'ResidentTransportError'
    this.edgeReason = edgeReason
  }
}

/** Edge reasons that mean "this node's credentials were refused". */
const AUTH_REASONS: ReadonlySet<string> = new Set(['EDGE_AUTH_REQUIRED'])
/** Edge reasons that mean "the peer's frames or state contradict the audited protocol". */
const PROTOCOL_REASONS: ReadonlySet<string> = new Set(['EDGE_PROTOCOL_INVALID', 'EDGE_SUPPLY_WITHDRAWN'])
/** Edge reasons that mean "the socket, its deadline or a send failed". */
const NETWORK_REASONS: ReadonlySet<string> = new Set([
  'EDGE_CONNECTION_FAILED', 'EDGE_CONNECTION_CLOSED', 'EDGE_HANDSHAKE_TIMEOUT', 'EDGE_HEARTBEAT_FAILED', 'EDGE_NOT_CONNECTED',
  // A peer that stops answering `hb` is a lost link even while the TCP session stays open;
  // this is the exact case the connection's post-auth ack deadline exists for.
  'EDGE_HEARTBEAT_TIMEOUT',
])

/**
 * Classify one edge close reason into the failure family a caller must handle.
 *
 * A socket-level subprotocol refusal is *not* distinguishable here: the
 * WHATWG `WebSocket` API reports only a bare `error` event, and
 * `EdgeWorkerConnection` maps it to `EDGE_CONNECTION_FAILED`, so it is
 * classified as a network failure rather than as a protocol mismatch.
 * @param edgeReason - Reason reported by `EdgeWorkerConnection`.
 * @param authenticated - Whether `auth_ok` was already received on this session.
 * @returns The stable failure code for that reason.
 */
export function classifyEdgeDisconnect(edgeReason: string, authenticated: boolean): ResidentEdgeFailureCode {
  if (edgeReason === 'EDGE_ABORTED') return 'TRANSPORT_ABORTED'
  // Local fail-closed decisions recorded before the socket is closed on purpose.
  if (edgeReason.startsWith('EDGE_OFFER_REFUSED') || edgeReason === 'EDGE_OFFER_IDENTITY_CONFLICT') return 'TRANSPORT_OFFER_REFUSED'
  if (AUTH_REASONS.has(edgeReason)) return 'TRANSPORT_AUTH_FAILED'
  // A server `err` before `auth_ok` is a credential decision; after `auth_ok` it
  // is a legitimate session-level rejection, not a second authentication.
  if (edgeReason === 'EDGE_SERVER_REJECTED') return authenticated ? 'TRANSPORT_SESSION_CLOSED' : 'TRANSPORT_AUTH_FAILED'
  if (PROTOCOL_REASONS.has(edgeReason)) return 'TRANSPORT_PROTOCOL_INVALID'
  if (NETWORK_REASONS.has(edgeReason)) return 'TRANSPORT_NETWORK_FAILED'
  return 'TRANSPORT_SESSION_CLOSED'
}

/** Facts this adapter observed for one authenticated edge offer. */
export interface EdgeOfferContext {
  /** Adapter receive instant, canonical UTC with millisecond precision. */
  readonly receivedAt: string
  /** Worker identity the server confirmed in `auth_ok`. */
  readonly workerId: string
}

/** Result of translating one authenticated edge offer for the resident seam. */
export type EdgeOfferTranslation = NodeTaskOfferMessage | { readonly refuse: string }

/** Result of encoding one verified local return for the edge result form. */
export type EdgeResultTranslation = EdgeInlineResult | EdgeArtifactResult | { readonly refuse: string }

/**
 * Deployment-owned translation between the two audited protocols.
 *
 * The transport cannot supply these fields itself without inventing them, so the
 * deployment owns the mapping and its signature scheme. A `refuse` return is
 * always honoured: this adapter never falls back to a fabricated frame.
 */
export interface EdgeSessionBridge {
  /** Translate one authenticated edge offer, or refuse it with a stable code. */
  toNodeOffer(offer: EdgeTaskOffer, context: EdgeOfferContext): EdgeOfferTranslation
  /** Encode one verified local return into an inline result or uploaded artifact reference. */
  toEdgeResult(message: NodeTaskReturnMessage): EdgeResultTranslation
}

/** Everything the resident edge session needs; no credential is stored outside `tokenProvider`. */
export interface EdgeWorkerSessionOptions {
  /** Audited loopback edge origin, for example `http://127.0.0.1:18941`. Null or empty refuses. */
  readonly endpoint: string | null
  /** Returns the access token for one handshake; never persisted by this module. */
  readonly tokenProvider: () => string | undefined
  /** Owner account the server must confirm in `auth_ok`. */
  readonly expectedOwnerId: number
  /** Previously acknowledged worker identity, when reconnecting the same registered node. */
  readonly workerId?: string
  /** Display name sent in `auth`. */
  readonly name: string
  readonly clientBuild: string
  readonly os: string
  readonly arch: string
  readonly capabilities: Readonly<Record<string, unknown>>
  readonly protocolCapabilities?: readonly string[]
  readonly allowedTaskTypes: readonly string[]
  /** Authenticated device registration with no executable adapters; every heartbeat remains paused. */
  readonly registrationOnly?: true
  readonly handshakeTimeoutMs: number
  readonly maxFrameBytes: number
  readonly maxOutputBytes: number
  /** Injected transport for lease-bound metadata POST and signed object PUT tests. */
  readonly artifactFetch?: typeof fetch
  /**
   * When true (the default), only literal loopback HTTP origins are admitted.
   * HTTPS scheduler origins require `false`.
   */
  readonly loopbackOnly?: boolean
  /** Owner policy read at every heartbeat; this adapter never widens it and never defaults it. */
  readonly supply: () => 'running' | 'paused'
  /** Required translation for the frames the two protocols do not share. */
  readonly bridge: EdgeSessionBridge
  /** Safe transport events, forwarded unchanged. */
  readonly onEvent?: (event: EdgeWorkerEvent) => void
  /** Local clock, injectable for tests. */
  readonly clock?: () => number
}

/** One offer the adapter delivered, with the edge identity its progress and result must reuse. */
interface DeliveredOffer {
  readonly identity: EdgeTaskIdentity
  readonly nodeAttempt: number
}

/**
 * The resident seam over one real edge socket.
 *
 * `onDisconnect` reports the classified failure code, so the three families are
 * visible on the notification path as well as on the thrown error.
 */
export class EdgeWorkerResidentSession implements ResidentSession {
  private readonly connection: EdgeWorkerConnection
  private readonly offers = new Set<(offer: NodeTaskOfferMessage) => void | Promise<void>>()
  private readonly disconnects = new Set<(reason?: string) => void>()
  private readonly delivered = new Map<string, DeliveredOffer>()
  private readonly clockNow: () => number
  private linkState: ResidentEdgeLinkState = 'not-configured'
  private authenticated = false
  private workerId = ''
  private edgeReason: string | null = null
  private failureCode: ResidentEdgeFailureCode | null = null
  private workloadFraction = 0
  private closing = false

  /** Build the session and its socket adapter; nothing is opened until {@link open}.
   * @param options - Endpoint, credentials provider, owner policy and protocol bridge.
   */
  constructor(private readonly options: EdgeWorkerSessionOptions) {
    this.clockNow = options.clock ?? (() => Date.now())
    const edgeOptions: EdgeWorkerOptions = {
      origin: options.endpoint ?? '',
      tokenProvider: options.tokenProvider,
      expectedOwnerId: options.expectedOwnerId,
      name: options.name,
      clientBuild: options.clientBuild,
      os: options.os,
      arch: options.arch,
      capabilities: options.capabilities,
      ...(options.protocolCapabilities === undefined ? {} : { protocolCapabilities: options.protocolCapabilities }),
      allowedTaskTypes: options.allowedTaskTypes,
      ...(options.registrationOnly === undefined ? {} : { registrationOnly: options.registrationOnly }),
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      maxFrameBytes: options.maxFrameBytes,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.artifactFetch === undefined ? {} : { artifactFetch: options.artifactFetch }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.loopbackOnly === undefined ? {} : { loopbackOnly: options.loopbackOnly }),
      readLoad: () => this.workloadFraction,
      onOffer: (offer, signal) => this.deliver(offer, signal),
      onEvent: (event) =>{  this.observe(event) },
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    }
    try {
      this.connection = new EdgeWorkerConnection(edgeOptions)
    } catch (error) {
      throw new EdgeWorkerTransportError('TRANSPORT_CONFIG_INVALID', 'not-configured',
        error instanceof SupplyError ? error.code : undefined)
    }
  }

  /** Current link state of this session. */
  state(): ResidentEdgeLinkState { return this.linkState }

  /** Classified failure of this session, or null while it has not failed. */
  failure(): { readonly code: ResidentEdgeFailureCode; readonly edgeReason: string | null } | null {
    return this.failureCode === null ? null : { code: this.failureCode, edgeReason: this.edgeReason }
  }

  /** Open the real socket and complete hello/auth.
   * @param signal - Abort the handshake and the whole session when cancelled.
   */
  async open(signal?: AbortSignal): Promise<void> {
    this.linkState = 'connecting'
    try {
      await this.connection.connect(signal)
    } catch (error) {
      this.linkState = 'failed'
      throw this.classify(error)
    }
    if (this.state() !== 'ready') {
      // The connection resolved without confirming an identity: fail closed
      // instead of handing the runtime a session that never authenticated.
      this.linkState = 'failed'
      throw this.classify(new SupplyError(this.edgeReason ?? 'EDGE_NOT_AUTHENTICATED'))
    }
  }

  sendHeartbeat(message: NodeHeartbeatMessage): Promise<void> {
    return seamCall(() => {
      // Reuses the node-protocol validator so an unusable observation is refused
      // locally instead of being published as a fabricated load figure.
      const heartbeat = parseNodeHeartbeat(message)
      this.workloadFraction = heartbeat.runningTasks / heartbeat.maxConcurrency
      this.assertUsable()
      const mode: string = this.options.supply()
      if (mode !== 'running' && mode !== 'paused') throw new ComputeError('COMPUTE_RESIDENT_SUPPLY_MODE_INVALID')
      // Withdrawal cannot erase a lease this same authenticated session already
      // delivered. Its retained map, cleared on return/refusal/disconnect, bounds
      // the paused load; a caller's count alone never authorizes new execution.
      if (this.options.registrationOnly === true && this.connection.nativeH3AdapterTaskTypes().length === 0
        && this.connection.reviewedVideoAdapterTaskType() === null
        && (mode !== 'paused' || heartbeat.runningTasks > this.delivered.size
        || heartbeat.capabilities.length !== 0)) throw new SupplyError('EDGE_REGISTRATION_ONLY')
      // `updateMode` is the existing audited path that sets the owner's supply mode
      // and emits one real `hb` frame carrying the load read from `readLoad`.
      this.connection.updateMode(mode)
      this.throwIfClosed()
    })
  }

  /** Send a challenge result over this session's authenticated WS and wait for durable server ack. */
  observeOrderAdapterChallenge(observation: OrderAdapterChallengeObservation): Promise<void> {
    this.assertUsable()
    return this.connection.observeOrderAdapterChallenge(observation)
  }

  /** Send only the fixed device enrollment proof frame over the current authenticated worker.
   * @param observation - Server enrollment challenge id and device signature.
   * @returns The durable observation acknowledgment, without granting approval or supply.
   */
  observeNativeH3DeviceKeyProof(observation: NativeH3DeviceKeyObservation): Promise<void> {
    this.assertUsable()
    return this.connection.observeNativeH3DeviceKeyProof(observation)
  }

  /** Read the current ready socket's server UUID; missing legacy metadata grants no presence authority.
   * @returns The current authenticated connection UUID or null without presence authority.
   */
  acknowledgedConnectionId(): string | null {
    return this.state() === 'ready' ? this.connection.acknowledgedConnectionId() : null
  }

  /** Witness one v2 device-private configuration CAS on the current ready socket.
   * @param observation - Enrolled device signature of the signed configuration challenge.
   * @returns This socket's acknowledgment; no supply or GPU work is enabled.
   */
  observeNativeH3DeviceConfigProof(observation: NativeH3DeviceKeyObservation): Promise<void> {
    this.assertUsable()
    return this.connection.observeNativeH3DeviceConfigProof(observation)
  }

  /** Send only the fixed native presence proof frame and await this socket's nonce acknowledgment.
   * @param observation - Independent presence challenge nonce and device signature.
   * @returns The server observation acknowledgment, without rendering or changing supply.
   */
  observeNativeH3DevicePresence(observation: NativeH3DevicePresenceObservation): Promise<void> {
    this.assertUsable()
    return this.connection.observeNativeH3DevicePresence(observation)
  }

  /** Synchronize only current fixed native claims without reconnecting this worker.
   * @param request - Exact fixed native metadata and request UUID.
   * @returns The same connection's accepted task-set acknowledgment.
   */
  updateNativeH3Adapters(request: { requestId: string; adapters: readonly NativeH3AdapterClaim[] }): Promise<void> {
    this.assertUsable()
    return this.connection.updateNativeH3Adapters(request)
  }

  /** Send one independently signed reviewed-video update; an ACK never switches on intake. */
  updateReviewedVideoAdapter(request: ReviewedVideoAdapterUpdate,
    signal?: AbortSignal): Promise<ReviewedVideoAdapterAck> {
    this.assertUsable()
    return this.connection.updateReviewedVideoAdapter(request, signal)
  }

  /** Task admitted by the exact reviewed-video update ACK on this ready socket. */
  reviewedVideoAdapterTaskType(): string | null {
    return this.state() === 'ready' ? this.connection.reviewedVideoAdapterTaskType() : null
  }

  sendProgress(message: NodeTaskProgressMessage): Promise<void> {
    return seamCall(() => {
      const offer = this.requireOffer(message.taskId, message.attempt)
      this.connection.reportProgress(offer.identity, message.progress)
      this.throwIfClosed()
    })
  }

  sendReturn(message: NodeTaskReturnMessage): Promise<void> {
    return seamCall(() => {
      const offer = this.requireOffer(message.taskId, message.attempt)
      const encoded = this.options.bridge.toEdgeResult(message)
      if ('refuse' in encoded) throw new EdgeWorkerTransportError('TRANSPORT_RESULT_REFUSED', this.linkState, encoded.refuse)
      if ('artifact' in encoded) this.connection.completeArtifact(offer.identity, encoded)
      else this.connection.complete(offer.identity, encoded)
      this.delivered.delete(message.taskId)
      this.throwIfClosed()
    })
  }

  /** Upload media bytes for one delivered attempt without exposing its private lease token. */
  uploadArtifact(taskId: string, attempt: number, input: {
    readonly filename: string
    readonly contentType: 'image/gif' | 'video/mp4'
    readonly bytes: Uint8Array
  }, signal?: AbortSignal): Promise<EdgeArtifactManifest> {
    const offer = this.requireOffer(taskId, attempt)
    return this.connection.uploadArtifact(offer.identity, input, signal)
  }

  /** Read one declared file slot using the private lease of this admitted resident attempt. */
  readFileAttachment(taskId: string, attempt: number, input: Parameters<EdgeWorkerConnection['readFileAttachment']>[1],
    signal?: AbortSignal): ReturnType<EdgeWorkerConnection['readFileAttachment']> {
    return this.connection.readFileAttachment(this.requireOffer(taskId, attempt).identity, input, signal)
  }

  /** Direct-upload bounded file bytes using this admitted resident attempt's private lease. */
  uploadFileArtifact(taskId: string, attempt: number, input: Parameters<EdgeWorkerConnection['uploadFileArtifact']>[1],
    signal?: AbortSignal): Promise<EdgeArtifactManifest> {
    return this.connection.uploadFileArtifact(this.requireOffer(taskId, attempt).identity, input, signal)
  }

  /** Stream a reviewed video through the same authenticated offer and Shanghai complete gate. */
  uploadReviewedVideoFile(taskId: string, attempt: number,
    input: Parameters<EdgeWorkerConnection['uploadReviewedVideoFile']>[1],
    signal?: AbortSignal): Promise<EdgeArtifactManifest> {
    return this.connection.uploadReviewedVideoFile(this.requireOffer(taskId, attempt).identity, input, signal)
  }

  /**
   * Report one admission decision the runtime made, when the wire can carry it.
   *
   * Only refusals travel: the server's `shard_result{ok:false}` form is what tells the scheduler
   * to recycle a shard, while an accepted offer is already visible through the heartbeat and the
   * result that follows. A decision about an offer this session never delivered is ignored rather
   * than translated into an invented frame, and the delivery entry is dropped after reporting so
   * one refused offer can never produce two frames.
   * @param event - The admission decision, including its stable refusal code.
   */
  sendDecision(event: ResidentDecisionEvent): Promise<void> {
    if (event.decision !== 'refused' || event.taskId === null) return Promise.resolve()
    const delivered = this.delivered.get(event.taskId)
    if (delivered === undefined) return Promise.resolve()
    if (event.attempt !== null && delivered.nodeAttempt !== event.attempt) return Promise.resolve()
    this.delivered.delete(event.taskId)
    try {
      this.connection.reject(delivered.identity, {
        code: 'EDGE_ADMISSION_REFUSED',
        message: event.reason === undefined ? 'local admission refused the offer' : `local admission refused: ${event.reason}`,
      })
    } catch { /* the lease is already gone; nothing to report and nothing to invent */ }
    return Promise.resolve()
  }

  onOffer(handler: (offer: NodeTaskOfferMessage) => void | Promise<void>): () => void {
    this.offers.add(handler)
    return () => this.offers.delete(handler)
  }

  onDisconnect(handler: (reason?: string) => void): () => void {
    this.disconnects.add(handler)
    return () => this.disconnects.delete(handler)
  }

  /** Close the socket and detach every handler; repeated calls stay idempotent. */
  async close(): Promise<void> {
    this.closing = true
    this.linkState = 'closed'
    this.offers.clear()
    this.disconnects.clear()
    this.delivered.clear()
    await this.connection.close()
  }

  private observe(event: EdgeWorkerEvent): void {
    if (event.type === 'authenticated') {
      this.authenticated = true
      this.workerId = event.workerId
      this.linkState = 'ready'
    }
    if (event.type === 'closed') this.handleClosed(event.reason)
    this.options.onEvent?.(event)
  }

  private handleClosed(edgeReason: string): void {
    this.edgeReason ??= edgeReason
    this.failureCode ??= classifyEdgeDisconnect(this.edgeReason, this.authenticated)
    this.delivered.clear()
    if (this.closing) {
      this.linkState = 'closed'
      return
    }
    this.linkState = 'failed'
    for (const handler of [...this.disconnects]) handler(this.failureCode)
  }

  /** Translate one authenticated edge offer, or refuse the session when it cannot be admitted. */
  private async deliver(offer: EdgeTaskOffer, _signal: AbortSignal): Promise<void> {
    const context: EdgeOfferContext = { receivedAt: new Date(this.clockNow()).toISOString(), workerId: this.workerId }
    const mapped = this.options.bridge.toNodeOffer(offer, context)
    if ('refuse' in mapped) {
      this.rejectDelivery(offer, `EDGE_OFFER_REFUSED_${mapped.refuse}`, `local admission refused the offer: ${mapped.refuse}`)
      return
    }
    const taskId = mapped.envelope.taskId
    const previous = this.delivered.get(taskId)
    if (previous && previous.identity.shardId !== offer.shardId) {
      // Two distinct edge shards mapping onto one local task identity would make
      // progress and results ambiguous; refuse this one instead of guessing.
      this.rejectDelivery(offer, 'EDGE_OFFER_IDENTITY_CONFLICT', 'two shards mapped onto one local task identity')
      return
    }
    this.delivered.set(taskId, { identity: offer, nodeAttempt: mapped.attempt })
    for (const handler of [...this.offers]) await handler(mapped)
  }

  /**
   * Report a refusal for one assignment, then keep serving the session.
   *
   * Why the session is not closed (measured against the real scheduler on 2026-09-17):
   * after a refusal frame the server marks the shard `FAILED` and stores the reason in
   * its `error` column — but only while the socket is still up. Closing the socket a few
   * milliseconds later made the server reset the shard to `PENDING` with an empty error
   * and re-queue it, which is exactly the "attempts keep rising and there is never any
   * error text" symptom. Closing would also kill everything else this node is running.
   *
   * Reporting stays best-effort: a peer that is already gone must not turn a protocol
   * decision into a thrown transport error.
   */
  private rejectDelivery(offer: EdgeTaskOffer, code: string, message: string): void {
    try { this.connection.reject(offer, { code, message }) }
    catch { /* the peer or the lease is already gone; the decision stays local */ }
  }

  private requireOffer(taskId: string, nodeAttempt: number): DeliveredOffer {
    this.assertUsable()
    const offer = this.delivered.get(taskId)
    if (!offer || offer.nodeAttempt !== nodeAttempt) {
      throw new EdgeWorkerTransportError('TRANSPORT_LEASE_NOT_ACTIVE', this.linkState, 'EDGE_LEASE_NOT_ACTIVE')
    }
    return offer
  }

  private assertUsable(): void {
    if (this.edgeReason !== null) this.throwIfClosed()
    if (!this.authenticated) throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONNECTED', this.linkState, 'EDGE_NOT_AUTHENTICATED')
  }

  /** Convert a failure already recorded by the connection into a classified error. */
  private throwIfClosed(): void {
    if (this.edgeReason === null) return
    throw new EdgeWorkerTransportError(this.failureCode ?? classifyEdgeDisconnect(this.edgeReason, this.authenticated), 'failed', this.edgeReason)
  }

  /** Classify a rejection thrown by the connection itself. */
  private classify(error: unknown): EdgeWorkerTransportError {
    if (error instanceof EdgeWorkerTransportError) return error
    const edgeReason = error instanceof SupplyError ? error.code : this.edgeReason
    if (edgeReason === null) {
      // The socket constructor itself rejected before any event, for example when
      // the runtime has no WebSocket implementation at all.
      return new EdgeWorkerTransportError('TRANSPORT_NETWORK_FAILED', 'failed', 'EDGE_SOCKET_UNAVAILABLE')
    }
    return new EdgeWorkerTransportError(classifyEdgeDisconnect(edgeReason, this.authenticated), 'failed', edgeReason)
  }
}

/**
 * Run one synchronous wire operation under the seam's promise contract.
 *
 * Every `ResidentSession` send returns a promise, and the runtime relies on a
 * refusal arriving as a rejection rather than as a synchronous throw. The
 * underlying socket sends are synchronous, so this wrapper keeps their side
 * effects immediate while preserving exactly that contract.
 * @param operation - Synchronous wire operation that may throw a classified failure.
 * @returns A promise that rejects with whatever the operation threw.
 */
function seamCall(operation: () => void): Promise<void> {
  try {
    operation()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * Connector that hands the resident runtime one real socket session per connect.
 *
 * An unconfigured deployment receives a structured `TRANSPORT_NOT_CONFIGURED`
 * refusal; nothing is opened, nothing is retried and no session is returned.
 */
export class EdgeWorkerResidentConnector implements ResidentSessionConnector {
  /** Owner policy, endpoint and credentials for every session this connector creates. */
  constructor(private readonly options: EdgeWorkerSessionOptions) {}

  /** Open one real socket session, or refuse before opening anything.
   * @param signal - Abort the handshake and the whole session when cancelled.
   * @returns The concrete session, so callers can inspect {@link EdgeWorkerResidentSession.failure}.
   */
  async connect(signal?: AbortSignal): Promise<EdgeWorkerResidentSession> {
    const endpoint = this.options.endpoint
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new EdgeWorkerTransportError('TRANSPORT_NOT_CONFIGURED', 'not-configured')
    }
    const bridge: unknown = this.options.bridge
    if (bridge === null || typeof bridge !== 'object'
      || typeof (bridge as EdgeSessionBridge).toNodeOffer !== 'function'
      || typeof (bridge as EdgeSessionBridge).toEdgeResult !== 'function') {
      throw new EdgeWorkerTransportError('TRANSPORT_BRIDGE_REQUIRED', 'not-configured')
    }
    if (signal?.aborted) throw new EdgeWorkerTransportError('TRANSPORT_ABORTED', 'failed', 'EDGE_ABORTED')
    const session = new EdgeWorkerResidentSession(this.options)
    await session.open(signal)
    return session
  }
}
