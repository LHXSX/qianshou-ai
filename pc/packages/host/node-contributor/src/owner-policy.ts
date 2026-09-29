/** Apply saved owner limits to the resident runner without changing existing leases. */
import { capabilityIdIfRegistered, hasIsolatedInlineRunner, type ContributorPolicy, type SupplyPolicy } from '@deepseek-ai/dsh-compute-core'
import type { ResidentCapability } from '@deepseek-ai/dsh-compute-core/resident'
import type { HostActivityReading } from './resident-assembly.ts'

/** Fresh local facts used for one admission and heartbeat cycle. */
export interface OwnerAdmissionFacts {
  readonly activity: HostActivityReading
  readonly voiceActive: boolean | null
  readonly foregroundTaskActive: boolean | null
  readonly freeMemoryBytes: number | null
  readonly runningTasks: number
}

/** One policy projection shared by transport, runtime and capability readers. */
export interface OwnerAdmission {
  readonly policy: ContributorPolicy
  readonly capabilities: readonly ResidentCapability[]
  readonly reasons: readonly string[]
}

/**
 * Intersect saved authorization with deployment limits and current local facts.
 * @param deployment - Deployment limits that owner preferences cannot expand.
 * @param owner - Complete committed owner policy, or null when unavailable.
 * @param facts - Current local activity, free memory and in-flight count.
 * @param capabilities - Runner capabilities before owner authorization is applied.
 * @param taskTypes - Exact deployed task landings; semantic aliases cannot borrow another runner's authorization.
 * @param verifiedLocalTaskTypes - Pinned local plugin landings with a recent bounded output proof.
 * @param verifiedArtifactTaskTypes - Exact installed media landings with a local proof and owner-scoped platform publication.
 * @param purchasedCapabilityIds - Exact capabilities backed by this worker's server-held entitlement and verified runtime.
 * @returns Admission policy and available capabilities from the same decision.
 */
export function projectOwnerAdmission(
  deployment: ContributorPolicy,
  owner: SupplyPolicy | null,
  facts: OwnerAdmissionFacts,
  capabilities: readonly ResidentCapability[],
  taskTypes: readonly string[],
  verifiedLocalTaskTypes: readonly string[] = [],
  verifiedArtifactTaskTypes: readonly string[] = [],
  purchasedCapabilityIds: readonly string[] = [],
): OwnerAdmission {
  const reasons: string[] = []
  const maxConcurrency = Math.min(deployment.maxConcurrency, owner?.maxConcurrency ?? deployment.maxConcurrency)
  if (deployment.mode === 'OFF') reasons.push('DEPLOYMENT_DISABLED')
  if (owner === null) reasons.push('OWNER_POLICY_UNAVAILABLE')
  else if (owner.mode === 'off') reasons.push('OWNER_DISABLED')
  else {
    if (facts.foregroundTaskActive === null) reasons.push('HOST_ACTIVITY_UNKNOWN')
    else if (facts.foregroundTaskActive) reasons.push('FOREGROUND_PRIORITY')
    if (facts.voiceActive === null) reasons.push('VOICE_ACTIVITY_UNKNOWN')
    else if (facts.voiceActive) reasons.push('VOICE_ACTIVE')
    if (owner.mode === 'idle') {
      if (facts.activity.idleSeconds === null) reasons.push('IDLE_STATE_UNKNOWN')
      else if (facts.activity.idleSeconds < owner.minIdleSeconds) reasons.push('USER_ACTIVE')
    }
    if (!deployment.allowWhileUserActive) {
      if (facts.activity.userActive === null && !reasons.includes('HOST_ACTIVITY_UNKNOWN')) reasons.push('HOST_ACTIVITY_UNKNOWN')
      else if (facts.activity.userActive && !reasons.includes('USER_ACTIVE')) reasons.push('USER_ACTIVE')
    }
    if (facts.freeMemoryBytes === null || !Number.isSafeInteger(facts.freeMemoryBytes) || facts.freeMemoryBytes < 0) {
      reasons.push('MEMORY_STATE_UNKNOWN')
    } else if (facts.freeMemoryBytes < owner.minFreeMemoryBytes) reasons.push('MEMORY_LIMIT')
    if (facts.runningTasks >= maxConcurrency) reasons.push('CONCURRENCY_LIMIT')
  }
  // An agent route never gains authorization from its task name. The only
  // additional media service needs its current task-specific local output proof.
  const textLandings = taskTypes.filter(taskType => capabilityIdIfRegistered(taskType) === 'text.transform')
  const nodeTextRunner = textLandings.length > 0 && textLandings.every(taskType =>
    hasIsolatedInlineRunner(taskType) || verifiedLocalTaskTypes.includes(taskType))
  const artifactReady = taskTypes.some(type => verifiedArtifactTaskTypes.includes(type))
  const authorized = capabilities.filter(capability => capability.available
    && owner?.enabledServiceIds.includes('node')
    && (capability.capabilityId === 'text.transform' && nodeTextRunner
      || capability.capabilityId === 'video.render' && artifactReady
      || purchasedCapabilityIds.includes(capability.capabilityId)))
  if (owner !== null && owner.mode !== 'off' && authorized.length === 0) reasons.push('NO_AUTHORIZED_SERVICE')
  const ready = reasons.length === 0
  return {
    policy: { ...deployment, maxConcurrency, mode: ready ? deployment.mode : 'OFF',
      allowWhileUserActive: ready && deployment.allowWhileUserActive },
    capabilities: capabilities.map(capability => ({ ...capability, available: ready && authorized.includes(capability) })),
    reasons,
  }
}
