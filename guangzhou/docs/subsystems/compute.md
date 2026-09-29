# Compute

English | [中文](compute.zh.md)

The compute subsystem exposes `ctx.computeCore` for authenticated capability reads, local planning drafts, authorized developer-task publish, and execution of already admitted assignments. It keeps remote account reads, local task state, executor selection, controlled workspaces, and result consumption behind one Host service. Catalogue entries do not prove online nodes, prices, or settlement; publish may freeze budget through the core developer-task route.

Capabilities stay opaque: Qianshou handles only the `capabilityId`, version and plugin digest advertised by a node. It does not provide or infer H3, image, video or any other concrete model capability. A node agent publishes an advertisement only after local self-checks, and the dispatch center selects exact `capabilityId@version@pluginDigest` matches from online node advertisements; the executor registry on this page is the seam through which the unified agent invokes a node-owned executor.

## Public records

`ComputeConnectionState` reports configured read features without exposing credentials. `ComputeCapability`, `ComputePlanDraft`, and `ComputeWorkloadSummary` carry capability, local planning, and owner-visible workload projections; their field contracts live in [protocol.ts](../../packages/host/compute-core/src/protocol.ts). Workspace input and output rules live in [task-workspace.ts](../../packages/host/compute-core/src/task-workspace.ts), task lifecycle states in [task-state.ts](../../packages/host/compute-core/src/task-state.ts), and admission records in [employee-task-coordinator.ts](../../packages/host/compute-core/src/employee-task-coordinator.ts). The generated region below contains the `ctx.computeCore` method signatures.

The [resident task loop](../../packages/host/compute-core/src/resident-loop.ts) is a host-driven tick seam: it sends a redacted heartbeat and serially coordinates verified passive offers. It owns ordering and shutdown only; timer, resource observation, queue transport, execution and upload remain separate adapters.

## Local execution and admission

`ctx.computeCore` reads the configured core through the existing authenticated connection and persists bounded drafts and task attempts locally. `executeTask` accepts only a versioned `ComputeTaskEnvelope` and a controlled `ComputeLocalTaskRequest`; the managed runner stages input in a private workspace, calls the executor registry for the exact registered capability version, verifies output, waits for the result consumer, and cleans up after the consumer finishes. `coordinateTask` persists an admitted employee assignment only after dispatch verification and scheduler decisions. Cancellation and shutdown stop new work and drain active cleanup before stores close.

## Ownership and limits

The compute package owns configuration, local stores, executor registration, and task lifecycle mechanics. The dispatch service owns node identity, trusted signing keys, leases, remote transport, prices, and settlement. A package README documents configuration and implementation responsibilities; this page owns the shared public records and the `ctx.computeCore` service reference.

## Plugin market trust boundary

`planCapabilityPluginInstall` parses an untrusted manifest and verifies the package digest, host compatibility, declared permission grants, and a deployment-supplied signature. It returns a frozen `verified` plan only; it never downloads, unpacks, loads, or executes plugin code. Transactional staging, process isolation, rollback, and artifact scanning belong to a deployment adapter. GPU and local-model permissions require native review. Shanghai remains a metadata-only control plane and cannot install, charge, or settle a plugin.

## Quote and estimate boundary

The current source-verified v8 contract exposes authenticated account identity, advertised task types, owner-visible workload progress, and `POST /api/v8/developer/tasks` with a required `idempotency_key`. It does not define a quote or estimate request path, request body, response envelope, ownership binding, expiry/signature rule, or pricing currency contract. `ComputeQuote` and its parser remain unused local metadata types; `QianshouCoreClient` has no quote or estimate method and never guesses a price from catalogue data. Configured cores report `submission: true` and `quoting: false`. An unknown developer-task POST is recorded locally and is never retried automatically.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputecore--computeservice"></a>

### `ctx.computeCore` — `ComputeService`

Core catalogue, local drafts, and authorized developer-task publish.

```ts cordis-catalog
/** Report configured features; this is not a connectivity or account validation probe.
 * @returns Current local configuration state.
 */
status(): ComputeConnectionState

/** Read fresh local resource facts independently of cloud model configuration.
 * @param signal - Cancellation for bounded local probes.
 * @returns Actual observations and saved owner policy; unknown facts stay unknown.
 */
querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot>

/** Persist a complete owner policy without buying or submitting a task.
 * @param policy - Complete policy validated by the supply controller before persistence.
 * @param signal - Caller cancellation; a committed policy remains saved after a probe error.
 * @returns Fresh local supply state after the committed change.
 */
updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot>

/** Read the current account's advertised task types, not live node inventory.
 * @param signal - Caller cancellation bound to the upstream request.
 * @returns Advertised capabilities from the configured core.
 */
capabilities(signal?: AbortSignal): Promise<ComputeCapability[]>

/** Read existing owner-visible local drafts.
 * @returns Locally stored planning drafts.
 */
plans(): Promise<ComputePlanDraft[]>

/** Create a draft only for a capability verified against the core catalog.
 * @param input - Untrusted UI or model planning request.
 * @param signal - Cancellation checked again before the local commit.
 * @returns The newly persisted local draft.
 */
async createPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Persist a local owner confirmation; this never quotes, submits, or charges.
 * @param input - Untrusted `{ id, decision }` from a conversation card or compute page.
 * @param signal - Cancellation checked before the local commit.
 * @returns The updated local draft.
 */
async confirmPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Publish an approved local draft through `POST /api/v8/developer/tasks`.
 * Unknown submit results stay in the local ledger and are never retried automatically.
 * This method never POSTs `/api/v8/workloads`.
 * @param input - Untrusted `{ id }` from a conversation card or compute page.
 * @param signal - Cancellation checked before the core POST.
 * @returns The draft with a core-issued `workloadId`.
 */
async publishPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Read a workload with the configured account; ownership is enforced by the core.
 * @param id - Workload identity provided by the user or a core receipt.
 * @param signal - Caller cancellation.
 * @returns Owner-visible workload summary.
 */
workload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadSummary>

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

Source: [`packages/host/compute-core/src/service.ts`](../../packages/host/compute-core/src/service.ts)
<!-- END GENERATED cordis-surface -->

## Further Exploration

- [Compute core package](../../packages/host/compute-core/README.md) — configuration, local stores, executors, and task runner.
- [Remote devices](remote-devices.md) — authenticated finite-task coordination for paired machines.
- [Cordis catalog](../cordis-api/service.md) — generated service signatures shared by the runtime.

### Dev Note

The generated region was produced and compared through the existing analyzer, projector, renderer and locale mapper restricted to the compute package. The reproducible script is archived with the project handoff receipts. The repository-wide generator then still failed on the unrelated `connections`, `subagents` and `employeeSettings` owners; those owners are now fixed, so the complete catalog and its runtime API artifact regenerate and verify as a whole, as the partition work recorded under `docs/dev-plan/` documents.
