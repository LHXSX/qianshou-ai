/**
 * Read-only capability facts for the conversation card: catalog membership, scheduler health and
 * server estimate. No method here submits work, reserves funds or produces a quote id.
 */
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ACCOUNT_ACCESS_REF } from '@deepseek-ai/dsh-host-qianshou-account'
import { intentViolations, isCapabilityId, loadContracts } from './contract.ts'
import type { ContractSet } from './contract.ts'
import { catalogOf, ESTIMATE_FIELDS, estimateOf, poolOf } from './decode.ts'
import { CapabilityProtocol, failureForStatus } from './protocol.ts'
import type { CapabilityProtocolConfig, Outcome } from './protocol.ts'
import type { AvailabilityView, CapabilityFailureCode, CatalogView, EstimateIntent, EstimateView } from './types.ts'
export type * from './types.ts'

/** Endpoint paths on the Shanghai core; provenance in `decode.ts`. */
const CATALOG_PATH = '/api/v8/capabilities'
const ESTIMATE_PATH = '/api/v8/economy/estimate'
const workersPath = (capabilityId: string): string => `${CATALOG_PATH}/${encodeURIComponent(capabilityId)}/workers`

/** Deployment-selected origin, contract copy location and transport limits. */
export interface Config extends CapabilityProtocolConfig {
  /** Directory holding the fixed `contracts/v1` copy; empty selects the repository copy next to this package. */
  contractsDir: string
  /** Concurrent Host requests before `busy`. */
  maxPending: number
}

declare module '@deepseek-ai/cordis' { interface Context { qianshouCapability: QianshouCapability } }

/** The account credential reference shared with `qianshou-account`; only the Host reads its value. */
const ACCESS_REF = credentialRef(ACCOUNT_ACCESS_REF)

/** Host-side capability reads; every failure is a named state, never an empty catalog. */
export class QianshouCapability extends TypertRemoteService {
  static inject = ['credentials']
  static Config: Schema<Config> = Schema.object({
    // Public nginx origin for qianshousuanli.com / 203.0.113.10 (reference repository docs/dev-plan/千手算力/上册-上海.md,
    // nginx row) and the same origin `qianshou-account` uses for `accountOrigin`.
    coreOrigin: Schema.string().default('https://qianshousuanli.com'),
    contractsDir: Schema.string().default(''),
    timeoutMs: Schema.number().min(1000).max(60000).default(10000),
    maxRetries: Schema.number().min(0).max(3).default(1),
    retryDelayMs: Schema.number().min(0).max(10000).default(500),
    maxResponseBytes: Schema.number().min(1024).max(4 * 1024 * 1024).default(512 * 1024),
    maxPending: Schema.number().min(1).max(16).default(3),
  })

  private readonly protocol: CapabilityProtocol
  private readonly lifetime = new AbortController()
  private contracts: ContractSet | null = null
  private pending = 0

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'qianshouCapability')
    this.protocol = new CapabilityProtocol(config)
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => { this.lifetime.abort() }, 'qianshou-capability: network lifetime')
    const dir = this.config.contractsDir === ''
      ? fileURLToPath(new URL('../../../../contracts/v1/', import.meta.url))
      : this.config.contractsDir
    this.contracts = await loadContracts(dir)
  }

  /**
   * Layer 1 for the whole catalog: what the Shanghai registry lists. Listed is not runnable.
   * @returns `signed-out` without any request, `catalog-only` entries, or a named failure.
   */
  @Remote
  async catalog(): Promise<CatalogView> {
    const source = this.protocol.origin + CATALOG_PATH
    if (this.lifetime.signal.aborted) return { state: 'unavailable', source, failure: 'closed', httpStatus: null }
    const bearer = await this.bearer()
    if (bearer === null) return { state: 'signed-out', source }
    const outcome = await this.send(CATALOG_PATH, 'GET', bearer, undefined)
    if (outcome.kind === 'failed') return { state: 'unavailable', source, failure: outcome.failure, httpStatus: null }
    if (outcome.status < 200 || outcome.status >= 300) return { state: 'unavailable', source, failure: failureForStatus(outcome.status), httpStatus: outcome.status }
    const decoded = catalogOf(outcome.payload, this.loaded())
    if (!decoded.ok) return { state: 'unavailable', source, failure: decoded.failure, httpStatus: outcome.status }
    return { state: 'catalog-only', source, ...decoded.value, checkedAt: Date.now() }
  }

  /**
   * Layer 1 for one capability: catalog membership plus declared and available-now counts.
   * @param capabilityId - Registry capability id; validated against the name grammar before any request.
   * @returns `signed-out`, `catalog-only` with counts, or `unavailable` including `not-in-catalog`.
   */
  @Remote
  async availability(capabilityId: string): Promise<AvailabilityView> {
    if (!isCapabilityId(capabilityId)) {
      return { state: 'unavailable', capabilityId: String(capabilityId).slice(0, 128), source: this.protocol.origin, failure: 'invalid-input', httpStatus: null }
    }
    const path = workersPath(capabilityId)
    const source = this.protocol.origin + path
    if (this.lifetime.signal.aborted) return { state: 'unavailable', capabilityId, source, failure: 'closed', httpStatus: null }
    const bearer = await this.bearer()
    if (bearer === null) return { state: 'signed-out', capabilityId, source }
    const outcome = await this.send(path, 'GET', bearer, undefined)
    if (outcome.kind === 'failed') return { state: 'unavailable', capabilityId, source, failure: outcome.failure, httpStatus: null }
    if (outcome.status !== 404 && (outcome.status < 200 || outcome.status >= 300)) {
      return { state: 'unavailable', capabilityId, source, failure: failureForStatus(outcome.status), httpStatus: outcome.status }
    }
    const decoded = poolOf(outcome.status, outcome.payload, capabilityId)
    if (!decoded.ok) return { state: 'unavailable', capabilityId, source, failure: decoded.failure, httpStatus: outcome.status }
    return { state: 'catalog-only', capabilityId, source, ...decoded.value, checkedAt: Date.now() }
  }

  /**
   * Layer 2: the server's estimate for one capability. The result is `estimate-only`; it carries no
   * quote id, locks no price and reserves no funds. The local budget cap is echoed, never posted.
   * @param capabilityId - Registry capability id with at least one `legacy_task_types` landing.
   * @param intent - `goal` and nullable `budget` validated against the `qianshou/intent/v1` copy.
   * @returns `signed-out`, `estimate-only` with server decimals and field provenance, or a named failure.
   */
  @Remote
  async estimate(capabilityId: string, intent: EstimateIntent): Promise<EstimateView> {
    const origin = this.protocol.origin
    if (!isCapabilityId(capabilityId)) {
      return { state: 'unavailable', capabilityId: String(capabilityId).slice(0, 128), source: origin, failure: 'invalid-input', httpStatus: null }
    }
    const source = origin + ESTIMATE_PATH
    if (this.lifetime.signal.aborted) return { state: 'unavailable', capabilityId, source, failure: 'closed', httpStatus: null }
    const contracts = this.loaded()
    const taskType = contracts.capabilities.get(capabilityId)?.legacyTaskTypes[0]
    if (taskType === undefined) return { state: 'unavailable', capabilityId, source, failure: 'not-in-catalog', httpStatus: null }
    if (intentViolations(contracts, intent).length > 0) return { state: 'unavailable', capabilityId, source, failure: 'invalid-input', httpStatus: null }
    const bearer = await this.bearer()
    if (bearer === null) return { state: 'signed-out', capabilityId, source }
    const outcome = await this.send(ESTIMATE_PATH, 'POST', bearer, { spec: { task_type: taskType } })
    if (outcome.kind === 'failed') return { state: 'unavailable', capabilityId, source, failure: outcome.failure, httpStatus: null }
    if (outcome.status < 200 || outcome.status >= 300) return { state: 'unavailable', capabilityId, source, failure: failureForStatus(outcome.status), httpStatus: outcome.status }
    const decoded = estimateOf(outcome.payload, taskType)
    if (!decoded.ok) return { state: 'unavailable', capabilityId, source, failure: decoded.failure, httpStatus: outcome.status }
    return { state: 'estimate-only', capabilityId, taskType, source, ...decoded.value, fields: { ...ESTIMATE_FIELDS }, intent, checkedAt: Date.now() }
  }

  private loaded(): ContractSet {
    if (this.contracts === null) throw new Error('qianshou-capability: contracts not loaded')
    return this.contracts
  }

  /**
   * Read the account token for this request only; a missing or empty value means signed out.
   * Callers check the plugin lifetime first, because the `credentials` service is gone once the
   * plugin is disposed.
   */
  private async bearer(): Promise<string | null> {
    const resolved = await this.ctx.credentials.resolve(ACCESS_REF)
    const value = resolved?.value ?? ''
    return value.length > 0 && !/[\r\n]/.test(value) ? value : null
  }

  private async send(path: string, method: 'GET' | 'POST', bearer: string, body: unknown): Promise<Outcome | { kind: 'failed'; failure: Extract<CapabilityFailureCode, 'busy' | 'closed'> }> {
    if (this.lifetime.signal.aborted) return { kind: 'failed', failure: 'closed' }
    if (this.pending >= this.config.maxPending) return { kind: 'failed', failure: 'busy' }
    this.pending++
    try { return await this.protocol.request(path, method, bearer, body, this.lifetime.signal) } finally { this.pending-- }
  }
}
export default QianshouCapability
