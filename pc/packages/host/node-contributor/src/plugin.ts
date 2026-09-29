import { updateWorkOf } from '@deepseek-ai/dsh-agent'
/** Cordis plugin entry for the resident node contributor.
 *
 * This entry constructs `ResidentNodeRuntime` through {@link createResidentAssembly}
 * and publishes one read-only status projection.
 *
 * Two questions are deliberately answered by two different switches:
 *
 * - **Being in the pool** (node identity + measured capabilities) follows from "the
 *   product is installed and the owner signed in". `autoStart` defaults to true, the
 *   advertised types default to what this process can really run, and the HMAC inline
 *   Edge connector is bound whenever there is something to advertise — including while
 *   contribution is off, so the machine still appears in `GET /api/v8/workers`.
 * - **Taking work** follows from the owner's supply switch. `mode: 'OFF'` or a saved
 *   supply policy of `off` makes the transport report paused: the platform stops
 *   dispatching, and any assignment that still arrives is refused with a stable code.
 *
 * When `isolatedProvider` and `isolatedModel` are both set, every admitted type,
 * including `word_count`, is handled by that isolated session. The local counter
 * runs only when the route is absent. The session never inherits the CEO default
 * route. Unknown types fail at load. `setPanelAccepting` is the window switch:
 * on removes the panel veto, while the owner's policy and local admission still
 * decide whether work can be taken. Off pauses intake. It does not start another worker.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { lstat, realpath } from 'node:fs/promises'
import { freemem, homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { symbols, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  ComputeError,
  ComputeTaskStore,
  decideContribution,
  hasIsolatedInlineRunner,
  createHostIdleReader,
  createIsolatedInlineRunner,
  ISOLATED_INLINE_TASK_TYPES,
  BUILTIN_WORD_COUNT_ADAPTER_DIGEST,
  readHostVoiceActivity,
  readHostForegroundTaskActivity,
  parseSupplyPolicy,
  type ComputeTaskSignatureVerifier,
  type ContributorPolicy,
  type ContributorSnapshot,
  type SupplyPolicy,
} from '@deepseek-ai/dsh-compute-core'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { bindInlineEdgeResident, type VerifiedTaskAdapterClaim } from './edge-binding.ts'
import type { NativeH3DeviceKeyObservation, NativeH3DevicePresenceObservation,
  OrderAdapterChallengeObservation } from '@deepseek-ai/dsh-compute-core/transport/edge-worker-session'
import { readInstalledCapabilityIds } from './market-declarations.ts'
import {
  checkLocalTextStatisticsOrderPlugin,
  createLocalInlineOrderRunner,
  findInstalledInlineOrderBinding,
  inspectInstalledInlineOrderBundle,
  resolveLocalTextStatisticsOrderBinding,
  type LocalTextStatisticsOrderBinding,
  type LocalTextStatisticsOrderHost,
} from './local-plugin-order.ts'
import { loadOrderExecutorSelection, saveOrderExecutorSelection } from './order-executor-selection.ts'
import { expectedTextSort, inlineOrderContractOf } from './inline-order-contracts.ts'
import { NodeContributorError } from './errors.ts'
import { createIsolatedAgentSession, type IsolatedAgentRoute } from './isolated-agent.ts'
import { projectOwnerAdmission, type OwnerAdmission } from './owner-policy.ts'
import { createPinnedSvgVideoAdapter, installedSvgVideoPackageDigest, SVG_VIDEO_PACKAGE_ALGORITHM,
  selfTestPinnedSvgVideoAdapter } from './pinned-svg-video.ts'
import { readArtifactPublicationReadiness } from './artifact-publication-readiness.ts'
import { createH3VideoProvider, h3ComputeExecutor, readH3BoundedFile, type H3VideoReadiness } from './h3-video.ts'
import type { createH3CanonicalProvider } from './h3-canonical-provider.ts'
import { createDynamicH3VideoProvider } from './h3-dynamic-provider.ts'
import { H3OwnerSetup } from './h3-owner-setup.ts'
import { H3CanonicalOwnerSetup } from './h3-canonical-owner-setup.ts'
import { H3ManagedSelection } from './h3-managed-selection.ts'
import type { H3OwnerSetupSelection, H3OwnerSetupInspectResult, H3OwnerSetupSaveRequest, H3OwnerSetupSaveResult,
  H3OwnerSelfTestRequest, H3OwnerSelfTestStatus, H3OwnerSelfTestId, H3OwnerSetupContextId }
  from './h3-owner-setup-types.ts'
import type {
  H3CanonicalSetupSelection, H3CanonicalSetupInspectResult, H3CanonicalSetupSaveRequest,
  H3CanonicalSetupSaveResult, H3CanonicalTrialRequest, H3CanonicalTrialStatus,
  H3CanonicalTrialId, H3CanonicalVerifiedBindingRequest } from './h3-canonical-owner-setup-types.ts'
import type { ArtifactOrderAdapter } from './artifact-order.ts'
import { nativeH3PublicBindingDigest, type NativeH3AuthorBinding } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { createPublishedNativeH3Adapter, selectNativeH3Binding, readOwnedH3ExecutionPermit,
  type OwnedH3ExecutionPermit, type NativeH3LocalSelection, type NativeH3PublishedBinding } from './native-h3-publication.ts'
import { runNativeH3ReviewChallenge, readOwnedNativeH3ReviewExecutionPermit,
  type OwnedNativeH3ReviewExecutionPermit, type NativeH3ReviewRequest } from './native-h3-review.ts'
import { validateNativeH3PresenceChallenge, type NativeH3PresenceRequest } from './native-h3-presence.ts'
import { type AnyNativeH3ReviewExecution } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import {
  loadArtifactAdapterSelection, saveArtifactAdapterSelection,
  type ArtifactAdapterSelection,
} from './artifact-adapter-selection.ts'
import {
  createResidentAssembly,
  productionGaps,
  type ResidentAssembly,
  type ResidentAssemblyStatus,
} from './resident-assembly.ts'
import { reviewedVideoHostPortOf } from './reviewed-video-host-port.ts'
import { createProductReviewedVideoHostPort } from './reviewed-video-host-provider.ts'
import { prepareVideoAssetPlan, type VideoAssetPlan, type VideoAssetPlanRequest }
  from './reviewed-video-asset-planner.ts'
import { sharingExecutionAdmission } from './sharing-admission.ts'
import { SharingCoordinator, registerSharingRoutes } from './sharing-coordinator.ts'
import { registerMediaNodeRoutes, type MediaNodeControl } from './media-node-routes.ts'

/** Structural service port: discovery remains optional and policy is validated at use. */
interface ComputeOwnerPort {
  coreOrigin(): string | null
  ownerAccountId(): Promise<number>
  ownerSupplyPolicy?(): Promise<SupplyPolicy>
}

interface PurchasedOrderRuntime {
  productId: string
  entitlementId: string
  taskType: string
  capabilityId: string
  outputKind: 'inline_json'
  artifactDigest: string
  packageDigest: string
  runtimeDigest: string
  contractVersion: 'v1'
}

interface PurchasedFileOrderRuntime extends Omit<PurchasedOrderRuntime, 'outputKind'> {
  outputKind: 'artifact_ref'
  contractSha256: string
  fileSchemaSha256: string
}
interface PurchasedOrderCatalogPort {
  verifiedNativeH3OrderBindings?(workerId: string): Promise<readonly NativeH3PublishedBinding[]>
  verifiedPurchasedFileOrderRuntimes?(workerId: string): Promise<PurchasedFileOrderRuntime[]>
  runPurchasedFileOrderRuntime?: (input: Parameters<import('@deepseek-ai/dsh-compute-core/resident').FileOrderRuntimeRunner>[0]
    & { workerId: string
      productId: string
      entitlementId: string
      artifactDigest: string
      runtimeDigest: string
      contractSha256: string
      fileSchemaSha256: string }) => ReturnType<import('@deepseek-ai/dsh-compute-core/resident').FileOrderRuntimeRunner>

  verifiedPurchasedOrderRuntimes(workerId: string): Promise<PurchasedOrderRuntime[]>
  runPurchasedOrderRuntime(input: { workerId: string
    productId: string
    entitlementId: string
    taskType: string
    artifactDigest: string
    runtimeDigest: string
    inlineInput: string
    signal: AbortSignal }): Promise<{ text: string }>
}

/** Cordis service key this plugin provides. */
export const NODE_CONTRIBUTOR_SERVICE = 'nodeContributor'

/** Stable plugin identity. */
export const name = 'qianshou-node-contributor'

/** The status route needs the authenticated Connection carrier. */
export const inject = ['connection']

/** Name-independent path guard; the pinned launcher verifies the exact contract and bytes next. */
export async function verifyInstalledArtifactRoot(root: string): Promise<void> {
  try {
    if (resolve(root) !== root || !root.endsWith(`${sep}scripts${sep}order_adapter`)
      || await realpath(root) !== root) throw new Error('non-canonical adapter root')
    const skillPath = join(dirname(dirname(root)), 'SKILL.md')
    const skillStat = await lstat(skillPath)
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) throw new Error('invalid skill file')
  } catch { throw new NodeContributorError('COMPUTE_ARTIFACT_ADAPTER_SELECTION_INVALID') }
}

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
  /** Task types this node will advertise and admit; empty advertises nothing. */
  allowedTaskTypes?: string[]
  /** Handshake deadline for the Edge worker socket. */
  handshakeTimeoutMs?: number
  /** Maximum admitted Edge frame size. */
  maxFrameBytes?: number
  /** Maximum inline result bytes advertised and accepted. */
  maxOutputBytes?: number
  /**
   * Isolated agent provider route. Empty keeps agent types unloaded.
   * This is never the CEO default: both this and `isolatedModel` must be set.
   */
  isolatedProvider?: string
  /**
   * Isolated agent model id for {@link isolatedProvider}.
   * Empty keeps agent types unloaded.
   */
  isolatedModel?: string
  /** Isolated task thinking level; empty leaves the chosen adapter's default. */
  isolatedReasoningEffort?: '' | 'off' | 'high'
  /** Explicit owner opt-in: pin one active local candidate for text orders by its generated package digest. */
  localTextStatisticsPackageName?: string
  localTextStatisticsToolName?: string
  localTextStatisticsPackageDigest?: string
  /** Explicit, digest-pinned media adapter opt-in. All four fields are required. */
  localArtifactAdapterRoot?: string
  localArtifactAdapterDigest?: string
  localArtifactPackageDigest?: string
  localArtifactPythonPath?: string
  localArtifactSwiftPath?: string
  /** Explicit H3 owner file overrides managed setup; empty resolves the authenticated owner/profile configuration. */
  h3OwnerConfigPath?: string
  /** Explicit Guangzhou TLS origin; empty leaves persistent media enrollment disabled. */
  mediaGatewayOrigin?: string
  /** Independent metadata-only trust for official install receipts and device qualification. No result-key fallback. */
  mediaMetadataPublicKey?: string
  mediaMetadataKeyId?: string
  /** Independent formal-result and lease roots; metadata signers cannot authenticate a result. */
  mediaGuangzhouPublicKey?: string
  mediaGuangzhouKeyId?: string
  mediaUploadPublicKey?: string
  mediaUploadKeyId?: string
  mediaAuthorizationPublicKey?: string
  mediaAuthorizationKeyId?: string
  mediaOrderPublicKey?: string
  mediaOrderKeyId?: string
  /** Explicit HTTPS package origins; empty permits only the configured Guangzhou origin. */
  mediaDownloadOrigins?: string[]
  /** Initial retry delay for the explicitly connected media node channel. */
  mediaReconnectInitialMs?: number
  /** Retry ceiling; jitter stays within this deployment limit. */
  mediaReconnectMaxMs?: number
  /** Whole media HTTP deadline, at least one second above the channel wait. */
  mediaRequestTimeoutMs?: number
  /** Guangzhou inbox long-poll wait, bounded by the media protocol. */
  mediaChannelWaitMs?: number
  /** Deadline for a read-only owner-local Comfy inventory probe. */
  mediaDiscoveryTimeoutMs?: number
  /** Read-only local observations; empty origins disable the respective probe without changing any service. */
  mediaLocalComfyOrigin?: string
  mediaLocalImageOrigin?: string
  mediaLocalVideoOrigin?: string
  /** Discover alternate owner-local listening ports when the defaults do not identify a runnable service. */
  mediaLocalAutoDiscover?: boolean
  mediaLocalProbeTimeoutMs?: number
  mediaPresenceConnectTimeoutMs?: number
  /** Bound status identity reads independently of background model/API probes. */
  mediaStatusTimeoutMs?: number
  /** Per-read limit for the private fixed Comfy workflow API factory. */
  mediaPilotTimeoutMs?: number
  /** Maximum PNG bytes accepted by the zero-fee fixed-workflow factory. */
  mediaPilotMaximumResultBytes?: number
  /** Explicitly enable the independent non-billable research consumer; saved owner consent is still required. */
  mediaResearchEnabled?: boolean
  /** Separate free research inbox wait and original-attempt journal limit. */
  mediaResearchWaitMs?: number
  mediaResearchMaximumRecords?: number
  /** Fresh research resource reports; Guangzhou expires them independently. */
  mediaResearchExecutionIntervalMs?: number
}

/** Runtime-validated node identity, policy and storage limits. */
export const Config: z<Config> = z.object({
  nodeId: z.string().default(''),
  agentVersion: z.string().default(''),
  /**
   * Deployment switch for *taking work*, not for being in the pool.
   *
   * Defaults to `BACKGROUND_ONLY` because a machine that installed the product and
   * signed in must appear in the node pool with its measured capabilities; whether it
   * actually accepts assignments is the owner's switch (the supply policy, whose first
   * -use default is `off`). `OFF` still registers and still reports; it refuses every
   * assignment and advertises itself as paused.
   */
  mode: z.union(['OFF', 'BACKGROUND_ONLY', 'OPPORTUNISTIC']).default('BACKGROUND_ONLY'),
  maxConcurrency: z.number().step(1).min(1).max(64).default(1),
  maxCpuPercent: z.number().min(0).max(100).default(50),
  maxGpuPercent: z.number().min(0).max(100).default(0),
  maxTemperatureC: z.number().min(1).max(150).default(80),
  minDiskFreeBytes: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(10_737_418_240),
  allowWhileUserActive: z.boolean().default(false),
  /**
   * Start the resident loop on mount.
   *
   * Defaults to true: "installed and signed in" is the whole activation story for the
   * owner, so the node must not need a second, invisible switch. The loop does not
   * depend on the owner being signed in yet — it waits, retries and self-heals once the
   * account session exists.
   */
  autoStart: z.boolean().default(true),
  workspaceRoot: z.string().default(''),
  maxInputBytes: z.number().step(1).min(0).max(268_435_456).default(1_048_576),
  storePath: z.string().default(''),
  maxTaskRecords: z.number().step(1).min(1).max(10_000).default(1_000),
  maxStoreBytes: z.number().step(1).min(65_536).max(33_554_432).default(4_194_304),
  /**
   * Task types this node advertises and admits.
   *
   * Defaults to the types this process can actually run without a model, so a fresh
   * install reports something real instead of an empty capability list. An empty list
   * still means "advertise nothing".
   */
  allowedTaskTypes: z.array(z.string()).default([...ISOLATED_INLINE_TASK_TYPES]),
  handshakeTimeoutMs: z.number().step(1).min(1000).max(60_000).default(15_000),
  maxFrameBytes: z.number().step(1).min(4_096).max(1_048_576).default(65_536),
  maxOutputBytes: z.number().step(1).min(1).max(8_388_608).default(1_048_576),
  isolatedProvider: z.string().default(''),
  isolatedModel: z.string().default(''),
  isolatedReasoningEffort: z.union(['', 'off', 'high']).default(''),
  localTextStatisticsPackageName: z.string().default(''),
  localTextStatisticsToolName: z.string().default(''),
  localTextStatisticsPackageDigest: z.string().default(''),
  localArtifactAdapterRoot: z.string().default(''),
  localArtifactAdapterDigest: z.string().default(''),
  localArtifactPackageDigest: z.string().default(''),
  localArtifactPythonPath: z.string().default(''),
  localArtifactSwiftPath: z.string().default(''),
  h3OwnerConfigPath: z.string().default(''),
  mediaGatewayOrigin: z.string().default('https://app.qianshousuanli.com'),
  mediaMetadataPublicKey: z.string().default(''),
  mediaMetadataKeyId: z.string().default(''),
  mediaGuangzhouPublicKey: z.string().default(''),
  mediaGuangzhouKeyId: z.string().default(''),
  mediaUploadPublicKey: z.string().default(''),
  mediaUploadKeyId: z.string().default(''),
  mediaAuthorizationPublicKey: z.string().default(''),
  mediaAuthorizationKeyId: z.string().default(''),
  mediaOrderPublicKey: z.string().default(''),
  mediaOrderKeyId: z.string().default(''),
  mediaDownloadOrigins: z.array(z.string()).default([]),
  mediaReconnectInitialMs: z.number().step(1).min(100).max(60000).default(1000),
  mediaReconnectMaxMs: z.number().step(1).min(100).max(60000).default(60000),
  mediaRequestTimeoutMs: z.number().step(1).min(1001).max(60000).default(30000),
  mediaChannelWaitMs: z.number().step(1).min(1).max(25000).default(10000),
  mediaDiscoveryTimeoutMs: z.number().step(1).min(100).max(30000).default(10000),
  mediaLocalComfyOrigin: z.string().default('http://127.0.0.1:8188'),
  mediaLocalImageOrigin: z.string().default('http://127.0.0.1:8189'),
  mediaLocalVideoOrigin: z.string().default('http://127.0.0.1:8794'),
  mediaLocalAutoDiscover: z.boolean().default(true),
  mediaLocalProbeTimeoutMs: z.number().step(1).min(100).max(5000).default(3000),
  mediaPresenceConnectTimeoutMs: z.number().step(1).min(100).max(5000).default(1000),
  mediaStatusTimeoutMs: z.number().step(1).min(100).max(10000).default(1000),
  mediaPilotTimeoutMs: z.number().step(1).min(100).max(30000).default(10000),
  mediaPilotMaximumResultBytes: z.number().step(1).min(1).max(67108864).default(67108864),
  mediaResearchEnabled: z.boolean().default(false),
  mediaResearchWaitMs: z.number().step(1).min(0).max(25000).default(0),
  mediaResearchMaximumRecords: z.number().step(1).min(1).max(4096).default(256),
  mediaResearchExecutionIntervalMs: z.number().step(1).min(1000).max(5000).default(5000),
})

/**
 * What can actually verify an assignment *in this process*, and nothing more.
 *
 * `'platform-signed'` is **deliberately absent, and its absence is the fact this type records**:
 * this deployment holds no dispatcher public key (`unconfiguredVerifier`), and an Edge
 * `shard_assign` frame carries no dispatcher signature at all — the bridge mints its own key
 * (`inline-edge-bridge.ts`, `randomBytes(32)`) and verifies an offer against that same key, so
 * admission is a *self-consistency* check, not a platform authorization. Naming a value here that
 * this process cannot produce would be the same silence in a new place: see
 * `docs/dev-plan/report-C16-N1准入证据与收紧方案.md` §A1（准入权威 ≡ 套接字归属）and §A3（恒空静默）。
 */
export type DispatchAuthority = 'process-local-hmac' | 'none'

/**
 * Every {@link DispatchAuthority} value, with the sentence that says where it comes from.
 *
 * Exhaustive by construction: adding a value to {@link DispatchAuthority} stops compiling until it
 * is described here. That is the point — a new authority (a real platform signature, say) has to
 * arrive with words rather than appearing as one more silent string.
 */
export const DISPATCH_AUTHORITY_BASIS: Record<DispatchAuthority, string> = {
  'process-local-hmac': 'the bound Edge bridge signs and verifies with a key minted inside this process',
  none: 'no verifier is bound, so `unconfiguredVerifier` refuses every offer',
}

/**
 * Why each name in {@link NodeContributorStatus.productionGaps} is absent or present.
 *
 * `productionGaps` is a *set*, so an empty set cannot say whether a seam was closed by a real
 * object or by the call site asserting it. This basis makes that difference readable:
 * `satisfiedByAssertion` lists exactly the entries `productionGaps` would still report if the call
 * site stopped passing its literal `true`s. An empty `productionGaps` together with a nonempty
 * `satisfiedByAssertion` therefore reads as "nothing claims to be missing" — **not** "a dispatch
 * authority exists". See `docs/dev-plan/report-C16-N1准入证据与收紧方案.md` §A3（铁律二：静默即缺陷）。
 */
export interface NodeContributorGapsBasis {
  /** Where the attempt root came from. This call site always derives or receives one, so no `absent`. */
  workspaceRoot: 'derived' | 'configured'
  /** Which transport the connector actually is; `memory` never reaches a dispatcher. */
  transport: 'edge-worker' | 'memory'
  /** The verifier bound for this process; never a platform signature. See {@link DispatchAuthority}. */
  dispatchAuthority: DispatchAuthority
  /** How a result travels back; `inline-frame` is the Edge bridge's own frame. */
  resultTransfer: 'inline-frame' | 'absent'
  /** Entries removed by a literal `true` at the call site instead of by a measured object. */
  satisfiedByAssertion: readonly string[]
}

/**
 * Read-only projection of the resident loop.
 *
 * `driver` separates the two states an operator must never confuse: `idle` means
 * a constructible runtime exists and the loop was not started, `running` means
 * someone drove it. Neither state claims a peer ever offered work.
 */
export interface NodeContributorStatus {
  /** Effective permission for new assignments; existing leases are not cancelled. */
  intake: 'running' | 'paused'
  /** Why new assignments are paused, separate from registration and heartbeat. */
  intakeReason: 'owner-authorized' | 'owner-disabled' | 'deployment-disabled' | 'policy-unavailable' | 'owner-policy-blocked'
  /** Saved owner restrictions or unavailable measurements preventing new admission. */
  intakeReasons: readonly string[]
  /**
   * Capability ids this process names on the resident projection, including while intake is paused.
   * Landing names such as `word_count` are not listed; the registered id is.
   */
  declaredCapabilityIds: readonly string[]
  /** Capability ids admission currently marks available. Empty while intake is paused. */
  acceptingCapabilityIds: readonly string[]
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
  /**
   * Deployment seams still absent; empty only when a real transport and workspace exist.
   *
   * An empty array is a *necessary* reading, not a sufficient one: read `gapsBasis` before treating
   * it as readiness, because this profile reaches `[]` partly through literals at the call site
   * rather than through a measured dispatch authority.
   */
  productionGaps: readonly string[]
  /** Why `productionGaps` reads the way it does; the basis for an empty array, not a second claim. */
  gapsBasis: NodeContributorGapsBasis
  /** Transport actually bound; `memory` never reaches a dispatcher. */
  transport: string
  /**
   * Name of the last failed resident tick, or null after a successful one.
   *
   * A resident node is expected to tick while its owner is signed out, so a failure here is
   * ordinary control flow, not a broken node — but "idle because nobody signed in" and
   * "idle because the driver never ran" must stay distinguishable to an operator.
   */
  lastDriveFailure: string | null
}

/** Operator surface of the resident contributor. */
export interface NodeContributorService {
  /** Buyer-only model planning. No skill install, upload, quote, or dispatch occurs here. */
  prepareVideoAssetPlan(request: VideoAssetPlanRequest, signal: AbortSignal): Promise<VideoAssetPlan>
  /** Read managed setup or inspect selected files without generating video. */
  inspectH3OwnerSetup(selection?: H3OwnerSetupSelection, signal?: AbortSignal): Promise<H3OwnerSetupInspectResult>
  /** Save one inspected revision; this never grants supply or starts the GPU. */
  saveH3OwnerSetup(request: H3OwnerSetupSaveRequest, signal: AbortSignal): Promise<H3OwnerSetupSaveResult>
  /** Explicitly start one local five-second trial, independently of platform approval. */
  startH3OwnerSelfTest(request: H3OwnerSelfTestRequest, signal: AbortSignal): Promise<H3OwnerSelfTestStatus>
  /** Read the current owner's operation without retrying an unknown generation. */
  h3OwnerSelfTestStatus(operationId: H3OwnerSelfTestId): Promise<H3OwnerSelfTestStatus>
  /** Host-only current revision and real local evidence used to prepare a skill draft. */
  verifiedH3OwnerSetupBinding(revision: number, contextId: H3OwnerSetupContextId): ReturnType<ReturnType<typeof createH3VideoProvider>['nativeAuthorBindingV2']>
  /** Read or inspect the separate managed canonical setup without submitting work. */
  inspectH3CanonicalSetup(selection?: H3CanonicalSetupSelection): Promise<H3CanonicalSetupInspectResult>
  /** Save one inspected canonical revision under the shared owner transaction. */
  saveH3CanonicalSetup(request: H3CanonicalSetupSaveRequest): Promise<H3CanonicalSetupSaveResult>
  /** Start exactly one explicitly selected canonical local sample. */
  startH3CanonicalTrial(request: H3CanonicalTrialRequest): Promise<H3CanonicalTrialStatus>
  /** Read a retained canonical sample without starting another job. */
  h3CanonicalTrialStatus(operationId: H3CanonicalTrialId): Promise<H3CanonicalTrialStatus>
  /** Host-only fresh proof of two independent canonical local samples. */
  verifiedH3CanonicalSetupBinding(request: H3CanonicalVerifiedBindingRequest): ReturnType<ReturnType<typeof createH3CanonicalProvider>['nativeAuthorBindingCanonical']>
  /** Validate the current socket and freshly read native identity for a short presence plan, without rendering. */
  validateNativeH3PresenceChallenge(input: NativeH3PresenceRequest): Promise<void>
  /** Run one independent author challenge with direct review-lease media upload, never a buyer order. */
  runNativeH3ReviewChallenge(input: NativeH3ReviewRequest): Promise<AnyNativeH3ReviewExecution>
  /** Read actual private binding metadata and the bound prior real trial; starts no GPU job. */
  nativeH3AuthorBinding(): Promise<NativeH3AuthorBinding>
  /** Read portable v2 execution identity and separate current private configuration, without rendering. */
  nativeH3AuthorBindingV2(): ReturnType<ReturnType<typeof createH3VideoProvider>['nativeAuthorBindingV2']>
  /** Read the separately pinned canonical software and its own real local trial; never upgrade V2 evidence. */
  nativeH3AuthorBindingCanonical(): ReturnType<ReturnType<typeof createH3CanonicalProvider>['nativeAuthorBindingCanonical']>
  /** Select only the actual private configuration schema; failed V2 preparation never falls back to canonical. */
  nativeH3AuthorBindingCurrent(): ReturnType<ReturnType<typeof createDynamicH3VideoProvider>['nativeAuthorBindingCurrent']>
  /** Validate an author's exact JSON-only source; this does not grant supply or approval. */
  selectNativeH3AuthorBinding(input: NativeH3LocalSelection): Promise<{
    readonly taskType: string
    readonly artifactDigest: string
    readonly packageDigest: string
    readonly localOwnerConfigDigest?: string
    readonly taskDefinitionSha256: string
    readonly inventoryAlgorithm: 'qianshou.native-binding-package.v1'
    readonly localVerified: true
    readonly platformReady: false
  }>
  /** Read the last local H3 preparation result; this method starts no GPU trial. */
  h3VideoReadiness(): H3VideoReadiness
  /** Current status; never performs I/O and never advances the loop. */
  status(): NodeContributorStatus
  /** Exact installed node id used for both lease binding and owner supply consent. */
  nodeIdentity(): string
  /**
   * Worker id Shanghai acknowledged for this process; `null` before the first
   * successful handshake or when this profile has no Edge binding.
   */
  acknowledgedWorkerId(): string | null
  /** Server-issued UUID for the current ready worker socket; old ACK formats return null. */
  acknowledgedConnectionId(): string | null
  /** Require Shanghai's authenticated WebSocket to acknowledge this challenge hash. */
  observePurchasedOrderChallenge(observation: OrderAdapterChallengeObservation): Promise<void>
  /** Observe the independent device-key enrollment nonce on this current worker connection. */
  observeNativeH3DeviceKeyProof(observation: NativeH3DeviceKeyObservation): Promise<void>
  /** Witness the independent presence nonce over this exact ready socket, without changing supply. */
  /** Witness a v2 configuration CAS on this same authenticated connection. */
  observeNativeH3DeviceConfigProof(observation: NativeH3DeviceKeyObservation): Promise<void>
  observeNativeH3DevicePresence(observation: NativeH3DevicePresenceObservation): Promise<void>
  refreshPurchasedOrderAdapters(): Promise<void>
  /** Synchronize fixed native claims on the current server ACK connection without reconnecting. */
  refreshNativeH3OrderAdapters(): Promise<void>
  /** Read whether this exact native alias has been admitted on the current ACK socket.
   * @param taskType - Exact native task landing.
   * @returns True only while the current ready socket retains its acknowledged alias.
   */
  nativeH3OrderAdapterReady(taskType: string): Promise<boolean>
  /** Which single inline executor this Host selected; installation alone never selects one. */
  orderExecutor(): { readonly kind: 'builtin' }
    | { readonly kind: 'plugin'; readonly packageName: string; readonly taskType?: string }
    | { readonly kind: 'unavailable' }
  /** Cached proof from explicit selection/authorization, with no tool execution on inventory reads. */
  orderExecutorVerified(): boolean
  /** Static manifest, digest and Loader check. Selection runs the output sample. */
  canSelectOrderBundle(packageName: string): Promise<boolean>
  orderBundleContract(packageName: string): Promise<{ taskType: string; capabilityId: string } | null>
  /** Switch this running Host after a bounded output self-test; owner grant must first be off. */
  selectOrderExecutor(input: { readonly kind: 'builtin' } | { readonly kind: 'plugin'; readonly packageName: string }): Promise<
    { readonly kind: 'builtin' } | { readonly kind: 'plugin'; readonly packageName: string; readonly taskType?: string }
  >
  /** Pin, render-test and select one installed media adapter for this profile. Publication is a separate gate. */
  selectArtifactAdapter(input: Pick<ArtifactAdapterSelection, 'root' | 'digest' | 'pythonPath' | 'swiftPath'>): Promise<{
    readonly taskType: 'bar_chart_svg_v1'
    readonly artifactDigest: string
    readonly packageDigest: string
    readonly inventoryAlgorithm: typeof SVG_VIDEO_PACKAGE_ALGORITHM
    readonly localVerified: true
    readonly platformReady: boolean
  }>
  /** Fresh, read-only check of this build's exact local order landing and optional pinned plugin. */
  canEnableLocalService(serviceId: string): Promise<boolean>
  /** Start the resident loop exactly once. */
  start(): Promise<NodeContributorStatus>
  /** Run exactly one serialized tick; the loop's observable progress. */
  tick(): Promise<NodeContributorStatus>
  /** Stop the loop and drain in-flight attempts. */
  stop(reason?: string): Promise<NodeContributorStatus>
  /**
   * Window switch. `true` removes the panel veto; it cannot override the
   * owner's saved supply policy, deployment limits, or local admission.
   * `false` pauses intake.
   * @param on - Whether this window should take assignments.
   */
  setPanelAccepting(on: boolean): void
}

interface AssemblyState {
  assembly: ResidentAssembly
  gaps: readonly string[]
  /** Basis for `gaps`, computed beside it so the two can never be read apart. */
  gapsBasis: NodeContributorGapsBasis
  driver: 'idle' | 'running'
  /** Name of the last failed resident tick; cleared by the first successful one. */
  lastDriveFailure: string | null
}

/**
 * Resident tick period for `autoStart`.
 *
 * One second is short enough that a freshly published task is admitted while the publisher is
 * still polling, and long enough that an idle node costs one heartbeat per second rather than a
 * busy loop. The runtime serializes ticks itself, so a slow tick never overlaps the next one.
 */
const RESIDENT_TICK_MS = 1_000

/** Developer API metadata is part of the signed assignment, not a user adapter parameter. */
export function reviewedInlineUserParamsEmpty(params: Readonly<Record<string, unknown>> | undefined): boolean {
  if (params === undefined) return true
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return false
  const entries = Object.entries(params)
  if (entries.length > 4) return false
  return entries.every(([key, value]) => {
    if (key === '_developer_api_version') return value === 'task.v1'
    if (key === '_developer_idempotency_key') return typeof value === 'string'
      && value.length >= 1 && value.length <= 128 && !/[\r\n]/u.test(value)
    if (key === '_developer_idempotency_fingerprint') return typeof value === 'string'
      && /^[0-9a-f]{64}$/u.test(value)
    if (key === '_developer_webhook_configured') return typeof value === 'boolean'
    return false
  })
}

/**
 * Stable machine-readable name for one failed tick.
 *
 * This package's own failures carry a `code` and transport failures carry a distinct `name`;
 * the projection keeps whichever is available so an operator can tell "nobody signed in"
 * (`TRANSPORT_NOT_CONFIGURED`) from "the socket dropped" (`TRANSPORT_SESSION_CLOSED`) from
 * "the loop was stopped" (`COMPUTE_RESIDENT_STOPPED`).
 * @param error - Rejection raised by one tick.
 * @returns The code, then the error name, then a constant fallback.
 */
function failureCodeOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
    return error.name
  }
  return 'DRIVE_FAILED'
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
  const configuredTaskTypes = resolveAllowedTaskTypes(config.allowedTaskTypes)
  let releaseH3Executor: (() => void) | undefined
  // A fresh Host cannot infer that another owner's abandoned GPU operation stopped.
  let h3TrialAdmissionClear = false
  let h3TrialAdmissionCode: string | null = 'H3_SETUP_SELF_TEST_UNKNOWN'
  const readH3SetupScope = async () => {
    const account = ctx.get('qianshouAccount') as {
      state?(): Promise<{ phase: string; account: { id: string } | null }>
    } | undefined
    const profile = ctx.get('profileContext') as { dir?: string } | undefined
    const state = await account?.state?.()
    const id = state?.account?.id
    if (state?.phase !== 'authenticated' || typeof id !== 'string' || !/^[1-9][0-9]*$/u.test(id)
      || !Number.isSafeInteger(Number(id)) || typeof profile?.dir !== 'string' || !isAbsolute(profile.dir)) return null
    return { ownerId: Number(id), profileDir: profile.dir }
  }
  const mediaGatewayOrigin = config.mediaGatewayOrigin ?? 'https://app.qianshousuanli.com'
  const sharing = new SharingCoordinator({ directory: join(resolveHarnessHome(), 'compute-sharing'),
    gatewayOrigin: mediaGatewayOrigin,
    presenceConnectTimeoutMs: config.mediaPresenceConnectTimeoutMs ?? 1000,
    statusTimeoutMs: config.mediaStatusTimeoutMs ?? 1000,
    ...(config.mediaResearchEnabled === true ? { research: { waitMs: config.mediaResearchWaitMs ?? 0,
      maximumRecords: config.mediaResearchMaximumRecords ?? 256,
      executionIntervalMs: config.mediaResearchExecutionIntervalMs ?? 5000 } } : {}),
    pilot: { timeoutMs: config.mediaPilotTimeoutMs ?? 10000, maximumResultBytes: config.mediaPilotMaximumResultBytes ?? 67108864 },
    localDiscovery: { comfyOrigin: config.mediaLocalComfyOrigin ?? 'http://127.0.0.1:8188',
      imageOrigin: config.mediaLocalImageOrigin ?? 'http://127.0.0.1:8189',
      videoOrigin: config.mediaLocalVideoOrigin ?? 'http://127.0.0.1:8794',
      autoDiscover: config.mediaLocalAutoDiscover ?? true, timeoutMs: config.mediaLocalProbeTimeoutMs ?? 3000 },
    metadataPublicKey: config.mediaMetadataPublicKey ?? '', metadataKeyId: config.mediaMetadataKeyId ?? '',
    guangzhouPublicKey: config.mediaGuangzhouPublicKey ?? '', guangzhouKeyId: config.mediaGuangzhouKeyId ?? '',
    uploadPublicKey: config.mediaUploadPublicKey ?? '', uploadKeyId: config.mediaUploadKeyId ?? '',
    authorizationPublicKey: config.mediaAuthorizationPublicKey ?? '', authorizationKeyId: config.mediaAuthorizationKeyId ?? '',
    orderPublicKey: config.mediaOrderPublicKey ?? '', orderKeyId: config.mediaOrderKeyId ?? '', downloadOrigins: config.mediaDownloadOrigins ?? [],
    owner: async () => { const scope = await readH3SetupScope(); return scope === null ? null : String(scope.ownerId) },
    executionState: async () => {
      let saved: SupplyPolicy | null = null
      try { const value = await computeCoreOf()?.ownerSupplyPolicy?.()
        if (value !== undefined) saved = parseSupplyPolicy(value) } catch { /* Missing limits cannot authorize execution. */ }
      const measured = await idleReader.read()
      let voice: boolean | null = null; let foreground: boolean | null = null
      try { voice = readHostVoiceActivity(ctx) } catch { /* Unknown remains a veto. */ }
      try { foreground = readHostForegroundTaskActivity(ctx) } catch { /* Unknown remains a veto. */ }
      return sharingExecutionAdmission(policy, saved, { activity: measured, voiceActive: voice,
        foregroundTaskActive: foreground, freeMemoryBytes: freemem(), runningTasks: state.assembly.runtime.inFlightCount() },
      nativeReviewInProgress || h3SetupWriteInProgress || h3TrialActive || artifactSelectionInProgress)
    },
    token: async () => contributorTokenOf(), workerId: () => edge?.workerId() ?? null,
    coreOrigin: () => computeCoreOf()?.coreOrigin() ?? null, channel: () => mediaControl,
    occupancyChanged: () => { applyPanelGate(); state.assembly.applyPolicy(admission.policy) },
    legacyBusy: () => nativeReviewInProgress || h3SetupWriteInProgress || h3TrialActive || artifactSelectionInProgress
      || state.assembly.runtime.inFlightCount() !== 0,
    admission: operation => sharedH3Coordination.coordinator.withTransaction(async (transaction) => {
      await transaction.assertOwned(); await sharedH3Coordination.assertClearWithinTransaction()
      assertReviewSlotAvailable(); return operation()
    }),
  })
  ctx.effect(() => updateWorkOf(ctx.root).register({ setLocked: locked => sharing.setUpdateLocked(locked),
    inspect: () => sharing.updateState() }), 'sharing: update execution protection')
  let h3ConfigurationEpoch = 0
  // Scheduling facts only: every refresh still verifies current owner, proof and actual provider.
  let nativeDiscovery: { key: string; verified: boolean; withdraw: boolean; notBefore: number } | null = null
  const h3Provider = createDynamicH3VideoProvider({
    async resolveConfiguration() {
      if (config.h3OwnerConfigPath) return { path: config.h3OwnerConfigPath, identity: 'external' }
      if (await readH3SetupScope() === null) return null
      const current = await h3ManagedSelection.readCurrent()
      return current === null ? null : { path: current.configPath,
        identity: `${current.scopeId}:${current.runtime}:${current.selectionRevision}:${current.revision}:${current.configSha256}` }
    },
    assertNewExecution: assertH3TrialAdmission,
    onChanged() {
      h3ConfigurationEpoch++
      nativeDiscovery = nativeDiscovery?.verified ? { ...nativeDiscovery, withdraw: true } : null
      releaseH3Executor?.(); releaseH3Executor = undefined
    },
  })
  const h3Configured = !!config.h3OwnerConfigPath || configuredTaskTypes.includes('video_generate')
  const artifactFields = [config.localArtifactAdapterRoot, config.localArtifactAdapterDigest,
    config.localArtifactPackageDigest,
    config.localArtifactPythonPath, config.localArtifactSwiftPath]
  const artifactConfigured = artifactFields.every(value => typeof value === 'string' && value.length > 0)
  if (artifactFields.some(value => typeof value === 'string' && value.length > 0) && !artifactConfigured) {
    throw new NodeContributorError('COMPUTE_ARTIFACT_ADAPTER_CONFIG_INCOMPLETE')
  }
  const profileDirOf = (): string | undefined => (ctx as { get?: (name: string) => { dir?: string } | undefined })
    .get?.('profileContext')?.dir
  const configuredArtifact: ArtifactAdapterSelection | null = artifactConfigured ? {
    root: config.localArtifactAdapterRoot ?? '', digest: config.localArtifactAdapterDigest ?? '',
    packageDigest: config.localArtifactPackageDigest ?? '',
    inventoryAlgorithm: SVG_VIDEO_PACKAGE_ALGORITHM,
    pythonPath: config.localArtifactPythonPath ?? '', swiftPath: config.localArtifactSwiftPath ?? '',
  } : null
  const savedArtifactSelection = loadArtifactAdapterSelection(profileDirOf(), configuredArtifact)
  // A malformed or tampered selection cannot activate media, including after a restart.
  let selectedArtifact = savedArtifactSelection.valid ? savedArtifactSelection.selection : null
  let artifactSelectionInProgress = false
  let nativeReviewInProgress = false
  let activeNativeReview: { request: NativeH3ReviewRequest; ownerId: number; deviceId: string; connectionId: string } | null = null
  let h3SetupWriteInProgress = false
  let h3TrialActive = false
  const isolatedRoute = resolveIsolatedRoute(config.isolatedProvider, config.isolatedModel, config.isolatedReasoningEffort)
  const configuredOrderPlugin = resolveLocalTextStatisticsOrderBinding(config.localTextStatisticsPackageName === undefined
    && config.localTextStatisticsToolName === undefined && config.localTextStatisticsPackageDigest === undefined
    ? undefined : {
      packageName: config.localTextStatisticsPackageName ?? '',
      toolName: config.localTextStatisticsToolName ?? '',
      packageDigest: config.localTextStatisticsPackageDigest ?? '',
    })
  const savedOrderSelection = loadOrderExecutorSelection(profileDirOf(), configuredOrderPlugin === null
    ? { kind: 'builtin' } : { kind: 'plugin', binding: configuredOrderPlugin })
  let selectionValid = savedOrderSelection.valid
  let localOrderPlugin: LocalTextStatisticsOrderBinding | null = savedOrderSelection.selection.kind === 'plugin'
    ? savedOrderSelection.selection.binding : null
  const allowedTaskTypes = [...configuredTaskTypes]
  if (h3Configured && !allowedTaskTypes.includes('video_generate')) allowedTaskTypes.push('video_generate')
  if (localOrderPlugin?.taskType !== undefined && !allowedTaskTypes.includes(localOrderPlugin.taskType)) {
    allowedTaskTypes.push(localOrderPlugin.taskType)
  }
  if (selectedArtifact !== null && !allowedTaskTypes.includes('bar_chart_svg_v1')) allowedTaskTypes.push('bar_chart_svg_v1')
  // A saved binding pins identity, not a fresh process proof. The hello
  // callback runs the bounded fixture before claiming it to Shanghai.
  let pluginSampleVerified = false
  const agentTaskTypes = isolatedRoute === null ? []
    : allowedTaskTypes.filter(type => !['bar_chart_svg_v1', 'video_generate'].includes(type))
  for (const item of allowedTaskTypes) {
    if (!hasIsolatedInlineRunner(item, agentTaskTypes) && item !== localOrderPlugin?.taskType
      && !(item === 'bar_chart_svg_v1' && selectedArtifact !== null) && !(item === 'video_generate' && h3Configured)) {
      throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_TASK_TYPE_UNSUPPORTED')
    }
  }
  const workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot)
  ctx.effect(() => () => { releaseH3Executor?.(); releaseH3Executor = undefined })
  const localOrderHost: LocalTextStatisticsOrderHost = {
    profileDir: profileDirOf,
    manager: () => ctx.get('pluginManager') as ReturnType<LocalTextStatisticsOrderHost['manager']>,
    tools: () => ctx.get('tools') as ReturnType<LocalTextStatisticsOrderHost['tools']>,
  }
  const baseRunner = createIsolatedInlineRunner({
    ...(isolatedRoute === null ? {} : { agent: createIsolatedAgentSession(ctx, { ...isolatedRoute,
      ownerWorkspaceRoot: workspaceRoot }) }),
    agentTaskTypes,
  })
  let orderRunner = localOrderPlugin === null ? baseRunner
    : createLocalInlineOrderRunner(localOrderPlugin, localOrderHost, baseRunner)
  let purchasedRuntimes = new Map<string, PurchasedOrderRuntime>()
  let purchasedFileRuntimes = new Map<string, PurchasedFileOrderRuntime>()
  let lastPurchasedHelloWorkerId: string | null = null
  let nextAdapterHelloRetryAt = 0
  let adapterHelloRetryDelayMs = 5_000
  const retryAdapterHello = (): void => {
    lastPurchasedHelloWorkerId = null
    nextAdapterHelloRetryAt = Date.now() + adapterHelloRetryDelayMs
    adapterHelloRetryDelayMs = Math.min(adapterHelloRetryDelayMs * 2, 60_000)
  }
  const purchasedCatalog = (): PurchasedOrderCatalogPort | undefined =>
    ctx.get('qianshouPluginCatalog') as PurchasedOrderCatalogPort | undefined
  // Cordis creates a new context-tracing proxy and method wrapper on each read.
  // Compare the original service and methods while invoking through its proxy.
  const catalogIdentity = (catalog: PurchasedOrderCatalogPort): PurchasedOrderCatalogPort =>
    (Reflect.get(catalog, symbols.original) ?? catalog) as PurchasedOrderCatalogPort
  const store = new ComputeTaskStore({
    path: resolveStorePath(config.storePath),
    maxTasks: config.maxTaskRecords ?? 1_000,
    maxBytes: config.maxStoreBytes ?? 4_194_304,
  })
  let computeCore: ComputeOwnerPort | undefined
  let accountSession: { ensureAccessToken?: () => Promise<string | null> } | undefined
  ctx.inject(['computeCore'], (scope) => {
    computeCore = (scope as { computeCore?: ComputeOwnerPort }).computeCore
  })
  ctx.inject(['accountSession'], (scope) => {
    accountSession = (scope as { accountSession?: { ensureAccessToken?: () => Promise<string | null> } }).accountSession
  })
  const computeCoreOf = (): ComputeOwnerPort | undefined => {
    if (computeCore !== undefined) return computeCore
    const found = (ctx as { get?: (name: string) => ComputeOwnerPort | undefined }).get?.('computeCore')
    if (found !== undefined) computeCore = found
    return computeCore
  }
  const reviewedVideoHost = (() => {
    const get = (ctx as { get?: (name: string) => unknown }).get
    const direct = reviewedVideoHostPortOf(get?.call(ctx, 'qianshouReviewedVideoHost'))
    if (direct !== null) return direct
    const provision = get?.call(ctx, 'qianshouReviewedVideoHostProvision')
    if (provision === undefined || provision === null) return null
    try {
      return reviewedVideoHostPortOf(createProductReviewedVideoHostPort(
        provision, store, computeCoreOf()))
    } catch { return null } // An incomplete provision never changes ordinary Host startup.
  })()
  const accountSessionOf = (): { ensureAccessToken?: () => Promise<string | null> } | undefined => {
    if (accountSession !== undefined) return accountSession
    const found = (ctx as { get?: (name: string) => { ensureAccessToken?: () => Promise<string | null> } | undefined }).get?.('accountSession')
    if (found !== undefined) accountSession = found
    return accountSession
  }
  /**
   * Bind the Edge connector whenever there is something to advertise.
   *
   * Why `mode` is deliberately absent here: node identity and capability reporting are
   * one thing, taking work is another. While this also required `mode !== 'OFF'`, a
   * machine whose owner had contribution off never registered at all — so it stayed
   * invisible in the pool (`GET /api/v8/workers` had no row for it) and the platform had
   * nothing to match against. Intake is still refused; see the `supply` mirror below.
   */
  // A profile can select a pinned media adapter after this Host has mounted.
  // Keep the connector constructible even when its initial task allowlist is empty;
  // only a current dynamic provider/runner pair may register an empty paused challenge session.
  const edgeIntended = allowedTaskTypes.length > 0 || profileDirOf() !== undefined
    || reviewedVideoHost !== null
  /**
   * Whether the transport may accept work: the owner's supply switch, mirrored.
   *
   * Why this exists: the 「本机供给」 page promises that 完全关闭 means this machine stops
   * taking work ("不参与接单" / "不会有新任务落到本机"), but that switch is stored in the
   * compute-core owner policy while admission happens here. Before this mirror the node
   * advertised `mode: running` and kept accepting offers after the owner turned
   * contribution off (AT-09 measured exactly that).
   *
   * Two switches answer one question, so both must agree: the deployment `mode` (OFF
   * means this deployment never takes work) and the owner's saved supply policy (whose
   * first-use default is `off`, matching the page's "开关默认是关的"). Either one off
   * makes the transport report paused — but neither one stops registration, which is why
   * the pool keeps showing the machine's identity and measured capabilities.
   *
   * Missing or unreadable authorization pauses new intake. The resident loop, existing
   * leases and result delivery remain alive. A later successful read restores the
   * saved owner mode; neither this mirror nor a read failure writes owner preferences.
   */
  let supplyMode: 'running' | 'paused' = 'paused'
  let intakeReason: NodeContributorStatus['intakeReason'] = policy.mode === 'OFF' ? 'deployment-disabled' : 'policy-unavailable'
  let ownerSupplyMode: 'running' | 'paused' = 'paused'
  let ownerIntakeReason: NodeContributorStatus['intakeReason'] = intakeReason
  /** `null` follows the supply-page gates. The window switch sets true or false. */
  let panelAccepting: boolean | null = null
  let localOrderPluginReady = selectionValid && localOrderPlugin === null
  const verifiedLocalTaskTypes = (): readonly string[] => localOrderPluginReady && pluginSampleVerified
    && localOrderPlugin?.taskType !== undefined ? [localOrderPlugin.taskType] : []
  const verifiedPurchasedCapabilityIds = (): readonly string[] =>
    [...purchasedRuntimes.values()].map(item => item.capabilityId)
  const idleReader = createHostIdleReader()
  let activity = { userActive: null, idleSeconds: null, unavailable: null } as Awaited<ReturnType<typeof idleReader.read>>
  let voiceActive: boolean | null = null
  let ownerAdmission: OwnerAdmission = projectOwnerAdmission(policy, null, {
    activity, voiceActive, foregroundTaskActive: null, freeMemoryBytes: null, runningTasks: 0,
  }, [], allowedTaskTypes, verifiedLocalTaskTypes())
  let admission: OwnerAdmission = ownerAdmission
  const refreshSupplyMode = async (): Promise<void> => {
    if (!selectionValid) localOrderPluginReady = false
    else if (localOrderPlugin !== null) {
      try {
        await checkLocalTextStatisticsOrderPlugin(localOrderPlugin, localOrderHost)
        localOrderPluginReady = true
      } catch {
        localOrderPluginReady = false
        pluginSampleVerified = false
      }
    } else localOrderPluginReady = true
    let saved: SupplyPolicy | null = null
    try {
      const value = await computeCoreOf()?.ownerSupplyPolicy?.()
      if (value !== undefined) saved = parseSupplyPolicy(value)
    } catch { /* An unreadable or invalid saved authorization cannot allow new work. */ }
    activity = await idleReader.read()
    voiceActive = null
    let foregroundTaskActive: boolean | null = null
    try { voiceActive = readHostVoiceActivity(ctx) }
    catch { /* A failed voice producer cannot establish inactivity. */ }
    try { foregroundTaskActive = readHostForegroundTaskActivity(ctx) }
    catch { /* An unavailable registry cannot establish foreground inactivity. */ }
    ownerAdmission = projectOwnerAdmission(policy, saved, {
      activity, voiceActive, foregroundTaskActive,
      freeMemoryBytes: freemem(), runningTasks: state.assembly.runtime.inFlightCount(),
    }, edge?.capabilities() ?? [], [...new Set([...allowedTaskTypes, ...(edge?.verifiedArtifactTaskTypes() ?? [])])],
    verifiedLocalTaskTypes(), edge?.verifiedArtifactTaskTypes() ?? [], verifiedPurchasedCapabilityIds())
    ownerSupplyMode = ownerAdmission.reasons.length === 0 ? 'running' : 'paused'
    ownerIntakeReason = policy.mode === 'OFF' ? 'deployment-disabled'
      : saved === null ? 'policy-unavailable' : saved.mode === 'off' ? 'owner-disabled'
        : ownerSupplyMode === 'running' ? 'owner-authorized' : 'owner-policy-blocked'
    applyPanelGate()
  }
  /**
   * Apply the window switch after the supply-page projection.
   * On follows the owner's saved policy and current local admission. Off adds
   * a veto. An unset switch leaves the owner projection unchanged.
   */
  function applyPanelGate(): void {
    admission = ownerAdmission
    supplyMode = ownerSupplyMode
    intakeReason = ownerIntakeReason
    if (!localOrderPluginReady && purchasedRuntimes.size === 0
      && (edge?.verifiedArtifactTaskTypes().length ?? 0) === 0) {
      supplyMode = 'paused'
      intakeReason = 'owner-policy-blocked'
      admission = {
        policy: { ...ownerAdmission.policy, mode: 'OFF' },
        capabilities: ownerAdmission.capabilities.map(item => ({ ...item, available: false })),
        reasons: [...ownerAdmission.reasons, 'LOCAL_ORDER_PLUGIN_UNAVAILABLE'],
      }
      return
    }
    if (panelAccepting !== false && !sharing.busy() && !h3SetupWriteInProgress && !h3TrialActive && h3TrialAdmissionClear) return
    supplyMode = 'paused'
    intakeReason = policy.mode === 'OFF' ? 'deployment-disabled' : 'owner-disabled'
    admission = {
      policy: { ...ownerAdmission.policy, mode: 'OFF' },
      capabilities: ownerAdmission.capabilities.map(item => ({ ...item, available: false })),
      reasons: ownerAdmission.reasons.includes('OWNER_DISABLED')
        ? ownerAdmission.reasons : [...ownerAdmission.reasons, 'OWNER_DISABLED'],
    }
  }
  const contributorTokenOf = async (): Promise<string | undefined> => readContributorAccessToken(
    storedAccessToken(ctx), accountSessionOf()?.ensureAccessToken,
  )
  const contributorOwnerIdOf = async (): Promise<number | undefined> => {
    const local = await localOwnerId(ctx)
    if (local !== undefined) return local
    if (storedAccessToken(ctx) !== undefined) return undefined
    const core = computeCoreOf()
    if (core === undefined) return undefined
    try {
      const ownerId = await core.ownerAccountId()
      return Number.isSafeInteger(ownerId) && ownerId >= 1 ? ownerId : undefined
    } catch { return undefined }
  }
  const edge: ReturnType<typeof bindInlineEdgeResident> | undefined = edgeIntended
    ? bindInlineEdgeResident({
      nodeId,
      agentVersion,
      allowedTaskTypes,
      localTaskTypes: verifiedLocalTaskTypes,
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 15_000,
      maxFrameBytes: config.maxFrameBytes ?? 65_536,
      maxOutputBytes: config.maxOutputBytes ?? 1_048_576,
      supply: () => supplyMode,
      marketCapabilityIds: () => readInstalledCapabilityIds(resolveHarnessHome()),
      publishedNativeArtifactOrders: () => readPublishedNativeArtifactOrders(),
      ...(reviewedVideoHost === null ? {} : { reviewedVideoHost }),
      ...(h3Configured ? { nativeArtifactOrders: [{ taskType: 'video_generate',
        async loadAndSelfTest() {
          const adapter = await h3Provider.loadAndSelfTest()
          if (adapter === null) { releaseH3Executor?.(); releaseH3Executor = undefined; return null }
          if (releaseH3Executor === undefined) {
            const core = ctx.get('computeCore') as { executors?: {
              register(executor: ReturnType<typeof h3ComputeExecutor>): () => void
            } } | undefined
            if (core?.executors !== undefined) releaseH3Executor = core.executors.register(h3ComputeExecutor(adapter))
          }
          return adapter
        },
      }] } : {}),
      // The platform only sees exact task contracts that this running process has
      // self-tested. The callback is source-neutral: a builtin and a pinned installed
      // package produce the same adapter shape, with their own immutable digest.
      // Owner permission remains in the live heartbeat/admission gate.
      taskAdapters: async (): Promise<readonly VerifiedTaskAdapterClaim[]> => {
        const contract = inlineOrderContractOf(localOrderPlugin?.taskType ?? 'word_count')
        if (contract === null || !allowedTaskTypes.includes(contract.taskType)
          || !await verifyDefaultLocalService()) return []
        return [{
          task_type: contract.taskType,
          capability_id: contract.capabilityId,
          input_kinds: [contract.inputKind],
          output_kind: contract.outputKind,
          contract_version: contract.contractVersion,
          artifact_digest: `sha256:${localOrderPlugin?.packageDigest ?? BUILTIN_WORD_COUNT_ADAPTER_DIGEST}`,
          installation_state: localOrderPlugin === null ? 'builtin' : 'installed',
          health: 'verified',
          self_test: 'passed',
        }]
      },
      purchasedTaskAdapters: async (): Promise<readonly VerifiedTaskAdapterClaim[]> => {
        purchasedRuntimes = new Map()
        const workerId = edge?.workerId() ?? null
        if (!workerId) return []
        const catalog = purchasedCatalog()
        if (!catalog || typeof catalog.verifiedPurchasedOrderRuntimes !== 'function'
          || typeof catalog.runPurchasedOrderRuntime !== 'function') return []
        const provider = catalog.verifiedPurchasedOrderRuntimes
        const original = catalogIdentity(catalog)
        const originalProvider: unknown = Reflect.get(original, 'verifiedPurchasedOrderRuntimes')
        const originalRunner: unknown = Reflect.get(original, 'runPurchasedOrderRuntime')
        try {
          const claims: VerifiedTaskAdapterClaim[] = []
          const runtimes = await provider.call(catalog, workerId)
          const current = purchasedCatalog()
          if (!current || catalogIdentity(current) !== original
            || original.verifiedPurchasedOrderRuntimes !== originalProvider
            || original.runPurchasedOrderRuntime !== originalRunner) return []
          for (const runtime of runtimes) {
            if (allowedTaskTypes.includes(runtime.taskType)
              || purchasedRuntimes.has(runtime.taskType) || purchasedRuntimes.size >= 64
              || runtime.outputKind !== 'inline_json' || runtime.contractVersion !== 'v1') continue
            purchasedRuntimes.set(runtime.taskType, runtime)
            claims.push({ task_type: runtime.taskType, capability_id: runtime.capabilityId,
              input_kinds: ['inline'], output_kind: 'inline_json', contract_version: 'v1',
              artifact_digest: runtime.artifactDigest, package_digest: runtime.packageDigest,
              installation_state: 'installed', health: 'verified', self_test: 'passed' })
          }
          // An empty first proof can also mean account/device recovery or a
          // temporary source-read failure. Do not permanently cache that empty
          // Hello: retry with the existing bounded delay and current proofs.
          // No capability is advertised until the provider verifies it.
          if (claims.length === 0) retryAdapterHello()
          else {
            lastPurchasedHelloWorkerId = workerId
            nextAdapterHelloRetryAt = 0
            adapterHelloRetryDelayMs = 5_000
          }
          return claims
        } catch (error) {
          purchasedRuntimes.clear()
          retryAdapterHello()
          throw error
        }
      },
      purchasedFileTaskAdapters: async (): Promise<readonly VerifiedTaskAdapterClaim[]> => {
        purchasedFileRuntimes = new Map()
        const workerId = edge?.workerId() ?? null
        const catalog = purchasedCatalog()
        if (!workerId || typeof catalog?.verifiedPurchasedFileOrderRuntimes !== 'function'
          || typeof catalog.runPurchasedFileOrderRuntime !== 'function') return []
        const provider = catalog.verifiedPurchasedFileOrderRuntimes
        const original = catalogIdentity(catalog)
        const originalProvider: unknown = Reflect.get(original, 'verifiedPurchasedFileOrderRuntimes')
        const originalRunner: unknown = Reflect.get(original, 'runPurchasedFileOrderRuntime')
        try {
          const claims: VerifiedTaskAdapterClaim[] = []
          const runtimes = await provider.call(catalog, workerId)
          const current = purchasedCatalog()
          if (!current || catalogIdentity(current) !== original
            || original.verifiedPurchasedFileOrderRuntimes !== originalProvider
            || original.runPurchasedFileOrderRuntime !== originalRunner) return []
          for (const runtime of runtimes) {
            if (allowedTaskTypes.includes(runtime.taskType) || purchasedRuntimes.has(runtime.taskType)
              || purchasedFileRuntimes.has(runtime.taskType) || purchasedFileRuntimes.size >= 64
              || runtime.outputKind !== 'artifact_ref' || runtime.contractVersion !== 'v1'
              || !/^sha256:[0-9a-f]{64}$/u.test(runtime.contractSha256)
              || !/^[0-9a-f]{64}$/u.test(runtime.fileSchemaSha256)) continue
            purchasedFileRuntimes.set(runtime.taskType, runtime)
            claims.push({ task_type: runtime.taskType, capability_id: runtime.capabilityId,
              input_kinds: ['inline'], output_kind: 'artifact_ref', contract_version: 'v1',
              artifact_digest: runtime.artifactDigest, package_digest: runtime.packageDigest,
              installation_state: 'installed', health: 'verified', self_test: 'passed' })
          }
          if (claims.length > 0) {
            lastPurchasedHelloWorkerId = workerId
            nextAdapterHelloRetryAt = 0
            adapterHelloRetryDelayMs = 5_000
          }
          return claims
        } catch (error) { purchasedFileRuntimes.clear(); retryAdapterHello(); throw error }
      },
      allowEmptyDynamicAdapterRegistration: () => {
        const catalog = purchasedCatalog()
        return reviewedVideoHost !== null || catalog !== undefined && (typeof catalog.verifiedNativeH3OrderBindings === 'function'
          || (typeof catalog.verifiedPurchasedOrderRuntimes === 'function'
          && typeof catalog.runPurchasedOrderRuntime === 'function')
          || (typeof catalog.verifiedPurchasedFileOrderRuntimes === 'function'
            && typeof catalog.runPurchasedFileOrderRuntime === 'function'))
      },
      fileOrderRun: async (input) => {
        await assertH3TrialAdmission()
        const runtime = purchasedFileRuntimes.get(input.taskType)
        const workerId = edge?.workerId() ?? null
        const catalog = purchasedCatalog()
        if (!runtime || !workerId || !catalog?.runPurchasedFileOrderRuntime) {
          throw new ComputeError('COMPUTE_FILE_ADAPTER_UNAVAILABLE', 503)
        }
        return catalog.runPurchasedFileOrderRuntime({ ...input, workerId, productId: runtime.productId,
          entitlementId: runtime.entitlementId, artifactDigest: runtime.artifactDigest,
          runtimeDigest: runtime.runtimeDigest, contractSha256: runtime.contractSha256,
          fileSchemaSha256: runtime.fileSchemaSha256 })
      },
      artifactOrder: {
        taskType: 'bar_chart_svg_v1' as const,
        loadAndSelfTest: async () => {
          const selection = selectedArtifact
          if (selection === null) return null
          await assertH3TrialAdmission()
          const adapter = await createPinnedSvgVideoAdapter({
            root: selection.root, expectedDigest: selection.digest,
            expectedPackageDigest: selection.packageDigest,
            nodePath: process.execPath, pythonPath: selection.pythonPath,
            swiftPath: selection.swiftPath,
          })
          await selfTestPinnedSvgVideoAdapter(adapter)
          return adapter
        },
        publicationReady: async (artifactDigest: string, packageDigest: string) => {
          const origin = computeCoreOf()?.coreOrigin()
          const token = await contributorTokenOf()
          const ownerId = await contributorOwnerIdOf()
          if (origin === null || origin === undefined || token === undefined || ownerId === undefined) return false
          return (await readArtifactPublicationReadiness({ origin, token, ownerId,
            taskType: 'bar_chart_svg_v1', artifactDigest, packageDigest })).ready
        },
      },
      originOf: () => computeCoreOf()?.coreOrigin() ?? null,
      tokenOf: contributorTokenOf,
      ownerIdOf: contributorOwnerIdOf,
      agentTaskTypes,
      // Indirection lets an explicitly selected, verified bundle take effect in
      // this running Host after the node grant was first withdrawn.
      run: async (input): Promise<{ text: string }> => {
        await assertH3TrialAdmission()
        const purchased = purchasedRuntimes.get(input.taskType)
        if (!purchased) return orderRunner(input)
        if (!reviewedInlineUserParamsEmpty(input.taskParams)) {
          throw new ComputeError('COMPUTE_INLINE_PARAMETERS_INVALID', 400)
        }
        const workerId: string | null = edge?.workerId() ?? null
        const catalog = purchasedCatalog()
        if (!workerId || !catalog) throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
        return catalog.runPurchasedOrderRuntime({ workerId,
          productId: purchased.productId, entitlementId: purchased.entitlementId,
          taskType: purchased.taskType, artifactDigest: purchased.artifactDigest,
          runtimeDigest: purchased.runtimeDigest, inlineInput: input.inlineInput,
          signal: input.signal })
      },
    })
    : undefined
  async function readPublishedNativeArtifactOrders(): Promise<ArtifactOrderAdapter[]> {
    if (!await refreshH3TrialAdmission()) return []
    await h3Provider.refreshStatus()
    const workerId = edge?.workerId() ?? null
    const connectionId = edge?.connectionId() ?? null
    const ownerId = await contributorOwnerIdOf()
    const catalog = purchasedCatalog()
    if (!workerId || !connectionId || ownerId === undefined || !catalog?.verifiedNativeH3OrderBindings) return []
    const discoveryKey = `${ownerId}:${workerId}:${connectionId}:${h3ConfigurationEpoch}`
    nativeDiscovery = { key: discoveryKey, verified: false, withdraw: false, notBefore: Date.now() + 30_000 }
    if (!h3Provider.status().configured) return []
    const original = catalogIdentity(catalog)
    const method: unknown = Reflect.get(original, 'verifiedNativeH3OrderBindings')
    const readCurrent = async (): Promise<readonly NativeH3PublishedBinding[]> => {
      if (edge?.workerId() !== workerId || edge.connectionId() !== connectionId
        || await contributorOwnerIdOf() !== ownerId) return []
      const current = purchasedCatalog()
      if (!current || catalogIdentity(current) !== original
        || original.verifiedNativeH3OrderBindings !== method || !current.verifiedNativeH3OrderBindings) return []
      const bindings = await current.verifiedNativeH3OrderBindings(workerId)
      const after = purchasedCatalog()
      if (edge.workerId() !== workerId || edge.connectionId() !== connectionId || await contributorOwnerIdOf() !== ownerId
        || !after || catalogIdentity(after) !== original
        || Reflect.get(original, 'verifiedNativeH3OrderBindings') !== method) return []
      return bindings
    }
    const adapters: ArtifactOrderAdapter[] = []
    const bindings = await readCurrent()
    if (bindings.length > 16) throw new NodeContributorError('H3_NATIVE_SELECTION_INVALID')
    for (const binding of bindings) {
      try {
        adapters.push(await createPublishedNativeH3Adapter(h3Provider, binding, { ownerId, deviceId: workerId, connectionId },
          async () => (await readCurrent()).find(item => item.publicationId === binding.publicationId) ?? null,
          undefined, permit => h3OwnerSetup.runAdmittedReservedExecution(permit,
            () => h3Provider.runAdmittedExecution(permit), async (result) => {
              const facts = readOwnedH3ExecutionPermit(permit)
              if (result.filename !== 'result.mp4' || result.contentType !== 'video/mp4'
                || result.path !== join(facts.input.workspacePath, 'result.mp4')) {
                throw new ComputeError('H3_CANONICAL_OUTPUT_INVALID', 409)
              }
              const bytes = await readH3BoundedFile(result.path, 16 * 1024 * 1024)
              if (bytes.subarray(4, 8).toString('ascii') !== 'ftyp') throw new ComputeError('H3_CANONICAL_OUTPUT_INVALID', 409)
              return createHash('sha256').update(bytes).digest('hex')
            })))
      } catch { /* An unavailable actual binding or stale proof never opens this alias. */ }
    }
    const after = purchasedCatalog()
    if (edge?.connectionId() !== connectionId || edge.workerId() !== workerId
      || await contributorOwnerIdOf() !== ownerId || after === undefined || catalogIdentity(after) !== original
      || Reflect.get(original, 'verifiedNativeH3OrderBindings') !== method) return []
    nativeDiscovery = { key: discoveryKey, verified: adapters.length > 0, withdraw: false, notBefore: Date.now() + 30_000 }
    return adapters
  }
  const gaps = productionGaps({
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(edge === undefined ? {} : { connector: edge.connector, dispatchBound: true, resultBound: true }),
  })
  /**
   * Basis for `gaps`, derived from the same objects the call above used — never hand-written.
   *
   * The load-bearing line is `satisfiedByAssertion`: it asks `productionGaps` the counterfactual
   * question ("what would you still report without the call site's literal `true`s?") and keeps the
   * difference, so the entries a literal removed become readable instead of invisible. Make the call
   * site honest tomorrow and this list empties itself — it cannot drift from the array it explains.
   */
  const gapsBasis: NodeContributorGapsBasis = Object.freeze({
    workspaceRoot: config.workspaceRoot === undefined || config.workspaceRoot === ''
      ? 'derived' as const
      : 'configured' as const,
    transport: edge === undefined ? 'memory' as const : 'edge-worker' as const,
    dispatchAuthority: edge === undefined ? 'none' as const : 'process-local-hmac' as const,
    resultTransfer: edge === undefined ? 'absent' as const : 'inline-frame' as const,
    satisfiedByAssertion: Object.freeze(productionGaps({
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(edge === undefined ? {} : { connector: edge.connector }),
    }).filter(name => !gaps.includes(name))),
  })
  const assembly = createResidentAssembly({
    nodeId,
    agentVersion,
    policy,
    store,
    // AT-10: the two activity facts behind `allowWhileUserActive` used to be the constants
    // `() => false`, so the policy branch was unreachable. They are now measured — idle time from
    // this host (macOS `ioreg`, Windows `GetLastInputInfo`, cached 5s, ≤1s timeout) and voice
    // activity from whichever plugin really produces it. Neither can say "idle" when it cannot
    // tell: unmeasurable stays null, and the status projection reports it as unenforceable.
    hostActivity: { read: () => Promise.resolve(activity) },
    voiceActivity: () => voiceActive,
    verifySignature: edge?.binding.verifySignature ?? unconfiguredVerifier,
    leaseOf: edge === undefined ? unconfiguredLeaseSource : edge.binding.leaseOf,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(config.maxInputBytes === undefined ? {} : { maxInputBytes: config.maxInputBytes }),
    ...(edge === undefined ? {} : {
      connector: edge.connector,
      transport: edge.transport,
      capabilities: () => admission.capabilities,
      resultConsumer: edge.resultConsumer,
      ...(edge.inputSource === undefined ? {} : { inputSource: edge.inputSource }),
    }),
  })
  const state: AssemblyState = { assembly, gaps, gapsBasis, driver: 'idle', lastDriveFailure: null }
  async function refreshH3TrialAdmission(): Promise<boolean> {
    const before = h3TrialAdmissionClear
    try {
      const result = await h3OwnerSetup.readTrialAdmission()
      h3TrialAdmissionClear = result.state === 'clear'
      h3TrialAdmissionCode = result.state === 'clear' ? null : result.state === 'pending'
        ? 'H3_SETUP_SELF_TEST_PENDING' : 'H3_SETUP_SELF_TEST_UNKNOWN'
    } catch { h3TrialAdmissionClear = false; h3TrialAdmissionCode = 'H3_SETUP_TRIAL_GUARD_INVALID' }
    // A scoped save also holds the shared mutex briefly. Only a fresh clear read,
    // never the callback or an empty owner's configuration, may release that veto.
    h3TrialActive = !h3TrialAdmissionClear
    // Intake withdrawal does not change source/configuration identity of an existing lease.
    if (!h3TrialAdmissionClear || before !== h3TrialAdmissionClear) {
      applyPanelGate()
      state.assembly.applyPolicy(admission.policy)
    }
    return h3TrialAdmissionClear
  }
  async function assertH3TrialAdmission(): Promise<void> {
    await sharing.assertIdle()
    await h3OwnerSetup.assertTrialAdmission()
    if (!await refreshH3TrialAdmission()) throw new ComputeError('H3_SETUP_SELF_TEST_UNSETTLED', 409)
  }
  const refreshAdmission = async (): Promise<void> => {
    await refreshH3TrialAdmission()
    await refreshSupplyMode()
    // The transport gate covers newly arriving frames. The runtime policy also
    // covers offers buffered before permission was withdrawn. Updating policy
    // changes admission only; it never stops attempts, leases or result delivery.
    state.assembly.applyPolicy(admission.policy)
  }
  const capabilityIds = (availableOnly: boolean): readonly string[] => {
    const ids: string[] = []
    for (const capability of admission.capabilities) {
      if (availableOnly && !capability.available) continue
      if (!ids.includes(capability.capabilityId)) ids.push(capability.capabilityId)
    }
    return Object.freeze(ids)
  }
  const projected = (): NodeContributorStatus => Object.freeze({
    intake: supplyMode,
    intakeReason,
    intakeReasons: admission.reasons,
    declaredCapabilityIds: capabilityIds(false),
    acceptingCapabilityIds: capabilityIds(true),
    source: 'node-contributor' as const,
    constructed: true,
    mode: policy.mode,
    driver: state.driver,
    resident: state.assembly.status(),
    productionGaps: state.gaps,
    gapsBasis: state.gapsBasis,
    transport: state.assembly.status().transport,
    lastDriveFailure: state.lastDriveFailure,
  })
  /** Verify the selected default runner without accepting a different installed runtime's proof. */
  async function verifyDefaultLocalService(): Promise<boolean> {
    if (!selectionValid || policy.mode === 'OFF' || edge === undefined) return false
    const contract = inlineOrderContractOf(localOrderPlugin?.taskType ?? 'word_count')
    if (contract === null || !allowedTaskTypes.includes(contract.taskType)) return false
    if (!edge.capabilities().some(item => item.capabilityId === 'text.transform'
      && (item.available || localOrderPlugin !== null))) return false
    // A configured agent route would spend account quota, and its provider may not exist
    // until an order starts. Only a deterministic local runner or an active pinned plugin
    // can pass this no-charge fixture preflight.
    if (isolatedRoute !== null && localOrderPlugin === null) return false
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('local service preflight timed out')) }, 5_000)
      })
      let valid = true
      for (const sampleInput of [contract.sampleInput, ...(contract.additionalSampleInputs ?? [])]) {
        const output = await Promise.race([
          orderRunner({ taskType: contract.taskType, inlineInput: sampleInput, signal: controller.signal }),
          deadline,
        ])
        const document: unknown = JSON.parse(output.text)
        const lines = typeof document === 'object' && document !== null && !Array.isArray(document)
          ? (document as Record<string, unknown>).result_lines : undefined
        const expected = contract.taskType === 'text_sort' ? expectedTextSort(sampleInput) : null
        valid = typeof document === 'object' && document !== null && !Array.isArray(document)
          && (document as Record<string, unknown>).status === 'ok'
          && (document as Record<string, unknown>).task_type === contract.taskType
          && (document as Record<string, unknown>).schema_version === contract.contractVersion
          && (expected === null ? JSON.stringify(lines) === JSON.stringify(contract.sampleResultLines)
            : expected.accepts(lines))
        if (!valid) break
      }
      if (localOrderPlugin !== null) pluginSampleVerified = valid
      return valid
    } catch {
      if (localOrderPlugin !== null) pluginSampleVerified = false
      return false
    }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
  const assertManagedH3Setup = (): H3OwnerSetup => {
    if (config.h3OwnerConfigPath) throw new ComputeError('H3_SETUP_EXTERNAL_CONFIG_ACTIVE', 409)
    return h3OwnerSetup
  }
  const assertManagedCanonicalSetup = (): H3CanonicalOwnerSetup => {
    if (config.h3OwnerConfigPath) throw new ComputeError('H3_SETUP_EXTERNAL_CONFIG_ACTIVE', 409)
    return h3CanonicalSetup
  }
  const assertH3SetupIdle = (): Promise<void> => {
    // The helper owns its durable guard mutex; reading it here would reject our own lock.
    if (sharing.busy() || nativeReviewInProgress || artifactSelectionInProgress
      || state.assembly.runtime.inFlightCount() !== 0) throw new ComputeError('H3_SETUP_BUSY', 409)
    return Promise.resolve()
  }
  const assertAdmittedH3Execution = async (permit: OwnedH3ExecutionPermit): Promise<void> => {
    const facts = readOwnedH3ExecutionPermit(permit)
    if (nativeReviewInProgress || artifactSelectionInProgress || h3SetupWriteInProgress
      || edge?.workerId() !== facts.lease.device_id || edge.connectionId() !== facts.lease.connection_id
      || await contributorOwnerIdOf() !== facts.lease.owner_id) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
    const running = state.assembly.runtime.inFlightAttempts()
    const records = state.assembly.runtime.activeAttempts()
    // A count is only a competition veto. Authority comes from the original delivered lease object.
    if (running.length !== 1 || !running.some((attempt) => {
      const record = records.find(item => item.taskId === attempt.taskId && item.attempt === attempt.attempt)
      if (attempt.taskType !== facts.lease.task_type || record?.status !== 'EXECUTING' || record.leaseExpiresAt === null) return false
      try { return edge.binding.leaseOf(attempt.taskId, attempt.attempt, record.leaseExpiresAt).nativeDeviceLease === facts.lease }
      catch { return false }
    })) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
  }
  const assertReviewSlotAvailable = (): void => {
    if (sharing.busy() || nativeReviewInProgress || h3SetupWriteInProgress || h3TrialActive || artifactSelectionInProgress
      || state.assembly.runtime.inFlightCount() !== 0) throw new NodeContributorError('H3_NATIVE_SELECTION_BUSY')
  }
  const assertReviewedH3Execution = async (permit: OwnedNativeH3ReviewExecutionPermit): Promise<void> => {
    const facts = readOwnedNativeH3ReviewExecutionPermit(permit)
    const active = activeNativeReview
    if (!active || facts.request !== active.request || facts.ownerId !== active.ownerId || facts.deviceId !== active.deviceId
      || edge?.workerId() !== active.deviceId || edge.connectionId() !== active.connectionId
      || await contributorOwnerIdOf() !== active.ownerId || !nativeReviewInProgress
      || h3SetupWriteInProgress || artifactSelectionInProgress || state.assembly.runtime.inFlightCount() !== 0) {
      throw new ComputeError('H3_REVIEW_EXECUTION_REFUSED', 409)
    }
    await facts.assertCurrent()
  }
  const runtimeDirectory = fileURLToPath(new URL('../runtime/h3-v2/', import.meta.url))
    .replace(/([/\\])app\.asar([/\\])/u, '$1app.asar.unpacked$2')
  const h3OwnerSetup = new H3OwnerSetup({ homePath: resolveHarnessHome(), runtimeDirectory,
    readScope: readH3SetupScope, assertIdle: assertH3SetupIdle, assertAdmittedExecution: assertAdmittedH3Execution,
    assertReviewedExecution: assertReviewedH3Execution,
    onTrialActivity(active) {
      if (h3TrialActive === active) return
      h3TrialActive = active
      if (active) h3TrialAdmissionClear = false
      applyPanelGate()
      state.assembly.applyPolicy(admission.policy)
    },
    async onSaved(configPath, transaction) {
      const saved = await h3OwnerSetup.readCurrentConfigIdentity()
      if (saved === null || saved.configPath !== configPath) throw new ComputeError('H3_SETUP_REVISION_CONFLICT', 409)
      await h3ManagedSelection.selectSaved('v2', saved, transaction)
      h3Provider.invalidate(true)
      if (edge?.connectionId()) {
        try { await edge.refreshNativeH3OrderAdapters() }
        catch { /* Local claims are withdrawn; saving does not establish platform readiness. */ }
      }
      await refreshAdmission()
    },
  })
  const sharedH3Coordination = h3OwnerSetup.coordinationPorts()
  const h3CanonicalSetup = new H3CanonicalOwnerSetup({ homePath: resolveHarnessHome(),
    coordinator: sharedH3Coordination.coordinator, readScope: readH3SetupScope,
    readAdmission: () => h3OwnerSetup.readTrialAdmission(),
    assertClearWithinTransaction: sharedH3Coordination.assertClearWithinTransaction,
    assertIdle: assertH3SetupIdle, externalConfigActive: () => !!config.h3OwnerConfigPath,
    onTrialActivity(active) {
      if (h3TrialActive === active) return
      h3TrialActive = active
      if (active) h3TrialAdmissionClear = false
      applyPanelGate(); state.assembly.applyPolicy(admission.policy)
    },
    async onSaved(saved, transaction) {
      await h3ManagedSelection.selectSaved('canonical', saved, transaction)
      h3Provider.invalidate(true)
      if (edge?.connectionId()) {
        try { await edge.refreshNativeH3OrderAdapters() }
        catch { /* Saved local configuration cannot grant platform supply. */ }
      }
      await refreshAdmission()
    },
  })
  const h3ManagedSelection = new H3ManagedSelection({ homePath: resolveHarnessHome(),
    readScope: readH3SetupScope,
    readV2Current: () => h3OwnerSetup.readCurrentConfigIdentity(),
    readCanonicalCurrent: () => h3CanonicalSetup.readCurrentConfigIdentity(),
  })
  const managedH3Setup = h3OwnerSetup
  ctx.effect(() => () => managedH3Setup.dispose(), 'node-contributor: owner setup lifecycle')
  const managedCanonicalSetup = h3CanonicalSetup
  ctx.effect(() => () => managedCanonicalSetup.dispose(), 'node-contributor: canonical owner setup lifecycle')
  const service: NodeContributorService = {
    prepareVideoAssetPlan: (request, signal) => prepareVideoAssetPlan(ctx, request, signal),
    inspectH3OwnerSetup: (selection, signal) => assertManagedH3Setup().inspect(selection, signal),
    async saveH3OwnerSetup(request, signal) {
      const setup = assertManagedH3Setup()
      await assertH3TrialAdmission()
      if (h3SetupWriteInProgress) throw new ComputeError('H3_SETUP_BUSY', 409)
      h3SetupWriteInProgress = true
      applyPanelGate(); state.assembly.applyPolicy(admission.policy)
      try { await assertH3SetupIdle(); return await setup.save(request, signal) }
      finally { h3SetupWriteInProgress = false; await refreshAdmission() }
    },
    async startH3OwnerSelfTest(request, signal) {
      if (h3SetupWriteInProgress) throw new ComputeError('H3_SETUP_BUSY', 409)
      await refreshH3TrialAdmission()
      return assertManagedH3Setup().startSelfTest(request, signal)
    },
    h3OwnerSelfTestStatus: operationId => assertManagedH3Setup().selfTestStatus(operationId),
    inspectH3CanonicalSetup: selection => assertManagedCanonicalSetup().inspect(selection),
    async saveH3CanonicalSetup(request) {
      const setup = assertManagedCanonicalSetup()
      await assertH3TrialAdmission()
      if (h3SetupWriteInProgress) throw new ComputeError('H3_SETUP_BUSY', 409)
      h3SetupWriteInProgress = true
      applyPanelGate(); state.assembly.applyPolicy(admission.policy)
      try { await assertH3SetupIdle(); return await setup.save(request) }
      finally { h3SetupWriteInProgress = false; await refreshAdmission() }
    },
    async startH3CanonicalTrial(request) {
      if (h3SetupWriteInProgress) throw new ComputeError('H3_SETUP_BUSY', 409)
      await refreshH3TrialAdmission()
      return assertManagedCanonicalSetup().startSelfTest(request)
    },
    h3CanonicalTrialStatus: operationId => assertManagedCanonicalSetup().selfTestStatus(operationId),
    async verifiedH3CanonicalSetupBinding(request) {
      const setup = assertManagedCanonicalSetup()
      const initial = await setup.freshVerifiedCanonicalBinding(request)
      const current = await h3Provider.nativeAuthorBindingCanonical()
      const after = await setup.freshVerifiedCanonicalBinding(request)
      const selected = await h3ManagedSelection.readCurrent()
      if (selected?.runtime !== 'canonical' || selected.revision !== request.revision
        || current.localOwnerConfigDigest !== initial.localOwnerConfigDigest
        || current.localOwnerConfigDigest !== after.localOwnerConfigDigest
        || nativeH3PublicBindingDigest(current.binding) !== nativeH3PublicBindingDigest(initial.binding)
        || nativeH3PublicBindingDigest(current.binding) !== nativeH3PublicBindingDigest(after.binding)) {
        throw new ComputeError('H3_SETUP_REVISION_CONFLICT', 409)
      }
      return current
    },
    async verifiedH3OwnerSetupBinding(revision, contextId) {
      const setup = assertManagedH3Setup()
      const initial = await setup.freshVerifiedBinding(revision, contextId)
      const current = await h3Provider.nativeAuthorBindingV2()
      const after = await setup.freshVerifiedBinding(revision, contextId)
      if (current.localOwnerConfigDigest !== initial.localOwnerConfigDigest
        || current.localOwnerConfigDigest !== after.localOwnerConfigDigest
        || nativeH3PublicBindingDigest(current.binding) !== nativeH3PublicBindingDigest(initial.binding)
        || nativeH3PublicBindingDigest(current.binding) !== nativeH3PublicBindingDigest(after.binding)) {
        throw new ComputeError('H3_SETUP_REVISION_CONFLICT', 409)
      }
      return current
    },
    status: projected,
    async runNativeH3ReviewChallenge(input) {
      await assertH3TrialAdmission()
      assertReviewSlotAvailable()
      const ownerId = await contributorOwnerIdOf()
      const deviceId = edge?.workerId() ?? null
      const connectionId = edge?.connectionId() ?? null
      if (ownerId === undefined || deviceId === null || connectionId === null) throw new ComputeError('H3_REVIEW_EXECUTION_REFUSED', 409)
      // Recheck after authentication reads before claiming the sole local review slot.
      assertReviewSlotAvailable()
      activeNativeReview = { request: input, ownerId, deviceId, connectionId }
      nativeReviewInProgress = true
      const previousPanel = panelAccepting
      service.setPanelAccepting(false)
      try {
        if (state.assembly.runtime.inFlightCount() !== 0) throw new NodeContributorError('H3_NATIVE_SELECTION_BUSY')
        return await runNativeH3ReviewChallenge(h3Provider, input, async () => {
          const ownerId = await contributorOwnerIdOf()
          const deviceId = edge?.workerId() ?? null
          return ownerId === undefined || deviceId === null ? null : { ownerId, deviceId }
        }, workspaceRoot, undefined, (permit, execute) => h3OwnerSetup.runReviewedReservedExecution(permit, execute,
          result => Promise.resolve(result.challenge_result_sha256)), permit => h3Provider.runReviewedExecution(permit))
      } finally {
        activeNativeReview = null
        nativeReviewInProgress = false
        panelAccepting = previousPanel
        applyPanelGate()
        state.assembly.applyPolicy(admission.policy)
      }
    },
    nativeH3AuthorBinding: () => h3Provider.nativeAuthorBinding(),
    nativeH3AuthorBindingV2: () => h3Provider.nativeAuthorBindingV2(),
    nativeH3AuthorBindingCanonical: () => h3Provider.nativeAuthorBindingCanonical(),
    nativeH3AuthorBindingCurrent: () => h3Provider.nativeAuthorBindingCurrent(),
    validateNativeH3PresenceChallenge: input => validateNativeH3PresenceChallenge(h3Provider, input, async () => {
      const ownerId = await contributorOwnerIdOf()
      const deviceId = edge?.workerId() ?? null
      const connectionId = edge?.connectionId() ?? null
      return ownerId === undefined || deviceId === null || connectionId === null ? null : { ownerId, deviceId, connectionId }
    }),
    async selectNativeH3AuthorBinding(input) {
      await assertH3TrialAdmission()
      if (state.assembly.runtime.inFlightCount() !== 0) throw new NodeContributorError('H3_NATIVE_SELECTION_BUSY')
      const selected = await selectNativeH3Binding(h3Provider, input)
      return { taskType: selected.declaration.taskType, artifactDigest: selected.sourceDigest,
        packageDigest: nativeH3PublicBindingDigest(selected.declaration),
        ...selected.localOwnerConfigDigest === undefined ? {} : { localOwnerConfigDigest: selected.localOwnerConfigDigest },
        taskDefinitionSha256: selected.taskDefinitionSha256,
        inventoryAlgorithm: 'qianshou.native-binding-package.v1',
        localVerified: true, platformReady: false }
    },
    h3VideoReadiness: () => h3TrialAdmissionCode === null ? h3Provider.status()
      : { ...h3Provider.status(), ready: false, code: h3TrialAdmissionCode },
    nodeIdentity: () => nodeId,
    acknowledgedWorkerId: () => edge?.workerId() ?? null,
    acknowledgedConnectionId: () => edge?.connectionId() ?? null,
    observePurchasedOrderChallenge: (observation) => {
      if (!edge) throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
      return edge.observeOrderAdapterChallenge(observation)
    },
    observeNativeH3DeviceKeyProof: (observation) => {
      if (!edge) throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
      return edge.observeNativeH3DeviceKeyProof(observation)
    },
    observeNativeH3DeviceConfigProof: (observation) => {
      if (!edge) throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
      return edge.observeNativeH3DeviceConfigProof(observation)
    },
    observeNativeH3DevicePresence: (observation) => {
      if (!edge) throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
      return edge.observeNativeH3DevicePresence(observation)
    },
    async refreshPurchasedOrderAdapters() {
      if (!edge) return
      const result = await state.assembly.runtime.refreshSessionWhenIdle()
      if (result === 'unavailable') throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
    },
    async refreshNativeH3OrderAdapters() {
      if (!edge) throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
      try { await edge.refreshNativeH3OrderAdapters() }
      finally { await refreshAdmission() }
    },
    nativeH3OrderAdapterReady: async taskType => await refreshH3TrialAdmission()
      && (await edge?.nativeH3OrderAdapterReady(taskType) ?? false),
    orderExecutor: () => !selectionValid ? { kind: 'unavailable' } : localOrderPlugin === null ? { kind: 'builtin' } : {
      kind: 'plugin', packageName: localOrderPlugin.packageName,
      ...(localOrderPlugin.taskType === 'word_count' ? {} : { taskType: localOrderPlugin.taskType }),
    },
    orderExecutorVerified: () => selectionValid && policy.mode !== 'OFF'
      && edge !== undefined && allowedTaskTypes.includes(localOrderPlugin?.taskType ?? 'word_count')
      && edge.capabilities().some(item => item.capabilityId === 'text.transform' && item.available)
      && (localOrderPlugin === null ? isolatedRoute === null : pluginSampleVerified),
    canSelectOrderBundle: async packageName => (await findInstalledInlineOrderBinding(packageName, localOrderHost)) !== null,
    orderBundleContract: async (packageName) => {
      const binding = await findInstalledInlineOrderBinding(packageName, localOrderHost)
      const contract = binding === null ? null : inlineOrderContractOf(binding.taskType ?? 'word_count')
      return contract === null ? null : { taskType: contract.taskType, capabilityId: contract.capabilityId }
    },
    async selectOrderExecutor(input) {
      if (input === null || typeof input !== 'object' || (input.kind !== 'builtin' && input.kind !== 'plugin')
        || (input.kind === 'plugin' && (typeof input.packageName !== 'string' || Object.keys(input).length !== 2))
        || (input.kind === 'builtin' && Object.keys(input).length !== 1)) {
        throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_SELECTION_INVALID')
      }
      const owner = await computeCoreOf()?.ownerSupplyPolicy?.()
      if (owner === undefined || owner.enabledServiceIds.includes('node')) {
        throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_SERVICE_ENABLED')
      }
      if (state.assembly.runtime.inFlightCount() !== 0) {
        throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_BUSY')
      }
      let binding: LocalTextStatisticsOrderBinding | null = null
      if (input.kind === 'plugin') {
        const inspected = await inspectInstalledInlineOrderBundle(input.packageName, localOrderHost)
        if (!inspected.eligible) throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
        binding = inspected.binding
      }
      // Close the live admission gate before the last in-flight check and disk write.
      // A failed recheck leaves intake paused; a later owner grant reopens it.
      service.setPanelAccepting(false)
      const current = await computeCoreOf()?.ownerSupplyPolicy?.()
      if (current === undefined || current.enabledServiceIds.includes('node')
        || state.assembly.runtime.inFlightCount() !== 0) {
        throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_BUSY')
      }
      const profileDir = profileDirOf()
      if (profileDir === undefined) throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_UNAVAILABLE')
      try {
        await saveOrderExecutorSelection(profileDir, binding === null ? { kind: 'builtin' } : { kind: 'plugin', binding })
      } catch { throw new NodeContributorError('COMPUTE_ORDER_EXECUTOR_SAVE_FAILED') }
      localOrderPlugin = binding
      orderRunner = binding === null ? baseRunner : createLocalInlineOrderRunner(binding, localOrderHost, baseRunner)
      allowedTaskTypes.splice(0, allowedTaskTypes.length, ...configuredTaskTypes)
      if (h3Configured && !allowedTaskTypes.includes('video_generate')) allowedTaskTypes.push('video_generate')
      if (binding?.taskType !== undefined && !allowedTaskTypes.includes(binding.taskType)) allowedTaskTypes.push(binding.taskType)
      if (selectedArtifact !== null && !allowedTaskTypes.includes('bar_chart_svg_v1')) allowedTaskTypes.push('bar_chart_svg_v1')
      edge?.binding.updateAllowedTaskTypes(allowedTaskTypes.filter(type =>
        !['bar_chart_svg_v1', 'video_generate'].includes(type) || edge.artifactReady(type)))
      selectionValid = true
      localOrderPluginReady = true
      pluginSampleVerified = binding !== null
      applyPanelGate()
      try { await state.assembly.runtime.refreshSessionWhenIdle() }
      catch { /* The next verified reconnect will publish the changed adapter snapshot. */ }
      return service.orderExecutor() as { kind: 'builtin' } | { kind: 'plugin'; packageName: string; taskType?: string }
    },
    async selectArtifactAdapter(input) {
      await assertH3TrialAdmission()
      if (h3SetupWriteInProgress || h3TrialActive || artifactSelectionInProgress) throw new NodeContributorError('COMPUTE_ARTIFACT_ADAPTER_SELECTION_BUSY')
      artifactSelectionInProgress = true
      try {
        if (input === null || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).sort().join(',') !== 'digest,pythonPath,root,swiftPath'
          || edge === undefined) throw new NodeContributorError('COMPUTE_ARTIFACT_ADAPTER_SELECTION_INVALID')
        const profileDir = profileDirOf()
        if (profileDir === undefined) throw new NodeContributorError('COMPUTE_ARTIFACT_ADAPTER_PROFILE_UNAVAILABLE')
        // A registered skill may use any name, but this launcher still accepts only
        // its canonical scripts/order_adapter directory and pinned bar-chart contract.
        // It never interprets SKILL.md or a task-provided executable path.
        await verifyInstalledArtifactRoot(input.root)
        const packageDigest = await installedSvgVideoPackageDigest(input.root,
          input.pythonPath, input.swiftPath)
        const adapter = await createPinnedSvgVideoAdapter({
          root: input.root, expectedDigest: input.digest, expectedPackageDigest: packageDigest,
          nodePath: process.execPath,
          pythonPath: input.pythonPath, swiftPath: input.swiftPath,
        })
        await selfTestPinnedSvgVideoAdapter(adapter)
        await assertH3TrialAdmission()
        const previousPanel = panelAccepting
        service.setPanelAccepting(false)
        try {
          if (state.assembly.runtime.inFlightCount() !== 0) {
            throw new NodeContributorError('COMPUTE_ARTIFACT_ADAPTER_SELECTION_BUSY')
          }
          edge.withdrawArtifact()
          try { await saveArtifactAdapterSelection(profileDir,
            { ...input, packageDigest, inventoryAlgorithm: SVG_VIDEO_PACKAGE_ALGORITHM }) }
          catch { throw new NodeContributorError('COMPUTE_ARTIFACT_ADAPTER_SAVE_FAILED') }
          selectedArtifact = { ...input, packageDigest, inventoryAlgorithm: SVG_VIDEO_PACKAGE_ALGORITHM }
          if (!allowedTaskTypes.includes('bar_chart_svg_v1')) allowedTaskTypes.push('bar_chart_svg_v1')
          try { await state.assembly.runtime.refreshSessionWhenIdle() }
          catch { /* Saved selection stays dormant until a verified reconnect. */ }
          await refreshAdmission()
          return { taskType: 'bar_chart_svg_v1', artifactDigest: adapter.artifactDigest,
            packageDigest: `sha256:${packageDigest}`,
            inventoryAlgorithm: SVG_VIDEO_PACKAGE_ALGORITHM,
            localVerified: true, platformReady: edge.artifactReady() }
        } finally {
          panelAccepting = previousPanel
          applyPanelGate()
          state.assembly.applyPolicy(admission.policy)
        }
      } finally { artifactSelectionInProgress = false }
    },
    async canEnableLocalService(serviceId) {
      if (serviceId !== 'node' || policy.mode === 'OFF' || edge === undefined) return false
      if (!await refreshH3TrialAdmission()) return false
      try {
        // H3-only hosts qualify through the fixed actual provider and current device proof,
        // independently of any installed text product or default word-count executor.
        if ((await readPublishedNativeArtifactOrders()).length > 0) return true
      } catch { /* An invalid native proof never qualifies this service. */ }
      const workerId = edge.workerId()
      const catalog = purchasedCatalog()
      if (workerId && catalog) {
        try {
          // This provider rereads account ownership, the device receipt and installed bytes.
          const installed = typeof catalog.verifiedPurchasedOrderRuntimes === 'function'
            && typeof catalog.runPurchasedOrderRuntime === 'function'
            ? await catalog.verifiedPurchasedOrderRuntimes(workerId) : []
          if (installed.some(item => item.outputKind === 'inline_json' && item.contractVersion === 'v1')) return true
          const files = await catalog.verifiedPurchasedFileOrderRuntimes?.(workerId) ?? []
          if (typeof catalog.runPurchasedFileOrderRuntime === 'function' && files.some(item => item.outputKind === 'artifact_ref'
            && item.contractVersion === 'v1' && /^sha256:[0-9a-f]{64}$/u.test(item.contractSha256)
            && /^[0-9a-f]{64}$/u.test(item.fileSchemaSha256))) return true
        } catch { /* A failed current receipt check cannot qualify a dynamic adapter. */ }
      }
      return verifyDefaultLocalService()
    },
    async start() {
      // The mirror is refreshed before the socket opens, so the very first heartbeat
      // already carries the owner's real switch instead of a default.
      await refreshAdmission()
      await state.assembly.runtime.start()
      await refreshAdmission()
      state.driver = 'running'
      return projected()
    },
    async tick() {
      await h3Provider.refreshStatus()
      const nativeWorker = edge?.workerId()
      const nativeConnection = edge?.connectionId()
      const nativeOwner = await contributorOwnerIdOf()
      const discoveryKey = `${nativeOwner}:${nativeWorker}:${nativeConnection}:${h3ConfigurationEpoch}`
      const shouldDiscover = h3Provider.status().configured && (nativeDiscovery?.key !== discoveryKey
        || nativeDiscovery.verified || Date.now() >= nativeDiscovery.notBefore)
      if (edge !== undefined && nativeWorker && nativeConnection && nativeOwner !== undefined
        && (shouldDiscover || nativeDiscovery?.withdraw)) {
        try { await edge.refreshNativeH3OrderAdapters() }
        catch { /* Current native proof loss withdraws the aliases before admission is projected. */ }
      }
      await refreshAdmission()
      await state.assembly.tick()
      const workerId = edge?.workerId() ?? null
      const retryCatalog = purchasedCatalog()
      const hasPurchasedDiscovery = retryCatalog !== undefined && ((typeof retryCatalog.verifiedPurchasedOrderRuntimes === 'function'
        && typeof retryCatalog.runPurchasedOrderRuntime === 'function')
        || (typeof retryCatalog.verifiedPurchasedFileOrderRuntimes === 'function'
          && typeof retryCatalog.runPurchasedFileOrderRuntime === 'function'))
      if (h3TrialAdmissionClear && workerId && hasPurchasedDiscovery && (edge?.verifiedArtifactTaskTypes().length ?? 0) === 0
        && workerId !== lastPurchasedHelloWorkerId
        && Date.now() >= nextAdapterHelloRetryAt) {
        await state.assembly.runtime.refreshSessionWhenIdle()
      }
      state.driver = 'running'
      return projected()
    },
    async stop(reason) {
      await state.assembly.runtime.stop(reason)
      state.driver = 'idle'
      return projected()
    },
    setPanelAccepting(on) {
      panelAccepting = on
      applyPanelGate()
      state.assembly.applyPolicy(admission.policy)
    },
  }
  ctx.provide(NODE_CONTRIBUTOR_SERVICE, service)
  ctx.provide('qianshouMediaNodeExecutor', sharing.executor)
  const mediaControl: MediaNodeControl = registerMediaNodeRoutes(ctx, { gatewayOrigin: mediaGatewayOrigin,
    directory: join(resolveHarnessHome(), 'media-node-sessions'), adapterVersion: agentVersion,
    ownerId: contributorOwnerIdOf, accessToken: contributorTokenOf,
    reconnectInitialMs: config.mediaReconnectInitialMs ?? 1000, reconnectMaxMs: config.mediaReconnectMaxMs ?? 60000,
    requestTimeoutMs: config.mediaRequestTimeoutMs ?? 30000, waitMs: config.mediaChannelWaitMs ?? 10000,
    discoveryTimeoutMs: config.mediaDiscoveryTimeoutMs ?? 10000 })
  registerSharingRoutes(ctx, sharing)
  const selectedSharing = sharing
  ctx.effect(() => { selectedSharing.start(); return () => selectedSharing.close() }, 'sharing: persistent supervision')
  ctx.provide('qianshou.market.hello', {
    refresh: async () => {
      if (edge === undefined) return
      try {
        await state.assembly.runtime.refreshSessionWhenIdle()
      } catch {
        // The saved selection remains; a failed Hello must not be reported as a
        // successful platform update. A later reconnect reads the current snapshot.
      }
    },
  })
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/node/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      await h3Provider.refreshStatus()
      return Response.json({ ...service.status(), h3Video: service.h3VideoReadiness() }, {
        status: 200,
        headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      })
    },
  }), 'node-contributor: status route')
  if (config.autoStart === true) {
    ctx.effect(() => {
      // 常驻驱动：一拍 = 一次连接/心跳/接单，串行不重叠。
      //
      // 为什么不是加载期 `await service.start()`（2026-09-17 实测的宿主级故障）：
      // 账号可能在插件加载**之后**才登录，那时 `connect()` 抛 TRANSPORT_NOT_CONFIGURED，
      // 而 `ctx.effect` 里的 rejection 会作为致命加载错误打掉**整个宿主**——
      // 表现为「节点一开，工作台就起不来」。真正正确的语义是：没登录就待命，
      // 登录后自愈。失败只记录成可读的 `lastDriveFailure`，绝不外抛。
      //
      // 为什么必须有这个定时器：`tickOnce()` 是接单的唯一入口（先心跳、再逐个受理缓冲的派单），
      // 在此之前它在生产代码里**没有任何调用方**——即节点连上了也永远不会接单。
      let driving = false
      const drive = async (): Promise<void> => {
        if (driving) return
        driving = true
        try {
          await service.tick()
          state.lastDriveFailure = null
        } catch (error) {
          // 未配置/未登录/链路断开/已停止：只记原因，下一拍再试。一拍失败不代表节点坏掉，
          // 也不允许把失败抛给宿主（加载期外抛会打掉整个宿主进程）。
          state.lastDriveFailure = failureCodeOf(error)
          // 运行时**刻意不自己重连**（契约见 failure.spec.ts：「does not auto-reconnect」），
          // 重连是上层的决定。常驻节点的部署策略就是「自己恢复」，所以驱动在这里显式走一次
          // pause→resume：没有会话时它重新建链，有会话时是空操作。
          await reconnect()
        } finally {
          driving = false
        }
      }
      const reconnect = async (): Promise<void> => {
        try {
          state.assembly.runtime.pause()
          await state.assembly.runtime.resume()
        } catch {
          // 下一拍再试；这里绝不外抛。
        }
      }
      const timer = setInterval(() => { void drive() }, RESIDENT_TICK_MS)
      void drive()
      return () => {
        clearInterval(timer)
        void service.stop('fiber disposed')
      }
    }, 'node-contributor: resident loop')
  }
}

const ACCESS_REF = 'QIANSHOU_ACCOUNT_ACCESS_TOKEN'
/** Renew a JWT access credential this long before `exp`, matching the account session. */
const ACCESS_RENEW_SKEW_MS = 30_000

/** Stored access credential, when this host has a credential service. */
interface StoredAccess {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

/**
 * Read the window's stored access credential without refreshing it.
 * A host with no credential service returns undefined so the caller can use
 * the account session. A present service that has no token stays undefined
 * and must not fall through to a refresh.
 * @param ctx - Host scope.
 * @returns A reader, or undefined when this host has no credential service.
 */
function storedAccessToken(ctx: Context): (() => Promise<string | undefined>) | undefined {
  const credentials = (ctx as { get?: (name: string) => Partial<StoredAccess> | undefined }).get?.('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
  const resolve = credentials.resolve.bind(credentials)
  return async () => {
    const resolved = await resolve(ACCESS_REF)
    return typeof resolved?.value === 'string' ? resolved.value : undefined
  }
}

/**
 * Owner id from a stored access credential, without a network read.
 * Expired, non-JWT, and non-numeric subjects are not owner ids.
 * @param token - Saved access credential.
 * @param nowMs - Current time in milliseconds.
 * @returns The owner id, or null.
 */
export function ownerIdFromStoredAccess(token: string, nowMs: number): number | null {
  const payload = token.split('.')[1]
  if (payload === undefined || payload === '') return null
  let record: { sub?: unknown; exp?: unknown }
  try {
    record = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown }
  } catch {
    return null
  }
  if (typeof record.exp === 'number' && record.exp * 1000 <= nowMs) return null
  if (typeof record.sub !== 'string' || !/^[1-9]\d*$/.test(record.sub)) return null
  const ownerId = Number(record.sub)
  return Number.isSafeInteger(ownerId) ? ownerId : null
}

/**
 * Owner id already known in this process.
 * The account snapshot wins when it names one. A stored access credential is
 * the fallback. Neither path refreshes the credential.
 * @param ctx - Host scope.
 * @returns The owner id, or undefined when this process cannot name one.
 */
async function localOwnerId(ctx: Context): Promise<number | undefined> {
  const stored = storedAccessToken(ctx)
  let ownerId: number | undefined
  if (stored !== undefined) {
    try {
      const token = await stored()
      const parsed = token === undefined ? null : ownerIdFromStoredAccess(token, Date.now())
      if (parsed !== null) ownerId = parsed
    } catch {
      // A failed credential read is not a reason to ask the core.
    }
  }
  const account = (ctx as { get?: (name: string) => { state?: () => Promise<{ account: { id: string } | null }> } | undefined }).get?.('qianshouAccount')
  if (typeof account?.state === 'function') {
    try {
      const id = (await account.state()).account?.id
      if (id !== undefined && /^[1-9]\d*$/.test(id)) ownerId = Number(id)
    } catch {
      // An unreadable account snapshot keeps the id from the stored credential.
    }
  }
  return ownerId
}

/**
 * Whether a saved access credential must be renewed before it is sent.
 * A non-JWT value is left alone. A JWT inside the renewal window, or one that
 * cannot be read, must not be sent as a live access credential.
 * @param token - Saved access credential.
 * @param nowMs - Current time in milliseconds.
 * @returns True when the account session should renew it.
 */
export function storedAccessNeedsRenewal(token: string, nowMs: number): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === '') return false
  let record: { exp?: unknown }
  try {
    record = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown }
  } catch {
    return true
  }
  if (typeof record.exp !== 'number') return false
  return record.exp * 1000 <= nowMs + ACCESS_RENEW_SKEW_MS
}

/**
 * Access token for the Edge worker.
 * An unexpired stored credential is used as-is. An expired JWT is renewed
 * through the account session, which keeps the refresh grant across a network
 * loss. A missing credential is not a reason to renew.
 * @param stored - Reader for the saved access credential, when the host has one.
 * @param ensure - Account-session renewal, used when the saved JWT is no longer sendable.
 * @returns The token, or undefined when there is nothing to send.
 */
export async function readContributorAccessToken(
  stored: (() => Promise<string | undefined>) | undefined,
  ensure: (() => Promise<string | null>) | undefined,
): Promise<string | undefined> {
  if (stored !== undefined) {
    try {
      const value = await stored()
      if (value === undefined || value.length === 0) return undefined
      if (!storedAccessNeedsRenewal(value, Date.now())) return value
      if (ensure === undefined) return undefined
      const renewed = await ensure()
      return renewed !== null && renewed.length > 0 ? renewed : undefined
    } catch {
      // A failed credential read is not a reason to invent a token.
      return undefined
    }
  }
  if (ensure === undefined) return undefined
  const token = await ensure()
  return token !== null && token.length > 0 ? token : undefined
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
    throw new NodeContributorError((error as ComputeError).code)
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
    : String((createRequire(import.meta.url)('../package.json') as { version: string }).version)
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new NodeContributorError('COMPUTE_CONTRIBUTOR_AGENT_VERSION_INVALID')
  return value
}

function resolveStorePath(configured: string | undefined): string {
  if (configured !== undefined && configured !== '') return requireAbsolute(configured)
  return resolve(join(resolveHarnessHome(), 'qianshou', 'node-tasks.json'))
}

/**
 * Attempt workspace used when `workspaceRoot` is empty.
 *
 * Same home as {@link resolveStorePath}: an installed, signed-in host must have a
 * real directory so `statfs` can report free bytes. Empty used to stay unset,
 * `readDiskFreeBytes` returned 0, and the 10 GiB floor then refused every offer
 * with `DISK_LOW` even when the disk had tens of gigabytes free.
 * @param configured - Absolute path from cordis.yml, or empty for the default.
 * @returns Absolute attempt-workspace directory.
 */
export function resolveWorkspaceRoot(configured: string | undefined): string {
  if (configured !== undefined && configured !== '') return requireAbsolute(configured)
  return resolve(join(resolveHarnessHome(), 'qianshou', 'attempts'))
}

/**
 * Home directory used when `storePath` is empty.
 * @param env - Process environment; `DSH_HOME` wins when nonempty.
 * @param home - User home used when `DSH_HOME` is absent.
 * @returns Absolute Harness home directory.
 */
export function resolveHarnessHome(env: { DSH_HOME?: string } = process.env, home = homedir()): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(home, '.deepseek-harness')
}

function resolveAllowedTaskTypes(configured: readonly string[] | undefined): string[] {
  const items = [...(configured ?? [])]
  if (items.length > 64) throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_TASK_TYPES_INVALID')
  const seen = new Set<string>()
  for (const item of items) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(item) || seen.has(item)) {
      throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_TASK_TYPES_INVALID')
    }
    seen.add(item)
  }
  return items
}

/**
 * Read the isolated agent route. Both fields empty means unbound. One field
 * without the other, an effort without a route, or an illegal token fails at load so a CEO default
 * cannot be inherited by omission.
 * @param provider - Configured provider route.
 * @param model - Configured model id.
 * @param reasoningEffort - Optional isolated thinking level, independent of the CEO session.
 * @returns The explicit route, or null when both fields are empty.
 */
export function resolveIsolatedRoute(
  provider: string | undefined,
  model: string | undefined,
  reasoningEffort: string | undefined = '',
): IsolatedAgentRoute | null {
  const providerValue = provider ?? ''
  const modelValue = model ?? ''
  const effortValue = reasoningEffort ?? ''
  if (providerValue === '' && modelValue === '' && effortValue === '') return null
  if (providerValue === '' || modelValue === ''
    || !['', 'off', 'high'].includes(effortValue)
    || !/^[\p{L}\p{N}._:/\u00B7-]{1,256}$/u.test(providerValue)
    || !/^[\p{L}\p{N}._:/\u00B7-]{1,256}$/u.test(modelValue)) {
    throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
  }
  return {
    provider: providerValue,
    model: modelValue,
    ...(effortValue === '' ? {} : { reasoningEffort: ReasoningEffortId(effortValue) }),
  }
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
 * @param _fingerprint - Assignment fingerprint; unused because no key exists.
 * @param _signature - Offered MAC; unused because no key exists.
 * @returns Always `false`.
 */
export const unconfiguredVerifier: ComputeTaskSignatureVerifier = async (_fingerprint, _signature) => false

/**
 * Lease source for a host with no dispatch session.
 * @returns Never; always throws `COMPUTE_NODE_CONTRIBUTOR_DISPATCH_UNCONFIGURED`.
 */
export function unconfiguredLeaseSource(): never {
  throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_DISPATCH_UNCONFIGURED')
}
