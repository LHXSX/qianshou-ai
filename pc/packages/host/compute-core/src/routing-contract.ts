/**
 * First-phase contracts for the Shanghai capability pool and Qianshou Router.
 *
 * The JSON shapes live in `contracts/v1/*.schema.json`; these parsers are the
 * host-side trust boundary. They intentionally return frozen values and reject
 * impossible routing states before a planner, UI or transport can consume them.
 */
import { ComputeError } from './errors.ts'

export const ROUTING_CONTRACT_VERSION = 'v1' as const

export type ManifestHealth = 'installed' | 'available' | 'busy' | 'degraded' | 'paused' | 'quarantined' | 'expired'
export type RiskLevel = 'read-only' | 'workspace-write' | 'app-control' | 'external-side-effect'
export type DataResidency = 'local' | 'region' | 'any'
export type NetworkEgress = 'denied' | 'declared' | 'allowed'

export interface ContractSignature {
  readonly algorithm: 'ed25519'
  readonly key_id: string
  readonly value: string
}

export interface CapabilityManifestEntry {
  readonly capability_id: string
  readonly version: string
  readonly input_schema_ref: string
  readonly output_schema_ref: string
  readonly input_kinds: readonly string[]
  readonly output_kinds: readonly string[]
  readonly streaming: boolean
  readonly cancellation: boolean
}

export interface CapabilityManifest {
  readonly contract: 'qianshou/capability-manifest/v1'
  readonly manifest_id: string
  readonly plugin_id: string
  readonly plugin_version: string
  readonly revision: number
  readonly capabilities: readonly CapabilityManifestEntry[]
  readonly execution: {
    readonly location: 'local' | 'remote' | 'hybrid'
    readonly platforms: readonly string[]
    readonly architectures: readonly string[]
    readonly models: readonly string[]
    readonly min_vram_mb?: number
    readonly min_memory_mb?: number
  }
  readonly risk_level: RiskLevel
  readonly permissions: readonly string[]
  readonly privacy: {
    readonly data_residency: DataResidency
    readonly network_egress: NetworkEgress
    readonly retention: 'none' | 'task' | 'days'
  }
  readonly limits: {
    readonly max_concurrency: number
    readonly max_input_bytes: number
    readonly max_output_bytes: number
  }
  readonly health: ManifestHealth
  readonly heartbeat_seq: number
  readonly ttl_s: number
  readonly observed_at: string
  readonly digest: string
  readonly signature: ContractSignature
}

export interface CapabilityOffer {
  readonly contract: 'qianshou/offer/v1'
  readonly offer_id: string
  readonly node_id: string
  readonly owner_id: string
  readonly manifest_id: string
  readonly manifest_revision: number
  readonly capability_id: string
  readonly capability_version: string
  readonly visibility: 'private' | 'invite' | 'public'
  readonly acceptance: 'off' | 'manual' | 'auto'
  readonly status: 'available' | 'busy' | 'degraded' | 'paused' | 'expired'
  readonly price: { readonly amount_minor: number; readonly currency: string; readonly unit: string }
  readonly availability: { readonly heartbeat_seq: number; readonly expires_at: string; readonly queue_depth: number; readonly max_concurrency: number }
  readonly privacy: { readonly data_residency: DataResidency; readonly network_egress: NetworkEgress }
  readonly limits: { readonly max_input_bytes: number; readonly max_output_bytes: number; readonly max_duration_s: number }
  readonly signature: ContractSignature
}

export interface IntentSpec {
  readonly contract: 'qianshou/intent/v1'
  readonly intent_id: string
  readonly request_id: string
  readonly account_id: string
  readonly goal: string
  readonly domain: string
  readonly modalities: readonly string[]
  readonly requires: readonly { readonly capability_id: string; readonly min_version: string; readonly optional: boolean }[]
  readonly inputs: readonly { readonly kind: 'inline' | 'artifact' | 'session'; readonly ref: string; readonly sha256?: string; readonly media_type: string }[]
  readonly output: { readonly kind: string; readonly format: string }
  readonly budget: { readonly amount_minor: number; readonly currency: string }
  readonly deadline_s: number
  readonly privacy: { readonly level: 'strict' | 'standard' | 'open'; readonly allow_remote: boolean; readonly data_residency: DataResidency }
  readonly preferences: { readonly prefer_local: boolean; readonly node_ids: readonly string[]; readonly platforms: readonly string[]; readonly max_price_minor?: number }
  readonly fallback: { readonly allow_replan: boolean; readonly allow_degraded: boolean; readonly max_attempts: number }
  readonly confirmation: 'required' | 'preapproved'
}

export interface RouteCandidate {
  readonly offer_id: string
  readonly node_id: string
  readonly score: number
  readonly eligible: boolean
  readonly reason_codes: readonly string[]
}

export interface RoutePlan {
  readonly contract: 'qianshou/route-plan/v1'
  readonly route_id: string
  readonly intent_id: string
  readonly revision: number
  readonly status: 'draft' | 'quoted' | 'accepted' | 'expired' | 'rejected'
  readonly steps: readonly {
    readonly step_id: string
    readonly capability_id: string
    readonly capability_version: string
    readonly input_refs: readonly string[]
    readonly output_kind: string
    readonly candidates: readonly RouteCandidate[]
    readonly selected: { readonly offer_id: string; readonly node_id: string; readonly manifest_revision: number }
    readonly privacy: { readonly data_residency: DataResidency; readonly network_egress: NetworkEgress }
    readonly fallback_offer_ids: readonly string[]
  }[]
  readonly quote: { readonly amount_minor: number; readonly currency: string; readonly unit: string; readonly expires_at: string }
  readonly explanation: readonly string[]
}

/** Parse a signed capability snapshot received from a plugin or node. */
export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  const item = object(value, 'manifest')
  contract(item, 'qianshou/capability-manifest/v1')
  const capabilities = array(item.capabilities, 'manifest.capabilities', parseManifestEntry)
  if (capabilities.length === 0 || capabilities.length > 64) invalid('manifest.capabilities')
  const keys = new Set(capabilities.map(entry => `${entry.capability_id}\u0000${entry.version}`))
  if (keys.size !== capabilities.length) invalid('manifest.capabilities.duplicate')
  const execution = object(item.execution, 'manifest.execution')
  const privacy = object(item.privacy, 'manifest.privacy')
  const limits = object(item.limits, 'manifest.limits')
  const result: CapabilityManifest = {
    contract: 'qianshou/capability-manifest/v1', manifest_id: text(item.manifest_id, 'manifest.manifest_id'), plugin_id: text(item.plugin_id, 'manifest.plugin_id'), plugin_version: version(item.plugin_version, 'manifest.plugin_version'), revision: positiveInt(item.revision, 'manifest.revision'), capabilities,
    execution: {
      location: oneOf(execution.location, 'manifest.execution.location', ['local', 'remote', 'hybrid'] as const), platforms: strings(execution.platforms, 'manifest.execution.platforms'), architectures: strings(execution.architectures, 'manifest.execution.architectures'), models: strings(execution.models, 'manifest.execution.models'),
      ...(execution.min_vram_mb === undefined ? {} : { min_vram_mb: nonNegativeInt(execution.min_vram_mb, 'manifest.execution.min_vram_mb') }), ...(execution.min_memory_mb === undefined ? {} : { min_memory_mb: nonNegativeInt(execution.min_memory_mb, 'manifest.execution.min_memory_mb') }),
    },
    risk_level: oneOf(item.risk_level, 'manifest.risk_level', ['read-only', 'workspace-write', 'app-control', 'external-side-effect'] as const), permissions: strings(item.permissions, 'manifest.permissions'),
    privacy: { data_residency: oneOf(privacy.data_residency, 'manifest.privacy.data_residency', ['local', 'region', 'any'] as const), network_egress: oneOf(privacy.network_egress, 'manifest.privacy.network_egress', ['denied', 'declared', 'allowed'] as const), retention: oneOf(privacy.retention, 'manifest.privacy.retention', ['none', 'task', 'days'] as const) },
    limits: { max_concurrency: positiveInt(limits.max_concurrency, 'manifest.limits.max_concurrency'), max_input_bytes: positiveInt(limits.max_input_bytes, 'manifest.limits.max_input_bytes'), max_output_bytes: positiveInt(limits.max_output_bytes, 'manifest.limits.max_output_bytes') },
    health: oneOf(item.health, 'manifest.health', ['installed', 'available', 'busy', 'degraded', 'paused', 'quarantined', 'expired'] as const), heartbeat_seq: nonNegativeInt(item.heartbeat_seq, 'manifest.heartbeat_seq'), ttl_s: positiveInt(item.ttl_s, 'manifest.ttl_s'), observed_at: text(item.observed_at, 'manifest.observed_at'), digest: digest(item.digest, 'manifest.digest'), signature: signature(item.signature, 'manifest.signature'),
  }
  return freeze(result)
}

/** Parse an owner-controlled offer; this object is not an execution lease. */
export function parseCapabilityOffer(value: unknown): CapabilityOffer {
  const item = object(value, 'offer')
  contract(item, 'qianshou/offer/v1')
  const price = object(item.price, 'offer.price'); const availability = object(item.availability, 'offer.availability'); const privacy = object(item.privacy, 'offer.privacy'); const limits = object(item.limits, 'offer.limits')
  return freeze({ contract: 'qianshou/offer/v1', offer_id: text(item.offer_id, 'offer.offer_id'), node_id: text(item.node_id, 'offer.node_id'), owner_id: text(item.owner_id, 'offer.owner_id'), manifest_id: text(item.manifest_id, 'offer.manifest_id'), manifest_revision: positiveInt(item.manifest_revision, 'offer.manifest_revision'), capability_id: text(item.capability_id, 'offer.capability_id'), capability_version: version(item.capability_version, 'offer.capability_version'), visibility: oneOf(item.visibility, 'offer.visibility', ['private', 'invite', 'public'] as const), acceptance: oneOf(item.acceptance, 'offer.acceptance', ['off', 'manual', 'auto'] as const), status: oneOf(item.status, 'offer.status', ['available', 'busy', 'degraded', 'paused', 'expired'] as const), price: { amount_minor: nonNegativeInt(price.amount_minor, 'offer.price.amount_minor'), currency: text(price.currency, 'offer.price.currency'), unit: text(price.unit, 'offer.price.unit') }, availability: { heartbeat_seq: nonNegativeInt(availability.heartbeat_seq, 'offer.availability.heartbeat_seq'), expires_at: text(availability.expires_at, 'offer.availability.expires_at'), queue_depth: nonNegativeInt(availability.queue_depth, 'offer.availability.queue_depth'), max_concurrency: positiveInt(availability.max_concurrency, 'offer.availability.max_concurrency') }, privacy: { data_residency: oneOf(privacy.data_residency, 'offer.privacy.data_residency', ['local', 'region', 'any'] as const), network_egress: oneOf(privacy.network_egress, 'offer.privacy.network_egress', ['denied', 'declared', 'allowed'] as const) }, limits: { max_input_bytes: positiveInt(limits.max_input_bytes, 'offer.limits.max_input_bytes'), max_output_bytes: positiveInt(limits.max_output_bytes, 'offer.limits.max_output_bytes'), max_duration_s: positiveInt(limits.max_duration_s, 'offer.limits.max_duration_s') }, signature: signature(item.signature, 'offer.signature') })
}

/** Parse normalized user intent. It has no selected node and cannot authorize spending by itself. */
export function parseIntentSpec(value: unknown): IntentSpec {
  const item = object(value, 'intent'); contract(item, 'qianshou/intent/v1')
  const requires = array(item.requires, 'intent.requires', value => { const row = object(value, 'intent.requires[]'); return { capability_id: text(row.capability_id, 'intent.requires[].capability_id'), min_version: version(row.min_version, 'intent.requires[].min_version'), optional: bool(row.optional, 'intent.requires[].optional') } })
  const inputs = array(item.inputs, 'intent.inputs', value => { const row = object(value, 'intent.inputs[]'); return { kind: oneOf(row.kind, 'intent.inputs[].kind', ['inline', 'artifact', 'session'] as const), ref: text(row.ref, 'intent.inputs[].ref'), ...(row.sha256 === undefined ? {} : { sha256: digest(row.sha256, 'intent.inputs[].sha256') }), media_type: text(row.media_type, 'intent.inputs[].media_type') } })
  const output = object(item.output, 'intent.output'); const budget = object(item.budget, 'intent.budget'); const privacy = object(item.privacy, 'intent.privacy'); const preferences = object(item.preferences, 'intent.preferences'); const fallback = object(item.fallback, 'intent.fallback')
  return freeze({ contract: 'qianshou/intent/v1', intent_id: text(item.intent_id, 'intent.intent_id'), request_id: text(item.request_id, 'intent.request_id'), account_id: text(item.account_id, 'intent.account_id'), goal: nonEmpty(item.goal, 'intent.goal'), domain: text(item.domain, 'intent.domain'), modalities: strings(item.modalities, 'intent.modalities'), requires, inputs, output: { kind: text(output.kind, 'intent.output.kind'), format: text(output.format, 'intent.output.format') }, budget: { amount_minor: nonNegativeInt(budget.amount_minor, 'intent.budget.amount_minor'), currency: text(budget.currency, 'intent.budget.currency') }, deadline_s: positiveInt(item.deadline_s, 'intent.deadline_s'), privacy: { level: oneOf(privacy.level, 'intent.privacy.level', ['strict', 'standard', 'open'] as const), allow_remote: bool(privacy.allow_remote, 'intent.privacy.allow_remote'), data_residency: oneOf(privacy.data_residency, 'intent.privacy.data_residency', ['local', 'region', 'any'] as const) }, preferences: { prefer_local: bool(preferences.prefer_local, 'intent.preferences.prefer_local'), node_ids: strings(preferences.node_ids, 'intent.preferences.node_ids'), platforms: strings(preferences.platforms, 'intent.preferences.platforms'), ...(preferences.max_price_minor === undefined ? {} : { max_price_minor: nonNegativeInt(preferences.max_price_minor, 'intent.preferences.max_price_minor') }) }, fallback: { allow_replan: bool(fallback.allow_replan, 'intent.fallback.allow_replan'), allow_degraded: bool(fallback.allow_degraded, 'intent.fallback.allow_degraded'), max_attempts: positiveInt(fallback.max_attempts, 'intent.fallback.max_attempts') }, confirmation: oneOf(item.confirmation, 'intent.confirmation', ['required', 'preapproved'] as const) })
}

/** Parse a route decision and enforce that the selected offer was eligible. */
export function parseRoutePlan(value: unknown): RoutePlan {
  const item = object(value, 'route'); contract(item, 'qianshou/route-plan/v1')
  const steps = array(item.steps, 'route.steps', value => {
    const row = object(value, 'route.steps[]'); const candidates = array(row.candidates, 'route.steps[].candidates', value => { const candidate = object(value, 'route.steps[].candidates[]'); const score = number(candidate.score, 'route.steps[].candidates[].score'); if (score < 0 || score > 1) invalid('route.steps[].candidates[].score'); return { offer_id: text(candidate.offer_id, 'route.steps[].candidates[].offer_id'), node_id: text(candidate.node_id, 'route.steps[].candidates[].node_id'), score, eligible: bool(candidate.eligible, 'route.steps[].candidates[].eligible'), reason_codes: strings(candidate.reason_codes, 'route.steps[].candidates[].reason_codes') } })
    if (candidates.length === 0) invalid('route.steps[].candidates')
    const selectedValue = object(row.selected, 'route.steps[].selected'); const selected = { offer_id: text(selectedValue.offer_id, 'route.steps[].selected.offer_id'), node_id: text(selectedValue.node_id, 'route.steps[].selected.node_id'), manifest_revision: positiveInt(selectedValue.manifest_revision, 'route.steps[].selected.manifest_revision') }
    const match = candidates.find(candidate => candidate.offer_id === selected.offer_id && candidate.node_id === selected.node_id)
    if (!match || !match.eligible) invalid('route.steps[].selected')
    const privacy = object(row.privacy, 'route.steps[].privacy')
    return { step_id: text(row.step_id, 'route.steps[].step_id'), capability_id: text(row.capability_id, 'route.steps[].capability_id'), capability_version: version(row.capability_version, 'route.steps[].capability_version'), input_refs: strings(row.input_refs, 'route.steps[].input_refs'), output_kind: text(row.output_kind, 'route.steps[].output_kind'), candidates, selected, privacy: { data_residency: oneOf(privacy.data_residency, 'route.steps[].privacy.data_residency', ['local', 'region', 'any'] as const), network_egress: oneOf(privacy.network_egress, 'route.steps[].privacy.network_egress', ['denied', 'declared', 'allowed'] as const) }, fallback_offer_ids: strings(row.fallback_offer_ids, 'route.steps[].fallback_offer_ids') }
  })
  if (steps.length === 0) invalid('route.steps')
  const quote = object(item.quote, 'route.quote')
  return freeze({ contract: 'qianshou/route-plan/v1', route_id: text(item.route_id, 'route.route_id'), intent_id: text(item.intent_id, 'route.intent_id'), revision: positiveInt(item.revision, 'route.revision'), status: oneOf(item.status, 'route.status', ['draft', 'quoted', 'accepted', 'expired', 'rejected'] as const), steps, quote: { amount_minor: nonNegativeInt(quote.amount_minor, 'route.quote.amount_minor'), currency: text(quote.currency, 'route.quote.currency'), unit: text(quote.unit, 'route.quote.unit'), expires_at: text(quote.expires_at, 'route.quote.expires_at') }, explanation: strings(item.explanation, 'route.explanation') })
}

function parseManifestEntry(value: unknown): CapabilityManifestEntry {
  const item = object(value, 'manifest.capabilities[]')
  return { capability_id: text(item.capability_id, 'manifest.capabilities[].capability_id'), version: version(item.version, 'manifest.capabilities[].version'), input_schema_ref: text(item.input_schema_ref, 'manifest.capabilities[].input_schema_ref'), output_schema_ref: text(item.output_schema_ref, 'manifest.capabilities[].output_schema_ref'), input_kinds: strings(item.input_kinds, 'manifest.capabilities[].input_kinds'), output_kinds: strings(item.output_kinds, 'manifest.capabilities[].output_kinds'), streaming: bool(item.streaming, 'manifest.capabilities[].streaming'), cancellation: bool(item.cancellation, 'manifest.capabilities[].cancellation') }
}

function signature(value: unknown, field: string): ContractSignature { const item = object(value, field); if (item.algorithm !== 'ed25519') invalid(`${field}.algorithm`); return { algorithm: 'ed25519', key_id: nonEmpty(item.key_id, `${field}.key_id`), value: nonEmpty(item.value, `${field}.value`) } }
function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field); return value as Record<string, unknown> }
function contract(item: Record<string, unknown>, expected: string): void { if (item.contract !== expected) invalid('contract') }
function text(value: unknown, field: string): string { if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) invalid(field); return value }
function nonEmpty(value: unknown, field: string): string { return text(value, field).trim() || invalid(field) }
function version(value: unknown, field: string): string { const result = text(value, field); if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(result)) invalid(field); return result }
function digest(value: unknown, field: string): string { const result = text(value, field); if (!/^[a-f0-9]{64}$/u.test(result)) invalid(field); return result }
function bool(value: unknown, field: string): boolean { if (typeof value !== 'boolean') invalid(field); return value }
function number(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field); return value }
function nonNegativeInt(value: unknown, field: string): number { const result = number(value, field); if (!Number.isSafeInteger(result) || result < 0) invalid(field); return result }
function positiveInt(value: unknown, field: string): number { const result = nonNegativeInt(value, field); if (result < 1) invalid(field); return result }
function strings(value: unknown, field: string): readonly string[] { if (!Array.isArray(value) || value.length > 256) invalid(field); return Object.freeze(value.map((entry, index) => text(entry, `${field}[${index}]`))) }
function array<T>(value: unknown, field: string, mapper: (entry: unknown) => T): readonly T[] { if (!Array.isArray(value) || value.length > 256) invalid(field); return Object.freeze(value.map(mapper)) }
function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(field); return value as T }
function invalid(field: string): never { throw new ComputeError('COMPUTE_ROUTING_CONTRACT_INVALID', 400, field) }
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child) } return value }
