/** Opt-in core bridge: existing identity, capabilities and workloads, plus local plan drafts. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { QianshouCoreClient } from './core-client.ts'
import { ComputeDraftStore } from './store.ts'
import { ComputeService } from './service.ts'
import { registerRoutes } from './routes.ts'
import { ComputeTaskStore } from './task-store.ts'
import { SubmissionLedger } from './submission-ledger.ts'
import { createHostSupply, readHostVoiceActivity, SupplyHostConfig } from './supply-host.ts'

export { ComputeService } from './service.ts'
export { ComputeExecutorRegistry, type ComputeExecutionContext, type ComputeExecutionResult, type ComputeExecutor } from './executor.ts'
export { prepareTaskWorkspace, type ComputeTaskWorkspace, type ComputeTaskWorkspaceConfig, type ComputeTaskInputSource } from './task-workspace.ts'
export { verifyTaskOutputs } from './task-output.ts'
export { prepareResultAssetManifest, type ComputeResultAsset, type ComputeResultAssetDescriptor, type ComputeResultAssetManifest, type ComputeResultAssetManifestOptions, type ComputeSemanticEvidenceReference } from './result-assets.ts'
export { ComputeLocalTaskRunner, type ComputeLocalTaskRequest } from './local-task-runner.ts'
export { transitionTask, type ComputeTaskEvent, type ComputeTaskState, type ComputeTaskStatus } from './task-state.ts'
export { ComputeTaskStore, type TaskStoreConfig } from './task-store.ts'
// Submission intent ledger: records the intent to submit and gates every future
// resend behind observed server facts. It performs no network I/O.
export { canResubmit, COMPUTE_SUBMISSION_INTENT_PROTOCOL, COMPUTE_SUBMISSION_LEDGER_VERSION, createSubmissionIntent, deriveSubmissionIdempotencyKey, parseSubmissionIntentRecord, SubmissionLedger, submissionRequestFingerprint, transitionSubmissionIntent, type SubmissionIntentAuthority, type SubmissionIntentEvent, type SubmissionIntentInput, type SubmissionIntentRecord, type SubmissionIntentStatus, type SubmissionLedgerConfig, type SubmissionReconciliation } from './submission-ledger.ts'
export { assignmentFingerprint, COMPUTE_TASK_ASSIGNMENT_PROTOCOL, isVerifiedTaskAssignment, taskFingerprint, verifyTaskAssignment, verifyTaskEnvelope, type ComputeTaskAssignment, type ComputeTaskSignatureVerifier, type VerifiedComputeTaskAssignment } from './envelope-security.ts'
export { decideContribution, type ContributorDecision, type ContributorMode, type ContributorPolicy, type ContributorSnapshot } from './contributor-policy.ts'
export { ContributorResourceObserver, type ContributorResourceSources } from './resource-observer.ts'
export { decideSchedulerCycle, type SchedulerAction, type SchedulerCycleDecision, type SchedulerCycleInput, type SchedulerOffer, type SchedulerRefusalReason } from './scheduler.ts'
export { ComputeNodeId, parseNodeHeartbeat, parseNodeTaskOffer, type ComputeNodeId as ComputeNodeIdType, type NodeCapabilityAdvertisement, type NodeHeartbeatMessage, type NodeTaskOfferMessage, type NodeTaskProgressMessage, type NodeTaskReturnMessage } from './node-protocol.ts'
export { COMPUTE_NODE_LEASE_VERSION, createNodeTaskLeaseState, parseNodeTaskLease, transitionNodeTaskLease, type NodeLeaseState, type NodeTaskLease, type NodeTaskLeaseEvent, type NodeTaskLeaseState } from './node-lease.ts'
export { transitionNodeConnection, type NodeConnectRequest, type NodeConnectionEvent, type NodeConnectionState, type NodeConnectionStatus, type NodeSession, type NodeSessionConnector } from './node-session.ts'
export { EmployeeTaskCoordinator, type EmployeeTaskCoordinateInput, type EmployeeTaskCoordinationResult, type VerifiedEmployeeTaskOffer } from './employee-task-coordinator.ts'
export { createNodeTransportConnector, type NodeTransport, type NodeTransportFactory, type NodeTransportInbound, type NodeTransportOutbound, type NodeTransportConnectorOptions } from './node-transport.ts'
export { assertCapabilityPluginExecutors, parseCapabilityPluginManifest, type ComputeCapabilityPluginManifest, type ComputePluginCapability, type ComputePluginDataScope, type ComputePluginPermission } from './capability-manifest.ts'
export { assertComputePluginBundleSize, parseComputePluginContract, type ComputePluginAsset, type ComputePluginContract, type ComputePluginDependency, type ComputePluginFootprintBudget, type ComputePluginRuntime, type ComputePluginToolContract } from './plugin-contract.ts'
export { planCapabilityPluginInstall, pluginManifestFingerprint, type ComputePluginInstallPlan, type ComputePluginInstallRequest, type ComputePluginSignatureVerifier } from './plugin-market.ts'
export { ResidentTaskLoop, createResidentHeartbeat, type ResidentHeartbeat, type ResidentLoopEffects, type ResidentTickInput, type ResidentTickResult } from './resident-loop.ts'
export { ComputeError } from './errors.ts'
export { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from './protocol.ts'
// Local supply, edge worker and billing surfaces. Transport plumbing stays internal
// (`requestJson`, `safeOrigin`, `validateTransportOptions`, `createProbeCommand`, `record`).
export type * from './supply.ts'
export { SupplyController, type SupplyControllerOptions } from './supply/controller.ts'
export { FileSupplyPolicyStore, SupplyError, parseSupplyPolicy, type SupplyPolicyStore } from './supply/policy.ts'
export { probeGpus, probeLocalSupply, type LocalProbeOptions, type LocalToolProbe, type ProbeCommand } from './supply/local-probe.ts'
export { EdgeSupplyApi, type EdgeApiOptions, type EdgeQuote, type EdgeQuoteRequest, type EdgeTaskType, type EdgeWorkload } from './supply/edge-api.ts'
export { createHostSupply, type SupplyHostConfig } from './supply-host.ts'
export { EdgeWorkerConnection, type EdgeWorkerOptions } from './edge-worker/connection.ts'
export type { EdgeInlineResult, EdgeResultSent, EdgeTaskIdentity, EdgeTaskOffer, EdgeWorkerEvent, EdgeWorkerPort } from './edge-worker/types.ts'
export { EdgeBillingApi, type EdgeBillingOptions } from './billing-adapter/client.ts'
export type { EdgeBalance, EdgeBudgetEstimate, EdgeEstimateRequest, EdgeLedgerEntry, EdgeLedgerPage, EdgeLedgerQuery } from './billing-adapter/types.ts'

/**
 * Logged-in compute-account session, when the optional `accountSession` service is present.
 * Duck-typed so this package does not depend on the account-session plugin.
 */
interface ComputeAccountSession {
  /** Hydrate or refresh the in-memory access token; `null` means not signed in. */
  readonly ensureAccessToken: () => Promise<string | null>
}

/** Deployment configuration; tokenEnv names an environment variable, never a literal key. */
export interface Config {
  /** Core HTTPS origin; empty leaves remote operations unavailable. */
  baseUrl?: string
  /**
   * Host environment variable containing an access-token override.
   * When `accountSession` is present, the logged-in access token is used first.
   */
  tokenEnv?: string
  /** Absolute private draft path; task records use its .tasks sibling. */
  statePath?: string
  /** Complete upstream request timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum bytes admitted from one upstream JSON response. */
  maxResponseBytes?: number
  /** Maximum bytes admitted by a local planning route. */
  maxRequestBytes?: number
  /** Maximum local draft count. */
  maxDrafts?: number
  /** Maximum bytes per local draft or task store. */
  maxStoreBytes?: number
  /** Maximum retained local task attempts. */
  maxTaskRecords?: number
  /** Local hardware probes and first-use owner policy, plus the deployment's optional advertisement endpoint. */
  supply?: SupplyHostConfig
}
/** Runtime-validated request and storage limits for this opt-in plugin. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''), tokenEnv: z.string().default('QIANSHOU_CORE_TOKEN'), statePath: z.string().default(''),
  timeoutMs: z.number().step(1).min(1000).max(60000).default(15000),
  maxResponseBytes: z.number().step(1).min(4096).max(4194304).default(1048576),
  maxRequestBytes: z.number().step(1).min(8192).max(131072).default(65536),
  maxDrafts: z.number().step(1).min(1).max(1000).default(100),
  maxStoreBytes: z.number().step(1).min(65536).max(33554432).default(4194304),
  maxTaskRecords: z.number().step(1).min(1).max(10000).default(1000),
  supply: SupplyHostConfig.default({}),
})
/** Stable plugin identity. */
export const name = 'qianshou-compute-core'
/** Local routes share the existing authenticated owner connection. */
export const inject = ['connection']

/** Install a reversible bridge without loading a legacy desktop client.
 * @param ctx - Host scope providing the existing authenticated carrier.
 * @param config - Deployment-owned origin, credential reference and bounds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const tokenEnv = config.tokenEnv ?? 'QIANSHOU_CORE_TOKEN'
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenEnv)) throw new Error('COMPUTE_INVALID_TOKEN_ENV')
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
  const statePath = config.statePath || join(home, 'qianshou', 'compute-plans.json')
  if (!isAbsolute(statePath)) throw new Error('COMPUTE_STATE_PATH_MUST_BE_ABSOLUTE')
  const envToken = (): string | undefined => process.env[tokenEnv]?.trim() || undefined
  let accountSession: ComputeAccountSession | undefined
  ctx.inject(['accountSession'], (scope) => {
    accountSession = (scope as { accountSession?: ComputeAccountSession }).accountSession
  })
  const accountSessionOf = (): ComputeAccountSession | undefined => {
    if (accountSession !== undefined) return accountSession
    const found = (ctx as { get?: (name: string) => ComputeAccountSession | undefined }).get?.('accountSession')
    if (found !== undefined) accountSession = found
    return accountSession
  }
  const resolveToken = async (): Promise<string | undefined> => {
    const session = accountSessionOf()
    const ensure = session?.ensureAccessToken
    if (typeof ensure === 'function') {
      const sessionToken = await ensure()
      if (sessionToken !== null && sessionToken.length > 0) return sessionToken
    }
    return envToken()
  }
  const client = config.baseUrl ? new QianshouCoreClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs ?? 15000,
    maxResponseBytes: config.maxResponseBytes ?? 1048576,
  }, resolveToken) : null
  const store = new ComputeDraftStore({ path: statePath, maxDrafts: config.maxDrafts ?? 100, maxBytes: config.maxStoreBytes ?? 4194304 })
  const tasks = new ComputeTaskStore({ path: statePath + '.tasks', maxTasks: config.maxTaskRecords ?? 1000, maxBytes: config.maxStoreBytes ?? 4194304 })
  const ledger = new SubmissionLedger({ path: statePath + '.submissions', maxRecords: config.maxTaskRecords ?? 1000, maxBytes: config.maxStoreBytes ?? 4194304 })
  // The advertisement port is always bound; its real endpoint and the existing tokenEnv credential come from
  // configuration, so an unconfigured profile stays honest instead of reporting a channel it does not have.
  // Voice activity is read lazily from whichever plugin really observes local voice work; this package does not
  // require that plugin, and its absence keeps the fact unknown rather than guessed.
  // Advertisement still uses the synchronous env override; catalogue reads use the logged-in session first.
  const supply = createHostSupply(ctx, config.supply ?? {}, statePath + '.supply', {
    tokenProvider: envToken,
    voiceActive: () => readHostVoiceActivity(ctx),
  })
  const service = new ComputeService(client, store, () => envToken() !== undefined || accountSessionOf() !== undefined, tasks, supply, ledger)
  ctx.provide('computeCore', service)
  ctx.effect(() => () => service.close(), 'compute: cancel reads and drain draft writes')
  registerRoutes(ctx, service, config.maxRequestBytes ?? 65536)
}
