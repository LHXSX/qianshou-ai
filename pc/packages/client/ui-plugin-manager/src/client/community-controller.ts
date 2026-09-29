/** Public registry discovery is metadata only; installation stays with PluginManager. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface CommunityEntry {
  name: string
  version: string
  description: string
  publisher: string | null
  license: string | null
  packageUrl: string
  installSpec: string
}

export interface CommunityView {
  status: 'idle' | 'loading' | 'ready' | 'error'
  query: string
  source: string
  entries: readonly CommunityEntry[]
  nextOffset: number | null
  excluded: number
  unavailable: number
  checkedAt: number | null
  loadingMore: boolean
  pageError: boolean
}

type RemoteValue<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
interface CommunityRemote {
  search(request: { query: string; offset: number }): Promise<RemoteValue<{
    source: string
    query: string
    nextOffset: number | null
    checkedAt: number
    excluded: number
    unavailable: number
    entries: CommunityEntry[]
  }>>
}

/** Explicit searches only; a stale or slower response cannot replace newer results. */
export class CommunityController {
  readonly store = createSnapshotStore<CommunityView>({
    status: 'idle', query: '', source: '', entries: [], nextOffset: null,
    excluded: 0, unavailable: 0, checkedAt: null, loadingMore: false, pageError: false,
  })
  private generation = 0
  private disposed = false
  constructor(private readonly ctx: Context) {}

  dispose(): void { this.disposed = true; this.generation += 1 }

  /** Search the deployment-selected public registry after a direct user action. */
  async search(query: string): Promise<void> {
    if (this.disposed) return
    const term = query.trim()
    const generation = ++this.generation
    this.store.set({ status: 'loading', query: term, source: '', entries: [], nextOffset: null,
      excluded: 0, unavailable: 0, checkedAt: null, loadingMore: false, pageError: false })
    await this.read(term, 0, generation)
  }

  /** Append the next bounded registry page, if the last response offered one. */
  async loadMore(): Promise<void> {
    if (this.disposed) return
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.loadingMore || current.nextOffset === null) return
    const generation = ++this.generation
    this.store.set({ ...current, loadingMore: true, pageError: false })
    await this.read(current.query, current.nextOffset, generation)
  }

  private async read(query: string, offset: number, generation: number): Promise<void> {
    try {
      const remote = (this.ctx.remote as unknown as { qianshouPluginCatalog: CommunityRemote }).qianshouPluginCatalog
      const result = await remote.search({ query, offset })
      if (this.disposed || generation !== this.generation) return
      if (!result.ok) throw new Error(result.error.message)
      const previous = this.store.getSnapshot()
      const entries = offset === 0 ? result.value.entries : [...previous.entries, ...result.value.entries]
      this.store.set({ status: 'ready', query, source: result.value.source, entries,
        nextOffset: result.value.nextOffset, excluded: previous.excluded + result.value.excluded,
        unavailable: previous.unavailable + result.value.unavailable,
        checkedAt: result.value.checkedAt, loadingMore: false, pageError: false })
    } catch {
      if (this.disposed || generation !== this.generation) return
      const previous = this.store.getSnapshot()
      this.store.set({ ...previous, status: offset === 0 ? 'error' : 'ready', loadingMore: false,
        pageError: offset !== 0,
        nextOffset: offset === 0 ? null : previous.nextOffset })
    }
  }
}
