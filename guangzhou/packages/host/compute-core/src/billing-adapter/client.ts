/** Narrow account and estimate reads reuse existing core authority and the bounded HTTP transport. */
import { requestJson, safeOrigin, validateTransportOptions, type JsonTransportOptions } from '../supply/http.ts'
import { record, SupplyError } from '../supply/policy.ts'
import type { EdgeBalance, EdgeBudgetEstimate, EdgeEstimateRequest, EdgeLedgerPage, EdgeLedgerQuery } from './types.ts'

/** Host-owned account credentials and resource bounds; no credentials appear in returned data. */
export interface EdgeBillingOptions extends JsonTransportOptions {
  readonly baseUrl: string
  readonly tokenProvider: () => string | undefined
  readonly maxRequestBytes: number
}

/** Query current account records and price estimates without any charge, freeze or purchase method. */
export class EdgeBillingApi {
  private readonly origin: URL
  private readonly lifetime = new AbortController()

  /** Bind an audited endpoint and existing account token provider without performing network I/O.
   * @param options - Trusted endpoint, account provider and transport limits.
   */
  constructor(private readonly options: EdgeBillingOptions) {
    this.origin = safeOrigin(options.baseUrl)
    validateTransportOptions(options)
    if (!Number.isSafeInteger(options.maxRequestBytes) || options.maxRequestBytes < 1) throw new SupplyError('BILLING_CONFIG_INVALID')
  }

  /** Read cached account balance and native ledger aggregates without force_recompute.
   * @param signal - Optional caller cancellation signal.
   * @returns Native CNY decimals and account identifier.
   */
  async queryBalance(signal?: AbortSignal): Promise<EdgeBalance> {
    const value = await this.request('/api/v8/economy/balance', undefined, signal)
    if (!record(value) || value.ok !== true || !integer(value.account_id, 1) || value.currency !== 'CNY'
      || !decimal(value.balance) || !decimal(value.total_earned) || !decimal(value.total_spent)
      || !integer(value.transaction_count, 0)) invalid()
    return { accountId: value.account_id, balance: value.balance, currency: value.currency, totalEarned: value.total_earned,
      totalSpent: value.total_spent, transactionCount: value.transaction_count }
  }

  /** Read one authenticated account's native ledger page, preserving signed monetary strings.
   * @param query - Explicit page bounds and optional native transaction type.
   * @param signal - Optional caller cancellation signal.
   * @returns The page without inferred total count or derived earnings categories.
   */
  async queryLedger(query: EdgeLedgerQuery, signal?: AbortSignal): Promise<EdgeLedgerPage> {
    if (!integer(query.limit, 1) || query.limit > 200 || !integer(query.offset, 0)
      || (query.type !== undefined && !safeType(query.type))) throw new SupplyError('BILLING_QUERY_INVALID')
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) })
    if (query.type !== undefined) params.set('type', query.type)
    const value = await this.request(`/api/v8/economy/ledger?${params}`, undefined, signal)
    if (!record(value) || value.ok !== true || !Array.isArray(value.items) || value.items.length > query.limit
      || value.limit !== query.limit || value.offset !== query.offset) invalid()
    const items = value.items.map(item => {
      if (!record(item) || !text(item.id) || !safeType(item.type) || !decimal(item.amount) || item.currency !== 'CNY'
        || !nullableText(item.workload_id) || !nullableText(item.shard_id) || !nullableText(item.created_at)) invalid()
      return { id: item.id, type: item.type, amount: item.amount, currency: item.currency as 'CNY',
        workloadId: item.workload_id, shardId: item.shard_id, createdAt: item.created_at }
    })
    return { items, limit: query.limit, offset: query.offset }
  }

  /** Request the existing spec-based estimate; balanceEnough does not reserve funds or permit execution.
   * @param input - Task spec and optional budget comparison accepted by the server.
   * @param signal - Optional caller cancellation signal.
   * @returns Server amounts and balance comparison with estimate-only authority.
   */
  async queryEstimate(input: EdgeEstimateRequest, signal?: AbortSignal): Promise<EdgeBudgetEstimate> {
    if (!record(input.spec) || !text(input.spec.task_type)
      || (input.name !== undefined && typeof input.name !== 'string')
      || (input.budget !== undefined && (!Number.isFinite(input.budget) || input.budget < 0))) throw new SupplyError('BILLING_ESTIMATE_INPUT_INVALID')
    const value = await this.request('/api/v8/economy/estimate', { spec: input.spec,
      ...(input.name !== undefined ? { name: input.name } : {}), ...(input.budget !== undefined ? { budget: input.budget } : {}) }, signal)
    if (!record(value) || value.ok !== true || value.task_type !== input.spec.task_type || !text(value.input_kind)
      || !integer(value.units, 1) || !integer(value.shards, 1) || !decimal(value.estimated_total) || !decimal(value.recommended_budget)
      || !(value.requested_budget === '' || decimal(value.requested_budget)) || !decimal(value.worker_reward_pool)
      || !decimal(value.platform_fee) || !decimal(value.risk_pool) || !decimal(value.script_author_fee)
      || value.currency !== 'CNY' || !decimal(value.balance) || typeof value.balance_enough !== 'boolean'
      || value.billing_mode !== 'server_price') invalid()
    return { taskType: value.task_type, inputKind: value.input_kind, units: value.units, shards: value.shards,
      estimatedTotal: value.estimated_total, recommendedBudget: value.recommended_budget,
      requestedBudget: value.requested_budget === '' ? null : value.requested_budget, workerRewardPool: value.worker_reward_pool,
      platformFee: value.platform_fee, riskPool: value.risk_pool, scriptAuthorFee: value.script_author_fee,
      currency: value.currency, balance: value.balance, balanceEnough: value.balance_enough, billingMode: value.billing_mode, authority: 'estimate-only' }
  }

  /** Abort active requests and reject new operations from this client. */
  close(): void { this.lifetime.abort() }

  private request(path: string, body: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
    if (this.lifetime.signal.aborted) return Promise.reject(new SupplyError('SUPPLY_CLOSED'))
    let token: string | undefined
    try { token = this.options.tokenProvider() } catch { return Promise.reject(new SupplyError('SUPPLY_AUTH_REQUIRED')) }
    if (!token || /[\r\n]/.test(token)) return Promise.reject(new SupplyError('SUPPLY_AUTH_REQUIRED'))
    let serialized: string | undefined
    if (body) {
      try { serialized = JSON.stringify(body) } catch { return Promise.reject(new SupplyError('BILLING_ESTIMATE_INPUT_INVALID')) }
      if (Buffer.byteLength(serialized) > this.options.maxRequestBytes) return Promise.reject(new SupplyError('BILLING_REQUEST_TOO_LARGE'))
    }
    return requestJson(new URL(path, this.origin), { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(serialized !== undefined ? { body: serialized } : {}) }, this.options,
    signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal)
  }
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value) }
function safeType(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(value) }
function nullableText(value: unknown): value is string | null { return value === null || text(value) }
function integer(value: unknown, minimum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) }
function invalid(): never { throw new SupplyError('BILLING_RESPONSE_INVALID') }
