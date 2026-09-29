/**
 * Host assembly point for the resident node runtime.
 *
 * The pieces the runtime needs already exist and are individually tested:
 * `ResidentNodeRuntime` (loop, admission, execution, return, drain),
 * `createResidentControlPort` (capability gate, lease binding, decisions) and
 * `ContributorResourceObserver`. What was missing is a *production* construction
 * point: before this module the only non-test `ResidentNodeRuntime` construction
 * lived in `resident-port.ts`, which nothing imported, and the only transport was
 * the in-memory conformance double.
 *
 * Honest boundary, deliberately encoded rather than only written down:
 * - the default transport is `MemoryResidentConnector`, which opens no socket.
 *   A deployment that lists allowed task types and a non-OFF mode binds the HMAC
 *   inline Edge connector instead; the socket still opens only on `start()`;
 * - local execution needs a host-granted workspace root. Without one,
 *   `createWorkspace` and `consume` refuse with a stable code instead of
 *   returning a fabricated success.
 *
 * A deployment that supplies a real `ResidentSessionConnector` and a workspace
 * root gets a constructible, drivable loop without changing this file.
 */
import { mkdir, statfs } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  ComputeError,
  ComputeTaskStore,
  ContributorResourceObserver,
  EmployeeTaskCoordinator,
  type ComputeTaskSignatureVerifier,
  type ContributorPolicy,
  type EdgeResultSent,
} from '@deepseek-ai/dsh-compute-core'
import { isResultAcceptanceObserved } from '@deepseek-ai/dsh-compute-core/edge-worker/polled-verification'
import { MemoryResidentConnector } from '@deepseek-ai/dsh-compute-core/transport/memory-session'
import {
  ResidentNodeRuntime,
  type ComputeResidentAttemptExecution,
  type ComputeResidentResultConsumer,
  type ComputeResidentWorkspace,
  type ComputeResidentWorkspaceProvider,
  type ResidentCapability,
  type ResidentInFlightAttempt,
  type ResidentLifecycleState,
  type ResidentResourceObservation,
  type ResidentRuntime,
  type ResidentRuntimeConfig,
  type ResidentSession,
  type ResidentSessionConnector,
  type ResidentTickOutcome,
} from '@deepseek-ai/dsh-compute-core/resident'
import { createResidentControlPort } from './resident-port.ts'
import type { ResidentResultVerification } from './edge-binding.ts'

/** Stable failure codes this assembly raises; none is a silent no-op. */
export const NODE_CONTRIBUTOR_FAILURES = {
  /** The host granted no workspace root, so no attempt may stage files. */
  workspaceUnavailable: 'COMPUTE_NODE_CONTRIBUTOR_WORKSPACE_UNAVAILABLE',
  /** No transfer provider exists, so a verified result cannot be delivered. */
  resultTransferUnavailable: 'COMPUTE_NODE_CONTRIBUTOR_RESULT_TRANSFER_UNAVAILABLE',
} as const

/**
 * The read a transport must offer to report what happened after a result was sent.
 *
 * `edge-binding.ts` implements it on the session it returns from `connect()`. The
 * seam is structural on purpose: this assembly must not require an Edge
 * deployment to be constructed, and the in-memory conformance double simply does
 * not answer it — which is a fact, not a failure.
 */
export interface ResultVerificationSource {
  onResultVerification(handler: (record: ResidentResultVerification) => void): () => void
}

/** Conclusions waiting for the attempt's own `RETURNED`; a queue nothing drains must not grow. */
const VERIFICATION_QUEUE_LIMIT = 64
/** Ticks one conclusion may wait for its attempt to reach `RETURNED`. */
const VERIFICATION_APPLY_ATTEMPTS = 16
/** Records kept in the status projection. */
const VERIFICATION_RECENT_LIMIT = 16

/**
 * Read the verification seam off one session, or report that this transport has none.
 * @param session - The session the runtime will drive.
 * @returns The source, or null when this transport cannot report anything.
 */
function resultVerificationSourceOf(session: ResidentSession): ResultVerificationSource | null {
  const candidate: unknown = session
  if (candidate === null || typeof candidate !== 'object') return null
  const method = (candidate as { onResultVerification?: unknown }).onResultVerification
  return typeof method === 'function' ? candidate as ResultVerificationSource : null
}

/** One assembly option set; every seam is explicit so deployment policy is inspectable. */
export interface ResidentAssemblyOptions {
  nodeId: string
  agentVersion: string
  policy: ContributorPolicy
  /** Durable attempt records; the control port reads them back for the runtime. */
  store: ComputeTaskStore
  /** Authorized-dispatch signature verifier; it owns the key material. */
  verifySignature: ComputeTaskSignatureVerifier
  /** Lease metadata carried out of band beside the signed offer. */
  leaseOf: (taskId: string, attempt: number, expiresAt: string) => unknown
  /**
   * Absolute root for per-attempt workspaces. Absent means no attempt can stage
   * its inputs on this host.
   */
  workspaceRoot?: string
  /** Maximum bytes staged per attempt workspace; used with `workspaceRoot`. */
  maxInputBytes?: number
  /**
   * Transport actually bound. Defaults to the in-memory conformance double,
   * which never opens a socket; a deployment with a real connector passes it here.
   */
  connector?: ResidentSessionConnector
  /** Transport kind reported in the status projection. */
  transport?: string
  /** Locally self-tested capabilities advertised on heartbeats and used for admission. */
  capabilities?: () => readonly ResidentCapability[]
  /** Result consumer; defaults to a structured refusal when no transfer provider exists. */
  resultConsumer?: ComputeResidentResultConsumer
  /** Exact authenticated input reader; absent retains the resident runtime's refusal. */
  inputSource?: ResidentRuntimeConfig['inputSource']
  /**
   * Real host-activity port the `allowWhileUserActive` policy is judged on.
   *
   * Absent means this deployment never bound one, and the projection says so
   * (`hostActivity.measured: false`) instead of quietly answering "not active".
   */
  hostActivity?: HostActivityPort
  /** Real voice-activity producer; absent means unknown, never "no voice". */
  voiceActivity?: () => boolean | null | Promise<boolean | null>
  clock?: () => number
  stopTimeoutMs?: number
}

/** One measured activity answer; `null` fields mean this host could not tell. */
export interface HostActivityReading {
  readonly userActive: boolean | null
  readonly idleSeconds: number | null
  /** Stable code when the idle measurement is unavailable on this host. */
  readonly unavailable: string | null
}

/** Real activity source bound by the deployment (see `createHostIdleReader`). */
export interface HostActivityPort {
  read(): Promise<HostActivityReading>
}

/** What the status projection says about the activity facts behind `allowWhileUserActive`. */
export interface ResidentHostActivityStatus {
  /** True/false only when it was measured; `null` means this host cannot tell. */
  readonly userActive: boolean | null
  /** Measured idle seconds, or null when unmeasured. */
  readonly idleSeconds: number | null
  readonly voiceActive: boolean | null
  /** True once a real activity port is bound; false means nothing is measuring here. */
  readonly measured: boolean
  /** Stable code when the idle reading is unknown (`IDLE_PROBE_UNSUPPORTED` / `IDLE_PROBE_FAILED`). */
  readonly unavailable: string | null
  /**
   * Whether `allowWhileUserActive: false` can actually be enforced right now.
   *
   * False is not an error: unknown activity lets work through by owner decision, and this
   * flag is how the owner sees that the policy has no basis on this host.
   */
  readonly policyEnforceable: boolean
}

/**
 * One conclusion a sent result reached on this node, and what this assembly did with it.
 *
 * `outcome`/`disposition` are C25's four states and its single mapping table, read
 * through `isResultAcceptanceObserved` — this module never re-derives them.
 */
export interface ResidentResultVerificationEntry {
  readonly taskId: string
  readonly attempt: number
  /** The workload the read side was addressed by; the tuple travels with the record. */
  readonly workloadId: string
  /** The transport fact the resident seam used to drop. */
  readonly sent: EdgeResultSent['state']
  /** C25's `PolledVerificationOutcome`, read straight off the record rather than restated. */
  readonly outcome: ResidentResultVerification['verification']['outcome']
  /** C25's `PolledVerificationDisposition` from the same single mapping table. */
  readonly disposition: ResidentResultVerification['verification']['disposition']
  readonly polls: number
  readonly failedPolls: number
  /** Stable reason for an `unobservable` outcome, else null. Never an upstream body. */
  readonly code: string | null
  /**
   * What happened to the attempt's **existing** state, never a claim the platform made.
   *
   * - `settled`: the attempt's durable record moved `RETURNED → SETTLED`, the one existing
   *   completion path, reached only from C25's `settleable` disposition;
   * - `not-settleable`: the conclusion was `retryable`/`retained`/`indeterminate`, so nothing was
   *   recorded as complete and the attempt stays exactly where the send left it;
   * - `awaiting-returned-attempt`: the attempt's own `RETURNED` is not durable yet; kept and
   *   retried on a later tick, bounded;
   * - `attempt-not-found` / `attempt-not-returned`: no legal completion exists for this record;
   * - `settle-refused`: the store refused the transition; the reason is in `code`.
   */
  readonly applied:
    | 'settled'
    | 'not-settleable'
    | 'awaiting-returned-attempt'
    | 'attempt-not-found'
    | 'attempt-not-returned'
    | 'settle-refused'
}

/** What this assembly observed about the results it already sent; counts and the newest records. */
export interface ResidentResultVerificationStatus {
  /** Records published by the bound transport since construction. */
  readonly observed: number
  /** Records applied to the durable attempt state; only `settleable` ever reaches this. */
  readonly settled: number
  /** Records discarded because nothing drained the queue inside the bound. */
  readonly dropped: number
  /** Records still waiting for the attempt's own `RETURNED` to become durable. */
  readonly pending: number
  /** Newest last, bounded. Empty on a transport that cannot report anything. */
  readonly recent: readonly ResidentResultVerificationEntry[]
}

/**
 * Stable, content-free projection of the resident loop.
 *
 * `runs` and `lastOutcome` are the observable facts an operator reads: they say
 * the loop was constructed and driven, never that a task was accepted from a peer.
 */
export interface ResidentAssemblyStatus {
  /** Stable marker for the module that produced this projection. */
  source: 'node-contributor'
  /** The runtime object exists in this process. */
  constructed: true
  nodeId: string
  /** Transport actually bound; `memory` never opens a socket. */
  transport: string
  /** Durable lifecycle state. */
  state: ResidentLifecycleState
  /** Successful `tickOnce()` calls observed by this assembly. */
  runs: number
  /** Attempts the runtime currently owns. */
  inFlight: number
  /** Attempts whose runner has not returned. Fraction `0` means started, not finished. */
  running: readonly ResidentInFlightAttempt[]
  /** Verified offers buffered for the next tick. */
  pendingOffers: number
  /** Last tick result, or null before the first tick. */
  lastOutcome: {
    sentHeartbeat: boolean
    heartbeatSequence: number | null
    runningTasks: number
    /** Coarse local admission classification per offer, in offer order. */
    outcomes: readonly { accepted: boolean; reason: string }[]
  } | null
  /** The activity facts `allowWhileUserActive` is judged on, including "cannot tell" (AT-10). */
  hostActivity: ResidentHostActivityStatus
  /**
   * What polling the platform's own projection observed for results this node already sent.
   *
   * This is the resident path's answer to "发出之后发生什么". It is filled only by a transport
   * that reports conclusions (`edge-binding.ts`); the in-memory conformance double reports none,
   * and an empty projection here means exactly that rather than "everything was accepted".
   */
  resultVerification: ResidentResultVerificationStatus
}

/** The assembled runtime plus the status projection an operator reads. */
export interface ResidentAssembly {
  readonly runtime: ResidentRuntime
  /** Current status; never performs I/O and never advances the loop. */
  status(): ResidentAssemblyStatus
  /** Run exactly one serialized tick and record it in `status().runs`. */
  tick(): Promise<ResidentTickOutcome>
  /**
   * Apply one policy to both the runtime and the admission controller.
   * Updating only the runtime leaves the controller on the policy from construction.
   * @param policy - The policy that applies on the next offer.
   */
  applyPolicy(policy: ContributorPolicy): void
}

/**
 * Build the resident loop over the real control plane.
 * @param options - Node identity, policy, store, verifier, lease source and optional seams.
 * @returns The constructed runtime and its status projection.
 */
export function createResidentAssembly(options: ResidentAssemblyOptions): ResidentAssembly {
  const workspaceRoot = options.workspaceRoot === undefined ? undefined : validRoot(options.workspaceRoot)
  const maxInputBytes = options.maxInputBytes ?? 1_048_576
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0) throw new ComputeError('COMPUTE_WORKSPACE_CONFIG_INVALID')
  const rawAdvertised = options.capabilities ?? ((): readonly ResidentCapability[] => [])
  const advertised = (): readonly ResidentCapability[] => {
    // One semantic capability can have several independently reviewed task
    // adapters. The control port and wire heartbeat both require a unique
    // capability/version; exact adapter digests remain in the WS Hello.
    const byKey = new Map<string, ResidentCapability>()
    for (const item of rawAdvertised()) {
      const key = `${item.capabilityId}\u0000${item.version}`
      if (!byKey.has(key) || (!byKey.get(key)?.available && item.available)) byKey.set(key, item)
    }
    return [...byKey.values()]
  }
  // Conclusions published by the bound transport, waiting for the attempt's own `RETURNED` and a tick.
  const queue: { record: ResidentResultVerification; tries: number }[] = []
  const recentVerifications: ResidentResultVerificationEntry[] = []
  let observedVerifications = 0
  let droppedVerifications = 0
  let settledVerifications = 0
  const rememberVerification = (entry: ResidentResultVerificationEntry): void => {
    recentVerifications.push(Object.freeze(entry))
    while (recentVerifications.length > VERIFICATION_RECENT_LIMIT) recentVerifications.shift()
  }
  const coordinator = new EmployeeTaskCoordinator(options.store)
  const { port, controller } = createResidentControlPort({
    nodeId: options.nodeId,
    agentVersion: options.agentVersion,
    policy: options.policy,
    coordinator,
    store: options.store,
    capabilities: advertised,
    transport: {
      // The controller's transport seam only carries heartbeat publication, which
      // the resident session owns. It records nothing this process cannot deliver.
      publishHeartbeat: async () => undefined,
    },
    verifySignature: options.verifySignature,
    leaseOf: options.leaseOf,
  })
  // Last readings, kept for the status projection: an operator must be able to see that the
  // host cannot measure activity, rather than inferring it from a policy that never fires.
  let lastActivity: HostActivityReading = { userActive: null, idleSeconds: null, unavailable: null }
  let lastVoice: boolean | null = null
  const activityPort = options.hostActivity
  const observer = new ContributorResourceObserver({
    // Unknown stays unknown (`null`) all the way into admission: `decideContribution` blocks
    // only on a measured `true`, so a host without an idle probe still ticks and still takes
    // work — the owner's decision — while the status below reports the hole.
    readUserActivity: async () => {
      if (activityPort === undefined) return null
      lastActivity = await activityPort.read()
      return lastActivity.userActive
    },
    readVoiceActivity: async () => {
      if (options.voiceActivity === undefined) return null
      lastVoice = (await options.voiceActivity()) ?? null
      return lastVoice
    },
    // No CPU/GPU/thermal probe is bound on this host yet. Zero is the honest
    // "nothing measured" value and is never used to claim spare capacity above
    // the owner's policy ceiling.
    readCpuPercent: () => 0,
    readGpuPercent: () => 0,
    readTemperatureC: () => 0,
    readDiskFreeBytes: async () => workspaceRoot === undefined ? 0 : statfsFreeBytes(workspaceRoot),
  })
  /**
   * The transport, with one subscription added.
   *
   * The resident seam used to drop `connection.complete`'s return value
   * (`transport/edge-worker-session.ts:298`), so nothing on this path could say what happened after
   * a result went out. A transport that can report conclusions hands them over here; one that cannot
   * (the in-memory conformance double) contributes no records and no invented ones.
   */
  const innerConnector = options.connector ?? new MemoryResidentConnector()
  const connector: ResidentSessionConnector = {
    connect: async (signal: AbortSignal): Promise<ResidentSession> => {
      const session = await innerConnector.connect(signal)
      const source = resultVerificationSourceOf(session)
      source?.onResultVerification((record) => {
        observedVerifications += 1
        queue.push({ record, tries: 0 })
        // Bounded: a queue nothing drains must not grow with the node's uptime. Dropping is
        // counted, never silent.
        if (queue.length > VERIFICATION_QUEUE_LIMIT) {
          queue.shift()
          droppedVerifications += 1
        }
      })
      return session
    },
  }
  /**
   * Land each conclusion in the attempt's **existing** task state.
   *
   * Only C25's `settleable` disposition may do anything here, and the only thing it may do is the
   * one transition this repository already has for a returned attempt (`RETURNED → SETTLED`).
   * `indeterminate`/`retained`/`retryable` leave the durable record exactly where the send left it,
   * which is what "未知不得被记为成功" means as state rather than as a log line.
   */
  const applyResultVerifications = async (): Promise<void> => {
    if (queue.length === 0) return
    const queued = queue.splice(0, queue.length)
    for (const item of queued) {
      const { record } = item
      let applied: ResidentResultVerificationEntry['applied']
      if (!isResultAcceptanceObserved(record.verification)) {
        applied = 'not-settleable'
      } else {
        const state = await port.state(record.taskId, record.attempt).catch(() => null)
        if (state === null) {
          applied = 'attempt-not-found'
        } else if (state.status === 'RETURNED') {
          try {
            await runtime.settle(record.taskId, record.attempt)
            settledVerifications += 1
            applied = 'settled'
          } catch {
            // The store refused the transition. The attempt is not reported as complete and the
            // refusal stays visible on that record instead of being thrown at the loop.
            applied = 'settle-refused'
          }
        } else if (state.status !== 'SETTLED' && state.status !== 'FAILED' && state.status !== 'REVOKED'
          && state.status !== 'REFUSED' && state.status !== 'EXPIRED'
          && item.tries < VERIFICATION_APPLY_ATTEMPTS) {
          // The attempt is still on its way to `RETURNED`; keep the record for a later tick.
          applied = 'awaiting-returned-attempt'
          queue.push({ record, tries: item.tries + 1 })
        } else {
          applied = 'attempt-not-returned'
        }
      }
      rememberVerification({
        taskId: record.taskId,
        attempt: record.attempt,
        workloadId: record.identity.workloadId,
        sent: record.sent,
        outcome: record.verification.outcome,
        disposition: record.verification.disposition,
        polls: record.verification.polls,
        failedPolls: record.verification.failedPolls,
        code: record.verification.code,
        applied,
      })
    }
  }
  const runtime = new ResidentNodeRuntime({
    nodeId: options.nodeId,
    agentVersion: options.agentVersion,
    policy: options.policy,
    observer: {
      snapshot: async (runningTasks: number): Promise<ResidentResourceObservation> => {
        const snapshot = await observer.sample(runningTasks)
        // The heartbeat describes a capability/version once. Multiple reviewed
        // adapters may implement it; their exact digests travel separately in
        // verified_task_adapters, which is the dispatch compatibility proof.
        const seen = new Set<string>()
        const capabilities = advertised().filter((item) => {
          if (runtime.policy().mode === 'OFF' || !item.available) return false
          const key = `${item.capabilityId}\u0000${item.version}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).map(item => Object.freeze({
          capabilityId: item.capabilityId as never,
          version: item.version,
          pluginDigest: item.pluginDigest,
        }))
        return {
          snapshot,
          heartbeat: {
            version: 'qianshou.node.v1',
            nodeId: options.nodeId as never,
            agentVersion: options.agentVersion,
            sentAt: new Date(options.clock?.() ?? Date.now()).toISOString(),
            capabilities,
            // The existing wire format requires capacity to include already leased slots.
            // Admission still uses the stricter live policy while excess attempts drain.
            maxConcurrency: Math.max(runtime.policy().maxConcurrency, runningTasks),
            runningTasks,
          },
        }
      },
    },
    capabilities: { listCapabilities: advertised },
    connector,
    port,
    workspace: workspaceProvider(workspaceRoot, maxInputBytes),
    ...(options.inputSource === undefined ? {} : { inputSource: options.inputSource }),
    resultConsumer: options.resultConsumer ?? refusingResultConsumer,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
  })
  let runs = 0
  let lastOutcome: ResidentAssemblyStatus['lastOutcome'] = null
  const applyPolicy = (policy: ContributorPolicy): void => {
    runtime.setPolicy(policy)
    controller.setPolicy(policy)
  }
  return {
    runtime,
    applyPolicy,
    status: () => Object.freeze({
      source: 'node-contributor' as const,
      constructed: true as const,
      nodeId: runtime.nodeId,
      transport: options.transport ?? 'memory',
      state: runtime.state(),
      runs,
      inFlight: runtime.inFlightCount(),
      running: runtime.inFlightAttempts(),
      pendingOffers: runtime.pendingOfferCount(),
      lastOutcome,
      resultVerification: Object.freeze({
        observed: observedVerifications,
        settled: settledVerifications,
        dropped: droppedVerifications,
        pending: queue.length,
        recent: Object.freeze([...recentVerifications]),
      }),
      hostActivity: Object.freeze({
        userActive: lastActivity.userActive,
        idleSeconds: lastActivity.idleSeconds,
        voiceActive: lastVoice,
        measured: activityPort !== undefined,
        unavailable: activityPort === undefined ? 'ACTIVITY_PORT_UNBOUND' : lastActivity.unavailable,
        // 缺口说清楚：本机测不到活动 ⇒ `allowWhileUserActive: false` 在这里没有依据。
        policyEnforceable: lastActivity.userActive !== null || lastVoice !== null,
      }),
    }),
    tick: async () => {
      const outcome = await runtime.tickOnce()
      runs += 1
      lastOutcome = Object.freeze({
        sentHeartbeat: outcome.sentHeartbeat,
        heartbeatSequence: outcome.heartbeatSequence,
        runningTasks: outcome.runningTasks,
        outcomes: Object.freeze(outcome.outcomes.map(item => Object.freeze({
          accepted: item.accepted,
          reason: item.reason,
        }))),
      })
      // Applied on the tick that already exists (the resident loop drives one per second), so a
      // conclusion never needs a driver of its own — and the durable `RETURNED` it depends on has
      // had a whole tick to land. This never rejects: a verification problem is not a tick failure,
      // and it is recorded in the projection rather than thrown at the loop.
      await applyResultVerifications()
      return outcome
    },
  }
}


/**
 * The production seams this host does not have yet, in a stable order.
 *
 * These are *gaps in the deployment*, not construction failures: the assembly
 * still builds, still ticks and still refuses everything, because a node that
 * cannot stage work or reach a dispatcher must advertise nothing. Naming them
 * here is what keeps a status reader from mistaking "constructed" for "earning".
 *
 * 注意（C19 档 1 登记，依据 `docs/dev-plan/report-C16-N1准入证据与收紧方案.md` §A3）：
 * `dispatchBound` / `resultBound` 是**调用方的断言**，本函数无法核对——它回答的是"调用方说这些
 * seam 补齐了没有"，而不是"这些 seam 真的存在"。于是调用方传一个字面量 `true`，缺口就**静默**
 * 消失，而这个数组读起来仍像"缺口都补上了"。默认 profile 下 `productionGaps` 恒空正是这样来的
 * （见 `plugin.ts` 的调用点），所以这个数组**不是** readiness 判据。调用方必须在旁边给出依据：
 * `plugin.ts` 现在把它发布成 `NodeContributorStatus.gapsBasis`（含 `satisfiedByAssertion`，
 * 逐个点名被字面量抹掉的项），并由 `tests/gaps-basis.spec.ts` 钉住。
 */
export function productionGaps(options: Pick<ResidentAssemblyOptions, 'workspaceRoot' | 'connector'> & {
  dispatchBound?: boolean
  resultBound?: boolean
}): readonly string[] {
  const gaps: string[] = []
  if (options.workspaceRoot === undefined) gaps.push('workspaceRoot')
  if (options.connector === undefined) gaps.push('transport')
  if (options.dispatchBound !== true) {
    gaps.push('dispatchVerifier', 'dispatchLeaseSource')
  }
  if (options.resultBound !== true) gaps.push('resultTransfer')
  return Object.freeze(gaps)
}

function validRoot(root: string): string {
  if (!isAbsolute(root) || root.includes('\u0000')) throw new ComputeError('COMPUTE_WORKSPACE_CONFIG_INVALID')
  return root
}

/** Measured free bytes on the filesystem holding one host-granted directory. */
async function statfsFreeBytes(root: string): Promise<number> {
  let stats
  try {
    stats = await statfs(root)
  } catch {
    // A deployment names its attempt root before anything has been staged there.
    // Creating it is the host's own storage policy, and it keeps this measurement
    // a measured fact instead of a guess.
    await mkdir(root, { recursive: true, mode: 0o700 })
    stats = await statfs(root)
  }
  return measuredFreeBytes(stats.bavail, stats.bsize)
}

/**
 * Convert a `statfs` block count into a byte total the policy can compare.
 * @param bavail - Free blocks available to a non-root caller.
 * @param bsize - Byte size of one block.
 * @returns A non-negative safe integer, or 0 when the product overflows.
 */
export function measuredFreeBytes(bavail: number, bsize: number): number {
  const free = bavail * bsize
  return Number.isSafeInteger(free) && free >= 0 ? free : 0
}

/**
 * Workspace provider for the resident runtime.
 *
 * It stages an attempt's authorized inputs through the host-provided
 * `ComputeResidentAttemptSource` and hands the runtime a private directory. It
 * never invents inputs and never reports a workspace it did not create.
 */
function workspaceProvider(root: string | undefined, maxInputBytes: number): ComputeResidentWorkspaceProvider {
  return {
    createWorkspace: async (execution: ComputeResidentAttemptExecution): Promise<ComputeResidentWorkspace> => {
      if (root === undefined) throw new ComputeError(NODE_CONTRIBUTOR_FAILURES.workspaceUnavailable, 503)
      const { prepareTaskWorkspace } = await import('@deepseek-ai/dsh-compute-core/task-workspace')
      const workspace = await prepareTaskWorkspace(
        { rootPath: root, maxInputBytes },
        execution.task,
        execution.source,
        execution.signal,
      )
      // `outputs` stays empty here, and that is the measured truth rather than a
      // missing wire. The runtime calls this provider *before* anything runs
      // (`runtime.ts:461` precedes the `consume` at `:465`), and
      // `prepareTaskWorkspace` stages authorized *inputs* only — at this instant
      // the attempt has produced nothing. Whatever this attempt does produce is
      // returned by the bound `resultConsumer` and travels on
      // `task.return.outputs`.
      //
      // This field is marked **NOT WIRED / no production reader** on the type
      // itself: see `ComputeResidentWorkspaceOutputs` in
      // `compute-core/src/resident/types.ts`. Never substitute a non-empty guess
      // here — this assembly's provider does not own execution, so any value it
      // wrote would report artifacts it cannot observe (and would still reach no
      // wire: `inline-edge-bridge.ts` `toEdgeResult` drops the outputs list).
      // `resident-assembly.spec.ts` pins both directions of that boundary.
      return { path: workspace.path, outputs: Object.freeze([]), close: () => workspace.close() }
    },
  }
}

/**
 * Result consumer for a host with no transfer provider.
 *
 * A verified output can only leave this process through a provider that owns the
 * upload authorization, and no such provider exists yet. This returns a stable
 * refusal so the attempt is recorded as a real failure instead of a fabricated
 * receipt that would let the node claim a delivered result.
 */
const refusingResultConsumer: ComputeResidentResultConsumer = {
  consume: async () => {
    throw new ComputeError(NODE_CONTRIBUTOR_FAILURES.resultTransferUnavailable, 503)
  },
}
