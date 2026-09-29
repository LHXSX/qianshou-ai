import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MemoryDirectory, MemoryDraft, MemoryEntry, MemoryFilters, MemoryStats } from './contracts.ts'

/** Observable directory and selected source; edits remain local to the page. */
export interface MemoryState extends MemoryDirectory {
  filters: MemoryFilters
  loading: boolean
  detailLoading: boolean
  busy: boolean
  error: string | null
  selected: MemoryEntry | null
  revisions: MemoryEntry[]
}
const emptyStats: MemoryStats = { temporary: 0, permanent: 0, knowledge: 0, experience: 0, candidates: 0 }

/** Own authenticated requests and discard stale directory/detail responses. */
export class MemoryController {
  /** Current records and operation state. */
  readonly store = createSnapshotStore<MemoryState>({
    items: [], total: 0, stats: emptyStats, storage: 'sqlite', search: 'keyword',
    filters: { query: '', kind: '', status: 'active', workspace: '', offset: 0 },
    loading: true, detailLoading: false, busy: false, error: null, selected: null, revisions: [],
  })
  private readonly abort = new AbortController()
  private listGeneration = 0
  private detailGeneration = 0
  constructor(private readonly transport: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  private closed(): boolean { return this.abort.signal.aborted }

  private async request<T>(suffix: string, body?: unknown): Promise<T> {
    const response = await this.transport('/api/qianshou/memory' + suffix, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: this.abort.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const data: unknown = await response.json()
    if (!response.ok) throw new Error(typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `HTTP_${response.status}`)
    return data as T
  }

  /** Read one directory page using its current filters. */
  async refresh(): Promise<void> {
    if (this.closed()) return
    const generation = ++this.listGeneration
    const filters = this.store.getSnapshot().filters
    const query = new URLSearchParams({ ...filters, offset: String(filters.offset), limit: '50' })
    this.store.update((state) => { state.loading = true; state.error = null })
    try {
      const result = await this.request<MemoryDirectory>('?' + query.toString())
      if (generation !== this.listGeneration || this.closed()) return
      if (!Array.isArray(result.items) || !Number.isFinite(result.total)) throw new Error('INVALID_MEMORY_RESPONSE')
      this.store.update((state) => {
        state.items = result.items; state.total = result.total; state.stats = result.stats
        state.loading = false; state.storage = result.storage; state.search = result.search
      })
    } catch (error) {
      if (generation === this.listGeneration && !this.closed()) this.store.update((state) => {
        state.loading = false; state.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Replace filters and return to the first page unless an offset is explicit. */
  filter(change: Partial<MemoryFilters>): void {
    this.store.update((state) => { state.filters = { ...state.filters, offset: 0, ...change } })
    void this.refresh()
  }

  /** Load exact source and prior snapshots; null clears the selected record. */
  async select(id: string | null): Promise<void> {
    if (this.closed()) return
    const generation = ++this.detailGeneration
    this.store.update((state) => { state.selected = null; state.revisions = []; state.detailLoading = id !== null; state.error = null })
    if (id === null) return
    try {
      const query = new URLSearchParams({ id }).toString()
      const result = await this.request<{ entry: MemoryEntry; revisions: MemoryEntry[] }>('/entry?' + query)
      if (generation === this.detailGeneration && !this.closed()) this.store.update((state) => {
        state.selected = result.entry; state.revisions = result.revisions; state.detailLoading = false
      })
    } catch (error) {
      if (generation === this.detailGeneration && !this.closed()) this.store.update((state) => {
        state.detailLoading = false; state.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Save one draft or explicitly review/delete one versioned record. */
  async mutate(action: 'save' | 'review' | 'delete', body: MemoryDraft | {
    id: string
    expectedRevision: number
    action?: 'accept' | 'reject'
  }): Promise<boolean> {
    if (this.store.getSnapshot().busy || this.closed()) return false
    this.store.update((state) => { state.busy = true; state.error = null })
    try {
      await this.request('/' + action, body)
      if (this.closed()) return false
      await this.refresh()
      if (action === 'save' && body.id) await this.select(body.id)
      else await this.select(null)
      return true
    } catch (error) {
      if (!this.closed()) this.store.update((state) => {
        state.error = error instanceof Error ? error.message : String(error)
      })
      return false
    } finally {
      if (!this.closed()) this.store.update((state) => { state.busy = false })
    }
  }

  /** Fetch the Host's export without exposing its authentication details. */
  async exportData(): Promise<string | null> {
    try { return JSON.stringify(await this.request('/export'), null, 2) }
    catch (error) {
      if (!this.closed()) this.store.update((state) => { state.error = error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** Cancel this plugin's pending requests when it leaves the composition. */
  dispose(): void { this.abort.abort(); this.listGeneration += 1; this.detailGeneration += 1 }
}
