import { updateWorkOf } from '@deepseek-ai/dsh-agent'
/** Opt-in core bridge: existing identity, capabilities and workloads, plus local plan drafts. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { QianshouCoreClient } from './core-client.ts'
import { ComputeDraftStore } from './store.ts'
import { LocalPluginDraftStore } from './plugin-draft.ts'
import { VideoWorkflowDraftStore } from './video-workflow-draft.ts'
import { ReviewableExecutionCandidateStore } from './reviewable-execution-candidates.ts'
import { LocalPluginCandidateBuilder } from './plugin-candidate.ts'
import { PrivateOfflinePluginArtifactStore } from './private-offline-plugin-artifact-store.ts'
import { PrivatePluginActivationLedger } from './private-plugin-activation-ledger.ts'
import { PrivatePluginInvocationLedger } from './private-plugin-invocation-ledger.ts'
import { ComfyPrivateTrialLedger } from './comfy-private-trial-ledger.ts'
import { PrivateComfyTrialHost } from './comfy-private-trial.ts'
import { ComputeError } from './errors.ts'
import { ComputeChainStore } from './chain-store.ts'
import { ComputeRecipeStore } from './recipe-store.ts'
import { ComputeResultCache } from './result-cache.ts'
import { ComputeService } from './service.ts'
export type { ComputeService } from './service.ts'
import { registerRoutes } from './routes.ts'
import { registerImageTrialRoutes } from './image-trial-routes.ts'
import { ResearchImageHost, type ResearchImageConfig } from './research-image.ts'
import type { ImageTrialConfig } from './image-trial.ts'
import { registerVideoTrialRoutes } from './video-trial-routes.ts'
import type { VideoTrialConfig } from './video-trial.ts'
import { FormalMediaControl } from './formal-media-control.ts'
import { registerFormalMediaRoutes } from './formal-media-routes.ts'
import { ComputeTaskStore } from './task-store.ts'
import { SubmissionLedger } from './submission-ledger.ts'
import { createHostSupply, readHostVoiceActivity, SupplyHostConfig, type HostVoiceActivity } from './supply-host.ts'
import { SupplyError } from './supply/policy.ts'
import { createMacDrawnVideoFactory } from './mac-drawn-video-factory.ts'

export {
  ComputeChainStore,
  DEFAULT_CHAIN_CONFIRM_TIMEOUT_MS,
  RECIPE_CONTRACT,
  chainDraftCardMeta,
  defaultChainConfirm,
  parseChainConfirmation,
  parseChainLocator,
  parseChainRequest,
  parseHumanConfirm,
  type ChainAbsenceTrace,
  type ChainAbsentBehavior,
  type ChainHumanConfirm,
  type ComputeChainDraft,
} from './chain-store.ts'
export {
  ComputeRecipeStore,
  mediaKindsOf,
  parseRecipeMatchQuery,
  parseRecipeSettleRequest,
  recipeHitCard,
  recipeMatchQueryFromRequest,
  taskTypeSequenceOf,
  type ComputeRecipeRecord,
  type RecipeAdmission,
  type RecipeMatchQuery,
  type RecipeSettleRequest,
} from './recipe-store.ts'
export {
  ComputeResultCache,
  cacheRefusalOf,
  determinismOf,
  parseResultCacheLookup,
  parseResultCacheStore,
  resultCacheDigest,
  resultOutputDigest,
  type ComputeResultCacheEntry,
} from './result-cache.ts'
export { ComputeExecutorRegistry, type ComputeExecutionContext, type ComputeExecutionResult, type ComputeExecutor } from './executor.ts'
export { HostPluginAdapterRegistry, type HostPluginAdapter, type HostPluginAdapterListing,
  type HostPluginSampleDigestClaim, type HostPluginSampleDigestClaimRecord, type PluginAdapterSelection,
  type PrivatePluginCandidate } from './plugin-adapter-admission.ts'
export { buildOfflinePluginArtifact, verifyOfflinePluginArtifact, offlinePluginSampleSha256,
  type OfflinePluginArtifact, type OfflinePluginSample, type VerifiedOfflinePluginArtifact,
} from './offline-plugin-artifact.ts'
export { buildOfflinePluginDeclaration,
  type OfflinePluginDeclaration, type OfflinePluginDeclarationManifest,
} from './offline-plugin-declaration.ts'
export { buildReviewableExecutionArtifact, verifyReviewableExecutionArtifact,
  evaluateReviewableExecution, type ReviewableExecutionArtifact,
  type VerifiedReviewableExecutionArtifact, type ReviewableExecutionManifest,
  type ReviewableExecutionOperation, type ReviewableStringMapExecutor,
} from './reviewable-execution-artifact.ts'
export { ReviewableExecutionCandidateStore } from './reviewable-execution-candidates.ts'
export { LocalPluginCandidateBuilder, type LocalPluginCandidate } from './plugin-candidate.ts'
export { HostPluginSampleWorkbench, type HostPluginSampleAdapter,
  type PrivatePluginExecutedSample, type PrivatePluginSampleRun,
} from './private-plugin-sample-workbench.ts'
export { PrivateOfflinePluginArtifactStore,
  type PrivateOfflinePluginArtifactSummary,
} from './private-offline-plugin-artifact-store.ts'
export { PrivatePluginActivationLedger, type PrivatePluginActivationRecord } from './private-plugin-activation-ledger.ts'
export { PrivatePluginInvocationLedger, type PrivatePluginInvocationRecord } from './private-plugin-invocation-ledger.ts'
export { PrivatePluginActivationHost, type PrivatePluginActivationSummary,
  type PrivatePluginOperationResult, type PrivatePluginOwnerApproval,
  type PreparedPrivatePluginSubmission } from './private-plugin-activation.ts'
export { createMacDrawnVideoFactory, type MacDrawnVideoFactory } from './mac-drawn-video-factory.ts'
export { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, parseNativeH3ContractBinding, parseNativeH3Declaration,
  type NativeH3Runtime, type NativeH3ContractBinding, type NativeH3AuthorBinding,
  type NativeH3Declaration } from './native-h3-binding.ts'
export { canonicalNativeH3DeviceProof, verifyNativeH3DeviceProof, isVerifiedNativeH3DeviceProof,
  type NativeH3DeviceTuple, type NativeH3DeviceProof,
  type VerifiedNativeH3DeviceProof } from './native-h3-device-proof.ts'
export { canonicalNativeH3ReviewJson, verifyNativeH3ReviewChallenge, isVerifiedNativeH3ReviewChallenge,
  type NativeH3ReviewInput, type NativeH3ReviewChallenge, type VerifiedNativeH3ReviewChallenge,
  type NativeH3ReviewArtifact, type NativeH3ReviewExecution } from './native-h3-review.ts'
export { verifyNativeH3PresenceChallenge, isVerifiedNativeH3PresenceChallenge,
  type NativeH3PresenceChallenge, type VerifiedNativeH3PresenceChallenge } from './native-h3-presence.ts'
export { verifyPrivateMacVideoInstallation, type PrivateMacVideoBundleManager,
  type PrivateMacVideoInstallationEvidence } from './private-mac-video-install.ts'
export {
  LocalPluginDraftStore, parsePluginDraftId, parsePluginDraftSaveRequest, parsePluginDraftSpec,
  type LocalPluginDraft, type PluginDraftBinding, type PluginDraftExport, type PluginDraftOperation,
  type PluginDraftResources, type PluginDraftSaveRequest, type PluginDraftSchema, type PluginDraftSpec,
  type PluginDraftStoreConfig,
} from './plugin-draft.ts'
export { VideoWorkflowDraftStore, type VideoWorkflowDraftSummary, type PrivateVideoWorkflowDraft,
  type VideoWorkflowDraftMapping } from './video-workflow-draft.ts'
export { pluginDraftPlanManifest, previewPluginDraft,
  type PluginDraftCheckState, type PluginDraftHostFacts, type PluginDraftOperationCheck,
  type PluginDraftPackagePreview, type PluginDraftPlanManifest,
} from './plugin-draft-preview.ts'
export { planPrivateComfyAdapterCandidate, PRIVATE_COMFY_EXECUTOR_CAPABILITY,
  PRIVATE_COMFY_EXECUTOR_VERSION, type PrivateComfyAdapterCandidate,
  type PrivateComfyAdapterCandidateInput } from './comfy-private-adapter-candidate.ts'
export { preparePrivateComfyDraftAsset, type PrivateComfyDraftAsset } from './comfy-draft-asset.ts'
export { preflightLocalComfyWorkflow } from './comfy-workflow-preflight.ts'
export {
  createInjectedLocalModelAdapter,
  type InjectedLocalModelAdapterOptions,
  type LocalModelAdapter,
  type LocalModelCheck,
  type LocalModelDescriptor,
  type LocalModelExecutionContext,
  type LocalModelObservation,
  type LocalModelRecoveryResult,
  type LocalModelRuntime,
  type LocalModelState,
} from './model-adapter.ts'
export { prepareTaskWorkspace, type ComputeTaskWorkspace, type ComputeTaskWorkspaceConfig, type ComputeTaskInputSource } from './task-workspace.ts'
export { verifyTaskOutputs } from './task-output.ts'
export { prepareResultAssetManifest, type ComputeResultAsset, type ComputeResultAssetDescriptor, type ComputeResultAssetManifest, type ComputeResultAssetManifestOptions, type ComputeSemanticEvidenceReference } from './result-assets.ts'
export { ComputeLocalTaskRunner, type ComputeLocalTaskRequest } from './local-task-runner.ts'
export {
  LOCAL_EXECUTION_APPROVAL_VERSION,
  LOCAL_EXECUTION_RECEIPT_VERSION,
  admitLocalExecution,
  issueLocalExecutionApproval,
  parseLocalExecutionReceipt,
  parseLocalExecutionApproval,
  runAuthorizedLocalTask,
  type LocalExecutionAdmission,
  type LocalExecutionApproval,
  type LocalExecutionApprovalInput,
  type LocalExecutionReceipt,
} from './local-execution-admission.ts'
export { parseTaskEvent, transitionTask, type ComputeTaskEvent, type ComputeTaskState, type ComputeTaskStatus } from './task-state.ts'
export { ComputeTaskStore, type TaskStoreConfig } from './task-store.ts'
export { ComputeJoinStore, ComputeFanOutJoinStore, JoinStore, createComputeFanOutPlan, type ComputeFanOutPlan, type ComputeFanOutPiece, type ComputePieceResult } from './fanout/index.ts'
// Submission intent ledger: records the intent to submit and gates every future
// resend behind observed server facts. It performs no network I/O.
export { canResubmit, COMPUTE_SUBMISSION_INTENT_PROTOCOL, COMPUTE_SUBMISSION_LEDGER_VERSION, createSubmissionIntent, deriveSubmissionIdempotencyKey, parseSubmissionIntentRecord, SubmissionLedger, submissionRequestFingerprint, transitionSubmissionIntent, type SubmissionIntentAuthority, type SubmissionIntentEvent, type SubmissionIntentInput, type SubmissionIntentRecord, type SubmissionIntentStatus, type SubmissionLedgerConfig, type SubmissionReconciliation } from './submission-ledger.ts'
export { assignmentFingerprint, COMPUTE_TASK_ASSIGNMENT_PROTOCOL, isVerifiedTaskAssignment, taskFingerprint, verifyTaskAssignment, verifyTaskEnvelope, type ComputeTaskAssignment, type ComputeTaskSignatureVerifier, type VerifiedComputeTaskAssignment } from './envelope-security.ts'
export { decideContribution, type ContributorDecision, type ContributorMode, type ContributorPolicy, type ContributorSnapshot } from './contributor-policy.ts'
export { ContributorResourceObserver, type ContributorResourceSources } from './resource-observer.ts'
export { decideSchedulerCycle, type SchedulerAction, type SchedulerCycleDecision, type SchedulerCycleInput, type SchedulerOffer, type SchedulerRefusalReason } from './scheduler.ts'
export { ComputeNodeId, parseNodeHeartbeat, parseNodeTaskOffer, parseNodeTaskProgress, parseNodeTaskReturn, type ComputeNodeId as ComputeNodeIdType, type NodeCapabilityAdvertisement, type NodeHeartbeatMessage, type NodeTaskOfferMessage, type NodeTaskProgressMessage, type NodeTaskReturnMessage } from './node-protocol.ts'
export { COMPUTE_NODE_LEASE_VERSION, createNodeTaskLeaseState, parseNodeTaskLease, transitionNodeTaskLease, type NodeLeaseState, type NodeTaskLease, type NodeTaskLeaseEvent, type NodeTaskLeaseState } from './node-lease.ts'
export { transitionNodeConnection, type NodeConnectRequest, type NodeConnectionEvent, type NodeConnectionState, type NodeConnectionStatus, type NodeSession, type NodeSessionConnector } from './node-session.ts'
export { EmployeeTaskCoordinator, type EmployeeTaskCoordinateInput, type EmployeeTaskCoordinationResult, type VerifiedEmployeeTaskOffer } from './employee-task-coordinator.ts'
export { createNodeTransportConnector, type NodeTransport, type NodeTransportFactory, type NodeTransportInbound, type NodeTransportOutbound, type NodeTransportConnectorOptions } from './node-transport.ts'
export { assertCapabilityPluginExecutors, parseCapabilityPluginManifest, type ComputeCapabilityPluginManifest, type ComputePluginCapability, type ComputePluginDataScope, type ComputePluginPermission } from './capability-manifest.ts'
export {
  ROUTING_CONTRACT_VERSION,
  parseCapabilityManifest,
  parseCapabilityOffer,
  parseIntentSpec,
  parseRoutePlan,
  type CapabilityManifest,
  type CapabilityManifestEntry,
  type CapabilityOffer,
  type ContractSignature,
  type IntentSpec,
  type RouteCandidate,
  type RoutePlan,
} from './routing-contract.ts'
export {
  createLocalCapabilityPluginRuntime,
  type LocalCapabilityPluginRuntime,
  type LocalCapabilityPluginRuntimeOptions,
  type LocalPluginCapabilityCheck,
  type LocalPluginPreflightReport,
  type LocalPluginRuntimeState,
} from './local-plugin-runtime.ts'
export { assertComputePluginBundleSize, parseComputePluginContract, type ComputePluginAsset, type ComputePluginContract, type ComputePluginDependency, type ComputePluginFootprintBudget, type ComputePluginRuntime, type ComputePluginToolContract } from './plugin-contract.ts'
export { planCapabilityPluginInstall, pluginManifestFingerprint, type ComputePluginInstallPlan, type ComputePluginInstallRequest, type ComputePluginSignatureVerifier } from './plugin-market.ts'
export { planRoute, QIANSHOU_INTENT_VERSION, QIANSHOU_ROUTE_VERSION, type RouterCandidate, type RouterDataScope, type RouterIntent, type RouterNodeOffer, type RouterPlan, type RouterPlanningInput, type RouterPrivacy, type RouterRejection, type RouterRejectionCode } from './router.ts'
export { AGENT_ROUTER_VERSION, planAgentRoute, type AgentRouterComplexity, type AgentRouterDecision, type AgentRouterInteraction, type AgentRouterIntent, type AgentRouterNetwork, type AgentRouterPath, type AgentRouterPrivacy, type AgentRouterReasonCode, type AgentRouterTarget } from './agent-router.ts'
export { PC_TASK_SURFACE_VERSION, projectPcTaskSurface, type PcOwnerGate, type PcTaskNextAction, type PcTaskPhase, type PcTaskReceiptView, type PcTaskSurface } from './pc-task-surface.ts'
export { planWireRoute, type RouterWireOfferObservation, type WireRoutePlanningInput, type WireRoutePlanningResult } from './router-adapter.ts'
export { COMMERCE_IMAGE_WORKFLOW_VERSION, planCommerceImageWorkflow, type CommerceImageWorkflowInput, type CommerceImageWorkflowPlan, type CommerceImageWorkflowStep } from './commerce-image-workflow.ts'
export { ResidentTaskLoop, createResidentHeartbeat, type ResidentHeartbeat, type ResidentLoopEffects, type ResidentTickInput, type ResidentTickResult } from './resident-loop.ts'
export {
  COMPUTE_HONESTY_PROMPT,
  COMPUTE_HONESTY_SECTION,
  COMPUTE_HONESTY_SECTION_ORDER,
  composeVisibleComputeReply,
  forbiddenComputeToolKeys,
  honestComputeSample,
  judgeComputeHonesty,
  type ComputeHonestyScenario,
} from './honesty.ts'
export { ComputeError } from './errors.ts'
export { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from './protocol.ts'
export { capabilityIdForTaskType, capabilityIdIfRegistered, landingTaskType, preferredLandingTaskType, publishableTaskTypes } from './developer-task.ts'
export {
  HOST_SIDE_MATCHING,
  HOST_SIDE_MATCHING_KINDS,
  helloUnionCapabilityIds,
  softwareNamesProveCapability,
  type HostSideMatchingKind,
} from './host-side-matching.ts'
export type { DeveloperTaskType } from './developer-task.ts'
// Local supply, edge worker and billing surfaces. Transport plumbing stays internal
// (`requestJson`, `safeOrigin`, `validateTransportOptions`, `createProbeCommand`, `record`).
export type * from './supply.ts'
export { SupplyController, type SupplyControllerOptions } from './supply/controller.ts'
export { FileSupplyPolicyStore, SupplyError, parseSupplyPolicy, type SupplyPolicyStore } from './supply/policy.ts'
export {
  FileProbeWatchStore,
  ZERO_CALLS_TODAY,
  probeWatchAlert,
  probeWatchDigest,
  recordProbeWatch,
  utcDay,
  type ProbeWatchStore,
} from './supply/probe-watch.ts'
export { probeGpus, probeLocalSupply, type LocalProbeOptions, type LocalToolProbe, type ProbeCommand } from './supply/local-probe.ts'
export { projectCapabilityDeclaration } from './supply/capability-declaration.ts'
// One trusted tool catalogue for both readers: the host supply page (`SupplyHostConfig.tools`) and
// the node's Edge `hello` advertisement. Exported so the node side cannot grow a second list — the
// two had already diverged once (`node, git, ffmpeg` versus `node, git, python3`), which left every
// ffmpeg-requiring task type unmatchable on a machine that had ffmpeg installed.
export {
  HOST_SUPPLY_TOOLS,
  HOST_SUPPLY_TOOL_SPECS,
  resolveSupplyCommand,
  supplyToolSearchDirectories,
  type HostSupplyToolSpec,
  type SupplyToolProbe,
} from './supply/tool-catalog.ts'
export { HOST_SUPPLY_PACKAGES, type HostSupplyPackageSpec } from './supply/package-catalog.ts'
export { EdgeSupplyApi, type EdgeApiOptions, type EdgeQuote, type EdgeQuoteRequest, type EdgeTaskType, type EdgeWorkload } from './supply/edge-api.ts'
export { createHostSupply, type SupplyHostConfig } from './supply-host.ts'
// Real host activity for the resident loop's `allowWhileUserActive` policy (AT-10).
export {
  createHostIdleReader,
  idleCommandFor,
  HOST_IDLE_CACHE_MS,
  HOST_IDLE_THRESHOLD_SECONDS,
  HOST_IDLE_TIMEOUT_MS,
  type HostActivityReading,
  type HostActivityUnavailable,
  type HostIdleReader,
  type HostIdleReaderOptions,
  type IdleCommand,
} from './host-activity.ts'
export { readHostVoiceActivity } from './supply-host.ts'
export { readHostForegroundTaskActivity, trackContributionAgent } from './foreground-activity.ts'
export { EdgeWorkerConnection, type EdgeWorkerOptions } from './edge-worker/connection.ts'
export { createShanghaiReviewedVideoFileControl,
  type ShanghaiReviewedVideoFileControlOptions } from './edge-worker/reviewed-video-file-control.ts'
export type { EdgeInlineResult, EdgeResultSent, EdgeTaskIdentity, EdgeTaskOffer, EdgeWorkerEvent, EdgeWorkerPort } from './edge-worker/types.ts'
export {
  createInlineEdgeBinding,
  ISOLATED_INLINE_SESSION_DIGEST,
  ISOLATED_INLINE_SESSION_PROTOCOL,
  ISOLATED_INLINE_SESSION_VERSION,
  type InlineEdgeBinding,
  type InlineEdgeBindingOptions,
  type ReviewedVideoOfferPort,
  type ReviewedVideoOfferProof,
} from './transport/inline-edge-bridge.ts'
export {
  createInlineSessionConsumer,
  unavailableIsolatedInlineRunner,
  type IsolatedInlineRunner,
  type InlineSessionConsumerOptions,
} from './resident/inline-session-consumer.ts'
export {
  createIsolatedInlineRunner,
  hasIsolatedInlineRunner,
  runnerOwnedCapabilityIds,
  ISOLATED_INLINE_TASK_TYPES,
  BUILTIN_WORD_COUNT_ADAPTER_DIGEST,
  type IsolatedAgentSession,
  type IsolatedInlineRunnerOptions,
} from './resident/isolated-inline-runner.ts'
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
  /** Exact trusted COS host for owner-selected task inputs; empty disables uploads. */
  inputStorageHostname?: string
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
  /** Optional private Guangzhou image trial; not a billable marketplace capability. */
  imageTrial?: ImageTrialConfig | undefined
  /** Optional free same-owner Shanghai image scheduler; fixed landscape/eight-step requests only. */
  researchImage?: ResearchImageConfig | undefined
  /** Optional unbilled H3 trial through an operator-owned local SSH forward. */
  videoTrial?: VideoTrialConfig | undefined
  /** Trusted Guangzhou media HTTPS origin; empty keeps formal uploads and delivery closed. */
  formalMediaGatewayOrigin?: string
  /** Interval for authenticated formal task status reads, between 500 and 60000 ms. */
  formalMediaStatusPollMs?: number
  /** Local hardware probes and first-use owner policy, plus the deployment's optional advertisement endpoint. */
  supply?: SupplyHostConfig
}
/** Runtime-validated request and storage limits for this opt-in plugin. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''), tokenEnv: z.string().default('QIANSHOU_CORE_TOKEN'), statePath: z.string().default(''),
  inputStorageHostname: z.string().default(''),
  timeoutMs: z.number().step(1).min(1000).max(60000).default(15000),
  maxResponseBytes: z.number().step(1).min(4096).max(4194304).default(1048576),
  maxRequestBytes: z.number().step(1).min(8192).max(131072).default(65536),
  maxDrafts: z.number().step(1).min(1).max(1000).default(100),
  maxStoreBytes: z.number().step(1).min(65536).max(33554432).default(4194304),
  maxTaskRecords: z.number().step(1).min(1).max(10000).default(1000),
  formalMediaGatewayOrigin: z.string().default(''),
  formalMediaStatusPollMs: z.number().step(1).min(500).max(60000).default(1500),
  imageTrial: z.union([z.object({ gatewayOrigin: z.string().required(), tokenEnv: z.string().required(),
    timeoutMs: z.number().step(1).min(300001).max(900000).default(360000) }), z.const(undefined)]),
  researchImage: z.union([z.object({ gatewayOrigin: z.string().required() }), z.const(undefined)]),
  videoTrial: z.union([z.object({ gatewayOrigin: z.string().required(),
    timeoutMs: z.number().step(1).min(1000).max(3600000).default(1800000) }), z.const(undefined)]),
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
    ...(config.inputStorageHostname === undefined ? {} : { inputStorageHostname: config.inputStorageHostname }),
  }, resolveToken) : null
  const store = new ComputeDraftStore({ path: statePath, maxDrafts: config.maxDrafts ?? 100, maxBytes: config.maxStoreBytes ?? 4194304 })
  const pluginDrafts = new LocalPluginDraftStore({ path: statePath + '.plugin-drafts',
    maxDrafts: config.maxDrafts ?? 100, maxBytes: config.maxStoreBytes ?? 4194304 })
  const privatePluginArtifacts = new PrivateOfflinePluginArtifactStore(statePath + '.plugin-candidates')
  const reviewableCandidates = new ReviewableExecutionCandidateStore(statePath + '.reviewable-execution-candidates')
  const pluginCandidates = new LocalPluginCandidateBuilder(pluginDrafts, statePath + '.safe-workflow-candidates')
  const videoWorkflowDrafts = new VideoWorkflowDraftStore(statePath + '.video-workflow-drafts')
  const privatePluginLedger = new PrivatePluginActivationLedger(statePath + '.plugin-activations')
  const privatePluginInvocations = new PrivatePluginInvocationLedger(statePath + '.plugin-invocations')
  const chains = new ComputeChainStore({ path: statePath + '.chains', maxChains: config.maxDrafts ?? 100, maxBytes: config.maxStoreBytes ?? 4194304 })
  const recipes = new ComputeRecipeStore({ path: statePath + '.recipes', maxRecipes: config.maxDrafts ?? 100, maxBytes: config.maxStoreBytes ?? 4194304 })
  const results = new ComputeResultCache({ directory: statePath + '.result-cache', maxEntries: config.maxTaskRecords ?? 1000, maxBytes: config.maxStoreBytes ?? 4194304 })
  const tasks = new ComputeTaskStore({ path: statePath + '.tasks', maxTasks: config.maxTaskRecords ?? 1000, maxBytes: config.maxStoreBytes ?? 4194304 })
  const ledger = new SubmissionLedger({ path: statePath + '.submissions', maxRecords: config.maxTaskRecords ?? 1000, maxBytes: config.maxStoreBytes ?? 4194304 })
  const privateComfyTrials = new PrivateComfyTrialHost({
    drafts: pluginDrafts,
    ledger: new ComfyPrivateTrialLedger(statePath + '.comfy-trials'),
    workspaceRoot: statePath + '.comfy-trial-work',
    outputRoot: statePath + '.comfy-trial-output',
    approval: { request: async (value) => {
      const approval = (ctx as unknown as { get: (name: string) => {
        request: (request: typeof value) => Promise<string>
      } | undefined }).get('approval')
      if (approval === undefined) throw new ComputeError('COMPUTE_COMFY_TRIAL_OWNER_APPROVAL_REQUIRED', 403)
      return approval.request(value)
    } },
  })
  // The advertisement port is always bound; its real endpoint and the existing tokenEnv credential come from
  // configuration, so an unconfigured profile stays honest instead of reporting a channel it does not have.
  // Only a producer with both a live reading and change notifications can establish an idle Host. A plain
  // active() reader cannot revoke an offer when voice work begins, so it remains unknown for admission.
  // Advertisement still uses the synchronous env override; catalogue reads use the logged-in session first.
  let subscribedVoice: HostVoiceActivity | null = null
  const currentSupplyOwner = async () => {
    const account = (ctx as { get?: (name: string) => { state?: () => Promise<{ phase: string; account: { id: string } | null }> } | undefined }).get?.('qianshouAccount')
    const node = (ctx as { get?: (name: string) => { nodeIdentity?: () => string } | undefined }).get?.('nodeContributor')
    if (typeof account?.state !== 'function' || typeof node?.nodeIdentity !== 'function') return null
    const status = await account.state()
    const id = status.phase === 'authenticated' ? status.account?.id : null
    if (typeof id !== 'string' || !/^[1-9]\d*$/u.test(id)) return null
    const ownerId = Number(id)
    const nodeId = node.nodeIdentity()
    if (!Number.isSafeInteger(ownerId) || !/^[A-Za-z0-9._:-]{1,256}$/u.test(nodeId)) return null
    return { ownerId, nodeId }
  }
  const supply = createHostSupply(ctx, config.supply ?? {}, statePath + '.supply', {
    tokenProvider: envToken,
    ownerBinding: {
      current: currentSupplyOwner,
      forWrite: async () => {
        const access = await accountSessionOf()?.ensureAccessToken?.()
        if (access === null || access === undefined || access.length === 0) return null
        return currentSupplyOwner()
      },
    },
    voiceActive: () => subscribedVoice !== null && ctx.get('voiceActivity') === subscribedVoice
      ? readHostVoiceActivity(ctx) : null,
  })
  const service = new ComputeService(
    client, store, () => envToken() !== undefined || accountSessionOf() !== undefined,
    tasks, supply, ledger, chains, recipes, results, pluginDrafts, privateComfyTrials,
    privatePluginArtifacts, privatePluginLedger, privatePluginInvocations, { request: async (value) => {
      const approval = (ctx as unknown as { get: (name: string) => {
        request: (request: typeof value) => Promise<string>
      } | undefined }).get('approval')
      if (approval === undefined) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_OWNER_APPROVAL_REQUIRED', 403)
      return approval.request(value)
    } }, reviewableCandidates, pluginCandidates, videoWorkflowDrafts,
  )
  ctx.provide('computeCore', service)
  // Only an explicitly installed, active package may register this fixed local executor.
  ctx.provide('macDrawnVideoFactory', createMacDrawnVideoFactory())
  ctx.effect(() => () => service.close(), 'compute: cancel reads and drain draft writes')
  ctx.inject(['voiceActivity'], (scope) => {
    const producer = scope.get('voiceActivity')
    if (typeof producer?.active !== 'function' || typeof producer.subscribe !== 'function') return
    subscribedVoice = producer
    const refresh = (active: boolean): void => {
      void supply.refreshActivity(active).catch((error: unknown) => {
        if (error instanceof SupplyError && (error.code === 'SUPPLY_ABORTED' || error.code === 'SUPPLY_CLOSED')) return
        // The route still reports a failed reconciliation on its next read. Do not log transport details or tokens.
        ctx.logger.warn('qianshou-compute-core: voice activity supply reconciliation failed')
      })
    }
    scope.effect(() => {
      const unsubscribe = producer.subscribe(refresh)
      refresh(producer.active())
      return () => {
        unsubscribe()
        if (subscribedVoice === producer) {
          subscribedVoice = null
          // Losing the producer makes voice state unknown, so any previously published offer is withdrawn.
          refresh(true)
        }
      }
    }, 'compute: reconcile supply on voice activity transitions')
  })
  registerRoutes(ctx, service, config.maxRequestBytes ?? 65536)
  const formalMedia = new FormalMediaControl(client, statePath + '.formal-media', {
    maxRecords: config.maxTaskRecords ?? 1000, maxBytes: config.maxStoreBytes ?? 4194304,
  }, { gatewayOrigin: config.formalMediaGatewayOrigin ?? '', timeoutMs: config.timeoutMs ?? 15000,
    statusPollMs: config.formalMediaStatusPollMs ?? 1500 })
  ctx.effect(() => updateWorkOf(ctx.root).register({ setLocked: locked => formalMedia.setUpdateLocked(locked),
    inspect: () => formalMedia.updateState() }), 'compute: update formal media protection')
  ctx.effect(() => () => formalMedia.close(), 'compute: formal media controls lifetime')
  registerFormalMediaRoutes(ctx, formalMedia, config.maxRequestBytes ?? 65536)
  const researchImage = new ResearchImageHost(client, config.researchImage, statePath + '.research-image', {
    maxRecords: config.maxTaskRecords ?? 1000, maxStoreBytes: config.maxStoreBytes ?? 4194304,
  })
  ctx.effect(() => updateWorkOf(ctx.root).register({ setLocked: locked => researchImage.setUpdateLocked(locked),
    inspect: () => researchImage.updateState() }), 'compute: update research image protection')
  ctx.effect(() => () => researchImage.close(), 'compute: research image lifetime')
  const imageHost = registerImageTrialRoutes(ctx, config.imageTrial, statePath + '.image-trial', {
    maxRecords: config.maxTaskRecords ?? 1000, maxStoreBytes: config.maxStoreBytes ?? 4194304,
  }, researchImage)
  registerVideoTrialRoutes(ctx, config.videoTrial, statePath + '.video-trial', {
    maxRecords: config.maxTaskRecords ?? 1000, maxStoreBytes: config.maxStoreBytes ?? 4194304,
  }, imageHost)
}

export { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, parseNativeH3ExecutionBindingV2, parseNativeH3DeclarationV2,
  parseAnyNativeH3ContractBinding, parseAnyNativeH3Declaration,
  nativeH3DeclarationBinding, nativeH3LogicalBindingSha256, nativeH3PublicBindingDigest,
  type NativeH3ExecutionBindingV2, type NativeH3DeclarationV2,
  type AnyNativeH3ContractBinding, type AnyNativeH3Declaration } from './native-h3-binding.ts'
export { verifyNativeH3DeviceProofV2, isVerifiedNativeH3DeviceProofV2,
  type NativeH3DeviceTupleV2, type NativeH3DeviceProofV2, type VerifiedNativeH3DeviceProofV2 } from './native-h3-device-proof.ts'
export { verifyNativeH3ReviewChallengeV2, isVerifiedNativeH3ReviewChallengeV2,
  type NativeH3ReviewChallengeV2, type VerifiedNativeH3ReviewChallengeV2,
  type NativeH3ReviewExecutionV2 } from './native-h3-review.ts'
export { verifyNativeH3PresenceChallengeV2, isVerifiedNativeH3PresenceChallengeV2,
  verifyNativeH3DeviceConfigChallengeV2, isVerifiedNativeH3DeviceConfigChallengeV2,
  type NativeH3PresenceChallengeV2, type VerifiedNativeH3PresenceChallengeV2,
  type NativeH3DeviceConfigChallengeV2, type VerifiedNativeH3DeviceConfigChallengeV2 } from './native-h3-presence.ts'

export { nativeH3ExpectedDeviceTuple, verifyAnyNativeH3DeviceProof, isVerifiedAnyNativeH3DeviceProof,
  type AnyNativeH3DeviceTuple, type AnyVerifiedNativeH3DeviceProof } from './native-h3-device-proof.ts'
export { verifyAnyNativeH3ReviewChallenge, isVerifiedAnyNativeH3ReviewChallenge,
  type AnyVerifiedNativeH3ReviewChallenge, type AnyNativeH3ReviewExecution } from './native-h3-review.ts'
export { verifyAnyNativeH3PresenceChallenge, isVerifiedAnyNativeH3PresenceChallenge,
  type AnyVerifiedNativeH3PresenceChallenge } from './native-h3-presence.ts'
export { parseNativeH3TaskLeaseV2, isAdmittedNativeH3TaskLeaseV2, type NativeH3TaskLeaseV2 } from './native-h3-task-lease.ts'
