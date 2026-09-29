/**
 * Owner-authenticated supply projection and policy commits.
 *
 * One route pair only: `GET /api/qianshou/compute/supply` and
 * `POST /api/qianshou/compute/supply/policy`. No execution, dispatch, quote or
 * settlement route exists here, and no amount is ever computed locally.
 *
 * A failed observation never silently keeps looking current: the last snapshot
 * is kept for its timestamped facts, but `stale` marks it as the previous
 * success so the page can say so beside the error.
 *
 * @module @deepseek-ai/dsh-client-ui-supply/client/controller
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SupplyPolicy, SupplySnapshot } from '@deepseek-ai/dsh-compute-core/supply'
import { hostError, INVALID_SUPPLY_RESPONSE, parseSupplySnapshot } from './wire.ts'

/** Last published supply observation and the finite policy-commit state. */
export interface SupplyState {
  /** Latest successfully parsed snapshot, or null before any successful observation. */
  snapshot: SupplySnapshot | null
  /** True when the latest attempt failed and `snapshot` is the previous success. */
  stale: boolean
  loading: boolean
  saving: boolean
  error: { code: string; message: string } | null
}

const INITIAL: SupplyState = { snapshot: null, stale: false, loading: true, saving: false, error: null }

/** Own the authenticated supply projection for one plugin lifetime. */
export class SupplyController {
  /** Snapshot bound by the slot renderer; no browser-side credential is kept. */
  readonly store = createSnapshotStore<SupplyState>({ ...INITIAL })
  private readonly abort = new AbortController()
  /** True while one observation is in flight; the projection is never read twice at once. */
  private refreshPending = false
  /**
   * Bind the Host fetch boundary.
   * @param transport - Fetch implementation; injectable so tests drive real `Response` objects.
   */
  constructor(private readonly transport: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  private async request(policy?: SupplyPolicy): Promise<unknown> {
    const response = await this.transport(policy === undefined ? '/api/qianshou/compute/supply' : '/api/qianshou/compute/supply/policy', {
      method: policy === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: this.abort.signal,
      ...(policy === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) }),
    })
    let data: unknown
    try { data = await response.json() }
    catch { throw response.ok ? new Error(INVALID_SUPPLY_RESPONSE) : hostError(null, response.status) }
    if (!response.ok) throw hostError(data, response.status)
    return data
  }

  private publishError(error: unknown): void {
    if (this.abort.signal.aborted) return
    this.store.update((state) => {
      state.error = error instanceof Error
        ? { code: error.message === INVALID_SUPPLY_RESPONSE ? INVALID_SUPPLY_RESPONSE : error.name, message: error.message }
        : { code: 'REQUEST_FAILED', message: 'REQUEST_FAILED' }
      state.stale = true
    })
  }

  private isAborted(): boolean { return this.abort.signal.aborted }

  /**
   * Observe the machine once and publish the complete result atomically.
   * @returns Nothing; the outcome is published on {@link store}.
   */
  async refresh(): Promise<void> {
    if (this.refreshPending || this.isAborted() || this.store.getSnapshot().saving) return
    this.refreshPending = true
    this.store.update((state) => { state.loading = true; state.error = null })
    try {
      const next = parseSupplySnapshot(await this.request())
      if (this.isAborted()) return
      this.store.update((state) => { state.snapshot = next; state.stale = false; state.loading = false })
    } catch (error) {
      if (!this.isAborted()) {
        this.store.update((state) => { state.loading = false })
        this.publishError(error)
      }
    } finally { this.refreshPending = false }
  }

  /**
   * Persist a complete owner policy, then publish the Host's fresh observation.
   * @param policy - Complete policy (the form echoes the fields this page does not edit).
   * @returns True only when the Host accepted and returned a fresh snapshot.
   */
  async savePolicy(policy: SupplyPolicy): Promise<boolean> {
    const current = this.store.getSnapshot()
    if (current.saving || current.loading || current.snapshot === null || this.isAborted()) return false
    this.store.update((state) => { state.saving = true; state.error = null })
    try {
      const next = parseSupplySnapshot(await this.request(policy))
      if (this.isAborted()) return false
      this.store.update((state) => { state.snapshot = next; state.stale = false })
      return true
    } catch (error) { this.publishError(error); return false }
    finally { if (!this.isAborted()) this.store.update((state) => { state.saving = false }) }
  }

  /** Abort in-flight requests and suppress late responses when the plugin leaves. */
  dispose(): void { this.abort.abort() }
}
