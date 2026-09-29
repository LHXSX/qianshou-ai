# Qianshou application extensions

English | [中文](qianshou.zh.md)

This reference owns the Qianshou-specific Host records and generated Cordis interfaces in this checkout. These packages are private application extensions under [host/](../../packages/host/README.md); their presence here does not make them upstream DeepSeek Harness features or public release packages. Each package README owns its configuration, persistence, resource lifecycle and limitations.

## Account status

`AccountSnapshot` contains the browser-visible authorization phase, whitelisted identity, safe failure code, verification time and model-route selection. It excludes credentials and authorization challenges. The [account package](../../packages/host/qianshou-account/README.md) owns credential storage and gateway requests.

## Device memory

`MemoryState` identifies the device vault and registered workspaces. `MemoryInput` supplies owner text; `MemoryEntry` adds stored metadata and revision. `MemoryQuery` and `MemoryPage` describe bounded selection and results. `MemoryDetail` and `MemoryHistoryPage` expose owner history. `MemoryRevision` fences mutations, while `MemoryReview` records an explicit decision on a candidate. `MemoryExportQuery` and `MemoryExportPage` page through an unchanged vault revision. `MemoryOrigin` attributes an agent proposal to its actual Session and tool call. The [memory package](../../packages/host/qianshou-memory/README.md) owns workspace filtering and the distinction between owner operations and agent retrieval.

## Local speech recognition

`VoiceStatus` reports availability, busy state, backend and audio limits without resource paths. Transcription bytes use the authenticated bounded HTTP upload route, not a Remote argument. The [voice package](../../packages/host/qianshou-voice/README.md) owns waveform validation, actual Session admission, process cancellation and temporary-file cleanup.

## Plugin directory

`CatalogQuery` selects search text and offset; `CatalogPage` returns checked exact-version bundle candidates, pagination and counts for excluded or unavailable results. Discovery does not authorize installation. The [catalog package](../../packages/host/qianshou-plugin-catalog/README.md) owns registry validation; [profile management](boot.md) owns inspection, installation, replacement and actual loading outcomes.

## Session connections

`ConnectionGrantInput` selects one existing ordinary Session, read or text permission, label and expiry. `ConnectionGrantCreated` returns a safe grant record and a secret link once; callers must keep the link out of diagnostics and Session history. `ConnectionOwnerState` lists grants for the selected Session without bearer secrets. External text admission is distinct from model completion, and uncertain receipts do not authorize automatic resubmission. The [connection package](../../packages/host/qianshou-session-connect/README.md) owns the restricted external HTTP protocol, projection, revocation and durable receipts.

## Account commerce

`AccountCommerce` reports the actual plan, window quota, nullable wallet numbers and a pending plan quote. `AccountPayment` is a server-signed Alipay form; `AccountRechargeOrder` is an owner-checked order, and `AccountAlipayStart` distinguishes ready, existing, unknown, conflict and rejected outcomes. `AccountWechatChannel` reports channel availability and server idempotency support; `AccountWechatOrder` adds the pending code URL and verified provider state, while `AccountWechatStart` preserves an unknown or conflicting result. Browser redirects cannot establish payment. The [account type definitions](../../packages/host/qianshou-account/src/types.ts) own these records.

## Local candidates and review receipts

`LocalPluginCandidates` lists prepared local packages; `LocalCandidateInstallCheck` compares their exact digest with an installed bundle. `LocalOrderPublicationDraft` and `LocalOrderPublicationDraftInput` describe owner-authored local metadata, without declaring platform approval. `ReviewedSeedHostConfig` holds Host-only endpoints and trusted keys; it is not a Remote credential view. `OfficialCsvSeedMarketStatus`, `OfficialCsvSeedInstallRequest` and `OfficialCsvSeedInstallResult` describe the exact reviewed CSV seed and its separate install operation. The [catalog package](../../packages/host/qianshou-plugin-catalog/README.md#doc-section-3) owns the admission gates.

`LocalOrderSkillEligibility` reports a source bound to its current artifact digest; `OrderSkillPricePreview` binds server pricing to that digest and the task-definition hash. `SubmitOrderSkillRequest` requests submission of those bytes, and `SubmittedOrderSkill` returns the separate archive and review states. `OrderReviewSampleStatus` reports independent sample evidence. `MyOrderSkillPublication` may carry platform-only history without a runnable local path. `ManageOrderSkillPublicationRequest` names a revision-checked lifecycle action, and `OrderPublicationLifecycleReceipt` returns its server-owned state; delisting or archiving never rewrites signed approval. Their full shapes are in the [catalog type definitions](../../packages/host/qianshou-plugin-catalog/src/types.ts).

`NativeH3CatalogBinding` is account-scoped metadata for an approved native H3 provider: its public declaration, publication, source digest, author task-definition digest, Shanghai contract digest and process-verified device proof. The task-definition and contract digests describe different immutable records. This Host-only binding contains no model bytes, private configuration paths or media, and cannot establish a new device's readiness by itself. The [native binding reader](../../packages/host/qianshou-plugin-catalog/src/native-h3-bindings-http.ts) owns its exact parsing and proof checks.

## Reviewed goods and local input forms

`OrderAdapterProduct` describes an exact reviewed version; `SellerOrderProduct` is its seller-facing review record. `OrderAdapterEntitlement` and `OrderAdapterBuyerEntitlement` distinguish an account purchase-rights receipt from its durable projection for the current device. `OrderAdapterInstallCheck`, `OrderAdapterSourceStage` and `OrderAdapterLocalInstall` distinguish checking, source quarantine and local probing. `AuthorOrderSkillActivation` reports the author's separate device activation. Purchase, installed bytes, device verification and permitted order intake remain independent states; the [catalog package](../../packages/host/qianshou-plugin-catalog/README.md#doc-section-8) owns their checks.

`MarketOrderInputPresentationRequest` binds product, task, version and artifact digest; `MarketOrderInputPresentation` returns conservative controls derived from accessible signed samples, or an explicit unavailable reason. It cannot change the legacy contract or execute a sample. `LocalSkillTrialDefinition` exposes the current task schema and digest; `LocalSkillTrialRequest` supplies validated form JSON with an optional expected digest. A text form does not grant a missing file runtime. The [trial definitions](../../packages/host/qianshou-plugin-catalog/src/local-skill-trial.ts) own this distinction.

`VerifiedPurchasedOrderRuntime` and `VerifiedPurchasedFileOrderRuntime` identify immutable, independently verified installed execution bytes. `EdgeFileContract` binds metadata to an authenticated assignment and exact attachment references; `FileOrderRuntimePorts` provides lease-scoped transport, and `GenericFileArtifact` returns the real output reference. Their [file-runtime implementation](../../packages/host/qianshou-plugin-catalog/README.md#doc-section-9) keeps file bytes on the PC and direct object storage rather than the Shanghai control plane.

## Market inventory and owner supply

`MarketCatalog` and `MarketCapability` describe discovery and execution metadata; `ReviewedLocalStarters` and `PrivatePluginActivations` keep local preparation and actual loaded activation separate. `PrivatePluginSubmissionPrepareRequest`, `PrivatePluginSubmissionPreview`, `PrivatePluginSubmissionConfirmRequest`, `PrivatePluginSubmissionResult` and `MyPrivatePluginSubmissionsView` retain preparation, explicit confirmation and server receipt as different steps. `MarketInstalled`, `MarketInstallRecord` and `MarketInstallActivities` report saved installations and separately checked activity. `InstallPreflightReport`, `MarketInstallRequest`, `MarketRepairResult`, `MarketRollbackResult` and `MarketRemoveResult` report actual preflight or explicit local operations, without declaring a market purchase or global deletion. The [catalog package](../../packages/host/qianshou-plugin-catalog/README.md#doc-section-4) owns their lifecycle.

`MyCapabilities` reads saved capability declarations. `CapabilityDraftRequest` saves a draft and `PublishCapabilityRequest` requires the requested visibility and explicit public confirmation. `OrderSources` inventories possible local executors; `OrderSourceSelectionRequest` and `OrderSourceSelectionResult` select one without enabling supply. `CapabilityOrderFacts` reports effective owner policy, while `CapabilitySupplySwitchRequest` and `CapabilityServiceSwitchRequest` request distinct master and service changes. Saved policy cannot establish live execution or server intake; the [owner-supply documentation](../../packages/host/qianshou-plugin-catalog/README.md#doc-section-5) owns identity, probe and admission checks.

## Local skill import and recycle bin

`SkillImportInspection` and its single-use `SkillImportInspectionId` report preflight metadata; `SkillImportReceipt` records a disk write and `SkillImportVerification` compares the exact digest afterward. `LocalSkillList` is a validated user-owned inventory; `SkillAuthoringContext` reports the bounded authoring environment. `LocalSkillArchiveRequest` and `LocalSkillArchiveReceipt` bind a reversible local removal to the selected source and bytes. `LocalSkillArchiveEntry`, `LocalSkillRestoreRequest` and `LocalSkillRestoreReceipt` describe verified archive metadata and an explicit conflict-checked restore. Restoration does not enable a plugin, receive orders or restore a cloud record. The [import package](../../packages/host/qianshou-skill-import/README.md) owns allowed roots, ownership, symlink refusal and archive integrity.

## Local execution and paired devices

`ComputeExecutor` is an installed Host executor port, not evidence of a reachable GPU or market registration. `LegalDocumentAdmission` and `LegalAssignedTaskRequest` bind an actual legal task lease, grants and execution request; the native provider may remain unavailable and its market dispatch unregistered. The [compute package](../../packages/host/compute-core/README.md#use-this-package) owns provider health and assignment checks. `DeviceInfo` reports paired-device metadata and peer-approved workspaces. `RemoteJob` retains the requested operation and actual peer receipt, including requested versus confirmed cancellation; the [device package](../../packages/host/remote-devices/README.md#understand-the-implementation) owns peer authorization and bounded transport.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputecore--computeservice"></a>

### `ctx.computeCore` — `ComputeService`

Core catalogue, local drafts, and authorized developer-task publish.

```ts cordis-catalog
/**
 * Read owner-local plugin recipes; they are neither installable nor advertised.
 * @returns Owner-local recipe records, without install or advertisement authority.
 */
localPluginDrafts(): Promise<LocalPluginDraft[]>

/**
 * Build and retain actual bounded program bytes from an exact private draft revision.
 * @param value - Exact private draft revision, declared capability IDs and bounded program bytes.
 * @returns The verified bounded candidate retained for the exact draft revision.
 */
async buildReviewableExecutionCandidate(value: { readonly draftId: string; readonly expectedUpdatedAt: string; readonly capabilityIds: Readonly<Record<string, string>>; readonly programs: Readonly<Record<string, unknown>> }): Promise<VerifiedReviewableExecutionArtifact>

/**
 * Authenticated owner export of the exact local candidate; this is not an install package.
 * @param packageSha256 - The exact immutable candidate or private archive SHA256.
 * @returns JSON export data; review, installability and dispatchability remain false.
 */
exportReviewableExecutionCandidate(packageSha256: string): Promise<{ readonly fileName: string readonly contentType: 'application/json' readonly contents: string readonly packageSha256: string readonly reviewed: false readonly installable: false readonly dispatchable: false }>

/**
 * Host caller obtains a fresh owner approval before passing sample input here.
 * @param packageSha256 - The exact immutable candidate or private archive SHA256.
 * @param samples - One schema-validated input for every declared candidate operation.
 * @returns Actual bounded sample outputs for every declared operation, without approval or installation.
 */
async tryReviewableExecutionCandidate(packageSha256: string, samples: readonly { readonly operationId: string; readonly input: unknown }[]): Promise<{ readonly packageSha256: string; readonly results: readonly { readonly operationId: string; readonly output: Readonly<Record<string, string>> }[]; readonly reviewed: false; readonly installable: false; readonly dispatchable: false }>

/**
 * List registered logical operations; no registration, sample or execution authority escapes this service.
 * @returns Registered logical-operation metadata, without Host callbacks or execution authority.
 */
listPluginAdapterBindings(): readonly HostPluginAdapterListing[]

/**
 * Read persisted PRIVATE installs with current archive, draft and Host callback availability.
 * @returns Saved private activations with current archive, draft and callback observations.
 */
listPrivatePluginActivations(): Promise<readonly PrivatePluginActivationSummary[]>

/** Prepare a redacted Guangzhou declaration from an exact active private plugin for Host upload.
 * @param input - Exact draft revision, sampled archive, explicit operation capabilities and cancellation.
 * @returns Safe metadata and ZIP bytes retained only by the trusted Host caller.
 */
preparePrivatePluginSubmission(input: { readonly draftId: string readonly expectedUpdatedAt: string readonly packageSha256: string readonly candidateSha256: string readonly capabilityIds: Readonly<Record<string, string>> readonly signal: AbortSignal }): Promise<PreparedPrivatePluginSubmission>

/**
 * Activate one exact private archive after a one-shot Host owner approval.
 * @param packageSha256 - The exact immutable candidate or private archive SHA256.
 * @param candidateSha256 - The expected private candidate identity bound to the archive.
 * @param authority - Trusted Host agent, call identity and cancellation for fresh one-shot owner approval.
 * @returns The private activation after exact-byte and fresh owner-approval checks.
 */
activatePrivatePlugin(packageSha256: string, candidateSha256: string, authority: { readonly agent: unknown; readonly callId?: unknown; readonly signal: AbortSignal }): Promise<PrivatePluginActivationSummary>

/**
 * Uninstall one exact private activation after a one-shot Host owner approval.
 * @param packageSha256 - The exact immutable candidate or private archive SHA256.
 * @param candidateSha256 - The expected private candidate identity bound to the archive.
 * @param authority - Trusted Host agent, call identity and cancellation for fresh one-shot owner approval.
 * @returns The explicit private uninstall receipt; market and supply rights are unchanged.
 */
uninstallPrivatePlugin(packageSha256: string, candidateSha256: string, authority: { readonly agent: unknown; readonly callId?: unknown; readonly signal: AbortSignal }): Promise<PrivatePluginActivationRecord & { readonly state: 'uninstalled-private' }>

/**
 * Run one installed PRIVATE operation with fresh archive, adapter and one-shot owner checks.
 * @param packageSha256 - The exact immutable candidate or private archive SHA256.
 * @param candidateSha256 - The expected private candidate identity bound to the archive.
 * @param operationId - The exact operation declared by the selected installed or saved source.
 * @param input - Untrusted operation input validated against the installed exact schema.
 * @param authority - Trusted Host agent, call identity and cancellation for fresh one-shot owner approval.
 * @returns The actual private operation result after current bytes and one-shot authority verify.
 */
runPrivatePluginOperation(packageSha256: string, candidateSha256: string, operationId: string, input: unknown, authority: { readonly agent: unknown; readonly callId?: unknown; readonly signal: AbortSignal }): Promise<PrivatePluginOperationResult>

/**
 * Trusted, already installed Host packages register their exact executor contract here.
 * Never expose this method as a model tool, Remote or HTTP route.
 * @param adapter - The trusted installed Host adapter and its exact executor contract.
 * @returns A disposer that unregisters only this installed Host adapter.
 */
registerHostPluginSampleAdapter(adapter: HostPluginSampleAdapter): () => void

/**
 * Run an exact saved draft against registered Host callbacks for one owner approved sample.
 * The returned archive contains private sample data; a model tool must omit its bytes.
 * @param id - The saved owner-local draft identifier, parsed before use.
 * @param expectedUpdatedAt - The exact saved draft revision expected before execution.
 * @param inputs - One owner-approved sample input for each selected declared operation.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns Real sample results and the private retained archive; callers must not expose archive bytes to a model.
 */
async runPrivatePluginSamples(id: unknown, expectedUpdatedAt: unknown, inputs: readonly { readonly operationId: string; readonly input: unknown }[], signal: AbortSignal): Promise<PrivatePluginSampleRun & { readonly stored: PrivateOfflinePluginArtifactSummary }>

/**
 * Save one private, non-executable plugin recipe after parsing its bounded operation schemas.
 * @param value - Untrusted recipe metadata and operation schemas, parsed before saving.
 * @returns The parsed and saved private, non-executable recipe.
 */
saveLocalPluginDraft(value: unknown): Promise<LocalPluginDraft>

/**
 * Save only after the creator tool obtains a one-shot Host approval for this graph digest.
 * @param value - Exact draft and operation, workflow path and expected source digest.
 * @returns The verified owner-local workflow summary, without task execution.
 */
bindLocalPluginComfyAsset(value: { readonly id: unknown readonly expectedUpdatedAt: unknown readonly operationId: unknown readonly workflow: unknown readonly mapping: unknown }): Promise<ComfyDraftAssetSummary>

/**
 * Give model tools only a private asset's digest and pending state.
 * @param id - The saved owner-local draft identifier, parsed before use.
 * @returns Bounded saved workflow summaries for the exact draft.
 */
localPluginComfyAssetSummaries(id: unknown): Promise<readonly ComfyDraftAssetSummary[]>

/**
 * Trusted Host-only readback for a later adapter; never mount this as a model tool or HTTP route.
 * @param id - The saved owner-local draft identifier, parsed before use.
 * @param operationId - The exact operation declared by the selected installed or saved source.
 * @returns The verified Host-only workflow asset for the selected operation.
 */
readLocalPluginComfyAsset(id: unknown, operationId: unknown): Promise<PrivateComfyDraftAsset>

/**
 * Run only a Host-approved private sample; the model cannot supply an owner or idempotency key.
 * @param value - Exact draft operation, local workflow parameters, Host authority and cancellation.
 * @returns The completed private sample receipt after fresh owner approval and actual execution.
 */
runLocalPluginComfyTrial(value: Omit<PrivateComfyTrialInput, 'ownerId' | 'idempotencyKey'>): Promise<PrivateComfyTrialReceipt>

/**
 * Opaque ID read for the authenticated local image preview route.
 * @param trialId - The opaque identifier of this owner's original private image trial.
 * @returns Verified PNG bytes for the authenticated local preview caller.
 */
readLocalPluginComfyTrialImage(trialId: string): Promise<Buffer>

/**
 * Authenticated local owner can locate an interrupted trial without an agent call ID.
 * @returns Up to twenty owner-local trial identifiers, states, timestamps and result metadata.
 */
recentLocalPluginComfyTrials(): Promise<readonly Pick<ComfyTrialRecord, 'trialId' | 'status' | 'updatedAt' | 'result'>[]>

/**
 * Read only the original Comfy prompt and verified PNG after an interrupted trial.
 * @param trialId - The opaque identifier of this owner's original private image trial.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns The original trial status and verified result; pending never authorizes resubmission.
 */
reconcileLocalPluginComfyTrial(trialId: string, signal: AbortSignal): Promise<PrivateComfyTrialReconciliation>

/**
 * Export one recipe as JSON data without installing, signing or publishing it.
 * @param id - The saved owner-local draft identifier, parsed before use.
 * @returns The recipe JSON data without installing, signing or publishing it.
 */
exportLocalPluginDraft(id: unknown): Promise<PluginDraftExport>

/**
 * Read a non-runnable package plan and live, explicitly limited hardware checks.
 * @param id - The saved owner-local draft identifier, parsed before use.
 * @returns A declaration-only package preview, without installation or execution.
 */
previewLocalPluginDraft(id: unknown): Promise<PluginDraftPackagePreview>

/**
 * Prepare a bounded private candidate from an allowlisted saved draft.
 * @param id - The saved owner-local draft identifier, parsed before use.
 * @returns The prepared local candidate, without installation or market publication.
 */
prepareLocalPluginCandidate(id: unknown): Promise<LocalPluginCandidate>

/**
 * Read byte-verified private candidates for owner review.
 * @returns Prepared owner-local candidates, separate from public market goods.
 */
listLocalPluginCandidates(): Promise<ListedLocalPluginCandidate[]>

/** Report configured features; this is not a connectivity or account validation probe.
 * @returns Current local configuration state.
 */
status(): ComputeConnectionState

/** Configured core origin for sibling plugins that open the worker socket.
 * @returns Scheme, host and port, or null when no origin is configured or the service is closed.
 */
coreOrigin(): string | null

/** Read the authenticated core account id used as the Edge worker owner id.
 * @param signal - Caller cancellation bound to the upstream request.
 * @returns Positive core account id.
 */
async ownerAccountId(signal?: AbortSignal): Promise<number>

/**
 * Read this owner's Shanghai-backed execution and settled earnings summary.
 * @param workerId - The current worker identity whose owner-visible dashboard is requested.
 * @param offset - The bounded dashboard page offset, defaulting to zero.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns The current owner and worker execution, order and settled-earnings metadata.
 */
nodeDashboard(workerId: string, offset: number = 0, signal?: AbortSignal): Promise<CoreNodeDashboard>

/** Read fresh local resource facts independently of cloud model configuration.
 * @param signal - Cancellation for bounded local probes.
 * @returns Actual observations and saved owner policy; unknown facts stay unknown.
 */
querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot>

/**
 * Preview a natural request against observed local, Guangzhou and Shanghai capability facts.
 * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
 * @param guangzhouAccount - The actual account state used to assess the cloud route without guessing authorization.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns A route decision based on actual registry, supply and account observations; it creates no task.
 */
async previewNaturalIntent(input: unknown, guangzhouAccount: GuangzhouAccountState, signal?: AbortSignal): Promise<NaturalRouteDecision>

/**
 * Return an already completed local observation without probing or changing Shanghai advertisement.
 * @returns The latest observed supply services, or null before an observation.
 */
lastObservedSupply(): ObservedSupplyServices | null

/** Read the saved owner supply policy without running local probes.
 *
 * The resident contribution loop mirrors this switch on every tick, so it must stay
 * cheap and must never touch advertisement state.
 * @param signal - Caller cancellation.
 * @returns The committed owner policy.
 */
ownerSupplyPolicy(signal?: AbortSignal): Promise<SupplyPolicy>

/** Persist a complete owner policy without buying or submitting a task.
 * @param policy - Complete policy validated by the supply controller before persistence.
 * @param signal - Caller cancellation; a committed policy remains saved after a probe error.
 * @returns Fresh local supply state after the committed change.
 */
updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot>

/** Host-only author commit; validates expected owner and worker inside the supply serialization queue.
 * @param policy - Complete proposed policy.
 * @param authority - Original author id and current worker/account assertion; never supplied by a renderer.
 * @param signal - Optional caller cancellation.
 * @returns Fresh snapshot only after the exact author-bound policy commit.
 */
updateBoundSupplyPolicy(policy: SupplyPolicy, authority: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot>

/** Host-only atomic switch; never derives a write from the public effective owner view.
 * @param command - Explicit master-mode or individual-service intent.
 * @param authority - Optional original author/worker authority, never renderer-supplied.
 * @param signal - Optional caller cancellation.
 * @returns Fresh supply state after merging into committed policy in the controller queue.
 */
updateOwnerSupply(command: OwnerSupplyCommand, authority?: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot>

/** Read the current account's advertised task types, not live node inventory.
 * @param signal - Caller cancellation bound to the upstream request.
 * @returns Advertised capabilities from the configured core.
 */
capabilities(signal?: AbortSignal): Promise<ComputeCapability[]>

/**
 * Owner-selected input bytes stay on the PC and go directly to COS; this creates no task.
 * @param input - Owner-selected filename, content type and bytes for direct PC-to-storage upload.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns Verified direct-storage input metadata; upload alone creates no task.
 */
uploadInputFile(input: { filename: string; contentType: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<PlanInputFile>

/**
 * Developer task input contracts for a product detail form. Missing forms are not guessed.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns Server task contracts with explicit form readiness; missing schemas stay missing.
 */
async taskTypes(signal?: AbortSignal): Promise<readonly { taskType: string; capabilityId: string; category: string; description: string; acceptedInputKinds: readonly string[]; defaultInputKind: string; requiredParams: readonly string[] | null; canQuoteInline: boolean; canQuoteFiles: boolean; formReady: boolean; paramsSchema: DeveloperTaskType['paramsSchema']; inputSchema: DeveloperTaskType['inputSchema'] }[]>

/** Read Shanghai's current registry and developer entry independently.
 * No item in either list proves a live worker, owner permission, quote or dispatch.
 * @param signal - Caller cancellation; it is never converted into an unknown result.
 * @returns Separate bounded observations; a failed read retains null items, not a false empty list.
 */
async capabilityDiscovery(signal?: AbortSignal): Promise<ComputeCapabilityDiscovery>

/** Read owner identity, copied money strings, and ledger rows. Missing money stays null.
 * @param include - Optional slice; omitted returns every section, still without invented totals.
 * @param signal - Caller cancellation bound to the upstream request.
 * @returns Balance and rewards as upstream strings or null; withdrawals are WITHDRAW rows only.
 */
async account(include?: string, signal?: AbortSignal): Promise<ComputeAccountSnapshot>

/** Ask the scheduler who declares one capability. Missing answers stay unknown, never an empty pool.
 * @param capability - Contract or scheduler capability id.
 * @param signal - Caller cancellation bound to the upstream request.
 * @returns Catalog membership, declared ads, and available-now ads as separate facts.
 */
async pool(capability: string, signal?: AbortSignal): Promise<CapabilityPoolSnapshot>

/** Read existing owner-visible local drafts.
 * @returns Locally stored planning drafts.
 */
plans(): Promise<ComputePlanDraft[]>

/** Create a draft only for a task type admitted by the live developer entry.
 * Semantic registry membership alone does not prove a requestable task.
 * @param input - Untrusted UI or model planning request.
 * @param signal - Cancellation checked again before the local commit.
 * @returns The newly persisted local draft.
 */
async createPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Persist a local chain card, or reuse an accepted recipe. This never quotes, submits, or charges.
 * @param input - Untrusted tool arguments; `currency` is filled by the tool consumer.
 * @param signal - Cancellation checked again before the local commit.
 * @returns A new draft, or a `hit` card whose steps came from the stored recipe.
 */
async createChain(input: unknown, signal?: AbortSignal): Promise<ComputeChainDraft>

/** Persist an owner chain decision. This never quotes, submits, or charges.
 * @param input - Untrusted `{ id, decision }` from a conversation card.
 * @param signal - Cancellation checked before the local commit.
 * @returns The updated chain card.
 */
async confirmChain(input: unknown, signal?: AbortSignal): Promise<ComputeChainDraft>

/** Record a due absence. Missing this write would make the timeout silent.
 * @param input - Untrusted `{ id }`.
 * @param signal - Cancellation checked before the local commit.
 * @returns The card after the stored absence policy is applied.
 */
async applyChainAbsence(input: unknown, signal?: AbortSignal): Promise<ComputeChainDraft>

/** Expand an approved chain into per-step local plan drafts. This never publishes or charges.
 * @param input - Untrusted `{ id }`.
 * @param signal - Cancellation checked before each local commit.
 * @returns The chain plus the local drafts. Drafts stay pending until the owner confirms each one.
 */
async expandChain(input: unknown, signal?: AbortSignal): Promise<{ chain: ComputeChainDraft; drafts: ComputePlanDraft[] }>

/** Look up an accepted local recipe. A miss is null so a model may compose.
 * @param input - Untrusted `{ recipe_id? , capabilities? , task_types? , media_kinds? }`.
 * @param signal - Cancellation checked before the file read.
 * @returns The accepted row, or null when nothing matches.
 */
async matchRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord | null>

/** Persist a settled chain from `result.status`. This never submits or charges.
 * @param input - Untrusted `{ status, steps, recipe_id?, verify? }`.
 * @param signal - Cancellation checked before the local commit.
 * @returns The stored recipe. `partial` never becomes a row.
 */
async settleRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord>

/** Demote a stored recipe to candidate so it stops auto-hitting.
 * @param input - Untrusted `{ sha256 }` or `{ recipe_id }`.
 * @param signal - Cancellation checked before the local commit.
 * @returns Updated rows.
 */
async rejectRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord[]>

/** Re-admit an `ok` candidate so it can auto-hit again.
 * @param input - Untrusted `{ sha256 }` or `{ recipe_id }`.
 * @param signal - Cancellation checked before the local commit.
 * @returns Updated rows.
 */
async acceptRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord[]>

/** Look up a previous deterministic processing result. Random chains miss.
 * @param input - Untrusted `{ steps, impls }`.
 * @param signal - Cancellation checked before the file read.
 * @returns The cached entry, or null on a miss.
 */
async lookupResultCache(input: unknown, signal?: AbortSignal): Promise<ComputeResultCacheEntry | null>

/** Store an ok deterministic result. This never submits or charges.
 * @param input - Untrusted `{ status, steps, impls, output }`.
 * @param signal - Cancellation checked before the local commit.
 * @returns The stored entry with matching output digest.
 */
async storeResultCache(input: unknown, signal?: AbortSignal): Promise<ComputeResultCacheEntry>

/** Drop the local processing cache. This never contacts the core.
 * @param signal - Cancellation checked before the directory is removed.
 * @returns The number of rows removed.
 */
async clearResultCache(signal?: AbortSignal): Promise<number>

/** Persist a local owner confirmation for the exact displayed execution price.
 * @param input - Untrusted `{ id, decision, quoteId }` from a conversation card.
 * @param signal - Cancellation checked before the local commit.
 * @returns The updated local draft.
 */
async confirmPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/**
 * Legacy model/local route: an approved draft alone cannot authorize a paid POST.
 * Existing submitted drafts remain readable, but first submission requires the separate
 * Host quote and explicit owner-confirmation method below.
 * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns The existing confirmed draft or a new server workload receipt; uncertain submission remains unresolved.
 */
async publishPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/**
 * Ask Shanghai to price the exact final developer task without creating an order.
 * The page receives only this bounded view. The ticket stays in the Host and is lost
 * on process restart; the owner then needs a fresh quote.
 * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns A bounded public quote view; its private ticket remains on the Host.
 */
async quotePlan(input: unknown, signal?: AbortSignal): Promise<DeveloperTaskQuoteView>

/**
 * Trusted Host action after the owner has seen and accepted this exact amount.
 * Do not expose this method as a model tool or unreviewed generic local route.
 * The caller must show the quote view and pass its opaque quoteId plus the amount displayed.
 * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns The existing submission or a workload created from the exact valid confirmed quote.
 */
async confirmQuotedPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Read a workload with the configured account; ownership is enforced by the core.
 * @param id - Workload identity provided by the user or a core receipt.
 * @param signal - Caller cancellation.
 * @returns Owner-visible workload summary.
 */
workload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadSummary>

/** Read owner-visible inline result text; this does not download artifacts or settle.
 * @param id - Workload identity provided by the user or a core receipt.
 * @param signal - Caller cancellation.
 * @returns Inline UTF-8 or an artifact reference from the developer-task result route.
 */
workloadResult(id: string, signal?: AbortSignal): Promise<ComputeWorkloadResult>

/**
 * Read the authenticated owner's current buyer-acceptance record without settling it.
 * @param id - The workload identity belonging to the authenticated owner.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns The current owner-visible buyer-acceptance record, or null if none exists.
 */
workloadAcceptance(id: string, signal?: AbortSignal): Promise<CoreBuyerAcceptance | null>

/**
 * Apply one explicit buyer decision with its idempotency key through the authoritative core.
 * @param id - The workload identity belonging to the authenticated owner.
 * @param decision - The explicitly chosen accept or reject decision.
 * @param idempotencyKey - The stable key for this explicitly requested buyer decision.
 * @param signal - Caller cancellation for this bounded operation.
 * @returns The server-confirmed decision for the selected owner workload.
 */
decideWorkloadAcceptance(id: string, decision: 'accept' | 'reject', idempotencyKey: string, signal?: AbortSignal): Promise<CoreBuyerAcceptance>

/**
 * Cancel one owner workload and report what actually happened to the money.
 *
 * Three cases, each answered explicitly instead of being lumped into one upstream error:
 *
 * - still running: the scheduler's `DELETE` decides, and the ledger tail is read back so the
 *   caller gets the refund fact rather than a balance projection that lags (AT-03 measured the
 *   projection still showing the old figure in the same second the refund was written);
 * - already cancelled: **idempotent** — the same request is answered with the same terminal state
 *   and the same refund rows, and no second upstream call is made, so no second refund is possible;
 * - already finished (`DONE`/`FAILED`): refused with `COMPUTE_WORKLOAD_ALREADY_TERMINAL`, and the
 *   state is left untouched.
 * @param id - Workload identity provided by the user or a core receipt.
 * @param signal - Caller cancellation.
 * @returns Terminal state plus the ledger rows this workload produced.
 */
async cancelWorkload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadCancellation>

/** Execute one already-admitted assignment through an exact local plugin version.
 * @param task - Versioned assignment received from the dispatch layer.
 * @param request - Controlled input provider, workspace limits, cancellation and result consumer.
 * @returns Result-consumer receipt after all local workspace files have been cleaned up.
 */
executeTask<T>(task: ComputeTaskEnvelope, request: ComputeLocalTaskRequest<T>): Promise<T>

/** Read a local task attempt without treating it as a remote completion receipt.
 * @param taskId - Local task identity.
 * @param attempt - Attempt number.
 * @returns Stored attempt state, or null when absent.
 */
task(taskId: string, attempt: number): Promise<ComputeTaskState | null>

/** Persist one lifecycle event for a local task attempt.
 * @param taskId - Local task identity.
 * @param attempt - Attempt number.
 * @param event - Lifecycle event to apply.
 * @param now - Canonical current UTC timestamp.
 * @returns Updated persisted attempt state.
 */
transitionTask(taskId: string, attempt: number, event: ComputeTaskEvent, now: string): Promise<ComputeTaskState>

/** Admit one verified passive offer through the unified scheduler and task store.
 * @param input - Verified offer and current scheduling context.
 * @returns Admission decision and persisted state when accepted.
 */
coordinateTask(input: EmployeeTaskCoordinateInput): Promise<EmployeeTaskCoordinationResult>

/** Cancel core reads and drain accepted local writes on plugin removal. */
async close(): Promise<void>
```

Types: [CapabilityPoolSnapshot](../../packages/host/compute-core/README.md#use-this-package) · [ComfyDraftAssetSummary](../../packages/host/compute-core/README.md#use-this-package) · [ComfyTrialRecord](../../packages/host/compute-core/README.md#use-this-package) · [ComputeAccountSnapshot](../../packages/host/compute-core/README.md#use-this-package) · [ComputeCapability](../../packages/host/compute-core/README.md#use-this-package) · [ComputeCapabilityDiscovery](../../packages/host/compute-core/README.md#use-this-package) · [ComputeChainDraft](../../packages/host/compute-core/README.md#use-this-package) · [ComputeConnectionState](../../packages/host/compute-core/README.md#use-this-package) · [ComputeLocalTaskRequest](../../packages/host/compute-core/README.md#use-this-package) · [ComputePlanDraft](../../packages/host/compute-core/README.md#use-this-package) · [ComputeRecipeRecord](../../packages/host/compute-core/README.md#use-this-package) · [ComputeResultCacheEntry](../../packages/host/compute-core/README.md#use-this-package) · [ComputeTaskEnvelope](../../packages/host/compute-core/README.md#use-this-package) · [ComputeTaskEvent](../../packages/host/compute-core/README.md#use-this-package) · [ComputeTaskState](../../packages/host/compute-core/README.md#use-this-package) · [ComputeWorkloadCancellation](../../packages/host/compute-core/README.md#use-this-package) · [ComputeWorkloadResult](../../packages/host/compute-core/README.md#use-this-package) · [ComputeWorkloadSummary](../../packages/host/compute-core/README.md#use-this-package) · [CoreBuyerAcceptance](../../packages/host/compute-core/README.md#use-this-package) · [CoreNodeDashboard](../../packages/host/compute-core/README.md#use-this-package) · [DeveloperTaskQuoteView](../../packages/host/compute-core/README.md#use-this-package) · [DeveloperTaskType](../../packages/host/compute-core/README.md#use-this-package) · [EmployeeTaskCoordinateInput](../../packages/host/compute-core/README.md#use-this-package) · [EmployeeTaskCoordinationResult](../../packages/host/compute-core/README.md#use-this-package) · [GuangzhouAccountState](../../packages/host/compute-core/README.md#use-this-package) · [HostPluginAdapterListing](../../packages/host/compute-core/README.md#use-this-package) · [HostPluginSampleAdapter](../../packages/host/compute-core/README.md#use-this-package) · [ListedLocalPluginCandidate](../../packages/host/compute-core/README.md#use-this-package) · [LocalPluginCandidate](../../packages/host/compute-core/README.md#use-this-package) · [LocalPluginDraft](../../packages/host/compute-core/README.md#use-this-package) · [NaturalRouteDecision](../../packages/host/compute-core/README.md#use-this-package) · [ObservedSupplyServices](../../packages/host/compute-core/src/supply/README.md) · [OwnerSupplyCommand](../../packages/host/compute-core/src/supply/README.md) · [PlanInputFile](../../packages/host/compute-core/README.md#use-this-package) · [PluginDraftExport](../../packages/host/compute-core/README.md#use-this-package) · [PluginDraftPackagePreview](../../packages/host/compute-core/README.md#use-this-package) · [PreparedPrivatePluginSubmission](../../packages/host/compute-core/README.md#use-this-package) · [PrivateComfyDraftAsset](../../packages/host/compute-core/README.md#use-this-package) · [PrivateComfyTrialInput](../../packages/host/compute-core/README.md#use-this-package) · [PrivateComfyTrialReceipt](../../packages/host/compute-core/README.md#use-this-package) · [PrivateComfyTrialReconciliation](../../packages/host/compute-core/README.md#use-this-package) · [PrivateOfflinePluginArtifactSummary](../../packages/host/compute-core/README.md#use-this-package) · [PrivatePluginActivationRecord](../../packages/host/compute-core/README.md#use-this-package) · [PrivatePluginActivationSummary](../../packages/host/compute-core/README.md#use-this-package) · [PrivatePluginOperationResult](../../packages/host/compute-core/README.md#use-this-package) · [PrivatePluginSampleRun](../../packages/host/compute-core/README.md#use-this-package) · [SupplyPolicy](../../packages/host/compute-core/src/supply/README.md) · [SupplyPolicyWriteAuthority](../../packages/host/compute-core/src/supply/README.md) · [SupplySnapshot](../../packages/host/compute-core/src/supply/README.md) · [VerifiedReviewableExecutionArtifact](../../packages/host/compute-core/README.md#use-this-package)

Source: [`packages/host/compute-core/src/service.ts`](../../packages/host/compute-core/src/service.ts)

<a id="ctxmacdrawnvideofactory--macdrawnvideofactory"></a>

### `ctx.macDrawnVideoFactory` — `MacDrawnVideoFactory`

A package gets no path, model, network, or task parameters when activating this fixed capability.

```ts cordis-catalog
/**
 * Create only the fixed reviewed Mac video capability using checked local tools.
 * @returns The fixed five-second Mac video executor; unavailable local tools cause an error.
 */
create(): ComputeExecutor
```

Source: [`packages/host/compute-core/src/mac-drawn-video-factory.ts`](../../packages/host/compute-core/src/mac-drawn-video-factory.ts)

<a id="ctxqianshouaccount--qianshouaccount"></a>

### `ctx.qianshouAccount` — `QianshouAccount`

Host service; no method returns passwords, tokens or the private TOTP challenge.

```ts cordis-catalog
/**
 * Read a safe account status without performing a network request.
 * @returns The current non-secret account status and route selection.
 */
@Remote async state(): Promise<AccountSnapshot>

/**
 * Ask Shanghai to send a phone code without replacing the current account.
 * @param phone - User-entered mainland number.
 * @param purpose - Login or new-account registration.
 * @returns The detached, non-secret account status after the operation.
 */
@Remote async sendPhoneCode(phone: string, purpose?: 'login' | 'register'): Promise<AccountSnapshot>

/**
 * Sign in with a phone code, then select the Guangzhou cloud route when the account is verified.
 * @param phone - User-entered mainland number.
 * @param code - User-entered six-digit SMS code.
 * @returns The detached, non-secret account status after the operation.
 */
@Remote async loginWithPhone(phone: string, code: string): Promise<AccountSnapshot>

/**
 * Register through Shanghai's verified phone flow and select the cloud route after authentication.
 * @param phone - User-entered mainland number.
 * @param code - Registration SMS code.
 * @returns The detached account status.
 */
@Remote async registerWithPhone(phone: string, code: string): Promise<AccountSnapshot>

/**
 * Sign in through the authoritative account service, then select the Guangzhou cloud route.
 * @param username - Account name or email.
 * @param password - Ephemeral password submitted only to the account authority.
 * @returns The detached, non-secret account status after the operation.
 */
@Remote async login(username: string, password: string): Promise<AccountSnapshot>

/**
 * Complete the Host-owned pending challenge without sending its token to the browser.
 * @param code - User-entered six-digit TOTP code.
 * @param trustDevice - Whether the authority may retain trust for this device.
 * @returns The detached, non-secret account status after the operation.
 */
@Remote async completeTotp(code: string, trustDevice: boolean): Promise<AccountSnapshot>

/**
 * Cancel an authorization attempt and discard any partially stored login.
 * @returns The detached, non-secret account status after the operation.
 */
@Remote async cancel(): Promise<AccountSnapshot>

/**
 * Refresh if necessary, verify identity, and read the authenticated Guangzhou model catalog.
 * @returns The detached, non-secret account status after the operation.
 */
@Remote async reconnect(): Promise<AccountSnapshot>

/**
 * Read the signed-in plan, five-hour window, and RMB wallet.
 * @returns Server-reported commerce figures.
 */
@Remote async billing(): Promise<AccountCommerce>

/**
 * Price one month of a plan without debiting the wallet.
 * @param tier - `basic`, `plus`, or `max`.
 * @returns The commerce view including the unpaid quote.
 */
@Remote async quotePlan(tier: string): Promise<AccountCommerce>

/**
 * Pay the quote last shown to this account.
 * @returns The commerce view after the purchase attempt.
 */
@Remote async buyPlan(): Promise<AccountCommerce>

/**
 * Start an Alipay recharge. The browser submits the returned page.
 * @param amount - Yuan amount entered by the user.
 * @returns Reviewed Alipay fields.
 * @param idempotencyKey - The account-bound key for this explicitly requested recharge.
 * @param replay - Explicit replay intent; unavailable idempotency support must not create a duplicate.
 */
@Remote async startRecharge(amount: string, idempotencyKey: string, replay: boolean): Promise<AccountAlipayStart>

/**
 * Read the real WeChat Native channel state; missing configuration stays unavailable.
 * @returns The configured Native payment channel availability, without creating an order.
 */
@Remote async wechatChannel(): Promise<AccountWechatChannel>

/**
 * Create one user-requested Native recharge. Never automatically retries an unknown create.
 * @param amount - The user-entered recharge amount in CNY.
 * @param idempotencyKey - The account-bound key for this explicitly requested recharge.
 * @param replay - Explicit replay intent; unavailable idempotency support must not create a duplicate.
 * @returns The original Native recharge instruction, or an explicit rejection.
 */
@Remote async startWechatRecharge(amount: string, idempotencyKey: string, replay: boolean): Promise<AccountWechatStart>

/**
 * Check only the signed-in owner's existing order.
 * @param orderNo - The existing order identifier belonging to the current signed-in account.
 * @returns The current owner-bound order and its payment status.
 */
@Remote async wechatOrder(orderNo: string): Promise<AccountWechatOrder>

/**
 * Reconcile the original owner-bound order through Shanghai's WeChat query.
 * @param orderNo - The existing order identifier belonging to the current signed-in account.
 * @returns The reconciled status of the same original owner-bound order.
 */
@Remote async wechatOrderRefresh(orderNo: string): Promise<AccountWechatOrder>

/**
 * Read a bounded order list so an ambiguous create can find its original order.
 * @returns The bounded list of the current account's Native recharge orders.
 */
@Remote async wechatOrders(): Promise<AccountWechatOrder[]>

/**
 * Regenerate only the original pending order's Native QR instruction.
 * @param orderNo - The existing order identifier belonging to the current signed-in account.
 * @returns The original pending order with its current Native QR instruction.
 */
@Remote async wechatOrderPayment(orderNo: string): Promise<AccountWechatOrder>

/**
 * Check only this account's original Alipay order; browser return is not payment truth.
 * @param orderNo - The existing order identifier belonging to the current signed-in account.
 * @returns The original account-bound order and server-reported payment status.
 */
@Remote async alipayOrder(orderNo: string): Promise<AccountRechargeOrder>

/**
 * Recover an ambiguous Alipay creation without issuing a second payment order.
 * @returns The current account's existing recharge orders, without creating another.
 */
@Remote async alipayOrders(): Promise<AccountRechargeOrder[]>

/**
 * Get cashier instructions only for the signed-in owner's pending order.
 * @param orderNo - The existing order identifier belonging to the current signed-in account.
 * @param amount - The user-entered recharge amount in CNY.
 * @returns Cashier instructions for the same pending account-bound order.
 */
@Remote async alipayOrderPayment(orderNo: string, amount: string): Promise<AccountPayment>

/**
 * Revoke the captured account session and clear only this plugin's local credentials.
 * @returns The detached, non-secret account status after the operation.
 */
@Remote async logout(): Promise<AccountSnapshot>

/**
 * Configure the authenticated cloud route and default for new or unconfigured empty sessions.
 * @returns The current non-secret account status and route selection.
 */
@Remote async useCloud(): Promise<AccountSnapshot>
```

Source: [`packages/host/qianshou-account/src/index.ts`](../../packages/host/qianshou-account/src/index.ts)

<a id="ctxqianshoucapability--qianshoucapability"></a>

### `ctx.qianshouCapability` — `QianshouCapability`

Host-side capability reads; every failure is a named state, never an empty catalog.

```ts cordis-catalog
/**
 * Layer 1 for the whole catalog: what the Shanghai registry lists. Listed is not runnable.
 * @returns `signed-out` without any request, `catalog-only` entries, or a named failure.
 */
@Remote async catalog(): Promise<CatalogView>

/**
 * Layer 1 for one capability: catalog membership plus declared and available-now counts.
 * @param capabilityId - Registry capability id; validated against the name grammar before any request.
 * @returns `signed-out`, `catalog-only` with counts, or `unavailable` including `not-in-catalog`.
 */
@Remote async availability(capabilityId: string): Promise<AvailabilityView>

/**
 * Layer 2: the server's estimate for one capability. The result is `estimate-only`; it carries no
 * quote id, locks no price and reserves no funds. The local budget cap is echoed, never posted.
 * @param capabilityId - Registry capability id with at least one `legacy_task_types` landing.
 * @param intent - `goal` and nullable `budget` validated against the `qianshou/intent/v1` copy.
 * @returns `signed-out`, `estimate-only` with server decimals and field provenance, or a named failure.
 */
@Remote async estimate(capabilityId: string, intent: EstimateIntent): Promise<EstimateView>
```

Source: [`packages/host/qianshou-capability/src/index.ts`](../../packages/host/qianshou-capability/src/index.ts)

<a id="ctxqianshoulegaldocumentruntime--legaldocumentruntime"></a>

### `ctx.qianshouLegalDocumentRuntime` — `LegalDocumentRuntime`

Installed local legal-provider entry; readiness does not register market dispatch.

```ts cordis-catalog
/**
 * Read local execution readiness without inferring market availability.
 * @returns Local provider readiness and the separate, unregistered market-dispatch status.
 */
state(): { localExecution: 'disabled' | 'checking' | 'ready' | 'unavailable'; marketDispatch: 'not-registered' }

/**
 * Installed Host port: requires admitted lease metadata and its authenticated grant provider.
 * @param admission - Authenticated lease and assignment metadata bound to this legal task.
 * @param request - The task request, authenticated file grants, cancellation, and result handling.
 * @returns The admitted task result; unavailable providers or invalid assignments reject.
 */
runAssignedTask<T>(admission: LegalDocumentAdmission, request: LegalAssignedTaskRequest<T>): Promise<T>
```

Source: [`packages/host/compute-core/src/legal-document-plugin.ts`](../../packages/host/compute-core/src/legal-document-plugin.ts)

<a id="ctxqianshoumemory--qianshoumemory"></a>

### `ctx.qianshouMemory` — `QianshouMemory`

Authoritative device vault, consumed by authenticated owner RPCs and scoped tools.

```ts cordis-catalog
/**
 * Read vault identity and registered destinations without requiring a cloud login.
 * @returns Local metadata.
 */
@Remote async state(): Promise<MemoryState>

/**
 * Browse owner-visible records.
 * @param query - Bounded owner filters.
 * @returns Summaries and counts.
 */
@Remote async list(query: MemoryQuery): Promise<MemoryPage>

/**
 * Read an owner record with historical revisions.
 * @param id - Entry id.
 * @returns Original and versions.
 */
@Remote async read(id: string): Promise<MemoryDetail>

/**
 * Read at most two previous versions without transferring the whole retained history.
 * @param value - Current record fence.
 * @param offset - History offset.
 * @returns Bounded owner history.
 */
@Remote async history(value: MemoryRevision, offset: number): Promise<MemoryHistoryPage>

/**
 * Commit a draft, preserving existing text on stale revisions.
 * @param value - Explicit owner draft.
 * @returns Committed entry.
 */
@Remote async save(value: MemoryInput): Promise<MemoryEntry>

/**
 * Accept or reject a candidate as the authenticated local owner.
 * @param value - Decision with revision.
 * @returns Saved entry or deletion.
 */
@Remote async review(value: MemoryReview): Promise<MemoryEntry | { deleted: true }>

/**
 * Erase one unchanged record and every retained version/index row.
 * @param value - Identifier and expected revision.
 * @returns Deletion receipt.
 */
@Remote async delete(value: MemoryRevision): Promise<{ deleted: true }>

/**
 * Read one bounded export page; later pages must retain its revision.
 * @param value - Export cursor.
 * @returns Consistent export page.
 */
@Remote async exportPage(value: MemoryExportQuery): Promise<MemoryExportPage>

/**
 * Retrieve confirmed content under the actual Session workspace.
 * @param session - Tool caller.
 * @param query - Model filters, bounded by the tool.
 * @param signal - Tool cancellation.
 * @returns Accessible summaries only.
 */
async searchForSession(session: Session, query: MemoryQuery, signal: AbortSignal): Promise<MemoryPage>

/**
 * Read an accessible original without revision history.
 * @param session - Tool caller.
 * @param id - Model record id.
 * @param signal - Tool cancellation.
 * @returns Confirmed scoped original.
 */
async readForSession(session: Session, id: string, signal: AbortSignal): Promise<MemoryDetail>

/**
 * Propose an experience for human review in the actual current workspace.
 * @param session - Tool caller.
 * @param callId - Runtime tool call identity.
 * @param value - Model proposal fields.
 * @param signal - Tool cancellation.
 * @returns Durable candidate.
 */
async proposeForSession(session: Session, callId: MemoryOrigin['callId'], value: Pick<MemoryInput, 'title' | 'content' | 'evidence'>, signal: AbortSignal): Promise<MemoryEntry>
```

Types: [Session](session.md)

Source: [`packages/host/qianshou-memory/src/index.ts`](../../packages/host/qianshou-memory/src/index.ts)

<a id="ctxqianshoumobilesync--qianshoumobilesync"></a>

### `ctx.qianshouMobileSync` — `QianshouMobileSync`

Host Remote exposing only whitelisted diagnostics; no method returns a token, lease or message text.

```ts cordis-catalog
/**
 * Whitelisted diagnostics for the owner UI and `qianshou:doctor`.
 * @returns PC id, registration state and heartbeat facts; never a credential.
 */
@Remote async status(): Promise<MobileSyncStatus>
```

Source: [`packages/host/qianshou-mobile-sync/src/index.ts`](../../packages/host/qianshou-mobile-sync/src/index.ts)

<a id="ctxqianshouplugincatalog--qianshouplugincatalog"></a>

### `ctx.qianshouPluginCatalog` — `QianshouPluginCatalog`

Market install records a capability declaration. `search` does not install packages or read account credentials.

```ts cordis-catalog
/**
 * Host-only location for the offline private seed; never a market entitlement.
 * @returns The configured local seed installation directory.
 */
offlineCsvSeedHome(): string

/**
 * The reviewed market tool is unavailable until an operator sets an API origin and both
 * independent trust roots. Shipped discovery never silently becomes an online market.
 * @returns The explicitly configured API and trust roots, or null when unavailable.
 */
reviewedSeedHostConfig(): ReviewedSeedHostConfig | null

/** Read current setup or inspect explicitly chosen files without rendering.
 * @param selection - Local file choices, omitted for the first-screen state.
 * @returns Current owner-local state or a short-lived save inspection.
 */
@Remote inspectH3OwnerSetup(selection?: H3OwnerSetupSelection): Promise<H3OwnerSetupInspectResult>

/** Save only the inspected current revision; no GPU, publication or supply grant occurs.
 * @param request - One single-use inspection and expected managed revision.
 * @returns Saved revision without private paths or credentials.
 */
@Remote saveH3OwnerSetup(request: H3OwnerSetupSaveRequest): Promise<H3OwnerSetupSaveResult>

/** Explicitly start one local five-second video trial; this is not platform approval.
 * @param request - Current revision and bounded Chinese prompt.
 * @returns Retained operation state; an unknown operation is never automatically retried.
 */
@Remote startH3OwnerSelfTest(request: H3OwnerSelfTestRequest): Promise<H3OwnerSelfTestStatus>

/** Read the current author's retained local trial without starting work.
 * @param operationId - Opaque id returned by explicit trial start.
 * @returns Local pending, unknown, failed or verified state.
 */
@Remote h3OwnerSelfTestStatus(operationId: H3OwnerSelfTestId): Promise<H3OwnerSelfTestStatus>

/** Create five validated local skill files from a real current trial, without cloud writes.
 * @param request - Current revision and local skill display text.
 * @returns Local draft state; publication and supply permission remain separate actions.
 */
@Remote createH3SkillDraft(request: H3SkillDraftRequest): Promise<H3SkillDraftResult>

/**
 * Read a signed exact release and current account presence without claiming a license or
 * downloading an archive. The installed state is deliberately not inferred from a file.
 * @returns Verified release metadata and account presence, without claiming ownership.
 */
@Remote async officialCsvSeedStatus(): Promise<OfficialCsvSeedMarketStatus>

/**
 * One explicit PC market action for the fixed free data-only seed. The browser confirms the
 * identity shown to the owner; Host rechecks account, online grant, signatures and package.
 * @param request - The fixed reviewed seed identity explicitly confirmed by the current owner.
 * @returns The verified local seed installation and its account-bound grant.
 */
@Remote async installOfficialCsvSeedForOwner(request: OfficialCsvSeedInstallRequest): Promise<OfficialCsvSeedInstallResult>

/**
 * Read byte-verified private candidate packages from the Host. This does not install or publish.
 * @returns Byte-verified private candidates available on this Host.
 */
@Remote async localCandidates(): Promise<LocalPluginCandidates>

/**
 * Compare installed bytes with a currently verified candidate. Order sampling also requires its adapter.
 * @param request - The byte-verified candidate identity to compare with installed files.
 * @returns Whether the current installed bytes match the selected candidate.
 */
@Remote async checkLocalCandidateInstall(request: { draftId: string packageDigest: string /** Local use may omit the order adapter; order publication keeps the strict default. */ requireOrderAdapter?: false }): Promise<LocalCandidateInstallCheck>

/**
 * Read only the author's local review notes for this still-current candidate.
 * @param request - The current candidate draft identifier and package digest.
 * @returns The matching local review notes, or null when none were saved.
 */
@Remote async localOrderPublicationDraft(request: { draftId: string; packageDigest: string }): Promise<LocalOrderPublicationDraft | null>

/**
 * Save metadata only under DSH_HOME; no code, entitlement, grant or Shanghai request is created.
 * @param request - Candidate-bound author metadata to save locally.
 * @returns The saved candidate-bound metadata; no platform submission is made.
 */
@Remote async saveLocalOrderPublicationDraft(request: LocalOrderPublicationDraftInput): Promise<LocalOrderPublicationDraft>

/**
 * Read display controls from accessible signed legacy examples; no source is installed or run.
 * @param request - Exact market product, task, product version and artifact digest.
 * @returns Presentation metadata only; the signed input schema and payment confirmation remain unchanged.
 */
@Remote async readMarketOrderInputPresentation(request: MarketOrderInputPresentationRequest): Promise<MarketOrderInputPresentation>

/**
 * Read the exact scanned source's input declaration without running, normalizing or contacting a platform.
 * @param request - The scanned user root and exact skill name.
 * @returns The current source digest, task declaration, and supported local input form.
 */
@Remote async readInstalledOrderSkillTrial(request: { source: 'user-dsh' | 'user-agents'; name: string }): Promise<LocalSkillTrialDefinition>

/**
 * Local trial uses the same bounded executor as published orders and never needs login.
 * @param request - The current local skill, expected artifact digest, and validated input JSON.
 * @returns The actual output JSON, artifact digest, task type, and elapsed milliseconds.
 */
@Remote async tryInstalledOrderSkill(request: LocalSkillTrialRequest): Promise<{ outputJson: string; artifactDigest: string; taskType: string; elapsedMs: number }>

/**
 * Quote one canonical task definition without publishing or claiming approval.
 * @param request - The scanned skill identity and exact current task-definition digest.
 * @returns The current server price and task-definition identity for confirmation.
 */
@Remote async previewInstalledOrderSkillPrice(request: { source: 'user-dsh' | 'user-agents'; name: string }): Promise<OrderSkillPricePreview>

/**
 * Install/self-test one registered adapter and submit its exact bytes for independent platform review.
 * @param request - The scanned source, display metadata, sale terms, and confirmed execution price.
 * @returns The exact package submission and platform review state.
 */
@Remote async submitInstalledOrderSkill(request: SubmitOrderSkillRequest): Promise<SubmittedOrderSkill>

/**
 * Retry only the source archive for the same account, package digest and publication id.
 * @param request - The current account's existing publication and exact package digest.
 * @returns The same publication with its source-archive transfer status.
 */
@Remote async retryInstalledOrderSkillArchive(request: { source: 'user-dsh' | 'user-agents'; name: string }): Promise<SubmittedOrderSkill>

/**
 * Retry the idempotent review sample after the exact archive was confirmed.
 * @param request - The existing publication whose exact source archive is already confirmed.
 * @returns The platform's sample verification state for the existing publication.
 */
@Remote async startOrderReviewSamples(request: { publicationId: string }): Promise<OrderReviewSampleStatus>

/**
 * Identify registered, intact local adapters without preparing a runtime, changing grants, or contacting Shanghai.
 * @returns The intact local declarations and their source-bound eligibility.
 */
@Remote async localOrderSkillEligibility(): Promise<{ items: LocalOrderSkillEligibility[] }>

/**
 * Restore author review state from Shanghai, matched to the current skill source digest.
 * @param request - Whether to include unmatched or archived platform history for cloud management.
 * @returns Current matching review records and explicitly requested cloud history.
 */
@Remote async myOrderSkillPublications(request?: { includeArchived?: boolean }): Promise<{ items: MyOrderSkillPublication[] }>

/**
 * Author actions use the current JWT and exact cloud record; no client owner is accepted.
 * @param request - The exact publication, locked version, and requested author action.
 * @returns The platform receipt for the requested author lifecycle action.
 */
@Remote async manageOrderSkillPublication(request: ManageOrderSkillPublicationRequest): Promise<OrderPublicationLifecycleReceipt>

/**
 * Only independently approved and published products appear. This read does not touch an account.
 * @returns The independently approved, published product metadata.
 */
@Remote async orderAdapterProducts(): Promise<{ products: OrderAdapterProduct[] }>

/**
 * The author's own product application state is always read from Shanghai.
 * @returns The current author's server-held product applications.
 */
@Remote async mySellerOrderProducts(): Promise<{ items: SellerOrderProduct[] }>

/**
 * Submit an approved skill for separate goods review with an explicit one-time CNY sale price.
 * @param request - The approved skill and explicitly chosen one-time CNY sale price.
 * @returns The product application and its independent goods-review state.
 */
@Remote async submitSellerOrderProduct(request: { publicationId: string; salePriceYuan: string }): Promise<SellerOrderProduct>

/**
 * Recover server-held buyer ownership and this worker's receipt after a client restart.
 * @returns The current account's entitlements and device installation receipts.
 */
@Remote async myPurchasedOrderAdapters(): Promise<{ items: OrderAdapterBuyerEntitlement[] }>

/** Recheck current authenticated native provider bindings; this method is Host-only.
 * @param workerId - The worker acknowledged by this profile's authenticated Edge socket.
 * @returns Exact current owner/device publications with purpose-verified process credentials.
 */
async verifiedNativeH3OrderBindings(workerId: string): Promise<NativeH3CatalogBinding[]>

/**
 * File provider requires current server installation plus separately enrolled, device-scoped file proof.
 * @param workerId - The exact worker whose device receipt and installed runtime must be rechecked.
 * @returns The currently authorized, byte-verified file runtime declarations.
 */
async verifiedPurchasedFileOrderRuntimes(workerId: string): Promise<VerifiedPurchasedFileOrderRuntime[]>

/**
 * Run only the advertised file declaration using connection-owned lease ports and direct storage.
 * @param input - The exact advertised runtime identity and its current admitted execution request.
 * @returns The admitted file artifact produced by the exact advertised runtime.
 */
async runPurchasedFileOrderRuntime(input: { workerId: string productId: string entitlementId: string taskType: string artifactDigest: string runtimeDigest: string contractSha256: string fileSchemaSha256: string inlineInput: string fileContract: EdgeFileContract ports: FileOrderRuntimePorts signal: AbortSignal }): Promise<GenericFileArtifact>

/**
 * Recheck Shanghai ownership, exact device receipt and installed bytes before each Hello.
 * @param workerId - The exact worker whose device receipt and installed runtime must be rechecked.
 * @returns The exact installed inline runtimes allowed for this worker.
 */
async verifiedPurchasedOrderRuntimes(workerId: string): Promise<VerifiedPurchasedOrderRuntime[]>

/**
 * Legacy API stays empty: authors now require the same device-scoped receipt as buyers.
 * @param _workerId - Legacy worker identifier; it does not authorize author-only execution.
 * @returns An empty list; author approval alone grants no device execution.
 */
async verifiedAuthorOrderRuntimes(_workerId: string): Promise<Array<{ taskType: string capabilityId: string outputKind: 'inline_json' artifactDigest: string packageDigest: string contractVersion: 'v1' }>>

/**
 * An approval alone never authorizes local execution or a worker Hello.
 * @param _input - Legacy author-only request, which is rejected without a device receipt.
 * @returns No successful result; this legacy author-only execution path rejects.
 */
runAuthorOrderRuntime(_input: { workerId: string taskType: string artifactDigest: string packageDigest: string inlineInput: string signal: AbortSignal }): Promise<{ text: string }>

/**
 * Execute only the exact runtime that this worker previously advertised.
 * @param input - The exact advertised runtime identity and its current admitted execution request.
 * @returns The bounded output JSON text from the exact advertised inline runtime.
 */
async runPurchasedOrderRuntime(input: { workerId: string productId: string entitlementId: string taskType: string artifactDigest: string runtimeDigest: string inlineInput: string signal: AbortSignal }): Promise<{ text: string }>

/**
 * Task types group official and independently reviewed user offers; this is metadata, never an order.
 * @returns The current grouped task metadata, without creating an order.
 */
@Remote async orderAdapterCapabilities(): Promise<{ capabilities: MarketCapability[] }>

/**
 * Local readiness only. The product listing and purchase endpoint independently check live service health.
 * @returns Local readiness and its specific missing prerequisite, if any.
 */
@Remote orderAdapterBuyerReadiness(): { ready: boolean reason: 'unsupported-platform' | 'configuration-missing' | 'node-offline' | null }

/**
 * Explicit account purchase. Its receipt proves only an account entitlement.
 * @param request - The exact product purchase explicitly confirmed by the signed-in account.
 * @returns The account purchase entitlement; device installation is separate.
 */
@Remote async purchaseOrderAdapterProduct(request: { productId: string; idempotencyKey: string }): Promise<OrderAdapterEntitlement>

/**
 * Verify the signed source inventory; archive download, device install and activation remain separate.
 * @param request - The selected product and entitlement whose signed inventory is required.
 * @returns The verified source inventory and its installation prerequisites.
 */
@Remote async checkOrderAdapterInstallManifest(request: { productId: string }): Promise<OrderAdapterInstallCheck>

/**
 * Verify and quarantine reviewed source bytes. No downloaded source is executed or activated.
 * @param request - The exact product and entitlement to verify and quarantine.
 * @returns The quarantined, verified source archive; no source is executed.
 */
@Remote async stageOrderAdapterProductSource(request: { productId: string }): Promise<OrderAdapterSourceStage>

/**
 * Install signed v5 source into a private runtime and run its actual examples; platform acceptance remains separate.
 * @param request - The selected signed source and entitlement for local installation.
 * @returns The locally installed runtime and actual example verification results.
 */
@Remote async installOrderAdapterProductLocally(request: { productId: string }): Promise<OrderAdapterLocalInstall>

/**
 * One buyer click: real local install, central challenge, independent proof, then committed device receipt.
 * @param request - The purchased product and exact installation identity confirmed by the buyer.
 * @returns The committed device receipt after installation and independent proof.
 */
@Remote async activatePurchasedOrderAdapter(request: { productId: string }): Promise<{ productId: string deviceId: string runtimeDigest: string deviceInstalled: true dispatchEligible: true }>

/**
 * Enable an author's exact published skill using the normal signed installation and device proof.
 * @param request - Controlled local skill identity selected by its owner.
 * @returns Committed device identity and the saved owner supply grant; idle admission remains separate.
 */
@Remote async activateAuthorOrderSkill(request: { source: 'user-dsh' | 'user-agents'; name: string }): Promise<AuthorOrderSkillActivation>

/**
 * Query public metadata only after an owner opens discovery or submits a search.
 * @param query - Search terms and bounded page offset.
 * @returns Real bundle declarations, source and partial-failure counts.
 */
@Remote async search(query: CatalogQuery): Promise<CatalogPage>

/**
 * List the market for the PC client. Shipped mode does not use the network.
 * @returns Presented listings. A capability this node cannot accept is not installable.
 */
@Remote async listings(): Promise<MarketCatalog>

/**
 * Surface only bundled, reviewed private starter paths; neither is an online product or order capability.
 * @returns Only the reviewed bundled starter locations available on this Host.
 */
@Remote async reviewedLocalStarters(): Promise<ReviewedLocalStarters>

/**
 * Read only live generic private activations. These are not Guangzhou listings or Shanghai supply.
 * @returns The current live private plugin activations, separate from market supply.
 */
@Remote async privatePluginActivations(): Promise<PrivatePluginActivations>

/**
 * Show the exact redacted declaration and account. The package bytes never cross Remote.
 * @param request - The local candidate identity whose declaration will be shown.
 * @returns The redacted declaration and captured account for confirmation.
 */
@Remote async previewPrivatePluginSubmission(request: PrivatePluginSubmissionPrepareRequest): Promise<PrivatePluginSubmissionPreview>

/**
 * Recreate the package and bind the one-click confirmation to its SHA and account before one POST.
 * @param request - The exact package digest and account captured by the prior confirmation.
 * @returns The account-bound platform receipt for the exact confirmed package.
 */
@Remote async submitPrivatePluginSubmission(request: PrivatePluginSubmissionConfirmRequest): Promise<PrivatePluginSubmissionResult>

/**
 * Read only the current signed-in owner's submission status; no releases or sales are inferred.
 * @returns The current owner's real submission records and read status.
 */
@Remote async myPrivatePluginSubmissions(): Promise<MyPrivatePluginSubmissionsView>

/**
 * Read declarations already saved on this computer.
 * @returns The declaration file. A missing file is an empty list.
 */
@Remote installed(): Promise<MarketInstalled>

/**
 * Read the current Host activity for saved rows without modifying the owner's drafts.
 * @returns The current Host installation activity for saved plugin rows.
 */
@Remote async installationActivity(): Promise<MarketInstallActivities>

/**
 * Read 我的能力: saved declarations plus any verified active private Mac video package.
 * Reading writes nothing and contacts neither Shanghai nor an invite endpoint.
 * @returns Local capabilities, the publish wizard's steps, and this computer's order policy.
 */
@Remote async myCapabilities(): Promise<MyCapabilities>

/**
 * Read active user plugins for a conversation without querying account, market or device purchase records.
 * @returns The active local conversation plugins with their display names and descriptions.
 */
@Remote async conversationPlugins(): Promise<{ id: string; title: string; description: string }[]>

/**
 * Enumerate real local installations; only a selected, self-tested task adapter may be authorized.
 * @returns Local installations, selected adapter, and current owner supply facts.
 */
@Remote async orderSources(): Promise<OrderSources>

/**
 * Explicitly choose one installed, contracted inline adapter. Service authorization is separate.
 * @param request - The installed, contracted adapter explicitly selected for node execution.
 * @returns The exact local selection and its current execution facts.
 */
@Remote async selectOrderSource(request: OrderSourceSelectionRequest): Promise<OrderSourceSelectionResult>

/**
 * Save the owner's master supply switch without changing per-service grants, rates or resource limits.
 * @param request - The owner's explicitly chosen master supply setting.
 * @returns The updated master switch with existing service grants and rates preserved.
 */
@Remote async setOwnerSupplyEnabled(request: CapabilitySupplySwitchRequest): Promise<CapabilityOrderFacts>

/**
 * Grant or revoke only this build's `node` text order service; never turn on the master mode.
 * @param request - The explicit grant or revocation for the local node text service.
 * @returns The updated node text-service grant without enabling the master switch.
 */
@Remote async setLocalServiceEnabled(request: CapabilityServiceSwitchRequest): Promise<CapabilityOrderFacts>

/**
 * Save one wizard draft. The first three steps — capability identity, run preflight and order
 * policy — save here, and what they save is a draft whatever the page asked for: only publish
 * changes who may see a declaration.
 * @param request - Market listing id, and the account ids this computer should invite.
 * @returns The row as saved.
 */
@Remote async saveCapabilityDraft(request: CapabilityDraftRequest): Promise<MarketInstallRecord>

/**
 * Publish one saved capability with the visibility the owner chose in the wizard's last step.
 * `public` is refused unless this call carries the owner's explicit confirmation, and it is the
 * only visibility the node hello repeats. Package-backed entries stay private drafts until
 * an exact order executor is registered and tested. Built-in entries rerun the four checks.
 * @param request - Market listing id, the chosen visibility, and the public confirmation.
 * @returns The row as saved.
 */
@Remote async publishCapability(request: PublishCapabilityRequest): Promise<MarketInstallRecord>

/**
 * Run the four install checks in order — signature, dependencies, model, resources — and write nothing.
 * @param request - Market listing id.
 * @returns The report the owner reads before Get. A failed report offers fix, recheck, cancel and rollback.
 */
@Remote async preflight(request: MarketInstallRequest): Promise<InstallPreflightReport>

/**
 * Attempt the repair for the step the last preflight failed on, then report the checks again.
 * @param request - Market listing id.
 * @returns What the attempt did. `unavailable` means this computer cannot repair that step.
 */
@Remote('repairListing') async repair(request: MarketInstallRequest): Promise<MarketRepairResult>

/**
 * Undo this listing's install attempt: remove the packages a repair installed, then restore the
 * declaration file to the bytes captured when that attempt started.
 * An attempt that started with no declaration file reports `no-previous-declaration` and leaves the
 * file it wrote: this market does not delete a declaration to undo an install.
 * @param request - Market listing id.
 * @returns What was restored or reverted. Nothing here cancels work or touches another declaration.
 */
@Remote('rollbackListing') async rollback(request: MarketInstallRequest): Promise<MarketRollbackResult>

/**
 * Download, install, and register one listing.
 * The preflight runs first and must pass; a nonempty package spec then goes through the existing
 * plugin manager. The declaration is written only after the preflight and the package apply succeeds.
 * @param request - Market listing id.
 * @returns The saved declaration.
 */
@Remote('installListing') async install(request: MarketInstallRequest): Promise<MarketInstallRecord>

/**
 * Remove a built-in capability declaration without uninstalling a package or changing the
 * device's order policy. A remote catalog entry must use the profile package manager instead.
 * @param request - Exact built-in listing id.
 * @returns Whether this computer had the declaration; other rows remain untouched.
 */
@Remote('removeListing') async remove(request: MarketInstallRequest): Promise<MarketRemoveResult>
```

Types: [H3OwnerSelfTestId](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3OwnerSelfTestRequest](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3OwnerSelfTestStatus](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3OwnerSetupInspectResult](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3OwnerSetupSaveRequest](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3OwnerSetupSaveResult](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3OwnerSetupSelection](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3SkillDraftRequest](../../packages/host/node-contributor/README.md#managed-owner-setup) · [H3SkillDraftResult](../../packages/host/node-contributor/README.md#managed-owner-setup)

Source: [`packages/host/qianshou-plugin-catalog/src/index.ts`](../../packages/host/qianshou-plugin-catalog/src/index.ts)

<a id="ctxqianshousessionconnect--qianshousessionconnect"></a>

### `ctx.qianshouSessionConnect` — `QianshouSessionConnect`

Owner-authenticated Remote creates and revokes narrow grants; it never exports an owner credential.

```ts cordis-catalog
/**
 * List the selected Session's non-secret authorizations.
 * @param sessionId - Explicit owner-selected Session.
 * @returns Current local-device grant metadata and configured reachability.
 */
@Remote async state(sessionId: SessionId): Promise<ConnectionOwnerState>

/**
 * Create one revocable authorization after inspecting the real Session.
 * @param input - Selected Session, mode, label and lifetime.
 * @returns Grant metadata and one secret fragment link, returned only here.
 */
@Remote async create(input: ConnectionGrantInput): Promise<ConnectionGrantCreated>

/**
 * Revoke access to one selected Session without interrupting its work.
 * @param sessionId - Owner's explicit Session fence.
 * @param grantId - Selected authorization id.
 */
@Remote async revoke(sessionId: SessionId, grantId: string): Promise<void>
```

Types: [SessionId](core.md)

Source: [`packages/host/qianshou-session-connect/src/index.ts`](../../packages/host/qianshou-session-connect/src/index.ts)

<a id="ctxqianshouskillimport--qianshouskillimport"></a>

### `ctx.qianshouSkillImport` — `QianshouSkillImport`

Preflight once, then write only the exact reviewed text into a controlled local root.

```ts cordis-catalog
/** Install only five Host-built native files under this service's trusted local root.
 * This Host-only method has no remote files or destination argument.
 * @param request - Catalog-built files and current-author verification callbacks.
 * @param signal - Cancellation before publishing SKILL.md.
 * @returns A local file receipt; no publication, supply grant or market approval occurs.
 */
installNativeSkillDraft(request: NativeSkillDraftRequest, signal: AbortSignal): Promise<NativeSkillDraftReceipt>

/**
 * Validate one UTF-8 SKILL.md and reserve its exact content for a short review window.
 * @param content - Complete text from a local file; URL, archive and filesystem paths are not accepted.
 * @returns Metadata, digest, destination and an opaque single-use installation id.
 */
@Remote async inspect(content: string): Promise<SkillImportInspection>

/**
 * Consume one inspection and publish its exact bytes without replacing an existing skill.
 * @param inspectionId - Opaque id returned by inspect; a repeated or expired id is refused.
 * @param signal - Cancels before publication.
 * @returns Verified disk-write receipt; callers separately query Session skill discovery.
 */
@Remote async install(inspectionId: SkillImportInspectionId, signal: AbortSignal): Promise<SkillImportReceipt>

/**
 * Check one expected digest at the controlled skill path after an uncertain install response.
 * @param name - Previously inspected kebab-case skill name.
 * @param sha256 - Lowercase SHA-256 digest returned by inspect.
 * @returns Matched bytes, changed or unsafe bytes, or an absent file; no Session visibility claim.
 */
@Remote async verify(name: string, sha256: string): Promise<SkillImportVerification>

/**
 * Read valid user skill files from the two roots scanned by the filesystem provider.
 * This is a local inventory, not proof that a particular Session selects a skill.
 * @returns Valid user skill entries from the configured roots, without claiming Session selection.
 */
@Remote async listLocal(): Promise<LocalSkillList>

/**
 * Archive only an exact current user skill; installed runtime and market records are separate.
 * @param request - Source, name, path and digest returned by listLocal.
 * @param signal - Cancels before the whole-directory move.
 * @returns Local restoration paths; no cloud withdrawal or package uninstall claim.
 */
@Remote async archiveLocal(request: LocalSkillArchiveRequest, signal: AbortSignal): Promise<LocalSkillArchiveReceipt>

/**
 * List only recoverable payloads in this Host's configured user roots.
 * @returns Only validated recoverable entries under the configured user archive roots.
 */
@Remote async archiveList(): Promise<{ items: readonly LocalSkillArchiveEntry[] }>

/**
 * Explicit local restoration; it does not publish, install or enable orders.
 * @param request - The archive source, identifier, and digest returned by the validated archive list.
 * @param signal - Cancellation for validation and restoration before the local copy is committed.
 * @returns The local restoration receipt; publication and supply authorization stay separate.
 */
@Remote async restoreLocal(request: LocalSkillRestoreRequest, signal: AbortSignal): Promise<LocalSkillRestoreReceipt>

/**
 * Return this live owner's configured roots without creating or modifying files.
 * @param name - An optional exact kebab-case skill name of at most 64 characters.
 * @returns The configured writable roots and exact-name authoring destinations, if requested.
 */
async authoringContext(name?: string): Promise<SkillAuthoringContext>
```

Types: [NativeSkillDraftReceipt](../../packages/host/qianshou-skill-import/README.md#native-skill-draft) · [NativeSkillDraftRequest](../../packages/host/qianshou-skill-import/README.md#native-skill-draft)

Source: [`packages/host/qianshou-skill-import/src/index.ts`](../../packages/host/qianshou-skill-import/src/index.ts)

<a id="ctxqianshouvision--qianshouvision"></a>

### `ctx.qianshouVision` — `QianshouVision`

Host service reporting driver assembly, OS grants, and route image acceptance separately. The computer-use service and its provider are optional: their absence is a reported fact, never an activation failure. No method mounts a driver, changes a model route, or grants anything.

```ts cordis-catalog
/**
 * Read all three facts without raising any OS dialog; the permission probe runs with `prompt: false`.
 * @returns The current vision status; `unknown` fields name the probe that could not answer.
 */
@Remote async state(): Promise<VisionSnapshot>

/**
 * Explicit user action: ask the registered provider to request missing OS grants (`prompt: true`).
 * Without a registered provider this only re-reads status and reports `no-provider`.
 * @returns The vision status after the request returned.
 */
@Remote async requestPermissions(): Promise<VisionSnapshot>
```

Source: [`packages/host/qianshou-vision/src/index.ts`](../../packages/host/qianshou-vision/src/index.ts)

<a id="ctxqianshouvoice--qianshouvoice"></a>

### `ctx.qianshouVoice` — `QianshouVoice`

Host-local transcription; no audio, transcript or process output enters Session history.

```ts cordis-catalog
/**
 * Read local asset accessibility and current admission limits without loading the model.
 * @returns Safe availability information; no filesystem paths or credentials.
 */
@Remote async status(): Promise<VoiceStatus>
```

Source: [`packages/host/qianshou-voice/src/index.ts`](../../packages/host/qianshou-voice/src/index.ts)

<a id="ctxremotedevices--remotedevicesservice"></a>

### `ctx.remoteDevices` — `RemoteDevicesService`

Authenticated task coordination without access to pairing secrets or device revocation.

```ts cordis-catalog
/**
 * Read public device metadata without exposing credentials or pairing codes.
 * @returns Cloned devices including connectivity and advertised workspace IDs.
 */
devices(): DeviceInfo[]

/**
 * Persist a validated task before delivering it to the selected online peer.
 * @param value - Untrusted finite task request, validated by the coordinator.
 * @returns The actual task in awaiting-approval state; acceptance does not mean execution.
 * @throws If the device is offline, its workspace is absent, input is invalid or task capacity is exhausted.
 */
submit(value: unknown): Promise<RemoteJob>

/**
 * Read a retained task receipt without starting or retrying work.
 * @param id - Existing task identity.
 * @returns A cloned receipt, or undefined when the task is absent or no longer retained.
 */
task(id: string): RemoteJob | undefined

/**
 * Record a cancellation request and forward it to an available peer.
 * @param id - Existing task identity.
 * @returns Request acceptance; a terminal receipt still determines the execution outcome.
 * @throws If the task is unknown or persistence fails.
 */
cancel(id: string): Promise<{ accepted: true }>
```

Source: [`packages/host/remote-devices/src/service.ts`](../../packages/host/remote-devices/src/service.ts)
<!-- END GENERATED cordis-surface -->
