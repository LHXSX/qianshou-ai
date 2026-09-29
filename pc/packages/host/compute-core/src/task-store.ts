/** Atomic local idempotency records for passive task attempts. */
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'
import { parseTaskState, transitionTask, type ComputeTaskEvent, type ComputeTaskState } from './task-state.ts'

/** Storage settings for bounded task metadata; no inputs, prompts, outputs, or credentials are stored. */
export interface TaskStoreConfig { path: string; maxTasks: number; maxBytes: number }

/** Cross-process serialized task state keyed by `taskId/attempt`. */
export class ComputeTaskStore {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  /** Construct a store without opening or rewriting the file.
   * @param config - Absolute private path and capacity limits.
   */
  constructor(private readonly config: TaskStoreConfig) {}

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ComputeError('COMPUTE_CLOSED', 503))
    const promise = operation()
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }

  private async read(): Promise<ComputeTaskState[]> {
    let file
    try { file = await open(this.config.path, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_TASK_STORE_UNAVAILABLE', 503)
    }
    try {
      if ((await file.stat()).size > this.config.maxBytes) throw new Error('size')
      const content = await file.readFile('utf8')
      const data: unknown = JSON.parse(content)
      if (!data || typeof data !== 'object' || (data as Record<string, unknown>).version !== 1 || !Array.isArray((data as Record<string, unknown>).tasks)) throw new Error('schema')
      const tasks = (data as Record<string, unknown>).tasks as unknown[]
      if (tasks.length > this.config.maxTasks) throw new Error('capacity')
      const seen = new Set<string>()
      return tasks.map((value) => {
        const state = parseTaskState(value)
        const key = taskKey(state)
        if (seen.has(key)) throw new Error('duplicate')
        seen.add(key)
        return state
      })
    } catch { throw new ComputeError('COMPUTE_TASK_STORE_INVALID', 503) }
    finally { await file.close() }
  }

  /** Read all local attempts; these facts do not prove remote acceptance or settlement.
   * @returns Persisted local task attempts.
   */
  list(): Promise<ComputeTaskState[]> { return this.track(() => this.read()) }

  /** Return one attempt or null; task IDs are never interpreted as paths.
   * @param taskId - Task identity to find.
   * @param attempt - Attempt number to find.
   * @returns Matching state, or null when absent.
   */
  get(taskId: string, attempt: number): Promise<ComputeTaskState | null> {
    return this.track(async () => (await this.read()).find(item => item.taskId === taskId && item.attempt === attempt) ?? null)
  }

  /** Insert an assignment once; replaying the same task/attempt never overwrites local state.
   * @param state - Offered task state to insert.
   * @returns True when a new record was written.
   */
  putIfAbsent(state: ComputeTaskState): Promise<boolean> {
    return this.track(async () => {
      const admitted = parseTaskState(state)
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.config.path, async () => {
        const tasks = await this.read()
        const existing = tasks.find(item => taskKey(item) === taskKey(admitted))
        if (existing) {
          if (existing.envelopeFingerprint !== admitted.envelopeFingerprint || existing.idempotencyKey !== admitted.idempotencyKey) {
            throw new ComputeError('COMPUTE_TASK_REPLAY_CONFLICT', 409)
          }
          return false
        }
        if (tasks.length >= this.config.maxTasks) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
        const next = [admitted, ...tasks]
        await this.write(next)
        return true
      })
    })
  }

  /**
   * Insert an offered assignment and accept it under one file lock.
   *
   * Keeping insertion and the ACCEPTED transition together prevents two local
   * coordinator loops from observing the same offer and racing each other. A
   * replay of the same fingerprint/idempotency key returns the existing state
   * without extending or replacing its lease.
   * @param state - Offered task state to admit.
   * @param leaseExpiresAt - Lease expiry to persist on acceptance.
   * @param now - Canonical current UTC timestamp.
   * @param options - Optional concurrency bound enforced under the file lock.
   * @returns Accepted state and whether a new record was inserted.
   */
  admit(
    state: ComputeTaskState,
    leaseExpiresAt: string,
    now: string,
    options?: { maxConcurrency?: number },
  ): Promise<{ state: ComputeTaskState; inserted: boolean }> {
    return this.track(async () => {
      const offered = parseTaskState(state)
      if (options?.maxConcurrency !== undefined && (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 64)) throw new ComputeError('COMPUTE_TASK_CONCURRENCY_LIMIT_INVALID')
      if (offered.status !== 'OFFERED' || offered.leaseExpiresAt !== null) throw new ComputeError('COMPUTE_TASK_STATE_INVALID', 409)
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.config.path, async () => {
        const tasks = await this.read()
        const existing = tasks.find(item => taskKey(item) === taskKey(offered))
        if (existing) {
          if (existing.envelopeFingerprint !== offered.envelopeFingerprint || existing.idempotencyKey !== offered.idempotencyKey) {
            throw new ComputeError('COMPUTE_TASK_REPLAY_CONFLICT', 409)
          }
          if (existing.status === 'ACCEPTED') {
            if (existing.leaseExpiresAt !== leaseExpiresAt) throw new ComputeError('COMPUTE_TASK_REPLAY_CONFLICT', 409)
            return { state: existing, inserted: false }
          }
          const accepted = transitionTask(existing, { type: 'accept', leaseExpiresAt }, now)
          const next = tasks.map(item => taskKey(item) === taskKey(existing) ? accepted : item)
          await this.write(next)
          return { state: accepted, inserted: false }
        }
        if (options?.maxConcurrency !== undefined && tasks.filter(item => ACTIVE_STATUSES.has(item.status)).length >= options.maxConcurrency) throw new ComputeError('COMPUTE_TASK_CONCURRENCY_LIMIT', 409)
        if (tasks.length >= this.config.maxTasks) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
        const accepted = transitionTask(offered, { type: 'accept', leaseExpiresAt }, now)
        await this.write([accepted, ...tasks])
        return { state: accepted, inserted: true }
      })
    })
  }

  /** Persist one terminal refusal atomically; transient policy refusals stay ephemeral.
   * @param state - Offered task state to refuse.
   * @param reason - Stable terminal refusal code.
   * @param now - Canonical current UTC timestamp.
   * @returns Refused state and whether a new record was inserted.
   */
  refuse(state: ComputeTaskState, reason: string, now: string): Promise<{ state: ComputeTaskState; inserted: boolean }> {
    return this.track(async () => {
      const offered = parseTaskState(state)
      if (offered.status !== 'OFFERED' || offered.leaseExpiresAt !== null) throw new ComputeError('COMPUTE_TASK_STATE_INVALID', 409)
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.config.path, async () => {
        const tasks = await this.read()
        const existing = tasks.find(item => taskKey(item) === taskKey(offered))
        if (existing) {
          if (existing.envelopeFingerprint !== offered.envelopeFingerprint || existing.idempotencyKey !== offered.idempotencyKey) {
            throw new ComputeError('COMPUTE_TASK_REPLAY_CONFLICT', 409)
          }
          return { state: existing, inserted: false }
        }
        if (tasks.length >= this.config.maxTasks) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
        const refused = transitionTask(offered, { type: 'refuse', reason }, now)
        await this.write([refused, ...tasks])
        return { state: refused, inserted: true }
      })
    })
  }

  /** Apply one lifecycle event atomically to an existing attempt.
   * @param taskId - Task identity to update.
   * @param attempt - Attempt number to update.
   * @param event - Lifecycle event to apply.
   * @param now - Canonical current UTC timestamp.
   * @returns Updated persisted task state.
   */
  transition(taskId: string, attempt: number, event: ComputeTaskEvent, now: string): Promise<ComputeTaskState> {
    return this.track(async () => {
      await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.config.path, async () => {
        const tasks = await this.read()
        const index = tasks.findIndex(item => item.taskId === taskId && item.attempt === attempt)
        if (index < 0) throw new ComputeError('COMPUTE_TASK_NOT_FOUND', 404)
        const existing = tasks[index]
        if (existing === undefined) throw new ComputeError('COMPUTE_TASK_NOT_FOUND', 404)
        const next = transitionTask(existing, event, now)
        tasks[index] = next
        await this.write(tasks)
        return next
      })
    })
  }

  private async write(tasks: readonly ComputeTaskState[]): Promise<void> {
    const content = JSON.stringify({ version: 1, tasks })
    if (Buffer.byteLength(content) > this.config.maxBytes) throw new ComputeError('COMPUTE_TASK_STORE_CAPACITY', 409)
    try { await writeFileAtomic(this.config.path, content, { mode: 0o600, dirMode: 0o700 }) }
    catch { throw new ComputeError('COMPUTE_TASK_STORE_UNAVAILABLE', 503) }
  }

  /** Stop new operations and drain accepted writes before plugin disposal. */
  async close(): Promise<void> { this.closed = true; await Promise.allSettled(this.pending) }
}

function taskKey(state: ComputeTaskState): string { return `${state.taskId}\u0000${state.attempt}` }

const ACTIVE_STATUSES = new Set<ComputeTaskState['status']>(['ACCEPTED', 'EXECUTING', 'UPLOADING', 'PAUSED', 'OFFLINE'])
