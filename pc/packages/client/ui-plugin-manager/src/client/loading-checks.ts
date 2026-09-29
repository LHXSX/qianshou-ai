/** Point-in-time Host loading checks owned by the plugin manager's lifetime. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BundleLoadCheck } from '@deepseek-ai/dsh-plugin-manager/types'

/** One package's last explicit check, distinct from live component inventory. */
export type LoadingCheck = { readonly status: 'checking' }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'checked'; readonly result: BundleLoadCheck }

/** Read-only result snapshots indexed by exact package name. */
export type LoadingChecks = Readonly<Record<string, LoadingCheck>>
type CheckAnswer = { readonly ok: true; readonly value: BundleLoadCheck }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** Coalesce one package's explicit checks and discard results after invalidation or disposal. */
export class LoadingCheckController {
  /** Last explicit loading-check result for each local bundle. */
  readonly store = createSnapshotStore<LoadingChecks>({})
  private readonly requests = new Map<string, object>()
  private disposed = false

  /** @param check - The authenticated Host operation returning observed loading only. */
  constructor(private readonly check: (name: string) => Promise<CheckAnswer>) {}

  /** Request a fresh loading observation; an in-flight request for that package is reused.
   * @param name - Exact local bundle name.
   * @returns Settlement after its latest relevant result is published.
   */
  async run(name: string): Promise<void> {
    if (this.disposed || this.requests.has(name)) return
    const request = {}
    this.requests.set(name, request)
    this.store.set({ ...this.store.getSnapshot(), [name]: { status: 'checking' } })
    let answer: CheckAnswer
    try { answer = await this.check(name) }
    catch (error) { answer = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } } }
    if (!this.current(name, request)) return
    this.requests.delete(name)
    this.store.set({ ...this.store.getSnapshot(), [name]: answer.ok
      ? { status: 'checked', result: answer.value } : { status: 'failed', reason: answer.error.message } })
  }

  /** Discard check facts that predate a mutation.
   * @param name - Exact bundle, or all bundles when a component changed.
   */
  invalidate(name?: string): void {
    if (name === undefined) { this.requests.clear(); this.store.set({}); return }
    this.requests.delete(name)
    this.store.set(Object.fromEntries(Object.entries(this.store.getSnapshot()).filter(([key]) => key !== name)))
  }

  private current(name: string, request: object): boolean {
    return !this.disposed && this.requests.get(name) === request
  }

  /** Drop late responses without cancelling other Host work. */
  dispose(): void { this.disposed = true; this.requests.clear() }
}
