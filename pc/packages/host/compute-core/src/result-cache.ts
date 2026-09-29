/** End-local result cache. Deterministic processing may hit; random output never becomes a template. */
import { createHash } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DETERMINISM_BY_CAPABILITY, IMPLEMENTATIONS_BY_CAPABILITY } from './capability-registry.ts'
import { parseChainRequest, type ComputeChainStep } from './chain-store.ts'
import { ComputeError } from './errors.ts'

const SHA256 = /^[0-9a-f]{64}$/u
const MAX_OUTPUT_BYTES = 65_536

/** Bounded directory for cached processing results. */
export interface ResultCacheConfig { directory: string; maxEntries: number; maxBytes: number }

/** One stored processing result. Random capabilities never produce this row. */
export interface ComputeResultCacheEntry {
  readonly digest: string
  readonly capabilities: readonly string[]
  readonly impls: readonly string[]
  readonly outputDigest: string
  readonly output: unknown
  readonly storedAt: string
}

/** Admitted cache write. */
export interface ResultCacheStoreRequest {
  readonly steps: readonly ComputeChainStep[]
  readonly impls: readonly string[]
  readonly output: unknown
}

/** Admitted cache lookup. */
export interface ResultCacheLookupRequest {
  readonly steps: readonly ComputeChainStep[]
  readonly impls: readonly string[]
}

function invalid(field: string): never {
  throw new TypeError(`INVALID_COMPUTE_FIELD: ${field}`)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('INVALID_COMPUTE_OBJECT')
  return value as Record<string, unknown>
}

/**
 * Registry `determinism` for one capability. Missing is not treated as deterministic.
 * @param capability - Semantic capability name.
 * @returns The registry value, or null when the name has no classification.
 */
export function determinismOf(capability: string): 'deterministic' | 'random' | null {
  return DETERMINISM_BY_CAPABILITY[capability] ?? null
}

/**
 * Refuse a chain that is random, unclassified, or mixes the two.
 * @param capabilities - Already admitted semantic names.
 * @returns Why the chain must not be cached, or null when every step is deterministic.
 */
export function cacheRefusalOf(capabilities: readonly string[]): 'random' | 'unknown' | null {
  for (const capability of capabilities) {
    const determinism = determinismOf(capability)
    if (determinism === null) return 'unknown'
    if (determinism === 'random') return 'random'
  }
  return null
}

/**
 * Digest for `(capability, impl, input)` as 01 册 §3.3. Same inputs must compare equal.
 * @param steps - Already admitted steps.
 * @param impls - Parallel registry implementation ids.
 * @returns Hex SHA-256.
 */
export function resultCacheDigest(steps: readonly ComputeChainStep[], impls: readonly string[]): string {
  if (impls.length !== steps.length) invalid('impls')
  return createHash('sha256').update(JSON.stringify(steps.map((step, index) => ({
    capability: step.capability,
    impl: impls[index],
    input: step.input,
  })))).digest('hex')
}

/**
 * Digest of a stored output so a later hit can prove it is the same bytes.
 * @param output - JSON-serializable payload.
 * @returns Hex SHA-256.
 */
export function resultOutputDigest(output: unknown): string {
  return createHash('sha256').update(JSON.stringify(output)).digest('hex')
}

function parseImpls(value: unknown, steps: readonly ComputeChainStep[]): string[] {
  if (!Array.isArray(value) || value.length !== steps.length) invalid('impls')
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim() || item.length > 128) invalid('impls')
    const impl = item.trim()
    const ads = IMPLEMENTATIONS_BY_CAPABILITY[steps[index]!.capability]
    if (ads && ads.length > 0 && !ads.some(ad => ad.id === impl)) {
      throw new ComputeError('COMPUTE_CACHE_IMPL_UNKNOWN', 409)
    }
    return impl
  })
}

function parseOutput(value: unknown): unknown {
  if (value === undefined) invalid('output')
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) invalid('output')
  return JSON.parse(encoded) as unknown
}

function parseStepsAndImpls(value: unknown): { steps: readonly ComputeChainStep[]; impls: readonly string[] } {
  const item = record(value)
  const request = parseChainRequest({
    recipe_id: item.recipe_id ?? item.recipeId ?? null,
    steps: item.steps,
    budgetMinor: typeof item.budgetMinor === 'number' ? item.budgetMinor : 0,
    currency: 'CNY',
    maxNodes: item.maxNodes ?? null,
  })
  return { steps: request.steps, impls: parseImpls(item.impls, request.steps) }
}

function assertCacheable(capabilities: readonly string[], onStore: boolean): void {
  const refusal = cacheRefusalOf(capabilities)
  if (refusal === 'random') {
    if (onStore) throw new ComputeError('COMPUTE_CACHE_RANDOM', 409)
    return
  }
  if (refusal === 'unknown') throw new ComputeError('COMPUTE_CACHE_UNCLASSIFIED', 409)
}

/**
 * Admit a cache write. `partial` and `random` never become a stored default.
 * @param value - Untrusted `{ status, steps, impls, output }`.
 * @returns Steps, impls and a bounded output copy.
 */
export function parseResultCacheStore(value: unknown): ResultCacheStoreRequest {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (!['status', 'resultStatus', 'steps', 'impls', 'output', 'recipe_id', 'recipeId', 'budgetMinor', 'currency', 'maxNodes'].includes(key)) {
      invalid(key)
    }
  }
  const status = item.status ?? item.resultStatus
  if (status === 'partial') throw new ComputeError('COMPUTE_CACHE_PARTIAL', 409)
  if (status !== 'ok') invalid('status')
  const parsed = parseStepsAndImpls(item)
  assertCacheable(parsed.steps.map(step => step.capability), true)
  return { steps: parsed.steps, impls: parsed.impls, output: parseOutput(item.output) }
}

/**
 * Admit a cache lookup. Random chains miss rather than throw.
 * @param value - Untrusted `{ steps, impls }`.
 * @returns Steps and impls, or null when the chain is random.
 */
export function parseResultCacheLookup(value: unknown): ResultCacheLookupRequest | null {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (!['steps', 'impls', 'recipe_id', 'recipeId', 'budgetMinor', 'currency', 'maxNodes'].includes(key)) {
      invalid(key)
    }
  }
  const parsed = parseStepsAndImpls(item)
  const refusal = cacheRefusalOf(parsed.steps.map(step => step.capability))
  if (refusal === 'random') return null
  if (refusal === 'unknown') throw new ComputeError('COMPUTE_CACHE_UNCLASSIFIED', 409)
  return parsed
}

/** Directory-backed processing cache. Clearing it never touches the core. */
export class ComputeResultCache {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()
  private readonly indexPath: string

  /** Construct a cache without creating the directory.
   * @param config - Absolute private directory and capacity limits.
   */
  constructor(private readonly config: ResultCacheConfig) {
    this.indexPath = join(config.directory, 'entries.json')
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const promise = operation()
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }

  private async read(): Promise<ComputeResultCacheEntry[]> {
    let file
    try { file = await open(this.indexPath, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
    }
    try {
      if ((await file.stat()).size > this.config.maxBytes) throw new Error('size')
      const data: unknown = JSON.parse(await file.readFile('utf8'))
      if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1 || !Array.isArray((data as { entries?: unknown }).entries)) {
        throw new Error('schema')
      }
      const entries = (data as { entries: unknown[] }).entries
      if (entries.length > this.config.maxEntries) throw new Error('capacity')
      return entries.map(value => {
        if (!value || typeof value !== 'object') throw new Error('schema')
        const row = value as ComputeResultCacheEntry
        if (!SHA256.test(row.digest) || !SHA256.test(row.outputDigest)) throw new Error('schema')
        return row
      })
    } catch (error) {
      if (error instanceof ComputeError) throw error
      throw new ComputeError('COMPUTE_STORE_INVALID', 503)
    } finally { await file.close() }
  }

  private async replace(entries: ComputeResultCacheEntry[]): Promise<void> {
    if (entries.length > this.config.maxEntries) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
    const content = JSON.stringify({ version: 1, entries })
    if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
    await mkdir(this.config.directory, { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.indexPath, content, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Store one ok processing result. Random and partial never land here.
   * @param input - Already admitted store request.
   * @returns The persisted entry, including both digests.
   */
  put(input: ResultCacheStoreRequest): Promise<ComputeResultCacheEntry> {
    return this.track(async () => {
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.indexPath, async () => {
          const entries = await this.read()
          const digest = resultCacheDigest(input.steps, input.impls)
          const existing = entries.find(row => row.digest === digest)
          if (existing) {
            if (existing.outputDigest !== resultOutputDigest(input.output)) {
              throw new ComputeError('COMPUTE_CACHE_DIGEST_MISMATCH', 409)
            }
            return existing
          }
          const entry: ComputeResultCacheEntry = {
            digest,
            capabilities: input.steps.map(step => step.capability),
            impls: input.impls,
            outputDigest: resultOutputDigest(input.output),
            output: input.output,
            storedAt: new Date().toISOString(),
          }
          await this.replace([entry, ...entries])
          return entry
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /**
   * Return a previous processing result for the same `(capability, impl, input)`.
   * @param input - Already admitted lookup, or null when the chain is random.
   * @returns The entry, or null on a miss.
   */
  get(input: ResultCacheLookupRequest | null): Promise<ComputeResultCacheEntry | null> {
    if (input === null) return Promise.resolve(null)
    return this.track(async () => {
      const digest = resultCacheDigest(input.steps, input.impls)
      return (await this.read()).find(row => row.digest === digest) ?? null
    })
  }

  /**
   * Drop every cached result. This never contacts the core.
   * @returns The number of rows removed.
   */
  clear(): Promise<number> {
    return this.track(async () => {
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.indexPath, async () => {
          const entries = await this.read()
          await rm(this.config.directory, { recursive: true, force: true })
          return entries.length
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /** Stop new operations and drain accepted writes. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending)
  }
}
