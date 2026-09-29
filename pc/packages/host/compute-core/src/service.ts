/** Host service linking local drafts to the existing core's catalogue and developer-task publish. */
import { createHash, randomBytes } from 'node:crypto'
import type { ComputeCapability, ComputeConnectionState, ComputePlanDraft, ComputePlanRequest, ComputeWorkloadCancellation, ComputeWorkloadId, ComputeWorkloadRefundEvidence, ComputeWorkloadResult, ComputeWorkloadSummary } from './protocol.ts'
import { parsePlanConfirmation, parsePlanPublish, parsePlanRequest } from './validation.ts'
import { ComputeError } from './errors.ts'
import { parseChainConfirmation, parseChainLocator, parseChainRequest, parseHumanConfirm, type ComputeChainDraft, type ComputeChainStore } from './chain-store.ts'
import { ComputeDraftStore } from './store.ts'
import { LocalPluginDraftStore, parsePluginDraftId, type LocalPluginDraft, type PluginDraftExport } from './plugin-draft.ts'
import { VideoWorkflowDraftStore, type PrivateVideoWorkflowDraft,
  type VideoWorkflowDraftSummary } from './video-workflow-draft.ts'
import { ReviewableExecutionCandidateStore } from './reviewable-execution-candidates.ts'
import { buildReviewableExecutionArtifact, evaluateReviewableExecution,
  type VerifiedReviewableExecutionArtifact } from './reviewable-execution-artifact.ts'
import type { HostPluginAdapterListing } from './plugin-adapter-admission.ts'
import { HostPluginSampleWorkbench, type HostPluginSampleAdapter,
  type PrivatePluginSampleRun } from './private-plugin-sample-workbench.ts'
import { PrivatePluginActivationHost, type PrivatePluginActivationSummary,
  type PrivatePluginOperationResult, type PrivatePluginOwnerApproval,
  type PreparedPrivatePluginSubmission } from './private-plugin-activation.ts'
import { PrivatePluginActivationLedger, type PrivatePluginActivationRecord } from './private-plugin-activation-ledger.ts'
import { PrivatePluginInvocationLedger } from './private-plugin-invocation-ledger.ts'
import { PrivateOfflinePluginArtifactStore,
  type PrivateOfflinePluginArtifactSummary } from './private-offline-plugin-artifact-store.ts'
import type { PluginDraftPackagePreview } from './plugin-draft-preview.ts'
import type { ComfyDraftAssetSummary, PrivateComfyDraftAsset } from './comfy-draft-asset.ts'
import type { PrivateComfyTrialHost, PrivateComfyTrialInput, PrivateComfyTrialReceipt,
  PrivateComfyTrialReconciliation } from './comfy-private-trial.ts'
import type { ComfyTrialRecord } from './comfy-private-trial-ledger.ts'
import type { PlanInputFile } from './plan-file-input.ts'
import {
  parseRecipeMatchQuery,
  parseRecipeSettleRequest,
  recipeHitCard,
  recipeMatchQueryFromRequest,
  type ComputeRecipeRecord,
  type ComputeRecipeStore,
} from './recipe-store.ts'
import {
  parseResultCacheLookup,
  parseResultCacheStore,
  type ComputeResultCache,
  type ComputeResultCacheEntry,
} from './result-cache.ts'
import { ACCOUNT_FIELD_MISSING, type CapabilityPoolSnapshot, type ComputeAccountSnapshot, type CoreBuyerAcceptance, type CoreCapabilityRegistry, type CoreLedgerEntry, type CoreNodeDashboard, type QianshouCoreClient } from './core-client.ts'
import { ComputeExecutorRegistry } from './executor.ts'
import { ComputeLocalTaskRunner, type ComputeLocalTaskRequest } from './local-task-runner.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import type { ListedLocalPluginCandidate, LocalPluginCandidate, LocalPluginCandidateBuilder } from './plugin-candidate.ts'
import { ComputeTaskStore } from './task-store.ts'
import type { ComputeTaskEvent, ComputeTaskState } from './task-state.ts'
import { EmployeeTaskCoordinator, type EmployeeTaskCoordinationResult, type EmployeeTaskCoordinateInput } from './employee-task-coordinator.ts'
import type { ObservedSupplyServices, OwnerSupplyCommand, SupplyClient, SupplyPolicy, SupplyPolicyWriteAuthority, SupplySnapshot } from './supply/types.ts'
import { developerTaskCreateBody, developerTaskIntentRequest, landingTaskType, type DeveloperTaskCreateBody, type DeveloperTaskQuoteView, type DeveloperTaskType } from './developer-task.ts'
import { submissionRequestFingerprint, SubmissionLedger } from './submission-ledger.ts'
import {
  classifyNaturalIntent, parseNaturalIntentRequest, planNaturalIntentRoute,
  type GuangzhouAccountState, type NaturalRouteDecision,
} from './natural-intent-route.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { computeCore: ComputeService }
}

/** Ticket-bearing pending quote. This value must never enter a Connection route response. */
interface PreparedDeveloperQuote {
  readonly view: DeveloperTaskQuoteView
  readonly accountId: string
  readonly draftFingerprint: string
  readonly body: DeveloperTaskCreateBody
  readonly quoteToken: string
}

function assertReviewedVideoAccount(request: ComputePlanRequest, accountId: unknown): void {
  if (request.expectedVideoReview === undefined) return
  const key = request.fileInput?.files[0]?.objectKey
  if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 1
    || typeof key !== 'string'
    || !key.startsWith(`v8/account-${accountId}/reviewed-video/input/`)) {
    throw new ComputeError('COMPUTE_VIDEO_MIXED_INPUT_INVALID', 409)
  }
}

/** Independent observations: a registry name never implies a requestable or online implementation. */
export interface ComputeCapabilityDiscovery {
  readonly registry: {
    readonly status: 'observed' | 'unreachable'
    readonly observedAt: string | null
    readonly reason: 'not_configured' | 'auth_required' | 'request_failed' | null
    readonly registryVersion: string | null
    readonly capabilities: CoreCapabilityRegistry['capabilities'] | null
  }
  readonly requestableTaskTypes: {
    readonly status: 'observed' | 'unreachable'
    readonly observedAt: string | null
    readonly reason: 'not_configured' | 'auth_required' | 'request_failed' | null
    readonly items: readonly Pick<DeveloperTaskType, 'taskType' | 'acceptedInputKinds' | 'defaultInputKind'>[] | null
  }
}

/** Core catalogue, local drafts, and authorized developer-task publish. */
export class ComputeService {
  private closed = false
  private readonly publishing = new Map<string, Promise<ComputePlanDraft>>()
  private readonly quotes = new Map<string, PreparedDeveloperQuote>()
  /** Local capability contributions used by the unified agent executor. */
  readonly executors: ComputeExecutorRegistry = new ComputeExecutorRegistry()
  /** Registered callbacks stay in the Host. A draft and model call cannot register one. */
  readonly #pluginSamples = new HostPluginSampleWorkbench({ platform: process.platform, architecture: process.arch })
  readonly #pluginSampleStop = new AbortController()
  private readonly privatePluginActivation?: PrivatePluginActivationHost
  readonly #activePluginSamples = new Set<Promise<PrivatePluginSampleRun & {
    readonly stored: PrivateOfflinePluginArtifactSummary }>>()
  private readonly runner = new ComputeLocalTaskRunner(this.executors)
  /** Optional admission coordinator sharing the durable local attempt store. */
  readonly coordinator?: EmployeeTaskCoordinator
  /** Share one owner-authorized core client with the local planning store.
   * @param client - Null until the deployment has configured a core origin.
   * @param store - Private owner draft storage.
   * @param hasCredential - Checks only presence; never exposes the value to clients.
   * @param tasks - Optional local attempt store owned by this plugin.
   * @param supply - Local observations and owner policy, without implicit remote advertisement.
   * @param ledger - Local submission intent ledger; required for developer-task publish.
   * @param chains - Optional local chain-card store; creating a card never contacts the core.
   * @param recipes - Optional settled-recipe store; matching never contacts the core.
   * @param results - Optional local processing cache; random capabilities never write it.
   * @param pluginDrafts - Optional private builder recipes; they never enter execution or hello.
   * @param pluginCandidates - Optional allowlisted local package builder; no installation or advertisement.
   */
  constructor(
    private readonly client: QianshouCoreClient | null,
    private readonly store: ComputeDraftStore,
    private readonly hasCredential: () => boolean,
    readonly tasks?: ComputeTaskStore,
    private readonly supply?: SupplyClient,
    private readonly ledger?: SubmissionLedger,
    private readonly chains?: ComputeChainStore,
    private readonly recipes?: ComputeRecipeStore,
    private readonly results?: ComputeResultCache,
    private readonly pluginDrafts?: LocalPluginDraftStore,
    private readonly privateComfyTrials?: PrivateComfyTrialHost,
    private readonly privatePluginArtifacts?: PrivateOfflinePluginArtifactStore,
    privatePluginLedger?: PrivatePluginActivationLedger,
    privatePluginInvocations?: PrivatePluginInvocationLedger,
    privatePluginApproval?: PrivatePluginOwnerApproval,
    private readonly reviewableCandidates?: ReviewableExecutionCandidateStore,
    private readonly pluginCandidates?: LocalPluginCandidateBuilder,
    private readonly videoWorkflowDrafts?: VideoWorkflowDraftStore,
  ) {
    if (tasks) this.coordinator = new EmployeeTaskCoordinator(tasks)
    if (pluginDrafts && privatePluginArtifacts && privatePluginLedger && privatePluginInvocations) {
      this.privatePluginActivation = new PrivatePluginActivationHost({ drafts: pluginDrafts,
        artifacts: privatePluginArtifacts, workbench: this.#pluginSamples,
        ledger: privatePluginLedger, invocations: privatePluginInvocations,
        ...(privatePluginApproval === undefined ? {} : { approval: privatePluginApproval }) })
    }
  }

  /**
   * Read owner-local plugin recipes; they are neither installable nor advertised.
   * @returns Owner-local recipe records, without install or advertisement authority.
   */
  localPluginDrafts(): Promise<LocalPluginDraft[]> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginDrafts) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503))
    return this.pluginDrafts.list()
  }

  /** List owner-private video graphs by identity only; graph bytes stay in the Host.
   * @returns Private draft summaries.
   */
  localVideoWorkflowDrafts(): Promise<VideoWorkflowDraftSummary[]> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.videoWorkflowDrafts) return Promise.reject(new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_STORE_UNAVAILABLE', 503))
    return this.videoWorkflowDrafts.list()
  }

  /** Save a bounded owner-private ComfyUI API graph. This does not make an order skill.
   * @param value - Untrusted owner draft request.
   * @returns The saved graph identity and digest.
   */
  saveLocalVideoWorkflowDraft(value: unknown): Promise<VideoWorkflowDraftSummary> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.videoWorkflowDrafts) return Promise.reject(new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_STORE_UNAVAILABLE', 503))
    return this.videoWorkflowDrafts.save(value)
  }

  /** Trusted in-process runner readback; deliberately absent from Connection routes and model tools.
   * @param id - Local draft identity.
   * @param expectedGraphSha256 - Digest of the authorized draft revision.
   * @returns Exact private graph and owner input bindings.
   */
  readPrivateVideoWorkflowDraft(id: string, expectedGraphSha256: string): Promise<PrivateVideoWorkflowDraft> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.videoWorkflowDrafts) return Promise.reject(new ComputeError('COMPUTE_VIDEO_WORKFLOW_DRAFT_STORE_UNAVAILABLE', 503))
    return this.videoWorkflowDrafts.readPrivate(id, expectedGraphSha256)
  }

  /**
   * Build and retain actual bounded program bytes from an exact private draft revision.
   * @param value - Exact private draft revision, declared capability IDs and bounded program bytes.
   * @returns The verified bounded candidate retained for the exact draft revision.
   */
  async buildReviewableExecutionCandidate(value: {
    readonly draftId: string
    readonly expectedUpdatedAt: string
    readonly capabilityIds: Readonly<Record<string, string>>
    readonly programs: Readonly<Record<string, unknown>>
  }):
  Promise<VerifiedReviewableExecutionArtifact> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.pluginDrafts || !this.reviewableCandidates) throw new ComputeError('COMPUTE_REVIEWABLE_CANDIDATE_UNAVAILABLE', 503)
    const draftId = parsePluginDraftId(value.draftId)
    const draft = (await this.pluginDrafts.list()).find(item => item.id === draftId)
    if (!draft) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
    if (draft.updatedAt !== value.expectedUpdatedAt) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_REVISION_STALE', 409)
    const artifact = buildReviewableExecutionArtifact({ draft, capabilityIds: value.capabilityIds,
      programs: value.programs })
    const saved = await this.reviewableCandidates.save(artifact)
    if ((await this.pluginDrafts.list()).find(item => item.id === draftId)?.updatedAt !== value.expectedUpdatedAt) {
      throw new ComputeError('COMPUTE_PLUGIN_DRAFT_REVISION_STALE', 409)
    }
    return saved
  }

  /**
   * Authenticated owner export of the exact local candidate; this is not an install package.
   * @param packageSha256 - The exact immutable candidate or private archive SHA256.
   * @returns JSON export data; review, installability and dispatchability remain false.
   */
  exportReviewableExecutionCandidate(packageSha256: string): Promise<{
    readonly fileName: string
    readonly contentType: 'application/json'
    readonly contents: string
    readonly packageSha256: string
    readonly reviewed: false
    readonly installable: false
    readonly dispatchable: false
  }> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.reviewableCandidates) throw new ComputeError('COMPUTE_REVIEWABLE_CANDIDATE_UNAVAILABLE', 503)
    return this.reviewableCandidates.export(packageSha256)
  }

  /**
   * Host caller obtains a fresh owner approval before passing sample input here.
   * @param packageSha256 - The exact immutable candidate or private archive SHA256.
   * @param samples - One schema-validated input for every declared candidate operation.
   * @returns Actual bounded sample outputs for every declared operation, without approval or installation.
   */
  async tryReviewableExecutionCandidate(packageSha256: string,
    samples: readonly { readonly operationId: string; readonly input: unknown }[]):
  Promise<{
    readonly packageSha256: string
    readonly results: readonly {
      readonly operationId: string
      readonly output: Readonly<Record<string, string>>
    }[]
    readonly reviewed: false
    readonly installable: false
    readonly dispatchable: false
  }> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.reviewableCandidates) throw new ComputeError('COMPUTE_REVIEWABLE_CANDIDATE_UNAVAILABLE', 503)
    const { bytes, verified } = await this.reviewableCandidates.read(packageSha256)
    const rawSamples: unknown = samples
    if (!Array.isArray(rawSamples) || rawSamples.length !== verified.manifest.operations.length
      || rawSamples.some((raw: unknown) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return true
        const item = raw as Record<string, unknown>
        return Object.keys(item).length !== 2 || typeof item.operationId !== 'string'
          || !Object.hasOwn(item, 'input')
      })
      || new Set(samples.map(item => item.operationId)).size !== samples.length
      || verified.manifest.operations.some(operation => !samples.some(item => item.operationId === operation.operationId))) {
      throw new ComputeError('COMPUTE_REVIEWABLE_SAMPLE_INVALID', 400)
    }
    const results = verified.manifest.operations.map((operation) => {
      const sample = samples.find(item => item.operationId === operation.operationId)
      if (!sample) throw new ComputeError('COMPUTE_REVIEWABLE_SAMPLE_INVALID', 400)
      return { operationId: operation.operationId,
        output: evaluateReviewableExecution(bytes, operation.operationId, sample.input) }
    })
    return { packageSha256, results, reviewed: false, installable: false, dispatchable: false }
  }

  /**
   * List registered logical operations; no registration, sample or execution authority escapes this service.
   * @returns Registered logical-operation metadata, without Host callbacks or execution authority.
   */
  listPluginAdapterBindings(): readonly HostPluginAdapterListing[] {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    return this.#pluginSamples.listBindings()
  }

  /**
   * Read persisted PRIVATE installs with current archive, draft and Host callback availability.
   * @returns Saved private activations with current archive, draft and callback observations.
   */
  listPrivatePluginActivations(): Promise<readonly PrivatePluginActivationSummary[]> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privatePluginActivation) return Promise.resolve([])
    return this.privatePluginActivation.list()
  }

  /** Prepare a redacted Guangzhou declaration from an exact active private plugin for Host upload.
   * @param input - Exact draft revision, sampled archive, explicit operation capabilities and cancellation.
   * @returns Safe metadata and ZIP bytes retained only by the trusted Host caller.
   */
  preparePrivatePluginSubmission(input: {
    readonly draftId: string
    readonly expectedUpdatedAt: string
    readonly packageSha256: string
    readonly candidateSha256: string
    readonly capabilityIds: Readonly<Record<string, string>>
    readonly signal: AbortSignal
  }): Promise<PreparedPrivatePluginSubmission> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privatePluginActivation) return Promise.reject(new ComputeError('COMPUTE_PRIVATE_PLUGIN_UNAVAILABLE', 503))
    return this.privatePluginActivation.prepareSubmission(input)
  }

  /**
   * Activate one exact private archive after a one-shot Host owner approval.
   * @param packageSha256 - The exact immutable candidate or private archive SHA256.
   * @param candidateSha256 - The expected private candidate identity bound to the archive.
   * @param authority - Trusted Host agent, call identity and cancellation for fresh one-shot owner approval.
   * @returns The private activation after exact-byte and fresh owner-approval checks.
   */
  activatePrivatePlugin(packageSha256: string, candidateSha256: string,
    authority: { readonly agent: unknown; readonly callId?: unknown; readonly signal: AbortSignal }):
  Promise<PrivatePluginActivationSummary> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privatePluginActivation) return Promise.reject(new ComputeError('COMPUTE_PRIVATE_PLUGIN_UNAVAILABLE', 503))
    return this.privatePluginActivation.activate(packageSha256, candidateSha256, authority)
  }

  /**
   * Uninstall one exact private activation after a one-shot Host owner approval.
   * @param packageSha256 - The exact immutable candidate or private archive SHA256.
   * @param candidateSha256 - The expected private candidate identity bound to the archive.
   * @param authority - Trusted Host agent, call identity and cancellation for fresh one-shot owner approval.
   * @returns The explicit private uninstall receipt; market and supply rights are unchanged.
   */
  uninstallPrivatePlugin(packageSha256: string, candidateSha256: string,
    authority: { readonly agent: unknown; readonly callId?: unknown; readonly signal: AbortSignal }):
  Promise<PrivatePluginActivationRecord & { readonly state: 'uninstalled-private' }> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privatePluginActivation) return Promise.reject(new ComputeError('COMPUTE_PRIVATE_PLUGIN_UNAVAILABLE', 503))
    return this.privatePluginActivation.uninstall(packageSha256, candidateSha256, authority)
  }

  /**
   * Run one installed PRIVATE operation with fresh archive, adapter and one-shot owner checks.
   * @param packageSha256 - The exact immutable candidate or private archive SHA256.
   * @param candidateSha256 - The expected private candidate identity bound to the archive.
   * @param operationId - The exact operation declared by the selected installed or saved source.
   * @param input - Untrusted operation input validated against the installed exact schema.
   * @param authority - Trusted Host agent, call identity and cancellation for fresh one-shot owner approval.
   * @returns The actual private operation result after current bytes and one-shot authority verify.
   */
  runPrivatePluginOperation(packageSha256: string, candidateSha256: string,
    operationId: string, input: unknown,
    authority: { readonly agent: unknown; readonly callId?: unknown; readonly signal: AbortSignal }):
  Promise<PrivatePluginOperationResult> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privatePluginActivation) return Promise.reject(new ComputeError('COMPUTE_PRIVATE_PLUGIN_UNAVAILABLE', 503))
    return this.privatePluginActivation.run(packageSha256, candidateSha256, operationId, input, authority)
  }

  /**
   * Trusted, already installed Host packages register their exact executor contract here.
   * Never expose this method as a model tool, Remote or HTTP route.
   * @param adapter - The trusted installed Host adapter and its exact executor contract.
   * @returns A disposer that unregisters only this installed Host adapter.
   */
  registerHostPluginSampleAdapter(adapter: HostPluginSampleAdapter): () => void {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    return this.#pluginSamples.register(adapter)
  }

  /**
   * Run an exact saved draft against registered Host callbacks for one owner approved sample.
   * The returned archive contains private sample data; a model tool must omit its bytes.
   * @param id - The saved owner-local draft identifier, parsed before use.
   * @param expectedUpdatedAt - The exact saved draft revision expected before execution.
   * @param inputs - One owner-approved sample input for each selected declared operation.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns Real sample results and the private retained archive; callers must not expose archive bytes to a model.
   */
  async runPrivatePluginSamples(id: unknown, expectedUpdatedAt: unknown,
    inputs: readonly { readonly operationId: string; readonly input: unknown }[],
    signal: AbortSignal): Promise<PrivatePluginSampleRun & {
      readonly stored: PrivateOfflinePluginArtifactSummary }> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (this.#activePluginSamples.size > 0) throw new ComputeError('COMPUTE_PLUGIN_SAMPLE_BUSY', 409)
    if (!this.pluginDrafts) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503)
    if (!this.privatePluginArtifacts) throw new ComputeError('COMPUTE_PRIVATE_ARTIFACT_STORE_UNAVAILABLE', 503)
    const draftId = parsePluginDraftId(id)
    if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.length > 40) {
      throw new ComputeError('COMPUTE_PLUGIN_DRAFT_REVISION_INVALID', 400)
    }
    const combined = AbortSignal.any([signal, this.#pluginSampleStop.signal])
    const pluginDrafts = this.pluginDrafts
    const privatePluginArtifacts = this.privatePluginArtifacts
    const run = (async () => {
      const draft = (await pluginDrafts.list()).find(item => item.id === draftId)
      combined.throwIfAborted()
      if (!draft) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
      if (draft.updatedAt !== expectedUpdatedAt) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_REVISION_STALE', 409)
      const sampled = await this.#pluginSamples.runPrivateSamples(draft, inputs, combined)
      combined.throwIfAborted()
      const stored = await privatePluginArtifacts.persist(sampled.artifact)
      combined.throwIfAborted()
      return { ...sampled, stored }
    })()
    this.#activePluginSamples.add(run)
    try { return await run }
    finally { this.#activePluginSamples.delete(run) }
  }

  /**
   * Save one private, non-executable plugin recipe after parsing its bounded operation schemas.
   * @param value - Untrusted recipe metadata and operation schemas, parsed before saving.
   * @returns The parsed and saved private, non-executable recipe.
   */
  saveLocalPluginDraft(value: unknown): Promise<LocalPluginDraft> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginDrafts) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503))
    return this.pluginDrafts.save(value)
  }

  /**
   * Save only after the creator tool obtains a one-shot Host approval for this graph digest.
   * @param value - Exact draft and operation, workflow path and expected source digest.
   * @returns The verified owner-local workflow summary, without task execution.
   */
  bindLocalPluginComfyAsset(value: {
    readonly id: unknown
    readonly expectedUpdatedAt: unknown
    readonly operationId: unknown
    readonly workflow: unknown
    readonly mapping: unknown
  }): Promise<ComfyDraftAssetSummary> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginDrafts) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503))
    return this.pluginDrafts.bindComfyAsset(value)
  }

  /**
   * Give model tools only a private asset's digest and pending state.
   * @param id - The saved owner-local draft identifier, parsed before use.
   * @returns Bounded saved workflow summaries for the exact draft.
   */
  localPluginComfyAssetSummaries(id: unknown): Promise<readonly ComfyDraftAssetSummary[]> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginDrafts) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503))
    return this.pluginDrafts.comfyAssetSummaries(id)
  }

  /**
   * Trusted Host-only readback for a later adapter; never mount this as a model tool or HTTP route.
   * @param id - The saved owner-local draft identifier, parsed before use.
   * @param operationId - The exact operation declared by the selected installed or saved source.
   * @returns The verified Host-only workflow asset for the selected operation.
   */
  readLocalPluginComfyAsset(id: unknown, operationId: unknown): Promise<PrivateComfyDraftAsset> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginDrafts) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503))
    return this.pluginDrafts.readComfyAsset(id, operationId)
  }

  /**
   * Run only a Host-approved private sample; the model cannot supply an owner or idempotency key.
   * @param value - Exact draft operation, local workflow parameters, Host authority and cancellation.
   * @returns The completed private sample receipt after fresh owner approval and actual execution.
   */
  runLocalPluginComfyTrial(value: Omit<PrivateComfyTrialInput, 'ownerId' | 'idempotencyKey'>): Promise<PrivateComfyTrialReceipt> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privateComfyTrials || typeof value.callId !== 'string' || value.callId.length < 1
      || value.callId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.callId)) {
      return Promise.reject(new ComputeError('COMPUTE_COMFY_TRIAL_UNAVAILABLE', 503))
    }
    const idempotencyKey = `call-${createHash('sha256').update(value.callId).digest('hex')}`
    return this.privateComfyTrials.run({ ...value, ownerId: 'local-host', idempotencyKey })
  }

  /**
   * Opaque ID read for the authenticated local image preview route.
   * @param trialId - The opaque identifier of this owner's original private image trial.
   * @returns Verified PNG bytes for the authenticated local preview caller.
   */
  readLocalPluginComfyTrialImage(trialId: string): Promise<Buffer> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privateComfyTrials) return Promise.reject(new ComputeError('COMPUTE_COMFY_TRIAL_UNAVAILABLE', 503))
    return this.privateComfyTrials.readImage(trialId, 'local-host')
  }

  /**
   * Authenticated local owner can locate an interrupted trial without an agent call ID.
   * @returns Up to twenty owner-local trial identifiers, states, timestamps and result metadata.
   */
  recentLocalPluginComfyTrials(): Promise<readonly Pick<ComfyTrialRecord, 'trialId' | 'status' | 'updatedAt' | 'result'>[]> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privateComfyTrials) return Promise.reject(new ComputeError('COMPUTE_COMFY_TRIAL_UNAVAILABLE', 503))
    return this.privateComfyTrials.recent('local-host')
  }

  /**
   * Read only the original Comfy prompt and verified PNG after an interrupted trial.
   * @param trialId - The opaque identifier of this owner's original private image trial.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns The original trial status and verified result; pending never authorizes resubmission.
   */
  reconcileLocalPluginComfyTrial(trialId: string, signal: AbortSignal): Promise<PrivateComfyTrialReconciliation> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.privateComfyTrials) return Promise.reject(new ComputeError('COMPUTE_COMFY_TRIAL_UNAVAILABLE', 503))
    return this.privateComfyTrials.reconcile(trialId, 'local-host', signal)
  }

  /**
   * Export one recipe as JSON data without installing, signing or publishing it.
   * @param id - The saved owner-local draft identifier, parsed before use.
   * @returns The recipe JSON data without installing, signing or publishing it.
   */
  exportLocalPluginDraft(id: unknown): Promise<PluginDraftExport> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginDrafts) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503))
    return this.pluginDrafts.export(id)
  }

  /**
   * Read a non-runnable package plan and live, explicitly limited hardware checks.
   * @param id - The saved owner-local draft identifier, parsed before use.
   * @returns A declaration-only package preview, without installation or execution.
   */
  previewLocalPluginDraft(id: unknown): Promise<PluginDraftPackagePreview> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginDrafts) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_DRAFT_STORE_UNAVAILABLE', 503))
    return this.pluginDrafts.preview(id)
  }

  /**
   * Prepare a bounded private candidate from an allowlisted saved draft.
   * @param id - The saved owner-local draft identifier, parsed before use.
   * @returns The prepared local candidate, without installation or market publication.
   */
  prepareLocalPluginCandidate(id: unknown): Promise<LocalPluginCandidate> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginCandidates) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_CANDIDATE_UNAVAILABLE', 503))
    return this.pluginCandidates.prepare(id)
  }

  /**
   * Read byte-verified private candidates for owner review.
   * @returns Prepared owner-local candidates, separate from public market goods.
   */
  listLocalPluginCandidates(): Promise<ListedLocalPluginCandidate[]> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.pluginCandidates) return Promise.reject(new ComputeError('COMPUTE_PLUGIN_CANDIDATE_UNAVAILABLE', 503))
    return this.pluginCandidates.list()
  }

  /** Report configured features; this is not a connectivity or account validation probe.
   * @returns Current local configuration state.
   */
  status(): ComputeConnectionState {
    const configured = !this.closed && this.client !== null && this.hasCredential()
    return { configured, capabilities: { workloadRead: configured, quoting: configured, submission: configured }, message: configured
      ? '核心连接已配置；任务须先取得上海报价并由用户确认，随后才会提交调度。'
      : '尚未配置算力核心地址和当前账号凭证；本地草稿可查看，任务提交未启用。' }
  }

  private core(): QianshouCoreClient {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.client || !this.hasCredential()) throw new ComputeError('COMPUTE_NOT_CONFIGURED', 503)
    return this.client
  }

  /** Configured core origin for sibling plugins that open the worker socket.
   * @returns Scheme, host and port, or null when no origin is configured or the service is closed.
   */
  coreOrigin(): string | null {
    if (this.closed || this.client === null) return null
    return this.client.originHref()
  }

  /** Read the authenticated core account id used as the Edge worker owner id.
   * @param signal - Caller cancellation bound to the upstream request.
   * @returns Positive core account id.
   */
  async ownerAccountId(signal?: AbortSignal): Promise<number> {
    const identity = await this.core().getIdentity(signal)
    return Number(identity.accountId)
  }

  /**
   * Read this owner's Shanghai-backed execution and settled earnings summary.
   * @param workerId - The current worker identity whose owner-visible dashboard is requested.
   * @param offset - The bounded dashboard page offset, defaulting to zero.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns The current owner and worker execution, order and settled-earnings metadata.
   */
  nodeDashboard(workerId: string, offset: number = 0, signal?: AbortSignal): Promise<CoreNodeDashboard> {
    return this.core().getNodeDashboard(workerId, offset, signal)
  }

  /** Read fresh local resource facts independently of cloud model configuration.
   * @param signal - Cancellation for bounded local probes.
   * @returns Actual observations and saved owner policy; unknown facts stay unknown.
   */
  querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.supply) return Promise.reject(new ComputeError('SUPPLY_NOT_CONFIGURED', 503))
    return this.supply.querySupplySnapshot(signal)
  }

  /**
   * Preview a natural request against observed local, Guangzhou and Shanghai capability facts.
   * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
   * @param guangzhouAccount - The actual account state used to assess the cloud route without guessing authorization.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns A route decision based on actual registry, supply and account observations; it creates no task.
   */
  async previewNaturalIntent(input: unknown, guangzhouAccount: GuangzhouAccountState, signal?: AbortSignal): Promise<NaturalRouteDecision> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const executors = this.executors.list()
    const intent = classifyNaturalIntent(parseNaturalIntentRequest(input), executors
      .filter(item => item.intentPhrases !== undefined)
      .map(item => ({ capabilityId: String(item.capabilityId), phrases: item.intentPhrases ?? [] })))
    signal?.throwIfAborted()
    const localExecutorCapabilities = executors.map(item => String(item.capabilityId))
    let borrowedPool = null
    if (intent.kind === 'task' && intent.capability !== null
      && (intent.preferred === 'borrowed' || (intent.preferred === null && intent.capability !== 'image.generate'
        && intent.capability !== 'workspace.operation' && !localExecutorCapabilities.includes(intent.capability)))) {
      borrowedPool = await this.pool(intent.capability, signal)
    }
    let ownerSupplyMode: SupplyPolicy['mode'] | null = null
    if (intent.kind === 'supply') {
      try { ownerSupplyMode = (await this.ownerSupplyPolicy(signal)).mode }
      catch { /* Unknown authorization is never treated as enabled. */ }
    }
    signal?.throwIfAborted()
    return planNaturalIntentRoute(intent, { localExecutorCapabilities, guangzhouAccount, borrowedPool, ownerSupplyMode })
  }

  /**
   * Return an already completed local observation without probing or changing Shanghai advertisement.
   * @returns The latest observed supply services, or null before an observation.
   */
  lastObservedSupply(): ObservedSupplyServices | null {
    if (this.closed) return null
    return this.supply?.lastObservedSupply() ?? null
  }

  /** Read the saved owner supply policy without running local probes.
   *
   * The resident contribution loop mirrors this switch on every tick, so it must stay
   * cheap and must never touch advertisement state.
   * @param signal - Caller cancellation.
   * @returns The committed owner policy.
   */
  ownerSupplyPolicy(signal?: AbortSignal): Promise<SupplyPolicy> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.supply) return Promise.reject(new ComputeError('SUPPLY_NOT_CONFIGURED', 503))
    return this.supply.ownerPolicy(signal)
  }

  /** Persist a complete owner policy without buying or submitting a task.
   * @param policy - Complete policy validated by the supply controller before persistence.
   * @param signal - Caller cancellation; a committed policy remains saved after a probe error.
   * @returns Fresh local supply state after the committed change.
   */
  updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.supply) return Promise.reject(new ComputeError('SUPPLY_NOT_CONFIGURED', 503))
    return this.supply.updateSupplyPolicy(policy, signal)
  }

  /** Host-only author commit; validates expected owner and worker inside the supply serialization queue.
   * @param policy - Complete proposed policy.
   * @param authority - Original author id and current worker/account assertion; never supplied by a renderer.
   * @param signal - Optional caller cancellation.
   * @returns Fresh snapshot only after the exact author-bound policy commit.
   */
  updateBoundSupplyPolicy(policy: SupplyPolicy, authority: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.supply?.updateBoundSupplyPolicy) return Promise.reject(new ComputeError('SUPPLY_NOT_CONFIGURED', 503))
    return this.supply.updateBoundSupplyPolicy(policy, authority, signal)
  }

  /** Host-only atomic switch; never derives a write from the public effective owner view.
   * @param command - Explicit master-mode or individual-service intent.
   * @param authority - Optional original author/worker authority, never renderer-supplied.
   * @param signal - Optional caller cancellation.
   * @returns Fresh supply state after merging into committed policy in the controller queue.
   */
  updateOwnerSupply(command: OwnerSupplyCommand, authority?: SupplyPolicyWriteAuthority, signal?: AbortSignal): Promise<SupplySnapshot> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.supply?.updateOwnerSupply) return Promise.reject(new ComputeError('SUPPLY_NOT_CONFIGURED', 503))
    return this.supply.updateOwnerSupply(command, authority, signal)
  }

  /** Read the current account's advertised task types, not live node inventory.
   * @param signal - Caller cancellation bound to the upstream request.
   * @returns Advertised capabilities from the configured core.
   */
  capabilities(signal?: AbortSignal): Promise<ComputeCapability[]> { return this.core().getCapabilities(signal) }

  /**
   * Owner-selected input bytes stay on the PC and go directly to COS; this creates no task.
   * @param input - Owner-selected filename, content type and bytes for direct PC-to-storage upload.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns Verified direct-storage input metadata; upload alone creates no task.
   */
  uploadInputFile(input: { filename: string; contentType: string; bytes: Uint8Array },
    signal?: AbortSignal, purpose?: 'reviewed-video-first-frame'): Promise<PlanInputFile> {
    return this.core().uploadInputFile(input, signal, purpose)
  }

  /**
   * Developer task input contracts for a product detail form. Missing forms are not guessed.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns Server task contracts with explicit form readiness; missing schemas stay missing.
   */
  async taskTypes(signal?: AbortSignal): Promise<readonly {
    taskType: string
    capabilityId: string
    category: string
    description: string
    acceptedInputKinds: readonly string[]
    defaultInputKind: string
    requiredParams: readonly string[] | null
    canQuoteInline: boolean
    canQuoteFiles: boolean
    formReady: boolean
    reviewedVideoInput?: {
      schema: 'qianshou.reviewed-video-task-input.v1'
      publicationId: string
      approvedContractDigest: string
      firstFrameSlot: string
      promptSlot: string
      firstFrameManifestParam: 'input_manifest'
      firstFrameManifestIndex: 0
      promptParam: 'prompt'
      mimeType: 'image/png' | 'image/jpeg'
      maxBytes: number
      maxPromptUtf8Bytes: number
    }
    reviewedPublication?: {
      schema: 'qianshou.reviewed-publication-selection.v1'
      publicationId: string
      artifactDigest: string
      contractSha256: string
    }
    paramsSchema: DeveloperTaskType['paramsSchema']
    inputSchema: DeveloperTaskType['inputSchema']
  }[]> {
    const rows = await this.core().getDeveloperTaskTypes(signal)
    return rows.map((row) => {
      const properties = row.paramsSchema?.properties
      const requiredParams = row.requiredParams
      const rawRequiredParams: unknown = requiredParams
      const validRequiredParams = Array.isArray(rawRequiredParams)
      const hasRequiredFields = properties !== undefined && validRequiredParams && requiredParams != null
        && requiredParams.every(name => Object.hasOwn(properties, name))
      return {
        taskType: row.taskType, capabilityId: row.capabilityId ?? row.taskType,
        category: row.category ?? '', description: row.description ?? '',
        acceptedInputKinds: row.acceptedInputKinds, defaultInputKind: row.defaultInputKind,
        requiredParams: row.requiredParams ?? null,
        formReady: row.formReady === true, paramsSchema: row.paramsSchema ?? null, inputSchema: row.inputSchema ?? null,
        canQuoteInline: row.acceptedInputKinds.includes('inline') && validRequiredParams
          && ((row.formReady === true && hasRequiredFields)
            || (row.formSchemaVersion === null && requiredParams?.length === 0)),
        canQuoteFiles: row.acceptedInputKinds.includes('multi_file') && row.formReady === true
          && hasRequiredFields,
        ...(row.reviewedVideoInput === undefined ? {} : { reviewedVideoInput: {
          schema: row.reviewedVideoInput.schema,
          publicationId: row.reviewedVideoInput.publicationId,
          approvedContractDigest: row.reviewedVideoInput.approvedContractDigest,
          firstFrameSlot: row.reviewedVideoInput.firstFrameSlot,
          promptSlot: row.reviewedVideoInput.promptSlot,
          firstFrameManifestParam: row.reviewedVideoInput.firstFrameManifestParam,
          firstFrameManifestIndex: row.reviewedVideoInput.firstFrameManifestIndex,
          promptParam: row.reviewedVideoInput.promptParam,
          mimeType: row.reviewedVideoInput.mimeType,
          maxBytes: row.reviewedVideoInput.maxBytes,
          maxPromptUtf8Bytes: row.reviewedVideoInput.maxPromptUtf8Bytes,
        } }),
        ...(row.reviewedPublication === undefined ? {} : { reviewedPublication: {
          schema: row.reviewedPublication.schema,
          publicationId: row.reviewedPublication.publication_id,
          artifactDigest: row.reviewedPublication.artifact_digest,
          contractSha256: row.reviewedPublication.contract_sha256,
        } }),
      }
    })
  }

  /** Read Shanghai's current registry and developer entry independently.
   * No item in either list proves a live worker, owner permission, quote or dispatch.
   * @param signal - Caller cancellation; it is never converted into an unknown result.
   * @returns Separate bounded observations; a failed read retains null items, not a false empty list.
   */
  async capabilityDiscovery(signal?: AbortSignal): Promise<ComputeCapabilityDiscovery> {
    const unknown = (reason: NonNullable<ComputeCapabilityDiscovery['registry']['reason']>) => ({
      status: 'unreachable' as const, observedAt: null, reason,
    })
    let core: QianshouCoreClient
    try { core = this.core() }
    catch (error) {
      if (error instanceof ComputeError && error.code === 'COMPUTE_CLOSED') throw error
      return {
        registry: { ...unknown('not_configured'), registryVersion: null, capabilities: null },
        requestableTaskTypes: { ...unknown('not_configured'), items: null },
      }
    }
    const reason = (error: unknown): NonNullable<ComputeCapabilityDiscovery['registry']['reason']> =>
      error instanceof ComputeError && ['CORE_CREDENTIALS_MISSING', 'CORE_CREDENTIALS_INVALID', 'CORE_CREDENTIALS_UNAVAILABLE', 'CORE_HTTP_401', 'CORE_HTTP_403'].includes(error.code)
        ? 'auth_required' : 'request_failed'
    const checkCancellation = (error: unknown): void => {
      if (signal?.aborted || (error instanceof ComputeError && error.code === 'CORE_REQUEST_ABORTED')) throw error
    }
    const [registry, requestableTaskTypes] = await Promise.all([
      core.getCapabilityRegistry(signal).then(value => ({
        status: 'observed' as const, observedAt: new Date().toISOString(), reason: null,
        registryVersion: value.registryVersion, capabilities: value.capabilities,
      }), (error: unknown) => {
        checkCancellation(error)
        return { ...unknown(reason(error)), registryVersion: null, capabilities: null }
      }),
      core.getDeveloperTaskTypes(signal).then(value => ({
        status: 'observed' as const, observedAt: new Date().toISOString(), reason: null,
        items: value.map(({ taskType, acceptedInputKinds, defaultInputKind }) => ({ taskType, acceptedInputKinds, defaultInputKind })),
      }), (error: unknown) => {
        checkCancellation(error)
        return { ...unknown(reason(error)), items: null }
      }),
    ])
    return { registry, requestableTaskTypes }
  }

  /** Read owner identity, copied money strings, and ledger rows. Missing money stays null.
   * @param include - Optional slice; omitted returns every section, still without invented totals.
   * @param signal - Caller cancellation bound to the upstream request.
   * @returns Balance and rewards as upstream strings or null; withdrawals are WITHDRAW rows only.
   */
  async account(include?: string, signal?: AbortSignal): Promise<ComputeAccountSnapshot> {
    const unused = '本次未请求这一项'
    const notAdded = '收益只能来自平台，端侧不累加账本行。'
    const withdrawNote = '累计提现只列 type=WITHDRAW 的原文，不把负数相加；账本尾有限，total 为 null。'
    const usageNote = '本地 token 用量不是账户余额，未计入。'
    const empty = (reason: string): ComputeAccountSnapshot => ({
      identity: null,
      balance: null,
      balanceNote: reason,
      rewards: null,
      rewardsNote: reason,
      withdrawn: { total: null, rows: [] },
      withdrawnNote: reason,
      ledger: null,
      ledgerNote: reason,
      usageNote,
    })
    let core: QianshouCoreClient
    try {
      core = this.core()
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'COMPUTE_CLOSED') throw error
      return empty(ACCOUNT_FIELD_MISSING)
    }
    if (include !== undefined && include !== 'balance' && include !== 'ledger' && include !== 'rewards') {
      throw new ComputeError('INVALID_COMPUTE_INCLUDE')
    }
    const wantView = include === undefined || include === 'balance'
    const wantLedger = include === undefined || include === 'ledger' || include === 'rewards'
    const [view, rows] = await Promise.all([
      wantView
        ? core.getAccountView(signal).catch(() => null)
        : Promise.resolve(null),
      wantLedger
        ? core.getLedger(signal).catch(() => null)
        : Promise.resolve(null),
    ])
    const identity = view?.identity ?? null
    const balance = view?.balance ?? null
    const withdrawRows = rows === null ? [] : rows.filter(row => row.type === 'WITHDRAW')
    return {
      identity,
      balance: wantView ? balance : null,
      balanceNote: wantView ? (balance === null ? ACCOUNT_FIELD_MISSING : null) : unused,
      rewards: null,
      rewardsNote: include === 'balance' || include === 'ledger' ? unused : `${ACCOUNT_FIELD_MISSING}；${notAdded}`,
      withdrawn: { total: null, rows: include === 'balance' ? [] : withdrawRows },
      withdrawnNote: include === 'balance' ? unused : (rows === null ? ACCOUNT_FIELD_MISSING : withdrawNote),
      ledger: include === 'balance' ? null : rows,
      ledgerNote: include === 'balance' ? unused : (rows === null ? ACCOUNT_FIELD_MISSING : null),
      usageNote,
    }
  }

  /** Ask the scheduler who declares one capability. Missing answers stay unknown, never an empty pool.
   * @param capability - Contract or scheduler capability id.
   * @param signal - Caller cancellation bound to the upstream request.
   * @returns Catalog membership, declared ads, and available-now ads as separate facts.
   */
  async pool(capability: string, signal?: AbortSignal): Promise<CapabilityPoolSnapshot> {
    let core: QianshouCoreClient
    try {
      core = this.core()
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'COMPUTE_CLOSED') throw error
      return {
        lookup: 'unreachable',
        capability,
        registryVersion: null,
        declared: null,
        availableNow: null,
        provides: [],
        note: '目录里有没有这个能力，这一刻查不到池子；不能当成池里没人。',
      }
    }
    try {
      return await core.getCapabilityWorkers(capability, signal)
    } catch (error) {
      if (!(error instanceof ComputeError)) throw error
      if (error.code === 'CORE_INVALID_CAPABILITY_ID') throw error
      const listed = await core.registryContains(capability, signal)
      return {
        lookup: 'unreachable',
        capability,
        registryVersion: null,
        declared: null,
        availableNow: null,
        provides: [],
        note: listed === true
          ? '目录里有这个能力，但我现在查不到池子里有没有节点能接'
          : '目录里有没有这个能力，这一刻查不到池子；不能当成池里没人。',
      }
    }
  }

  /** Read existing owner-visible local drafts.
   * @returns Locally stored planning drafts.
   */
  plans(): Promise<ComputePlanDraft[]> { return this.store.list() }

  /** A registry observation authorizes only local planning syntax, never sale, execution or submission. */
  private async observedRegistryIds(signal?: AbortSignal): Promise<ReadonlySet<string>> {
    const registry = await this.core().getCapabilityRegistry(signal)
    signal?.throwIfAborted()
    return new Set(registry.capabilities.map(item => item.capability))
  }

  /** Create a draft only for a task type admitted by the live developer entry.
   * Reviewed video first frames must belong to the current core account before persistence.
   * Semantic registry membership alone does not prove a requestable task.
   * @param input - Untrusted UI or model planning request.
   * @param signal - Cancellation checked again before the local commit.
   * @returns The newly persisted local draft.
   */
  async createPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft> {
    const request = parsePlanRequest(input)
    signal?.throwIfAborted()
    const core = this.core()
    const catalog = await core.getDeveloperTaskTypes(signal)
    const landing = landingTaskType(request.capabilityId, catalog)
    if (!landing) throw new ComputeError(request.expectedVideoReview === undefined
      ? 'COMPUTE_CAPABILITY_UNAVAILABLE' : 'COMPUTE_VIDEO_REVIEW_CHANGED', 409)
    if (request.expectedProduct !== undefined) {
      await core.assertSelectedProduct(request.expectedProduct, landing.taskType, signal)
    }
    if (!landing.acceptedInputKinds.includes(request.fileInput === undefined ? 'inline' : 'multi_file')
      || !Array.isArray(landing.requiredParams)) {
      throw new ComputeError('COMPUTE_INPUT_KIND_UNSUPPORTED', 409)
    }
    developerTaskIntentRequest(request, landing)
    if (request.expectedVideoReview !== undefined) {
      assertReviewedVideoAccount(request, (await core.getIdentity(signal)).accountId)
    }
    signal?.throwIfAborted()
    return this.store.create(request)
  }

  /** Persist a local chain card, or reuse an accepted recipe. This never quotes, submits, or charges.
   * @param input - Untrusted tool arguments; `currency` is filled by the tool consumer.
   * @param signal - Cancellation checked again before the local commit.
   * @returns A new draft, or a `hit` card whose steps came from the stored recipe.
   */
  async createChain(input: unknown, signal?: AbortSignal): Promise<ComputeChainDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.chains) throw new ComputeError('COMPUTE_CHAINS_NOT_CONFIGURED', 503)
    const item = asRecord(input)
    const confirm = parseHumanConfirm(item.human_confirm ?? item.humanConfirm ?? {})
    const registryIds = await this.observedRegistryIds(signal)
    if (!recordHasSteps(input)) {
      const hit = await this.matchRecipe({
        recipe_id: item.recipe_id ?? item.recipeId,
        capabilities: item.capabilities,
        task_types: item.task_types ?? item.taskTypes,
        media_kinds: item.media_kinds ?? item.mediaKinds,
      }, signal)
      if (!hit) throw new ComputeError('COMPUTE_RECIPE_MISS', 404)
      if (hit.steps.some(step => !registryIds.has(step.capability))) throw new ComputeError('COMPUTE_CAPABILITY_NOT_REGISTRY', 409)
      signal?.throwIfAborted()
      return this.chains.admit({
        ...recipeHitCard(hit, {
          budgetMinor: typeof item.budgetMinor === 'number' ? item.budgetMinor : 0,
          maxNodes: typeof item.maxNodes === 'number' ? item.maxNodes : null,
        }),
        humanConfirm: confirm,
      })
    }
    const request = parseChainRequest(input, registryIds)
    signal?.throwIfAborted()
    if (this.recipes) {
      const existing = await this.recipes.match(recipeMatchQueryFromRequest(request))
      if (existing) return this.chains.admit({ ...recipeHitCard(existing, request), humanConfirm: confirm })
    }
    return this.chains.create(request, confirm, registryIds)
  }

  /** Persist an owner chain decision. This never quotes, submits, or charges.
   * @param input - Untrusted `{ id, decision }` from a conversation card.
   * @param signal - Cancellation checked before the local commit.
   * @returns The updated chain card.
   */
  async confirmChain(input: unknown, signal?: AbortSignal): Promise<ComputeChainDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.chains) throw new ComputeError('COMPUTE_CHAINS_NOT_CONFIGURED', 503)
    const confirmation = parseChainConfirmation(input)
    signal?.throwIfAborted()
    return this.chains.confirm(confirmation.id, confirmation.decision)
  }

  /** Record a due absence. Missing this write would make the timeout silent.
   * @param input - Untrusted `{ id }`.
   * @param signal - Cancellation checked before the local commit.
   * @returns The card after the stored absence policy is applied.
   */
  async applyChainAbsence(input: unknown, signal?: AbortSignal): Promise<ComputeChainDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.chains) throw new ComputeError('COMPUTE_CHAINS_NOT_CONFIGURED', 503)
    const locator = parseChainLocator(input)
    signal?.throwIfAborted()
    return this.chains.noteAbsence(locator.id, new Date())
  }

  /** Expand an approved chain into per-step local plan drafts. This never publishes or charges.
   * @param input - Untrusted `{ id }`.
   * @param signal - Cancellation checked before each local commit.
   * @returns The chain plus the local drafts. Drafts stay pending until the owner confirms each one.
   */
  async expandChain(input: unknown, signal?: AbortSignal): Promise<{ chain: ComputeChainDraft; drafts: ComputePlanDraft[] }> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.chains) throw new ComputeError('COMPUTE_CHAINS_NOT_CONFIGURED', 503)
    const locator = parseChainLocator(input)
    signal?.throwIfAborted()
    const chain = await this.chains.get(locator.id)
    if (chain.authorization !== 'approved') throw new ComputeError('COMPUTE_CHAIN_NOT_APPROVED', 409)
    if (chain.stepDraftIds) {
      const listed = await this.store.list()
      return {
        chain,
        drafts: chain.stepDraftIds.map((id) => {
          const draft = listed.find(item => item.id === id)
          if (!draft) throw new ComputeError('COMPUTE_CHAIN_EXPAND_INCOMPLETE', 409)
          return draft
        }),
      }
    }
    const drafts: ComputePlanDraft[] = []
    const total = chain.request.steps.length
    for (const [index, step] of chain.request.steps.entries()) {
      signal?.throwIfAborted()
      drafts.push(await this.store.create({
        capabilityId: step.capability,
        goal: `链 ${chain.id} 步骤 ${index + 1}/${total}：${step.capability}。本机展开，未下单、未报价、未扣费。`,
        budgetMinor: chain.request.budgetMinor,
        currency: 'CNY',
        maxNodes: chain.request.maxNodes,
      }))
    }
    return { chain: await this.chains.attachStepDrafts(locator.id, drafts.map(item => item.id)), drafts }
  }

  /** Look up an accepted local recipe. A miss is null so a model may compose.
   * @param input - Untrusted `{ recipe_id? , capabilities? , task_types? , media_kinds? }`.
   * @param signal - Cancellation checked before the file read.
   * @returns The accepted row, or null when nothing matches.
   */
  async matchRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord | null> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.recipes) throw new ComputeError('COMPUTE_RECIPES_NOT_CONFIGURED', 503)
    const query = parseRecipeMatchQuery(input)
    signal?.throwIfAborted()
    return this.recipes.match(query)
  }

  /** Persist a settled chain from `result.status`. This never submits or charges.
   * @param input - Untrusted `{ status, steps, recipe_id?, verify? }`.
   * @param signal - Cancellation checked before the local commit.
   * @returns The stored recipe. `partial` never becomes a row.
   */
  async settleRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.recipes) throw new ComputeError('COMPUTE_RECIPES_NOT_CONFIGURED', 503)
    const request = parseRecipeSettleRequest(input)
    signal?.throwIfAborted()
    return this.recipes.settle(request)
  }

  /** Demote a stored recipe to candidate so it stops auto-hitting.
   * @param input - Untrusted `{ sha256 }` or `{ recipe_id }`.
   * @param signal - Cancellation checked before the local commit.
   * @returns Updated rows.
   */
  async rejectRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord[]> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.recipes) throw new ComputeError('COMPUTE_RECIPES_NOT_CONFIGURED', 503)
    signal?.throwIfAborted()
    return this.recipes.reject(input)
  }

  /** Re-admit an `ok` candidate so it can auto-hit again.
   * @param input - Untrusted `{ sha256 }` or `{ recipe_id }`.
   * @param signal - Cancellation checked before the local commit.
   * @returns Updated rows.
   */
  async acceptRecipe(input: unknown, signal?: AbortSignal): Promise<ComputeRecipeRecord[]> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.recipes) throw new ComputeError('COMPUTE_RECIPES_NOT_CONFIGURED', 503)
    signal?.throwIfAborted()
    return this.recipes.accept(input)
  }

  /** Look up a previous deterministic processing result. Random chains miss.
   * @param input - Untrusted `{ steps, impls }`.
   * @param signal - Cancellation checked before the file read.
   * @returns The cached entry, or null on a miss.
   */
  async lookupResultCache(input: unknown, signal?: AbortSignal): Promise<ComputeResultCacheEntry | null> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.results) throw new ComputeError('COMPUTE_CACHE_NOT_CONFIGURED', 503)
    const request = parseResultCacheLookup(input)
    signal?.throwIfAborted()
    return this.results.get(request)
  }

  /** Store an ok deterministic result. This never submits or charges.
   * @param input - Untrusted `{ status, steps, impls, output }`.
   * @param signal - Cancellation checked before the local commit.
   * @returns The stored entry with matching output digest.
   */
  async storeResultCache(input: unknown, signal?: AbortSignal): Promise<ComputeResultCacheEntry> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.results) throw new ComputeError('COMPUTE_CACHE_NOT_CONFIGURED', 503)
    const request = parseResultCacheStore(input)
    signal?.throwIfAborted()
    return this.results.put(request)
  }

  /** Drop the local processing cache. This never contacts the core.
   * @param signal - Cancellation checked before the directory is removed.
   * @returns The number of rows removed.
   */
  async clearResultCache(signal?: AbortSignal): Promise<number> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.results) throw new ComputeError('COMPUTE_CACHE_NOT_CONFIGURED', 503)
    signal?.throwIfAborted()
    return this.results.clear()
  }

  /** Persist a local owner confirmation for the exact displayed execution price.
   * @param input - Untrusted `{ id, decision, quoteId }` from a conversation card.
   * @param signal - Cancellation checked before the local commit.
   * @returns The updated local draft.
   */
  async confirmPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const raw = asRecord(input)
    if (Object.keys(raw).sort().join(',') !== 'decision,id') throw new ComputeError('COMPUTE_QUOTE_REQUIRED', 409)
    const confirmation = parsePlanConfirmation(input)
    signal?.throwIfAborted()
    const plan = await this.store.confirm(confirmation.id, confirmation.decision)
    if (confirmation.decision === 'declined') this.quotes.delete(confirmation.id)
    return plan
  }

  /**
   * Legacy model/local route: an approved draft alone cannot authorize a paid POST.
   * Existing submitted drafts remain readable, but first submission requires the separate
   * Host quote and explicit owner-confirmation method below.
   * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns The existing confirmed draft or a new server workload receipt; uncertain submission remains unresolved.
   */
  async publishPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const publish = parsePlanPublish(input)
    signal?.throwIfAborted()
    const draft = (await this.store.list()).find(item => item.id === publish.id)
    if (!draft) throw new ComputeError('COMPUTE_PLAN_NOT_FOUND', 404)
    if (draft.authorization !== 'approved') throw new ComputeError('COMPUTE_PLAN_NOT_APPROVED', 409)
    if (draft.workloadId !== null) return draft
    throw new ComputeError('COMPUTE_QUOTE_CONFIRMATION_REQUIRED', 409)
  }

  /**
   * Ask Shanghai to price the exact final developer task without creating an order.
   * The page receives only this bounded view. A reviewed video's first frame must still
   * belong to the current core account. The ticket stays in the Host and is lost on
   * process restart; the owner then needs a fresh quote.
   * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns A bounded public quote view; its private ticket remains on the Host.
   */
  async quotePlan(input: unknown, signal?: AbortSignal): Promise<DeveloperTaskQuoteView> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const { id } = parsePlanPublish(input)
    signal?.throwIfAborted()
    const drafts = await this.store.list()
    const draft = drafts.find(item => item.id === id)
    if (!draft) throw new ComputeError('COMPUTE_PLAN_NOT_FOUND', 404)
    if (draft.authorization !== 'approved') throw new ComputeError('COMPUTE_PLAN_NOT_APPROVED', 409)
    if (draft.workloadId !== null) throw new ComputeError('COMPUTE_PLAN_ALREADY_PUBLISHED', 409)
    if (!this.ledger) throw new ComputeError('COMPUTE_SUBMISSION_LEDGER_UNAVAILABLE', 503)
    if (this.publishing.has(id)) throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
    if (draft.request.expectedVideoReview !== undefined || draft.request.expectedProduct !== undefined) this.quotes.delete(id)
    const core = this.core()
    const [identity, types] = await Promise.all([core.getIdentity(signal), core.getDeveloperTaskTypes(signal)])
    const prior = (await this.ledger.list()).find(item => item.accountId === String(identity.accountId)
      && item.taskId === id && item.status !== 'REJECTED')
    if (prior) throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
    const taskType = landingTaskType(draft.request.capabilityId, types)
    if (!taskType) throw new ComputeError(draft.request.expectedVideoReview === undefined
      ? 'COMPUTE_CAPABILITY_UNAVAILABLE' : 'COMPUTE_VIDEO_REVIEW_CHANGED', 409)
    if (draft.request.expectedProduct !== undefined) {
      await core.assertSelectedProduct(draft.request.expectedProduct, taskType.taskType, signal)
    }
    const fields = developerTaskIntentRequest(draft.request, taskType)
    assertReviewedVideoAccount(draft.request, identity.accountId)
    const body = developerTaskCreateBody(fields, randomBytes(32).toString('hex'))
    const estimate = await core.estimateDeveloperTask(body, signal)
    if (estimate.expiresAt <= Math.floor(Date.now() / 1000)) throw new ComputeError('COMPUTE_QUOTE_EXPIRED', 409)
    const view: DeveloperTaskQuoteView = {
      planId: draft.id,
      capabilityId: draft.request.capabilityId,
      quoteId: randomBytes(16).toString('hex'),
      taskType: body.task_type,
      name: estimate.name,
      goal: draft.request.goal,
      inputKind: body.input_kind,
      timeoutSeconds: body.timeout_s,
      maxShards: body.max_shards,
      autoShard: body.auto_shard,
      currency: 'CNY',
      requestedBudget: estimate.requestedBudget,
      recommendedBudget: estimate.recommendedBudget,
      expiresAt: estimate.expiresAt,
      balanceEnough: estimate.balanceEnough,
      priceBasis: estimate.priceBasis,
      settingsVersion: estimate.settingsVersion,
      billingMode: estimate.billingMode,
    }
    this.quotes.set(id, {
      view, accountId: String(identity.accountId), draftFingerprint: submissionRequestFingerprint(draft.request),
      body, quoteToken: estimate.quoteToken,
    })
    return view
  }

  /**
   * Trusted Host action after the owner has seen and accepted this exact amount.
   * Do not expose this method as a model tool or unreviewed generic local route.
   * The caller must show the quote view and pass its opaque quoteId plus the amount displayed.
   * @param input - Untrusted owner-selected intent or draft-confirmation metadata, validated by this operation.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns The existing submission or a workload created from the exact valid confirmed quote.
   */
  async confirmQuotedPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const item = asRecord(input)
    const { id } = parsePlanPublish({ id: item.id })
    if (typeof item.quoteId !== 'string' || !/^[a-f0-9]{32}$/u.test(item.quoteId)
      || typeof item.amount !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(item.amount)) {
      throw new ComputeError('COMPUTE_QUOTE_CONFIRMATION_INVALID')
    }
    const pending = this.quotes.get(id)
    if (!pending || pending.view.quoteId !== item.quoteId
      || canonicalYuan(item.amount) !== canonicalYuan(pending.view.recommendedBudget)) {
      throw new ComputeError('COMPUTE_QUOTE_CONFIRMATION_INVALID', 409)
    }
    if (pending.view.expiresAt <= Math.floor(Date.now() / 1000)) throw new ComputeError('COMPUTE_QUOTE_EXPIRED', 409)
    if (!pending.view.balanceEnough) throw new ComputeError('COMPUTE_QUOTE_BALANCE_INSUFFICIENT', 409)
    signal?.throwIfAborted()
    const inflight = this.publishing.get(id)
    if (inflight) return inflight
    const run = this.publishQuoted(id, pending, signal)
    this.publishing.set(id, run)
    try { return await run }
    finally { this.publishing.delete(id) }
  }

  private async publishQuoted(id: ComputePlanDraft['id'], pending: PreparedDeveloperQuote, signal?: AbortSignal): Promise<ComputePlanDraft> {
    const drafts = await this.store.list()
    const draft = drafts.find(item => item.id === id)
    if (!draft) throw new ComputeError('COMPUTE_PLAN_NOT_FOUND', 404)
    if (draft.authorization !== 'approved') throw new ComputeError('COMPUTE_PLAN_NOT_APPROVED', 409)
    if (draft.workloadId !== null) return draft
    if (submissionRequestFingerprint(draft.request) !== pending.draftFingerprint) throw new ComputeError('COMPUTE_QUOTE_PLAN_CHANGED', 409)
    if (!this.ledger) throw new ComputeError('COMPUTE_SUBMISSION_LEDGER_UNAVAILABLE', 503)
    const core = this.core()
    if (draft.request.expectedVideoReview !== undefined || draft.request.expectedProduct !== undefined) {
      const types = await core.getDeveloperTaskTypes(signal)
      const current = landingTaskType(draft.request.capabilityId, types)
      if (!current) throw new ComputeError(draft.request.expectedProduct === undefined
        ? 'COMPUTE_VIDEO_REVIEW_CHANGED' : 'COMPUTE_PRODUCT_SELECTION_CHANGED', 409)
      if (draft.request.expectedProduct !== undefined) {
        await core.assertSelectedProduct(draft.request.expectedProduct, current.taskType, signal)
      }
      const fresh = developerTaskIntentRequest(draft.request, current)
      const { idempotency_key: _key, ...quoted } = pending.body
      if (submissionRequestFingerprint(fresh) !== submissionRequestFingerprint(quoted)) {
        throw new ComputeError(draft.request.expectedProduct === undefined
          ? 'COMPUTE_VIDEO_REVIEW_CHANGED' : 'COMPUTE_PRODUCT_SELECTION_CHANGED', 409)
      }
    }
    const identity = await core.getIdentity(signal)
    assertReviewedVideoAccount(draft.request, identity.accountId)
    if (String(identity.accountId) !== pending.accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
    if (pending.view.expiresAt <= Math.floor(Date.now() / 1000)) throw new ComputeError('COMPUTE_QUOTE_EXPIRED', 409)
    const { quote_token: _ignored, ...request } = {
      ...pending.body, budget: canonicalYuan(pending.view.recommendedBudget), quote_token: pending.quoteToken,
    }
    const confirmedBody: DeveloperTaskCreateBody = { ...request, quote_token: pending.quoteToken }
    const now = new Date().toISOString()
    const prior = (await this.ledger.list()).find(item => item.accountId === pending.accountId
      && item.taskId === id && item.status !== 'REJECTED')
    if (prior) throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
    const recorded = await this.ledger.recordIntentWithKey({
      accountId: pending.accountId, taskId: draft.id, request, attempt: 1,
    }, pending.body.idempotency_key, now)
    if (!recorded.inserted) throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
    await this.ledger.transition(recorded.record.idempotencyKey, { type: 'submitting' }, now)
    try {
      signal?.throwIfAborted()
      const created = await core.createDeveloperTask(confirmedBody, signal)
      const attached = await this.store.attachWorkload(draft.id, created.id)
      await this.ledger.reconcile(recorded.record.idempotencyKey, {
        observed: 'workload-present', evidence: created.id,
      }, new Date().toISOString())
      this.quotes.delete(id)
      return attached
    } catch (error) {
      const code = error instanceof ComputeError ? error.code : ''
      const absent = code === 'CORE_HTTP_400' || code === 'CORE_HTTP_401' || code === 'CORE_HTTP_403' || code === 'CORE_HTTP_422'
      const at = new Date().toISOString()
      if (absent) {
        await this.ledger.reconcile(recorded.record.idempotencyKey, {
          observed: 'workload-absent', evidence: 'rejected',
        }, at)
      } else {
        await this.ledger.transition(recorded.record.idempotencyKey, { type: 'unknown' }, at)
      }
      throw error
    }
  }

  /** Read a workload with the configured account; ownership is enforced by the core.
   * @param id - Workload identity provided by the user or a core receipt.
   * @param signal - Caller cancellation.
   * @returns Owner-visible workload summary.
   */
  workload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadSummary> { return this.core().getWorkload(id, signal) }

  /** Read owner-visible inline result text; this does not download artifacts or settle.
   * @param id - Workload identity provided by the user or a core receipt.
   * @param signal - Caller cancellation.
   * @returns Inline UTF-8 or an artifact reference from the developer-task result route.
   */
  workloadResult(id: string, signal?: AbortSignal): Promise<ComputeWorkloadResult> {
    return this.core().getWorkloadResult(id, signal)
  }

  /**
   * Read the authenticated owner's current buyer-acceptance record without settling it.
   * @param id - The workload identity belonging to the authenticated owner.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns The current owner-visible buyer-acceptance record, or null if none exists.
   */
  workloadAcceptance(id: string, signal?: AbortSignal): Promise<CoreBuyerAcceptance | null> {
    return this.core().getBuyerAcceptance(id, signal)
  }

  /**
   * Apply one explicit buyer decision with its idempotency key through the authoritative core.
   * @param id - The workload identity belonging to the authenticated owner.
   * @param decision - The explicitly chosen accept or reject decision.
   * @param idempotencyKey - The stable key for this explicitly requested buyer decision.
   * @param signal - Caller cancellation for this bounded operation.
   * @returns The server-confirmed decision for the selected owner workload.
   */
  decideWorkloadAcceptance(id: string, decision: 'accept' | 'reject',
    idempotencyKey: string, signal?: AbortSignal): Promise<CoreBuyerAcceptance> {
    return this.core().decideBuyerAcceptance(id, decision, idempotencyKey, signal)
  }

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
  async cancelWorkload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadCancellation> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const current = await this.core().getWorkload(id, signal)
    if (current.status === 'CANCELLED') {
      return { id: current.id, state: 'CANCELLED', alreadyTerminal: true, ledger: await this.refundEvidence(current.id, signal) }
    }
    if (current.status === 'DONE' || current.status === 'FAILED') {
      throw new ComputeError('COMPUTE_WORKLOAD_ALREADY_TERMINAL', 409)
    }
    let cancelled: { id: ComputeWorkloadId; status: string }
    try {
      cancelled = await this.core().cancelWorkload(current.id, signal)
    } catch (error) {
      // The task may have reached a terminal state between our read and the delete; the scheduler
      // answers 400 for that, and the honest local answer is "too late", not "upstream failed".
      if (error instanceof ComputeError && error.code === 'CORE_HTTP_400') {
        throw new ComputeError('COMPUTE_WORKLOAD_ALREADY_TERMINAL', 409)
      }
      throw error
    }
    return { id: current.id, state: cancelled.status, alreadyTerminal: false, ledger: await this.refundEvidence(current.id, signal) }
  }

  /** Ledger facts for one workload: refund rows and their total, or null when the tail cannot be read. */
  private async refundEvidence(id: ComputeWorkloadId, signal?: AbortSignal): Promise<ComputeWorkloadRefundEvidence | null> {
    let rows: readonly CoreLedgerEntry[]
    try {
      rows = await this.core().getLedger(signal)
    } catch {
      // The cancel already happened; failing the whole call because the *evidence* read failed
      // would report the wrong thing. The caller is told the evidence is unavailable instead.
      return null
    }
    const mine = rows.filter(row => row.workloadId === id)
    const refundMinor = mine.filter(row => row.type === 'REFUND')
      .reduce((total, row) => total + Math.round(Number(row.amount) * 100), 0)
    return {
      refundMinor: Number.isFinite(refundMinor) ? refundMinor : 0,
      rows: mine.map(row => ({ type: row.type, amount: row.amount, note: row.note, createdAt: row.createdAt })),
    }
  }

  /** Execute one already-admitted assignment through an exact local plugin version.
   * @param task - Versioned assignment received from the dispatch layer.
   * @param request - Controlled input provider, workspace limits, cancellation and result consumer.
   * @returns Result-consumer receipt after all local workspace files have been cleaned up.
   */
  executeTask<T>(task: ComputeTaskEnvelope, request: ComputeLocalTaskRequest<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    return this.runner.run(task, request)
  }

  /** Read a local task attempt without treating it as a remote completion receipt.
   * @param taskId - Local task identity.
   * @param attempt - Attempt number.
   * @returns Stored attempt state, or null when absent.
   */
  task(taskId: string, attempt: number): Promise<ComputeTaskState | null> {
    if (!this.tasks) return Promise.resolve(null)
    return this.tasks.get(taskId, attempt)
  }

  /** Persist one lifecycle event for a local task attempt.
   * @param taskId - Local task identity.
   * @param attempt - Attempt number.
   * @param event - Lifecycle event to apply.
   * @param now - Canonical current UTC timestamp.
   * @returns Updated persisted attempt state.
   */
  transitionTask(taskId: string, attempt: number, event: ComputeTaskEvent, now: string): Promise<ComputeTaskState> {
    if (!this.tasks) return Promise.reject(new ComputeError('COMPUTE_TASK_STORE_UNAVAILABLE', 503))
    return this.tasks.transition(taskId, attempt, event, now)
  }

  /** Admit one verified passive offer through the unified scheduler and task store.
   * @param input - Verified offer and current scheduling context.
   * @returns Admission decision and persisted state when accepted.
   */
  coordinateTask(input: EmployeeTaskCoordinateInput): Promise<EmployeeTaskCoordinationResult> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    if (!this.coordinator) return Promise.reject(new ComputeError('COMPUTE_TASK_STORE_UNAVAILABLE', 503))
    return this.coordinator.coordinate(input)
  }

  /** Cancel core reads and drain accepted local writes on plugin removal. */
  async close(): Promise<void> {
    this.closed = true
    this.#pluginSampleStop.abort()
    await Promise.allSettled([...this.#activePluginSamples])
    await this.privatePluginActivation?.close()
    this.quotes.clear()
    await Promise.all([this.coordinator?.close(), this.runner.close(), this.client?.close(), this.supply?.close(), this.ledger?.close()])
    await this.store.close()
    await this.tasks?.close()
    await this.chains?.close()
    await this.recipes?.close()
    await this.results?.close()
    await this.pluginDrafts?.close()
  }
}

/** Exact CNY cents for quote acknowledgement; never use floating-point money comparison. */
function canonicalYuan(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value) || value.length > 32) {
    throw new ComputeError('COMPUTE_QUOTE_CONFIRMATION_INVALID')
  }
  const [whole, fraction = ''] = value.split('.')
  return `${whole}.${fraction.padEnd(2, '0')}`
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('INVALID_COMPUTE_OBJECT')
  return value as Record<string, unknown>
}

function recordHasSteps(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'steps' in value
}
