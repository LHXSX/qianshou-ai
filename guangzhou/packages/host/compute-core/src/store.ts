/** Private local planning receipts; never a ledger or an execution authority. */
import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ComputePlanId, ComputeWorkloadId, type ComputePlanAuthorization, type ComputePlanDraft, type ComputePlanRequest } from './protocol.ts'
import { parsePlanRequest } from './validation.ts'
import { ComputeError } from './errors.ts'

const DRAFT_REASON = '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。'
const APPROVED_REASON = '方案已在本机确认，尚未报价、下单或扣费。'
const DECLINED_REASON = '方案已在本机拒绝，尚未报价、下单或扣费。'
const PUBLISHED_REASON = '方案已发布到调度中心，任务身份由核心签发；报价仍未接入。'
const WORKLOAD_ID = /^[A-Za-z0-9._-]{1,128}$/u

function draftReason(authorization: ComputePlanAuthorization): string {
  if (authorization === 'approved') return APPROVED_REASON
  if (authorization === 'declined') return DECLINED_REASON
  return DRAFT_REASON
}

function planAuthorization(value: unknown): ComputePlanAuthorization {
  if (value === undefined || value === 'pending') return 'pending'
  if (value === 'approved' || value === 'declined') return value
  throw new Error('schema')
}

function planWorkloadId(value: unknown): ComputeWorkloadId | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !WORKLOAD_ID.test(value) || value === '.' || value === '..') throw new Error('schema')
  return ComputeWorkloadId(value)
}

/** Bounded storage settings; files contain goals and must remain local and private. */
export interface DraftStoreConfig { path: string; maxDrafts: number; maxBytes: number }

/** Atomic, cross-process serialized draft storage with explicit corruption failures. */
export class ComputeDraftStore {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  /** Construct a store without opening, migrating or overwriting existing user data.
   * @param config - Absolute private path and deployment-owned capacity limits.
   */
  constructor(private readonly config: DraftStoreConfig) {}

  private async read(): Promise<ComputePlanDraft[]> {
    let file
    try { file = await open(this.config.path, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_STORE_UNAVAILABLE', 503)
    }
    try {
      if ((await file.stat()).size > this.config.maxBytes) throw new Error('size')
      const bytes = Buffer.alloc(this.config.maxBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > this.config.maxBytes) throw new Error('size')
      const data: unknown = JSON.parse(bytes.toString('utf8', 0, length))
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('plans' in data) || !Array.isArray(data.plans)) throw new Error('schema')
      if (data.plans.length > this.config.maxDrafts) throw new Error('capacity')
      const seen = new Set<string>()
      return data.plans.map((value: unknown): ComputePlanDraft => {
        if (!value || typeof value !== 'object') throw new Error('schema')
        const v = value as Record<string, unknown>
        if (typeof v.id !== 'string' || !/^plan_[0-9a-f-]{36}$/.test(v.id) || seen.has(v.id) || v.status !== 'draft' || v.quote !== null || typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt)) || new Date(v.createdAt).toISOString() !== v.createdAt) throw new Error('schema')
        seen.add(v.id)
        const authorization = planAuthorization(v.authorization)
        const workloadId = planWorkloadId(v.workloadId)
        return {
          id: ComputePlanId(v.id), request: parsePlanRequest(v.request), status: 'draft', createdAt: v.createdAt,
          quote: null, authorization, workloadId, reason: workloadId ? PUBLISHED_REASON : draftReason(authorization),
        }
      })
    } catch { throw new ComputeError('COMPUTE_STORE_INVALID', 503) }
    finally { await file.close() }
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const promise = operation()
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }

  /** Read owner-visible drafts without treating their goal text as instructions.
   * @returns Fresh validated drafts; no in-memory stale view across Host processes.
   */
  list(): Promise<ComputePlanDraft[]> { return this.track(() => this.read()) }

  /** Persist one already admitted local plan; this operation never contacts a billing API.
   * @param input - Planning constraints, revalidated at the persistence boundary.
   * @returns The local receipt after atomic replacement completes.
   */
  create(input: ComputePlanRequest): Promise<ComputePlanDraft> {
    return this.track(async () => {
      const request = parsePlanRequest(input)
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const plans = await this.read()
          if (plans.length >= this.config.maxDrafts) throw new ComputeError('COMPUTE_DRAFT_CAPACITY', 409)
          const draft: ComputePlanDraft = {
            id: ComputePlanId(`plan_${randomUUID()}`), request, status: 'draft', createdAt: new Date().toISOString(),
            quote: null, authorization: 'pending', workloadId: null, reason: draftReason('pending'),
          }
          const content = JSON.stringify({ version: 1, plans: [draft, ...plans] })
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

  /** Persist a local owner decision; this operation never contacts a billing or submit API.
   * @param id - Host-issued plan identity already stored on this machine.
   * @param decision - Owner confirmation or decline of that draft.
   * @returns The local receipt after atomic replacement completes.
   */
  confirm(id: ComputePlanId, decision: Exclude<ComputePlanAuthorization, 'pending'>): Promise<ComputePlanDraft> {
    return this.track(async () => {
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const plans = await this.read()
          const index = plans.findIndex(item => item.id === id)
          if (index < 0) throw new ComputeError('COMPUTE_PLAN_NOT_FOUND', 404)
          const current = plans[index]!
          if (current.authorization === decision) return current
          const next: ComputePlanDraft = {
            ...current, authorization: decision,
            reason: current.workloadId ? PUBLISHED_REASON : draftReason(decision),
          }
          const updated = plans.map((item, i) => i === index ? next : item)
          const content = JSON.stringify({ version: 1, plans: updated })
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

  /** Persist a core-issued workload identity on an approved local draft.
   * @param id - Host-issued plan identity already stored on this machine.
   * @param workloadId - Identity returned by `POST /api/v8/developer/tasks`.
   * @returns The local receipt after atomic replacement completes.
   */
  attachWorkload(id: ComputePlanId, workloadId: ComputeWorkloadId): Promise<ComputePlanDraft> {
    return this.track(async () => {
      const attached = planWorkloadId(workloadId)
      if (attached === null) throw new ComputeError('CORE_INVALID_WORKLOAD_ID')
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      try {
        return await withFileLock(this.config.path, async () => {
          const plans = await this.read()
          const index = plans.findIndex(item => item.id === id)
          if (index < 0) throw new ComputeError('COMPUTE_PLAN_NOT_FOUND', 404)
          const current = plans[index]!
          if (current.authorization !== 'approved') throw new ComputeError('COMPUTE_PLAN_NOT_APPROVED', 409)
          if (current.workloadId === attached) return current
          if (current.workloadId !== null) throw new ComputeError('COMPUTE_PLAN_WORKLOAD_CONFLICT', 409)
          const next: ComputePlanDraft = { ...current, workloadId: attached, reason: PUBLISHED_REASON }
          const updated = plans.map((item, i) => i === index ? next : item)
          const content = JSON.stringify({ version: 1, plans: updated })
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

  /** Stop new operations and drain accepted writes before plugin disposal. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending)
  }
}
