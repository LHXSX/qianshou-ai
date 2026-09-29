/**
 * Host-emitted supply codes and their reader-facing explanations.
 *
 * Every table below maps a code the Host actually emits to a localized
 * explanation. A code that is not in a table is never dropped: the page shows
 * it verbatim beside {@link SupplyKey} `unknownCode`, so a Host that adds a
 * reason cannot silently lose the user's only explanation for a block.
 *
 * @module @deepseek-ai/dsh-client-ui-supply/client/reasons
 */
import type { SupplyKey } from './locales.ts'

/**
 * Admission/blocking reasons pushed by compute-core's `SupplyController.observe`.
 * Order and membership mirror that file; this map adds no code of its own.
 */
export const ADMISSION_REASON_KEYS: Readonly<Record<string, SupplyKey>> = {
  OWNER_DISABLED: 'reasonOwnerDisabled',
  HOST_ACTIVITY_UNKNOWN: 'reasonActivityUnknown',
  FOREGROUND_PRIORITY: 'reasonForegroundPriority',
  IDLE_STATE_UNKNOWN: 'reasonIdleUnknown',
  USER_ACTIVE: 'reasonUserActive',
  TASK_COUNT_UNKNOWN: 'reasonTaskCountUnknown',
  CONCURRENCY_LIMIT: 'reasonConcurrencyLimit',
  MEMORY_LIMIT: 'reasonMemoryLimit',
  NO_VERIFIED_ENABLED_SERVICE: 'reasonNoVerifiedService',
}

/** Per-service reasons emitted by the local supply probe. */
export const SERVICE_REASON_KEYS: Readonly<Record<string, SupplyKey>> = {
  LOCAL_TOOL_CHECK_FAILED: 'serviceReasonLocalToolFailed',
  MODEL_INFERENCE_NOT_VERIFIED: 'serviceReasonModelUnverified',
}

/** Hardware-probe errors emitted by the local supply probe. */
export const PROBE_ERROR_KEYS: Readonly<Record<string, SupplyKey>> = {
  GPU_PROBE_UNAVAILABLE: 'probeErrorGpu',
  IDLE_PROBE_UNAVAILABLE: 'probeErrorIdle',
  LOCAL_MODEL_SERVICE_UNAVAILABLE: 'probeErrorModelService',
}

/**
 * Look up the explanation key for one Host code.
 * @param table - The code table owned by the surface rendering the code.
 * @param code - Untrusted code string from the Host.
 * @returns The dictionary key, or null when this page does not document the code.
 */
export function codeKey(table: Readonly<Record<string, SupplyKey>>, code: string): SupplyKey | null {
  return table[code] ?? null
}
