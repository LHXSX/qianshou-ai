/**
 * Narrow values crossing the Host fetch boundary before they are published.
 *
 * `GET /api/qianshou/compute/supply` is the only source of supply facts. Every
 * field is re-validated here and re-projected into fresh frozen objects, so a
 * malformed or partial response fails the whole observation instead of being
 * rendered as a usable state. Missing facts stay `null` all the way to the
 * page: this layer never substitutes 0, false or an empty list for "unknown".
 *
 * @module @deepseek-ai/dsh-client-ui-supply/client/wire
 */
import type {
  LocalSupplyService, NodeRateSetting, SupplyActivity, SupplyGpu, SupplyPolicy, SupplyProbeResult, SupplySnapshot,
} from '@deepseek-ai/dsh-compute-core/supply'

/** The only snapshot version this page knows how to render. */
export const SUPPLY_SNAPSHOT_VERSION = 'qianshou.local-supply.v1'

/** Stable client error code for a response that does not satisfy the contract. */
export const INVALID_SUPPLY_RESPONSE = 'INVALID_SUPPLY_RESPONSE'

/**
 * Bounds mirroring the Host parsers these payloads come from. They are far
 * above what the real probe emits, so they only stop an unbounded array from
 * being rendered; they never reject a real observation.
 */
const LIMITS = {
  reasons: 64, probeErrors: 64, gpus: 64, services: 512, advertised: 512, enabled: 128, rates: 128,
} as const

function fail(): never { throw new Error(INVALID_SUPPLY_RESPONSE) }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** Non-empty text without NUL or control characters; Host codes and ids travel as text. */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)
}
function nullableText(value: unknown): value is string | null { return value === null || text(value) }
function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
function nullableInteger(value: unknown): value is number | null { return value === null || safeInteger(value, 0) }
function nullableBoolean(value: unknown): value is boolean | null { return value === null || typeof value === 'boolean' }
function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit || !value.every(text)) fail()
  return [...value] as string[]
}
/** Strict ISO-8601 millisecond timestamp, exactly as the Host `now()` writes it. */
function timestamp(value: unknown): string {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) fail()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail()
  return value
}

function parseGpu(value: unknown): SupplyGpu {
  if (!record(value) || !text(value.name) || !nullableText(value.vendor) || !nullableInteger(value.memoryBytes)) fail()
  return Object.freeze({ name: value.name, vendor: value.vendor, memoryBytes: value.memoryBytes })
}

function parseService(value: unknown): LocalSupplyService {
  if (!record(value) || !text(value.id) || value.id.length > 256 || !['tool', 'local-model'].includes(String(value.kind))
    || !text(value.name) || !nullableText(value.version) || !['verified', 'pending', 'unavailable'].includes(String(value.verification))
    || !nullableText(value.reason)) fail()
  return Object.freeze({
    id: value.id, kind: value.kind as LocalSupplyService['kind'], name: value.name,
    version: value.version, verification: value.verification as LocalSupplyService['verification'], reason: value.reason,
  })
}

function parseActivity(value: unknown): SupplyActivity {
  if (!record(value) || !nullableInteger(value.idleSeconds) || !nullableBoolean(value.foregroundTaskActive)
    || !nullableBoolean(value.voiceActive)) fail()
  return Object.freeze({
    idleSeconds: value.idleSeconds, foregroundTaskActive: value.foregroundTaskActive, voiceActive: value.voiceActive,
  })
}

function parseRate(value: unknown, enabled: readonly string[]): NodeRateSetting {
  if (!record(value) || !text(value.localServiceId) || !enabled.includes(value.localServiceId)
    || !safeInteger(value.amountMinor, 0) || !text(value.unit) || value.unit.length > 64
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) fail()
  return Object.freeze({
    localServiceId: value.localServiceId, amountMinor: value.amountMinor, unit: value.unit, currency: value.currency,
  })
}

/**
 * Parse the complete owner policy, including the rate settings this page does
 * not edit: they are echoed back on save, so they are validated exactly as the
 * Host parser validates them.
 */
export function parsePolicy(value: unknown): SupplyPolicy {
  if (!record(value) || !['off', 'idle', 'allowed'].includes(String(value.mode))
    || !safeInteger(value.maxConcurrency, 1) || !safeInteger(value.minFreeMemoryBytes, 0) || !safeInteger(value.minIdleSeconds, 0)
    || !Array.isArray(value.enabledServiceIds) || !Array.isArray(value.nodeRates)) fail()
  const enabledServiceIds = strings(value.enabledServiceIds, LIMITS.enabled)
  if (new Set(enabledServiceIds).size !== enabledServiceIds.length || value.nodeRates.length > LIMITS.rates) fail()
  const nodeRates = (value.nodeRates as unknown[]).map(rate => parseRate(rate, enabledServiceIds))
  if (new Set(nodeRates.map(rate => rate.localServiceId)).size !== nodeRates.length) fail()
  return Object.freeze({
    mode: value.mode as SupplyPolicy['mode'], maxConcurrency: value.maxConcurrency,
    minFreeMemoryBytes: value.minFreeMemoryBytes, minIdleSeconds: value.minIdleSeconds,
    enabledServiceIds: Object.freeze(enabledServiceIds), nodeRates: Object.freeze(nodeRates),
  })
}

function parseProbe(value: unknown): SupplyProbeResult {
  if (!record(value) || !record(value.hardware)) fail()
  const hardware = value.hardware
  if (!text(hardware.platform) || !text(hardware.arch) || !text(hardware.cpuModel)
    || !safeInteger(hardware.logicalCores, 1) || !safeInteger(hardware.totalMemoryBytes, 0) || !safeInteger(hardware.freeMemoryBytes, 0)
    || !Array.isArray(hardware.gpus) || hardware.gpus.length > LIMITS.gpus) fail()
  const gpus = (hardware.gpus as unknown[]).map(parseGpu)
  const probeErrors = strings(hardware.probeErrors, LIMITS.probeErrors)
  if (!Array.isArray(value.localServices) || value.localServices.length > LIMITS.services) fail()
  const localServices = (value.localServices as unknown[]).map(parseService)
  if (new Set(localServices.map(service => service.id)).size !== localServices.length) fail()
  return Object.freeze({
    hardware: Object.freeze({
      platform: hardware.platform, arch: hardware.arch, cpuModel: hardware.cpuModel, logicalCores: hardware.logicalCores,
      totalMemoryBytes: hardware.totalMemoryBytes, freeMemoryBytes: hardware.freeMemoryBytes,
      gpus: Object.freeze(gpus), probeErrors: Object.freeze(probeErrors),
    }),
    localServices: Object.freeze(localServices),
    activity: parseActivity(value.activity),
  })
}

/**
 * Consistency checks that restate `SupplyController.observe` itself: the state
 * is derived from the policy mode and the reason list, and advertisement is
 * only confirmed while eligible. A response that contradicts its own
 * definition is rejected rather than rendered as a state the Host cannot mean.
 */
function assertConsistent(snapshot: SupplySnapshot): void {
  const disabled = snapshot.eligibility.state === 'disabled'
  if (disabled !== (snapshot.ownerPolicy.mode === 'off')) fail()
  if (snapshot.eligibility.state === 'ready' && snapshot.eligibility.reasons.length > 0) fail()
  if (snapshot.eligibility.state === 'blocked' && snapshot.eligibility.reasons.length === 0) fail()
  if (snapshot.advertisingState === 'advertising' && snapshot.eligibility.state !== 'ready') fail()
}

/**
 * Parse one `SupplySnapshot` response.
 * @param value - Untrusted JSON value from the Host fetch boundary.
 * @returns The validated snapshot, projected into fresh frozen objects.
 * @throws {Error} with {@link INVALID_SUPPLY_RESPONSE} when any field is missing or contradictory.
 */
export function parseSupplySnapshot(value: unknown): SupplySnapshot {
  if (!record(value) || value.version !== SUPPLY_SNAPSHOT_VERSION || !record(value.eligibility)
    || !['disabled', 'blocked', 'ready'].includes(String(value.eligibility.state))
    || !Array.isArray(value.eligibility.reasons)
    || !['not-connected', 'withdrawn', 'advertising'].includes(String(value.advertisingState))
    || !Array.isArray(value.advertisedCapabilityIds)) fail()
  const snapshot: SupplySnapshot = {
    ...parseProbe(value),
    version: SUPPLY_SNAPSHOT_VERSION,
    observedAt: timestamp(value.observedAt),
    ownerPolicy: parsePolicy(value.ownerPolicy),
    eligibility: Object.freeze({
      state: value.eligibility.state as SupplySnapshot['eligibility']['state'],
      reasons: Object.freeze(strings(value.eligibility.reasons, LIMITS.reasons)),
    }),
    advertisingState: value.advertisingState as SupplySnapshot['advertisingState'],
    advertisedCapabilityIds: Object.freeze(strings(value.advertisedCapabilityIds, LIMITS.advertised)),
  }
  assertConsistent(snapshot)
  return Object.freeze(snapshot)
}

/**
 * Extract a structured Host error without rendering objects or raw HTML as status.
 * @param value - Parsed (or absent) response body.
 * @param status - HTTP status of the response.
 * @returns An error whose `name` is the Host code, or a transport-level code.
 */
export function hostError(value: unknown, status: number): Error {
  if (record(value) && record(value.error) && text(value.error.code) && text(value.error.message)) {
    const error = new Error(value.error.message)
    error.name = value.error.code
    return error
  }
  const error = new Error(`HTTP_${status}`)
  error.name = status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'REQUEST_FAILED'
  return error
}
