/**
 * Versioned, deployer-overridable task pricing for Qianshou.
 *
 * This module is pure data and integer arithmetic: no network I/O, no payment, no task
 * submission, no settlement and no persisted price policy. It answers one question —
 * "given this configuration and this billable quantity, what does a task quote look
 * like?" — so a task price can be computed without inventing a provider route.
 *
 * Four boundaries are deliberate and must not be merged:
 *   - a **user budget** is an upper-bound input (`TaskBudgetAuthorization` in ./index.ts);
 *     it never becomes a platform price;
 *   - a **platform quote** is this module's output, marked `authority: 'estimate-only'`
 *     and `billingSource`: it is not a reservation, an order, nor a submission idempotency key;
 *   - a **server price** is the upstream core's own fact. The live core already owns pricing
 *     (`services/economy/task_pricing.py`, settings in `we_kv` key `economy:settings:v1`) and
 *     forces `server_price` for ordinary accounts, ignoring a client's lower number. When a
 *     connected host has that estimate, it wins; the configuration here is the fallback used
 *     when no server estimate exists (offline, preview, a deployment that prices locally).
 *     A configuration whose numbers come from a local default must therefore declare
 *     `pricingSource: 'local_default'`, which makes `quoteTask` refuse `billingMode:
 *     'server_price'` — see `pricingSource` below;
 *   - a **node rate** (`NodeRateSetting` in compute-core supply types) is what a
 *     machine owner asks for locally; it is not a platform quote and not a reserve.
 *
 * Every amount is an integer number of CNY minor units (fen), matching ./index.ts.
 * Every price and every split ratio ships as a *default* that a deployment may override;
 * no caller is forced to accept the defaults below.
 */

import { BillingContractError } from './index.ts'
import type { BillingCurrency } from './index.ts'

/** The platform quote is an estimate produced from configuration, never a locked order. */
export type PricingAuthority = 'estimate-only'

/**
 * Where a configuration's numbers came from.
 * - `host_config`: an operator established these values for this deployment (may be aligned
 *   with the upstream core's settings).
 * - `local_default`: the shipped defaults; this deployment's price is a local convenience,
 *   must be labelled as such and must never be presented as the server's price — the upstream
 *   formula is itself parameterised, so a local default cannot reproduce it by construction.
 */
export type PricingSource = 'host_config' | 'local_default'

/** Which side of the `billingMode: 'server_price'` claim a quote carries. */
export type BillingSource = 'server_price' | 'configured_fallback'

/** The five split ports observed on the real server; a task total is divided across all of them. */
export type PricingSplitKind = 'workerRewardPool' | 'platformFee' | 'riskPool' | 'scriptAuthorFee'

/** Supported billable task families. `compute_second` is the generic GPU/CPU-time family. */
export type PricingTaskKind = 'word_count' | 'video_second' | 'compute_second'

/** Basis points: 10000 means "all of the total". Integers only, so ratios never drift. */
export const PRICING_BASIS_POINTS = 10000

/**
 * Split ratios as integer basis points. The four ratios must sum to `PRICING_BASIS_POINTS`
 * exactly; a configuration that does not is rejected instead of being silently renormalized.
 */
export type PricingSplitBps = Readonly<Record<PricingSplitKind, number>>

export interface TaskPricing {
  /** Billable unit this rate is expressed in, for auditability and for matching server fields. */
  readonly unit: 'file' | 'second'
  /** Price in CNY fen for one whole `unit`. */
  readonly rateMinor: number
  /**
   * Minimum billable quantity; a smaller request is billed as this many units. The server
   * model has an explicit `min_charge_applied` flag, so the minimum lives here as a default.
   */
  readonly minimumUnits: number
  /** Human-readable provenance for this default, kept next to the number it justifies. */
  readonly note: string
}

export interface PricingConfig {
  readonly version: 'qianshou.pricing.v1'
  readonly currency: BillingCurrency
  /**
   * Declares whether these numbers were established for this deployment or are the shipped
   * defaults. A configuration answers "what may this deployment charge?", never "what does the
   * upstream core charge?" — keep the two apart when a server estimate is available.
   */
  readonly pricingSource: PricingSource
  readonly split: PricingSplitBps
  /**
   * Which port receives the fen left over by per-port flooring. Integer flooring cannot
   * always distribute a total exactly, and the observed server records a different figure
   * than the ratio implies. Naming a recipient keeps `sum(parts) === total` an invariant
   * instead of a rounding accident.
   */
  readonly remainderRecipient: PricingSplitKind
  readonly prices: Readonly<Record<PricingTaskKind, TaskPricing>>
}

/** A deployment override: any subset of the defaults, merged field by field. */
export interface PricingConfigOverride {
  readonly version?: 'qianshou.pricing.v1'
  readonly currency?: BillingCurrency
  readonly pricingSource?: PricingSource
  readonly split?: Partial<PricingSplitBps>
  readonly remainderRecipient?: PricingSplitKind
  readonly prices?: Partial<Record<PricingTaskKind, Partial<TaskPricing>>>
}

/** Mirrors the five financial fields of the server estimate, plus provenance. */
export interface QuoteBreakdown {
  readonly workerRewardPool: number
  readonly platformFee: number
  readonly riskPool: number
  readonly scriptAuthorFee: number
}

export interface TaskQuote {
  readonly version: 'qianshou.pricing.v1'
  readonly taskKind: PricingTaskKind
  readonly unit: TaskPricing['unit']
  readonly currency: BillingCurrency
  /** Units as requested by the caller, before the minimum charge. */
  readonly requestedUnits: number
  /** Units actually charged: `max(requestedUnits, minimumUnits)`. */
  readonly chargedUnits: number
  /** Fen per unit taken from the effective configuration. */
  readonly rateMinor: number
  readonly minimumUnits: number
  readonly minimumApplied: boolean
  /** Platform quote total in fen; always equal to the sum of `breakdown`. */
  readonly estimatedTotalMinor: number
  /** Platform-suggested authorization amount in fen. Mirrors the server's `recommendedBudget`. */
  readonly recommendedBudgetMinor: number
  readonly breakdown: Readonly<QuoteBreakdown>
  /**
   * `server_price` only for a configuration whose numbers are an operator fact for this
   * deployment; a local default reports `configured_fallback`, so a UI or an agent can never
   * mistake this module's arithmetic for the upstream core's authoritative price.
   */
  readonly billingMode: BillingSource
  readonly authority: PricingAuthority
}

/** Canonical basis-point order; also the deterministic tie-break order for the remainder. */
const SPLIT_KINDS: readonly PricingSplitKind[] = ['workerRewardPool', 'platformFee', 'riskPool', 'scriptAuthorFee']
const TASK_KINDS: readonly PricingTaskKind[] = ['word_count', 'video_second', 'compute_second']
const UNITS: readonly TaskPricing['unit'][] = ['file', 'second']
const PRICING_SOURCES: readonly PricingSource[] = ['host_config', 'local_default']
const MAX_NOTE = 320
const MAX_RATE_MINOR = 10_000_000
const MAX_MINIMUM_UNITS = 86_400

/**
 * Server-measured split (2026-09-15, isolated `word_count` estimate, total 0.50 CNY):
 * workerRewardPool 0.32 / platformFee 0.15 / riskPool 0.00 / scriptAuthorFee 0.02.
 * Taking the platform fee and script-author fee as exact ratios gives 30% and 5%, the worker
 * pool takes the rest (65%), and the risk pool ships at 0% because the server stored nothing
 * for it — a deployment that wants a funded reserve must raise `riskPool` explicitly.
 */
export const DEFAULT_PRICING_SPLIT: PricingSplitBps = Object.freeze({
  workerRewardPool: 6500, platformFee: 3000, riskPool: 0, scriptAuthorFee: 500,
})

/**
 * Default prices. Each one is a starting point with a stated origin, not a platform policy:
 * a deployment overrides any of them through `createPricingConfig`.
 *
 * - `word_count` 50 fen/file — the only task family with a real server-measured sample:
 *   the isolated `POST /api/v8/economy/estimate` call returned `estimated_total: "0.50"` for
 *   `{ task_type: 'word_count', input_kind: 'inline', units: 1 }` (evidence:
 *   `qianshou-agent-021-compute-integration/validation/20260915-billing-adapter/real-billing.json`,
 *   observed 2026-09-14T22:44:52Z). That sample covers one unit only, so a uniform per-file
 *   rate is an assumption, not a measurement of the server's scaling curve.
 * - `video_second` 35 fen/second — an unverified video pricing example. Market survey
 *   of seven mainstream AI video tools (2026-09-15) measured 0.18–1.38 CNY per second of
 *   generated video; 0.35 CNY sits in the lower half of that band and above the "≈0.3 CNY/s"
 *   entry-tier coverage for domestic video models, leaving room for a cheaper CPU tier below it.
 * - `compute_second` 10 fen/GPU-second — the generic GPU-time family. GPU rental listings in
 *   China in 2026-09 ranged roughly 2–12 CNY per GPU-hour; 3.6 CNY/hour (= 0.10 CNY/second,
 *   6 fen/minute) sits inside that range. This is a derived figure from listings, not a
 *   measured transaction price.
 */
export const DEFAULT_PRICING: PricingConfig = Object.freeze({
  version: 'qianshou.pricing.v1',
  currency: 'CNY',
  pricingSource: 'local_default',
  split: DEFAULT_PRICING_SPLIT,
  remainderRecipient: 'workerRewardPool',
  prices: Object.freeze({
    word_count: Object.freeze({ unit: 'file', rateMinor: 50, minimumUnits: 1, note: 'server-measured sample: 1 inline file = 0.50 CNY (2026-09-14)' }),
    video_second: Object.freeze({ unit: 'second', rateMinor: 35, minimumUnits: 5, note: 'market band 0.18-1.38 CNY/s measured 2026-09-15; 0.35 CNY/s in the lower half' }),
    compute_second: Object.freeze({ unit: 'second', rateMinor: 10, minimumUnits: 60, note: 'derived from GPU listings 2-12 CNY/hour (2026-09); 3.6 CNY/hour = 0.10 CNY/s' }),
  }),
})

/**
 * Build the effective configuration: defaults plus a partial override, validated and frozen.
 * Omitted fields keep their default, so the smallest useful deployment is
 * `createPricingConfig({})`.
 */
export function createPricingConfig(override: PricingConfigOverride = {}): PricingConfig {
  const source = pricingObject(override, 'override')
  const version = source.version === undefined ? DEFAULT_PRICING.version : exact(source.version, 'qianshou.pricing.v1', 'version')
  const currency = source.currency === undefined ? DEFAULT_PRICING.currency : pricingCurrency(source.currency)
  const pricingSource = source.pricingSource === undefined
    ? DEFAULT_PRICING.pricingSource
    : enumValue(source.pricingSource, PRICING_SOURCES, 'pricingSource')
  const split = resolveSplit(source.split)
  const remainderRecipient = source.remainderRecipient === undefined
    ? DEFAULT_PRICING.remainderRecipient
    : enumValue(source.remainderRecipient, SPLIT_KINDS, 'remainderRecipient')
  const prices = resolvePrices(source.prices)
  return Object.freeze({
    version, currency, pricingSource, split, remainderRecipient, prices,
  })
}

/**
 * Divide a task total across the four ports with integer arithmetic only.
 * Invariant: the returned parts always sum to `totalMinor`.
 */
export function allocateSplit(
  split: PricingSplitBps,
  totalMinor: number,
  remainderRecipient: PricingSplitKind = DEFAULT_PRICING.remainderRecipient,
): QuoteBreakdown {
  pricingAmount(totalMinor, 'totalMinor')
  const shares = resolveSplit(split)
  const recipient = enumValue(remainderRecipient, SPLIT_KINDS, 'remainderRecipient')
  const parts = { workerRewardPool: 0, platformFee: 0, riskPool: 0, scriptAuthorFee: 0 }
  const remainders = { workerRewardPool: 0, platformFee: 0, riskPool: 0, scriptAuthorFee: 0 }
  let allocated = 0
  for (const kind of SPLIT_KINDS) {
    const scaled = totalMinor * shares[kind]
    const floor = Math.floor(scaled / PRICING_BASIS_POINTS)
    parts[kind] = floor
    remainders[kind] = scaled - floor * PRICING_BASIS_POINTS
    allocated += floor
  }
  // Integer flooring can leave at most (ports - 1) fen unassigned; hand each one to the
  // recipient first, then to the largest fractional share with canonical-order tie-breaks.
  let leftover = totalMinor - allocated
  while (leftover > 0) {
    let winner: PricingSplitKind | null = null
    for (const kind of SPLIT_KINDS) {
      if (kind === recipient) continue
      if (winner === null || remainders[kind] > remainders[winner]) winner = kind
    }
    const target = winner === null || remainders[recipient] >= remainders[winner] ? recipient : winner
    if (remainders[target] === 0) { parts[recipient] += leftover; break }
    parts[target] += 1
    remainders[target] -= PRICING_BASIS_POINTS
    leftover -= 1
  }
  return Object.freeze({
    workerRewardPool: parts.workerRewardPool, platformFee: parts.platformFee,
    riskPool: parts.riskPool, scriptAuthorFee: parts.scriptAuthorFee,
  })
}

/**
 * Produce the platform quote for one task. `units` is the caller's billable quantity
 * (files, seconds); anything below the configured minimum is charged as the minimum.
 */
export function quoteTask(config: PricingConfig, taskKind: PricingTaskKind, units: number): TaskQuote {
  const resolved = pricingConfig(config)
  const kind = enumValue(taskKind, TASK_KINDS, 'taskKind')
  pricingAmount(units, 'units')
  const price = resolved.prices[kind]
  const chargedUnits = Math.max(units, price.minimumUnits)
  const estimatedTotalMinor = chargedUnits * price.rateMinor
  if (!Number.isSafeInteger(estimatedTotalMinor)) fail('PRICING_AMOUNT_OVERFLOW', 'estimatedTotalMinor')
  const breakdown = allocateSplit(resolved.split, estimatedTotalMinor, resolved.remainderRecipient)
  return Object.freeze({
    version: resolved.version, taskKind: kind, unit: price.unit, currency: resolved.currency,
    requestedUnits: units, chargedUnits, rateMinor: price.rateMinor, minimumUnits: price.minimumUnits,
    minimumApplied: chargedUnits !== units, estimatedTotalMinor, recommendedBudgetMinor: estimatedTotalMinor,
    breakdown, billingMode: billingModeOf(resolved), authority: 'estimate-only',
  })
}

/**
 * A local default may never claim `server_price`: the upstream core parameterises its own
 * formula (`task_pricing.py` + `economy:settings:v1`), so shipped defaults cannot reproduce it.
 * Operators who align a deployment's numbers with the core's settings declare `host_config`.
 */
function billingModeOf(config: PricingConfig): BillingSource {
  return config.pricingSource === 'host_config' ? 'server_price' : 'configured_fallback'
}

/** Read one effective rate without quoting; useful for UI copy that must not show amounts. */
export function resolveTaskPricing(config: PricingConfig, taskKind: PricingTaskKind): TaskPricing {
  return pricingConfig(config).prices[enumValue(taskKind, TASK_KINDS, 'taskKind')]
}

/**
 * Sum the four ports of a breakdown. Exists so callers can assert the conservation invariant
 * (`sumSplitMinor(breakdown) === estimatedTotalMinor`) without an index-signature cast.
 */
export function sumSplitMinor(breakdown: QuoteBreakdown): number {
  return breakdown.workerRewardPool + breakdown.platformFee + breakdown.riskPool + breakdown.scriptAuthorFee
}

function resolveSplit(value: unknown): PricingSplitBps {
  if (value === undefined) return DEFAULT_PRICING_SPLIT
  const source = pricingObject(value, 'split')
  const split = Object.create(null) as Record<PricingSplitKind, number>
  let sum = 0
  for (const kind of SPLIT_KINDS) {
    const raw = source[kind] === undefined ? DEFAULT_PRICING_SPLIT[kind] : source[kind]
    if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > PRICING_BASIS_POINTS) fail('PRICING_INVALID_SPLIT_SHARE', `split.${kind}`)
    split[kind] = raw as number
    sum += raw as number
  }
  if (sum !== PRICING_BASIS_POINTS) fail('PRICING_SPLIT_NOT_TOTAL', `split.sum=${sum}`)
  return Object.freeze(split)
}

function resolvePrices(value: unknown): Readonly<Record<PricingTaskKind, TaskPricing>> {
  const source = value === undefined ? {} : pricingObject(value, 'prices')
  const prices = Object.create(null) as Record<PricingTaskKind, TaskPricing>
  for (const kind of TASK_KINDS) {
    const override = source[kind] === undefined ? {} : pricingObject(source[kind], `prices.${kind}`)
    const base = DEFAULT_PRICING.prices[kind]
    const unit = override.unit === undefined ? base.unit : enumValue(override.unit, UNITS, `prices.${kind}.unit`)
    const rateMinor = override.rateMinor === undefined ? base.rateMinor : pricingRate(override.rateMinor, `prices.${kind}.rateMinor`)
    const minimumUnits = override.minimumUnits === undefined ? base.minimumUnits : pricingMinimum(override.minimumUnits, `prices.${kind}.minimumUnits`)
    const note = override.note === undefined ? base.note : pricingNote(override.note, `prices.${kind}.note`)
    prices[kind] = Object.freeze({ unit, rateMinor, minimumUnits, note })
  }
  return Object.freeze(prices)
}

function pricingConfig(value: unknown): PricingConfig {
  const source = pricingObject(value, 'config')
  const split = resolveSplit(source.split)
  const version = exact(source.version, DEFAULT_PRICING.version, 'version')
  const currency = pricingCurrency(source.currency)
  const pricingSource = enumValue(source.pricingSource, PRICING_SOURCES, 'pricingSource')
  const remainderRecipient = enumValue(source.remainderRecipient, SPLIT_KINDS, 'remainderRecipient')
  const prices = source.prices === undefined
    ? DEFAULT_PRICING.prices
    : resolvePrices(source.prices)
  return Object.freeze({ version, currency, pricingSource, split, remainderRecipient, prices })
}

/** Structural guard only: it revalidates the fields a quote reads and ignores extra keys. */
function pricingObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('PRICING_INVALID_OBJECT', field)
  return value as Record<string, unknown>
}
function pricingRate(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_RATE_MINOR) fail('PRICING_INVALID_RATE', field)
  return value as number
}
function pricingMinimum(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_MINIMUM_UNITS) fail('PRICING_INVALID_MINIMUM_UNITS', field)
  return value as number
}
function pricingNote(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_NOTE || value.trim() !== value) fail('PRICING_INVALID_NOTE', field)
  return value
}
function pricingAmount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('PRICING_INVALID_AMOUNT', field)
  return value as number
}
function pricingCurrency(value: unknown): BillingCurrency {
  if (value !== 'CNY') fail('PRICING_INVALID_CURRENCY', 'currency')
  return 'CNY'
}
function exact<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) fail('PRICING_INVALID_FIELD', field)
  return expected
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail('PRICING_UNKNOWN_VALUE', field)
  return value as T
}
function fail(code: string, field?: string): never {
  throw new BillingContractError(code, field)
}
