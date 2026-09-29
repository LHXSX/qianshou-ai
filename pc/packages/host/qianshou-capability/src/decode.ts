/**
 * Whitelist projections of Shanghai core answers. Each decoder names the server fields it reads;
 * a missing or mistyped field is `invalid-response`, never a default such as `0` or an empty list.
 *
 * Field provenance (Shanghai platform source):
 * - `GET /api/v8/capabilities` — `platform_v8/api/v8/capabilities.py` `list_capabilities`
 *   (`registry_version`, `capabilities[].capability/implementations/legacy_task_types`).
 * - `GET /api/v8/capabilities/{id}/workers` — QS-21.md §2 three states and
 *   `core-client.ts` `getCapabilityWorkers` (`found`, `capability`, `registry_version`,
 *   `declared.count/by_impl`, `available_now.count/by_impl/online_ttl_seconds`; 404 body `detail.found === false`).
 * - `POST /api/v8/economy/estimate` — `packages/host/compute-core/src/billing-adapter/client.ts`
 *   `queryEstimate` (`ok`, `task_type`, `estimated_total`, `recommended_budget`, `currency`,
 *   `balance_enough`, `billing_mode`); route listed in `docs/dev-plan/千手算力/上册-上海.md` (`economy.py`).
 */
import { isCapabilityId } from './contract.ts'
import type { ContractSet } from './contract.ts'
import type { CapabilityCatalogEntry, CapabilityPoolCounts } from './types.ts'

/** Decoded projection or the reason the answer is unusable. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; failure: 'invalid-response' | 'not-in-catalog' }

/** Server field names behind each projected estimate field, published with every estimate. */
export const ESTIMATE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  taskType: 'task_type',
  currency: 'currency',
  estimatedTotal: 'estimated_total',
  recommendedBudget: 'recommended_budget',
  balanceEnough: 'balance_enough',
  billingMode: 'billing_mode',
})

const DECIMAL = /^-?\d+(?:\.\d+)?$/
const TASK_TYPE = /^[A-Za-z0-9._-]{1,128}$/
const invalid = { ok: false, failure: 'invalid-response' } as const

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function counts(value: unknown): CapabilityPoolCounts | null {
  const row = record(value)
  const byImpl = record(row?.by_impl)
  if (row === null || byImpl === null || !count(row.count)) return null
  const out: Record<string, number> = {}
  for (const [impl, n] of Object.entries(byImpl)) {
    if (!text(impl, 64) || !count(n)) return null
    out[impl] = n
  }
  return { count: row.count, byImpl: out }
}

/**
 * Project Shanghai's current semantic registry response. The local copy supplies
 * titles and permits an estimate landing only while Shanghai still lists it.
 * @param payload - Untrusted JSON from `GET /api/v8/capabilities`.
 * @param contracts - Loaded registry copy used for titles and landings.
 * @returns Entries plus the server's registry version, or `invalid-response`.
 */
export function catalogOf(payload: unknown, contracts: ContractSet): Decoded<{ registryVersion: string | null; entries: CapabilityCatalogEntry[] }> {
  const body = record(payload)
  if (body === null || !text(body.registry_version, 128)
    || !Array.isArray(body.capabilities) || body.capabilities.length > 5000) return invalid
  const entries: CapabilityCatalogEntry[] = []
  const seen = new Set<string>()
  for (const value of body.capabilities as unknown[]) {
    const item = record(value)
    const id = item?.capability
    if (!isCapabilityId(id) || seen.has(id)
      || !Array.isArray(item?.implementations) || item.implementations.length > 128
      || item.implementations.some(implementation => !text(implementation, 256))
      || !Array.isArray(item.legacy_task_types) || item.legacy_task_types.length > 128
      || item.legacy_task_types.some(taskType => typeof taskType !== 'string'
        || !TASK_TYPE.test(taskType) || taskType.includes('..'))) return invalid
    seen.add(id)
    const known = contracts.capabilities.get(id)
    const landing = known?.legacyTaskTypes[0]
    entries.push({ id, title: known?.title ?? null,
      taskType: landing !== undefined && item.legacy_task_types.includes(landing) ? landing : null })
  }
  return { ok: true, value: { registryVersion: body.registry_version, entries } }
}

/**
 * Project the reverse lookup for one capability. A 404 body with `detail.found === false` is `not-in-catalog`.
 * @param status - HTTP status of the answer.
 * @param payload - Untrusted JSON from `GET /api/v8/capabilities/{id}/workers`.
 * @param capabilityId - The id that was requested; the answer must echo it.
 * @returns Declared and available-now counts as separate facts.
 */
export function poolOf(status: number, payload: unknown, capabilityId: string): Decoded<{
  registryVersion: string | null
  declared: CapabilityPoolCounts
  availableNow: CapabilityPoolCounts & { onlineTtlSeconds: number }
}> {
  const body = record(payload)
  if (status === 404) {
    return record(body?.detail)?.found === false ? { ok: false, failure: 'not-in-catalog' } : invalid
  }
  if (body === null || body.found !== true || body.capability !== capabilityId) return invalid
  const declared = counts(body.declared)
  const available = counts(body.available_now)
  const ttl = record(body.available_now)?.online_ttl_seconds
  if (declared === null || available === null || !count(ttl)) return invalid
  return { ok: true, value: {
    registryVersion: text(body.registry_version, 64) ? body.registry_version : null,
    declared, availableNow: { ...available, onlineTtlSeconds: ttl },
  } }
}

/**
 * Project the server estimate; every amount is copied verbatim as the server's decimal string.
 * @param payload - Untrusted JSON from `POST /api/v8/economy/estimate`.
 * @param taskType - The `task_type` that was posted; the answer must echo it.
 * @returns Estimate fields with `estimate-only` authority, or `invalid-response`.
 */
export function estimateOf(payload: unknown, taskType: string): Decoded<{
  currency: string
  estimatedTotal: string
  recommendedBudget: string
  balanceEnough: boolean
  billingMode: string
}> {
  const body = record(payload)
  if (body === null || body.ok !== true || body.task_type !== taskType) return invalid
  const { estimated_total, recommended_budget, currency, balance_enough, billing_mode } = body
  if (typeof estimated_total !== 'string' || !DECIMAL.test(estimated_total)
    || typeof recommended_budget !== 'string' || !DECIMAL.test(recommended_budget)
    || !text(currency, 8) || typeof balance_enough !== 'boolean' || !text(billing_mode, 32)) return invalid
  return { ok: true, value: {
    currency, estimatedTotal: estimated_total, recommendedBudget: recommended_budget,
    balanceEnough: balance_enough, billingMode: billing_mode,
  } }
}
