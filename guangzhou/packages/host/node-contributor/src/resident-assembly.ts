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
 * - the only transport this package ships is `MemoryResidentConnector`, which
 *   opens no socket. A node on it ticks and publishes a heartbeat, but it can
 *   never reach a dispatcher, so the capability list is empty by construction and
 *   nothing is ever accepted;
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
} from '@deepseek-ai/dsh-compute-core'
import { MemoryResidentConnector } from '@deepseek-ai/dsh-compute-core/transport/memory-session'
import {
  ResidentNodeRuntime,
  type ComputeResidentAttemptExecution,
  type ComputeResidentResultConsumer,
  type ComputeResidentWorkspace,
  type ComputeResidentWorkspaceProvider,
  type ResidentCapability,
  type ResidentLifecycleState,
  type ResidentResourceObservation,
  type ResidentRuntime,
  type ResidentSessionConnector,
  type ResidentTickOutcome,
} from '@deepseek-ai/dsh-compute-core/resident'
import { createResidentControlPort } from './resident-port.ts'

/** Stable failure codes this assembly raises; none is a silent no-op. */
export const NODE_CONTRIBUTOR_FAILURES = {
  /** The host granted no workspace root, so no attempt may stage files. */
  workspaceUnavailable: 'COMPUTE_NODE_CONTRIBUTOR_WORKSPACE_UNAVAILABLE',
  /** No transfer provider exists, so a verified result cannot be delivered. */
  resultTransferUnavailable: 'COMPUTE_NODE_CONTRIBUTOR_RESULT_TRANSFER_UNAVAILABLE',
} as const

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
  clock?: () => number
  stopTimeoutMs?: number
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
}

/** The assembled runtime plus the status projection an operator reads. */
export interface ResidentAssembly {
  readonly runtime: ResidentRuntime
  /** Current status; never performs I/O and never advances the loop. */
  status(): ResidentAssemblyStatus
  /** Run exactly one serialized tick and record it in `status().runs`. */
  tick(): Promise<ResidentTickOutcome>
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
  const coordinator = new EmployeeTaskCoordinator(options.store)
  const { port } = createResidentControlPort({
    nodeId: options.nodeId,
    agentVersion: options.agentVersion,
    policy: options.policy,
    coordinator,
    store: options.store,
    capabilities: () => [],
    transport: {
      // The controller's transport seam only carries heartbeat publication, which
      // the resident session owns. It records nothing this process cannot deliver.
      publishHeartbeat: async () => undefined,
    },
    verifySignature: options.verifySignature,
    leaseOf: options.leaseOf,
  })
  const observer = new ContributorResourceObserver({
    readUserActivity: () => false,
    readVoiceActivity: () => false,
    // No CPU/GPU/thermal probe is bound on this host yet. Zero is the honest
    // "nothing measured" value and is never used to claim spare capacity above
    // the owner's policy ceiling.
    readCpuPercent: () => 0,
    readGpuPercent: () => 0,
    readTemperatureC: () => 0,
    readDiskFreeBytes: async () => workspaceRoot === undefined ? 0 : statfsFreeBytes(workspaceRoot),
  })
  const runtime = new ResidentNodeRuntime({
    nodeId: options.nodeId,
    agentVersion: options.agentVersion,
    policy: options.policy,
    observer: {
      snapshot: async (runningTasks: number): Promise<ResidentResourceObservation> => {
        const snapshot = await observer.sample(runningTasks)
        return {
          snapshot,
          heartbeat: {
            version: 'qianshou.node.v1',
            nodeId: options.nodeId as never,
            agentVersion: options.agentVersion,
            sentAt: new Date(options.clock?.() ?? Date.now()).toISOString(),
            capabilities: [],
            maxConcurrency: options.policy.maxConcurrency,
            runningTasks,
          },
        }
      },
    },
    // Empty by construction: the bound transport cannot reach a dispatcher, so
    // this node advertises no capability it could not honour.
    capabilities: { listCapabilities: (): readonly ResidentCapability[] => [] },
    connector: options.connector ?? new MemoryResidentConnector(),
    port,
    workspace: workspaceProvider(workspaceRoot, maxInputBytes),
    resultConsumer: refusingResultConsumer,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
  })
  let runs = 0
  let lastOutcome: ResidentAssemblyStatus['lastOutcome'] = null
  return {
    runtime,
    status: () => Object.freeze({
      source: 'node-contributor' as const,
      constructed: true as const,
      nodeId: runtime.nodeId,
      transport: options.transport ?? 'memory',
      state: runtime.state(),
      runs,
      inFlight: runtime.inFlightCount(),
      pendingOffers: runtime.pendingOfferCount(),
      lastOutcome,
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
 */
export function productionGaps(options: Pick<ResidentAssemblyOptions, 'workspaceRoot' | 'connector'>): readonly string[] {
  const gaps: string[] = []
  if (options.workspaceRoot === undefined) gaps.push('workspaceRoot')
  if (options.connector === undefined) gaps.push('transport')
  // The control plane this assembly binds always refuses unverified work: no
  // authorized-dispatch key material is configured anywhere in this host yet.
  gaps.push('dispatchVerifier', 'dispatchLeaseSource', 'resultTransfer')
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
  const free = stats.bavail * stats.bsize
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
