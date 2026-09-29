/** Current Edge HTTP projection. Native workload responses are not wrapped in an invented envelope. */
import { requestJson, safeOrigin, validateTransportOptions, type JsonTransportOptions } from './http.ts'
import { record, SupplyError } from './policy.ts'

/** Safe catalogue fields; the source does not promise capability versions or online worker availability. */
export interface EdgeTaskType {
  readonly taskType: string
  readonly description: string
  readonly executor: string
  readonly runtimes: readonly string[]
  readonly requiredSoftware: readonly string[]
  readonly requiresGpu: boolean
  readonly minMemoryMb: number
}
/** A workload read preserves native status and does not infer ledger spend or missing timestamps. */
export interface EdgeWorkload {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly progress: number
  readonly totalShards: number
  readonly completedShards: number
  readonly failedShards: number
  readonly createdAt: string
  readonly completedAt: string | null
}
/** Actual quote request accepted by economy.py; workload unit depends on the task type. */
export interface EdgeQuoteRequest {
  readonly taskType: string
  readonly workload: number
  readonly speed: 't24' | 't8' | 't2'
  readonly quality: 'standard' | 'double' | 'high'
}
/** Server monetary strings retain precision; a quote does not reserve budget or authorize a task. */
export interface EdgeQuote {
  readonly taskType: string
  readonly unit: string
  readonly workload: number
  readonly totalYuan: string
  readonly totalCp: string
  readonly nodeCp: string
  readonly platformCp: string
  readonly channelCp: string
  readonly riskPoolCp: string
  readonly settingsVersion: number
  readonly currency: 'CNY'
  readonly minChargeApplied: boolean
  readonly authority: 'estimate-only'
}
/** Authentication is supplied by the existing account owner and is never returned in public data. */
export interface EdgeApiOptions extends JsonTransportOptions {
  readonly baseUrl: string
  readonly tokenProvider: () => string | undefined
}
/** Read identity, catalogue and workloads, and request the existing non-reserving price simulation. */
export class EdgeSupplyApi {
  private readonly origin: URL
  private readonly lifetime = new AbortController()
  /** Bind an audited service origin and caller-owned token provider; no request occurs here.
 * @param options - Trusted origin, request limits and account token provider.
 */
  constructor(private readonly options: EdgeApiOptions) {
    this.origin = safeOrigin(options.baseUrl)
    validateTransportOptions(options)
  }
  /** Read the current authenticated account ID while discarding unrelated account fields.
 * @param signal - Optional caller cancellation signal.
 * @returns The authenticated account identifier.
 */
  async queryIdentity(signal?: AbortSignal): Promise<{ readonly accountId: number }> {
    const value = await this.request('/api/v8/auth/me', undefined, signal)
    if (!record(value) || value.ok !== true || !record(value.account) || !safeInteger(value.account.id)) invalid()
    return { accountId: value.account.id }
  }
  /** Read the workload catalogue without inventing worker availability or capability versions.
 * @param signal - Optional caller cancellation signal.
 * @returns Catalogue entries reported by the server.
 */
  async queryCapabilities(signal?: AbortSignal): Promise<readonly EdgeTaskType[]> {
    const value = await this.request('/api/v8/developer/task-types', undefined, signal)
    if (!record(value) || value.ok !== true || !Array.isArray(value.items) || !safeInteger(value.total)) invalid()
    return value.items.map(item => {
      if (!record(item) || !safeText(item.task_type) || typeof item.description !== 'string' || !safeText(item.executor)
        || !strings(item.runtimes) || !strings(item.required_software) || typeof item.requires_gpu !== 'boolean'
        || !finiteNonnegative(item.min_memory_mb)) invalid()
      return { taskType: item.task_type, description: item.description, executor: item.executor, runtimes: item.runtimes,
        requiredSoftware: item.required_software, requiresGpu: item.requires_gpu, minMemoryMb: item.min_memory_mb }
    })
  }
  /** Read the server's direct workload array through its account authorization.
 * @param signal - Optional caller cancellation signal.
 * @returns Authorized workloads with native status fields.
 */
  async queryWorkloads(signal?: AbortSignal): Promise<readonly EdgeWorkload[]> {
    const value = await this.request('/api/v8/workloads', undefined, signal)
    if (!Array.isArray(value)) invalid()
    return value.map(parseWorkload)
  }
  /** Read one workload's native status without exposing input/result payloads.
 * @param id - Server workload identifier.
 * @param signal - Optional caller cancellation signal.
 * @returns The authorized workload status projection.
 */
  async queryWorkload(id: string, signal?: AbortSignal): Promise<EdgeWorkload> {
    if (!/^[\w-]{1,256}$/.test(id)) throw new SupplyError('EDGE_WORKLOAD_ID_INVALID')
    return parseWorkload(await this.request(`/api/v8/workloads/${encodeURIComponent(id)}`, undefined, signal))
  }
  /** Request existing price simulation; this method never submits a task or reserves funds.
 * @param input - Task amount and service-level inputs accepted by the quote endpoint.
 * @param signal - Optional caller cancellation signal.
 * @returns The server estimate with precise monetary strings and no reservation authority.
 */
  async queryQuote(input: EdgeQuoteRequest, signal?: AbortSignal): Promise<EdgeQuote> {
    if (!safeText(input.taskType) || !finiteNonnegative(input.workload) || !['t24', 't8', 't2'].includes(input.speed)
      || !['standard', 'double', 'high'].includes(input.quality)) throw new SupplyError('EDGE_QUOTE_INPUT_INVALID')
    const value = await this.request('/api/v8/economy/quote', { task_type: input.taskType, workload: input.workload, speed: input.speed, quality: input.quality }, signal)
    if (!record(value) || value.task_type !== input.taskType || !safeText(value.unit) || !finiteNonnegative(value.workload)
      || value.currency !== 'CNY' || typeof value.min_charge_applied !== 'boolean' || !safeInteger(value.settings_version)
      || !decimal(value.total_yuan) || !decimal(value.total_cp) || !decimal(value.node_cp) || !decimal(value.platform_cp)
      || !decimal(value.channel_cp) || !decimal(value.risk_pool_cp)) invalid()
    return { taskType: value.task_type, unit: value.unit, workload: value.workload, totalYuan: value.total_yuan,
      totalCp: value.total_cp, nodeCp: value.node_cp, platformCp: value.platform_cp, channelCp: value.channel_cp,
      riskPoolCp: value.risk_pool_cp, settingsVersion: value.settings_version, currency: value.currency,
      minChargeApplied: value.min_charge_applied, authority: 'estimate-only' }
  }
  /** Abort active HTTP requests and forbid new requests from this client. */
  close(): void { this.lifetime.abort() }
  private request(path: string, body: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
    if (this.lifetime.signal.aborted) return Promise.reject(new SupplyError('SUPPLY_CLOSED'))
    let token: string | undefined
    try { token = this.options.tokenProvider() } catch { return Promise.reject(new SupplyError('SUPPLY_AUTH_REQUIRED')) }
    if (!token || /[\r\n]/.test(token)) return Promise.reject(new SupplyError('SUPPLY_AUTH_REQUIRED'))
    return requestJson(new URL(path, this.origin), { method: body ? 'POST' : 'GET', headers: {
      authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }, this.options,
    signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal)
  }
}
function parseWorkload(value: unknown): EdgeWorkload {
  if (!record(value) || !safeText(value.id) || typeof value.name !== 'string' || !safeText(value.status)
    || !finiteNonnegative(value.progress) || !safeInteger(value.total_shards) || !safeInteger(value.completed_shards)
    || !safeInteger(value.failed_shards) || !safeText(value.created_at) || !(value.completed_at === null || safeText(value.completed_at))) invalid()
  return { id: value.id, name: value.name, status: value.status, progress: value.progress, totalShards: value.total_shards,
    completedShards: value.completed_shards, failedShards: value.failed_shards, createdAt: value.created_at, completedAt: value.completed_at }
}
function safeText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(safeText) }
function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function safeInteger(value: unknown): value is number { return finiteNonnegative(value) && Number.isSafeInteger(value) }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) }
function invalid(): never { throw new SupplyError('EDGE_RESPONSE_INVALID') }
