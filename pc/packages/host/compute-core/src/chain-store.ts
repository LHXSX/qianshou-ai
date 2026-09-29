/** Private local chain receipts. Never a dispatch, quote, or ledger. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CAPABILITY_BY_TASK_TYPE, IMPLEMENTATIONS_BY_CAPABILITY, SEMANTIC_CAPABILITY_NAMES } from './capability-registry.ts'
import { ComputeError } from './errors.ts'
import { ComputeCapabilityId, type ComputePlanAuthorization } from './protocol.ts'
import { TASK_INPUT_PROPERTIES_BY_KIND, TASK_INPUT_REQUIRED_BY_KIND } from './task-chain-schema.ts'

/** End-local recipe contract id. This is not a sixth contracts/v1 section. */
export const RECIPE_CONTRACT = 'qianshou.recipe.v1' as const
const CHAIN_REASON = '链已存成草稿，等你的确认。尚未下单、报价或扣费。'
const APPROVED_REASON = '链已在本机确认。尚未下单、报价或扣费。'
const DECLINED_REASON = '链已在本机拒绝。尚未下单、报价或扣费。'
const HELD_REASON = '确认期满未应答，已按 hold 留痕，仍等待确认。尚未下单。'
const ABORT_REASON = '确认期满未应答，已按 abort 拒绝。尚未下单。'
const PROCEED_REASON = '确认期满未应答，已按 proceed_with_default 本机通过。尚未下单、报价或扣费。'
/** Default hold window when the caller omits `timeout`. */
export const DEFAULT_CHAIN_CONFIRM_TIMEOUT_MS = 86_400_000
const MAX_CHAIN_STEPS = 16
const CHAIN_ID = /^chain_[0-9a-f-]{36}$/u
const RECIPE_ID = /^[A-Za-z0-9._-]{1,128}$/u
const ABSENT_BEHAVIORS = ['hold', 'abort', 'proceed_with_default'] as const

const SEMANTIC = new Set(SEMANTIC_CAPABILITY_NAMES)
const PACKAGES = new Set(
  Object.values(IMPLEMENTATIONS_BY_CAPABILITY).flatMap(impls => impls.flatMap(impl => impl.names)),
)

/** One step: a registry capability plus the generated task `input` binding. */
export interface ComputeChainStep {
  readonly capability: ReturnType<typeof ComputeCapabilityId>
  readonly input: Readonly<Record<string, unknown>>
}

/** Admitted local chain request. Budget is a proposed ceiling, not a quote. */
export interface ComputeChainRequest {
  readonly recipeId: string | null
  readonly steps: readonly ComputeChainStep[]
  readonly budgetMinor: number
  readonly currency: 'CNY'
  readonly maxNodes: number | null
}

/** Absence policy for `human_confirm`. Default is `hold`. */
export type ChainAbsentBehavior = (typeof ABSENT_BEHAVIORS)[number]

/** Timeout and absence policy stored on every chain card. */
export interface ChainHumanConfirm {
  readonly timeoutMs: number
  readonly onAbsent: ChainAbsentBehavior
}

/** Required trace when the owner does not answer before timeout. */
export interface ChainAbsenceTrace {
  readonly at: string
  readonly behavior: ChainAbsentBehavior
  readonly note: string
}

/** Persisted chain card. This object never carries a workload id. */
export interface ComputeChainDraft {
  readonly id: string
  readonly contract: typeof RECIPE_CONTRACT
  readonly recipeId: string | null
  readonly version: '1'
  readonly sha256: string
  readonly request: ComputeChainRequest
  readonly status: 'draft' | 'hit'
  readonly authorization: ComputePlanAuthorization
  readonly humanConfirm: ChainHumanConfirm
  readonly absence: ChainAbsenceTrace | null
  readonly stepDraftIds: readonly string[] | null
  readonly createdAt: string
  readonly reason: string
}

/** Bounded storage settings for chain files. */
export interface ChainStoreConfig { path: string; maxChains: number; maxBytes: number }

function invalid(field: string): never {
  throw new TypeError(`INVALID_COMPUTE_FIELD: ${field}`)
}

/**
 * Default `human_confirm` spec: 24h hold. Absence still has to be recorded later.
 * @returns A complete confirm spec.
 */
export function defaultChainConfirm(): ChainHumanConfirm {
  return { timeoutMs: DEFAULT_CHAIN_CONFIRM_TIMEOUT_MS, onAbsent: 'hold' }
}

/**
 * Admit optional timeout and absence behavior. Omitted fields take the hold default.
 * @param value - Untrusted object that may carry `timeout` / `on_absent`.
 * @returns A complete confirm spec.
 */
export function parseHumanConfirm(value: unknown): ChainHumanConfirm {
  const item = record(value)
  const rawTimeout = item.timeout ?? item.timeoutMs ?? item.timeout_ms
  let timeoutMs = DEFAULT_CHAIN_CONFIRM_TIMEOUT_MS
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== 'number' || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1_000 || rawTimeout > 604_800_000) {
      invalid('timeout')
    }
    timeoutMs = rawTimeout
  }
  const rawAbsent = item.on_absent ?? item.onAbsent
  let onAbsent: ChainAbsentBehavior = 'hold'
  if (rawAbsent !== undefined) {
    if (typeof rawAbsent !== 'string' || !ABSENT_BEHAVIORS.includes(rawAbsent as ChainAbsentBehavior)) invalid('on_absent')
    onAbsent = rawAbsent as ChainAbsentBehavior
  }
  return { timeoutMs, onAbsent }
}

/**
 * Admit an owner chain decision. This is not a model-visible approval.
 * @param value - Untrusted `{ id, decision }`.
 * @returns Host chain id and approved/declined.
 */
export function parseChainConfirmation(value: unknown): { id: string; decision: Exclude<ComputePlanAuthorization, 'pending'> } {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (!['id', 'decision'].includes(key)) invalid(key)
  }
  if (typeof item.id !== 'string' || !CHAIN_ID.test(item.id)) invalid('id')
  if (item.decision !== 'approved' && item.decision !== 'declined') invalid('decision')
  return { id: item.id, decision: item.decision }
}

/**
 * Admit a stored chain identity without a decision. Extra keys fail.
 * @param value - Untrusted `{ id }`.
 * @returns Host chain id.
 */
export function parseChainLocator(value: unknown): { id: string } {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (key !== 'id') invalid(key)
  }
  if (typeof item.id !== 'string' || !CHAIN_ID.test(item.id)) invalid('id')
  return { id: item.id }
}

function chainReason(authorization: ComputePlanAuthorization, absence: ChainAbsenceTrace | null): string {
  if (absence && authorization === 'pending' && absence.behavior === 'hold') return HELD_REASON
  if (absence && authorization === 'declined' && absence.behavior === 'abort') return ABORT_REASON
  if (absence && authorization === 'approved' && absence.behavior === 'proceed_with_default') return PROCEED_REASON
  if (authorization === 'approved') return APPROVED_REASON
  if (authorization === 'declined') return DECLINED_REASON
  return CHAIN_REASON
}

function humanConfirmOf(row: ComputeChainDraft): ChainHumanConfirm {
  const spec = row.humanConfirm
  if (spec && Number.isSafeInteger(spec.timeoutMs) && ABSENT_BEHAVIORS.includes(spec.onAbsent)) return spec
  return defaultChainConfirm()
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('INVALID_COMPUTE_OBJECT')
  return value as Record<string, unknown>
}

/**
 * Admit one generated `input` object. Extra keys and missing required keys fail.
 * @param value - Untrusted step input.
 * @returns A copy containing only schema-known keys.
 */
export function parseChainInput(value: unknown): Record<string, unknown> {
  const item = record(value)
  const kind = item.kind
  if (typeof kind !== 'string' || !(kind in TASK_INPUT_REQUIRED_BY_KIND)) invalid('input.kind')
  const allowed = new Set(TASK_INPUT_PROPERTIES_BY_KIND[kind])
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) invalid('input')
  }
  for (const key of TASK_INPUT_REQUIRED_BY_KIND[kind] ?? []) {
    if (!(key in item)) invalid('input')
  }
  const out: Record<string, unknown> = { kind }
  for (const key of allowed) {
    if (key === 'kind' || !(key in item)) continue
    const field = item[key]
    if (key === 'value') out.value = field
    else if (typeof field !== 'string' || !field.trim() || field.length > 8_000 || field.includes('\0')) invalid('input')
    else out[key] = field
  }
  return out
}

/**
 * Admit a chain tool payload. The Host supplies a freshly observed registry set
 * for new drafts; standalone callers retain the bundled set for stored legacy data.
 * @param value - Untrusted tool arguments plus `currency`.
 * @returns A local chain request with no workload identity.
 */
export function parseChainRequest(value: unknown, semanticCapabilities: ReadonlySet<string> = SEMANTIC): ComputeChainRequest {
  const item = record(value)
  for (const key of Object.keys(item)) {
    if (!['recipe_id', 'recipeId', 'steps', 'budgetMinor', 'maxNodes', 'currency', 'human_confirm', 'humanConfirm'].includes(key)) invalid(key)
  }
  const recipeRaw = item.recipe_id ?? item.recipeId
  const recipeId = recipeRaw === undefined || recipeRaw === null ? null : String(recipeRaw)
  if (recipeId !== null && (!RECIPE_ID.test(recipeId) || recipeId === '.' || recipeId === '..')) invalid('recipe_id')
  if (!Array.isArray(item.steps) || item.steps.length < 1 || item.steps.length > MAX_CHAIN_STEPS) invalid('steps')
  if (typeof item.budgetMinor !== 'number' || !Number.isSafeInteger(item.budgetMinor) || item.budgetMinor < 0) invalid('budgetMinor')
  if (item.currency !== 'CNY') invalid('currency')
  let maxNodes: number | null = null
  if (item.maxNodes !== undefined && item.maxNodes !== null) {
    if (typeof item.maxNodes !== 'number' || !Number.isSafeInteger(item.maxNodes) || item.maxNodes < 1 || item.maxNodes > 64) {
      invalid('maxNodes')
    }
    maxNodes = item.maxNodes
  }
  const steps = item.steps.map((stepValue, index) => {
    const step = record(stepValue)
    if (Object.keys(step).some(key => key !== 'capability' && key !== 'input')) invalid(`steps[${index}]`)
    if (typeof step.capability !== 'string'
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(step.capability)
      || step.capability.includes('..')
      || !semanticCapabilities.has(step.capability)
      || PACKAGES.has(step.capability)
      || (CAPABILITY_BY_TASK_TYPE[step.capability] !== undefined
        && CAPABILITY_BY_TASK_TYPE[step.capability] !== step.capability)) {
      throw new ComputeError('COMPUTE_CAPABILITY_NOT_REGISTRY', 409)
    }
    return { capability: ComputeCapabilityId(step.capability), input: parseChainInput(step.input) }
  })
  return { recipeId, steps, budgetMinor: item.budgetMinor, currency: 'CNY', maxNodes }
}

/**
 * Digest of the canonical step list. Matching recipes later use this, not a model.
 * @param steps - Already admitted steps.
 * @returns Hex SHA-256.
 */
export function chainStepsDigest(steps: readonly ComputeChainStep[]): string {
  return createHash('sha256').update(JSON.stringify(steps)).digest('hex')
}

/** Atomic local chain cards. Creating a card never contacts the core. */
export class ComputeChainStore {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  /** Construct a store without opening or rewriting existing user recipes.
   * @param config - Absolute private path and capacity limits.
   */
  constructor(private readonly config: ChainStoreConfig) {}

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const promise = operation()
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }

  private async read(): Promise<ComputeChainDraft[]> {
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
      if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1 || !Array.isArray((data as { chains?: unknown }).chains)) {
        throw new Error('schema')
      }
      const chains = (data as { chains: unknown[] }).chains
      if (chains.length > this.config.maxChains) throw new Error('capacity')
      return chains.map((value) => {
        if (!value || typeof value !== 'object') throw new Error('schema')
        const row = value as ComputeChainDraft
        if (!CHAIN_ID.test(row.id) || row.contract !== RECIPE_CONTRACT || (row.status !== 'draft' && row.status !== 'hit')) {
          throw new Error('schema')
        }
        if (row.authorization !== 'pending' && row.authorization !== 'approved' && row.authorization !== 'declined') {
          throw new Error('schema')
        }
        return {
          ...row,
          humanConfirm: humanConfirmOf(row),
          absence: row.absence ?? null,
          stepDraftIds: row.stepDraftIds ?? null,
        }
      })
    } catch { throw new ComputeError('COMPUTE_STORE_INVALID', 503) }
    finally { await file.close() }
  }

  /** Persist one already admitted chain. This never publishes or charges.
   * @param input - Planning constraints, revalidated at the persistence boundary.
   * @returns The local chain card after atomic replacement completes.
   */
  create(input: ComputeChainRequest, confirm: ChainHumanConfirm = defaultChainConfirm(), semanticCapabilities: ReadonlySet<string> = SEMANTIC): Promise<ComputeChainDraft> {
    return this.track(async () => {
      const request = parseChainRequest({ ...input, recipe_id: input.recipeId }, semanticCapabilities)
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const chains = await this.read()
          if (chains.length >= this.config.maxChains) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
          const draft: ComputeChainDraft = {
            id: `chain_${randomUUID()}`,
            contract: RECIPE_CONTRACT,
            recipeId: request.recipeId,
            version: '1',
            sha256: chainStepsDigest(request.steps),
            request,
            status: 'draft',
            authorization: 'pending',
            humanConfirm: confirm,
            absence: null,
            stepDraftIds: null,
            createdAt: new Date().toISOString(),
            reason: CHAIN_REASON,
          }
          const content = JSON.stringify({ version: 1, chains: [draft, ...chains] })
          if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
          await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 })
          return draft
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /**
   * Persist a projected card once. A later hit of the same id returns the stored decision.
   * @param card - Already-shaped draft or hit card.
   * @returns The stored card.
   */
  admit(card: ComputeChainDraft): Promise<ComputeChainDraft> {
    return this.track(async () => {
      if (!CHAIN_ID.test(card.id) || card.contract !== RECIPE_CONTRACT || (card.status !== 'draft' && card.status !== 'hit')) {
        throw new ComputeError('COMPUTE_STORE_INVALID', 503)
      }
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const chains = await this.read()
          const existing = chains.find(item => item.id === card.id)
          if (existing) return existing
          if (chains.length >= this.config.maxChains) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
          const content = JSON.stringify({ version: 1, chains: [card, ...chains] })
          if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
          await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 })
          return card
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /**
   * Read one stored chain. Hit cards that were never persisted are not found.
   * @param id - Host-issued chain identity.
   * @returns The stored card.
   */
  get(id: string): Promise<ComputeChainDraft> {
    return this.track(async () => {
      const chains = await this.read()
      const row = chains.find(item => item.id === id)
      if (!row) throw new ComputeError('COMPUTE_CHAIN_NOT_FOUND', 404)
      return row
    })
  }

  private write(id: string, update: (current: ComputeChainDraft) => ComputeChainDraft): Promise<ComputeChainDraft> {
    return this.track(async () => {
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const chains = await this.read()
          const index = chains.findIndex(item => item.id === id)
          if (index < 0) throw new ComputeError('COMPUTE_CHAIN_NOT_FOUND', 404)
          const next = update(chains[index]!)
          const updated = chains.map((item, i) => i === index ? next : item)
          const content = JSON.stringify({ version: 1, chains: updated })
          if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
          await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 })
          return next
        })
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
      }
    })
  }

  /**
   * Persist an owner decision. This never quotes, submits, or charges.
   * @param id - Host-issued chain identity.
   * @param decision - Owner approved or declined.
   * @returns The updated card.
   */
  confirm(id: string, decision: Exclude<ComputePlanAuthorization, 'pending'>): Promise<ComputeChainDraft> {
    return this.write(id, current => {
      if (current.authorization === 'declined' && current.absence?.behavior === 'abort' && decision === 'approved') {
        throw new ComputeError('COMPUTE_CHAIN_ABSENT_ABORTED', 409)
      }
      if (current.authorization === decision) return current
      return { ...current, authorization: decision, reason: chainReason(decision, current.absence) }
    })
  }

  /**
   * Record a due absence. Missing this write would make the timeout silent.
   * @param id - Host-issued chain identity.
   * @param now - Clock used to decide whether the timeout has passed.
   * @returns The card after the absence policy is applied, or unchanged if not due.
   */
  noteAbsence(id: string, now: Date): Promise<ComputeChainDraft> {
    return this.write(id, current => {
      if (current.authorization !== 'pending' || current.absence) return current
      const due = new Date(current.createdAt).getTime() + current.humanConfirm.timeoutMs
      if (!Number.isFinite(due) || now.getTime() < due) return current
      const behavior = current.humanConfirm.onAbsent
      const absence: ChainAbsenceTrace = {
        at: now.toISOString(),
        behavior,
        note: behavior === 'hold'
          ? '缺席：仍等待确认。'
          : behavior === 'abort'
            ? '缺席：已拒绝。'
            : '缺席：已按默认本机通过。',
      }
      const authorization: ComputePlanAuthorization = behavior === 'abort'
        ? 'declined'
        : behavior === 'proceed_with_default'
          ? 'approved'
          : 'pending'
      return { ...current, authorization, absence, reason: chainReason(authorization, absence) }
    })
  }

  /**
   * Remember local per-step draft ids after an approved expand. This is not a submit.
   * @param id - Host-issued chain identity.
   * @param stepDraftIds - Plan ids created for each step.
   * @returns The updated card.
   */
  attachStepDrafts(id: string, stepDraftIds: readonly string[]): Promise<ComputeChainDraft> {
    return this.write(id, current => {
      if (current.authorization !== 'approved') throw new ComputeError('COMPUTE_CHAIN_NOT_APPROVED', 409)
      if (current.stepDraftIds) return current
      return { ...current, stepDraftIds }
    })
  }

  /** Stop new operations and drain accepted writes. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending)
  }
}

const CHAIN_CARD_PROTOCOL = 'qianshou.chain-card.v1' as const

/** Replayable observations for a local chain card; not a quote or submission. */
export interface ChainDraftCardMeta {
  protocol: typeof CHAIN_CARD_PROTOCOL
  cardId: string
  contract: typeof RECIPE_CONTRACT
  sha256: string
  stepCount: number
  budgetMinor: number
  currency: 'CNY'
  maxNodes: number | null
  createdAt: string
  reason: string
  authorization: ComputePlanAuthorization
  humanConfirm: ChainHumanConfirm
  absence: ChainAbsenceTrace | null
  stepDraftIds: readonly string[] | null
}

/**
 * Project a local chain into replayable card observations without quoting or submitting.
 * @param draft - Host-validated local chain receipt.
 * @returns JSON-safe metadata for the conversation card.
 */
export function chainDraftCardMeta(draft: ComputeChainDraft): ChainDraftCardMeta {
  return {
    protocol: CHAIN_CARD_PROTOCOL,
    cardId: draft.id,
    contract: draft.contract,
    sha256: draft.sha256,
    stepCount: draft.request.steps.length,
    budgetMinor: draft.request.budgetMinor,
    currency: draft.request.currency,
    maxNodes: draft.request.maxNodes,
    createdAt: draft.createdAt,
    reason: draft.reason,
    authorization: draft.authorization,
    humanConfirm: humanConfirmOf(draft),
    absence: draft.absence ?? null,
    stepDraftIds: draft.stepDraftIds ?? null,
  }
}
