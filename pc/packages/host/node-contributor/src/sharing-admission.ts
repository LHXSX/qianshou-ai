/** Independent media permission uses existing owner resource limits without changing legacy service grants. */
import type { ContributorPolicy, SupplyPolicy } from '@deepseek-ai/dsh-compute-core'
import type { OwnerAdmissionFacts } from './owner-policy.ts'

/** A connection may remain present while idle-only execution is unavailable. */
export type SharingExecutionState = 'idle' | 'busy' | 'unknown' | 'disabled'
/** Project only measured activity and existing resource constraints; legacy mode/service IDs confer no media consent.
 * @param deployment - Operator limits; OFF always vetoes execution.
 * @param owner - Existing committed resource preferences, without altering their mode or grants.
 * @param facts - Fresh private Host observations.
 * @param busy - Existing local GPU/review/adapter occupancy.
 * @returns Idle permission, a measured veto, or unknown rather than fabricated inactivity.
 */
export function sharingExecutionAdmission(deployment: ContributorPolicy, owner: SupplyPolicy | null,
  facts: OwnerAdmissionFacts, busy: boolean): SharingExecutionState {
  if (deployment.mode === 'OFF') return 'disabled'
  if (owner === null || facts.activity.userActive === null || facts.activity.idleSeconds === null
    || facts.voiceActive === null || facts.foregroundTaskActive === null || facts.freeMemoryBytes === null
    || !Number.isSafeInteger(facts.freeMemoryBytes) || facts.freeMemoryBytes < 0
    || !Number.isFinite(facts.activity.idleSeconds) || facts.activity.idleSeconds < 0
    || !Number.isSafeInteger(facts.runningTasks) || facts.runningTasks < 0) return 'unknown'
  if (busy || facts.activity.userActive || facts.activity.idleSeconds < owner.minIdleSeconds
    || facts.voiceActive || facts.foregroundTaskActive || facts.freeMemoryBytes < owner.minFreeMemoryBytes
    || facts.runningTasks >= Math.min(deployment.maxConcurrency, owner.maxConcurrency)) return 'busy'
  return 'idle'
}
