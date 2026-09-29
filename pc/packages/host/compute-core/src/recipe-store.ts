/** End-local settled recipes. Matching never calls a model; settling never dispatches. */
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CAPABILITY_BY_TASK_TYPE, LEGACY_TASK_TYPES_BY_CAPABILITY, SEMANTIC_CAPABILITY_NAMES } from './capability-registry.ts'
import {
  RECIPE_CONTRACT,
  chainStepsDigest,
  defaultChainConfirm,
  parseChainInput,
  parseChainRequest,
  type ComputeChainDraft,
  type ComputeChainRequest,
  type ComputeChainStep,
} from './chain-store.ts'
import { ComputeError } from './errors.ts'
import { ComputeCapabilityId } from './protocol.ts'
import { TASK_INPUT_REQUIRED_BY_KIND } from './task-chain-schema.ts'

const HIT_REASON = '命中已有 recipe，未重新编链。仍未下单、报价或扣费。'
const RECIPE_ID = /^[A-Za-z0-9._-]{1,128}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SEMANTIC = new Set(SEMANTIC_CAPABILITY_NAMES)
const MEDIA_KINDS = new Set(Object.keys(TASK_INPUT_REQUIRED_BY_KIND))

/** Bounded storage settings for settled recipe files. */
export interface RecipeStoreConfig { path: string; maxRecipes: number; maxBytes: number }

/** Result statuses that may be stored. `partial` is never a row. */
export type RecipeResultStatus = 'ok' | 'failed' | 'cancelled'

/** Owner admission. Only `accepted` rows participate in automatic match. */
export type RecipeAdmission = 'accepted' | 'candidate'

/** Persisted local recipe. Control planes do not see this object. */
export interface ComputeRecipeRecord {
  readonly contract: typeof RECIPE_CONTRACT
  readonly recipeId: string | null
  readonly version: number
  readonly sha256: string
  readonly steps: readonly ComputeChainStep[]
  readonly capabilities: readonly string[]
  readonly taskTypes: readonly string[]
  readonly mediaKinds: readonly string[]
  readonly admission: RecipeAdmission
  readonly resultStatus: RecipeResultStatus
  readonly createdAt: string
  readonly settledAt: string
}

/** Match key from 05 册增-3: capability/task-type sequence, media set, optional recipe id. */
export interface RecipeMatchQuery {
  readonly recipeId: string | null
  readonly capabilities: readonly string[] | null
  readonly taskTypes: readonly string[] | null
  readonly mediaKinds: readonly string[] | null
}

/** Admitted settlement. Success is `result.status` plus optional verify, never a model. */
export interface RecipeSettleRequest {
  readonly request: ComputeChainRequest
  readonly resultStatus: RecipeResultStatus
  readonly verifyPassed: boolean
}

function invalid(field: string): never {
  throw new TypeError(`INVALID_COMPUTE_FIELD: ${field}`)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('INVALID_COMPUTE_OBJECT')
  return value as Record<string, unknown>
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return sameList([...left].sort(), [...right].sort())
}

/**
 * First recorded legacy `task_type` per capability; the capability name when the registry has none.
 * @param capabilities - Already admitted semantic names.
 * @returns The projected sequence used as the 增-3 match key.
 */
export function taskTypeSequenceOf(capabilities: readonly string[]): string[] {
  return capabilities.map(capability => LEGACY_TASK_TYPES_BY_CAPABILITY[capability]?.[0] ?? capability)
}

/**
 * Closed `input.kind` set from admitted steps. This is the media-type half of the match key.
 * @param steps - Already admitted steps.
 * @returns Sorted unique generated input kinds.
 */
export function mediaKindsOf(steps: readonly ComputeChainStep[]): string[] {
  return [...new Set(steps.map(step => String(step.input.kind)))].sort()
}

function capabilityOfName(name: string): string {
  const mapped = CAPABILITY_BY_TASK_TYPE[name]
  if (mapped !== undefined) return mapped
  invalid('task_types')
}

function parseNameList(value: unknown, field: string, admit: (name: string) => string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) invalid(field)
  return value.map(item => {
    if (typeof item !== 'string' || !item.trim()) invalid(field)
    return admit(item)
  })
}

function parseMediaKinds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) invalid('media_kinds')
  const kinds = [...new Set(value.map(item => {
    if (typeof item !== 'string' || !MEDIA_KINDS.has(item)) invalid('media_kinds')
    return item
  }))].sort()
  if (kinds.length < 1) invalid('media_kinds')
  return kinds
}

function parseRecipeId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const recipeId = String(value)
  if (!RECIPE_ID.test(recipeId) || recipeId === '.' || recipeId === '..') invalid('recipe_id')
  return recipeId
}

function parseVerifyPassed(value: unknown): boolean {
  if (value === undefined) return true
  const item = record(value)
  if (item.passed === false) return false
  if (item.passed === true) return true
  if (!Array.isArray(item.steps)) invalid('verify')
  return item.steps.every(step => record(step).passed !== false)
}

/**
 * Admit a match query. Sequence names may be semantic or recorded legacy spellings.
 * @param value - Untrusted tool or planner arguments.
 * @returns A query that match() can evaluate without a model.
 */
export function parseRecipeMatchQuery(value: unknown): RecipeMatchQuery {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (!['recipe_id', 'recipeId', 'capabilities', 'task_types', 'taskTypes', 'media_kinds', 'mediaKinds'].includes(key)) {
      invalid(key)
    }
  }
  const recipeId = parseRecipeId(item.recipe_id ?? item.recipeId)
  const capabilities = item.capabilities === undefined
    ? null
    : parseNameList(item.capabilities, 'capabilities', name => {
      if (!SEMANTIC.has(name)) throw new ComputeError('COMPUTE_CAPABILITY_NOT_REGISTRY', 409)
      return name
    })
  const taskTypes = item.task_types === undefined && item.taskTypes === undefined
    ? null
    : parseNameList(item.task_types ?? item.taskTypes, 'task_types', capabilityOfName)
  if (capabilities && taskTypes && !sameList(capabilities, taskTypes.map(capabilityOfName))) invalid('capabilities')
  const mediaKinds = item.media_kinds === undefined && item.mediaKinds === undefined
    ? null
    : parseMediaKinds(item.media_kinds ?? item.mediaKinds)
  if (recipeId === null && capabilities === null && taskTypes === null) invalid('recipe_id')
  return { recipeId, capabilities, taskTypes, mediaKinds }
}

/**
 * Admit a settlement. `partial` is rejected here so it cannot become a default path.
 * @param value - Untrusted `{ status, steps, recipe_id?, verify? }`.
 * @returns Steps plus a storeable result status.
 */
export function parseRecipeSettleRequest(value: unknown): RecipeSettleRequest {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (!['status', 'resultStatus', 'steps', 'recipe_id', 'recipeId', 'verify', 'budgetMinor', 'currency', 'maxNodes'].includes(key)) {
      invalid(key)
    }
  }
  const status = item.status ?? item.resultStatus
  if (status === 'partial') throw new ComputeError('COMPUTE_RECIPE_PARTIAL', 409)
  if (status !== 'ok' && status !== 'failed' && status !== 'cancelled') invalid('status')
  const verifyPassed = parseVerifyPassed(item.verify)
  if (!verifyPassed) throw new ComputeError('COMPUTE_RECIPE_VERIFY_FAILED', 409)
  return {
    request: parseChainRequest({
      recipe_id: item.recipe_id ?? item.recipeId ?? null,
      steps: item.steps,
      budgetMinor: typeof item.budgetMinor === 'number' ? item.budgetMinor : 0,
      currency: 'CNY',
      maxNodes: item.maxNodes ?? null,
    }),
    resultStatus: status,
    verifyPassed,
  }
}

function matches(row: ComputeRecipeRecord, query: RecipeMatchQuery): boolean {
  if (row.admission !== 'accepted') return false
  if (query.recipeId !== null && row.recipeId !== query.recipeId) return false
  const queryCaps = query.capabilities ?? (query.taskTypes ? query.taskTypes.map(capabilityOfName) : null)
  if (queryCaps !== null && !sameList(row.capabilities, queryCaps)) return false
  if (query.mediaKinds !== null && !sameSet(row.mediaKinds, query.mediaKinds)) return false
  return query.recipeId !== null || queryCaps !== null
}

function matchQueryFromRequest(request: ComputeChainRequest): RecipeMatchQuery {
  return {
    recipeId: request.recipeId,
    capabilities: request.steps.map(step => step.capability),
    taskTypes: null,
    mediaKinds: mediaKindsOf(request.steps),
  }
}

function chainIdFromDigest(sha256: string): string {
  return `chain_${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-${sha256.slice(12, 16)}-${sha256.slice(16, 20)}-${sha256.slice(20, 32)}`
}

/**
 * Project an accepted recipe into a reviewable chain card without writing a new draft.
 * @param recipe - Already matched accepted row.
 * @param request - Optional budget from this invocation; steps always come from the recipe.
 * @returns A local card with `status=hit` and no workload identity.
 */
export function recipeHitCard(recipe: ComputeRecipeRecord, request?: Pick<ComputeChainRequest, 'budgetMinor' | 'maxNodes'>): ComputeChainDraft {
  return {
    id: chainIdFromDigest(recipe.sha256),
    contract: RECIPE_CONTRACT,
    recipeId: recipe.recipeId,
    version: '1',
    sha256: recipe.sha256,
    request: {
      recipeId: recipe.recipeId,
      steps: recipe.steps.map(step => ({ capability: ComputeCapabilityId(step.capability), input: parseChainInput(step.input) })),
      budgetMinor: request?.budgetMinor ?? 0,
      currency: 'CNY',
      maxNodes: request?.maxNodes ?? null,
    },
    status: 'hit',
    authorization: 'pending',
    humanConfirm: defaultChainConfirm(),
    absence: null,
    stepDraftIds: null,
    createdAt: new Date().toISOString(),
    reason: HIT_REASON,
  }
}

function parseLocator(value: unknown): { sha256: string | null; recipeId: string | null } {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (!['sha256', 'recipe_id', 'recipeId'].includes(key)) invalid(key)
  }
  const sha256 = item.sha256 === undefined || item.sha256 === null ? null : String(item.sha256)
  if (sha256 !== null && !SHA256.test(sha256)) invalid('sha256')
  const recipeId = parseRecipeId(item.recipe_id ?? item.recipeId)
  if (sha256 === null && recipeId === null) invalid('sha256')
  return { sha256, recipeId }
}

/** Atomic local recipes. Matching and settling never contact the core. */
export class ComputeRecipeStore {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  /** Construct a store without opening or rewriting existing user recipes.
   * @param config - Absolute private path and capacity limits.
   */
  constructor(private readonly config: RecipeStoreConfig) {}

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const promise = operation()
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }

  private async read(): Promise<ComputeRecipeRecord[]> {
    let file
    try { file = await open(this.config.path, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
    }
    try {
      if ((await file.stat()).size > this.config.maxBytes) throw new Error('size')
      const content = await file.readFile('utf8')
      const data: unknown = JSON.parse(content)
      if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1 || !Array.isArray((data as { recipes?: unknown }).recipes)) {
        throw new Error('schema')
      }
      const recipes = (data as { recipes: unknown[] }).recipes
      if (recipes.length > this.config.maxRecipes) throw new Error('capacity')
      return recipes.map((value) => {
        if (!value || typeof value !== 'object') throw new Error('schema')
        const row = value as ComputeRecipeRecord
        if (row.contract !== RECIPE_CONTRACT || !SHA256.test(row.sha256) || (row.admission !== 'accepted' && row.admission !== 'candidate')) {
          throw new Error('schema')
        }
        if (row.resultStatus !== 'ok' && row.resultStatus !== 'failed' && row.resultStatus !== 'cancelled') throw new Error('schema')
        return row
      })
    } catch (error) {
      if (error instanceof ComputeError) throw error
      throw new ComputeError('COMPUTE_STORE_INVALID', 503)
    }
    finally { await file.close() }
  }

  private async replace(recipes: ComputeRecipeRecord[]): Promise<void> {
    if (recipes.length > this.config.maxRecipes) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
    const content = JSON.stringify({ version: 1, recipes })
    if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
    await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 })
  }

  /**
   * Return the newest accepted recipe for the match key, or null so a model may compose.
   * @param query - Already admitted match key.
   * @returns The accepted row, or null on a miss.
   */
  match(query: RecipeMatchQuery): Promise<ComputeRecipeRecord | null> {
    return this.track(async () => {
      const rows = (await this.read()).filter(row => matches(row, query))
      rows.sort((left, right) => right.version - left.version || right.settledAt.localeCompare(left.settledAt))
      return rows[0] ?? null
    })
  }

  /**
   * Persist a settled chain. `ok` becomes accepted; `failed`/`cancelled` stay candidate.
   * @param input - Already admitted settlement.
   * @returns The stored row after atomic replacement.
   */
  settle(input: RecipeSettleRequest): Promise<ComputeRecipeRecord> {
    return this.track(async () => {
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const recipes = await this.read()
          const sha256 = chainStepsDigest(input.request.steps)
          const existing = recipes.find(row => row.sha256 === sha256)
          if (existing) return existing
          const capabilities = input.request.steps.map(step => step.capability)
          const now = new Date().toISOString()
          const sameName = recipes.filter(row => row.recipeId !== null && row.recipeId === input.request.recipeId)
          const record: ComputeRecipeRecord = {
            contract: RECIPE_CONTRACT,
            recipeId: input.request.recipeId,
            version: Math.max(0, ...sameName.map(row => row.version)) + 1,
            sha256,
            steps: input.request.steps,
            capabilities,
            taskTypes: taskTypeSequenceOf(capabilities),
            mediaKinds: mediaKindsOf(input.request.steps),
            admission: input.resultStatus === 'ok' ? 'accepted' : 'candidate',
            resultStatus: input.resultStatus,
            createdAt: now,
            settledAt: now,
          }
          await this.replace([record, ...recipes])
          return record
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /**
   * Demote matched rows to candidate so they stop auto-hitting.
   * @param value - Untrusted `{ sha256 }` or `{ recipe_id }`.
   * @returns Updated rows; missing locators yield an empty list.
   */
  reject(value: unknown): Promise<ComputeRecipeRecord[]> {
    return this.setAdmission(value, 'candidate')
  }

  /**
   * Admit previously rejected `ok` rows so they can auto-hit again.
   * @param value - Untrusted `{ sha256 }` or `{ recipe_id }`.
   * @returns Updated rows; failed/cancelled rows stay candidate.
   */
  accept(value: unknown): Promise<ComputeRecipeRecord[]> {
    return this.setAdmission(value, 'accepted')
  }

  private setAdmission(value: unknown, admission: RecipeAdmission): Promise<ComputeRecipeRecord[]> {
    const locator = parseLocator(value)
    return this.track(async () => {
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const recipes = await this.read()
          const updated: ComputeRecipeRecord[] = []
          const next = recipes.map(row => {
            const hit = (locator.sha256 !== null && row.sha256 === locator.sha256)
              || (locator.recipeId !== null && row.recipeId === locator.recipeId)
            if (!hit) return row
            if (admission === 'accepted' && row.resultStatus !== 'ok') return row
            const changed: ComputeRecipeRecord = { ...row, admission }
            updated.push(changed)
            return changed
          })
          await this.replace(next)
          return updated
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

/**
 * Build a match query from an admitted chain request.
 * @param request - Host-validated chain request.
 * @returns The 增-3 match key for those steps.
 */
export function recipeMatchQueryFromRequest(request: ComputeChainRequest): RecipeMatchQuery {
  return matchQueryFromRequest(request)
}
