/** Owner policy validation and private atomic persistence; no platform budget is written here. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SupplyPolicy } from './types.ts'

/** Stable public failure without subprocess output, credentials or upstream response bodies. */
export class SupplyError extends Error {
  /** Expose only a stable, module-owned code at the public error boundary.
 * @param code - Stable public error code owned by this module.
 */
  constructor(readonly code: string) { super(code); this.name = 'SupplyError' }
}

/** Parse complete persisted or user-submitted policy; never widen omitted limits.
 * @param value - Untrusted persisted or submitted policy object.
 * @returns The validated immutable owner policy.
 */
export function parseSupplyPolicy(value: unknown): SupplyPolicy {
  if (!record(value) || !['off', 'idle', 'allowed'].includes(String(value.mode))
    || !integer(value.maxConcurrency, 1) || !integer(value.minFreeMemoryBytes, 0) || !integer(value.minIdleSeconds, 0)
    || !Array.isArray(value.enabledServiceIds) || value.enabledServiceIds.length > 128
    || !value.enabledServiceIds.every(id) || new Set(value.enabledServiceIds).size !== value.enabledServiceIds.length
    || !Array.isArray(value.nodeRates) || value.nodeRates.length > 128) throw new SupplyError('SUPPLY_POLICY_INVALID')
  const enabledServiceIds = value.enabledServiceIds as string[]
  const rates = value.nodeRates.map(rate => {
    if (!record(rate) || !id(rate.localServiceId) || !enabledServiceIds.includes(rate.localServiceId)
      || !integer(rate.amountMinor, 0) || typeof rate.unit !== 'string' || !rate.unit.trim() || rate.unit.length > 64
      || typeof rate.currency !== 'string' || !/^[A-Z]{3}$/.test(rate.currency)) throw new SupplyError('SUPPLY_POLICY_INVALID')
    return Object.freeze({ localServiceId: rate.localServiceId, amountMinor: rate.amountMinor, unit: rate.unit, currency: rate.currency })
  })
  if (new Set(rates.map(rate => rate.localServiceId)).size !== rates.length) throw new SupplyError('SUPPLY_POLICY_INVALID')
  return Object.freeze({ mode: value.mode as SupplyPolicy['mode'], maxConcurrency: value.maxConcurrency,
    minFreeMemoryBytes: value.minFreeMemoryBytes, minIdleSeconds: value.minIdleSeconds,
    enabledServiceIds: Object.freeze([...value.enabledServiceIds] as string[]), nodeRates: Object.freeze(rates) })
}

/** Deployment-owned persistence port; save resolves only after the new policy is committed. */
export interface SupplyPolicyStore {
  /** Return committed owner policy, or null when first-use policy has not been saved. */
  load(): Promise<SupplyPolicy | null>
  /** Commit the complete new policy; reject if it cannot be persisted. */
  save(policy: SupplyPolicy): Promise<void>
}

/** Use one dedicated host-owned file; credentials and model settings are never read. */
export class FileSupplyPolicyStore implements SupplyPolicyStore {
  /** Select a dedicated private file whose parent directory is controlled by the Host.
 * @param filename - Absolute path to the dedicated policy file.
 */
  constructor(private readonly filename: string) {
    if (!isAbsolute(filename)) throw new SupplyError('SUPPLY_STORAGE_INVALID')
  }
  /** Read a bounded regular file without following a final symlink, then validate its complete policy.
 * @returns The saved policy, or null when no policy file exists.
 */
  async load(): Promise<SupplyPolicy | null> {
    let file
    try { file = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new SupplyError('SUPPLY_STORAGE_UNAVAILABLE')
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 65536) throw new SupplyError('SUPPLY_STORAGE_INVALID')
      const buffer = Buffer.alloc(65537)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const next = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (!next.bytesRead) break
        bytesRead += next.bytesRead
      }
      if (bytesRead > 65536) throw new SupplyError('SUPPLY_STORAGE_INVALID')
      return parseSupplyPolicy(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
    } catch { throw new SupplyError('SUPPLY_STORAGE_INVALID') }
    finally { await file.close() }
  }
  /** Atomically replace the selected file with validated private owner settings.
 * @param policy - Complete owner policy to validate and persist.
 */
  async save(policy: SupplyPolicy): Promise<void> {
    const parsed = parseSupplyPolicy(policy)
    try { await writeFileAtomic(this.filename, `${JSON.stringify(parsed)}\n`, { mode: 0o600, dirMode: 0o700 }) }
    catch { throw new SupplyError('SUPPLY_STORAGE_UNAVAILABLE') }
  }
}

/** JSON object parser shared only at external data boundaries.
 * @param value - Untrusted JSON value.
 * @returns Whether the value is a non-null, non-array object.
 */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown, minimum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum }
function id(value: unknown): value is string { return typeof value === 'string' && /^[\w.:-]{1,256}$/.test(value) }
