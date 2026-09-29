/** The server binds this tuple to an authenticated socket and its opaque lease token. */
export interface EdgeTaskIdentity {
  readonly workerId: string
  readonly workloadId: string
  readonly shardId: string
  readonly attempt: number
}

/** Task data from an authenticated test connection, requiring separate Host execution authorization. */
export interface EdgeTaskOffer extends EdgeTaskIdentity {
  readonly taskType: string
  readonly runtime: string
  readonly inputKind: string
  readonly inlineInput: string | null
  readonly inputRef: string
  readonly inputRefs: readonly string[]
  /** Task parameters delivered by the authenticated dispatcher; still untrusted input. */
  readonly params?: Readonly<Record<string, unknown>>
  readonly codeUrl: string
  readonly codeSha256: string
  readonly timeoutSeconds: number
  readonly verificationPolicy: 'semantic' | 'artifact' | 'quarantine'
  readonly executionModel: string
  readonly capability: string
  readonly capabilityVersion: string
  /** Exact Runtime V2 wire version; an absent legacy field never opts into video. */
  readonly runtimeApi?: string
  /** Hash of this assignment's opaque active lease token, never the token itself. */
  readonly leaseTokenSha256?: string
  /** Separately signed reviewed-video order; opaque until Host Ed25519 verification. */
  readonly reviewedVideoOrder?: unknown
  /** Server-frozen ordinary native identity, independent of buyer parameters and presence TTL. */
  readonly nativeDeviceLease?: import('../native-h3-task-lease.ts').NativeH3TaskLeaseV2
  readonly fileContract?: import('./file-task-contract.ts').EdgeFileContract
}

/** Existing inline_output result form. Session/tool provenance remains in the Host's own evidence. */
export interface EdgeInlineResult {
  readonly inlineOutputUtf8: string
  readonly elapsedMs: number
}

/** Server-issued artifact.v1 reference. Media bytes travel directly to object storage. */
export interface EdgeArtifactManifest {
  readonly schema: 'artifact.v1'
  readonly object_key: string
  /** Immutable object-store version returned by the actual media PUT, not the presign response. */
  readonly object_version_id: string
  readonly filename: string
  readonly size_bytes: number
  readonly content_type: string
  readonly sha256: string
  readonly result_id: string
  readonly shard_id: string
  readonly workload_id: string
  readonly account_id: number
}

/** A result whose object bytes were uploaded under this same active lease. */
export interface EdgeArtifactResult {
  readonly artifact: EdgeArtifactManifest
  readonly elapsedMs: number
}

/** A local send receipt, never a server result acceptance or settlement receipt. */
export interface EdgeResultSent {
  readonly state: 'sent-awaiting-verification'
}

/**
 * What polling the platform's own workload projection did or did not show.
 *
 * Deliberately not named `receipt`/`ack`/`confirmed`: the platform sends this node
 * no acknowledgement frame (C7 N6 — the inbound set is `welcome`, `auth_ok`,
 * `hb_ack`, `shard_assign`, `shard_cancel`, `err`), so the only thing a node can
 * honestly observe is the platform's **own** workload projection, polled over the
 * already-audited HTTP read side. Two limits are part of the naming, not merely of
 * this comment:
 *
 * - it is **polled**: the platform never pushed anything to this node;
 * - it is **aggregate**: `GET /api/v8/workloads/{id}` reports per-workload
 *   `completed_shards`/`failed_shards` counts and carries no shard, worker or
 *   attempt identity, so a movement is not attributable to *this* shard.
 */
export type PolledVerificationOutcome =
  /** The projection reports one more completed shard for this workload than it did before the send. */
  | 'workload-completed-shard-observed'
  /** The projection reports one more failed shard for this workload than it did before the send. */
  | 'workload-failed-shard-observed'
  /** Every read succeeded but no counter moved inside the window: still undecided, not a failure. */
  | 'no-change-within-window'
  /** Nothing usable could be read (transport, timeout, authorization, malformed body, no baseline). */
  | 'unobservable'

/**
 * Every state one submitted result can be recorded in on this node.
 *
 * `sent-awaiting-verification` is the transport fact and stays exactly what it was.
 * The other four are produced by polling, and only one of them may be settled on.
 */
export type EdgeResultState = EdgeResultSent['state'] | PolledVerificationOutcome

/** What a caller may do with an outcome; only `settleable` means acceptance was observed. */
export type PolledVerificationDisposition = 'settleable' | 'retryable' | 'retained' | 'indeterminate'

/** The per-workload shard counters the platform projection reported at one instant. */
export interface WorkloadShardCounters {
  readonly completedShards: number
  readonly failedShards: number
}

/**
 * Why this node will not run one delivered assignment.
 *
 * A stable code plus a bounded reason: the scheduler needs a machine code it can
 * act on, an operator needs text it can read. The code travels in the refusal
 * frame's `failure_class`, so it stays within the documented field convention of
 * the other audit codes on this seam.
 */
export interface EdgeTaskFailure {
  /** Stable machine code, for example `EDGE_TASK_SCOPE_DENIED`. */
  readonly code: string
  /** One bounded human-readable sentence; never a token and never a raw frame body. */
  readonly message: string
}

/** Safe connection events omit raw network messages and lease credentials. */
export type EdgeWorkerEvent =
  | { readonly type: 'authenticated'; readonly workerId: string; readonly ownerId: number }
  | { readonly type: 'heartbeat-acknowledged' }
  | { readonly type: 'closed'; readonly reason: string }

/** Transport-only operations. The Host owns task policy, autonomous sessions and outcome reconciliation. */
export interface EdgeWorkerPort {
  connect(signal?: AbortSignal): Promise<void>
  updateMode(mode: 'running' | 'paused'): void
  reportProgress(identity: EdgeTaskIdentity, fraction: number): void
  complete(identity: EdgeTaskIdentity, result: EdgeInlineResult): EdgeResultSent
  /**
   * Tell the server this node will not run one delivered assignment.
   *
   * Without a refusal frame the wire could only express "a result" or "silence":
   * a refused offer left the shard `DISPATCHED` until its lease expired, with an
   * empty `error` and the escrow held for that whole window (AT-14).
   * @param identity - Exact identity tuple received in the task offer.
   * @param failure - Stable code and bounded reason for the refusal.
   */
  reject(identity: EdgeTaskIdentity, failure: EdgeTaskFailure): void
  close(): Promise<void>
}
