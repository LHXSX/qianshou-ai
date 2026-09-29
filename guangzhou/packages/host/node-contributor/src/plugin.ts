/** Cordis plugin entry for the resident node contributor.
 *
 * Before this module the package had no importer and no patch row: the resident
 * loop could only be constructed by a test. This entry is the production assembly
 * point. It constructs `ResidentNodeRuntime` through {@link createResidentAssembly}
 * and publishes one read-only status projection.
 *
 * What it deliberately does *not* do:
 * - it never starts the loop on its own (`autoStart` defaults to false), so a
 *   profile that mounts this row opens no session until an operator asks;
 * - it never claims task acceptance: the bound transport is the in-memory
 *   conformance double, which opens no socket, so the advertised capability list
 *   is empty and every offer is refused before execution;
 * - it never verifies a signature without key material. With no
 *   authorized-dispatch verifier configured, `verifyOffer` refuses with a stable
 *   code instead of trusting an unverified offer.
 */
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  ComputeError,
  ComputeTaskStore,
  decideContribution,
  type ComputeTaskSignatureVerifier,
  type ContributorPolicy,
  type ContributorSnapshot,
} from '@deepseek-ai/dsh-compute-core'
import z from '@deepseek-ai/schemastery'
import { NodeContributorError } from './errors.ts'
import {
  createResidentAssembly,
  productionGaps,
  type ResidentAssembly,
  type ResidentAssemblyStatus,
} from './resident-assembly.ts'

/** Cordis service key this plugin provides. */
export const NODE_CONTRIBUTOR_SERVICE = 'nodeContributor'

/** Stable plugin identity. */
export const name = 'qianshou-node-contributor'

/** The status route needs the authenticated Connection carrier. */
export const inject = ['connection']

/** Owner policy, identity and storage for one resident contributor node. */
export interface Config {
  /** Provider-issued node identity used for lease binding and decision reporting. */
  nodeId?: string
  agentVersion?: string
  /** Contribution mode; `OFF` keeps the node idle while the loop stays constructible. */
  mode?: 'OFF' | 'BACKGROUND_ONLY' | 'OPPORTUNISTIC'
  maxConcurrency?: number
  maxCpuPercent?: number
  maxGpuPercent?: number
  maxTemperatureC?: number
  minDiskFreeBytes?: number
  /** Accept work while the owner is active; forced false while mode is `OFF`. */
  allowWhileUserActive?: boolean
  /** Start the loop during `apply()`. Off by default: no session opens unasked. */
  autoStart?: boolean
  /** Absolute attempt-workspace root; empty leaves local execution unavailable. */
  workspaceRoot?: string
  /** Maximum bytes staged per attempt workspace. */
  maxInputBytes?: number
  /** Absolute durable attempt-record path; empty resolves under the Harness home. */
  storePath?: string
  /** Maximum retained attempt records. */
  maxTaskRecords?: number
  /** Maximum bytes of the attempt-record file. */
  maxStoreBytes?: number
}

/** Runtime-validated node identity, policy and storage limits. */
export const Config: z<Config> = z.object({
  nodeId: z.string().default(''),
  agentVersion: z.string().default(''),
  mode: z.union(['OFF', 'BACKGROUND_ONLY', 'OPPORTUNISTIC']).default('OFF'),
  maxConcurrency: z.number().step(1).min(1).max(64).default(1),
  maxCpuPercent: z.number().min(0).max(100).default(50),
  maxGpuPercent: z.number().min(0).max(100).default(0),
  maxTemperatureC: z.number().min(1).max(150).default(80),
  minDiskFreeBytes: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(10_737_418_240),
  allowWhileUserActive: z.boolean().default(false),
  autoStart: z.boolean().default(false),
  workspaceRoot: z.string().default(''),
  maxInputBytes: z.number().step(1).min(0).max(268_435_456).default(1_048_576),
  storePath: z.string().default(''),
  maxTaskRecords: z.number().step(1).min(1).max(10_000).default(1_000),
  maxStoreBytes: z.number().step(1).min(65_536).max(33_554_432).default(4_194_304),
})

/**
 * Read-only projection of the resident loop.
 *
 * `driver` separates the two states an operator must never confuse: `idle` means
 * a constructible runtime exists and the loop was not started, `running` means
 * someone drove it. Neither state claims a peer ever offered work.
 */
export interface NodeContributorStatus {
  /** Stable marker for the module that produced this projection. */
  source: 'node-contributor'
  /** The resident runtime object exists in this process. */
  constructed: boolean
  /** Policy mode currently in force. */
  mode: ContributorPolicy['mode']
  /** `idle` until the loop is started or ticked; `running` once it is. */
  driver: 'idle' | 'running'
  /** Constructed loop projection, or null when construction was refused. */
  resident: ResidentAssemblyStatus | null
  /** Deployment seams still absent; empty only when a real transport and workspace exist. */
  productionGaps: readonly string[]
  /** Transport actually bound; `memory` never reaches a dispatcher. */
  transport: string
}

/** Operator surface of the resident contributor. */
export interface NodeContributorService {
  /** Current status; never performs I/O and never advances the loop. */
  status(): NodeContributorStatus
  /** Start the resident loop exactly once. */
  start(): Promise<NodeContributorStatus>
  /** Run exactly one serialized tick; the loop's observable progress. */
  tick(): Promise<NodeContributorStatus>
  /** Stop the loop and drain in-flight attempts. */
  stop(reason?: string): Promise<NodeContributorStatus>
}

interface AssemblyState {
  assembly: ResidentAssembly | null
  failure: string | null
  gaps: readonly string[]
  driver: 'idle' | 'running'
}

/**
 * Mount the resident contributor on a host that already owns the services it needs.
 * @param ctx - Host scope owning the authenticated Connection carrier.
 * @param config - Node identity, owner policy, storage and optional workspace root.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const policy = resolvePolicy(config)
  const nodeId = resolveNodeId(config.nodeId)
  const agentVersion = resolveAgentVersion(config.agentVersion)
  const workspaceRoot = config.workspaceRoot === undefined || config.workspaceRoot === ''
    ? undefined
    : requireAbsolute(config.workspaceRoot)
  const store = new ComputeTaskStore({
    path: resolveStorePath(config.storePath),
    maxTasks: config.maxTaskRecords ?? 1_000,
    maxBytes: config.maxStoreBytes ?? 4_194_304,
  })
  const state: AssemblyState = {
    assembly: null,
    failure: null,
    gaps: productionGaps({ ...(workspaceRoot === undefined ? {} : { workspaceRoot }) }),
    driver: 'idle',
  }
  // Construction performs no I/O, opens no socket and evaluates no plugin code,
  // so a refused construction is reported through the status instead of taking
  // the whole profile down.
  try {
    state.assembly = createResidentAssembly({
      nodeId,
      agentVersion,
      policy,
      store,
      verifySignature: unconfiguredVerifier,
      leaseOf: unconfiguredLeaseSource,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(config.maxInputBytes === undefined ? {} : { maxInputBytes: config.maxInputBytes }),
    })
  } catch (error) {
    const code = error instanceof ComputeError ? error.code : 'COMPUTE_NODE_CONTRIBUTOR_ASSEMBLY_FAILED'
    throw new NodeContributorError(code, { cause: error })
  }
  const projected = (): NodeContributorStatus => Object.freeze({
    source: 'node-contributor' as const,
    constructed: state.assembly !== null,
    mode: policy.mode,
    driver: state.driver,
    resident: state.assembly === null ? null : state.assembly.status(),
    productionGaps: state.gaps,
    transport: 'memory',
  })
  const service: NodeContributorService = {
    status: projected,
    async start() {
      if (state.assembly === null) return projected()
      await state.assembly.runtime.start()
      state.driver = 'running'
      return projected()
    },
    async tick() {
      if (state.assembly === null) return projected()
      await state.assembly.tick()
      state.driver = 'running'
      return projected()
    },
    async stop(reason) {
      if (state.assembly === null) return projected()
      await state.assembly.runtime.stop(reason)
      state.driver = 'idle'
      return projected()
    },
  }
  if (state.failure !== null) throw new NodeContributorError(state.failure)
  ctx.provide(NODE_CONTRIBUTOR_SERVICE, service)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/node/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json(service.status(), {
      status: 200,
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    }),
  }), 'node-contributor: status route')
  if (config.autoStart === true) {
    ctx.effect(() => {
      void service.start()
      return () => service.stop('fiber disposed')
    }, 'node-contributor: resident loop')
  }
}

/**
 * Build the owner policy from configuration and reject an impossible one.
 * @param config - Deployment configuration.
 * @returns A validated policy; `allowWhileUserActive` can never survive `mode: 'OFF'`.
 */
export function resolvePolicy(config: Config): ContributorPolicy {
  const mode = config.mode ?? 'OFF'
  const policy: ContributorPolicy = {
    mode,
    maxConcurrency: config.maxConcurrency ?? 1,
    maxCpuPercent: config.maxCpuPercent ?? 50,
    maxGpuPercent: config.maxGpuPercent ?? 0,
    maxTemperatureC: config.maxTemperatureC ?? 80,
    minDiskFreeBytes: config.minDiskFreeBytes ?? 10_737_418_240,
    allowWhileUserActive: (config.allowWhileUserActive ?? false) && mode !== 'OFF',
  }
  try {
    decideContribution(policy, zeroSnapshot(policy.maxConcurrency))
  } catch (error) {
    throw error instanceof ComputeError ? new NodeContributorError(error.code) : error
  }
  return policy
}

/** A snapshot with every measured fact at its floor; used only to validate a policy. */
function zeroSnapshot(runningTasks: number): ContributorSnapshot {
  return {
    userActive: false,
    voiceActive: false,
    cpuPercent: 0,
    gpuPercent: 0,
    temperatureC: 0,
    diskFreeBytes: 0,
    runningTasks: Math.max(0, Math.min(runningTasks, 64)),
  }
}

function resolveNodeId(configured: string | undefined): string {
  const value = configured !== undefined && configured !== '' ? configured : `node-${hostname()}`
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new NodeContributorError('COMPUTE_CONTRIBUTOR_NODE_ID_INVALID')
  return value
}

function resolveAgentVersion(configured: string | undefined): string {
  // Empty means "this host did not pin one": fall back to this package's own
  // version, read from its manifest rather than assumed from a working directory.
  const value = configured !== undefined && configured !== ''
    ? configured
    : String((createRequire(import.meta.url)('../package.json') as { version?: unknown }).version ?? '')
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new NodeContributorError('COMPUTE_CONTRIBUTOR_AGENT_VERSION_INVALID')
  return value
}

function resolveStorePath(configured: string | undefined): string {
  if (configured !== undefined && configured !== '') return requireAbsolute(configured)
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
  return resolve(join(home, 'qianshou', 'node-tasks.json'))
}

function requireAbsolute(value: string): string {
  if (!isAbsolute(value)) throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_PATH_NOT_ABSOLUTE')
  return resolve(value)
}

/**
 * Signature verifier for a host with no authorized-dispatch key material.
 *
 * Verifying an offer needs the dispatcher's public key, which this deployment does
 * not have. Returning `false` is the honest answer: every offer is refused as
 * unverified, so the code path that would accept one is unreachable.
 */
const unconfiguredVerifier: ComputeTaskSignatureVerifier = async () => false

/** Lease source for a host with no dispatch session; every lookup is a structured refusal. */
function unconfiguredLeaseSource(): unknown {
  throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_DISPATCH_UNCONFIGURED')
}
