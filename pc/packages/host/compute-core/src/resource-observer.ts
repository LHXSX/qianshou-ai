/** Host resource observation seam for the optional employee scheduler. */
import { ComputeError } from './errors.ts'
import { type ContributorSnapshot } from './contributor-policy.ts'

/** A native fact may be omitted when the platform cannot observe it safely. */
/** A reader's answer: the measured value, or `undefined`/`null` for "this host cannot tell". */
type ResourceRead<T> = T | undefined | null | Promise<T | undefined | null>

/** Native facts supplied by a platform adapter; readers must not return estimates for unknown facts. */
export interface ContributorResourceSources {
  readUserActivity(): ResourceRead<boolean>
  readVoiceActivity(): ResourceRead<boolean>
  readCpuPercent(): ResourceRead<number>
  readGpuPercent(): ResourceRead<number>
  readTemperatureC(): ResourceRead<number>
  readDiskFreeBytes(): ResourceRead<number>
}

/** Resource observer that validates every native fact before exposing a policy snapshot. */
export class ContributorResourceObserver {
  /** Construct a pure adapter around platform-owned resource readers.
   * @param sources - Platform readers; they must not return estimates for unknown facts.
   */
  constructor(private readonly sources: ContributorResourceSources) {}

  /** Sample current host facts for one admission decision.
   * @param runningTasks - Number of locally active employee attempts.
   * @returns A validated snapshot suitable for `decideContribution`.
   */
  async sample(runningTasks: number): Promise<ContributorSnapshot> {
    if (!Number.isSafeInteger(runningTasks) || runningTasks < 0) throw new ComputeError('COMPUTE_RESOURCE_TASK_COUNT_INVALID')
    let raw: {
      userActive: boolean | undefined | null
      voiceActive: boolean | undefined | null
      cpuPercent: number | undefined | null
      gpuPercent: number | undefined | null
      temperatureC: number | undefined | null
      diskFreeBytes: number | undefined | null
    }
    try {
      raw = {
        userActive: await this.sources.readUserActivity(),
        voiceActive: await this.sources.readVoiceActivity(),
        cpuPercent: await this.sources.readCpuPercent(),
        gpuPercent: await this.sources.readGpuPercent(),
        temperatureC: await this.sources.readTemperatureC(),
        diskFreeBytes: await this.sources.readDiskFreeBytes(),
      }
    } catch { throw new ComputeError('COMPUTE_RESOURCE_UNAVAILABLE', 503) }
    // Activity is the one pair of facts where "cannot measure" is legitimate: a host with no
    // idle probe and no voice producer still has to tick (`decideContribution` only blocks on a
    // measured `true`). Every other fact keeps the strict rule — an unmeasured number would
    // otherwise be read as spare capacity.
    if (Object.entries(raw).some(([key, value]) => (value === undefined || value === null) && key !== 'userActive' && key !== 'voiceActive')) {
      throw new ComputeError('COMPUTE_RESOURCE_UNAVAILABLE', 503)
    }
    const complete = {
      ...raw,
      userActive: raw.userActive ?? null,
      voiceActive: raw.voiceActive ?? null,
    } as {
      userActive: boolean | null
      voiceActive: boolean | null
      cpuPercent: number
      gpuPercent: number
      temperatureC: number
      diskFreeBytes: number
    }
    const snapshot: ContributorSnapshot = { ...complete, runningTasks }
    validateSnapshot(snapshot)
    return snapshot
  }
}

function validateSnapshot(snapshot: ContributorSnapshot): void {
  // Activity is tri-state here as well: `null` means this host cannot tell (see contributor-policy).
  if (!activityFact(snapshot.userActive) || !activityFact(snapshot.voiceActive)
    || !Number.isFinite(snapshot.cpuPercent) || snapshot.cpuPercent < 0 || snapshot.cpuPercent > 100
    || !Number.isFinite(snapshot.gpuPercent) || snapshot.gpuPercent < 0 || snapshot.gpuPercent > 100
    || !Number.isFinite(snapshot.temperatureC) || snapshot.temperatureC < -100 || snapshot.temperatureC > 300
    || !Number.isSafeInteger(snapshot.diskFreeBytes) || snapshot.diskFreeBytes < 0
    || !Number.isSafeInteger(snapshot.runningTasks) || snapshot.runningTasks < 0) throw new ComputeError('COMPUTE_RESOURCE_SNAPSHOT_INVALID', 503)
}

/** Activity facts are tri-state: measured active, measured inactive, or unmeasurable here. */
function activityFact(value: unknown): value is boolean | null {
  return typeof value === 'boolean' || value === null
}
