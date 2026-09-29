/** Persist local probe history so a later reader can see change and zero-call days. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SupplyError } from './policy.ts'
import type { ProbeWatchState } from './types.ts'

export type { ProbeWatchState }

/** File schema version. */
export const PROBE_WATCH_VERSION = 1 as const
/** Monitor sentence when the probe did not run today. */
export const ZERO_CALLS_TODAY = '该机制今日调用 0 次'
const MAX_CHANGES = 16

/** One observed add/remove of registry capability names. */
export interface ProbeWatchChange {
  readonly at: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

/** Store port. Missing file is null, never an invented zero-call day. */
export interface ProbeWatchStore {
  load(): Promise<ProbeWatchState | null>
  save(state: ProbeWatchState): Promise<void>
}

/**
 * UTC calendar day of a clock. Used so a monitor can ask "today" without local TZ drift.
 * @param now - Clock used by the caller.
 * @returns `YYYY-MM-DD`.
 */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Digest of the sorted capability list. Same names in another order match.
 * @param capabilities - Registry names from this probe.
 * @returns Hex SHA-256.
 */
export function probeWatchDigest(capabilities: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...capabilities].sort())).digest('hex')
}

/**
 * Fold one probe into the stored watch. A new UTC day resets the call count, not the last set.
 * @param previous - Last persisted row, or null on first use.
 * @param capabilities - Registry names from `declaration.provides`.
 * @param now - Clock used for the day key and change timestamp.
 * @returns The updated watch.
 */
export function recordProbeWatch(
  previous: ProbeWatchState | null,
  capabilities: readonly string[],
  now: Date,
): ProbeWatchState {
  const day = utcDay(now)
  const digest = probeWatchDigest(capabilities)
  const lastCapabilities = previous?.lastCapabilities ?? []
  const lastDigest = previous?.lastDigest ?? null
  const callsToday = previous && previous.day === day ? previous.callsToday + 1 : 1
  const added = capabilities.filter(name => !lastCapabilities.includes(name))
  const removed = lastCapabilities.filter(name => !capabilities.includes(name))
  const changed = lastDigest !== digest
  const change: ProbeWatchChange | null = changed
    ? { at: now.toISOString(), added, removed }
    : null
  const priorChanges = previous && previous.day === day ? previous.changes : previous?.changes ?? []
  return {
    version: PROBE_WATCH_VERSION,
    day,
    callsToday,
    lastDigest: digest,
    lastCapabilities: [...capabilities],
    lastChangedAt: change ? change.at : previous?.lastChangedAt ?? null,
    changes: change ? [change, ...priorChanges].slice(0, MAX_CHANGES) : [...priorChanges],
  }
}

/**
 * Report today's call count without probing. Yesterday's row is not today's count.
 * @param state - Persisted watch, or null when nothing was ever written.
 * @param now - Clock used to decide "today".
 * @returns Count, sentence, and whether a monitor should raise attention.
 */
export function probeWatchAlert(state: ProbeWatchState | null, now: Date): {
  readonly callsToday: number
  readonly note: string
  readonly attention: boolean
} {
  const callsToday = state && state.day === utcDay(now) ? state.callsToday : 0
  return {
    callsToday,
    note: callsToday === 0 ? ZERO_CALLS_TODAY : `该机制今日调用 ${callsToday} 次`,
    attention: callsToday === 0,
  }
}

/**
 * Private JSON file for the probe watch. A missing file is null.
 */
export class FileProbeWatchStore implements ProbeWatchStore {
  /**
   * @param filename - Absolute private path, usually `statePath + '.supply.watch'`.
   */
  constructor(private readonly filename: string) {
    if (!isAbsolute(filename)) throw new SupplyError('SUPPLY_STORAGE_INVALID')
  }

  /**
   * @returns The saved watch, or null when the file does not exist.
   */
  async load(): Promise<ProbeWatchState | null> {
    let file
    try { file = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new SupplyError('SUPPLY_STORAGE_UNAVAILABLE')
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 65536) throw new SupplyError('SUPPLY_STORAGE_INVALID')
      const raw = JSON.parse(await file.readFile('utf8')) as unknown
      return parseProbeWatch(raw)
    } catch (error) {
      if (error instanceof SupplyError) throw error
      throw new SupplyError('SUPPLY_STORAGE_INVALID')
    } finally { await file.close() }
  }

  /**
   * @param state - Already recorded watch.
   */
  async save(state: ProbeWatchState): Promise<void> {
    const parsed = parseProbeWatch(state)
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.filename, JSON.stringify(parsed), { mode: 0o600, dirMode: 0o700 })
  }
}

function parseProbeWatch(value: unknown): ProbeWatchState {
  if (!value || typeof value !== 'object') throw new SupplyError('SUPPLY_STORAGE_INVALID')
  const row = value as ProbeWatchState
  if (row.version !== PROBE_WATCH_VERSION || typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(row.day)) {
    throw new SupplyError('SUPPLY_STORAGE_INVALID')
  }
  if (!Number.isSafeInteger(row.callsToday) || row.callsToday < 0) throw new SupplyError('SUPPLY_STORAGE_INVALID')
  if (row.lastDigest !== null && (typeof row.lastDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(row.lastDigest))) {
    throw new SupplyError('SUPPLY_STORAGE_INVALID')
  }
  if (!Array.isArray(row.lastCapabilities) || !row.lastCapabilities.every(item => typeof item === 'string')) {
    throw new SupplyError('SUPPLY_STORAGE_INVALID')
  }
  if (row.lastChangedAt !== null && typeof row.lastChangedAt !== 'string') throw new SupplyError('SUPPLY_STORAGE_INVALID')
  if (!Array.isArray(row.changes) || row.changes.length > MAX_CHANGES) throw new SupplyError('SUPPLY_STORAGE_INVALID')
  return {
    version: PROBE_WATCH_VERSION,
    day: row.day,
    callsToday: row.callsToday,
    lastDigest: row.lastDigest,
    lastCapabilities: [...row.lastCapabilities],
    lastChangedAt: row.lastChangedAt,
    changes: row.changes.map(item => ({
      at: String(item.at),
      added: [...item.added],
      removed: [...item.removed],
    })),
  }
}
