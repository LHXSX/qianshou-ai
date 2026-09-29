/** Buyer input for an isolated model turn. A local file summary is never an upload receipt. */
export interface BuyerVideoAssetPlanRequest {
  sourceGoal: string
  answers?: {
    subject?: string
    motion?: string
    style?: string
    purpose?: string
    story?: string
    storyboard?: string
    sound?: string
    camera?: string
    avoid?: string
    duration?: string
  }
  selectedFirstFrame?: { mimeType: 'image/png' | 'image/jpeg'; bytes: number; sha256: string }
}

/** A model-backed text plan and buyer asset checklist; it carries no market consent. */
export interface BuyerVideoAssetPlan {
  schema: 'qianshou.video-asset-plan.v1'
  sourceGoal: string
  prompt: string
  assetGuidance: string
  requiredAssets: readonly [{ slot: 'first_frame'; acceptedMimeTypes: readonly ['image/png', 'image/jpeg']; maxBytes: 16777216 }]
  selectedFirstFrame?: { mimeType: 'image/png' | 'image/jpeg'; bytes: number; sha256: string }
  durationSeconds: 5
  frames: 120
  fps: 24
  modelReceipt: { provider: string; model: string; sessionId: string; assistantEventSeq: number; turnEndEventSeq: number }
}

/** A registry claim about an exact bundle version; discovery is not a code audit. */
export interface CatalogEntry {
  name: string
  version: string
  description: string
  publisher: string | null
  license: string | null
  homepage: string | null
  packageUrl: string
  installSpec: string
}

/** One bounded public-registry search, with explicit omissions and freshness. */
export interface CatalogPage {
  source: string
  query: string
  offset: number
  nextOffset: number | null
  checkedAt: number
  candidates: number
  excluded: number
  unavailable: number
  entries: CatalogEntry[]
}

/** Search input contains no workspace, transcript or account information. */
export interface CatalogQuery { query: string; offset: number }

/** One Host-verified, private plugin package prepared from the owner's saved draft. */
export interface LocalPluginCandidateView {
  draftId: string
  packageName: string
  packagePath: string
  toolName: string
  sourceDigest: string
  packageDigest: string
  displayName: string
  description: string
  operationTitle: string
  preparedAt: number
  /** Exact inline order contract carried by an allowlisted local candidate. */
  orderAdapter?: {
    version: 1
    capabilityId: 'text.transform'
    taskType: 'word_count'
    inputKind: 'inline'
    outputKind: 'inline_json'
    contractVersion: 'v1'
  }
  installableLocally: true
  published: false
  dispatchable: false
}

/** This list is separate from public marketplace listings and installed bundles. */
export interface LocalPluginCandidates { candidates: LocalPluginCandidateView[] }

/** A read-only comparison between a private candidate and its profile-installed three-file bundle. */
export interface LocalCandidateInstallCheck {
  packageName: string
  packageDigest: string
  matched: boolean
  reason: 'matched' | 'not-installed' | 'changed' | 'adapter-missing' | 'unavailable'
}

/** Author's local review metadata, bound to one byte-verified package digest. Never a platform listing. */
export interface LocalOrderPublicationDraft {
  draftId: string
  packageDigest: string
  name: string
  purpose: string
  category: 'text' | 'data' | 'automation'
  configuration: string
  salePriceYuan: string | null
  taskContract: NonNullable<LocalPluginCandidateView['orderAdapter']>
  savedAt: number
  state: 'local-draft'
}

export type LocalOrderPublicationDraftInput = Pick<LocalOrderPublicationDraft,
  'draftId' | 'packageDigest' | 'name' | 'purpose' | 'category' | 'configuration' | 'salePriceYuan'>

/** Shanghai receipt for a self-tested installed skill. Review is not approval or intake. */
export interface SubmittedOrderSkill {
  publicationId: string
  salePriceYuan?: string | null
  marketProductId?: string | null
  marketProductStatus?: 'review' | 'published' | 'rejected' | 'suspended' | null
  priceYuan?: string
  status: 'review' | 'approved'
  archiveStatus: 'confirmed' | 'pending'
  archiveError?: 'order-author-key-unavailable' | 'order-author-unavailable'
    | 'order-archive-untrusted-host' | 'order-archive-unavailable'
    | 'order-archive-upload-failed' | 'order-archive-unconfirmed' | 'order-publication-conflict'
    | 'order-auth-required'
  taskType: string
  artifactDigest: string
  reviewReasons: string[]
  platformReady: boolean
  /** Exact publication's independent review sample. Absent if start failed. */
  reviewSampleStatus?: 'blocked' | 'pending' | 'running' | 'verified' | 'evidence_deposited' | 'independent_sample_required'
  mediaEvidenceStatus?: 'missing' | 'valid' | 'invalid'
  reviewSampleError?: CatalogFailureCode
}

export interface OrderSkillPricePreview {
  taskType: string
  artifactDigest: string
  priceYuan: string
  settingsVersion: number
  taskDefinitionSha256: string
}

/** Public control-plane receipt for one independently executed review sample pair. */
export interface OrderReviewSampleStatus {
  readonly publicationId: string
  readonly status: 'blocked' | 'pending' | 'running' | 'verified' | 'evidence_deposited'
  readonly mediaEvidenceStatus: 'missing' | 'valid' | 'invalid'
  /** Older SVG review pairs expose their formats; native pairs use only aggregate progress. */
  readonly samples?: Readonly<Record<'gif' | 'mp4', { readonly status: string }>>
}

/** A server-confirmed author submission matched to exact local adapter source bytes. */
/** Server-owned reversible visibility, separate from signed review approval. */
export interface OrderPublicationLifecycle {
  readonly state: 'active' | 'withdrawn' | 'delisted'
  readonly archived: boolean
  readonly revision: number
  readonly allowedActions: readonly ('withdraw' | 'delist' | 'archive' | 'restore')[]
  readonly blockingReasons: readonly ('active-orders' | 'pending-install')[]
}

export interface ManageOrderSkillPublicationRequest {
  readonly publicationId: string
  readonly action: 'withdraw' | 'delist' | 'archive' | 'restore'
  readonly expectedRevision: number
  readonly note: string
}

export interface OrderPublicationLifecycleReceipt {
  readonly publicationId: string
  readonly ownerId: number
  readonly name: string
  readonly status: 'review' | 'approved' | 'rejected'
  readonly lifecycle: OrderPublicationLifecycle
}

export interface MyOrderSkillPublication {
  /** Derived from an intact fixed native source and its exact platform publication, never its title. */
  runtimeKind?: 'native-h3'
  source: 'user-dsh' | 'user-agents' | 'platform'
  name: string
  displayName?: string
  lifecycle?: OrderPublicationLifecycle
  publicationId: string
  status: 'review' | 'approved' | 'rejected'
  taskType: string
  artifactDigest: string
  priceYuan?: string
  salePriceYuan?: string | null
  marketProductId?: string | null
  marketProductStatus?: 'review' | 'published' | 'rejected' | 'suspended' | null
  reviewReasons: string[]
  reviewSampleError?: CatalogFailureCode
  evidenceStatus?: Readonly<Record<string, 'missing' | 'valid' | 'invalid'>>
  archiveStatus?: 'confirmed' | 'pending'
  reviewSampleStatus?: 'blocked' | 'pending' | 'running' | 'verified' | 'evidence_deposited' | 'independent_sample_required'
  mediaEvidenceStatus?: 'missing' | 'valid' | 'invalid'
  packageMigrationRequired?: boolean
}

/** Read-only local inventory: a registered source can open the real submission flow. */
export interface LocalOrderSkillEligibility {
  /** Host-validated fixed native declaration, independent of the skill's name. */
  runtimeKind?: 'native-h3'
  serviceTitle?: string
  serviceDescription?: string
  source: 'user-dsh' | 'user-agents'
  name: string
  path: string
  taskType: string
  artifactDigest: string
  platformPriced: boolean
}

export interface SubmitOrderSkillRequest {
  source: 'user-dsh' | 'user-agents'
  name: string
  displayName: string
  purpose: string
  configuration: string
  /** Empty only for a signed v2 task definition priced by Shanghai. */
  priceYuan: string
  /** One-time buyout price; zero is free. Confirmed in this same immutable submission. */
  salePriceYuan?: string
  expectedArtifactDigest?: string
  expectedTaskDefinitionSha256?: string
}

/** Seller's platform review receipt; publication is not a purchasable listing until approved. */
export interface SellerOrderProduct {
  id: string
  publicationId: string
  status: 'review' | 'published' | 'rejected'
  salePriceYuan: string
  canApprove: boolean
  reviewReasons: string[]
}

/** Exact source identity selected before requesting read-only legacy input controls. */
export interface MarketOrderInputPresentationRequest {
  readonly productId: string
  readonly taskType: string
  readonly version: string
  readonly artifactDigest: string
}

/** Sample-derived controls only; the signed legacy input definition remains unchanged. */
export interface MarketOrderInputPresentation {
  readonly productId: string
  readonly taskType: string
  readonly version: string
  readonly artifactDigest: string
  readonly status: 'available' | 'unavailable'
  readonly contentSchemaJson: string | null
  readonly fixedInputJson: string | null
  readonly reason: string | null
}

/** Independent CNY goods; platform listing is not an installed device package. */
export interface OrderAdapterProduct {
  id: string
  publicationId: string
  ownerId: number
  taskType: string
  /** Reviewed execution metadata; older catalogs may omit it and cannot activate v5 goods. */
  capabilityId?: string
  acceptedInputKinds?: string[]
  outputKind?: string
  contractVersion?: string
  /** Runtime read from independently reviewed source before payment. */
  runtimeAbi?: 'node-sandbox.v2' | 'quickjs-wasm.v3'
  name: string
  description: string
  category: string
  version: string
  artifactDigest: string
  reviewedSellerRuntimeDigest: string
  salePriceYuan: string
  currency: 'CNY'
  availableToPurchase: boolean
  purchaseBlockReason?: string | null
  archiveDigest: string | null
  archiveSizeBytes: number | null
}

/** Account-rights receipt only. The Host never maps it to local activation. */
export interface OrderAdapterEntitlement {
  entitlementId: string
  productId: string
  status: 'pending_install' | 'installed' | 'refunded'
  priceYuan: string
  currency: 'CNY'
  alreadyOwned: boolean
  deviceInstalled: false
  installExpiresAt: string | null
}

/** Durable Shanghai account ownership projected for this live PC worker. */
export interface OrderAdapterBuyerEntitlement {
  productId: string
  entitlementId: string
  productName: string
  status: 'pending_install' | 'installed' | 'refunded' | 'unknown'
  deviceInstalled: boolean
  /** Digest recorded by Shanghai's independently signed receipt for this exact worker. */
  runtimeDigest: string | null
  installExpiresAt: string | null
}

/** Signed metadata check only; archive bytes and local activation still need separate proof. */
export interface OrderAdapterInstallCheck {
  productId: string
  entitlementId: string
  publicationId: string
  archiveDigest: string
  archiveSizeBytes: number
  archiveVersionId: string
  archiveFormat: 'zip-source-v1'
  signatureVerified: true
  packageReceiptVerified: true
  deviceInstalled: false
  nextStep: 'archive-download-and-device-verification-required'
}

/** Locally verified source in quarantine. This is deliberately not an installed device receipt. */
export interface OrderAdapterSourceStage {
  productId: string
  entitlementId: string
  archiveVersionId: string
  archiveDigest: string
  artifactDigest: string
  sourceVerified: true
  deviceInstalled: false
  chatAvailable: false
  orderAvailable: false
  nextStep: 'independent-device-install-attestation-required'
}

/** Exact buyer runtime after a local isolated probe; Shanghai has not yet accepted device proof. */
export interface OrderAdapterLocalInstall {
  productId: string
  entitlementId: string
  taskType: string
  capabilityId: string
  artifactDigest: string
  runtimeDigest: string
  sourceVerified: true
  localVerified: true
  deviceInstalled: false
  orderAvailable: false
  nextStep: 'independent-device-install-attestation-required'
}

/** Signed Comfy source bytes installed as data; private GPU runtime proof is still required. */
export interface ReviewedComfyVideoSourceInstall {
  readonly productId: string
  readonly entitlementId: string
  readonly publicationId: string
  readonly taskType: string
  readonly artifactDigest: string
  readonly sourceVerified: true
  readonly metadataInstalled: true
  readonly deviceInstalled: false
  readonly orderAvailable: false
  readonly nextStep: 'independent-device-install-attestation-required'
}

/** Safe failures; external bodies and credential-bearing URLs never reach callers. */
export type CatalogFailureCode = 'invalid-query' | 'unavailable' | 'invalid-response' | 'busy' | 'closed'
  | 'not-advertisable' | 'unknown-listing' | 'install-failed' | 'installer-unavailable' | 'preflight-failed'
  | 'remove-unavailable'
  | 'candidate-unavailable' | 'activation-pending'
  | 'order-draft-invalid' | 'order-draft-unavailable'
  | 'order-adapter-invalid' | 'order-skill-unavailable' | 'order-runtime-unavailable'
  | 'order-skill-import-unavailable' | 'order-node-contributor-unavailable'
  | 'order-local-verification-failed' | 'order-platform-contract' | 'order-platform-route-unavailable'
  | 'order-review-samples-insufficient'
  | 'order-platform-unavailable' | 'order-auth-required' | 'order-publication-conflict'
  | 'order-author-key-unavailable' | 'order-author-unavailable'
  | 'order-author-source-changed' | 'order-author-not-published' | 'order-author-device-unverified'
  | 'order-author-entitlement-invalid' | 'order-author-entitlement-refunded' | 'order-author-entitlement-unknown'
  | 'order-archive-untrusted-host' | 'order-archive-unavailable'
  | 'order-archive-upload-failed' | 'order-archive-unconfirmed'
  | 'order-review-samples-invalid' | 'order-review-samples-not-ready' | 'order-review-samples-unavailable'
  | 'order-product-unavailable' | 'order-product-invalid' | 'order-product-not-found'
  | 'order-product-submission-rejected'
  | 'order-purchase-rejected' | 'order-install-manifest-invalid' | 'order-install-not-ready'
  | 'order-activation-invalid' | 'order-activation-unavailable' | 'order-attestor-unavailable'
  | 'order-install-download-failed' | 'order-install-refunded' | 'order-install-refund-unconfirmed'
  | 'market-capabilities-invalid' | 'market-capabilities-unavailable'
  | 'invalid-visibility' | 'invalid-invite' | 'publish-unconfirmed' | 'supply-unavailable' | 'invalid-supply-toggle'
  | 'invalid-service-toggle' | 'service-unavailable'
  | 'invalid-order-source' | 'order-source-unavailable' | 'order-source-busy'
  | 'order-service-enabled' | 'order-source-save-failed'
  | 'declaration-unreadable' | 'declaration-changed' | 'migration-protection-failed'

/** Where the PC client reads the market. `api` is the later shared catalog for Mac and Windows. */
export type MarketConnectionMode = 'shipped' | 'api'

/** One detached signature a listing carries. */
export interface MarketListingSignature {
  /** `catalog-digest` is the built-in catalog's own digest; `publisher` is a remote publisher's. */
  kind: 'catalog-digest' | 'publisher'
  /** Publisher id, trusted through the operator's `publisherKeys`. */
  publisher: string
  /** Hex digest for `catalog-digest`, base64 detached signature for `publisher`. */
  value: string
}

/** One module the listing needs before this computer may install it locally. */
export interface MarketDependency {
  /** Module name, resolved on this computer at install preflight. */
  name: string
  /** Lowest acceptable installed version, or empty for any version. */
  minimumVersion: string
}

/** What a listing declares it needs. Every field is checked before installation is recorded. */
export interface MarketListingRequirements {
  /** Signature over the declaration bytes, or null when the listing carries none. */
  signature: MarketListingSignature | null
  /** Modules that must resolve locally. Empty means the listing declares no dependency. */
  packages: MarketDependency[]
  /** Model route the plugin calls (`LlmProviderInfo.id`), or empty when it needs no model. */
  model: string
  /** Free bytes required at the declaration directory. Zero means no requirement. */
  minFreeDiskBytes: number
  /** Physical memory bytes the host must have to run the capability. Zero means no requirement. */
  minTotalMemoryBytes: number
  /** Operating systems supported by this release. Omitted means the publisher made no OS claim. */
  platforms?: ('darwin' | 'win32' | 'linux')[]
  /** Node Host process architectures supported by this release. Omitted means no CPU claim. */
  architectures?: ('arm64' | 'x64' | 'ia32' | 'arm')[]
}

/**
 * One market row.
 * `packageSpec` is empty when the row only registers a capability declaration.
 * `installable` means a private local installation may enter preflight; it does not authorize
 * publishing, owner supply, or Shanghai dispatch.
 */
export interface MarketListing {
  id: string
  title: string
  summary: string
  capabilityId: string
  version: string
  packageSpec: string
  installable: boolean
  requirements: MarketListingRequirements
}

/** Signed Guangzhou release metadata, displayed separately from actionable market listings. */
export interface MarketReleasePreview {
  pluginId: string
  version: string
  releaseId: string
  title: string
  summary: string
  packageBytes: number
  platforms: ('darwin' | 'win32' | 'linux')[]
  architectures: ('arm64' | 'x64' | 'ia32' | 'arm')[]
  operations: {
    capabilityId: string
    operationId: string
    executorKind: 'workflow' | 'node' | 'python' | 'model'
    permissions: string[]
  }[]
  publisherId: string
  reviewId: string
  reviewedAt: number
  /** Guangzhou checked the opaque archive bytes, not its extracted manifest or runtime. */
  verificationScope: 'opaque-archive-bytes'
  installable: false
}

export type MarketReleaseStatus = 'not-configured' | 'available' | 'unavailable'

/** Read-only readiness for the fixed official CSV seed; only `ready` may offer a claim. */
export interface OfficialCsvSeedMarketStatus {
  readonly phase: 'not-configured' | 'sign-in-required' | 'release-unavailable'
    | 'claim-auth-unverified' | 'ready'
  readonly accountSignedIn: boolean
  readonly signedReleaseVerified: boolean
  /** True only after Guangzhou verifies this request's Bearer identity, not a Cookie principal. */
  readonly claimAuthChannelVerified: boolean
  readonly pluginId: 'qianshou.csv-profile'
  readonly releaseId: 'qianshou.csv-profile-1.0.0'
  readonly version: '1.0.0'
  readonly packageSha256: string
}

/** The exact release and digest the owner confirmed in the PC market. */
export interface OfficialCsvSeedInstallRequest {
  readonly releaseId: string
  readonly packageSha256: string
}

/** One completed account-bound private install, never a Shanghai supply declaration. */
export interface OfficialCsvSeedInstallResult {
  readonly pluginId: 'qianshou.csv-profile'
  readonly version: '1.0.0'
  readonly alreadyInstalled: boolean
  readonly scope: 'account-bound-private'
  readonly dispatchable: false
}

/** The catalog the PC client renders. `source` is `shipped` or the API origin. */
export interface MarketCatalog {
  mode: MarketConnectionMode
  source: string
  listings: MarketListing[]
  /** Independent, read-only release preview. It never becomes an installable listing. */
  releaseSource: string
  releaseStatus: MarketReleaseStatus
  releases: MarketReleasePreview[]
}

/** Reviewed built-in private starting points, kept separate from public market listings. */
export interface ReviewedLocalStarter {
  readonly kind: 'mac-drawn-video' | 'csv-profile'
  /** Available means the fixed local starter exists; actual install still checks this device and asks the owner. */
  readonly phase: 'available' | 'installed' | 'unavailable'
  readonly reason?: 'mac-only' | 'drawing-unavailable' | 'package-unavailable' | 'installation-needs-repair'
}
export interface ReviewedLocalStarters { readonly items: ReviewedLocalStarter[] }

/** A generic private plugin activated on this computer, separate from market products and order supply. */
export interface PrivatePluginActivationView {
  readonly pluginId: string
  readonly displayName: string
  readonly version: string
  readonly packageSha256: string
  readonly candidateSha256: string
  readonly draftId: string
  readonly draftUpdatedAt: string
  readonly installedAt: string
  readonly operations: readonly {
    readonly operationId: string
    readonly adapterId: string
    readonly adapterVersion: string
  }[]
  readonly state: 'active-private' | 'unavailable-private'
  readonly scope: 'private-local'
  readonly dispatchable: false
  readonly publishable: false
}
export interface PrivatePluginActivations {
  readonly status: 'available' | 'not-supported'
  readonly records: readonly PrivatePluginActivationView[]
}

/** Exact private version and proposed capability mapping for a declaration-only submission. */
export interface PrivatePluginSubmissionPrepareRequest {
  readonly draftId: string
  readonly expectedUpdatedAt: string
  readonly packageSha256: string
  readonly candidateSha256: string
  readonly capabilityIds: Readonly<Record<string, string>>
}

/** Safe metadata shown before the owner chooses to upload; ZIP bytes stay in Host memory. */
export interface PrivatePluginSubmissionPreview {
  readonly accountId: string
  /** Configured publisher candidates; Guangzhou checks their account binding during submission. */
  readonly publisherIds: readonly string[]
  readonly pluginId: string
  readonly version: string
  readonly packageSha256: string
  readonly packageBytes: number
  readonly sourcePrivatePackageSha256: string
  readonly sourceCandidateSha256: string
  readonly operations: readonly {
    readonly operationId: string
    readonly capabilityId: string
    readonly executorKind: 'workflow' | 'tool' | 'model'
    readonly permissions: readonly string[]
    readonly inputSchemaSha256: string
    readonly outputSchemaSha256: string
  }[]
}

/** A Client confirmation is bound to the account and redacted package shown in preview. */
export interface PrivatePluginSubmissionConfirmRequest extends PrivatePluginSubmissionPrepareRequest {
  readonly publisherId: string
  readonly title: string
  readonly summary: string
  readonly approvedAccountId: string
  readonly approvedPackageSha256: string
}

/** A reviewed status is not a sale, license or Shanghai order admission. */
export interface PrivatePluginSubmissionReceiptView {
  readonly submissionId: string
  readonly accountId: string
  readonly publisherId: string
  readonly title: string
  readonly summary: string
  readonly submittedAt: number
  readonly packageSha256: string
  readonly packageBytes: number
  readonly reviewStatus: 'pending' | 'approved' | 'declaration-reviewed' | 'execution-candidate-reviewed' | 'rejected'
  readonly reviewId?: string
  readonly reviewNote?: string
}
export type PrivatePluginSubmissionResult =
  | {
    readonly state: 'submitted'
    readonly receipt: PrivatePluginSubmissionReceiptView
  }
  | {
    readonly state: 'refused'
    readonly reason: 'publisher-not-bound' | 'sign-in-required'
  }
  | {
    readonly state: 'unknown'
    readonly accountId: string
    readonly packageSha256: string
    readonly reconciliation: 'mine-required'
  }
export interface MyPrivatePluginSubmissionsView {
  readonly status: 'available'
  readonly records: readonly PrivatePluginSubmissionReceiptView[]
}

/** One saved local installation or built-in declaration. Only separately admitted public
 * declarations may reach the node hello; package-backed rows remain private drafts for now. */
export interface MarketInstallRecord {
  id: string
  capabilityId: string
  version: string
  installedAt: string
  /** Exact installed package, empty for a built-in row. Older records may omit this identity. */
  packageSpec?: string
  /** Who may see this declaration. A row that omits the field reads as `draft`. */
  visibility: CapabilityVisibility
  /** Account ids invited on this computer alone. Empty by default; no invite request leaves here. */
  inviteAccountIds: string[]
}

/** Saved declarations. The file on disk is the same list. */
export interface MarketInstalled { records: MarketInstallRecord[] }

/** Current Host status is read separately from the saved declaration and never persisted. */
export type MarketActivityState = 'active' | 'inactive' | 'unknown'
export interface MarketInstallActivities {
  records: {
    id: string
    capabilityId: string
    version: string
    packageSpec: string | null
    state: MarketActivityState
  }[]
}

/**
 * Who may see one declared capability.
 * `draft`, `private` and `invite` stay on this computer; only `public` reaches the node hello.
 */
export type CapabilityVisibility = 'draft' | 'private' | 'invite' | 'public'

/**
 * Why this computer has no number for one measurement.
 * `no-local-sample` means nothing ran here yet; `not-probed` means this service never looked.
 */
export type CapabilityMetricReason = 'no-local-sample' | 'not-probed'

/**
 * One number the owner reads before publishing.
 * `unknown` is not zero: an unmeasured measurement is reported as missing, with its reason.
 */
export type CapabilityMetric =
  | { readonly state: 'measured'; readonly value: number }
  | { readonly state: 'unknown'; readonly reason: CapabilityMetricReason }

/** The three published numbers. None of them falls back to a default value. */
export interface CapabilityMetrics {
  /** Share of this capability's local runs that finished, or `no-local-sample`. */
  successRate: CapabilityMetric
  /** 95th percentile of this capability's local run duration, or `no-local-sample`. */
  p95LatencyMs: CapabilityMetric
  /** Accelerator memory this computer measured, or `not-probed`. */
  vramBytes: CapabilityMetric
}

/** Saved order policy of this computer, read from the compute service when one is loaded. */
export interface CapabilityOrderFacts {
  /** `off` takes no work here. */
  mode: 'off' | 'idle' | 'allowed'
  /** Highest number of tasks the owner allows at once. */
  maxConcurrency: number
  /** Number of owner-enabled local service IDs, not a count of verified or available executors. */
  enabledServiceCount?: number
  /** Exact owner grants; a saved grant remains subject to live admission checks. */
  enabledServiceIds?: readonly string[]
}

/** Narrow owner write: toggles only the saved master mode, preserving every per-service choice and limit. */
export interface CapabilitySupplySwitchRequest { enabled: boolean }

/** Narrow owner write for the one local service with a deployed order runner. */
export interface CapabilityServiceSwitchRequest { serviceId: 'node'; enabled: boolean }

/** Choosing an executor never grants the node service or turns on the master intake switch. */
export interface OrderSourceSelectionRequest { sourceId: string }
export interface OrderSourceSelectionResult {
  readonly selectedSourceId: string
  readonly taskType: string
  readonly capabilityId: 'text.transform'
  readonly requiresGrant: true
}

/** Author activation includes the committed device proof and the owner's saved grant. */
export interface GenericAuthorOrderSkillActivation {
  readonly source: 'user-dsh' | 'user-agents'
  readonly name: string
  readonly publicationId: string
  readonly productId: string
  readonly deviceId: string
  readonly runtimeDigest: string
  readonly deviceInstalled: true
  readonly dispatchEligible: true
  readonly order: CapabilityOrderFacts
}

/** Native authors supply their existing private H3 provider; no purchased program is installed. */
export interface NativeAuthorOrderSkillActivation {
  /** Identifies the fixed native receipt separately from a purchased program installation. */
  readonly runtimeKind: 'native-h3'
  /** Controlled local author inventory that supplied the exact JSON-only source. */
  readonly source: 'user-dsh' | 'user-agents'
  /** Exact local skill name selected by the explicit owner action. */
  readonly name: string
  /** Approved immutable publication matched to the source and current device proof. */
  readonly publicationId: string
  /** Physical worker acknowledged on the same authenticated connection. */
  readonly deviceId: string
  /** SHA-256 digest of the actual private provider configuration identity. */
  readonly runtimeDigest: string
  /** Exact independent installed-device evidence was verified for this receipt. */
  readonly deviceVerified: true
  /** Current native update was acknowledged and the owner's saved Node grant permits intake. */
  readonly dispatchEligible: true
  /** Owner supply facts reread after the normal authorization write. */
  readonly order: CapabilityOrderFacts
}

/** Ordinary installed products and fixed native providers have separate verified activation receipts. */
export type AuthorOrderSkillActivation = GenericAuthorOrderSkillActivation | NativeAuthorOrderSkillActivation

/** One actual local installation or built-in executor, independent of a market declaration. */
export interface OrderSourceItem {
  /** Fixed native source matched to current owner/device evidence; never a product-id substitute. */
  readonly runtimeKind?: 'native-h3'
  readonly id: string
  /** Exact approved author product, absent for conversation-only and unlisted skills. */
  readonly authorProductId?: string
  /** Exact local source approval and separate listing facts; neither grants device intake. */
  readonly authorPublication?: {
    readonly publicationId: string
    readonly status: 'review' | 'approved' | 'rejected'
    readonly archiveConfirmed: boolean
    readonly listingStatus: 'not-listed' | 'review' | 'published' | 'rejected' | 'suspended' | 'unavailable'
    /** Explicit one-time sale price, never inferred from the per-task service price. */
    readonly salePriceYuan: string | null
  }
  readonly kind: 'builtin' | 'plugin' | 'skill'
  /** Profile placement, not a claim about purchase or publisher provenance. */
  readonly source: 'builtin' | 'profile-bundle' | 'profile-entry' | 'user-dsh' | 'user-agents'
  readonly title: string
  readonly description: string
  /** Only validated skill metadata is copied; plugin names are never used to infer a category. */
  readonly category: string | null
  /** A local load observation. A skill can still lose to a same-name Session provider. */
  readonly loadState: 'active' | 'disabled' | 'failed' | 'unknown'
  /** The exact platform landing supported by an adapted executor, never guessed from its title. */
  readonly capabilityId: string | null
  readonly taskType: string | null
  /** Only the selected, self-tested order executor may expose the owner grant target. */
  readonly serviceId: 'node' | null
  /** An unselected adapter may be explicitly chosen after a fresh Host output self-test. */
  readonly selectable: boolean
  /** Executor eligibility is separate from live idle time, login and Shanghai acknowledgement. */
  readonly eligible: boolean
  /** Saved local owner grant; an eligible source can still be paused by live admission. */
  readonly enabled: boolean
  readonly reason: 'ready' | 'not-selected' | 'not-active' | 'platform-task-unmapped'
    | 'file-input-unsupported' | 'executor-unverified' | 'output-unverified'
    | 'conversation-only' | 'local-trial-ready' | 'publication-pending' | 'publication-approved' | 'publication-rejected'
}

/** The inventory covers Host profile bundles/entries and the two installed user skill roots. */
export interface OrderSources {
  readonly sources: readonly OrderSourceItem[]
  /** False if a source could not be read or the bounded result omitted rows. */
  readonly complete: boolean
  readonly order: CapabilityOrderFacts | null
}

/** One declared capability as the 我的能力 page shows it. */
export interface MyCapability {
  record: MarketInstallRecord
  /** Fallback title; the PC client translates the ids it knows. */
  title: string
  /** Fallback one-liner; the PC client translates the ids it knows. */
  summary: string
  /** True only for a current built-in declaration this computer may publish. Loaded market packages stay drafts. */
  advertisable: boolean
  /** Live package/built-in activity, or unknown for an old unmatched record or failed Host read. */
  activity: MarketActivityState
  /** The three published numbers; an unmeasured one stays `unknown`. */
  metrics: CapabilityMetrics
  /** Free bytes at the declaration directory, measured on this call. */
  freeDiskBytes: number
  /** Physical memory bytes this computer has, measured on this call. */
  totalMemoryBytes: number
}

/** Verified active private package, shown separately from market declarations and Shanghai intake. */
export interface PrivateLocalCapability {
  readonly kind: 'reviewed-private-mac-video'
  readonly packageName: 'qianshou-mac-drawn-video'
  readonly packageVersion: '0.1.0'
  readonly capabilityId: 'video.drawn-mac-5s'
  readonly capabilityVersion: '0.1.0'
  readonly pluginDigest: string
  readonly scope: 'private-local-trial'
  readonly dispatchable: false
}

/** One step of the publish wizard, in the order the page offers them. */
export type CapabilityWizardStepId = 'identity' | 'run-preflight' | 'order-policy' | 'publish'

/** Everything the 我的能力 page reads in one call. */
export interface MyCapabilities {
  capabilities: MyCapability[]
  /** Current verified private runtime entries; never persisted into market-installed.json or node hello. */
  privateLocalCapabilities: PrivateLocalCapability[]
  /** The publish wizard's steps in order: identity, run preflight, order policy, publish. */
  wizardSteps: CapabilityWizardStepId[]
  /** This computer's saved order policy, or null when no compute service is loaded here. */
  order: CapabilityOrderFacts | null
}

/** Steps before `publish` save a draft. Only `publish` may set a visibility other than `draft`. */
export interface CapabilityDraftRequest {
  id: string
  /** Account ids to save on this computer, replacing the saved list; empty clears it. */
  inviteAccountIds: string[]
}

/** Publish input. `public` is refused unless the owner confirmed it in this request. */
export interface PublishCapabilityRequest {
  id: string
  visibility: CapabilityVisibility
  /** The owner's explicit confirmation that `public` merges this capability into the node hello. */
  confirmPublic: boolean
}

/** Install input. The id is a market listing id, not a package spec. */
export interface MarketInstallRequest { id: string }

/** Removing one built-in declaration never uninstalls a plugin package or changes owner supply policy. */
export interface MarketRemoveResult { id: string; removed: boolean }

/** One ordered install check. */
export type PreflightStepId = 'signature' | 'dependencies' | 'model' | 'resources'

/** `not-checked` follows a failure; `not-applicable` means no package exists for this check. */
export type PreflightStepState = 'passed' | 'failed' | 'not-checked' | 'not-applicable'

/** One step's outcome. `reason` is a stable code, empty only when the step passed. */
export interface PreflightStep {
  id: PreflightStepId
  state: PreflightStepState
  /** Stable reason code, or empty when the step passed. */
  reason: string
  /** Bounded observed facts (`name=…`, `free=…`), or empty when not needed. */
  detail: string
}

/** A recovery choice a failed preflight offers the owner. */
export type PreflightActionId = 'fix' | 'recheck' | 'cancel' | 'rollback'

/** What the four checks found. A declaration is written only for a `passed` verdict. */
export interface InstallPreflightReport {
  listingId: string
  /** All four steps in check order, whether or not they ran. */
  steps: PreflightStep[]
  verdict: 'passed' | 'failed'
  /** The step that stopped the run, or null when every step passed. */
  failedStep: PreflightStepId | null
  /** Recovery choices, empty when the run passed. */
  actions: PreflightActionId[]
  checkedAt: number
  /** Absence is compatible with older Host reports; new Hosts distinguish no claim from a check that passed. */
  compatibility?: {
    platform: HostCompatibilityCheck
    architecture: HostCompatibilityCheck
    /** The market has no reliable cross-platform GPU/VRAM check yet. */
    gpuMemory: { readonly state: 'not-probed' }
  }
}

/** Required values are null when the API listing did not declare this constraint. */
export interface HostCompatibilityCheck {
  readonly state: 'matched' | 'mismatched' | 'not-declared' | 'not-checked'
  readonly observed: string
  readonly required: readonly string[] | null
}

/** Outcome of one repair attempt, with the preflight report it produced. */
export interface MarketRepairResult {
  listingId: string
  /** Step the attempt repaired, or null when the report had already passed. */
  step: PreflightStepId | null
  /** `repaired` means every package install applied and the following report passed; `unavailable` means this computer cannot repair it. */
  outcome: 'repaired' | 'unchanged' | 'unavailable'
  /** Bounded facts about what the attempt did. */
  detail: string
  report: InstallPreflightReport
}

/** Outcome of returning this computer to its pre-install state. */
export interface MarketRollbackResult {
  listingId: string
  /** True when the declaration file was written back to its pre-install contents. */
  restored: boolean
  /** Packages a repair installed and this rollback removed. */
  reverted: string[]
  /** Bounded facts: `declaration-unchanged`, `no-attempt`, `no-previous-declaration`, `declaration-restored`. */
  detail: string
}
/** One reviewed task-type entry in Shanghai's market catalog. */
export interface MarketCapability {
  taskType: string
  capabilityId: string
  name: string
  description: string
  category: string
  categoryLabelZh: string
  acceptedInputKinds: string[]
  defaultInputKind: string
  requiredParams: string[]
  outputKind: string
  contractVersion: string
  publisherKind: 'official' | 'user'
  publisherKinds: Array<'official' | 'user'>
  executionMode: 'device' | 'cloud'
  availability: 'contract_ready' | 'published_no_dispatch_contract' | 'paused' | 'unavailable'
  formReady?: boolean
  requiresQuote: true
  executionQuotePath: '/api/v8/developer/tasks/estimate' | null
  currency: 'CNY'
  products: Array<{
    productId: string
    publicationId: string
    ownerId: number
    version: string
    salePriceYuan: string
    availableToPurchase: boolean
  }>
}
export type { LocalSkillTrialDefinition, LocalSkillTrialRequest } from './local-skill-trial.ts'

/** Pure setup DTOs; the browser never imports a provider or receives a private configuration. */
export type { H3OwnerSetupSelection, H3OwnerSetupInspectResult, H3OwnerSetupInspection, H3OwnerSetupSummary,
  H3OwnerSetupSaveRequest, H3OwnerSetupSaveResult, H3OwnerSelfTestRequest, H3OwnerSelfTestStatus,
  H3OwnerSelfTestId, H3OwnerInspectionId, H3OwnerSetupContextId, H3SkillDraftRequest, H3SkillDraftResult }
  from '@deepseek-ai/dsh-host-node-contributor/h3-owner-setup-types'

/** Canonical setup has independent commands, revisions and local trial records. */
export type { H3CanonicalSetupContextId, H3CanonicalInspectionId, H3CanonicalTrialId, H3CanonicalSetupSelection,
  H3CanonicalSetupInspectResult, H3CanonicalSetupSummary, H3CanonicalSetupInspection, H3CanonicalSetupSaveRequest,
  H3CanonicalSetupSaveResult, H3CanonicalTrialRequest, H3CanonicalTrialStatus, H3CanonicalSkillDraftRequest,
  H3CanonicalSkillDraftResult }
  from '@deepseek-ai/dsh-host-node-contributor/h3-owner-setup-types'

/** Only existing user-root identities can choose a local directory. */
export interface OrdinarySkillChoice {
  source: 'user-dsh' | 'user-agents'
  name: string
  displayName: string
  description: string
}
/** Author-edited terms; an empty price never becomes zero. */
export interface OrdinarySkillSubmit {
  requestId: string
  source: OrdinarySkillChoice['source']
  name: string
  title: string
  summary: string
  priceYuan: string
}
/** Credential-free manual review facts, all bound to the original package and price. */
export interface OrdinarySkillReceipt {
  requestId: string
  submissionId: string
  accountId: string
  skillId: string
  version: string
  title: string
  summary: string
  priceYuan: string
  currency: 'CNY'
  packageSha256: string
  packageBytes: number
  unpackedTreeSha256: string
  skillMdSha256: string
  submittedAt: number
  publisherKind: 'official' | 'user'
  review: { status: 'pending' | 'published' | 'rejected'
    reviewId: string | null
    operatorId: string | null
    reviewedAt: number | null
    note: string | null
    testReceiptSha256: string | null }
  purchaseAvailable: false
  installable: false
}
/** A saved original request can only be reconciled; it never authorizes another upload. */
export interface OrdinarySkillIntent extends OrdinarySkillSubmit {
  accountId: string
  skillId: string
  version: string
  packageSha256: string
  packageBytes: number
  unpackedTreeSha256: string
  skillMdSha256: string
}
export interface OrdinarySkillPublicationResult {
  intent: OrdinarySkillIntent
  submission: OrdinarySkillReceipt | null
  state: 'unknown' | 'submitted'
}
/** Local choices exposed without their filesystem locations. */
export interface OrdinarySkillChoicesResult { skills: OrdinarySkillChoice[] }
/** Independently reviewed ordinary directory, with no installation authority. */
export interface OrdinarySkillCatalogResult { listings: OrdinarySkillReceipt[] }
/** Current account's saved original submission observations. */
export interface OrdinarySkillMineResult { accountId: string; submissions: OrdinarySkillPublicationResult[] }
