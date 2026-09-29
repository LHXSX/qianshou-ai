/** Host service linking local drafts to the existing core's catalogue and developer-task publish. */
import type { ComputeCapability, ComputeConnectionState, ComputePlanDraft, ComputeWorkloadSummary } from './protocol.ts'
import { parsePlanConfirmation, parsePlanPublish, parsePlanRequest } from './validation.ts'
import { ComputeError } from './errors.ts'
import { ComputeDraftStore } from './store.ts'
import type { QianshouCoreClient } from './core-client.ts'
import { ComputeExecutorRegistry } from './executor.ts'
import { ComputeLocalTaskRunner, type ComputeLocalTaskRequest } from './local-task-runner.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import { ComputeTaskStore } from './task-store.ts'
import type { ComputeTaskEvent, ComputeTaskState } from './task-state.ts'
import { EmployeeTaskCoordinator, type EmployeeTaskCoordinationResult, type EmployeeTaskCoordinateInput } from './employee-task-coordinator.ts'
import type { SupplyClient, SupplyPolicy, SupplySnapshot } from './supply/types.ts'
import { developerTaskCreateBody, developerTaskIntentRequest } from './developer-task.ts'
import { canResubmit, SubmissionLedger } from './submission-ledger.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { computeCore: ComputeService }
}

/** Core catalogue, local drafts, and authorized developer-task publish. */
export class ComputeService {
  private closed = false
  private readonly publishing = new Map<string, Promise<ComputePlanDraft>>()
  /** Local capability contributions used by the unified agent executor. */
  readonly executors: ComputeExecutorRegistry = new ComputeExecutorRegistry()
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
   */
  constructor(
    private readonly client: QianshouCoreClient | null,
    private readonly store: ComputeDraftStore,
    private readonly hasCredential: () => boolean,
    readonly tasks?: ComputeTaskStore,
    private readonly supply?: SupplyClient,
    private readonly ledger?: SubmissionLedger,
  ) {
    if (tasks) this.coordinator = new EmployeeTaskCoordinator(tasks)
  }

  /** Report configured features; this is not a connectivity or account validation probe.
   * @returns Current local configuration state.
   */
  status(): ComputeConnectionState {
    const configured = !this.closed && this.client !== null && this.hasCredential()
    return { configured, capabilities: { workloadRead: configured, quoting: false, submission: configured }, message: configured
      ? '核心连接已配置，能力目录可查询。已确认的方案可通过开发者任务入口发布；报价仍未接入。'
      : '尚未配置算力核心地址和当前账号凭证；本地草稿可查看，任务提交未启用。' }
  }

  private core(): QianshouCoreClient {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    if (!this.client || !this.hasCredential()) throw new ComputeError('COMPUTE_NOT_CONFIGURED', 503)
    return this.client
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

  /** Read the current account's advertised task types, not live node inventory.
   * @param signal - Caller cancellation bound to the upstream request.
   * @returns Advertised capabilities from the configured core.
   */
  capabilities(signal?: AbortSignal): Promise<ComputeCapability[]> { return this.core().getCapabilities(signal) }

  /** Read existing owner-visible local drafts.
   * @returns Locally stored planning drafts.
   */
  plans(): Promise<ComputePlanDraft[]> { return this.store.list() }

  /** Create a draft only for a capability verified against the core catalog.
   * @param input - Untrusted UI or model planning request.
   * @param signal - Cancellation checked again before the local commit.
   * @returns The newly persisted local draft.
   */
  async createPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft> {
    const request = parsePlanRequest(input)
    signal?.throwIfAborted()
    const catalog = await this.capabilities(signal)
    if (!catalog.some(item => item.id === request.capabilityId && item.available)) throw new ComputeError('COMPUTE_CAPABILITY_UNAVAILABLE', 409)
    signal?.throwIfAborted()
    return this.store.create(request)
  }

  /** Persist a local owner confirmation; this never quotes, submits, or charges.
   * @param input - Untrusted `{ id, decision }` from a conversation card or compute page.
   * @param signal - Cancellation checked before the local commit.
   * @returns The updated local draft.
   */
  async confirmPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const confirmation = parsePlanConfirmation(input)
    signal?.throwIfAborted()
    return this.store.confirm(confirmation.id, confirmation.decision)
  }

  /** Publish an approved local draft through `POST /api/v8/developer/tasks`.
   * Unknown submit results stay in the local ledger and are never retried automatically.
   * This method never POSTs `/api/v8/workloads`.
   * @param input - Untrusted `{ id }` from a conversation card or compute page.
   * @param signal - Cancellation checked before the core POST.
   * @returns The draft with a core-issued `workloadId`.
   */
  async publishPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft> {
    if (this.closed) throw new ComputeError('COMPUTE_CLOSED', 503)
    const publish = parsePlanPublish(input)
    signal?.throwIfAborted()
    const inflight = this.publishing.get(publish.id)
    if (inflight) return inflight
    const run = this.publishApproved(publish.id, signal)
    this.publishing.set(publish.id, run)
    try { return await run }
    finally { this.publishing.delete(publish.id) }
  }

  private async publishApproved(id: ComputePlanDraft['id'], signal?: AbortSignal): Promise<ComputePlanDraft> {
    const drafts = await this.store.list()
    const draft = drafts.find(item => item.id === id)
    if (!draft) throw new ComputeError('COMPUTE_PLAN_NOT_FOUND', 404)
    if (draft.authorization !== 'approved') throw new ComputeError('COMPUTE_PLAN_NOT_APPROVED', 409)
    if (draft.workloadId !== null) return draft
    if (!this.ledger) throw new ComputeError('COMPUTE_SUBMISSION_LEDGER_UNAVAILABLE', 503)
    const core = this.core()
    const [identity, types] = await Promise.all([core.getIdentity(signal), core.getDeveloperTaskTypes(signal)])
    const taskType = types.find(item => item.taskType === draft.request.capabilityId)
    if (!taskType) throw new ComputeError('COMPUTE_CAPABILITY_UNAVAILABLE', 409)
    const fields = developerTaskIntentRequest(draft.request, taskType)
    const now = new Date().toISOString()
    const base = { accountId: String(identity.accountId), taskId: draft.id, request: fields }
    let recorded = await this.ledger.recordIntent({ ...base, attempt: 1 }, now)
    if (recorded.record.status === 'REJECTED' && canResubmit(recorded.record)) {
      recorded = await this.ledger.recordIntent({ ...base, attempt: recorded.record.attempt + 1 }, now)
    }
    if (recorded.record.status === 'CONFIRMED') throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
    if (recorded.record.status !== 'INTENT_RECORDED') throw new ComputeError('COMPUTE_SUBMISSION_UNKNOWN', 409)
    await this.ledger.transition(recorded.record.idempotencyKey, { type: 'submitting' }, now)
    try {
      signal?.throwIfAborted()
      const created = await core.createDeveloperTask(
        developerTaskCreateBody(fields, recorded.record.idempotencyKey),
        signal,
      )
      const attached = await this.store.attachWorkload(draft.id, created.id)
      await this.ledger.reconcile(recorded.record.idempotencyKey, {
        observed: 'workload-present', evidence: created.id,
      }, new Date().toISOString())
      return attached
    } catch (error) {
      const code = error instanceof ComputeError ? error.code : ''
      const absent = code === 'CORE_HTTP_401' || code === 'CORE_HTTP_403' || code === 'CORE_HTTP_422'
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
    await Promise.all([this.coordinator?.close(), this.runner.close(), this.client?.close(), this.supply?.close(), this.ledger?.close()])
    await this.store.close()
    await this.tasks?.close()
  }
}
