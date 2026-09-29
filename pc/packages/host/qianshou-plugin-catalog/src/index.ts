/** Qianshou plugin market plus read-only public bundle discovery. */
import type { NodeContributorService } from '@deepseek-ai/dsh-host-node-contributor'
import type { BuyerVideoAssetPlan, BuyerVideoAssetPlanRequest } from './types.ts'
import type { H3OwnerSetupSelection, H3OwnerSetupInspectResult, H3OwnerSetupSaveRequest, H3OwnerSetupSaveResult,
  H3OwnerSelfTestRequest, H3OwnerSelfTestStatus, H3OwnerSelfTestId, H3SkillDraftRequest, H3SkillDraftResult,
  H3CanonicalSetupSelection, H3CanonicalSetupInspectResult, H3CanonicalSetupSaveRequest, H3CanonicalSetupSaveResult,
  H3CanonicalTrialRequest, H3CanonicalTrialStatus, H3CanonicalTrialId, H3CanonicalSkillDraftRequest, H3CanonicalSkillDraftResult }
  from '@deepseek-ai/dsh-host-node-contributor/h3-owner-setup-types'
import type { NativeSkillDraftRequest, NativeSkillDraftReceipt }
  from '@deepseek-ai/dsh-host-qianshou-skill-import/src/native-skill-draft.ts'
import { createH3OwnerSkillDraft, H3OwnerOnboardingError, type H3DraftScope, type H3DraftPorts, type H3DraftRequest, type H3DraftContextId } from './h3-owner-onboarding.ts'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync, statfsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform, totalmem } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { verifyPrivateMacVideoInstallation } from '@deepseek-ai/dsh-compute-core'
import { fetchNativeH3CatalogBindings, type NativeH3CatalogBinding } from './native-h3-bindings-http.ts'
import { readNativeH3DeviceConfig, registerNativeH3DeviceConfig } from './native-h3-device-config-http.ts'
import { readNativeH3OrderSource } from './native-h3-order-source.ts'
import { renewNativeH3DevicePresence, type NativeH3PresenceSelection } from './native-h3-presence-http.ts'
import { fetchNativeH3PurposeKeys, type NativeH3PurposeKeys } from './native-h3-trust-http.ts'
import type { VerifiedNativeH3PresenceChallenge } from '@deepseek-ai/dsh-compute-core/native-h3-presence'
import { enrollNativeH3DeviceKey, startNativeH3ReviewSamples, reportNativeH3ReviewSample,
  uploadNativeH3ReviewArtifact, type NativeH3ReviewControl } from './native-h3-review-http.ts'
import type { NativeH3ReviewArtifact, AnyNativeH3ReviewExecution as NativeH3ReviewExecution,
  AnyVerifiedNativeH3ReviewChallenge as VerifiedNativeH3ReviewChallenge }
  from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { parseNativeH3ContractBinding, parseNativeH3ExecutionBindingV2, parseNativeH3CanonicalExecutionBinding,
  NATIVE_H3_RUNTIME_ABI_CANONICAL, nativeH3PublicBindingDigest,
  type NativeH3AuthorBinding, type AnyNativeH3Declaration as NativeH3Declaration }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { isVerifiedAnyNativeH3DeviceProof, nativeH3ExpectedDeviceTuple } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import {
  assertInstallHome,
  fetchMarketListings,
  listingMayInstall,
  marketBundleIdentity,
  marketApiUrl,
  marketCatalog,
  marketInstallPath,
  readDeclarationBytes,
  readMarketInstallFile,
  removeMarketInstall,
  resolveMarketHome,
  shippedListings,
  writeDeclarationBytes,
  writeMarketInstall,
} from './market.ts'
import {
  CAPABILITY_WIZARD_STEP_IDS,
  DEFAULT_VISIBILITY,
  draftInviteAccountIds,
  draftVisibility,
  resolvePublishVisibility,
  unmeasuredCapabilityMetrics,
} from './capabilities.ts'
import { runInstallPreflight, type PreflightObservations, type SignatureVerdict } from './preflight.ts'
import { fetchReleasePreviews } from './release-preview.ts'
import { fetchSignedReleases } from './release-preview.ts'
import { CSV_SEED_IDENTITY, verifyPrivateOfficialCsvSeedInstallation } from './official-seed-csv.ts'
import { acquireReviewedSeedCsvFromMarket, isReviewedSeedCsvRelease, reviewedSeedClaimAuthChannel,
  type ReviewedSeedAccountCarrier } from './reviewed-seed-consumer.ts'
import { installReviewedSeedCsvForOwner, runReviewedSeedCsvForOwner } from './reviewed-seed-install.ts'
import { listMyPrivatePluginSubmissions, submitPrivatePluginDeclaration } from './private-plugin-submissions.ts'
import { CatalogFailure, parseQuery, registryUrl, searchRegistry } from './registry.ts'
import { orderPublicationDraftPath, parseOrderPublicationDraftInput,
  readOrderPublicationDrafts, writeOrderPublicationDrafts } from './order-publication-drafts.ts'
import { identifyRegisteredOrderAdapter, prepareRegisteredOrderAdapter, type ArtifactContributor } from './registered-order-adapters.ts'
import { listPlatformOrderPublications, managePlatformOrderPublication, previewPlatformOrderPublicationPrice,
  submitPlatformOrderPublication } from './order-publication-http.ts'
import type { ManageOrderSkillPublicationRequest, OrderPublicationLifecycleReceipt } from './types.ts'
import { startPlatformOrderReviewSamples } from './order-review-samples-http.ts'
import { buildCanonicalOrderArchive } from './order-source-archive.ts'
import { normalizeGenericOrderSourceJson } from './order-source-json.ts'
import { uploadPlatformOrderSourceArchive } from './order-package-upload-http.ts'
import { signAndRecordOrderAuthorManifest } from './order-publisher-identity.ts'
import { cancelPendingOrderAdapterPurchase, checkOrderAdapterInstallManifest, listOrderAdapterProducts,
  listBuyerOrderAdapterEntitlements, listSellerOrderProducts, submitSellerOrderProduct,
  readVerifiedOrderAdapterSource, claimAuthorOrderAdapterEntitlement,
  purchaseOrderAdapterProduct as buyOrderAdapterProduct } from './order-products-http.ts'
import { stageVerifiedOrderAdapterSource } from './order-product-source-stage.ts'
import { installVerifiedOrderAdapterSource } from './order-buyer-install.ts'
import { installReviewedComfyVideoSource } from './comfy-video-source-install.ts'
import { COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM } from './order-source-inventory.ts'
import { activateVerifiedOrderAdapter } from './order-buyer-activation.ts'
import { activateVerifiedFileOrderAdapter } from './order-file-activation.ts'
import { loadOwnedInstalledFileRuntime, type VerifiedPurchasedFileOrderRuntime } from './order-file-runtime.ts'
import { loadInstalledVerifiedOrderAdapterSource } from './order-buyer-install.ts'
import { executeGenericOrderFile, type GenericFileArtifact } from './generic-file-runtime.ts'
import { parseEdgeFileContract, type EdgeFileContract } from '@deepseek-ai/dsh-compute-core/edge-worker/file-task-contract'
import type { FileOrderRuntimePorts } from '@deepseek-ai/dsh-compute-core/resident'
import { readGenericOrderSource, runGenericOrderChallenge,
  verifyGenericOrderAdapter } from './generic-order-adapter.ts'
import { SOURCE_INVENTORY_ALGORITHM } from './order-source-inventory.ts'
import type { GenericOrderSource } from './generic-order-source.ts'
import type { LocalSkillTrialDefinition, LocalSkillTrialRequest } from './local-skill-trial.ts'
import { OrdinarySkillPublications } from './ordinary-skill-publication.ts'
import type { OrdinarySkillSubmit, OrdinarySkillChoicesResult, OrdinarySkillCatalogResult,
  OrdinarySkillMineResult, OrdinarySkillPublicationResult } from './types.ts'
import { readMarketOrderInputPresentation } from './market-order-input-presentation.ts'
import type { MarketOrderInputPresentation, MarketOrderInputPresentationRequest } from './types.ts'
import { loadOwnedInstalledRuntime, type VerifiedPurchasedOrderRuntime } from './order-purchased-runtime.ts'
import { listMarketCapabilities } from './market-capabilities-http.ts'
import type { OrderAdapterProduct, OrderAdapterEntitlement, OrderAdapterInstallCheck,
  OrderAdapterSourceStage, OrderAdapterLocalInstall, OrderAdapterBuyerEntitlement,
  MarketCapability, SellerOrderProduct, ReviewedComfyVideoSourceInstall } from './types.ts'
import type {
  CapabilityDraftRequest,
  CapabilityOrderFacts,
  AuthorOrderSkillActivation,
  CapabilityServiceSwitchRequest,
  CapabilitySupplySwitchRequest,
  CatalogPage,
  CatalogQuery,
  InstallPreflightReport,
  MarketCatalog,
  MarketConnectionMode,
  MarketActivityState,
  MarketInstallActivities,
  MarketInstallRecord,
  MarketInstallRequest,
  MarketInstalled,
  MarketListing,
  LocalPluginCandidates,
  LocalCandidateInstallCheck,
  LocalOrderPublicationDraft,
  LocalOrderPublicationDraftInput,
  SubmitOrderSkillRequest,
  SubmittedOrderSkill,
  OrderSkillPricePreview,
  OrderReviewSampleStatus,
  CatalogFailureCode,
  MyOrderSkillPublication,
  LocalOrderSkillEligibility,
  OrderSourceItem,
  OrderSourceSelectionRequest,
  OrderSourceSelectionResult,
  OrderSources,
  MarketRepairResult,
  MarketRemoveResult,
  MarketRollbackResult,
  MyCapabilities,
  OfficialCsvSeedInstallRequest,
  OfficialCsvSeedInstallResult,
  OfficialCsvSeedMarketStatus,
  PrivatePluginActivations,
  PrivatePluginActivationView,
  PrivatePluginSubmissionPrepareRequest,
  PrivatePluginSubmissionPreview,
  PrivatePluginSubmissionConfirmRequest,
  PrivatePluginSubmissionResult,
  MyPrivatePluginSubmissionsView,
  PrivateLocalCapability,
  ReviewedLocalStarter,
  ReviewedLocalStarters,
  PreflightStepId,
  PublishCapabilityRequest,
} from './types.ts'
export type * from './types.ts'
export {
  MARKET_ADVERTISABLE_CAPABILITY_IDS,
  isAdvertisableCapability,
  marketInstallPath,
  resolveMarketHome,
} from './market.ts'
export {
  CAPABILITY_VISIBILITIES,
  CAPABILITY_WIZARD_STEP_IDS,
  DEFAULT_VISIBILITY,
  HELLO_VISIBILITY,
  MAX_INVITE_ACCOUNT_IDS,
  mergesIntoHello,
  unmeasuredCapabilityMetrics,
} from './capabilities.ts'
export {
  PREFLIGHT_ACTION_IDS,
  PREFLIGHT_DECLARATION_ONLY_REASON,
  PREFLIGHT_PENDING_REASON,
  PREFLIGHT_STEP_IDS,
  catalogDigest,
  declarationBytes,
  runInstallPreflight,
  versionAtLeast,
} from './preflight.ts'
export type { PreflightObservations, SignatureVerdict } from './preflight.ts'
export { stageReviewedPluginArchive } from './reviewed-staging.ts'
export type { ReviewedStageRequest, ReviewedStageResult } from './reviewed-staging.ts'
export { CSV_SEED_IDENTITY, executeOfficialCsvProfile, inspectOfficialCsvSeedArchive,
  installPrivateOfficialCsvSeed, runPrivateOfficialCsvSeed } from './official-seed-csv.ts'
export type { CsvProfileInput, CsvProfileOutput, CsvSeedPackage,
  PrivateCsvSeedInstallRequest } from './official-seed-csv.ts'
export { operationReviewPayload, projectPluginOperationReadiness } from './plugin-operation-readiness.ts'
export type { PluginOperationIdentity, PluginOperationReadiness, PluginOperationReadinessInput,
  PluginOperationReadinessReason, SignedOperationReview } from './plugin-operation-readiness.ts'

/** Module resolution runs from this package, the same place the installed plugin would load. */
const requireModule = createRequire(import.meta.url)
/** Longest dependency detail the market echoes back to a client. */
const MAX_DETAIL = 200
const ORDINARY_SKILL_API_ORIGIN = 'https://app.qianshousuanli.com'

/** Operator-selected sources. `connection: api` is the shared catalog Mac and Windows will both call. */
export interface Config {
  /** Public registry origin; HTTPS is required except for owned loopback test servers. */
  registryUrl: string
  /** Maximum milliseconds for one complete search or market API read. */
  timeoutMs: number
  /** `shipped` reads the built-in catalog. `api` reads `{apiBaseUrl}/plugins`. */
  connection: MarketConnectionMode
  /** API origin used only when `connection` is `api`. */
  apiBaseUrl: string
  /** Independent ordinary SKILL.md API origin; empty explicitly disables its network operations. */
  ordinarySkillsApiOrigin?: string
  /** Shanghai account and task-publication origin; independent of public marketplace discovery. */
  coreOrigin?: string
  /** Absolute directory for the declaration file. Empty uses the harness home. */
  installHome: string
  /** Publisher id to base64 SPKI public key. A publisher absent here cannot pass the signature step. */
  publisherKeys: Record<string, string>
  /** Guangzhou reviewer id to base64 SPKI Ed25519 public key for read-only release previews. */
  operatorKeys?: Record<string, string>
  /** Operator-pinned Ed25519 Raw32 package review keys. */
  orderPackageIssuerKeys?: Record<string, string>
  /** Separately enrolled Raw32 Ed25519 keys for the native H3 device-attestor purpose. */
  orderNativeH3AttestorKeys?: Record<string, string>
  /** Separate pre-approval challenge purpose roots; installation keys are not substitutes. */
  orderNativeH3ChallengeKeys?: Record<string, string>
  /** Control-plane object upload issuance roots; these cannot approve a device. */
  orderNativeH3UploadIssuanceKeys?: Record<string, string>
  /** Pinned HTTPS hostname for immutable source archives. */
  orderArchiveHostname?: string
  /** Pinned HTTPS hostname of the independent activation attestor. */
  orderAttestorHostname?: string
  /** Locally enrolled file-device purpose roots; never fall back to ordinary installation keys. */
  orderFileAttestorKeys?: Record<string, string>
  /** Pinned HTTPS host for the independent file-device attestor. Installation proof cannot replace file-purpose verification. */
  orderFileAttestorHostname?: string
  /** Every enrolled ordinary device and file-result public key, excluded from file-device signing. */
  orderNonFilePurposeKeys?: string[]
  /** Precise direct-storage hostname for lease-authorized attachment reads. */
  orderFileStorageHostname?: string
}

/** Host-only executable identity. Neither renderer nor worker ad receives source bytes. */
export type { VerifiedPurchasedOrderRuntime } from './order-purchased-runtime.ts'
export type { VerifiedPurchasedFileOrderRuntime } from './order-file-runtime.ts'

/** Host-only connection facts for the exact reviewed seed. Public verification keys are never
 * exposed through a Remote method or supplied by a model call. */
export interface ReviewedSeedHostConfig {
  readonly apiBaseUrl: string
  readonly publisherKeys: Readonly<Record<string, string>>
  readonly operatorKeys: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly home: string
}

type AccountHostContext = Context & { get(name: string, strict?: boolean): unknown }

/** Structural Host port so catalog typecheck does not require a rebuilt compute-core package. */
interface PreparedPrivatePluginSubmission {
  readonly archive: Buffer
  readonly preview: {
    readonly manifest: {
      readonly pluginId: string
      readonly version: string
      readonly operations: readonly {
        readonly operationId: string
        readonly capabilityId: string
        readonly executorKind: 'workflow' | 'tool' | 'model'
        readonly permissions: readonly string[]
        readonly inputSchemaSha256: string
        readonly outputSchemaSha256: string
      }[]
    }
    readonly packageSha256: string
    readonly packageBytes: number
    readonly sourcePrivatePackageSha256: string
    readonly sourceCandidateSha256: string
  }
}
const SAFE_SUBMISSION_ERRORS = new Set([
  'QIANSHOU_PLUGIN_SUBMISSION_ACCOUNT_CHANGED',
  'QIANSHOU_PLUGIN_SUBMISSION_CONFIRMATION_INVALID',
  'QIANSHOU_PLUGIN_SUBMISSION_STALE',
  'QIANSHOU_PLUGIN_DECLARATION_INVALID',
])

function reviewedSeedAccount(ctx: Context): ReviewedSeedAccountCarrier | null {
  const account = (ctx as AccountHostContext).get('qianshouAccount', false) as {
    state?: () => Promise<{ phase: string; account: { id: string } | null }>
  } | undefined
  const session = (ctx as AccountHostContext).get('accountSession', false) as {
    ensureAccessToken?: () => Promise<string | null>
  } | undefined
  const snapshot = account?.state
  const ensureAccessToken = session?.ensureAccessToken
  return typeof snapshot === 'function' && typeof ensureAccessToken === 'function'
    ? { snapshot: () => snapshot.call(account), ensureAccessToken: () => ensureAccessToken.call(session) }
    : null
}

function reviewedSeedPaths(home: string): { stage: string; installed: string } {
  const root = join(home, 'qianshou', 'reviewed-seed-csv')
  return { stage: join(root, 'stage'), installed: join(root, 'private') }
}

/** Package install result this market accepts before it writes a declaration. */
interface PackageInstallResult { application?: string; bundle?: string }

/** Installer observations distinguish a downloaded dependency from an active Host bundle. */
interface PackageBundleInfo { name: string; version?: string; enabled: boolean; installed: boolean; error?: unknown }
interface PackageBundleCheck {
  state: string
  selected: boolean
  version?: string
  rows: readonly { phase: string | null }[]
}

/** Existing profile installer. The market does not grow a second package installer. */
interface PackageInstaller {
  installBundle(spec: string): Promise<PackageInstallResult | undefined>
  removeBundle(name: string): Promise<unknown>
  listBundles?(): Promise<PackageBundleInfo[]>
  checkBundle?(name: string): Promise<PackageBundleCheck>
}

/** Registered model routes, read structurally so the market does not depend on the LLM package. */
interface ModelRoutes { listProviders(): readonly { id: string }[] }

interface AuthorSupplyAuthority { readonly expectedOwnerId: number; readonly assertCurrent: () => Promise<void> }

/** Saved owner order policy, read structurally so the market does not depend on the compute package. */
interface ComputeSupplyPort {
  ownerSupplyPolicy(): Promise<{ mode: string; maxConcurrency: number; enabledServiceIds?: readonly string[]; [key: string]: unknown }>
  querySupplySnapshot?(): Promise<{ localServices?: readonly { id: string; kind: string; verification: string }[] }>
  updateSupplyPolicy?(policy: unknown): Promise<unknown>
  updateBoundSupplyPolicy?(policy: unknown, authority: AuthorSupplyAuthority): Promise<unknown>
  updateOwnerSupply?(command: { kind: 'mode'; mode: 'off' | 'idle' }
    | { kind: 'local-service'; serviceId: string; enabled: boolean }, authority?: AuthorSupplyAuthority): Promise<unknown>
}

interface ComputeCandidatePort {
  listLocalPluginCandidates(): Promise<LocalPluginCandidates['candidates']>
}

/** The node's in-memory panel veto; it never replaces the persisted owner policy. */
interface NodeIntakePort {
  setPanelAccepting(on: boolean): void
  /** Identity acknowledged by Shanghai on this live contributor connection. */
  acknowledgedWorkerId?(): string | null
  acknowledgedConnectionId?(): string | null
  nativeH3AuthorBinding?(): Promise<NativeH3AuthorBinding>
  nativeH3AuthorBindingV2?(): Promise<{ binding: import('@deepseek-ai/dsh-compute-core/native-h3-binding').NativeH3ExecutionBindingV2
    localOwnerConfigDigest: string }>
  /** Fresh canonical preparation from its explicit configured provider; never a V2 runner fallback. */
  nativeH3AuthorBindingCanonical?(): Promise<{ binding: import('@deepseek-ai/dsh-compute-core/native-h3-binding').NativeH3CanonicalExecutionBinding
    localOwnerConfigDigest: string }>
  observePurchasedOrderChallenge?(observation: { challengeNonce: string
    inputDigest: string
    outputDigest: string
    runtimeDigest: string
    artifactDigest: string }): Promise<void>
  refreshPurchasedOrderAdapters?(): Promise<void>
  /** Revalidate fixed native claims on the current authenticated socket without reconnecting. */
  refreshNativeH3OrderAdapters?(): Promise<void>
  /** Read current acknowledged native intake; this does not select, renew, execute or grant. */
  nativeH3OrderAdapterReady?(taskType: string): Promise<boolean>
  canEnableLocalService?(serviceId: string): Promise<boolean>
  orderExecutor?(): { kind: 'builtin' } | { kind: 'plugin'; packageName: string; taskType?: string } | { kind: 'unavailable' }
  orderExecutorVerified?(): boolean
  /** Static, pinned contract inspection. Inventory never invokes an installed tool. */
  orderBundleContract?(packageName: string): Promise<{ taskType: string; capabilityId: string } | null>
  canSelectOrderBundle?(packageName: string): Promise<boolean>
  selectOrderExecutor?(input: { kind: 'builtin' } | { kind: 'plugin'; packageName: string }): Promise<
    { kind: 'builtin' } | { kind: 'plugin'; packageName: string; taskType?: string }>
}

interface NativeH3PresenceNodePort extends NodeIntakePort {
  observeNativeH3DeviceConfigProof?(input: { challengeId: string; signature: string }): Promise<void>
  observeNativeH3DeviceKeyProof?(input: { challengeId: string; signature: string }): Promise<void>
  validateNativeH3PresenceChallenge?(input: { selection: NativeH3PresenceSelection
    publicationId: string
    contractSha256: string
    challenge: VerifiedNativeH3PresenceChallenge }): Promise<void>
  observeNativeH3DevicePresence?(input: { challengeNonce: string; signature: string }): Promise<void>
}

/** The profile manager sees packages and live Loader entries regardless of their install origin. */
interface OrderPluginInventoryPort {
  listBundles(): Promise<readonly { name: string
    displayName?: string
    description?: string
    enabled: boolean
    installed: boolean
    removable: boolean
    optional: boolean
    error?: unknown
    rows: readonly { entryId?: string; moduleName: string }[] }[]>
  listPlugins(): Promise<readonly { entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null }[]>
}

/** Validated user SKILL.md roots; Session winner selection remains a separate fact. */
interface OrderSkillInventoryPort {
  listLocal(): Promise<{ skills: readonly { name: string
    displayName: string
    description: string
    category?: string
    source: 'user-dsh' | 'user-agents'
    path?: string }[] }>
}

const MAX_ORDER_SOURCES = 1024

/** Order modes this host accepts from the compute service; anything else stays unknown. */
const ORDER_MODES: readonly CapabilityOrderFacts['mode'][] = ['off', 'idle', 'allowed']

/** Node hook that sends a fresh hello after a declaration is saved. */
interface MarketHelloRefresh { refresh(): Promise<void> }
declare module '@deepseek-ai/cordis' { interface Context { qianshouPluginCatalog: QianshouPluginCatalog } }

/** Installed version of one declared dependency, or null when this computer cannot resolve it. */
function resolveInstalledPackage(name: string): { version: string } | null {
  let resolved: string
  try {
    resolved = requireModule.resolve(name)
  } catch {
    // An unresolvable module is the dependency step's finding, not a service failure.
    return null
  }
  let current = dirname(resolved)
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return { version: parsed.version }
    } catch {
      // No manifest at this level; the resolved module's own manifest may sit higher up.
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * Free bytes on the volume holding a path, walking up to the first directory that exists.
 * @param start - Directory the declaration file would be written into.
 * @returns Free bytes, or 0 when no ancestor can be measured.
 */
function freeDiskBytes(start: string): number {
  let current = start
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const stats = statfsSync(current)
      return stats.bavail * stats.bsize
    } catch {
      const parent = dirname(current)
      if (parent === current) return 0
      current = parent
    }
  }
  return 0
}

/** Read-only migration hint. Old local choices are preserved for audit, never rewritten here. */
async function legacySvgPackageSelection(profileDir: unknown): Promise<boolean> {
  if (typeof profileDir !== 'string') return false
  try {
    const path = join(profileDir, 'qianshou-artifact-adapter.json')
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) return false
    const bytes = await readFile(path)
    if (bytes.length !== stat.size) return false
    const row: unknown = JSON.parse(bytes.toString('utf8'))
    return row !== null && typeof row === 'object' && !Array.isArray(row)
      && [2, 3].includes((row as Record<string, unknown>).version as number)
  } catch { return false }
}

/** Preserve the platform publication id when author signing or direct OSS upload fails. */
async function attemptOrderArchiveUpload(input: Parameters<typeof uploadPlatformOrderSourceArchive>[0]
  & { readonly version: string; readonly profileDir: string }):
Promise<Pick<SubmittedOrderSkill, 'archiveStatus' | 'archiveError'>> {
  try {
    await signAndRecordOrderAuthorManifest(input)
    return { archiveStatus: await uploadPlatformOrderSourceArchive(input) }
  } catch (error) {
    const code = error instanceof CatalogFailure ? error.code : 'order-archive-unavailable'
    const archiveError: NonNullable<SubmittedOrderSkill['archiveError']> = [
      'order-author-key-unavailable', 'order-author-unavailable',
      'order-archive-untrusted-host', 'order-archive-unavailable',
      'order-archive-upload-failed', 'order-archive-unconfirmed',
      'order-publication-conflict', 'order-auth-required',
    ].includes(code) ? code as NonNullable<SubmittedOrderSkill['archiveError']> : 'order-archive-unavailable'
    return { archiveStatus: 'pending', archiveError }
  }
}

/** Starting a review sample is a separate receipt from source upload and approval. */
async function attemptOrderReviewSampleStart(input: {
  origin: string
  token: string
  publicationId: string
}): Promise<Pick<SubmittedOrderSkill, 'reviewSampleStatus' | 'mediaEvidenceStatus' | 'reviewSampleError'>> {
  try {
    const sample = await startPlatformOrderReviewSamples(input)
    return { reviewSampleStatus: sample.status, mediaEvidenceStatus: sample.mediaEvidenceStatus }
  } catch (error) {
    const code: CatalogFailureCode = error instanceof CatalogFailure
      ? error.code : 'order-review-samples-unavailable'
    return { reviewSampleError: code }
  }
}

/** Require two different local examples before Guangzhou's independent review. */
async function requireIndependentReviewSamples(skillPath: string,
  adapter: { inventoryAlgorithm: string; digest: string }): Promise<void> {
  if (adapter.inventoryAlgorithm !== SOURCE_INVENTORY_ALGORITHM) return
  const source = await readGenericOrderSource(skillPath)
  if (source.digest !== adapter.digest) throw new CatalogFailure('order-local-verification-failed')
  const inputs = source.declaration.selfTests.map(sample =>
    source.files.find(file => file.path === sample.input)?.bytes.toString('utf8'))
  if (inputs.some(input => input === undefined) || new Set(inputs).size < 2) {
    throw new CatalogFailure('order-review-samples-insufficient')
  }
}

/** Market install records a capability declaration. `search` does not install packages or read account credentials. */
export class QianshouPluginCatalog extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({
    registryUrl: Schema.string().default('https://registry.npmjs.org/'),
    timeoutMs: Schema.number().min(1000).max(60000).default(15000),
    connection: Schema.union(['shipped', 'api']).default('shipped'),
    apiBaseUrl: Schema.string().default(''),
    ordinarySkillsApiOrigin: Schema.string().default(ORDINARY_SKILL_API_ORIGIN),
    coreOrigin: Schema.string().default('https://qianshousuanli.com'),
    installHome: Schema.string().default(''),
    publisherKeys: Schema.dict(Schema.string()).default({}),
    operatorKeys: Schema.dict(Schema.string()).default({}),
    orderPackageIssuerKeys: Schema.dict(Schema.string()).default({}),
    orderNativeH3AttestorKeys: Schema.dict(Schema.string()).default({}),
    orderNativeH3ChallengeKeys: Schema.dict(Schema.string()).default({}),
    orderNativeH3UploadIssuanceKeys: Schema.dict(Schema.string()).default({}),
    orderFileAttestorKeys: Schema.dict(Schema.string()).default({}),
    orderFileAttestorHostname: Schema.string().default(''),
    orderNonFilePurposeKeys: Schema.array(Schema.string()).default([]),
    orderFileStorageHostname: Schema.string().default(''),
    orderArchiveHostname: Schema.string().default(''),
    orderAttestorHostname: Schema.string().default(''),
  })
  private closed = false
  private writeChain: Promise<void> = Promise.resolve()
  private readonly pending = new Set<{ abort: AbortController; done: Promise<unknown> }>()
  /** Declaration bytes as they were when the last install attempt for an id started; null means no file. */
  private readonly attempts = new Map<string, string | null>()
  /** Packages a repair installed for one id, so rollback can remove exactly those. */
  private readonly repairedPackages = new Map<string, string[]>()
  private readonly authorActivations = new Map<string, Promise<AuthorOrderSkillActivation>>()
  /** Local GPU work state is not administrator approval or a reusable platform device proof. */
  private readonly nativeReviewTasks = new Map<string, { digest: string
    workerId: string
    connectionId: string
    localOwnerConfigDigest?: string
    deviceBindingRevision?: number
    status: 'pending' | 'running' | 'evidence_deposited' | 'blocked'
    error?: CatalogFailureCode }>()
  private nativePurposeTrust: { origin: string; keys: NativeH3PurposeKeys; expiresAt: number } | undefined
  private readonly nativePresenceRefreshes = new Map<string, Promise<NativeH3CatalogBinding[]>>()
  private readonly source: URL
  private readonly apiBase: URL | null
  private readonly ordinarySkills: OrdinarySkillPublications
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'qianshouPluginCatalog')
    this.source = registryUrl(config.registryUrl)
    assertInstallHome(config.installHome)
    this.apiBase = config.connection === 'api' ? marketApiUrl(config.apiBaseUrl) : null
    const ordinaryOrigin = config.ordinarySkillsApiOrigin ?? this.apiBase?.href ?? ORDINARY_SKILL_API_ORIGIN
    this.ordinarySkills = new OrdinarySkillPublications(this.offlineCsvSeedHome(), ordinaryOrigin === '' ? null : ordinaryOrigin,
      config.timeoutMs, config.operatorKeys ?? {}, () => reviewedSeedAccount(this.ctx), async () => {
        const inventory = this.ctx.get('qianshouSkillImport') as { listLocal(): Promise<{ skills: {
          name: string
          source: string
          path: string
          displayName?: string
          description?: string }[] }> } | undefined
        if (inventory === undefined) throw new Error('ORDINARY_SKILL_LOCAL_UNAVAILABLE')
        return inventory.listLocal()
      })
  }
  /** Read local ordinary skill choices without an adapter or automatic execution.
   * @returns User-root skill identities without paths or bytes.
   */
  @Remote
  ordinarySkillChoices(): Promise<OrdinarySkillChoicesResult> { return this.ordinarySkills.choices() }
  /** Read independently reviewed ordinary listings; buying and installation remain closed.
   * @returns Staff-signed ordinary listings from the configured Guangzhou origin.
   */
  @Remote
  ordinarySkillCatalog(): Promise<OrdinarySkillCatalogResult> { return this.ordinarySkills.catalog() }
  /** Reconcile original owner submissions through the exact saved request UUID only.
   * @returns Current account's original intents and verified manual review observations.
   */
  @Remote
  ordinarySkillMine(): Promise<OrdinarySkillMineResult> { return this.ordinarySkills.mine() }
  /** Submit immutable ordinary skill bytes after explicit approval of the price and text.
   * @param request - Inventory identity and author-approved terms; no path, token or URL.
   * @returns Original submission receipt or a read-only uncertain request.
   */
  @Remote
  submitOrdinarySkill(request: OrdinarySkillSubmit): Promise<OrdinarySkillPublicationResult> { return this.ordinarySkills.submit(request) }
  /**
   * Host-only location for the offline private seed; never a market entitlement.
   * @returns The configured local seed installation directory.
   */
  offlineCsvSeedHome(): string {
    return this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
  }
  /**
   * The reviewed market tool is unavailable until an operator sets an API origin and both
   * independent trust roots. Shipped discovery never silently becomes an online market.
   * @returns The explicitly configured API and trust roots, or null when unavailable.
   */
  reviewedSeedHostConfig(): ReviewedSeedHostConfig | null {
    if (this.closed || this.config.connection !== 'api' || this.apiBase === null
      || Object.keys(this.config.publisherKeys).length === 0
      || Object.keys(this.config.operatorKeys ?? {}).length === 0) return null
    return { apiBaseUrl: this.apiBase.href,
      publisherKeys: this.config.publisherKeys, operatorKeys: this.config.operatorKeys ?? {},
      timeoutMs: this.config.timeoutMs, home: this.offlineCsvSeedHome() }
  }
  /** Read current setup or inspect explicitly chosen files without rendering.
   * @param selection - Local file choices, omitted for the first-screen state.
   * @returns Current owner-local state or a short-lived save inspection.
   */
  @Remote
  inspectH3OwnerSetup(selection?: H3OwnerSetupSelection): Promise<H3OwnerSetupInspectResult> {
    return this.withH3OwnerSetup(signal => this.h3OwnerNode().inspectH3OwnerSetup(selection, signal))
  }

  /** Save only the inspected current revision; no GPU, publication or supply grant occurs.
   * @param request - One single-use inspection and expected managed revision.
   * @returns Saved revision without private paths or credentials.
   */
  @Remote
  saveH3OwnerSetup(request: H3OwnerSetupSaveRequest): Promise<H3OwnerSetupSaveResult> {
    return this.withH3OwnerSetup(signal => this.h3OwnerNode().saveH3OwnerSetup(request, signal))
  }

  /** Explicitly start one local five-second video trial; this is not platform approval.
   * @param request - Current revision and bounded Chinese prompt.
   * @returns Retained operation state; an unknown operation is never automatically retried.
   */
  @Remote
  startH3OwnerSelfTest(request: H3OwnerSelfTestRequest): Promise<H3OwnerSelfTestStatus> {
    return this.withH3OwnerSetup(signal => this.h3OwnerNode().startH3OwnerSelfTest(request, signal))
  }

  /** Read the current author's retained local trial without starting work.
   * @param operationId - Opaque id returned by explicit trial start.
   * @returns Local pending, unknown, failed or verified state.
   */
  @Remote
  h3OwnerSelfTestStatus(operationId: H3OwnerSelfTestId): Promise<H3OwnerSelfTestStatus> {
    return this.withH3OwnerSetup(() => this.h3OwnerNode().h3OwnerSelfTestStatus(operationId))
  }

  /** Create five validated local skill files from a real current trial, without cloud writes.
   * @param request - Current revision and local skill display text.
   * @returns Local draft state; publication and supply permission remain separate actions.
   */
  @Remote
  createH3SkillDraft(request: H3SkillDraftRequest): Promise<H3SkillDraftResult> {
    return this.withH3OwnerSetup((signal) => {
      const node = this.h3OwnerNode()
      return this.prepareH3Draft(node, request,
        (revision, contextId) => node.verifiedH3OwnerSetupBinding(revision, contextId), signal)
    })
  }

  /** Read canonical setup or inspect a PNG without generating video.
   * @param selection - Optional explicit PNG and advanced loopback settings.
   * @returns Current canonical state or a single-use inspection.
   */
  @Remote
  inspectH3CanonicalSetup(selection?: H3CanonicalSetupSelection): Promise<H3CanonicalSetupInspectResult> {
    return this.withH3OwnerSetup(() => this.h3CanonicalNode().inspectH3CanonicalSetup(selection))
  }

  /** Save one canonical inspected revision without publication or GPU work.
   * @param request - Single-use inspection and expected revision.
   * @returns Saved canonical revision without private paths.
   */
  @Remote
  saveH3CanonicalSetup(request: H3CanonicalSetupSaveRequest): Promise<H3CanonicalSetupSaveResult> {
    return this.withH3OwnerSetup(() => this.h3CanonicalNode().saveH3CanonicalSetup(request))
  }

  /** Start only the explicitly selected canonical local sample.
   * @param request - Current context, sample number and video description.
   * @returns Retained state; uncertainty never authorizes a repeat.
   */
  @Remote
  startH3CanonicalTrial(request: H3CanonicalTrialRequest): Promise<H3CanonicalTrialStatus> {
    return this.withH3OwnerSetup(() => this.h3CanonicalNode().startH3CanonicalTrial(request))
  }

  /** Read a retained canonical sample without submitting work.
   * @param operationId - Original operation returned by explicit start.
   * @returns Current local sample state.
   */
  @Remote
  h3CanonicalTrialStatus(operationId: H3CanonicalTrialId): Promise<H3CanonicalTrialStatus> {
    return this.withH3OwnerSetup(() => this.h3CanonicalNode().h3CanonicalTrialStatus(operationId))
  }

  /** Prepare a local draft from two current verified canonical samples.
   * @param request - Canonical context and local display text.
   * @returns Local draft receipt; cloud review and supply remain separate.
   */
  @Remote
  createH3CanonicalSkillDraft(request: H3CanonicalSkillDraftRequest): Promise<H3CanonicalSkillDraftResult> {
    return this.withH3OwnerSetup((signal) => {
      const node = this.h3CanonicalNode()
      return this.prepareH3Draft(node, request,
        (revision, contextId) => node.verifiedH3CanonicalSetupBinding({ revision, contextId }), signal)
    })
  }

  private async prepareH3Draft<C extends H3DraftContextId>(node: NodeContributorService,
    request: H3DraftRequest<C>, readBinding: H3DraftPorts<C>['readBinding'], signal: AbortSignal): Promise<H3SkillDraftResult> {
    const importer = this.ctx.get('qianshouSkillImport') as {
      installNativeSkillDraft?: (input: NativeSkillDraftRequest, signal: AbortSignal) => Promise<NativeSkillDraftReceipt>
    } | undefined
    if (!importer?.installNativeSkillDraft) throw new H3OwnerOnboardingError(new Error('H3_SETUP_IMPORTER_UNAVAILABLE'))
    const installDraft = importer.installNativeSkillDraft.bind(importer)
    const identity = (service: object): unknown => Reflect.get(service, symbols.original) ?? service
    const nodeIdentity = identity(node)
    const importerIdentity = identity(importer)
    const readScope = async (): Promise<H3DraftScope | null> => {
      const currentNode: unknown = this.ctx.get('nodeContributor')
      const currentImporter: unknown = this.ctx.get('qianshouSkillImport')
      if (currentNode === null || typeof currentNode !== 'object'
        || currentImporter === null || typeof currentImporter !== 'object'
        || identity(currentNode) !== nodeIdentity || identity(currentImporter) !== importerIdentity) return null
      const account = this.ctx.get('qianshouAccount') as {
        state?(): Promise<{ phase: string; account: { id: string } | null }>
      } | undefined
      const state = await account?.state?.()
      const profile = this.ctx.get('profileContext') as { dir?: unknown } | undefined
      const id = state?.account?.id
      if (state?.phase !== 'authenticated' || typeof id !== 'string' || !/^[1-9][0-9]*$/u.test(id)
        || !Number.isSafeInteger(Number(id)) || typeof profile?.dir !== 'string' || !isAbsolute(profile.dir)) return null
      return { ownerId: Number(id), profileDir: profile.dir }
    }
    return createH3OwnerSkillDraft({ readScope, readBinding,
      installDraft: (input, ownedSignal) => installDraft(input, ownedSignal) }, request, signal)
  }

  private h3CanonicalNode(): NodeContributorService {
    const node = this.ctx.get('nodeContributor') as NodeContributorService | undefined
    if (node === undefined || typeof node.inspectH3CanonicalSetup !== 'function') {
      throw new H3OwnerOnboardingError(new Error('H3_SETUP_UNAVAILABLE'))
    }
    return node
  }

  private h3OwnerNode(): NodeContributorService {
    const node = this.ctx.get('nodeContributor') as NodeContributorService | undefined
    if (node === undefined || typeof node.inspectH3OwnerSetup !== 'function') {
      throw new H3OwnerOnboardingError(new Error('H3_SETUP_UNAVAILABLE'))
    }
    return node
  }

  private withH3OwnerSetup<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withNetwork(async (signal) => {
      try { return await run(signal) }
      catch (error) { throw new H3OwnerOnboardingError(error) }
    }, 60_000)
  }

  /** Use the owner's selected model to prepare one five-second buyer asset plan.
   * This endpoint works without a reviewed product and cannot upload, quote, or dispatch.
   */
  @Remote
  prepareVideoAssetPlan(request: BuyerVideoAssetPlanRequest): Promise<BuyerVideoAssetPlan> {
    return this.withNetwork(async (signal) => {
      const node = this.ctx.get('nodeContributor') as NodeContributorService | undefined
      if (typeof node?.prepareVideoAssetPlan !== 'function') throw new CatalogFailure('unavailable')
      return node.prepareVideoAssetPlan(request, signal)
    }, 60_000)
  }

  /**
   * Read a signed exact release and current account presence without claiming a license or
   * downloading an archive. The installed state is deliberately not inferred from a file.
   * @returns Verified release metadata and account presence, without claiming ownership.
   */
  @Remote
  async officialCsvSeedStatus(): Promise<OfficialCsvSeedMarketStatus> {
    const identity = { pluginId: CSV_SEED_IDENTITY.pluginId,
      releaseId: CSV_SEED_IDENTITY.releaseId, version: CSV_SEED_IDENTITY.version,
      packageSha256: CSV_SEED_IDENTITY.packageSha256 }
    const absent = { accountSignedIn: false, signedReleaseVerified: false,
      claimAuthChannelVerified: false }
    const config = this.reviewedSeedHostConfig()
    if (config === null) return { ...identity, ...absent, phase: 'not-configured' }
    const account = reviewedSeedAccount(this.ctx)
    if (account === null) return { ...identity, ...absent, phase: 'sign-in-required' }
    const state = await account.snapshot().catch(() => null)
    if (state === null || (state.phase !== 'authenticated' && state.phase !== 'refreshing')
      || typeof state.account?.id !== 'string' || state.account.id === '') {
      return { ...identity, ...absent, phase: 'sign-in-required' }
    }
    const releaseReady = await this.withNetwork(async signal =>
      (await fetchSignedReleases(marketApiUrl(config.apiBaseUrl), signal,
        config.publisherKeys, config.operatorKeys)).some(isReviewedSeedCsvRelease)).catch(() => false)
    if (!releaseReady) return { ...identity, ...absent, accountSignedIn: true,
      phase: 'release-unavailable' }
    // Public signatures and local login do not prove that Guangzhou checked this request.
    const verified = await this.withNetwork(async signal =>
      await reviewedSeedClaimAuthChannel({ apiBaseUrl: config.apiBaseUrl,
        account, signal, timeoutMs: config.timeoutMs }) === 'verified').catch(() => false)
    return { ...identity, accountSignedIn: true, signedReleaseVerified: true,
      claimAuthChannelVerified: verified, phase: verified ? 'ready' : 'claim-auth-unverified' }
  }
  /**
   * One explicit PC market action for the fixed free data-only seed. The browser confirms the
   * identity shown to the owner; Host rechecks account, online grant, signatures and package.
   * @param request - The fixed reviewed seed identity explicitly confirmed by the current owner.
   * @returns The verified local seed installation and its account-bound grant.
   */
  @Remote
  async installOfficialCsvSeedForOwner(request: OfficialCsvSeedInstallRequest): Promise<OfficialCsvSeedInstallResult> {
    if (request?.releaseId !== CSV_SEED_IDENTITY.releaseId
      || request.packageSha256 !== CSV_SEED_IDENTITY.packageSha256) {
      throw new CatalogFailure('invalid-response')
    }
    const config = this.reviewedSeedHostConfig()
    const account = reviewedSeedAccount(this.ctx)
    if (config === null || account === null) throw new CatalogFailure('unavailable')
    return this.withNetwork(async (signal) => {
      if (await reviewedSeedClaimAuthChannel({ apiBaseUrl: config.apiBaseUrl,
        account, signal, timeoutMs: config.timeoutMs }) !== 'verified') {
        throw new CatalogFailure('unavailable')
      }
      const state = await account.snapshot()
      if ((state.phase !== 'authenticated' && state.phase !== 'refreshing')
        || typeof state.account?.id !== 'string' || state.account.id === '') {
        throw new CatalogFailure('unavailable')
      }
      const paths = reviewedSeedPaths(config.home)
      await mkdir(paths.stage, { recursive: true, mode: 0o700 })
      await mkdir(paths.installed, { recursive: true, mode: 0o700 })
      const license = { apiBaseUrl: config.apiBaseUrl,
        publisherKeys: config.publisherKeys, operatorKeys: config.operatorKeys,
        timeoutMs: config.timeoutMs, account, signal }
      try {
        await lstat(join(paths.installed, 'market-qianshou.csv-profile-1.0.0.json'))
        await runReviewedSeedCsvForOwner({ privateDir: paths.installed,
          license, input: { csv: '列\n样例' }, signal })
        return { pluginId: CSV_SEED_IDENTITY.pluginId, version: CSV_SEED_IDENTITY.version,
          alreadyInstalled: true, scope: 'account-bound-private', dispatchable: false }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const candidate = await acquireReviewedSeedCsvFromMarket({ ...license,
        stagingDir: paths.stage })
      try {
        const installed = await installReviewedSeedCsvForOwner({ candidate,
          license, privateDir: paths.installed, signal,
          approveOwner: async identity => identity.releaseId === request.releaseId
            && identity.packageSha256 === request.packageSha256,
        })
        return { pluginId: installed.pluginId, version: installed.version,
          alreadyInstalled: false, scope: installed.scope, dispatchable: false }
      } finally { await unlink(candidate.archivePath).catch(() => undefined) }
    }, Math.min(config.timeoutMs * 5, 300_000))
  }
  protected [Service.init](): void {
    this.ctx.effect(() => () => this.ordinarySkills.close(), 'qianshou-plugin-catalog: ordinary skill lifetime')
    this.ctx.effect(() => async () => {
      this.closed = true
      const pending = [...this.pending]; for (const task of pending) task.abort.abort()
      await Promise.allSettled(pending.map(task => task.done))
    }, 'qianshou-plugin-catalog: network lifetime')
  }
  /**
   * Read byte-verified private candidate packages from the Host. This does not install or publish.
   * @returns Byte-verified private candidates available on this Host.
   */
  @Remote
  async localCandidates(): Promise<LocalPluginCandidates> {
    if (this.closed) throw new CatalogFailure('closed')
    const compute = this.ctx.get('computeCore') as ComputeCandidatePort | undefined
    if (typeof compute?.listLocalPluginCandidates !== 'function') throw new CatalogFailure('candidate-unavailable')
    try { return { candidates: await compute.listLocalPluginCandidates() } }
    catch { throw new CatalogFailure('candidate-unavailable') }
  }
  /**
   * Compare installed bytes with a currently verified candidate. Order sampling also requires its adapter.
   * @param request - The byte-verified candidate identity to compare with installed files.
   * @returns Whether the current installed bytes match the selected candidate.
   */
  @Remote
  async checkLocalCandidateInstall(request: { draftId: string
    packageDigest: string
    /** Local use may omit the order adapter; order publication keeps the strict default. */
    requireOrderAdapter?: false }): Promise<LocalCandidateInstallCheck> {
    if (this.closed) throw new CatalogFailure('closed')
    if (typeof request?.draftId !== 'string' || typeof request.packageDigest !== 'string'
      || (Object.keys(request).length !== 2
        && !(Object.keys(request).length === 3 && request.requireOrderAdapter === false))
      || !/^plugin_draft_[0-9a-f-]{36}$/u.test(request.draftId)
      || !/^[0-9a-f]{64}$/u.test(request.packageDigest)) throw new CatalogFailure('candidate-unavailable')
    const candidate = (await this.localCandidates()).candidates.find(item => item.draftId === request.draftId
      && item.packageDigest === request.packageDigest)
    if (candidate === undefined) throw new CatalogFailure('candidate-unavailable')
    try {
      const source = JSON.parse(await readFile(join(candidate.packagePath, 'package.json'), 'utf8')) as Record<string, unknown>
      const adapter = source.qianshouOrderAdapter as Record<string, unknown> | undefined
      if (source.name !== candidate.packageName || (request.requireOrderAdapter !== false
        && (typeof adapter !== 'object' || adapter === null
          || adapter.toolName !== candidate.toolName || typeof adapter.taskType !== 'string'))) {
        return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
          matched: false, reason: 'adapter-missing' }
      }
    } catch { return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
      matched: false, reason: 'unavailable' } }
    const manager = this.ctx.get('pluginManager') as OrderPluginInventoryPort | undefined
    if (manager === undefined) return { packageName: candidate.packageName,
      packageDigest: candidate.packageDigest, matched: false, reason: 'unavailable' }
    try {
      if (!(await manager.listBundles()).some(bundle => bundle.name === candidate.packageName && bundle.installed)) {
        return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
          matched: false, reason: 'not-installed' }
      }
    } catch { return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
      matched: false, reason: 'unavailable' } }
    const profile = this.ctx.get('profileContext') as { dir?: unknown } | undefined
    if (typeof profile?.dir !== 'string') return { packageName: candidate.packageName,
      packageDigest: candidate.packageDigest, matched: false, reason: 'unavailable' }
    const files = ['package.json', 'cordis.patch.yml', 'index.js'] as const
    try {
      const directory = await realpath(join(profile.dir, 'node_modules', candidate.packageName))
      const entries = await readdir(directory)
      if (entries.length !== files.length || files.some(file => !entries.includes(file))) {
        return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
          matched: false, reason: 'changed' }
      }
      const contents: string[] = []
      for (const file of files) {
        const path = join(directory, file)
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
          return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
            matched: false, reason: 'changed' }
        }
        contents.push(await readFile(path, 'utf8'))
      }
      const actual = createHash('sha256').update(files.map((file, i) => `${file}\0${contents[i]}`).join('\0')).digest('hex')
      return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
        matched: actual === candidate.packageDigest, reason: actual === candidate.packageDigest ? 'matched' : 'changed' }
    } catch (error) {
      return { packageName: candidate.packageName, packageDigest: candidate.packageDigest,
        matched: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'unavailable' }
    }
  }
  /**
   * Read only the author's local review notes for this still-current candidate.
   * @param request - The current candidate draft identifier and package digest.
   * @returns The matching local review notes, or null when none were saved.
   */
  @Remote
  async localOrderPublicationDraft(request: { draftId: string; packageDigest: string }): Promise<LocalOrderPublicationDraft | null> {
    if (this.closed) throw new CatalogFailure('closed')
    if (typeof request?.draftId !== 'string' || typeof request.packageDigest !== 'string'
      || Object.keys(request).length !== 2 || !/^plugin_draft_[0-9a-f-]{36}$/u.test(request.draftId)
      || !/^[0-9a-f]{64}$/u.test(request.packageDigest)) throw new CatalogFailure('order-draft-invalid')
    const candidate = (await this.localCandidates()).candidates.find(item => item.draftId === request.draftId
      && item.packageDigest === request.packageDigest && item.orderAdapter !== undefined)
    if (candidate === undefined) throw new CatalogFailure('candidate-unavailable')
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    const drafts = await readOrderPublicationDrafts(orderPublicationDraftPath(home))
    return drafts.find(item => item.draftId === candidate.draftId && item.packageDigest === candidate.packageDigest) ?? null
  }
  /**
   * Save metadata only under DSH_HOME; no code, entitlement, grant or Shanghai request is created.
   * @param request - Candidate-bound author metadata to save locally.
   * @returns The saved candidate-bound metadata; no platform submission is made.
   */
  @Remote
  async saveLocalOrderPublicationDraft(request: LocalOrderPublicationDraftInput): Promise<LocalOrderPublicationDraft> {
    if (this.closed) throw new CatalogFailure('closed')
    const input = parseOrderPublicationDraftInput(request)
    return this.serialize(async () => {
      const candidate = (await this.localCandidates()).candidates.find(item => item.draftId === input.draftId
        && item.packageDigest === input.packageDigest && item.orderAdapter !== undefined)
      if (candidate === undefined || candidate.orderAdapter === undefined) throw new CatalogFailure('candidate-unavailable')
      const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
      const path = orderPublicationDraftPath(home)
      const previous = await readOrderPublicationDrafts(path)
      const saved: LocalOrderPublicationDraft = { ...input, taskContract: candidate.orderAdapter,
        savedAt: Date.now(), state: 'local-draft' }
      await writeOrderPublicationDrafts(path, [saved, ...previous.filter(item => item.draftId !== input.draftId)].slice(0, 20))
      return saved
    })
  }

  /**
   * Read display controls from accessible signed legacy examples; no source is installed or run.
   * @param request - Exact market product, task, product version and artifact digest.
   * @returns Presentation metadata only; the signed input schema and payment confirmation remain unchanged.
   */
  @Remote
  async readMarketOrderInputPresentation(request: MarketOrderInputPresentationRequest): Promise<MarketOrderInputPresentation> {
    if (this.closed) throw new CatalogFailure('closed')
    const owner = await this.fileAccountId()
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (owner === null || !token) throw new CatalogFailure('order-auth-required')
    const result = await readMarketOrderInputPresentation({ request, token,
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
      trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {},
      trustedArchiveHostname: this.config.orderArchiveHostname ?? '' })
    if (this.closed || await this.fileAccountId() !== owner) throw new CatalogFailure('order-auth-required')
    return result
  }

  /**
   * Read the exact scanned source's input declaration without running, normalizing or contacting a platform.
   * @param request - The scanned user root and exact skill name.
   * @returns The current source digest, task declaration, and supported local input form.
   */
  @Remote
  async readInstalledOrderSkillTrial(request: { source: 'user-dsh' | 'user-agents'; name: string }): Promise<LocalSkillTrialDefinition> {
    if (this.closed) throw new CatalogFailure('closed')
    if (request === null || typeof request !== 'object'
      || Object.keys(request).sort().join(',') !== 'name,source'
      || !['user-dsh', 'user-agents'].includes(request.source)
      || typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)) {
      throw new CatalogFailure('order-draft-invalid')
    }
    const importer = this.ctx.get('qianshouSkillImport') as {
      listLocal?: () => Promise<{ skills: Array<{ name: string; source: string; path: string }> }>
    } | undefined
    if (!importer?.listLocal) throw new CatalogFailure('order-skill-import-unavailable')
    const skill = (await importer.listLocal()).skills.find(item => item.source === request.source && item.name === request.name)
    if (skill === undefined) throw new CatalogFailure('order-skill-unavailable')
    const source = await readGenericOrderSource(skill.path)
    const file = source.taskDefinition?.fileSchema !== undefined
    const portable = source.declaration.schema === 'qianshou.local-adapter-candidate.v3'
    return { schema: 'qianshou.local-skill-trial.v1', taskType: source.declaration.taskType,
      artifactDigest: `sha256:${source.digest}`,
      inputSchemaJson: source.taskDefinition === null ? null : JSON.stringify(source.taskDefinition.inputSchema),
      supportsLocalTrial: portable && !file,
      unavailableReason: file ? 'file-trial-unavailable' : portable ? null : 'runtime-unavailable' }
  }

  /**
   * Local trial uses the same bounded executor as published orders and never needs login.
   * @param request - The current local skill, expected artifact digest, and validated input JSON.
   * @returns The actual output JSON, artifact digest, task type, and elapsed milliseconds.
   */
  @Remote
  async tryInstalledOrderSkill(request: LocalSkillTrialRequest):
  Promise<{ outputJson: string; artifactDigest: string; taskType: string; elapsedMs: number }> {
    if (this.closed || request === null || typeof request !== 'object'
      || !['inputJson,name,source', 'expectedArtifactDigest,inputJson,name,source'].includes(Object.keys(request).sort().join(','))
      || (request.expectedArtifactDigest !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(request.expectedArtifactDigest))
      || !['user-dsh', 'user-agents'].includes(request.source)
      || typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)
      || typeof request.inputJson !== 'string' || Buffer.byteLength(request.inputJson, 'utf8') < 1
      || Buffer.byteLength(request.inputJson, 'utf8') > 64 * 1024) {
      throw new CatalogFailure('order-draft-invalid')
    }
    const importer = (this.ctx as { get?: (name: string) => unknown }).get?.('qianshouSkillImport') as {
      listLocal?: () => Promise<{ skills: Array<{ name: string; source: string; path: string }> }>
    } | undefined
    if (!importer?.listLocal) throw new CatalogFailure('order-skill-import-unavailable')
    const inventory = await importer.listLocal()
    const skill = inventory.skills.find(item => item.name === request.name && item.source === request.source)
    if (skill === undefined) throw new CatalogFailure('order-skill-unavailable')
    if (request.expectedArtifactDigest === undefined) await normalizeGenericOrderSourceJson(skill.path)
    const source = await readGenericOrderSource(skill.path)
    if (request.expectedArtifactDigest !== undefined && request.expectedArtifactDigest !== `sha256:${source.digest}`) {
      throw new CatalogFailure('order-publication-conflict')
    }
    // Local plugin trial on both desktops uses only the portable, no-native-capability VM.
    if (source.declaration.schema !== 'qianshou.local-adapter-candidate.v3') {
      throw new CatalogFailure('order-runtime-unavailable')
    }
    const started = Date.now()
    await verifyGenericOrderAdapter(source)
    if (this.closed) throw new CatalogFailure('closed')
    const { output } = await runGenericOrderChallenge(source, Buffer.from(request.inputJson, 'utf8'))
    return { outputJson: JSON.stringify(output), artifactDigest: `sha256:${source.digest}`,
      taskType: source.declaration.taskType, elapsedMs: Date.now() - started }
  }

  /**
   * Quote one canonical task definition without publishing or claiming approval.
   * @param request - The scanned skill identity and exact current task-definition digest.
   * @returns The current server price and task-definition identity for confirmation.
   */
  @Remote
  async previewInstalledOrderSkillPrice(request: { source: 'user-dsh' | 'user-agents'; name: string }):
  Promise<OrderSkillPricePreview> {
    if (this.closed) throw new CatalogFailure('closed')
    if (request === null || typeof request !== 'object' || !['user-dsh', 'user-agents'].includes(request.source)
      || typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)) {
      throw new CatalogFailure('order-draft-invalid')
    }
    const importer = (this.ctx as { get?: (name: string) => unknown }).get?.('qianshouSkillImport') as {
      listLocal?: () => Promise<{ skills: Array<{ name: string; source: string; path: string }> }>
    } | undefined
    const session = (this.ctx as { get?: (name: string) => unknown }).get?.('accountSession') as {
      ensureAccessToken?: () => Promise<string | null>
    } | undefined
    if (!importer?.listLocal) throw new CatalogFailure('order-skill-import-unavailable')
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const inventory = await importer.listLocal()
    const skill = inventory.skills.find(item => item.name === request.name && item.source === request.source)
    if (skill === undefined) throw new CatalogFailure('order-skill-unavailable')
    await normalizeGenericOrderSourceJson(skill.path)
    const adapter = await prepareRegisteredOrderAdapter(skill.path)
    await requireIndependentReviewSamples(skill.path, adapter)
    if (adapter.taskDefinition === null || adapter.taskDefinitionSha256 === null) {
      throw new CatalogFailure('order-platform-contract')
    }
    const priced = await previewPlatformOrderPublicationPrice({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
      taskType: adapter.taskType, taskDefinition: adapter.taskDefinition,
      taskDefinitionSha256: adapter.taskDefinitionSha256,
    })
    return { taskType: adapter.taskType, artifactDigest: `sha256:${adapter.digest}`,
      ...priced }
  }

  /**
   * Install/self-test one registered adapter and submit its exact bytes for independent platform review.
   * @param request - The scanned source, display metadata, sale terms, and confirmed execution price.
   * @returns The exact package submission and platform review state.
   */
  @Remote
  async submitInstalledOrderSkill(request: SubmitOrderSkillRequest): Promise<SubmittedOrderSkill> {
    if (this.closed) throw new CatalogFailure('closed')
    if (request === null || typeof request !== 'object' || !['user-dsh', 'user-agents'].includes(request.source)
      || typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)
      || typeof request.displayName !== 'string' || request.displayName.trim().length < 1 || request.displayName.length > 80
      || typeof request.purpose !== 'string' || request.purpose.trim().length < 1 || request.purpose.length > 500
      || typeof request.configuration !== 'string' || request.configuration.length > 1000
      || (request.salePriceYuan !== undefined && (typeof request.salePriceYuan !== 'string'
        || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u.test(request.salePriceYuan)
        || Number(request.salePriceYuan) > 100000))
      || (request.expectedArtifactDigest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(request.expectedArtifactDigest))
      || (request.expectedTaskDefinitionSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(request.expectedTaskDefinitionSha256))
      || typeof request.priceYuan !== 'string' || (request.priceYuan !== ''
        && (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u.test(request.priceYuan)
          || Number(request.priceYuan) > 100000))) throw new CatalogFailure('order-draft-invalid')
    const importer = (this.ctx as { get?: (name: string) => unknown }).get?.('qianshouSkillImport') as {
      listLocal?: () => Promise<{ skills: Array<{ name: string; source: string; path: string }> }>
    } | undefined
    const session = (this.ctx as { get?: (name: string) => unknown }).get?.('accountSession') as {
      ensureAccessToken?: () => Promise<string | null>
    } | undefined
    const contributor = (this.ctx as { get?: (name: string) => unknown }).get?.('nodeContributor') as ArtifactContributor | undefined
    if (!importer?.listLocal) throw new CatalogFailure('order-skill-import-unavailable')
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const inventory = await importer.listLocal()
    const skill = inventory.skills.find(item => item.name === request.name && item.source === request.source)
    if (skill === undefined) throw new CatalogFailure('order-skill-unavailable')
    await normalizeGenericOrderSourceJson(skill.path)
    const adapter = await prepareRegisteredOrderAdapter(skill.path)
    await requireIndependentReviewSamples(skill.path, adapter)
    if ((request.expectedArtifactDigest !== undefined
      && request.expectedArtifactDigest !== `sha256:${adapter.digest}`)
      || (request.expectedTaskDefinitionSha256 !== undefined
        && request.expectedTaskDefinitionSha256 !== adapter.taskDefinitionSha256)) {
      throw new CatalogFailure('order-local-verification-failed')
    }
    if (request.priceYuan === '' && adapter.taskDefinition === null) {
      throw new CatalogFailure('order-draft-invalid')
    }
    const selected = await adapter.verifyLocal(contributor)
    if (selected.taskType !== adapter.taskType || selected.artifactDigest !== `sha256:${adapter.digest}`
      || selected.inventoryAlgorithm !== adapter.inventoryAlgorithm || ! selected.localVerified) {
      throw new CatalogFailure('order-local-verification-failed')
    }
    const artifactDigest = `sha256:${adapter.digest}`
    const archive = await buildCanonicalOrderArchive(adapter.root, artifactDigest, adapter.inventoryAlgorithm)
    const receipt = await submitPlatformOrderPublication({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
      payload: { task_type: adapter.taskType, capability_id: adapter.capabilityId,
        input_kinds: [...adapter.inputKinds], output_kind: adapter.outputKind,
        contract_version: adapter.contractVersion,
        artifact_digest: artifactDigest, package_digest: selected.packageDigest,
        version: adapter.version, name: request.displayName.trim(), category: adapter.category,
        description: request.purpose.trim(), configuration: request.configuration.trim(),
        ...(adapter.taskDefinition === null ? {} : { task_definition: adapter.taskDefinition }),
        currency: 'CNY', ...(request.salePriceYuan === undefined ? {}
          : { sale_price_yuan: Number(request.salePriceYuan).toFixed(2) }), ...(request.priceYuan === '' ? {}
          : { price_yuan: Number(request.priceYuan).toFixed(2) }) },
    })
    const upload = await attemptOrderArchiveUpload({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
      publicationId: receipt.id, ownerId: receipt.ownerId,
      packageDigest: selected.packageDigest, archive, version: adapter.version,
      profileDir: String((this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir ?? ''),
      trustedArchiveHostname: this.config.orderArchiveHostname ?? '',
    })
    const sample = upload.archiveStatus === 'confirmed'
      ? adapter.inventoryAlgorithm === 'qianshou.native-binding-package.v1'
        ? await this.queueNativeH3Review(skill.path, receipt.id, receipt.ownerId)
        : adapter.taskDefinition !== null
          ? { reviewSampleStatus: 'independent_sample_required' as const }
          : await attemptOrderReviewSampleStart({
            origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token, publicationId: receipt.id }) : {}
    return { publicationId: receipt.id, status: receipt.status, priceYuan: receipt.priceYuan,
      ...(receipt.salePriceYuan === undefined ? {} : { salePriceYuan: receipt.salePriceYuan }),
      ...(receipt.marketProductId === undefined ? {} : { marketProductId: receipt.marketProductId }),
      ...(receipt.marketProductStatus === undefined ? {} : { marketProductStatus: receipt.marketProductStatus }), ...upload, ...sample,
      taskType: adapter.taskType, artifactDigest,
      reviewReasons: [...receipt.reviewReasons], platformReady: selected.platformReady }
  }
  /** Queue native owner samples after locked source upload; the publication screen remains responsive. */
  private async nativeH3CurrentSelection(node: NodeIntakePort, selection: NativeH3PresenceSelection): Promise<NativeH3PresenceSelection> {
    if (selection.declaration.contractVersion !== 'v2') return selection
    const canonical = selection.declaration.runtimeAbi === NATIVE_H3_RUNTIME_ABI_CANONICAL
    const read = canonical ? node.nativeH3AuthorBindingCanonical?.bind(node) : node.nativeH3AuthorBindingV2?.bind(node)
    if (read === undefined) throw new CatalogFailure('order-node-contributor-unavailable')
    const actual = await read()
    const binding = canonical ? parseNativeH3CanonicalExecutionBinding(actual.binding)
      : parseNativeH3ExecutionBindingV2(actual.binding)
    if (nativeH3PublicBindingDigest(binding) !== nativeH3PublicBindingDigest(selection.declaration)
      || !/^sha256:[a-f0-9]{64}$/u.test(actual.localOwnerConfigDigest)) throw new CatalogFailure('order-local-verification-failed')
    return { ...selection, localOwnerConfigDigest: actual.localOwnerConfigDigest }
  }

  private async nativeH3ConfigHead(control: NativeH3ReviewControl, node: NativeH3PresenceNodePort,
    selection: NativeH3PresenceSelection, publicationId: string, connectionId: string,
    register?: { signer: Awaited<ReturnType<typeof enrollNativeH3DeviceKey>>
      keys: NativeH3PurposeKeys }): Promise<NativeH3PresenceSelection> {
    if (selection.declaration.contractVersion !== 'v2') return selection
    const prepared = await this.nativeH3CurrentSelection(node, selection)
    if (prepared.declaration.schema !== 'qianshou.native-h3-binding.v2' || prepared.localOwnerConfigDigest === undefined) {
      throw new CatalogFailure('order-local-verification-failed')
    }
    const configSelection = { declaration: prepared.declaration, sourceDigest: prepared.sourceDigest,
      localOwnerConfigDigest: prepared.localOwnerConfigDigest }
    const assertLocalCurrent = async (): Promise<void> => {
      await control.assertCurrent()
      const current = await this.nativeH3CurrentSelection(node, prepared)
      if (current.localOwnerConfigDigest !== prepared.localOwnerConfigDigest) throw new CatalogFailure('order-local-verification-failed')
      await control.assertCurrent()
    }
    const observeConfig = node.observeNativeH3DeviceConfigProof?.bind(node)
    if (register !== undefined && observeConfig === undefined) throw new CatalogFailure('order-node-contributor-unavailable')
    const head = register === undefined ? await readNativeH3DeviceConfig({ ...control, publicationId, selection: configSelection })
      : await registerNativeH3DeviceConfig({ ...control, publicationId, connectionId, selection: configSelection,
        signer: register.signer, challengeKeys: register.keys.challenge, assertLocalCurrent,
        observeConfig: observeConfig ?? (() => Promise.reject(new CatalogFailure('order-node-contributor-unavailable'))) })
    await assertLocalCurrent()
    if (head.status !== 'registered' || head.local_owner_config_digest !== prepared.localOwnerConfigDigest
      || selection.deviceBindingRevision !== undefined && head.device_binding_revision !== selection.deviceBindingRevision) {
      throw new CatalogFailure('order-author-device-unverified')
    }
    return { ...prepared, deviceBindingRevision: head.device_binding_revision }
  }

  private async queueNativeH3Review(skillPath: string, publicationId: string,
    ownerId: number, restart = false): Promise<Pick<SubmittedOrderSkill, 'reviewSampleStatus' | 'reviewSampleError'>> {
    try {
      if (this.closed || await this.fileAccountId() !== ownerId) throw new CatalogFailure('order-auth-required')
      const node = this.ctx.get('nodeContributor') as NativeH3PresenceNodePort & {
        acknowledgedWorkerId?(): string | null
        acknowledgedConnectionId?(): string | null
        observeNativeH3DeviceKeyProof?(input: { challengeId: string; signature: string }): Promise<void>
        runNativeH3ReviewChallenge?(input: {
          selection: { declaration: NativeH3Declaration; sourceDigest: string; taskDefinitionSha256: string }
          publicationId: string
          contractSha256: string
          challenge: VerifiedNativeH3ReviewChallenge
          signal: AbortSignal
          assertBindingCurrent?: () => Promise<void>
          upload(input: { filename: 'result.mp4'; contentType: 'video/mp4'; bytes: Uint8Array; sha256: string },
            signal: AbortSignal): Promise<NativeH3ReviewArtifact>
        }): Promise<NativeH3ReviewExecution>
      } | undefined
      const workerId = node?.acknowledgedWorkerId?.()
      const connectionId = node?.acknowledgedConnectionId?.()
      const observe = node?.observeNativeH3DeviceKeyProof?.bind(node)
      const run = node?.runNativeH3ReviewChallenge?.bind(node)
      if (node === undefined || !workerId || !connectionId || observe === undefined || run === undefined) {
        throw new CatalogFailure('order-node-contributor-unavailable')
      }
      if (!this.config.orderArchiveHostname) {
        throw new CatalogFailure('order-review-samples-unavailable')
      }
      const source = await readNativeH3OrderSource(skillPath)
      const definition = source.files.find(file => file.path === 'task-definition.json')
      if (definition === undefined) throw new CatalogFailure('order-local-verification-failed')
      let selection: NativeH3PresenceSelection = { declaration: source.declaration, sourceDigest: `sha256:${source.digest}`,
        taskDefinitionSha256: `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}` }
      selection = await this.nativeH3CurrentSelection(node, selection)
      const key = `${ownerId}\0${publicationId}`
      const token = await reviewedSeedAccount(this.ctx)?.ensureAccessToken()
      if (!token) throw new CatalogFailure('order-auth-required')
      const profileDir = (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir
      if (typeof profileDir !== 'string') throw new CatalogFailure('order-review-samples-unavailable')
      const abort = new AbortController()
      const state: { digest: string
        workerId: string
        connectionId: string
        localOwnerConfigDigest?: string
        deviceBindingRevision?: number
        status: 'pending' | 'running' | 'evidence_deposited' | 'blocked'
        error?: CatalogFailureCode } = { digest: selection.sourceDigest, status: 'pending', workerId, connectionId,
        ...selection.localOwnerConfigDigest === undefined ? {} : { localOwnerConfigDigest: selection.localOwnerConfigDigest } }
      const assertCurrent = async (): Promise<void> => {
        abort.signal.throwIfAborted()
        if (this.closed || await this.fileAccountId() !== ownerId
          || node?.acknowledgedWorkerId?.() !== workerId
          || node.acknowledgedConnectionId?.() !== connectionId
          || (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir !== profileDir
          || await reviewedSeedAccount(this.ctx)?.ensureAccessToken() !== token) throw new CatalogFailure('order-auth-required')
        if ((await readNativeH3OrderSource(skillPath)).digest !== source.digest) {
          throw new CatalogFailure('order-local-verification-failed')
        }
      }
      const control: NativeH3ReviewControl = { origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
        token, ownerId, workerId, profileDir,
        signal: abort.signal, assertCurrent, observeDeviceKey: observe }
      const previous = this.nativeReviewTasks.get(key)
      if (previous !== undefined) {
        if (previous.digest !== selection.sourceDigest) throw new CatalogFailure('order-publication-conflict')
        if (previous.workerId !== workerId || previous.connectionId !== connectionId
          || previous.localOwnerConfigDigest !== selection.localOwnerConfigDigest) {
          throw new CatalogFailure('order-review-samples-not-ready')
        }
        if (previous.status === 'evidence_deposited' && selection.declaration.contractVersion === 'v2') {
          const current = await this.nativeH3ConfigHead(control, node, selection, publicationId, connectionId)
          if (previous.deviceBindingRevision !== current.deviceBindingRevision) {
            throw new CatalogFailure('order-review-samples-not-ready')
          }
        }
        if (previous.status !== 'blocked' || !restart) {
          return { reviewSampleStatus: previous.status, ...(previous.error === undefined ? {} : { reviewSampleError: previous.error }) }
        }
        this.nativeReviewTasks.delete(key)
      }
      if (this.nativeReviewTasks.size >= 64) throw new CatalogFailure('order-review-samples-not-ready')
      this.nativeReviewTasks.set(key, state)
      const task: { abort: AbortController; done: Promise<unknown> } = { abort, done: Promise.resolve() }
      this.pending.add(task)
      task.done = (async () => {
        const purposeKeys = await this.nativeH3PurposeKeys(control)
        const challengeKeys = purposeKeys.challenge
        const issuanceKeys = purposeKeys.issuance
        const signer = await enrollNativeH3DeviceKey(control)
        selection = await this.nativeH3ConfigHead(control, node, selection, publicationId, connectionId,
          { signer, keys: purposeKeys })
        if (selection.deviceBindingRevision !== undefined) state.deviceBindingRevision = selection.deviceBindingRevision
        const assertBindingCurrent = async (): Promise<void> => {
          await assertCurrent()
          await this.nativeH3ConfigHead(control, node, selection, publicationId, connectionId)
        }
        const challenges = await startNativeH3ReviewSamples({ ...control, publicationId,
          sourceDigest: selection.sourceDigest, declaration: source.declaration, deviceKeyId: signer.keyId,
          ...selection.localOwnerConfigDigest === undefined ? {} : { localOwnerConfigDigest: selection.localOwnerConfigDigest },
          ...selection.deviceBindingRevision === undefined ? {} : { deviceBindingRevision: selection.deviceBindingRevision },
          challengeKeys, restart })
        state.status = 'running'
        for (const [index, challenge] of challenges.entries()) {
          await assertCurrent()
          const execution = await run({ selection, publicationId, contractSha256: challenge.payload.contract_sha256,
            challenge, signal: abort.signal, assertBindingCurrent,
            upload: async (output, signal) => uploadNativeH3ReviewArtifact({ ...control, signal, publicationId,
              contractVersion: selection.declaration.contractVersion, challengeNonce: challenge.payload.challenge_nonce,
              bytes: output.bytes, sha256: output.sha256,
              trustedUploadHostname: this.config.orderArchiveHostname ?? '', issuanceKeys }) })
          await assertBindingCurrent()
          const reported = await reportNativeH3ReviewSample({ ...control, signer, execution })
          if (reported !== (index === challenges.length - 1 ? 'independent_sample_verified' : 'awaiting_second_sample')) {
            throw new CatalogFailure('order-review-samples-not-ready')
          }
        }
        await assertCurrent()
        state.status = 'evidence_deposited'
      })().catch((error: unknown) => {
        state.status = 'blocked'
        state.error = error instanceof CatalogFailure ? error.code : 'order-review-samples-unavailable'
      }).finally(() => { this.pending.delete(task) })
      return { reviewSampleStatus: 'pending' }
    } catch (error) {
      return { reviewSampleStatus: 'blocked', reviewSampleError: error instanceof CatalogFailure
        ? error.code : 'order-review-samples-unavailable' }
    }
  }
  /**
   * Retry only the source archive for the same account, package digest and publication id.
   * @param request - The current account's existing publication and exact package digest.
   * @returns The same publication with its source-archive transfer status.
   */
  @Remote
  async retryInstalledOrderSkillArchive(request: { source: 'user-dsh' | 'user-agents'; name: string }):
  Promise<SubmittedOrderSkill> {
    if (this.closed) throw new CatalogFailure('closed')
    if (request === null || typeof request !== 'object' || Object.keys(request).length !== 2
      || !['user-dsh', 'user-agents'].includes(request.source)
      || typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)) {
      throw new CatalogFailure('order-draft-invalid')
    }
    const importer = (this.ctx as { get?: (name: string) => unknown }).get?.('qianshouSkillImport') as {
      listLocal?: () => Promise<{ skills: Array<{ name: string; source: string; path: string }> }>
    } | undefined
    const session = (this.ctx as { get?: (name: string) => unknown }).get?.('accountSession') as {
      ensureAccessToken?: () => Promise<string | null>
    } | undefined
    const contributor = (this.ctx as { get?: (name: string) => unknown }).get?.('nodeContributor') as ArtifactContributor | undefined
    if (!importer?.listLocal) throw new CatalogFailure('order-skill-import-unavailable')
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const inventory = await importer.listLocal()
    const skill = inventory.skills.find(item => item.name === request.name && item.source === request.source)
    if (skill === undefined) throw new CatalogFailure('order-skill-unavailable')
    const adapter = await prepareRegisteredOrderAdapter(skill.path)
    const selected = await adapter.verifyLocal(contributor)
    if (selected.taskType !== adapter.taskType || selected.artifactDigest !== `sha256:${adapter.digest}`
      || selected.inventoryAlgorithm !== adapter.inventoryAlgorithm || ! selected.localVerified) {
      throw new CatalogFailure('order-local-verification-failed')
    }
    const artifactDigest = `sha256:${adapter.digest}`
    const archive = await buildCanonicalOrderArchive(adapter.root, artifactDigest, adapter.inventoryAlgorithm)
    const mine = await listPlatformOrderPublications({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
    })
    const publication = mine.find(item => item.taskType === adapter.taskType
      && item.artifactDigest === artifactDigest)
    if (publication === undefined || publication.packageDigest !== selected.packageDigest
      || publication.status !== 'review') throw new CatalogFailure('order-publication-conflict')
    const upload = await attemptOrderArchiveUpload({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
      publicationId: publication.id, ownerId: publication.ownerId,
      packageDigest: selected.packageDigest, archive, version: adapter.version,
      profileDir: String((this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir ?? ''),
      trustedArchiveHostname: this.config.orderArchiveHostname ?? '',
    })
    const sample = upload.archiveStatus === 'confirmed'
      ? adapter.inventoryAlgorithm === 'qianshou.native-binding-package.v1'
        ? await this.queueNativeH3Review(skill.path, publication.id, publication.ownerId)
        : adapter.taskDefinition !== null
          ? { reviewSampleStatus: 'independent_sample_required' as const }
          : await attemptOrderReviewSampleStart({
            origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
            publicationId: publication.id }) : {}
    return { publicationId: publication.id, status: 'review',
      ...(publication.salePriceYuan === undefined ? {} : { salePriceYuan: publication.salePriceYuan }),
      ...(publication.marketProductId === undefined ? {} : { marketProductId: publication.marketProductId }),
      ...(publication.marketProductStatus === undefined ? {} : { marketProductStatus: publication.marketProductStatus }),
      ...upload, ...sample,
      taskType: adapter.taskType, artifactDigest, reviewReasons: [...publication.reviewReasons],
      platformReady: selected.platformReady }
  }
  /**
   * Retry the idempotent review sample after the exact archive was confirmed.
   * @param request - The existing publication whose exact source archive is already confirmed.
   * @returns The platform's sample verification state for the existing publication.
   */
  @Remote
  async startOrderReviewSamples(request: { publicationId: string }): Promise<OrderReviewSampleStatus> {
    if (this.closed) throw new CatalogFailure('closed')
    if (request === null || typeof request !== 'object' || Object.keys(request).length !== 1
      || typeof request.publicationId !== 'string'
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(request.publicationId)) {
      throw new CatalogFailure('order-review-samples-invalid')
    }
    const session = (this.ctx as { get?: (name: string) => unknown }).get?.('accountSession') as {
      ensureAccessToken?: () => Promise<string | null>
    } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const importer = this.ctx.get('qianshouSkillImport') as OrderSkillInventoryPort | undefined
    const inventory = await importer?.listLocal()
    const nativeSources: { path: string; source: Awaited<ReturnType<typeof readNativeH3OrderSource>> }[] = []
    for (const skill of inventory?.skills ?? []) {
      if ((skill.source !== 'user-dsh' && skill.source !== 'user-agents') || skill.path === undefined) continue
      try { nativeSources.push({ path: skill.path, source: await readNativeH3OrderSource(skill.path) }) }
      catch { /* Other review runtimes retain their existing route. */ }
    }
    const ownerId = await this.fileAccountId()
    if (nativeSources.length > 0
      || ownerId !== null && this.nativeReviewTasks.has(`${ownerId}\0${request.publicationId}`)) {
      if (ownerId === null) throw new CatalogFailure('order-auth-required')
      const mine = await listPlatformOrderPublications({ origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token })
      const publication = mine.find(row => row.id === request.publicationId && row.ownerId === ownerId)
      if (publication === undefined) throw new CatalogFailure('order-publication-conflict')
      const native = nativeSources.find(({ source }) => publication?.taskType === source.declaration.taskType
        && publication.artifactDigest === `sha256:${source.digest}`
        && publication.packageDigest === nativeH3PublicBindingDigest(source.declaration))
      if (native !== undefined && publication !== undefined) {
        if (publication.status !== 'review' || publication.lifecycle?.archived === true
          || publication.lifecycle !== undefined && publication.lifecycle.state !== 'active'
          || publication.packageUploadStatus !== 'confirmed' || publication.authorManifestStatus !== 'recorded') {
          throw new CatalogFailure('order-review-samples-not-ready')
        }
        if (await this.fileAccountId() !== ownerId || await session?.ensureAccessToken?.() !== token) {
          throw new CatalogFailure('order-auth-required')
        }
        const result = await this.queueNativeH3Review(native.path, publication.id, ownerId, true)
        if (result.reviewSampleError !== undefined) throw new CatalogFailure(result.reviewSampleError)
        const status = result.reviewSampleStatus
        if (status === undefined || status === 'independent_sample_required') throw new CatalogFailure('order-review-samples-not-ready')
        return { publicationId: publication.id, status,
          mediaEvidenceStatus: publication.mediaEvidenceStatus ?? 'missing' }
      }
      if (nativeSources.some(({ source }) => source.declaration.taskType === publication.taskType)
        || this.nativeReviewTasks.has(`${ownerId}\0${publication.id}`)) {
        throw new CatalogFailure('order-local-verification-failed')
      }
    }
    return startPlatformOrderReviewSamples({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
      publicationId: request.publicationId,
    })
  }
  /**
   * Identify registered, intact local adapters without preparing a runtime, changing grants, or contacting Shanghai.
   * @returns The intact local declarations and their source-bound eligibility.
   */
  @Remote
  async localOrderSkillEligibility(): Promise<{ items: LocalOrderSkillEligibility[] }> {
    if (this.closed) throw new CatalogFailure('closed')
    const importer = (this.ctx as { get?: (name: string) => unknown }).get?.('qianshouSkillImport') as {
      listLocal?: () => Promise<{ skills: Array<{ name: string; source: string; path: string }> }>
    } | undefined
    if (!importer?.listLocal) throw new CatalogFailure('order-skill-import-unavailable')
    const inventory = await importer.listLocal()
    const items: LocalOrderSkillEligibility[] = []
    for (const skill of inventory.skills) {
      if (skill.source !== 'user-dsh' && skill.source !== 'user-agents') continue
      try {
        const identity = await identifyRegisteredOrderAdapter(skill.path)
        let runtimeKind: 'native-h3' | undefined
        try {
          const native = await readNativeH3OrderSource(skill.path)
          if (`sha256:${native.digest}` === identity.artifactDigest
            && native.declaration.taskType === identity.taskType) runtimeKind = 'native-h3'
        } catch { /* Other intact registered runtimes retain their existing eligibility. */ }
        items.push({ source: skill.source, name: skill.name, path: skill.path,
          ...(runtimeKind === undefined ? {} : { runtimeKind }),
          taskType: identity.taskType, artifactDigest: identity.artifactDigest,
          platformPriced: identity.platformPriced,
          ...(identity.serviceTitle === undefined ? {} : { serviceTitle: identity.serviceTitle }),
          ...(identity.serviceDescription === undefined ? {} : { serviceDescription: identity.serviceDescription }) })
      } catch { /* A SKILL.md or unchecked adapter is not a publishable order source. */ }
    }
    return { items }
  }
  /**
   * Restore author review state from Shanghai, matched to the current skill source digest.
   * @param request - Whether to include unmatched or archived platform history for cloud management.
   * @returns Current matching review records and explicitly requested cloud history.
   */
  @Remote
  async myOrderSkillPublications(request?: { includeArchived?: boolean }): Promise<{ items: MyOrderSkillPublication[] }> {
    if (this.closed) throw new CatalogFailure('closed')
    const importer = (this.ctx as { get?: (name: string) => unknown }).get?.('qianshouSkillImport') as {
      listLocal?: () => Promise<{ skills: Array<{ name: string; source: string; path: string }> }>
    } | undefined
    const session = (this.ctx as { get?: (name: string) => unknown }).get?.('accountSession') as {
      ensureAccessToken?: () => Promise<string | null>
    } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const [mine, inventory] = await Promise.all([
      listPlatformOrderPublications({ origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
        ...(request?.includeArchived === undefined ? {} : { includeArchived: request.includeArchived }) }),
      importer?.listLocal?.() ?? Promise.resolve({ skills: [] }),
    ])
    const items: MyOrderSkillPublication[] = []
    const profile = (this.ctx as { get?: (name: string) => unknown }).get?.('profileContext') as
      { dir?: unknown } | undefined
    const needsPackageMigration = await legacySvgPackageSelection(profile?.dir)
    for (const skill of inventory.skills) {
      if (skill.source !== 'user-dsh' && skill.source !== 'user-agents') continue
      let identity: Awaited<ReturnType<typeof identifyRegisteredOrderAdapter>>
      try { identity = await identifyRegisteredOrderAdapter(skill.path) }
      catch { continue }
      const receipt = mine.find(item => item.taskType === identity.taskType
        && item.artifactDigest === identity.artifactDigest)
      if (receipt === undefined) continue
      let runtimeKind: 'native-h3' | undefined
      try {
        const native = await readNativeH3OrderSource(skill.path)
        if (`sha256:${native.digest}` === receipt.artifactDigest
          && native.declaration.taskType === receipt.taskType
          && nativeH3PublicBindingDigest(native.declaration) === receipt.packageDigest) runtimeKind = 'native-h3'
      } catch { /* Other runtimes never inherit a native capability from their display name. */ }
      items.push({ source: skill.source, name: skill.name, publicationId: receipt.id,
        ...(runtimeKind === undefined ? {} : { runtimeKind }),
        ...(receipt.name === undefined ? {} : { displayName: receipt.name }),
        ...(receipt.lifecycle === undefined ? {} : { lifecycle: receipt.lifecycle }),
        status: receipt.status, taskType: receipt.taskType,
        artifactDigest: receipt.artifactDigest, reviewReasons: [...receipt.reviewReasons],
        ...(receipt.evidenceStatus === undefined ? {} : { evidenceStatus: receipt.evidenceStatus }),
        ...(receipt.priceYuan === undefined ? {} : { priceYuan: receipt.priceYuan }),
        ...(receipt.salePriceYuan === undefined ? {} : { salePriceYuan: receipt.salePriceYuan }),
        ...(receipt.marketProductId === undefined ? {} : { marketProductId: receipt.marketProductId }),
        ...(receipt.marketProductStatus === undefined ? {} : { marketProductStatus: receipt.marketProductStatus }),
        archiveStatus: receipt.packageUploadStatus === 'confirmed'
          && receipt.authorManifestStatus === 'recorded' ? 'confirmed' : 'pending',
        ...(receipt.reviewSampleStatus === undefined ? {} : { reviewSampleStatus: receipt.reviewSampleStatus }),
        ...(receipt.mediaEvidenceStatus === undefined ? {} : { mediaEvidenceStatus: receipt.mediaEvidenceStatus }),
        ...(() => {
          const native = this.nativeReviewTasks.get(`${receipt.ownerId}\0${receipt.id}`)
          return native?.digest === receipt.artifactDigest && receipt.status === 'review'
            && receipt.reviewSampleStatus !== 'verified' && receipt.evidenceStatus?.sample !== 'valid'
            && receipt.mediaEvidenceStatus !== 'valid'
            ? { reviewSampleStatus: native.status, ...(native.error === undefined ? {} : { reviewSampleError: native.error }) } : {}
        })(),
        ...(identity.taskType === 'bar_chart_svg_v1' && needsPackageMigration
          ? { packageMigrationRequired: true } : {}) })
    }
    for (const receipt of request?.includeArchived === true ? mine : []) {
      if (items.some(item => item.publicationId === receipt.id)) continue
      items.push({ source: 'platform', name: receipt.name ?? receipt.taskType,
        displayName: receipt.name ?? receipt.taskType, publicationId: receipt.id,
        status: receipt.status, taskType: receipt.taskType, artifactDigest: receipt.artifactDigest,
        reviewReasons: [...receipt.reviewReasons],
        ...(receipt.lifecycle === undefined ? {} : { lifecycle: receipt.lifecycle }),
        ...(receipt.marketProductId === undefined ? {} : { marketProductId: receipt.marketProductId }),
        ...(receipt.marketProductStatus === undefined ? {} : { marketProductStatus: receipt.marketProductStatus }) })
    }
    return { items }
  }
  /**
   * Author actions use the current JWT and exact cloud record; no client owner is accepted.
   * @param request - The exact publication, locked version, and requested author action.
   * @returns The platform receipt for the requested author lifecycle action.
   */
  @Remote
  async manageOrderSkillPublication(request: ManageOrderSkillPublicationRequest): Promise<OrderPublicationLifecycleReceipt> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const origin = this.config.coreOrigin ?? 'https://qianshousuanli.com'
    const mine = await listPlatformOrderPublications({ origin, token, includeArchived: true })
    const row = mine.find(item => item.id === request?.publicationId)
    if (!row || row.lifecycle?.revision !== request.expectedRevision
      || !row.lifecycle.allowedActions.includes(request.action)) throw new CatalogFailure('order-publication-conflict')
    return managePlatformOrderPublication({ ...request, origin, token, ownerId: row.ownerId })
  }
  /**
   * Only independently approved and published products appear. This read does not touch an account.
   * @returns The independently approved, published product metadata.
   */
  @Remote
  async orderAdapterProducts(): Promise<{ products: OrderAdapterProduct[] }> {
    if (this.closed) throw new CatalogFailure('closed')
    const listed = await listOrderAdapterProducts({ origin: this.config.coreOrigin ?? 'https://qianshousuanli.com' })
    if (process.platform !== 'win32') return listed
    return { products: listed.products.map(product => product.runtimeAbi === 'quickjs-wasm.v3'
      ? product : { ...product, availableToPurchase: false,
        purchaseBlockReason: '当前商品尚未提供可在 Windows 验证的运行包' }) }
  }
  /**
   * The author's own product application state is always read from Shanghai.
   * @returns The current author's server-held product applications.
   */
  @Remote
  async mySellerOrderProducts(): Promise<{ items: SellerOrderProduct[] }> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    return listSellerOrderProducts({ origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token })
  }
  /**
   * Submit an approved skill for separate goods review with an explicit one-time CNY sale price.
   * @param request - The approved skill and explicitly chosen one-time CNY sale price.
   * @returns The product application and its independent goods-review state.
   */
  @Remote
  async submitSellerOrderProduct(request: { publicationId: string; salePriceYuan: string }):
  Promise<SellerOrderProduct> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    return submitSellerOrderProduct({ origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
      token, publicationId: request?.publicationId, salePriceYuan: request?.salePriceYuan })
  }
  /**
   * Recover server-held buyer ownership and this worker's receipt after a client restart.
   * @returns The current account's entitlements and device installation receipts.
   */
  @Remote
  async myPurchasedOrderAdapters(): Promise<{ items: OrderAdapterBuyerEntitlement[] }> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const contributor = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    const workerId = contributor?.acknowledgedWorkerId?.() ?? null
    return listBuyerOrderAdapterEntitlements({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token, workerId,
    })
  }

  private async purchasedRuntimeEntries(workerId: string, productId?: string): Promise<{
    runtime: VerifiedPurchasedOrderRuntime
    source: GenericOrderSource
  }[]> {
    if (this.closed || !workerId || !['darwin', 'win32'].includes(process.platform)) return []
    const contributor = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    if (contributor?.acknowledgedWorkerId?.() !== workerId) return []
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) return []
    const origin = this.config.coreOrigin ?? 'https://qianshousuanli.com'
    const owned = await listBuyerOrderAdapterEntitlements({ origin, token, workerId })
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    const result: { runtime: VerifiedPurchasedOrderRuntime; source: GenericOrderSource }[] = []
    const seen = new Set<string>()
    for (const entitlement of owned.items) {
      if (productId !== undefined && entitlement.productId !== productId) continue
      if (entitlement.status !== 'installed' || !entitlement.deviceInstalled
        || entitlement.runtimeDigest === null) continue
      try {
        const signed = await readVerifiedOrderAdapterSource({ origin,
          productId: entitlement.productId, token,
          trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {} })
        if (seen.has(signed.taskType)) continue
        const installed = await loadOwnedInstalledRuntime(entitlement, signed, home)
        if (installed === null) continue
        seen.add(signed.taskType)
        result.push(installed)
      } catch { /* A revoked, unavailable or mutated package is never announced. */ }
      if (result.length >= 64) break
    }
    return result
  }

  private async fileAccountId(): Promise<number | null> {
    const account = await reviewedSeedAccount(this.ctx)?.snapshot()
    const id = account?.account?.id
    if (!['authenticated', 'refreshing'].includes(account?.phase ?? '') || typeof id !== 'string'
      || !/^[1-9][0-9]*$/u.test(id) || !Number.isSafeInteger(Number(id))) return null
    return Number(id)
  }

  /** Recheck current authenticated native provider bindings; this method is Host-only.
   * @param workerId - The worker acknowledged by this profile's authenticated Edge socket.
   * @returns Exact current owner/device publications with purpose-verified process credentials.
   */
  async verifiedNativeH3OrderBindings(workerId: string): Promise<NativeH3CatalogBinding[]> {
    if (this.closed || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(workerId)) return []
    const contributor = this.ctx.get('nodeContributor') as NativeH3PresenceNodePort | undefined
    if (contributor?.acknowledgedWorkerId?.() !== workerId) return []
    const ownerId = await this.fileAccountId()
    if (ownerId === null) return []
    const token = await reviewedSeedAccount(this.ctx)?.ensureAccessToken()
    if (!token) return []
    const connectionId = contributor.acknowledgedConnectionId?.()
    if (!connectionId) return []
    const key = `${ownerId}\0${workerId}\0${connectionId}\0${createHash('sha256').update(token).digest('hex')}`
    const pending = this.nativePresenceRefreshes.get(key)
    if (pending !== undefined) return pending
    const task = this.refreshNativeH3OrderBindings(contributor, ownerId, workerId, connectionId, token)
      .finally(() => { this.nativePresenceRefreshes.delete(key) })
    this.nativePresenceRefreshes.set(key, task)
    return task
  }

  private async nativeH3PurposeKeys(control: NativeH3ReviewControl): Promise<NativeH3PurposeKeys> {
    await control.assertCurrent()
    if (this.nativePurposeTrust?.origin === control.origin && this.nativePurposeTrust.expiresAt > Date.now()) {
      return this.nativePurposeTrust.keys
    }
    const keys = await fetchNativeH3PurposeKeys({ ...control,
      configured: { ...(this.config.orderNativeH3ChallengeKeys === undefined ? {} : { challenge: this.config.orderNativeH3ChallengeKeys }),
        ...(this.config.orderNativeH3AttestorKeys === undefined ? {} : { attestor: this.config.orderNativeH3AttestorKeys }),
        ...(this.config.orderNativeH3UploadIssuanceKeys === undefined ? {} : { issuance: this.config.orderNativeH3UploadIssuanceKeys }) } })
    this.nativePurposeTrust = { origin: control.origin, keys, expiresAt: Date.now() + 60_000 }
    return keys
  }

  /** Inventory reads already issued proof metadata only; it never enrolls, renews or creates a nonce. */
  private async readNativeH3BindingsForInventory(ownerId: number, workerId: string,
    connectionId: string): Promise<NativeH3CatalogBinding[]> {
    const node = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    const profileDir = (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir
    const token = await reviewedSeedAccount(this.ctx)?.ensureAccessToken()
    if (typeof profileDir !== 'string' || !token || node === undefined) return []
    const assertCurrent = async (): Promise<void> => {
      if (this.closed || await this.fileAccountId() !== ownerId || node.acknowledgedWorkerId?.() !== workerId
        || node.acknowledgedConnectionId?.() !== connectionId
        || (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir !== profileDir
        || await reviewedSeedAccount(this.ctx)?.ensureAccessToken() !== token) throw new CatalogFailure('order-auth-required')
    }
    const control: NativeH3ReviewControl = { origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
      token, ownerId, workerId, profileDir, signal: new AbortController().signal, assertCurrent,
      observeDeviceKey: () => Promise.reject(new CatalogFailure('order-author-device-unverified')) }
    await assertCurrent()
    const keys = await this.nativeH3PurposeKeys(control)
    const bindings = await fetchNativeH3CatalogBindings({ origin: control.origin, token, ownerId, workerId,
      enrolledKeys: keys.attestor })
    const importer = this.ctx.get('qianshouSkillImport') as OrderSkillInventoryPort | undefined
    const inventory = await importer?.listLocal()
    let hasV2 = false
    for (const skill of inventory?.skills ?? []) {
      if (!skill.path || !['user-dsh', 'user-agents'].includes(skill.source)) continue
      try { if ((await readNativeH3OrderSource(skill.path)).declaration.contractVersion === 'v2') hasV2 = true } catch { /* Ordinary skill. */ }
    }
    if (hasV2) bindings.push(...await fetchNativeH3CatalogBindings({ origin: control.origin, token, ownerId, workerId,
      enrolledKeys: keys.attestor, bindingVersion: 2 }))
    await assertCurrent()
    return bindings
  }

  private async refreshNativeH3OrderBindings(node: NativeH3PresenceNodePort, ownerId: number,
    workerId: string, connectionId: string, token: string): Promise<NativeH3CatalogBinding[]> {
    const importer = this.ctx.get('qianshouSkillImport') as OrderSkillInventoryPort | undefined
    const profileDir = (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir
    const observe = node.observeNativeH3DeviceKeyProof?.bind(node)
    const validate = node.validateNativeH3PresenceChallenge?.bind(node)
    const observePresence = node.observeNativeH3DevicePresence?.bind(node)
    if (typeof profileDir !== 'string' || importer?.listLocal === undefined
      || observe === undefined || validate === undefined || observePresence === undefined) return []
    const abort = new AbortController()
    const assertCurrent = async (): Promise<void> => {
      abort.signal.throwIfAborted()
      if (this.closed || await this.fileAccountId() !== ownerId || node.acknowledgedWorkerId?.() !== workerId
        || node.acknowledgedConnectionId?.() !== connectionId
        || (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir !== profileDir
        || await reviewedSeedAccount(this.ctx)?.ensureAccessToken() !== token) throw new CatalogFailure('order-auth-required')
    }
    const control: NativeH3ReviewControl = { origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
      token, ownerId, workerId, profileDir, signal: abort.signal, assertCurrent, observeDeviceKey: observe }
    const task: { abort: AbortController; done: Promise<unknown> } = { abort, done: Promise.resolve() }
    this.pending.add(task)
    task.done = (async () => {
      await assertCurrent()
      const inventory = await importer.listLocal()
      const sources: { path: string; source: Awaited<ReturnType<typeof readNativeH3OrderSource>> }[] = []
      for (const skill of inventory.skills) {
        if ((skill.source !== 'user-dsh' && skill.source !== 'user-agents') || skill.path === undefined) continue
        try { sources.push({ path: skill.path, source: await readNativeH3OrderSource(skill.path) }) }
        catch { /* Ordinary local skills cannot create native supply. */ }
      }
      if (sources.length === 0) return []
      if (sources.length > 16) throw new CatalogFailure('order-platform-contract')
      const keys = await this.nativeH3PurposeKeys(control)
      const readBindings = async (): Promise<NativeH3CatalogBinding[]> => {
        const result = await fetchNativeH3CatalogBindings({ origin: control.origin, token, ownerId, workerId, enrolledKeys: keys.attestor })
        if (sources.some(item => item.source.declaration.contractVersion === 'v2')) result.push(...await fetchNativeH3CatalogBindings({
          origin: control.origin, token, ownerId, workerId, enrolledKeys: keys.attestor, bindingVersion: 2 }))
        return result
      }
      const bindings = await readBindings()
      await assertCurrent()
      const mine = await listPlatformOrderPublications({ origin: control.origin, token })
      await assertCurrent()
      const approved = sources.flatMap((item) => {
        const publication = mine.find(row => row.ownerId === ownerId && row.status === 'approved'
          && row.lifecycle?.archived !== true && (row.lifecycle === undefined || row.lifecycle.state === 'active')
          && row.taskType === item.source.declaration.taskType
          && row.artifactDigest === `sha256:${item.source.digest}`
          && row.packageDigest === nativeH3PublicBindingDigest(item.source.declaration))
        return publication === undefined ? [] : [{ ...item, publication }]
      })
      const now = Math.floor(Date.now() / 1000)
      const needsPresence = approved.filter(({ publication }) => !bindings.some(binding =>
        binding.publicationId === publication.id && binding.sourceDigest === publication.artifactDigest
        && binding.deviceProof.payload.expires_at > now + 60))
      const currentBindings = async (values: NativeH3CatalogBinding[]): Promise<NativeH3CatalogBinding[]> => {
        const result: NativeH3CatalogBinding[] = []
        for (const binding of values) {
          const match = approved.find(({ source, publication }) => binding.publicationId === publication.id
            && binding.sourceDigest === publication.artifactDigest && binding.declaration.taskType === source.declaration.taskType
            && nativeH3PublicBindingDigest(binding.declaration) === nativeH3PublicBindingDigest(source.declaration)
            && binding.declaration.executionRecipeSha256 === source.declaration.executionRecipeSha256
            && binding.declaration.modelSha256 === source.declaration.modelSha256)
          if (match === undefined) continue
          const definition = match.source.files.find(file => file.path === 'task-definition.json')
          if (definition === undefined || binding.taskDefinitionSha256
            !== `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}`) continue
          try {
            if ((await readNativeH3OrderSource(match.path)).digest === match.source.digest) {
              const selection = await this.nativeH3ConfigHead(control, node, { declaration: match.source.declaration,
                sourceDigest: binding.sourceDigest, taskDefinitionSha256: binding.taskDefinitionSha256 },
              binding.publicationId, connectionId)
              if (binding.declaration.contractVersion === 'v1' || binding.localOwnerConfigDigest === selection.localOwnerConfigDigest
                && binding.deviceBindingRevision === selection.deviceBindingRevision) result.push(binding)
            }
          } catch { /* Missing or changed local sources cannot advertise old cloud supply. */ }
        }
        await assertCurrent()
        return result
      }
      if (needsPresence.length === 0) return currentBindings(bindings)
      const signer = await enrollNativeH3DeviceKey(control)
      for (const { source, path, publication } of needsPresence) {
        const definition = source.files.find(file => file.path === 'task-definition.json')
        if (definition === undefined) throw new CatalogFailure('order-local-verification-failed')
        const checkSource = async (): Promise<void> => {
          await assertCurrent()
          if ((await readNativeH3OrderSource(path)).digest !== source.digest) {
            throw new CatalogFailure('order-local-verification-failed')
          }
        }
        try {
          const selection = await this.nativeH3ConfigHead({ ...control, assertCurrent: checkSource }, node,
            { declaration: source.declaration, sourceDigest: publication.artifactDigest,
              taskDefinitionSha256: `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}` }, publication.id, connectionId)
          const checkBinding = async (): Promise<void> => {
            await checkSource()
            await this.nativeH3ConfigHead({ ...control, assertCurrent: checkSource }, node, selection, publication.id, connectionId)
          }
          await renewNativeH3DevicePresence({ ...control, assertCurrent: checkBinding, signer,
            publicationId: publication.id, connectionId,
            selection,
            challengeKeys: keys.challenge, attestorKeys: keys.attestor, validate, observePresence })
        } catch {
          // An unavailable publication cannot suppress another independently valid native provider.
          await assertCurrent()
        }
      }
      await assertCurrent()
      const renewed = await readBindings()
      await assertCurrent()
      return currentBindings(renewed)
    })().finally(() => { this.pending.delete(task) })
    return task.done as Promise<NativeH3CatalogBinding[]>
  }

  private fileTransportConfigured(): boolean {
    let coreHost: string
    try { coreHost = new URL(this.config.coreOrigin ?? 'https://qianshousuanli.com').hostname } catch { return false }
    const hosts = [this.config.orderFileAttestorHostname, this.config.orderFileStorageHostname, this.config.orderArchiveHostname]
    return hosts.every(host => typeof host === 'string' && /^[a-z0-9.-]+$/u.test(host) && host !== coreHost)
      && Object.keys(this.config.orderFileAttestorKeys ?? {}).length > 0 && (this.config.orderNonFilePurposeKeys ?? []).length > 0
  }

  private async purchasedFileRuntimeEntries(workerId: string, productId?: string): Promise<{
    runtime: VerifiedPurchasedFileOrderRuntime
    source: GenericOrderSource
  }[]> {
    if (this.closed || !workerId || !['darwin', 'win32'].includes(process.platform)
      || !this.fileTransportConfigured()) return []
    const contributor = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    if (contributor?.acknowledgedWorkerId?.() !== workerId) return []
    const accountId = await this.fileAccountId()
    if (accountId === null) return []
    const token = await reviewedSeedAccount(this.ctx)?.ensureAccessToken()
    if (!token) return []
    const origin = this.config.coreOrigin ?? 'https://qianshousuanli.com'
    const owned = await listBuyerOrderAdapterEntitlements({ origin, token, workerId })
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    const entries: { runtime: VerifiedPurchasedFileOrderRuntime; source: GenericOrderSource }[] = []
    const seen = new Set<string>()
    for (const entitlement of owned.items) {
      if (productId !== undefined && entitlement.productId !== productId) continue
      if (entitlement.status !== 'installed' || !entitlement.deviceInstalled || entitlement.runtimeDigest === null) continue
      try {
        const signed = await readVerifiedOrderAdapterSource({ origin, token, productId: entitlement.productId,
          trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {} })
        if (signed.outputKind !== 'artifact_ref' || seen.has(signed.taskType)) continue
        const installed = await loadOwnedInstalledFileRuntime({ entitlement, signed, home, workerId, accountId,
          fileAttestorKeys: this.config.orderFileAttestorKeys ?? {}, nonFilePurposeKeys: this.config.orderNonFilePurposeKeys ?? [] })
        if (installed === null) continue
        seen.add(signed.taskType); entries.push(installed)
      } catch { /* A stale receipt, purpose mismatch, changed bytes or revoked ownership cannot open file intake. */ }
      if (entries.length >= 64) break
    }
    if (contributor?.acknowledgedWorkerId?.() !== workerId || await this.fileAccountId() !== accountId) return []
    return entries
  }

  /**
   * File provider requires current server installation plus separately enrolled, device-scoped file proof.
   * @param workerId - The exact worker whose device receipt and installed runtime must be rechecked.
   * @returns The currently authorized, byte-verified file runtime declarations.
   */
  async verifiedPurchasedFileOrderRuntimes(workerId: string): Promise<VerifiedPurchasedFileOrderRuntime[]> {
    return (await this.purchasedFileRuntimeEntries(workerId)).map(entry => entry.runtime)
  }

  /**
   * Run only the advertised file declaration using connection-owned lease ports and direct storage.
   * @param input - The exact advertised runtime identity and its current admitted execution request.
   * @returns The admitted file artifact produced by the exact advertised runtime.
   */
  async runPurchasedFileOrderRuntime(input: { workerId: string
    productId: string
    entitlementId: string
    taskType: string
    artifactDigest: string
    runtimeDigest: string
    contractSha256: string
    fileSchemaSha256: string
    inlineInput: string
    fileContract: EdgeFileContract
    ports: FileOrderRuntimePorts
    signal: AbortSignal }): Promise<GenericFileArtifact> {
    input.signal.throwIfAborted()
    const ownerAccountId = await this.fileAccountId()
    const assertCurrent = async (): Promise<void> => {
      const contributor = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
      if (ownerAccountId === null || await this.fileAccountId() !== ownerAccountId
        || contributor?.acknowledgedWorkerId?.() !== input.workerId) throw new CatalogFailure('order-runtime-unavailable')
      input.signal.throwIfAborted()
    }
    const selected = (await this.purchasedFileRuntimeEntries(input.workerId)).find(({ runtime }) =>
      runtime.productId === input.productId && runtime.entitlementId === input.entitlementId
      && runtime.taskType === input.taskType && runtime.artifactDigest === input.artifactDigest
      && runtime.runtimeDigest === input.runtimeDigest && runtime.contractSha256 === input.contractSha256
      && runtime.fileSchemaSha256 === input.fileSchemaSha256)
    if (selected === undefined) throw new CatalogFailure('order-runtime-unavailable')
    const contract = parseEdgeFileContract(input.fileContract, input.taskType, input.fileContract.account_id)
    const runtime = selected.runtime
    if (contract.contract_sha256 !== runtime.contractSha256 || contract.file_schema_sha256 !== runtime.fileSchemaSha256
      || Object.keys(contract.attachments).sort().join(',') !== runtime.fileSchema.inputs.map(slot => slot.name).sort().join(',')) {
      throw new CatalogFailure('order-runtime-unavailable')
    }
    await assertCurrent()
    const artifact = await executeGenericOrderFile(selected.source, Buffer.from(input.inlineInput, 'utf8'), async (slot) => {
      await assertCurrent()
      const found = await input.ports.read({ slot: slot.name, maxBytes: slot.maxBytes, contentTypes: slot.contentTypes,
        contractSha256: runtime.contractSha256, fileSchemaSha256: runtime.fileSchemaSha256,
        trustedStorageHostname: this.config.orderFileStorageHostname ?? '' }, input.signal)
      await assertCurrent(); return found
    }, async (file) => {
      await assertCurrent()
      const uploaded = await input.ports.upload({ filename: file.filename, contentType: file.contentType, bytes: file.bytes,
        contractSha256: runtime.contractSha256, fileSchemaSha256: runtime.fileSchemaSha256 }, input.signal)
      await assertCurrent(); return uploaded
    }, input.signal)
    await assertCurrent()
    return artifact
  }

  /**
   * Recheck Shanghai ownership, exact device receipt and installed bytes before each Hello.
   * @param workerId - The exact worker whose device receipt and installed runtime must be rechecked.
   * @returns The exact installed inline runtimes allowed for this worker.
   */
  async verifiedPurchasedOrderRuntimes(workerId: string): Promise<VerifiedPurchasedOrderRuntime[]> {
    return (await this.purchasedRuntimeEntries(workerId)).map(item => item.runtime)
  }

  /**
   * Legacy API stays empty: authors now require the same device-scoped receipt as buyers.
   * @param _workerId - Legacy worker identifier; it does not authorize author-only execution.
   * @returns An empty list; author approval alone grants no device execution.
   */
  async verifiedAuthorOrderRuntimes(_workerId: string): Promise<Array<{
    taskType: string
    capabilityId: string
    outputKind: 'inline_json'
    artifactDigest: string
    packageDigest: string
    contractVersion: 'v1' }>> {
    return []
  }

  /**
   * An approval alone never authorizes local execution or a worker Hello.
   * @param _input - Legacy author-only request, which is rejected without a device receipt.
   * @returns No successful result; this legacy author-only execution path rejects.
   */
  runAuthorOrderRuntime(_input: { workerId: string
    taskType: string
    artifactDigest: string
    packageDigest: string
    inlineInput: string
    signal: AbortSignal }): Promise<{ text: string }> {
    return Promise.reject(new CatalogFailure('order-runtime-unavailable'))
  }

  /**
   * Execute only the exact runtime that this worker previously advertised.
   * @param input - The exact advertised runtime identity and its current admitted execution request.
   * @returns The bounded output JSON text from the exact advertised inline runtime.
   */
  async runPurchasedOrderRuntime(input: { workerId: string
    productId: string
    entitlementId: string
    taskType: string
    artifactDigest: string
    runtimeDigest: string
    inlineInput: string
    signal: AbortSignal }): Promise<{ text: string }> {
    if (input.signal.aborted || Buffer.byteLength(input.inlineInput, 'utf8') > 16_384) {
      throw new CatalogFailure('order-runtime-unavailable')
    }
    const entries = await this.purchasedRuntimeEntries(input.workerId)
    const selected = entries.find(({ runtime }) => runtime.productId === input.productId
      && runtime.entitlementId === input.entitlementId
      && runtime.taskType === input.taskType
      && runtime.artifactDigest === input.artifactDigest
      && runtime.runtimeDigest === input.runtimeDigest)
    if (selected === undefined) throw new CatalogFailure('order-runtime-unavailable')
    const output = await runGenericOrderChallenge(selected.source,
      Buffer.from(input.inlineInput, 'utf8'), input.signal)
    return { text: JSON.stringify(output.output) }
  }
  /**
   * Task types group official and independently reviewed user offers; this is metadata, never an order.
   * @returns The current grouped task metadata, without creating an order.
   */
  @Remote
  async orderAdapterCapabilities(): Promise<{ capabilities: MarketCapability[] }> {
    if (this.closed) throw new CatalogFailure('closed')
    return listMarketCapabilities({ origin: this.config.coreOrigin ?? 'https://qianshousuanli.com' })
  }
  private orderBuyerReadiness(): { ready: boolean; reason: 'unsupported-platform' | 'configuration-missing' | 'node-offline' | null } {
    if (!['darwin', 'win32'].includes(process.platform)) return { ready: false, reason: 'unsupported-platform' }
    if (!this.config.orderArchiveHostname || !this.config.orderAttestorHostname
      || Object.keys(this.config.orderPackageIssuerKeys ?? {}).length === 0) {
      return { ready: false, reason: 'configuration-missing' }
    }
    const contributor = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    if (!contributor?.acknowledgedWorkerId?.()) return { ready: false, reason: 'node-offline' }
    return { ready: true, reason: null }
  }
  /**
   * Local readiness only. The product listing and purchase endpoint independently check live service health.
   * @returns Local readiness and its specific missing prerequisite, if any.
   */
  @Remote
  orderAdapterBuyerReadiness(): { ready: boolean
    reason: 'unsupported-platform' | 'configuration-missing' | 'node-offline' | null } {
    if (this.closed) throw new CatalogFailure('closed')
    return this.orderBuyerReadiness()
  }
  /**
   * Explicit account purchase. Its receipt proves only an account entitlement.
   * @param request - The exact product purchase explicitly confirmed by the signed-in account.
   * @returns The account purchase entitlement; device installation is separate.
   */
  @Remote
  async purchaseOrderAdapterProduct(request: { productId: string; idempotencyKey: string }): Promise<OrderAdapterEntitlement> {
    if (this.closed) throw new CatalogFailure('closed')
    // Avoid charging before this PC can enter the buyer install/challenge path.
    const readiness = this.orderBuyerReadiness()
    if (!readiness.ready) throw new CatalogFailure(readiness.reason === 'node-offline'
      ? 'order-node-contributor-unavailable' : 'order-install-not-ready')
    const origin = this.config.coreOrigin ?? 'https://qianshousuanli.com'
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    return buyOrderAdapterProduct({ origin,
      productId: request?.productId, idempotencyKey: request?.idempotencyKey, token,
      ...(process.platform === 'win32' ? { requiredRuntimeAbi: 'quickjs-wasm.v3' as const } : {}) })
  }
  /**
   * Verify the signed source inventory; archive download, device install and activation remain separate.
   * @param request - The selected product and entitlement whose signed inventory is required.
   * @returns The verified source inventory and its installation prerequisites.
   */
  @Remote
  async checkOrderAdapterInstallManifest(request: { productId: string }): Promise<OrderAdapterInstallCheck> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    return checkOrderAdapterInstallManifest({ origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
      productId: request?.productId, token, trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {} })
  }
  /**
   * Verify and quarantine reviewed source bytes. No downloaded source is executed or activated.
   * @param request - The exact product and entitlement to verify and quarantine.
   * @returns The quarantined, verified source archive; no source is executed.
   */
  @Remote
  async stageOrderAdapterProductSource(request: { productId: string }): Promise<OrderAdapterSourceStage> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    const origin = this.config.coreOrigin ?? 'https://qianshousuanli.com'
    const source = await readVerifiedOrderAdapterSource({ origin, productId: request?.productId, token,
      trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {} })
    try {
      return await stageVerifiedOrderAdapterSource(source, { home,
        trustedArchiveHostname: this.config.orderArchiveHostname ?? '' })
    } catch {
      try {
        const cancelled = await cancelPendingOrderAdapterPurchase({ origin, productId: request?.productId, token })
        if (cancelled.entitlementId !== source.check.entitlementId) {
          throw new CatalogFailure('order-install-refund-unconfirmed')
        }
      } catch { throw new CatalogFailure('order-install-refund-unconfirmed') }
      throw new CatalogFailure('order-install-refunded')
    }
  }
  /**
   * Install signed v5 source into a private runtime and run its actual examples; platform acceptance remains separate.
   * @param request - The selected signed source and entitlement for local installation.
   * @returns The locally installed runtime and actual example verification results.
   */
  @Remote
  async installOrderAdapterProductLocally(request: { productId: string }): Promise<OrderAdapterLocalInstall> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    const source = await readVerifiedOrderAdapterSource({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', productId: request?.productId,
      token, trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {},
    })
    if (source.inventoryAlgorithm === COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM) {
      throw new CatalogFailure('order-install-not-ready')
    }
    return installVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: this.config.orderArchiveHostname ?? '' })
  }
  /** Install a published Comfy product's signed metadata without installing its private executor. */
  @Remote
  async installReviewedVideoSkillMetadata(request: { productId: string }): Promise<ReviewedComfyVideoSourceInstall> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    const source = await readVerifiedOrderAdapterSource({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', productId: request?.productId,
      token, trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {},
    })
    return installReviewedComfyVideoSource(source, { home,
      trustedArchiveHostname: this.config.orderArchiveHostname ?? '' })
  }
  /**
   * One buyer click: real local install, central challenge, independent proof, then committed device receipt.
   * @param request - The purchased product and exact installation identity confirmed by the buyer.
   * @returns The committed device receipt after installation and independent proof.
   */
  @Remote
  async activatePurchasedOrderAdapter(request: { productId: string }): Promise<{
    productId: string
    deviceId: string
    runtimeDigest: string
    deviceInstalled: true
    dispatchEligible: true }> {
    if (this.closed) throw new CatalogFailure('closed')
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    const contributor = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    const workerId = contributor?.acknowledgedWorkerId?.()
    if (!workerId || !contributor?.observePurchasedOrderChallenge) {
      throw new CatalogFailure('order-node-contributor-unavailable')
    }
    const observeNodeChallenge = contributor.observePurchasedOrderChallenge.bind(contributor)
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    const origin = this.config.coreOrigin ?? 'https://qianshousuanli.com'
    const source = await readVerifiedOrderAdapterSource({
      origin, productId: request?.productId, token,
      trustedPackageIssuerKeys: this.config.orderPackageIssuerKeys ?? {},
    })
    if (source.inventoryAlgorithm === COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM) {
      throw new CatalogFailure('order-install-not-ready')
    }
    // Run the reviewed examples first. A challenge never substitutes for installation.
    await installVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: this.config.orderArchiveHostname ?? '' })
    const loaded = source.outputKind === 'artifact_ref'
      ? await loadInstalledVerifiedOrderAdapterSource(source, home) : null
    const file = loaded?.source.taskDefinition?.fileSchema !== undefined
    const accountId = file ? await this.fileAccountId() : null
    if (file && (accountId === null || !this.fileTransportConfigured())) {
      throw new CatalogFailure('order-install-not-ready')
    }
    const activated = file && accountId !== null ? await activateVerifiedFileOrderAdapter({ source, home, coreOrigin: origin, token,
      workerId, accountId, trustedArchiveHostname: this.config.orderArchiveHostname ?? '',
      trustedFileAttestorHostname: this.config.orderFileAttestorHostname ?? '',
      fileAttestorKeys: this.config.orderFileAttestorKeys ?? {}, nonFilePurposeKeys: this.config.orderNonFilePurposeKeys ?? [],
      observeNodeChallenge,
      assertCurrent: async () => {
        if (contributor.acknowledgedWorkerId?.() !== workerId || await this.fileAccountId() !== accountId) {
          throw new CatalogFailure('order-auth-required')
        }
      } }) : await activateVerifiedOrderAdapter({ source, home, coreOrigin: origin, token,
      workerId, trustedArchiveHostname: this.config.orderArchiveHostname ?? '',
      trustedAttestorHostname: this.config.orderAttestorHostname ?? '',
      observeNodeChallenge })
    await contributor?.refreshPurchasedOrderAdapters?.().catch(() => undefined)
    return activated
  }
  /**
   * Enable an author's exact published skill using the normal signed installation and device proof.
   * @param request - Controlled local skill identity selected by its owner.
   * @returns Committed device identity and the saved owner supply grant; idle admission remains separate.
   */
  @Remote
  async activateAuthorOrderSkill(request: { source: 'user-dsh' | 'user-agents'; name: string }):
  Promise<AuthorOrderSkillActivation> {
    if (this.closed) throw new CatalogFailure('closed')
    if (request === null || typeof request !== 'object'
      || Object.keys(request).sort().join(',') !== 'name,source'
      || !['user-dsh', 'user-agents'].includes(request.source)
      || typeof request.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)) {
      throw new CatalogFailure('order-draft-invalid')
    }
    const key = `${request.source}:${request.name}`
    const pending = this.authorActivations.get(key)
    if (pending) return pending
    const operation = this.enableAuthorOrderSkill(request)
    this.authorActivations.set(key, operation)
    try { return await operation }
    finally { if (this.authorActivations.get(key) === operation) this.authorActivations.delete(key) }
  }

  private async enableAuthorOrderSkill(request: { source: 'user-dsh' | 'user-agents'; name: string }):
  Promise<AuthorOrderSkillActivation> {
    const expectedOwnerId = await this.fileAccountId()
    if (expectedOwnerId === null) throw new CatalogFailure('order-auth-required')
    // This read matches the account's immutable publication to the current controlled-root digest.
    const publication = (await this.myOrderSkillPublications()).items.find(item =>
      item.source === request.source && item.name === request.name)
    if (!publication || publication.status !== 'approved' || publication.archiveStatus !== 'confirmed'
      || publication.reviewReasons.length > 0) throw new CatalogFailure('order-author-not-published')
    const native = await this.enableNativeH3AuthorOrderSkill(request, publication, expectedOwnerId)
    if (native !== null) return native
    const legacyProduct = publication.marketProductStatus === 'published' && publication.marketProductId
      ? undefined : (await this.mySellerOrderProducts()).items.find(item => item.status === 'published'
        && item.publicationId === publication.publicationId)
    const productId = publication.marketProductStatus === 'published' && publication.marketProductId
      ? publication.marketProductId : legacyProduct?.id
    if (!productId) throw new CatalogFailure('order-author-not-published')
    const contributor = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    const workerId = contributor?.acknowledgedWorkerId?.()
    if (!workerId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(workerId) || !contributor?.observePurchasedOrderChallenge
      || !contributor.refreshPurchasedOrderAdapters) throw new CatalogFailure('order-node-contributor-unavailable')
    const authority: AuthorSupplyAuthority = Object.freeze({ expectedOwnerId, assertCurrent: async () => {
      if (await this.fileAccountId() !== expectedOwnerId || contributor.acknowledgedWorkerId?.() !== workerId) {
        throw new CatalogFailure('order-auth-required')
      }
    } })
    await authority.assertCurrent()
    const session = this.ctx.get('accountSession') as { ensureAccessToken?: () => Promise<string | null> } | undefined
    const token = await session?.ensureAccessToken?.()
    if (!token) throw new CatalogFailure('order-auth-required')
    await authority.assertCurrent()
    const entitlement = await claimAuthorOrderAdapterEntitlement({
      origin: this.config.coreOrigin ?? 'https://qianshousuanli.com', token,
      productId, publicationId: publication.publicationId,
      taskType: publication.taskType, artifactDigest: publication.artifactDigest,
    })
    await authority.assertCurrent()
    if (entitlement.status === 'refunded') throw new CatalogFailure('order-author-entitlement-refunded')
    if (entitlement.status === 'unknown') throw new CatalogFailure('order-author-entitlement-unknown')
    const exactRuntime = async (): Promise<VerifiedPurchasedOrderRuntime | VerifiedPurchasedFileOrderRuntime | undefined> =>
      [...await this.purchasedRuntimeEntries(workerId, productId), ...await this.purchasedFileRuntimeEntries(workerId, productId)]
        .find(({ runtime }) =>
          runtime.productId === productId && runtime.entitlementId === entitlement.entitlementId
        && runtime.taskType === publication.taskType && runtime.artifactDigest === publication.artifactDigest)?.runtime
    let runtime = await exactRuntime()
    if (!runtime) {
      await this.activatePurchasedOrderAdapter({ productId })
      runtime = await exactRuntime()
    }
    if (!runtime || contributor.acknowledgedWorkerId?.() !== workerId) {
      throw new CatalogFailure('order-author-device-unverified')
    }
    const unchanged = (await this.myOrderSkillPublications()).items.some(item => item.source === request.source
      && item.name === request.name && item.publicationId === publication.publicationId
      && item.status === 'approved' && item.taskType === publication.taskType
      && item.artifactDigest === publication.artifactDigest && item.archiveStatus === 'confirmed'
      && item.reviewReasons.length === 0)
    if (!unchanged) throw new CatalogFailure('order-author-source-changed')
    await authority.assertCurrent()
    // The explicit enable action authorizes the existing master switch and node grant.
    // Only reach these writes after an installed receipt and verified local bytes exist.
    const current = await this.orderFacts()
    if (!current) throw new CatalogFailure('supply-unavailable')
    await authority.assertCurrent()
    if (current.mode === 'off') await this.writeOwnerSupplyEnabled({ enabled: true }, authority)
    await this.writeLocalServiceEnabled({ serviceId: 'node', enabled: true }, authority)
    await contributor.refreshPurchasedOrderAdapters()
    const [order, confirmed] = await Promise.all([this.orderFacts(), exactRuntime()])
    await authority.assertCurrent()
    if (!confirmed || !order || order.mode === 'off' || !order.enabledServiceIds?.includes('node')
      || contributor.acknowledgedWorkerId?.() !== workerId) throw new CatalogFailure('order-author-device-unverified')
    return { ...request, publicationId: publication.publicationId, productId: confirmed.productId,
      deviceId: workerId, runtimeDigest: confirmed.runtimeDigest,
      deviceInstalled: true, dispatchEligible: true, order }
  }
  /** Explicit native author activation: device samples and current presence precede supply writes. */
  private async enableNativeH3AuthorOrderSkill(request: { source: 'user-dsh' | 'user-agents'; name: string },
    publication: MyOrderSkillPublication, ownerId: number): Promise<AuthorOrderSkillActivation | null> {
    const importer = this.ctx.get('qianshouSkillImport') as OrderSkillInventoryPort | undefined
    const skill = (await importer?.listLocal())?.skills.find(item => item.source === request.source && item.name === request.name)
    if (skill?.path === undefined) return null
    const skillPath = skill.path
    let source: Awaited<ReturnType<typeof readNativeH3OrderSource>>
    try { source = await readNativeH3OrderSource(skillPath) }
    catch {
      if (publication.runtimeKind === 'native-h3') throw new CatalogFailure('order-author-source-changed')
      return null /* Ordinary installed adapters retain their existing activation path. */
    }
    if (source.declaration.taskType !== publication.taskType || `sha256:${source.digest}` !== publication.artifactDigest) {
      throw new CatalogFailure('order-author-source-changed')
    }
    const node = this.ctx.get('nodeContributor') as NativeH3PresenceNodePort & ArtifactContributor | undefined
    const workerId = node?.acknowledgedWorkerId?.()
    const connectionId = node?.acknowledgedConnectionId?.()
    const observe = node?.observeNativeH3DeviceKeyProof?.bind(node)
    const validate = node?.validateNativeH3PresenceChallenge?.bind(node)
    const observePresence = node?.observeNativeH3DevicePresence?.bind(node)
    const selectBinding = node?.selectNativeH3AuthorBinding?.bind(node)
    if (!workerId || !connectionId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(workerId)
      || observe === undefined || validate === undefined || observePresence === undefined
      || selectBinding === undefined || node?.refreshNativeH3OrderAdapters === undefined) {
      throw new CatalogFailure('order-node-contributor-unavailable')
    }
    const profileDir = (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir
    const token = await reviewedSeedAccount(this.ctx)?.ensureAccessToken()
    if (typeof profileDir !== 'string' || !token) throw new CatalogFailure('order-auth-required')
    const definition = source.files.find(file => file.path === 'task-definition.json')
    if (definition === undefined) throw new CatalogFailure('order-local-verification-failed')
    let selection: NativeH3PresenceSelection = { declaration: source.declaration, sourceDigest: publication.artifactDigest,
      taskDefinitionSha256: `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}` }
    const assertCurrent = async (): Promise<void> => {
      if (this.closed || await this.fileAccountId() !== ownerId || node.acknowledgedWorkerId?.() !== workerId
        || node.acknowledgedConnectionId?.() !== connectionId
        || (this.ctx.get('profileContext') as { dir?: unknown } | undefined)?.dir !== profileDir
        || await reviewedSeedAccount(this.ctx)?.ensureAccessToken() !== token) throw new CatalogFailure('order-auth-required')
      if ((await readNativeH3OrderSource(skillPath)).digest !== source.digest) {
        throw new CatalogFailure('order-author-source-changed')
      }
    }
    const select = async (): Promise<void> => {
      await assertCurrent()
      let actual: Awaited<ReturnType<typeof selectBinding>>
      try { actual = await selectBinding(selection) }
      catch { throw new CatalogFailure('order-local-verification-failed') }
      await assertCurrent()
      if (actual.taskType !== selection.declaration.taskType || actual.artifactDigest !== selection.sourceDigest
        || actual.packageDigest !== nativeH3PublicBindingDigest(selection.declaration) || !actual.localVerified
        || actual.inventoryAlgorithm !== 'qianshou.native-binding-package.v1') {
        throw new CatalogFailure('order-local-verification-failed')
      }
    }
    const exactBinding = async (): Promise<NativeH3CatalogBinding | undefined> => {
      await assertCurrent()
      const result = (await this.verifiedNativeH3OrderBindings(workerId)).find(binding =>
        binding.publicationId === publication.publicationId && binding.sourceDigest === selection.sourceDigest
        && binding.taskDefinitionSha256 === selection.taskDefinitionSha256
        && binding.declaration.taskType === source.declaration.taskType
        && nativeH3PublicBindingDigest(binding.declaration) === nativeH3PublicBindingDigest(source.declaration)
        && binding.declaration.executionRecipeSha256 === source.declaration.executionRecipeSha256
        && binding.declaration.modelSha256 === source.declaration.modelSha256
        && isVerifiedAnyNativeH3DeviceProof(binding.deviceProof, nativeH3ExpectedDeviceTuple(source.declaration,
          { publicationId: publication.publicationId, ownerId, deviceId: workerId,
            contractSha256: binding.contractSha256, sourceDigest: selection.sourceDigest },
          selection.localOwnerConfigDigest !== undefined && selection.deviceBindingRevision !== undefined
            ? { localOwnerConfigDigest: selection.localOwnerConfigDigest,
              deviceBindingRevision: selection.deviceBindingRevision } : undefined), Math.floor(Date.now() / 1000)))
      await assertCurrent()
      return result
    }
    await select()
    if (selection.declaration.contractVersion === 'v2') {
      const control: NativeH3ReviewControl = { origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
        token, ownerId, workerId, profileDir, signal: new AbortController().signal, assertCurrent, observeDeviceKey: observe }
      const keys = await this.nativeH3PurposeKeys(control)
      const signer = await enrollNativeH3DeviceKey(control)
      selection = await this.nativeH3ConfigHead(control, node, selection, publication.publicationId, connectionId, { signer, keys })
    }
    const assertBindingCurrent = async (): Promise<void> => {
      await assertCurrent()
      if (selection.declaration.contractVersion === 'v2') {
        const control: NativeH3ReviewControl = { origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
          token, ownerId, workerId, profileDir, signal: new AbortController().signal, assertCurrent, observeDeviceKey: observe }
        await this.nativeH3ConfigHead(control, node, selection, publication.publicationId, connectionId)
      }
    }
    await assertBindingCurrent()
    let binding = await exactBinding()
    if (binding === undefined) {
      const control: NativeH3ReviewControl = { origin: this.config.coreOrigin ?? 'https://qianshousuanli.com',
        token, ownerId, workerId, profileDir, signal: new AbortController().signal, assertCurrent: assertBindingCurrent,
        observeDeviceKey: observe }
      const keys = await this.nativeH3PurposeKeys(control)
      const signer = await enrollNativeH3DeviceKey(control)
      let deviceNeverStarted = false
      const canStartDeviceSamples = (): boolean => deviceNeverStarted
      // Only the authenticated server's narrowly defined absence response authorizes initial GPU samples.
      // A network failure, expired/unknown sample, stale key or ordinary conflict never does.
      const controlledFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init)
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (response.status === 409 && url.origin === new URL(control.origin).origin
          && url.pathname === `/api/v8/task-adapter-publications/${publication.publicationId}/native-device-presence/challenge`) {
          const reader = response.body?.getReader()
          if (reader !== undefined) {
            let size = 0
            const chunks: Uint8Array[] = []
            try {
              for (;;) {
                const next = await reader.read()
                if (next.done) break
                size += next.value.byteLength
                if (size > 4096) break
                chunks.push(next.value)
              }
              if (size <= 4096) {
                const row: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                if (row !== null && typeof row === 'object' && !Array.isArray(row)
                  && Object.keys(row).join(',') === 'detail') {
                  const detail = (row as { detail?: unknown }).detail
                  deviceNeverStarted = detail !== null && typeof detail === 'object' && !Array.isArray(detail)
                    && Object.keys(detail).sort().join(',') === 'code,message'
                    && (detail as { code?: unknown }).code === 'NATIVE_H3_DEVICE_SAMPLE_MISSING'
                    && (detail as { message?: unknown }).message === '当前设备尚未启动独立双样例，请明确启用后运行'
                }
              }
            } catch { /* Malformed server errors cannot authorize GPU execution. */ }
            finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
          }
          return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
        return response
      }
      try {
        await renewNativeH3DevicePresence({ ...control, fetch: controlledFetch, signer, selection,
          publicationId: publication.publicationId, connectionId, challengeKeys: keys.challenge,
          attestorKeys: keys.attestor, validate, observePresence })
      } catch (error) {
        await assertCurrent()
        if (!canStartDeviceSamples()) throw error
        const key = `${ownerId}\0${publication.publicationId}`
        const previous = this.nativeReviewTasks.get(key)
        if (previous !== undefined && previous.status !== 'evidence_deposited') {
          throw new CatalogFailure('order-review-samples-not-ready')
        }
        // A completed different-device run cannot hide the server-confirmed absence on this physical device.
        if (previous !== undefined) this.nativeReviewTasks.delete(key)
        const before = new Set(this.pending)
        const queued = await this.queueNativeH3Review(skillPath, publication.publicationId, ownerId)
        if (queued.reviewSampleError !== undefined) throw new CatalogFailure(queued.reviewSampleError)
        const tasks = [...this.pending].filter(task => !before.has(task))
        if (tasks.length === 1) await tasks[0]?.done
        else if (tasks.length !== 0 || this.nativeReviewTasks.get(key)?.status !== 'evidence_deposited') {
          throw new CatalogFailure('order-review-samples-not-ready')
        }
        await assertCurrent()
        const state = this.nativeReviewTasks.get(key)
        if (state?.status !== 'evidence_deposited') {
          throw new CatalogFailure(state?.error ?? 'order-review-samples-not-ready')
        }
      }
      binding = await exactBinding()
    }
    if (binding === undefined) throw new CatalogFailure('order-author-device-unverified')
    await select()
    const unchanged = (await this.myOrderSkillPublications()).items.some(item => item.source === request.source
      && item.name === request.name && item.publicationId === publication.publicationId && item.status === 'approved'
      && item.taskType === publication.taskType && item.artifactDigest === publication.artifactDigest
      && item.archiveStatus === 'confirmed' && item.reviewReasons.length === 0
      && item.lifecycle?.archived !== true && (item.lifecycle === undefined || item.lifecycle.state === 'active'))
    if (!unchanged) throw new CatalogFailure('order-author-source-changed')
    await assertCurrent()
    const authority: AuthorSupplyAuthority = Object.freeze({ expectedOwnerId: ownerId, assertCurrent: assertBindingCurrent })
    const current = await this.orderFacts()
    if (!current) throw new CatalogFailure('supply-unavailable')
    if (current.mode === 'off') await this.writeOwnerSupplyEnabled({ enabled: true }, authority)
    await this.writeLocalServiceEnabled({ serviceId: 'node', enabled: true }, authority)
    await assertBindingCurrent()
    await node.refreshNativeH3OrderAdapters()
    const [order, confirmed] = await Promise.all([this.orderFacts(), exactBinding()])
    await select()
    const ready = await node.nativeH3OrderAdapterReady?.(source.declaration.taskType) === true
    await assertCurrent()
    if (!confirmed || !ready || !order || order.mode === 'off' || !order.enabledServiceIds?.includes('node')) {
      throw new CatalogFailure('order-author-device-unverified')
    }
    return { ...request, runtimeKind: 'native-h3', publicationId: publication.publicationId, deviceId: workerId,
      runtimeDigest: nativeH3PublicBindingDigest(confirmed.declaration), deviceVerified: true, dispatchEligible: true, order }
  }
  /**
   * Query public metadata only after an owner opens discovery or submits a search.
   * @param query - Search terms and bounded page offset.
   * @returns Real bundle declarations, source and partial-failure counts.
   */
  @Remote
  async search(query: CatalogQuery): Promise<CatalogPage> {
    const parsed = parseQuery(query)
    if (this.closed) throw new CatalogFailure('closed')
    if (this.pending.size >= 2) throw new CatalogFailure('busy')
    const abort = new AbortController(); const timeout = setTimeout(() => { abort.abort() }, this.config.timeoutMs)
    timeout.unref()
    const done = searchRegistry(this.source, parsed, abort.signal)
    const task = { abort, done }; this.pending.add(task)
    try { return await done } catch (error) { throw error instanceof CatalogFailure ? error : new CatalogFailure('unavailable') }
    finally { clearTimeout(timeout); this.pending.delete(task) }
  }
  /**
   * List the market for the PC client. Shipped mode does not use the network.
   * @returns Presented listings. A capability this node cannot accept is not installable.
   */
  @Remote
  async listings(): Promise<MarketCatalog> {
    if (this.closed) throw new CatalogFailure('closed')
    const base = this.apiBase
    if (base === null) return marketCatalog('shipped', 'shipped', shippedListings())
    const listings = await this.withNetwork(signal => fetchMarketListings(base, signal))
    const catalog = marketCatalog('api', base.origin, listings)
    catalog.releaseSource = new URL('/qianshou-market/releases', base).href
    try {
      // A missing, slow or untrusted release endpoint must not break the existing /plugins catalog.
      catalog.releases = await this.withNetwork(signal => fetchReleasePreviews(base,
        AbortSignal.any([signal, AbortSignal.timeout(Math.min(this.config.timeoutMs, 3000))]),
        this.config.publisherKeys, this.config.operatorKeys ?? {}))
      catalog.releaseStatus = 'available'
    } catch {
      catalog.releaseStatus = 'unavailable'
    }
    return catalog
  }
  /**
   * Surface only bundled, reviewed private starter paths; neither is an online product or order capability.
   * @returns Only the reviewed bundled starter locations available on this Host.
   */
  @Remote
  async reviewedLocalStarters(): Promise<ReviewedLocalStarters> {
    if (this.closed) throw new CatalogFailure('closed')
    const items: ReviewedLocalStarter[] = []
    const factory = this.ctx.get('macDrawnVideoFactory') as { available: boolean } | undefined
    if (platform() !== 'darwin') items.push({ kind: 'mac-drawn-video', phase: 'unavailable', reason: 'mac-only' })
    else if (factory?.available !== true) items.push({
      kind: 'mac-drawn-video', phase: 'unavailable', reason: 'drawing-unavailable',
    })
    else items.push({ kind: 'mac-drawn-video',
      phase: (await this.privateLocalCapabilities()).some(row => row.kind === 'reviewed-private-mac-video')
        ? 'installed' : 'available' })

    const bundled = fileURLToPath(new URL('../seed/csv-profile/qianshou.csv-profile-1.0.0.qspkg', import.meta.url))
    try {
      const stat = await lstat(bundled)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== CSV_SEED_IDENTITY.packageBytes) {
        throw new Error('QIANSHOU_CSV_STARTER_INVALID')
      }
      const digest = createHash('sha256').update(await readFile(bundled)).digest('hex')
      if (digest !== CSV_SEED_IDENTITY.packageSha256) throw new Error('QIANSHOU_CSV_STARTER_INVALID')
    }
    catch {
      items.push({ kind: 'csv-profile', phase: 'unavailable', reason: 'package-unavailable' })
      return { items }
    }
    const privateDir = join(this.offlineCsvSeedHome(), 'qianshou', 'private-seed-csv')
    const receipt = join(privateDir, `${CSV_SEED_IDENTITY.pluginId}-${CSV_SEED_IDENTITY.version}.json`)
    try {
      await lstat(receipt)
      try {
        await verifyPrivateOfficialCsvSeedInstallation(privateDir, new AbortController().signal)
        items.push({ kind: 'csv-profile', phase: 'installed' })
      } catch {
        items.push({ kind: 'csv-profile', phase: 'unavailable', reason: 'installation-needs-repair' })
      }
    } catch (error) {
      items.push((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'csv-profile', phase: 'available' }
        : { kind: 'csv-profile', phase: 'unavailable', reason: 'package-unavailable' })
    }
    return { items }
  }
  /**
   * Read only live generic private activations. These are not Guangzhou listings or Shanghai supply.
   * @returns The current live private plugin activations, separate from market supply.
   */
  @Remote
  async privatePluginActivations(): Promise<PrivatePluginActivations> {
    if (this.closed) throw new CatalogFailure('closed')
    const compute = (this.ctx as AccountHostContext).get('computeCore', false) as {
      listPrivatePluginActivations?: () => Promise<readonly PrivatePluginActivationView[]>
    } | undefined
    if (compute?.listPrivatePluginActivations === undefined) return { status: 'not-supported', records: [] }
    const records = await compute.listPrivatePluginActivations()
    if (this.closed) throw new CatalogFailure('closed')
    return { status: 'available', records }
  }
  /** Operator origin and publisher candidates stay Host configured; absence never enables upload. */
  private privateSubmissionConfig(): { apiBaseUrl: string
    timeoutMs: number
    publisherIds: readonly string[]
    account: ReviewedSeedAccountCarrier } {
    if (this.closed || this.config.connection !== 'api' || this.apiBase === null
      || Object.keys(this.config.publisherKeys).length === 0) {
      throw new Error('QIANSHOU_MARKET_NOT_CONFIGURED')
    }
    const account = reviewedSeedAccount(this.ctx)
    if (account === null) throw new Error('QIANSHOU_ACCOUNT_REQUIRED')
    return { apiBaseUrl: this.apiBase.href, timeoutMs: this.config.timeoutMs,
      publisherIds: Object.keys(this.config.publisherKeys).sort(), account }
  }
  private async privateSubmissionAccountId(account: ReviewedSeedAccountCarrier): Promise<string> {
    const state = await account.snapshot().catch(() => null)
    const id = state?.account?.id
    if ((state?.phase !== 'authenticated' && state?.phase !== 'refreshing')
      || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(id)) {
      throw new Error('QIANSHOU_ACCOUNT_REQUIRED')
    }
    return id
  }
  private privateSubmissionCompute(): {
    preparePrivatePluginSubmission(input: PrivatePluginSubmissionPrepareRequest & {
      readonly signal: AbortSignal }): Promise<PreparedPrivatePluginSubmission>
  } {
    const compute = (this.ctx as AccountHostContext).get('computeCore', false) as {
      preparePrivatePluginSubmission?: (input: PrivatePluginSubmissionPrepareRequest & {
        readonly signal: AbortSignal }) => Promise<PreparedPrivatePluginSubmission>
    } | undefined
    const prepare = compute?.preparePrivatePluginSubmission
    if (typeof prepare !== 'function') {
      throw new Error('QIANSHOU_PRIVATE_PLUGIN_PREPARATION_UNAVAILABLE')
    }
    return { preparePrivatePluginSubmission: input => prepare.call(compute, input) }
  }
  private privateSubmissionPreview(prepared: PreparedPrivatePluginSubmission,
    accountId: string, publisherIds: readonly string[]): PrivatePluginSubmissionPreview {
    const { preview } = prepared
    return { accountId, publisherIds, pluginId: preview.manifest.pluginId,
      version: preview.manifest.version, packageSha256: preview.packageSha256,
      packageBytes: preview.packageBytes,
      sourcePrivatePackageSha256: preview.sourcePrivatePackageSha256,
      sourceCandidateSha256: preview.sourceCandidateSha256,
      operations: preview.manifest.operations.map(operation => ({
        operationId: operation.operationId, capabilityId: operation.capabilityId,
        executorKind: operation.executorKind, permissions: operation.permissions,
        inputSchemaSha256: operation.inputSchemaSha256,
        outputSchemaSha256: operation.outputSchemaSha256,
      })) }
  }
  private async preparePrivateSubmission(compute: ReturnType<QianshouPluginCatalog['privateSubmissionCompute']>,
    request: PrivatePluginSubmissionPrepareRequest, signal: AbortSignal):
  Promise<PreparedPrivatePluginSubmission> {
    try { return await compute.preparePrivatePluginSubmission({ ...request, signal }) }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'COMPUTE_PLUGIN_DECLARATION_INVALID') {
        throw new Error('QIANSHOU_PLUGIN_DECLARATION_INVALID')
      }
      if (message.startsWith('COMPUTE_PRIVATE_PLUGIN_') || message.startsWith('COMPUTE_PLUGIN_DRAFT_')) {
        throw new Error('QIANSHOU_PLUGIN_SUBMISSION_STALE')
      }
      throw error
    }
  }
  /**
   * Show the exact redacted declaration and account. The package bytes never cross Remote.
   * @param request - The local candidate identity whose declaration will be shown.
   * @returns The redacted declaration and captured account for confirmation.
   */
  @Remote
  async previewPrivatePluginSubmission(request: PrivatePluginSubmissionPrepareRequest):
  Promise<PrivatePluginSubmissionPreview> {
    const configured = this.privateSubmissionConfig()
    const accountId = await this.privateSubmissionAccountId(configured.account)
    const compute = this.privateSubmissionCompute()
    return this.withNetwork(async (signal) => {
      const prepared = await this.preparePrivateSubmission(compute, request, signal)
      if (await this.privateSubmissionAccountId(configured.account) !== accountId) {
        throw new Error('QIANSHOU_PLUGIN_SUBMISSION_ACCOUNT_CHANGED')
      }
      return this.privateSubmissionPreview(prepared, accountId, configured.publisherIds)
    })
  }
  /**
   * Recreate the package and bind the one-click confirmation to its SHA and account before one POST.
   * @param request - The exact package digest and account captured by the prior confirmation.
   * @returns The account-bound platform receipt for the exact confirmed package.
   */
  @Remote
  async submitPrivatePluginSubmission(request: PrivatePluginSubmissionConfirmRequest):
  Promise<PrivatePluginSubmissionResult> {
    const configured = this.privateSubmissionConfig()
    const accountId = await this.privateSubmissionAccountId(configured.account)
    if (request.approvedAccountId !== accountId
      || !configured.publisherIds.includes(request.publisherId)) {
      throw new Error('QIANSHOU_PLUGIN_SUBMISSION_CONFIRMATION_INVALID')
    }
    const compute = this.privateSubmissionCompute()
    return this.withNetwork(async (signal) => {
      const prepared = await this.preparePrivateSubmission(compute, request, signal)
      if (prepared.preview.packageSha256 !== request.approvedPackageSha256
        || prepared.preview.sourcePrivatePackageSha256 !== request.packageSha256
        || prepared.preview.sourceCandidateSha256 !== request.candidateSha256) {
        throw new Error('QIANSHOU_PLUGIN_SUBMISSION_CONFIRMATION_INVALID')
      }
      return submitPrivatePluginDeclaration({ apiBaseUrl: configured.apiBaseUrl,
        timeoutMs: configured.timeoutMs, account: configured.account, signal,
        publisherId: request.publisherId, title: request.title, summary: request.summary,
        archiveBytes: prepared.archive, approvedAccountId: accountId,
        approvedPackageSha256: request.approvedPackageSha256 })
    })
  }
  /**
   * Read only the current signed-in owner's submission status; no releases or sales are inferred.
   * @returns The current owner's real submission records and read status.
   */
  @Remote
  async myPrivatePluginSubmissions(): Promise<MyPrivatePluginSubmissionsView> {
    const configured = this.privateSubmissionConfig()
    await this.privateSubmissionAccountId(configured.account)
    return this.withNetwork(async (signal) => {
      const result = await listMyPrivatePluginSubmissions({ apiBaseUrl: configured.apiBaseUrl,
        timeoutMs: configured.timeoutMs, account: configured.account, signal,
        operatorKeys: this.config.operatorKeys ?? {}, publisherKeys: this.config.publisherKeys })
      return { status: 'available', records: result.submissions }
    })
  }
  /**
   * Read declarations already saved on this computer.
   * @returns The declaration file. A missing file is an empty list.
   */
  @Remote
  installed(): Promise<MarketInstalled> {
    if (this.closed) throw new CatalogFailure('closed')
    return Promise.resolve({ records: readMarketInstallFile(this.declarationPath()) })
  }
  /**
   * Read the current Host activity for saved rows without modifying the owner's drafts.
   * @returns The current Host installation activity for saved plugin rows.
   */
  @Remote
  async installationActivity(): Promise<MarketInstallActivities> {
    if (this.closed) throw new CatalogFailure('closed')
    const rows = readMarketInstallFile(this.declarationPath())
    return { records: await Promise.all(rows.map(async record =>
      ({ id: record.id, capabilityId: record.capabilityId, version: record.version,
        packageSpec: record.packageSpec ?? (this.isLegacyArticle(record) ? '' : null),
        state: await this.recordActivity(record) }))) }
  }
  /**
   * Read 我的能力: saved declarations plus any verified active private Mac video package.
   * Reading writes nothing and contacts neither Shanghai nor an invite endpoint.
   * @returns Local capabilities, the publish wizard's steps, and this computer's order policy.
   */
  @Remote
  async myCapabilities(): Promise<MyCapabilities> {
    if (this.closed) throw new CatalogFailure('closed')
    const rows = readMarketInstallFile(this.declarationPath())
    const activities = await Promise.all(rows.map(record => this.recordActivity(record)))
    // Saved rows remain visible if the catalog cannot be read, but an unknown listing cannot
    // establish its signed identity or current package readiness.
    const listed = await this.listings().catch((): MarketCatalog | null => null)
    const freeDisk = freeDiskBytes(dirname(this.declarationPath()))
    const totalMemory = totalmem()
    return {
      capabilities: rows.map((record, index) => {
        const listing = listed?.listings.find(item => item.id === record.id)
        const activity = activities[index] ?? 'unknown'
        return {
          record,
          title: listing?.title ?? record.id,
          summary: listing?.summary ?? '',
          advertisable: activity === 'active' && listing !== undefined && listing.packageSpec === '' && listingMayInstall(listing)
            && listing.version === record.version && listing.capabilityId === record.capabilityId,
          activity,
          metrics: unmeasuredCapabilityMetrics(),
          freeDiskBytes: freeDisk,
          totalMemoryBytes: totalMemory,
        }
      }),
      privateLocalCapabilities: await this.privateLocalCapabilities(),
      wizardSteps: [...CAPABILITY_WIZARD_STEP_IDS],
      order: await this.orderFacts(),
    }
  }
  /** Read only the saved owner intake policy. Market discovery must not delay this safety-critical status. */
  @Remote
  async myOrderPolicy(): Promise<CapabilityOrderFacts | null> {
    if (this.closed) throw new CatalogFailure('closed')
    return this.orderFacts()
  }
  /**
   * Read active user plugins for a conversation without querying account, market or device purchase records.
   * @returns The active local conversation plugins with their display names and descriptions.
   */
  @Remote
  async conversationPlugins(): Promise<{ id: string; title: string; description: string }[]> {
    const manager = this.ctx.get('pluginManager') as OrderPluginInventoryPort | undefined
    if (this.closed) throw new CatalogFailure('closed')
    if (manager === undefined) throw new CatalogFailure('unavailable')
    const [bundles, entries] = await Promise.all([manager.listBundles(), manager.listPlugins()])
    if (this.closed) throw new CatalogFailure('closed')
    return bundles.filter(bundle => bundle.installed && bundle.removable && bundle.enabled
      && bundle.error === undefined && bundle.rows.length > 0
      && bundle.rows.every(row => entries.some(entry => entry.entryId === row.entryId
        && entry.moduleName === row.moduleName && entry.enabled && entry.fiberPhase === 'active')))
      .slice(0, MAX_ORDER_SOURCES).map(bundle => ({
        id: `bundle:${encodeURIComponent(bundle.name)}`,
        title: bundle.displayName?.trim() || bundle.name,
        description: bundle.description?.slice(0, 1024) ?? '',
      }))
  }

  /**
   * Enumerate real local installations; only a selected, self-tested task adapter may be authorized.
   * @returns Local installations, selected adapter, and current owner supply facts.
   */
  @Remote
  async orderSources(): Promise<OrderSources> {
    if (this.closed) throw new CatalogFailure('closed')
    let publicationAccountId: number | null = null
    try { publicationAccountId = await this.fileAccountId() } catch { /* Account identity remains unconfirmed. */ }
    const manager = this.ctx.get('pluginManager') as OrderPluginInventoryPort | undefined
    const skillImport = this.ctx.get('qianshouSkillImport') as OrderSkillInventoryPort | undefined
    const node = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
    const order = await this.orderFacts()
    let complete = order !== null
    let bundles: Awaited<ReturnType<OrderPluginInventoryPort['listBundles']>> = []
    let entries: Awaited<ReturnType<OrderPluginInventoryPort['listPlugins']>> = []
    let skills: Awaited<ReturnType<OrderSkillInventoryPort['listLocal']>>['skills'] = []
    const observations = await Promise.allSettled([
      manager?.listBundles(), manager?.listPlugins(), skillImport?.listLocal(),
    ])
    if (observations[0]?.status === 'fulfilled' && observations[0].value !== undefined) bundles = observations[0].value
    else complete = false
    if (observations[1]?.status === 'fulfilled' && observations[1].value !== undefined) entries = observations[1].value
    else complete = false
    if (observations[2]?.status === 'fulfilled' && observations[2].value !== undefined) skills = observations[2].value.skills
    else complete = false
    let selected: ReturnType<NonNullable<NodeIntakePort['orderExecutor']>> | null = null
    try { selected = node?.orderExecutor?.() ?? null } catch { /* No verified selection. */ }
    if (selected === null || selected.kind === 'unavailable') complete = false
    // Inventory must not invoke installed code. Selection and grant run their own
    // bounded samples; this read uses only the most recent proof and live static checks.
    let runnable = false
    try { runnable = node?.orderExecutorVerified?.() === true } catch { /* Fail closed. */ }
    const ownerEnabled = order?.enabledServiceIds?.includes('node') === true
    const sources: OrderSourceItem[] = []
    const builtinSelected = selected?.kind === 'builtin'
    sources.push({ id: 'builtin:word_count', kind: 'builtin', source: 'builtin', title: '本机词频统计',
      description: '按词统计次数，输出平台可合并的词频结果。', category: 'text',
      loadState: node === undefined ? 'unknown' : 'active',
      capabilityId: builtinSelected ? 'text.transform' : null, taskType: builtinSelected ? 'word_count' : null,
      serviceId: builtinSelected ? 'node' : null, selectable: !builtinSelected && node?.selectOrderExecutor !== undefined,
      eligible: builtinSelected && runnable,
      enabled: builtinSelected && ownerEnabled,
      reason: builtinSelected ? runnable ? 'ready' : 'executor-unverified' : 'not-selected' })
    for (const bundle of bundles) {
      const chosen = selected?.kind === 'plugin' && selected.packageName === bundle.name
      // Shipped Host composition rows are not user installations. A bare Loader
      // entry has no reliable ownership field and is intentionally omitted.
      if (!chosen && (!bundle.installed || !bundle.removable)) continue
      const active = bundle.enabled && bundle.error === undefined && bundle.rows.length > 0
        && bundle.rows.every(row => entries.some(entry => entry.entryId === row.entryId
          && entry.moduleName === row.moduleName && entry.enabled && entry.fiberPhase === 'active'))
      const loadState: OrderSourceItem['loadState'] = bundle.error !== undefined ? 'failed'
        : !bundle.enabled ? 'disabled' : active ? 'active' : 'unknown'
      let contract: { taskType: string; capabilityId: string } | null = null
      if (active) {
        try {
          if (node?.orderBundleContract !== undefined) contract = await node.orderBundleContract(bundle.name)
          else if (await node?.canSelectOrderBundle?.(bundle.name) === true) {
            // The older node API only accepted the word_count landing.
            contract = { taskType: 'word_count', capabilityId: 'text.transform' }
          }
        }
        catch { /* An unverified bundle never becomes selectable. */ }
      }
      const adapter = contract !== null
      sources.push({ id: `bundle:${encodeURIComponent(bundle.name)}`, kind: 'plugin', source: 'profile-bundle',
        title: bundle.displayName?.trim() || bundle.name, description: bundle.description?.slice(0, 1024) ?? '',
        category: adapter ? 'text' : null,
        loadState, capabilityId: contract?.capabilityId ?? (chosen ? 'text.transform' : null),
        taskType: contract?.taskType ?? (selected?.kind === 'plugin' && chosen
          ? selected.taskType ?? 'word_count' : null),
        serviceId: chosen ? 'node' : null, selectable: !chosen && adapter && node?.selectOrderExecutor !== undefined,
        eligible: chosen && adapter && runnable,
        enabled: chosen && ownerEnabled,
        reason: chosen ? !active ? 'not-active' : runnable && adapter ? 'ready' : 'executor-unverified'
          : adapter ? 'not-selected' : active ? 'platform-task-unmapped' : 'not-active' })
    }
    if (selected?.kind === 'plugin' && !bundles.some(bundle => bundle.name === selected.packageName)) {
      sources.push({ id: `bundle:${encodeURIComponent(selected.packageName)}`, kind: 'plugin', source: 'profile-bundle',
        title: selected.packageName, description: '', category: null, loadState: 'failed',
        capabilityId: 'text.transform', taskType: selected.taskType ?? 'word_count', serviceId: 'node', selectable: false, eligible: false,
        enabled: ownerEnabled, reason: 'not-active' })
    }
    let publications: MyOrderSkillPublication[] = []
    try { publications = (await this.myOrderSkillPublications()).items }
    catch { complete = false /* An unavailable account never invents a publication state. */ }
    let sellerProducts: SellerOrderProduct[] = []
    let sellerProductsAvailable = true
    let installed: (VerifiedPurchasedOrderRuntime | VerifiedPurchasedFileOrderRuntime)[] = []
    const workerId = node?.acknowledgedWorkerId?.()
    const connectionId = node?.acknowledgedConnectionId?.()
    let nativeBindings: NativeH3CatalogBinding[] = []
    // These are independent, read-only authorities. Wait for all observations and retain
    // the same fail-closed result if any one cannot be checked. No cache grants eligibility.
    const needsSeller = publications.some(item => item.runtimeKind !== 'native-h3' && item.status === 'approved'
      && item.marketProductStatus !== 'published')
    const hasNativePublication = publications.some(item => item.runtimeKind === 'native-h3')
    const [sellerRead, nativeRead, runtimeRead, fileRuntimeRead] = await Promise.allSettled([
      needsSeller ? this.mySellerOrderProducts() : Promise.resolve({ items: [] }),
      workerId && connectionId && publicationAccountId !== null && hasNativePublication
        ? this.readNativeH3BindingsForInventory(publicationAccountId, workerId, connectionId)
        : Promise.resolve([] as NativeH3CatalogBinding[]),
      workerId ? this.verifiedPurchasedOrderRuntimes(workerId) : Promise.resolve([] as VerifiedPurchasedOrderRuntime[]),
      workerId ? this.verifiedPurchasedFileOrderRuntimes(workerId) : Promise.resolve([] as VerifiedPurchasedFileOrderRuntime[]),
    ])
    if (sellerRead.status === 'fulfilled') sellerProducts = sellerRead.value.items
    else { complete = false; sellerProductsAvailable = false }
    if (nativeRead.status === 'fulfilled') nativeBindings = nativeRead.value
    else complete = false /* Inventory never creates a review, trial, presence nonce or grant. */
    if (runtimeRead.status === 'fulfilled' && fileRuntimeRead.status === 'fulfilled') {
      installed = [...runtimeRead.value, ...fileRuntimeRead.value]
      if (this.closed || workerId && node?.acknowledgedWorkerId?.() !== workerId) { installed = []; complete = false }
    } else complete = false
    for (const skill of skills) {
      let identity: Awaited<ReturnType<typeof identifyRegisteredOrderAdapter>> | null = null
      if (typeof skill.path === 'string') {
        try { identity = await identifyRegisteredOrderAdapter(skill.path) }
        catch { /* A method-only skill remains usable in conversations. */ }
      }
      const publication = publications.find(item => item.source === skill.source && item.name === skill.name
        && item.artifactDigest === identity?.artifactDigest)
      const sellerProduct = publication === undefined ? undefined
        : sellerProducts.find(item => item.publicationId === publication.publicationId)
      const listingStatus = publication?.marketProductStatus ?? sellerProduct?.status
        ?? (sellerProductsAvailable ? 'not-listed' : 'unavailable')
      const authorProductId = publication?.status === 'approved'
        && publication.archiveStatus === 'confirmed' && publication.reviewReasons.length === 0
        ? publication.marketProductStatus === 'published' && typeof publication.marketProductId === 'string'
          ? publication.marketProductId : sellerProduct?.status === 'published' ? sellerProduct.id : undefined
        : undefined
      const runtime = authorProductId === undefined ? undefined : installed.find(item =>
        item.productId === authorProductId && item.taskType === identity?.taskType
        && item.artifactDigest === identity?.artifactDigest)
      let nativeVerified = false
      if (publication?.runtimeKind === 'native-h3' && publication.status === 'approved'
        && publication.archiveStatus === 'confirmed' && publication.reviewReasons.length === 0
        && publication.lifecycle?.archived !== true
        && (publication.lifecycle === undefined || publication.lifecycle.state === 'active')
        && typeof skill.path === 'string' && node !== undefined && workerId && publicationAccountId !== null) {
        try {
          const source = await readNativeH3OrderSource(skill.path)
          const definition = source.files.find(file => file.path === 'task-definition.json')
          if (definition === undefined) throw new CatalogFailure('order-local-verification-failed')
          const prepared = await this.nativeH3CurrentSelection(node, { declaration: source.declaration,
            sourceDigest: `sha256:${source.digest}`,
            taskDefinitionSha256: `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}` })
          if (source.declaration.contractVersion === 'v1') {
            if (node.nativeH3AuthorBinding === undefined) throw new CatalogFailure('order-node-contributor-unavailable')
            const actual = parseNativeH3ContractBinding(await node.nativeH3AuthorBinding())
            if (nativeH3PublicBindingDigest(source.declaration) !== actual.ownerConfigDigest
              || source.declaration.executionRecipeSha256 !== actual.executionRecipeSha256
              || source.declaration.modelSha256 !== actual.modelSha256) throw new CatalogFailure('order-local-verification-failed')
          }
          const binding = nativeBindings.find(item => item.publicationId === publication.publicationId
            && item.sourceDigest === prepared.sourceDigest && item.declaration.taskType === identity?.taskType
            && nativeH3PublicBindingDigest(item.declaration) === nativeH3PublicBindingDigest(source.declaration)
            && (source.declaration.contractVersion === 'v1'
              || item.localOwnerConfigDigest === prepared.localOwnerConfigDigest && item.connectionId === connectionId)
            && item.taskDefinitionSha256 === prepared.taskDefinitionSha256)
          nativeVerified = binding !== undefined && await node.nativeH3OrderAdapterReady?.(source.declaration.taskType) === true
            && isVerifiedAnyNativeH3DeviceProof(binding.deviceProof, nativeH3ExpectedDeviceTuple(source.declaration,
              { publicationId: publication.publicationId, ownerId: publicationAccountId, deviceId: workerId,
                contractSha256: binding.contractSha256, sourceDigest: prepared.sourceDigest },
              prepared.localOwnerConfigDigest !== undefined && binding.deviceBindingRevision !== undefined
                ? { localOwnerConfigDigest: prepared.localOwnerConfigDigest,
                  deviceBindingRevision: binding.deviceBindingRevision } : undefined), Math.floor(Date.now() / 1000))
        } catch { /* Changed local metadata cannot keep a native grant projection ready. */ }
      }
      const ready = runtime !== undefined || nativeVerified
      const reason: OrderSourceItem['reason'] = ready ? 'ready' : publication?.status === 'approved' ? 'publication-approved'
        : publication?.status === 'rejected' ? 'publication-rejected'
          : publication ? 'publication-pending' : identity ? 'local-trial-ready' : 'conversation-only'
      sources.push({ id: `skill:${skill.source}:${encodeURIComponent(skill.name)}`, kind: 'skill', source: skill.source,
        ...(publication?.runtimeKind === undefined ? {} : { runtimeKind: publication.runtimeKind }),
        ...(authorProductId === undefined || publication?.runtimeKind === 'native-h3' ? {} : { authorProductId }),
        ...(publication === undefined ? {} : { authorPublication: {
          publicationId: publication.publicationId, status: publication.status,
          archiveConfirmed: publication.archiveStatus === 'confirmed', listingStatus,
          salePriceYuan: sellerProduct?.salePriceYuan ?? publication.salePriceYuan ?? null,
        } }),
        title: identity?.serviceTitle ?? skill.displayName,
        description: identity ? identity.serviceDescription ?? '' : skill.description,
        category: skill.category ?? null,
        loadState: ready ? 'active' : 'unknown', capabilityId: nativeVerified ? 'video.render' : runtime?.capabilityId ?? null,
        taskType: identity?.taskType ?? null, serviceId: ready ? 'node' : null, selectable: false, eligible: ready,
        enabled: ready && ownerEnabled && (publication?.runtimeKind !== 'native-h3' || order.mode !== 'off'), reason })
    }
    let authorOwnerCurrent = false
    try { authorOwnerCurrent = publicationAccountId !== null && await this.fileAccountId() === publicationAccountId }
    catch { /* Do not retain author approval or device proof across an unreadable account. */ }
    if (this.closed) throw new CatalogFailure('closed')
    if (!authorOwnerCurrent) {
      for (const [index, source] of sources.entries()) {
        if (source.kind !== 'skill' || source.authorPublication === undefined && source.authorProductId === undefined) continue
        const local = { ...source }
        delete local.authorPublication
        delete local.authorProductId
        sources[index] = { ...local, loadState: 'unknown', capabilityId: null, serviceId: null,
          eligible: false, enabled: false, reason: source.taskType === null ? 'conversation-only' : 'local-trial-ready' }
        complete = false
      }
    }
    if (workerId && (node?.acknowledgedWorkerId?.() !== workerId
      || connectionId !== undefined && node.acknowledgedConnectionId?.() !== connectionId)) {
      complete = false
      for (const [index, source] of sources.entries()) {
        if (source.kind !== 'skill' || !source.eligible && !source.enabled) continue
        sources[index] = { ...source, loadState: 'unknown', capabilityId: null, serviceId: null,
          eligible: false, enabled: false, reason: source.authorPublication?.status === 'approved' ? 'publication-approved'
            : source.taskType === null ? 'conversation-only' : 'local-trial-ready' }
      }
    }
    if (sources.length > MAX_ORDER_SOURCES) complete = false
    return { sources: sources.slice(0, MAX_ORDER_SOURCES), complete, order }
  }
  /**
   * Explicitly choose one installed, contracted inline adapter. Service authorization is separate.
   * @param request - The installed, contracted adapter explicitly selected for node execution.
   * @returns The exact local selection and its current execution facts.
   */
  @Remote
  async selectOrderSource(request: OrderSourceSelectionRequest): Promise<OrderSourceSelectionResult> {
    if (this.closed) throw new CatalogFailure('closed')
    const input: unknown = request
    if (input === null || typeof input !== 'object' || !('sourceId' in input)
      || typeof input.sourceId !== 'string' || Object.keys(input).length !== 1
      || input.sourceId.length > 300) throw new CatalogFailure('invalid-order-source')
    return this.serialize(async () => {
      const node = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
      if (typeof node?.selectOrderExecutor !== 'function') throw new CatalogFailure('order-source-unavailable')
      let selectedSourceId: string
      let choice: { kind: 'builtin' } | { kind: 'plugin'; packageName: string }
      if (request.sourceId === 'builtin:word_count') {
        selectedSourceId = request.sourceId
        choice = { kind: 'builtin' }
      } else {
        const manager = this.ctx.get('pluginManager') as OrderPluginInventoryPort | undefined
        if (manager === undefined || typeof node.canSelectOrderBundle !== 'function') {
          throw new CatalogFailure('order-source-unavailable')
        }
        let bundles: Awaited<ReturnType<OrderPluginInventoryPort['listBundles']>>
        try { bundles = await manager.listBundles() }
        catch { throw new CatalogFailure('order-source-unavailable') }
        const bundle = bundles.find(row => `bundle:${encodeURIComponent(row.name)}` === request.sourceId
          && row.installed && row.removable && row.enabled && row.error === undefined)
        if (bundle === undefined) throw new CatalogFailure('invalid-order-source')
        let selectable = false
        try { selectable = await node.canSelectOrderBundle(bundle.name) }
        catch { /* Selection still fails closed. */ }
        if (!selectable) throw new CatalogFailure('order-source-unavailable')
        selectedSourceId = `bundle:${encodeURIComponent(bundle.name)}`
        choice = { kind: 'plugin', packageName: bundle.name }
      }
      let selectedTaskType = 'word_count'
      try {
        const chosen = await node.selectOrderExecutor(choice)
        if (choice.kind !== chosen.kind || (choice.kind === 'plugin'
          && (chosen.kind !== 'plugin' || chosen.packageName !== choice.packageName))) {
          throw new CatalogFailure('order-source-unavailable')
        }
        if (chosen.kind === 'plugin') selectedTaskType = chosen.taskType ?? 'word_count'
      } catch (error) {
        if (error instanceof CatalogFailure) throw error
        const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
        if (code === 'COMPUTE_ORDER_EXECUTOR_SERVICE_ENABLED') throw new CatalogFailure('order-service-enabled')
        if (code === 'COMPUTE_ORDER_EXECUTOR_BUSY') throw new CatalogFailure('order-source-busy')
        if (code === 'COMPUTE_ORDER_EXECUTOR_SAVE_FAILED') throw new CatalogFailure('order-source-save-failed')
        throw new CatalogFailure('order-source-unavailable')
      }
      // The new executor has a different pinned digest. Hello is a connect-time
      // snapshot, so withdraw the old claim and advertise the newly verified one
      // before the owner can grant this service again.
      await this.refreshHello()
      return { selectedSourceId, taskType: selectedTaskType, capabilityId: 'text.transform', requiresGrant: true }
    })
  }
  /**
   * Save the owner's master supply switch without changing per-service grants, rates or resource limits.
   * @param request - The owner's explicitly chosen master supply setting.
   * @returns The updated master switch with existing service grants and rates preserved.
   */
  @Remote
  async setOwnerSupplyEnabled(request: CapabilitySupplySwitchRequest): Promise<CapabilityOrderFacts> {
    if (this.closed) throw new CatalogFailure('closed')
    const input: unknown = request
    if (input === null || typeof input !== 'object' || !('enabled' in input)
      || typeof input.enabled !== 'boolean' || Object.keys(input).length !== 1) {
      throw new CatalogFailure('invalid-supply-toggle')
    }
    return this.writeOwnerSupplyEnabled(request)
  }
  private writeOwnerSupplyEnabled(request: CapabilitySupplySwitchRequest,
    authority?: AuthorSupplyAuthority): Promise<CapabilityOrderFacts> {
    return this.serialize(async () => {
      await authority?.assertCurrent()
      const compute = this.ctx.get('computeCore') as ComputeSupplyPort | undefined
      if (typeof compute?.updateOwnerSupply !== 'function') throw new CatalogFailure('supply-unavailable')
      const node = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
      if (!request.enabled) {
        try { node?.setPanelAccepting(false) } catch { /* The persisted policy still has to turn off. */ }
      }
      await authority?.assertCurrent()
      try {
        await compute.updateOwnerSupply({ kind: 'mode', mode: request.enabled ? 'idle' : 'off' }, authority)
      }
      catch { throw new CatalogFailure('supply-unavailable') }
      await authority?.assertCurrent()
      if (request.enabled) {
        try { node?.setPanelAccepting(true) } catch { /* The saved policy stays subject to the node's veto. */ }
      }
      const order = await this.orderFacts()
      if (order === null) throw new CatalogFailure('supply-unavailable')
      return order
    })
  }
  /**
   * Grant or revoke only this build's `node` text order service; never turn on the master mode.
   * @param request - The explicit grant or revocation for the local node text service.
   * @returns The updated node text-service grant without enabling the master switch.
   */
  @Remote
  async setLocalServiceEnabled(request: CapabilityServiceSwitchRequest): Promise<CapabilityOrderFacts> {
    if (this.closed) throw new CatalogFailure('closed')
    const input: unknown = request
    if (input === null || typeof input !== 'object' || !('serviceId' in input) || !('enabled' in input)
      || input.serviceId !== 'node' || typeof input.enabled !== 'boolean' || Object.keys(input).length !== 2) {
      throw new CatalogFailure('invalid-service-toggle')
    }
    return this.writeLocalServiceEnabled(request)
  }
  private writeLocalServiceEnabled(request: CapabilityServiceSwitchRequest,
    authority?: AuthorSupplyAuthority): Promise<CapabilityOrderFacts> {
    return this.serialize(async () => {
      await authority?.assertCurrent()
      const compute = this.ctx.get('computeCore') as ComputeSupplyPort | undefined
      const node = this.ctx.get('nodeContributor') as NodeIntakePort | undefined
      if (typeof compute?.updateOwnerSupply !== 'function') throw new CatalogFailure('supply-unavailable')
      if (request.enabled) {
        if (typeof compute.querySupplySnapshot !== 'function' || typeof node?.canEnableLocalService !== 'function') {
          throw new CatalogFailure('service-unavailable')
        }
        let verified = false
        let runnable = false
        try {
          const snapshot = await compute.querySupplySnapshot()
          verified = snapshot.localServices?.some(service => service.id === 'node'
            && service.kind === 'tool' && service.verification === 'verified') === true
          runnable = await node.canEnableLocalService('node')
        } catch { throw new CatalogFailure('service-unavailable') }
        if (!verified || !runnable) throw new CatalogFailure('service-unavailable')
      } else {
        // Close the in-memory intake gate before the policy write or withdrawal can fail.
        try { node?.setPanelAccepting(false) } catch { /* Saved policy still has to revoke the grant. */ }
      }
      await authority?.assertCurrent()
      try {
        await compute.updateOwnerSupply({ kind: 'local-service', serviceId: 'node', enabled: request.enabled }, authority)
      }
      catch { throw new CatalogFailure('supply-unavailable') }
      await authority?.assertCurrent()
      if (request.enabled) {
        try { node?.setPanelAccepting(true) } catch { /* The saved grant remains subject to the node's veto. */ }
      }
      const order = await this.orderFacts()
      if (order === null) throw new CatalogFailure('supply-unavailable')
      return order
    })
  }
  /**
   * Save one wizard draft. The first three steps — capability identity, run preflight and order
   * policy — save here, and what they save is a draft whatever the page asked for: only publish
   * changes who may see a declaration.
   * @param request - Market listing id, and the account ids this computer should invite.
   * @returns The row as saved.
   */
  @Remote
  async saveCapabilityDraft(request: CapabilityDraftRequest): Promise<MarketInstallRecord> {
    if (this.closed) throw new CatalogFailure('closed')
    const inviteAccountIds = draftInviteAccountIds(request)
    return this.serialize(() => {
      const saved = this.savedRecord(request.id)
      return this.saveRow({ ...saved, visibility: draftVisibility(), inviteAccountIds })
    })
  }
  /**
   * Publish one saved capability with the visibility the owner chose in the wizard's last step.
   * `public` is refused unless this call carries the owner's explicit confirmation, and it is the
   * only visibility the node hello repeats. Package-backed entries stay private drafts until
   * an exact order executor is registered and tested. Built-in entries rerun the four checks.
   * @param request - Market listing id, the chosen visibility, and the public confirmation.
   * @returns The row as saved.
   */
  @Remote
  async publishCapability(request: PublishCapabilityRequest): Promise<MarketInstallRecord> {
    if (this.closed) throw new CatalogFailure('closed')
    const visibility = resolvePublishVisibility(request)
    const listing = await this.requireInstallable({ id: typeof request.id === 'string' ? request.id : '' })
    // A loaded package is not an order executor. Exact capability-to-runner admission is still absent.
    if (listing.packageSpec !== '') throw new CatalogFailure('not-advertisable')
    return this.serialize(async () => {
      const saved = this.savedRecord(listing.id)
      // A migrated Windows declaration may still name an older catalog version. It remains
      // visible in 我的能力, but its owner must install the current signed row before publishing.
      if (saved.version !== listing.version || saved.capabilityId !== listing.capabilityId) {
        throw new CatalogFailure('preflight-failed')
      }
      if (await this.recordActivity(saved) !== 'active') throw new CatalogFailure('preflight-failed')
      if (this.preflightOne(listing).verdict !== 'passed') throw new CatalogFailure('preflight-failed')
      return this.saveRow({ ...saved, visibility, inviteAccountIds: saved.inviteAccountIds })
    })
  }
  /**
   * Run the four install checks in order — signature, dependencies, model, resources — and write nothing.
   * @param request - Market listing id.
   * @returns The report the owner reads before Get. A failed report offers fix, recheck, cancel and rollback.
   */
  @Remote
  async preflight(request: MarketInstallRequest): Promise<InstallPreflightReport> {
    if (this.closed) throw new CatalogFailure('closed')
    return this.preflightOne(await this.requireInstallable(request))
  }
  /**
   * Attempt the repair for the step the last preflight failed on, then report the checks again.
   * @param request - Market listing id.
   * @returns What the attempt did. `unavailable` means this computer cannot repair that step.
   */
  @Remote('repairListing')
  async repair(request: MarketInstallRequest): Promise<MarketRepairResult> {
    if (this.closed) throw new CatalogFailure('closed')
    const listing = await this.requireInstallable(request)
    const before = this.preflightOne(listing)
    const step = before.failedStep
    if (step === null) {
      return { listingId: listing.id, step: null, outcome: 'unchanged', detail: 'preflight-passed', report: before }
    }
    if (step === 'signature') {
      const fresh = await this.requireInstallable(request)
      const report = this.preflightOne(fresh)
      return {
        listingId: listing.id, step, detail: 'refreshed-listing',
        outcome: report.verdict === 'passed' ? 'repaired' : 'unchanged', report,
      }
    }
    if (step === 'dependencies') return await this.repairDependencies(listing, step, before)
    const detail = step === 'model' ? 'owner-model-route' : 'owner-free-space'
    return { listingId: listing.id, step, outcome: 'unavailable', detail, report: before }
  }
  /**
   * Undo this listing's install attempt: remove the packages a repair installed, then restore the
   * declaration file to the bytes captured when that attempt started.
   * An attempt that started with no declaration file reports `no-previous-declaration` and leaves the
   * file it wrote: this market does not delete a declaration to undo an install.
   * @param request - Market listing id.
   * @returns What was restored or reverted. Nothing here cancels work or touches another declaration.
   */
  @Remote('rollbackListing')
  async rollback(request: MarketInstallRequest): Promise<MarketRollbackResult> {
    if (this.closed) throw new CatalogFailure('closed')
    const id = typeof request.id === 'string' ? request.id : ''
    const reverted: string[] = []
    const manager = this.installer()
    if (manager !== undefined) {
      for (const name of this.repairedPackages.get(id) ?? []) {
        try {
          await manager.removeBundle(name)
          reverted.push(name)
        } catch {
          // A package this rollback could not remove stays installed; the reply names what it did remove.
        }
      }
    }
    this.repairedPackages.delete(id)
    const attempt = this.attempts.get(id)
    if (attempt === undefined) return { listingId: id, restored: false, reverted, detail: 'no-attempt' }
    const path = this.declarationPath()
    if (readDeclarationBytes(path) === attempt) {
      return { listingId: id, restored: false, reverted, detail: 'declaration-unchanged' }
    }
    if (attempt === null) return { listingId: id, restored: false, reverted, detail: 'no-previous-declaration' }
    writeDeclarationBytes(path, attempt)
    return { listingId: id, restored: true, reverted, detail: 'declaration-restored' }
  }
  /**
   * Download, install, and register one listing.
   * The preflight runs first and must pass; a nonempty package spec then goes through the existing
   * plugin manager. The declaration is written only after the preflight and the package apply succeeds.
   * @param request - Market listing id.
   * @returns The saved declaration.
   */
  @Remote('installListing')
  async install(request: MarketInstallRequest): Promise<MarketInstallRecord> {
    if (this.closed) throw new CatalogFailure('closed')
    return this.serialize(() => this.installOne(request))
  }
  /**
   * Remove a built-in capability declaration without uninstalling a package or changing the
   * device's order policy. A remote catalog entry must use the profile package manager instead.
   * @param request - Exact built-in listing id.
   * @returns Whether this computer had the declaration; other rows remain untouched.
   */
  @Remote('removeListing')
  async remove(request: MarketInstallRequest): Promise<MarketRemoveResult> {
    if (this.closed) throw new CatalogFailure('closed')
    const input: unknown = request
    const id = input !== null && typeof input === 'object' && 'id' in input && typeof input.id === 'string' ? input.id : ''
    const listing = this.apiBase === null ? shippedListings().find(item => item.id === id) : undefined
    if (listing?.packageSpec !== '') throw new CatalogFailure('remove-unavailable')
    return this.serialize(async () => {
      const removed = removeMarketInstall(this.declarationPath(), id)
      if (removed) await this.refreshHello()
      return { id, removed }
    })
  }
  private declarationPath(): string {
    const home = this.config.installHome !== '' ? this.config.installHome : resolveMarketHome()
    return marketInstallPath(home)
  }
  /** Run one write to the declaration file after every write this service already started. */
  private serialize<T>(run: () => Promise<T> | T): Promise<T> {
    const result = this.writeChain.then(() => run(), () => run())
    this.writeChain = result.then(() => undefined, () => undefined)
    return result
  }
  /** One row already saved on this computer, or the unknown-listing failure the clients map. */
  private savedRecord(value: unknown): MarketInstallRecord {
    const id = typeof value === 'string' && value.length <= 80 ? value : ''
    const record = readMarketInstallFile(this.declarationPath()).find(item => item.id === id)
    if (record === undefined) throw new CatalogFailure('unknown-listing')
    return record
  }
  /** Write one complete row, then tell the node to send the hello this change implies. */
  private async saveRow(record: MarketInstallRecord): Promise<MarketInstallRecord> {
    writeMarketInstall(this.declarationPath(), record)
    await this.refreshHello()
    return record
  }
  /**
   * Ask the node contributor for a fresh hello after a declaration changed.
   * A draft or invite row reaching the hello is the same call as a published one: the node reads
   * the file and merges only what it may, so withdrawing a `public` row needs this refresh too.
   */
  private async refreshHello(): Promise<void> {
    const refresh = this.ctx.get('qianshou.market.hello') as MarketHelloRefresh | undefined
    if (refresh === undefined || typeof refresh.refresh !== 'function') return
    try {
      await refresh.refresh()
    } catch {
      // The declaration file is already saved. The next hello reads it if this reconnect fails.
    }
  }
  private installer(): PackageInstaller | undefined {
    const manager = this.ctx.get('pluginManager') as PackageInstaller | undefined
    if (manager === undefined || typeof manager.installBundle !== 'function') return undefined
    return manager
  }
  /** The manager's current profile must contain this exact active release. */
  private async bundleActivity(manager: PackageInstaller | undefined,
    identity: { name: string; version: string }): Promise<MarketActivityState> {
    if (manager?.listBundles === undefined || manager.checkBundle === undefined) return 'unknown'
    try {
      const bundle = (await manager.listBundles()).find(item => item.name === identity.name)
      if (bundle === undefined || !bundle.installed || !bundle.enabled || bundle.error !== undefined
        || bundle.version !== identity.version) return 'inactive'
      const check = await manager.checkBundle(identity.name)
      return check.state === 'active' && check.selected && check.version === identity.version
        && check.rows.some(row => row.phase === 'active') ? 'active' : 'inactive'
    } catch {
      // A refused or failed Host read cannot establish that the bundle is active or missing.
      return 'unknown'
    }
  }
  private async bundleReady(manager: PackageInstaller | undefined, identity: { name: string; version: string }): Promise<boolean> {
    return await this.bundleActivity(manager, identity) === 'active'
  }
  private isLegacyArticle(record: MarketInstallRecord): boolean {
    return record.id === 'qianshou.article' && record.capabilityId === 'text.transform' && record.version === '1'
      && (record.packageSpec === undefined || record.packageSpec === '')
  }
  private async recordActivity(record: MarketInstallRecord): Promise<MarketActivityState> {
    // The original shipped Article identity is already known to this build, including old rows
    // that predate packageSpec. Other legacy rows remain unknown until the owner reinstalls them.
    if (this.isLegacyArticle(record)) return 'active'
    if (record.packageSpec === undefined || record.packageSpec === '') return 'unknown'
    const identity = marketBundleIdentity(record.packageSpec)
    return identity === null ? 'unknown' : await this.bundleActivity(this.installer(), identity)
  }
  /** A private package is visible only after its exact bytes, Loader row and executor all match. */
  private async privateLocalCapabilities(): Promise<PrivateLocalCapability[]> {
    const profile = this.ctx.get('profileContext') as { dir: string } | undefined
    const manager = this.ctx.get('pluginManager') as Parameters<typeof verifyPrivateMacVideoInstallation>[0]['manager'] | undefined
    const compute = this.ctx.get('computeCore') as { executors: Parameters<typeof verifyPrivateMacVideoInstallation>[0]['executors'] } | undefined
    const factory = this.ctx.get('macDrawnVideoFactory') as Parameters<typeof verifyPrivateMacVideoInstallation>[0]['factory'] | undefined
    if (profile === undefined || manager === undefined || compute === undefined || factory === undefined) return []
    try {
      const verified = await verifyPrivateMacVideoInstallation({ profileDir: profile.dir,
        manager, executors: compute.executors, factory })
      return [{ kind: 'reviewed-private-mac-video', packageName: verified.packageName,
        packageVersion: verified.packageVersion, capabilityId: verified.capabilityId,
        capabilityVersion: verified.capabilityVersion, pluginDigest: verified.pluginDigest,
        scope: verified.scope, dispatchable: false }]
    } catch {
      // Failed attestation cannot become an owner-visible claim that this capability runs here.
      return []
    }
  }
  private async requireInstallable(request: MarketInstallRequest): Promise<MarketListing> {
    const id = typeof request.id === 'string' && request.id.length <= 80 ? request.id : ''
    const listing = (await this.listings()).listings.find(item => item.id === id)
    if (listing === undefined) throw new CatalogFailure('unknown-listing')
    if (!listingMayInstall(listing)) throw new CatalogFailure('not-advertisable')
    return listing
  }
  private preflightOne(listing: MarketListing): InstallPreflightReport {
    return runInstallPreflight(listing, this.observations())
  }
  private observations(): PreflightObservations {
    return {
      mode: this.apiBase === null ? 'shipped' : 'api',
      resolvePackage: name => resolveInstalledPackage(name),
      modelRoutes: () => this.modelRoutes(),
      freeDiskBytes: () => freeDiskBytes(dirname(this.declarationPath())),
      totalMemoryBytes: () => totalmem(),
      platform: () => platform(),
      architecture: () => arch(),
      signatureVerdict: (publisher, payload, signature) => this.signatureVerdict(publisher, payload, signature),
    }
  }
  private modelRoutes(): readonly string[] {
    const llm = this.ctx.get('llm') as ModelRoutes | undefined
    if (llm === undefined || typeof llm.listProviders !== 'function') return []
    try {
      return llm.listProviders().map(provider => provider.id).filter(id => typeof id === 'string' && id !== '')
    } catch {
      // A provider registry that throws on read is reported as no registered model route.
      return []
    }
  }
  /**
   * This computer's saved order policy, read from the service that owns it.
   * The order-policy step shows these facts rather than keeping a second copy of them. No compute
   * service, a refused read, or a policy value this build does not know all report `null` instead
   * of a guess: the page then says the policy is unknown.
   */
  private async orderFacts(): Promise<CapabilityOrderFacts | null> {
    const compute = this.ctx.get('computeCore') as ComputeSupplyPort | undefined
    if (compute === undefined || typeof compute.ownerSupplyPolicy !== 'function') return null
    try {
      const policy = await compute.ownerSupplyPolicy()
      if (!ORDER_MODES.includes(policy.mode as CapabilityOrderFacts['mode'])) return null
      if (!Number.isSafeInteger(policy.maxConcurrency) || policy.maxConcurrency < 1) return null
      return { mode: policy.mode as CapabilityOrderFacts['mode'], maxConcurrency: policy.maxConcurrency,
        ...(Array.isArray(policy.enabledServiceIds) ? {
          enabledServiceCount: policy.enabledServiceIds.length,
          enabledServiceIds: [...policy.enabledServiceIds],
        } : {}) }
    } catch {
      // A compute service that cannot answer is reported as an unknown order policy.
      return null
    }
  }
  private signatureVerdict(publisher: string, payload: string, signature: string): SignatureVerdict {
    const encoded: string | undefined = Object.hasOwn(this.config.publisherKeys, publisher)
      ? this.config.publisherKeys[publisher]
      : undefined
    if (encoded === undefined || encoded === '') return 'unknown-publisher'
    try {
      const publicKey = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' })
      return verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64')) ? 'valid' : 'invalid'
    } catch {
      // A misconfigured key, or a signature that is not valid base64 for that key, is not a trusted signature.
      return 'invalid'
    }
  }
  private journalRepair(id: string, installed: readonly string[]): void {
    this.repairedPackages.set(id, [...new Set([...(this.repairedPackages.get(id) ?? []), ...installed])])
  }
  private async repairDependencies(
    listing: MarketListing,
    step: PreflightStepId,
    report: InstallPreflightReport,
  ): Promise<MarketRepairResult> {
    const observed = this.observations()
    const missing = listing.requirements.packages.filter(dependency => observed.resolvePackage(dependency.name) === null)
    if (missing.length === 0) {
      return { listingId: listing.id, step, outcome: 'unchanged', detail: 'no-missing-package', report }
    }
    const manager = this.installer()
    if (manager === undefined) {
      return { listingId: listing.id, step, outcome: 'unavailable', detail: 'installer-unavailable', report }
    }
    const installed: string[] = []
    for (const dependency of missing) {
      const spec = dependency.minimumVersion === '' ? dependency.name : `${dependency.name}@${dependency.minimumVersion}`
      try {
        const result = await manager.installBundle(spec)
        if (result?.application !== 'applied') {
          if (result?.application === 'restart-required') installed.push(dependency.name)
          this.journalRepair(listing.id, installed)
          return {
            listingId: listing.id, step, outcome: 'unchanged',
            detail: `${result?.application === 'restart-required' ? 'activation-pending' : 'install-failed'} name=${dependency.name}`.slice(0, MAX_DETAIL),
            report: this.preflightOne(listing),
          }
        }
        installed.push(dependency.name)
      } catch {
        this.journalRepair(listing.id, installed)
        return {
          listingId: listing.id, step, outcome: 'unchanged',
          detail: `install-error name=${dependency.name}`.slice(0, MAX_DETAIL), report: this.preflightOne(listing),
        }
      }
    }
    this.journalRepair(listing.id, installed)
    const after = this.preflightOne(listing)
    return {
      listingId: listing.id, step,
      outcome: after.verdict === 'passed' ? 'repaired' : 'unchanged',
      detail: `installed=${installed.join(',')}`.slice(0, MAX_DETAIL), report: after,
    }
  }
  private async installOne(request: MarketInstallRequest): Promise<MarketInstallRecord> {
    const listing = await this.requireInstallable(request)
    const path = this.declarationPath()
    // Refuse an unmappable old declaration before installing any package or starting a rollback.
    readMarketInstallFile(path)
    this.attempts.set(listing.id, readDeclarationBytes(path))
    const report = this.preflightOne(listing)
    if (report.verdict !== 'passed') throw new CatalogFailure('preflight-failed')
    if (listing.packageSpec !== '') {
      const manager = this.installer()
      const identity = marketBundleIdentity(listing.packageSpec)
      if (manager === undefined || manager.listBundles === undefined || manager.checkBundle === undefined) {
        throw new CatalogFailure('installer-unavailable')
      }
      if (identity === null) throw new CatalogFailure('not-advertisable')
      // A prior restart-required install can finish at boot; still recheck the signed row above.
      if (!await this.bundleReady(manager, identity)) {
        const result = await manager.installBundle(listing.packageSpec)
        if (result?.application === 'restart-required') throw new CatalogFailure('activation-pending')
        if (result?.application !== 'applied' || result.bundle !== identity.name
          || !await this.bundleReady(manager, identity)) throw new CatalogFailure('install-failed')
      }
    }
    const record: MarketInstallRecord = {
      id: listing.id,
      capabilityId: listing.capabilityId,
      version: listing.version,
      installedAt: new Date().toISOString(),
      packageSpec: listing.packageSpec,
      // A new install is unpublished and invites nobody: the owner publishes it later, from the
      // wizard's last step, and only that step may make it visible to Shanghai.
      visibility: DEFAULT_VISIBILITY,
      inviteAccountIds: [],
    }
    await this.saveRow(record)
    return record
  }
  private async withNetwork<T>(run: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.config.timeoutMs): Promise<T> {
    if (this.closed) throw new CatalogFailure('closed')
    if (this.pending.size >= 2) throw new CatalogFailure('busy')
    const abort = new AbortController()
    const timeout = setTimeout(() => { abort.abort() }, timeoutMs)
    timeout.unref()
    const done = run(abort.signal)
    const task = { abort, done }
    this.pending.add(task)
    try {
      return await done
    } catch (error) {
      if (error instanceof CatalogFailure || error instanceof H3OwnerOnboardingError
        || error instanceof Error && SAFE_SUBMISSION_ERRORS.has(error.message)) throw error
      throw new CatalogFailure('unavailable')
    } finally {
      clearTimeout(timeout)
      this.pending.delete(task)
    }
  }
}
export default QianshouPluginCatalog
