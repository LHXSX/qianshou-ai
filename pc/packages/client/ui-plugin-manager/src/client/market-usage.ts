/** Account-scoped picker preferences derived only from acknowledged market dispatches. */

/** Browser preference storage; callers may pass null when persistence is unavailable. */
export interface MarketUsageStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Stable identities only; names and call eligibility come from the current catalog. */
export interface MarketUsageRanking {
  readonly frequent: readonly string[]
  readonly recent: readonly string[]
}

interface UsageEntry {
  taskType: string
  count: number
  lastUsedAt: number
}
interface DispatchIdentity { taskType: string; workloadId: string }
interface UsageRecord {
  version: 1
  ownerId: number
  entries: UsageEntry[]
  dispatches: DispatchIdentity[]
}

const TASK_TYPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u
const WORKLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MAX_ENTRIES = 64
const MAX_DISPATCHES = 256
const MAX_BYTES = 64 * 1024
const MAX_COUNT = 1_000_000
const EMPTY: MarketUsageRanking = { frequent: [], recent: [] }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function fields(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected
}
function parse(raw: string | null, ownerId: number): UsageRecord {
  const empty: UsageRecord = { version: 1, ownerId, entries: [], dispatches: [] }
  if (raw === null || raw.length > MAX_BYTES) return empty
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch (_failure) { return empty }
  const row = object(value)
  if (row === null || !fields(row, 'dispatches,entries,ownerId,version') || row.version !== 1
    || row.ownerId !== ownerId || !Array.isArray(row.entries) || row.entries.length > MAX_ENTRIES
    || !Array.isArray(row.dispatches) || row.dispatches.length > MAX_DISPATCHES) return empty
  const entries: UsageEntry[] = []
  for (const value of row.entries) {
    const item = object(value)
    if (item === null || !fields(item, 'count,lastUsedAt,taskType')
      || typeof item.taskType !== 'string' || !TASK_TYPE.test(item.taskType)
      || typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > MAX_COUNT
      || typeof item.lastUsedAt !== 'number' || !Number.isSafeInteger(item.lastUsedAt)
      || item.lastUsedAt < 0 || item.lastUsedAt > 8_640_000_000_000_000) return empty
    entries.push({ taskType: item.taskType, count: item.count, lastUsedAt: item.lastUsedAt })
  }
  const dispatches: DispatchIdentity[] = []
  for (const value of row.dispatches) {
    const item = object(value)
    if (item === null || !fields(item, 'taskType,workloadId')
      || typeof item.taskType !== 'string' || !TASK_TYPE.test(item.taskType)
      || typeof item.workloadId !== 'string' || !WORKLOAD_ID.test(item.workloadId)) return empty
    dispatches.push({ taskType: item.taskType, workloadId: item.workloadId })
  }
  if (new Set(entries.map(item => item.taskType)).size !== entries.length
    || new Set(dispatches.map(item => item.workloadId)).size !== dispatches.length) return empty
  return { version: 1, ownerId, entries, dispatches }
}

function recentFirst(left: UsageEntry, right: UsageEntry): number {
  return right.lastUsedAt - left.lastUsedAt || left.taskType.localeCompare(right.taskType)
}

/** Bounded local usage history; this never grants permission, quotes, submits or claims task success. */
export class MarketUsageController {
  private pending: Promise<void> = Promise.resolve()

  /** Create a picker-history owner.
   * @param input - Safe current account id reader, optional storage and wall clock; no account credentials.
   */
  constructor(private readonly input: {
    readOwner: () => Promise<number | null>
    storage?: MarketUsageStorage | null
    clock?: () => number
  }) {}

  /** Read preferences for the currently authenticated account without reusing an earlier account snapshot.
   * @returns Frequent (at least two dispatches) and recent task identities, or empty preferences on IO failure/logout.
   */
  async rankedTaskTypes(): Promise<MarketUsageRanking> {
    try {
      const ownerId = await this.input.readOwner()
      if (ownerId === null || this.input.storage == null) return EMPTY
      const record = parse(this.input.storage.getItem(this.key(ownerId)), ownerId)
      return {
        frequent: record.entries.filter(item => item.count >= 2)
          .sort((left, right) => right.count - left.count || recentFirst(left, right)).map(item => item.taskType),
        recent: [...record.entries].sort(recentFirst).map(item => item.taskType),
      }
    } catch (_failure) { return EMPTY } // Preference IO must not block the market picker.
  }

  /** Record the first confirmed workload reference, not a selection, quote, unknown submission or completion.
   * @param taskType - Canonical task identity bound to the acknowledged dispatch.
   * @param workloadId - Actual central workload UUID; retained 256 identities deduplicate callbacks and reloads.
   * @param expectedOwner - Account captured by the new call; a changed/logged-out account cannot receive its history.
   * @returns A contained preference write; callers never need to fail a task because account/storage IO failed.
   */
  recordDispatch(taskType: string, workloadId: string, expectedOwner?: number): Promise<void> {
    const pending = this.pending.then(async () => {
      try {
        if (!TASK_TYPE.test(taskType) || !WORKLOAD_ID.test(workloadId)) return
        const ownerId = await this.input.readOwner()
        if (ownerId === null || (expectedOwner !== undefined && ownerId !== expectedOwner)
          || this.input.storage == null) return
        const record = parse(this.input.storage.getItem(this.key(ownerId)), ownerId)
        if (record.dispatches.some(item => item.workloadId === workloadId)) return
        const at = this.input.clock?.() ?? Date.now()
        if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) return
        const old = record.entries.find(item => item.taskType === taskType)
        if (old === undefined) record.entries.push({ taskType, count: 1, lastUsedAt: at })
        else { old.count = Math.min(MAX_COUNT, old.count + 1); old.lastUsedAt = Math.max(at, old.lastUsedAt) }
        record.entries.sort(recentFirst)
        record.entries.length = Math.min(record.entries.length, MAX_ENTRIES)
        record.dispatches.push({ taskType, workloadId })
        record.dispatches = record.dispatches.slice(-MAX_DISPATCHES)
        this.input.storage.setItem(this.key(ownerId), JSON.stringify(record))
      } catch (_failure) { /* Dispatch remains valid when optional history cannot be stored. */ }
    })
    this.pending = pending
    return pending
  }

  private key(ownerId: number): string { return `qianshou:market-usage:v1:${ownerId}` }
}
