/**
 * Owner-policy draft: the editable projection of one observed snapshot, plus
 * the exact conversion back into the complete policy the Host persists.
 *
 * Two rules shape this module:
 *
 * - The submitted policy is always complete. `POST .../supply/policy` replaces
 *   the stored policy, so anything this page does not edit (today: the local
 *   rate settings) is echoed back byte for byte instead of being dropped.
 * - Validation mirrors the Host parser exactly, no more and no less. The page
 *   must not offer a save the Host would reject, and must not refuse a value
 *   the Host accepts.
 *
 * @module @deepseek-ai/dsh-client-ui-supply/client/form
 */
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocalSupplyService, SupplyPolicy, SupplySnapshot } from '@deepseek-ai/dsh-compute-core/supply'

/** Editable policy draft; numeric inputs stay text so a user can clear and retype them. */
export interface PolicyForm {
  readonly mode: SupplyPolicy['mode']
  readonly maxConcurrency: string
  readonly minFreeMemoryMiB: string
  readonly minIdleSeconds: string
  readonly enabledServiceIds: readonly string[]
}

/** Which field made the draft unsavable; the page owns the localized copy. */
export type PolicyProblem =
  | { readonly kind: 'mode' }
  | { readonly kind: 'maxConcurrency' }
  | { readonly kind: 'minFreeMemory' }
  | { readonly kind: 'minIdleSeconds' }
  | { readonly kind: 'serviceIdLimit' }
  | { readonly kind: 'serviceId'; readonly id: string }

/** A validated policy, or the single problem that must be shown instead of saving. */
export type PolicyDraft =
  | { readonly ok: true; readonly policy: SupplyPolicy }
  | { readonly ok: false; readonly problem: PolicyProblem }

/** Bytes in one mebibyte; the only unit conversion this page performs. */
export const MIB = 1048576

/** Identifier pattern of the Host policy parser, restated so a save cannot be rejected for it. */
const SERVICE_ID = /^[\w.:-]{1,256}$/u

/** Host ceiling on the enabled-service list. */
const MAX_ENABLED_SERVICES = 128

/** One capability row: a discovered local service, an enabled-but-gone identifier, or both. */
export interface ServiceRow {
  /** Capability identifier persisted in the policy and advertised to the Host. */
  readonly id: string
  /** Discovered name, or null when the policy enables an identifier this observation did not find. */
  readonly name: string | null
  /** Discovered kind, or null when the service was not discovered now. */
  readonly kind: LocalSupplyService['kind'] | null
  /** Discovered version, or null when unknown or not discovered. */
  readonly version: string | null
  /** Self-check verdict of this observation, or null when the service was not discovered. */
  readonly verification: LocalSupplyService['verification'] | null
  /** Probe-reported reason code, or null. */
  readonly reason: string | null
  /** Whether the policy would enable this identifier. */
  readonly enabled: boolean
  /** Whether the Host policy parser accepts this identifier at all. */
  readonly acceptable: boolean
}

/**
 * Build the draft from an observed policy. The memory field is left blank on
 * purpose: blank means "keep the saved byte count exactly", so a value that is
 * not a whole number of MiB can never be rounded away by editing another field.
 * @param snapshot - The observed snapshot whose owner policy seeds the draft.
 * @returns The editable draft.
 */
export function policyForm(snapshot: SupplySnapshot): PolicyForm {
  return {
    mode: snapshot.ownerPolicy.mode,
    maxConcurrency: String(snapshot.ownerPolicy.maxConcurrency),
    minFreeMemoryMiB: '',
    minIdleSeconds: String(snapshot.ownerPolicy.minIdleSeconds),
    enabledServiceIds: [...snapshot.ownerPolicy.enabledServiceIds],
  }
}

/**
 * Resolve the memory floor the draft would save.
 * @param form - Current draft.
 * @param fallbackBytes - Saved byte count used when the field is left blank.
 * @returns The exact byte count, or null when the field is not a valid integer MiB entry.
 */
export function draftMemoryBytes(form: PolicyForm, fallbackBytes: number): number | null {
  if (form.minFreeMemoryMiB.trim() === '') return fallbackBytes
  if (!/^\d+$/u.test(form.minFreeMemoryMiB.trim())) return null
  const mib = Number(form.minFreeMemoryMiB.trim())
  const bytes = mib * MIB
  return Number.isSafeInteger(bytes) ? bytes : null
}

/**
 * Human-readable memory facts for one exact byte count.
 * @param bytes - Exact byte count taken from the policy.
 * @returns The exact count plus its compact size text.
 */
export function memoryFacts(bytes: number): { readonly bytes: number; readonly size: string } {
  return { bytes, size: fileSizeText(bytes) }
}

/**
 * Placeholder for the memory override field: whole MiB when the saved byte
 * count divides exactly, otherwise the exact byte count, so the hint can never
 * suggest a rounded value the save would not reproduce.
 * @param bytes - Currently saved minimum free memory, in bytes.
 * @returns Placeholder text for the memory input.
 */
export function memoryPlaceholder(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} B`
}

/**
 * Convert the draft into the complete policy to persist.
 * @param form - Current draft.
 * @param snapshot - Snapshot the draft was built from (source of the untouched rate settings).
 * @returns The validated policy, or the single problem to display.
 */
export function policyRequest(form: PolicyForm, snapshot: SupplySnapshot): PolicyDraft {
  if (!['off', 'idle', 'allowed'].includes(form.mode)) return { ok: false, problem: { kind: 'mode' } }
  if (!/^\d+$/u.test(form.maxConcurrency.trim())) return { ok: false, problem: { kind: 'maxConcurrency' } }
  const maxConcurrency = Number(form.maxConcurrency.trim())
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) return { ok: false, problem: { kind: 'maxConcurrency' } }
  if (!/^\d+$/u.test(form.minIdleSeconds.trim())) return { ok: false, problem: { kind: 'minIdleSeconds' } }
  const minIdleSeconds = Number(form.minIdleSeconds.trim())
  if (!Number.isSafeInteger(minIdleSeconds)) return { ok: false, problem: { kind: 'minIdleSeconds' } }
  const minFreeMemoryBytes = draftMemoryBytes(form, snapshot.ownerPolicy.minFreeMemoryBytes)
  if (minFreeMemoryBytes === null) return { ok: false, problem: { kind: 'minFreeMemory' } }
  if (form.enabledServiceIds.length > MAX_ENABLED_SERVICES) return { ok: false, problem: { kind: 'serviceIdLimit' } }
  // Every enabled identifier is submitted, so one the Host parser would reject
  // blocks the save instead of being dropped from the submitted policy.
  const rejected = form.enabledServiceIds.find(id => !SERVICE_ID.test(id))
  if (rejected !== undefined) return { ok: false, problem: { kind: 'serviceId', id: rejected } }
  if (new Set(form.enabledServiceIds).size !== form.enabledServiceIds.length) {
    // The sizes differ only when a duplicate exists, so the first entry is present.
    return { ok: false, problem: { kind: 'serviceId', id: form.enabledServiceIds[0]! } }
  }
  return {
    ok: true,
    policy: {
      mode: form.mode,
      maxConcurrency,
      minFreeMemoryBytes,
      minIdleSeconds,
      enabledServiceIds: [...form.enabledServiceIds],
      // Not edited here; passing it through unchanged is what keeps the saved
      // rate settings alive across a policy save.
      nodeRates: [...snapshot.ownerPolicy.nodeRates],
    },
  }
}

/**
 * Project the discovered services and the enabled identifiers into one row list.
 * The union matters in both directions: a service the observation missed must
 * stay visible while the policy still enables it, and a draft change must not
 * hide a capability the Host just reported.
 * @param snapshot - Latest snapshot, or null before the first observation.
 * @param form - Current draft, or null before the draft is seeded.
 * @returns Rows in discovered order, then policy-only identifiers in policy order.
 */
export function serviceRows(snapshot: SupplySnapshot | null, form: PolicyForm | null): ServiceRow[] {
  const enabled = form?.enabledServiceIds ?? snapshot?.ownerPolicy.enabledServiceIds ?? []
  const discovered = new Map((snapshot?.localServices ?? []).map(service => [service.id, service]))
  const rows: ServiceRow[] = (snapshot?.localServices ?? []).map(service => row(service, enabled))
  for (const id of enabled) {
    if (!discovered.has(id)) rows.push({ id, name: null, kind: null, version: null, verification: null, reason: null, enabled: true, acceptable: SERVICE_ID.test(id) })
  }
  return rows
}

function row(service: LocalSupplyService, enabled: readonly string[]): ServiceRow {
  return {
    id: service.id, name: service.name, kind: service.kind, version: service.version,
    verification: service.verification, reason: service.reason,
    enabled: enabled.includes(service.id), acceptable: SERVICE_ID.test(service.id),
  }
}
