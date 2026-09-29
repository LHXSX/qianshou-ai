/**
 * Render-ready projections of already-parsed supply facts.
 *
 * Nothing here reads the network or invents a value: each function maps one
 * observed fact (or its absence) to the dictionary key and the numbers the page
 * renders. Absence is its own key everywhere — the page can never show 0,
 * false, or "idle" for a fact the Host reported as `null`.
 *
 * @module @deepseek-ai/dsh-client-ui-supply/client/view
 */
import type { LocalSupplyService, SupplySnapshot } from '@deepseek-ai/dsh-compute-core/supply'
import type { PolicyProblem } from './form.ts'
import type { SupplyKey } from './locales.ts'

/** Admission-state copy keys, mirroring `SupplyController`'s three states plus "not observed". */
export type StateKey = 'stateDisabled' | 'stateBlocked' | 'stateReady' | 'stateUnknown'
/** Advertisement-state copy keys, mirroring the Host's three states plus "not observed". */
export type AdvertisingKey = 'advertisingNotConnected' | 'advertisingWithdrawn' | 'advertisingAdvertising' | 'advertisingUnknown'

/** Idle duration expressed in the unit its magnitude deserves. */
export interface DurationBucket {
  /** Dictionary key carrying the unit. */
  readonly key: 'idleSeconds' | 'idleMinutes' | 'idleHours'
  /** Whole-unit magnitude to substitute into that key. */
  readonly count: number
}

/**
 * Bucket an observed idle duration.
 * @param seconds - Non-negative whole seconds reported by the Host.
 * @returns The unit key and its magnitude.
 */
export function durationBucket(seconds: number): DurationBucket {
  if (seconds < 60) return { key: 'idleSeconds', count: seconds }
  if (seconds < 3600) return { key: 'idleMinutes', count: Math.floor(seconds / 60) }
  return { key: 'idleHours', count: Math.floor(seconds / 3600) }
}

/**
 * Admission state copy.
 * @param state - Observed admission state, or null before the first observation.
 * @returns The dictionary key for that state.
 */
export function stateKey(state: SupplySnapshot['eligibility']['state'] | null): StateKey {
  if (state === 'disabled') return 'stateDisabled'
  if (state === 'blocked') return 'stateBlocked'
  if (state === 'ready') return 'stateReady'
  return 'stateUnknown'
}

/**
 * The sentence explaining what the current admission state means.
 * @param state - Observed admission state, or null before the first observation.
 * @returns The dictionary key for that explanation.
 */
export function stateHintKey(state: SupplySnapshot['eligibility']['state'] | null): 'hintDisabled' | 'hintBlocked' | 'hintReady' | 'hintUnknown' {
  if (state === 'disabled') return 'hintDisabled'
  if (state === 'blocked') return 'hintBlocked'
  if (state === 'ready') return 'hintReady'
  return 'hintUnknown'
}

/**
 * Advertisement state copy.
 * @param state - Observed advertisement state, or null before the first observation.
 * @returns The dictionary key for that state.
 */
export function advertisingKey(state: SupplySnapshot['advertisingState'] | null): AdvertisingKey {
  if (state === 'not-connected') return 'advertisingNotConnected'
  if (state === 'withdrawn') return 'advertisingWithdrawn'
  if (state === 'advertising') return 'advertisingAdvertising'
  return 'advertisingUnknown'
}

/**
 * Local self-check verdict copy.
 * @param verification - Verdict reported by the probe.
 * @returns The dictionary key for that verdict.
 */
export function verificationKey(verification: LocalSupplyService['verification']): 'verified' | 'pending' | 'unavailable' {
  return verification
}

/**
 * Local capability kind copy.
 * @param kind - Kind reported by the probe.
 * @returns The dictionary key for that kind.
 */
export function serviceKindKey(kind: LocalSupplyService['kind']): 'serviceKindTool' | 'serviceKindModel' {
  return kind === 'tool' ? 'serviceKindTool' : 'serviceKindModel'
}

/**
 * Operation failure copy.
 * @param code - Stable error code carried on the thrown error.
 * @returns The dictionary key explaining that failure.
 */
export function errorKey(code: string): SupplyKey {
  if (code === 'INVALID_SUPPLY_RESPONSE') return 'errorInvalidResponse'
  if (code === 'SUPPLY_POLICY_INVALID') return 'errorPolicyInvalid'
  if (code === 'SUPPLY_STORAGE_UNAVAILABLE') return 'errorStorageUnavailable'
  if (/AUTH|UNAUTHORIZED|FORBIDDEN/u.test(code)) return 'errorAuthRequired'
  return 'errorRequestFailed'
}

/**
 * Local copy for one rejected draft field.
 * @param problem - Problem returned by {@link import('./form.ts').policyRequest}.
 * @returns The dictionary key to display, with its placeholder value when it has one.
 */
export function problemKey(problem: PolicyProblem): { readonly key: SupplyKey; readonly id?: string } {
  if (problem.kind === 'mode') return { key: 'invalidMode' }
  if (problem.kind === 'maxConcurrency') return { key: 'invalidMaxConcurrency' }
  if (problem.kind === 'minFreeMemory') return { key: 'invalidMinFreeMemory' }
  if (problem.kind === 'minIdleSeconds') return { key: 'invalidMinIdleSeconds' }
  if (problem.kind === 'serviceIdLimit') return { key: 'invalidTooManyServices' }
  return { key: 'invalidServiceId', id: problem.id }
}
