/** Deterministic local policy for optional employee-task contribution. */
import { ComputeError } from './errors.ts'

/** Contribution mode selected by the user for the current agent. */
export type ContributorMode = 'OFF' | 'BACKGROUND_ONLY' | 'OPPORTUNISTIC'

/** User-owned limits; all values are explicit so deployment policy is inspectable. */
export interface ContributorPolicy {
  mode: ContributorMode
  maxConcurrency: number
  maxCpuPercent: number
  maxGpuPercent: number
  maxTemperatureC: number
  minDiskFreeBytes: number
  allowWhileUserActive: boolean
}

/** Point-in-time facts supplied by a host resource observer.
 *
 * `userActive` / `voiceActive` are nullable on purpose: "this host cannot tell" is a real
 * answer (no idle probe on this platform, no voice producer mounted, probe failed), and
 * rounding it down to `false` is what made `allowWhileUserActive` meaningless for a whole
 * release. Only an explicit `true` blocks admission — see {@link decideContribution}.
 */
export interface ContributorSnapshot {
  userActive: boolean | null
  voiceActive: boolean | null
  cpuPercent: number
  gpuPercent: number
  temperatureC: number
  diskFreeBytes: number
  runningTasks: number
}

/** Stable reason for accepting or refusing one task invitation. */
export type ContributorDecisionReason = 'READY' | 'POLICY_DENIED' | 'USER_ACTIVE' | 'VOICE_ACTIVE' | 'CPU_LIMIT' | 'GPU_LIMIT' | 'TEMPERATURE_LIMIT' | 'DISK_LOW' | 'CONCURRENCY_LIMIT'

/** Result of local admission; refusal is expected control flow, not a node failure. */
export interface ContributorDecision {
  accepted: boolean
  reason: ContributorDecisionReason
}

/** Decide whether the employee scheduler may accept one new invitation.
 * @param policy - Explicit user contribution settings.
 * @param snapshot - Current host facts from a separate resource observer.
 * @returns A stable admission decision; this function has no side effects.
 */
export function decideContribution(policy: ContributorPolicy, snapshot: ContributorSnapshot): ContributorDecision {
  validatePolicy(policy)
  validateSnapshot(snapshot)
  if (policy.mode === 'OFF') return { accepted: false, reason: 'POLICY_DENIED' }
  // Only a measured `true` blocks. `null` means the host could not tell, and blocking on it
  // would keep every platform without an idle probe out of the pool entirely — the owner's
  // decision is that unknown lets work through, and the status reports the unknown instead.
  if (snapshot.voiceActive === true) return { accepted: false, reason: 'VOICE_ACTIVE' }
  if (snapshot.userActive === true && !policy.allowWhileUserActive) return { accepted: false, reason: 'USER_ACTIVE' }
  if (snapshot.runningTasks >= policy.maxConcurrency) return { accepted: false, reason: 'CONCURRENCY_LIMIT' }
  if (snapshot.cpuPercent > policy.maxCpuPercent) return { accepted: false, reason: 'CPU_LIMIT' }
  if (snapshot.gpuPercent > policy.maxGpuPercent) return { accepted: false, reason: 'GPU_LIMIT' }
  if (snapshot.temperatureC > policy.maxTemperatureC) return { accepted: false, reason: 'TEMPERATURE_LIMIT' }
  if (snapshot.diskFreeBytes < policy.minDiskFreeBytes) return { accepted: false, reason: 'DISK_LOW' }
  return { accepted: true, reason: 'READY' }
}

function validatePolicy(policy: unknown): asserts policy is ContributorPolicy {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new ComputeError('COMPUTE_CONTRIBUTOR_POLICY_INVALID')
  const item = policy as Record<string, unknown>
  if (!['OFF', 'BACKGROUND_ONLY', 'OPPORTUNISTIC'].includes(item.mode as string)
    || !Number.isSafeInteger(item.maxConcurrency) || (item.maxConcurrency as number) < 1 || (item.maxConcurrency as number) > 64
    || !Number.isFinite(item.maxCpuPercent) || (item.maxCpuPercent as number) < 0 || (item.maxCpuPercent as number) > 100
    || !Number.isFinite(item.maxGpuPercent) || (item.maxGpuPercent as number) < 0 || (item.maxGpuPercent as number) > 100
    || !Number.isFinite(item.maxTemperatureC) || (item.maxTemperatureC as number) < 1 || (item.maxTemperatureC as number) > 150
    || !Number.isSafeInteger(item.minDiskFreeBytes) || (item.minDiskFreeBytes as number) < 0
    || typeof item.allowWhileUserActive !== 'boolean') throw new ComputeError('COMPUTE_CONTRIBUTOR_POLICY_INVALID')
}

function validateSnapshot(snapshot: unknown): asserts snapshot is ContributorSnapshot {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new ComputeError('COMPUTE_CONTRIBUTOR_SNAPSHOT_INVALID')
  const item = snapshot as Record<string, unknown>
  if (!activity(item.userActive) || !activity(item.voiceActive)
    || !Number.isFinite(item.cpuPercent) || (item.cpuPercent as number) < 0 || (item.cpuPercent as number) > 100
    || !Number.isFinite(item.gpuPercent) || (item.gpuPercent as number) < 0 || (item.gpuPercent as number) > 100
    || !Number.isFinite(item.temperatureC) || (item.temperatureC as number) < -100 || (item.temperatureC as number) > 300
    || !Number.isSafeInteger(item.diskFreeBytes) || (item.diskFreeBytes as number) < 0
    || !Number.isSafeInteger(item.runningTasks) || (item.runningTasks as number) < 0) throw new ComputeError('COMPUTE_CONTRIBUTOR_SNAPSHOT_INVALID')
}

/** Activity facts are tri-state: measured active, measured inactive, or not measurable here. */
function activity(value: unknown): value is boolean | null {
  return typeof value === 'boolean' || value === null
}
