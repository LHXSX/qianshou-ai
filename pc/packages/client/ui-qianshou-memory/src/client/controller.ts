/** Owner interaction state; the Host owns documents and all authorization decisions. */
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryDetail, MemoryEntry, MemoryExportPage, MemoryFailureCode, MemoryInput, MemoryPage, MemoryQuery, MemoryState } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** A draft belongs to the current selection and survives a revision conflict. */
export interface MemoryView {
  metadata: MemoryState | null
  page: MemoryPage | null
  query: MemoryQuery
  detail: MemoryDetail | null
  draft: MemoryInput | null
  loading: boolean
  reading: boolean
  busy: boolean
  exporting: boolean
  error: MemoryFailureCode | 'connection-failed' | 'export-too-large' | null
}
function draftOf(entry: MemoryEntry): MemoryInput {
  return { id: entry.id, expectedRevision: entry.revision, title: entry.title, content: entry.content, kind: entry.kind, scope: entry.scope,
    ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}), source: entry.source, evidence: entry.evidence,
    ...(entry.expiresAt === null ? {} : { expiresInDays: Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 86400000)) }) }
}
function unwrap<T>(response: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}
function failure(error: unknown): MemoryView['error'] {
  const message = error instanceof Error ? error.message : ''
  const codes: MemoryFailureCode[] = ['invalid-request', 'not-found', 'conflict', 'workspace-required', 'candidate-readonly', 'evidence-required', 'capacity', 'closed', 'storage-failed', 'export-changed', 'proposal-removed']
  if (message === 'export-too-large') return 'export-too-large'
  return codes.find(code => message.includes(`QIANSHOU_MEMORY_${code}`)) ?? 'connection-failed'
}
/** Coordinate independent list, selection and mutation lifetimes without replacing newer drafts. */
export class MemoryController {
  /** Shared owner viewing state and unsaved draft, separate from authoritative Host documents. */
  readonly store = createSnapshotStore<MemoryView>({ metadata: null,
    page: null,
    query: { limit: 50 },
    detail: null,
    draft: null,
    loading: false,
    reading: false,
    busy: false,
    exporting: false,
    error: null })
  private listGeneration = 0
  private selectionGeneration = 0
  private historyGeneration = 0
  private lifetime = 0
  private disposed = false
  private draftEpoch = 0
  private mountEpoch = 0
  constructor(private readonly ctx: Context) {}
  /** Current draft interaction identity for asynchronous file imports. */
  get draftGeneration(): number { return this.draftEpoch }
  /**
   * Attach one main-page lifetime; detaching invalidates pending reads, mutations and exports.
   * @returns View disposer.
   */
  attach(): () => void {
    const epoch = ++this.mountEpoch
    return () => {
      if (epoch !== this.mountEpoch) return
      this.lifetime++; this.listGeneration++; this.selectionGeneration++; this.draftEpoch++
      this.patch({ loading: false, reading: false, busy: false, exporting: false })
    }
  }
  private patch(value: Partial<MemoryView>): void { if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), ...value }) }
  /** End pending UI response ownership; committed Host operations are not represented as rolled back. */
  dispose(): void { this.disposed = true; this.lifetime++; this.listGeneration++; this.selectionGeneration++ }
  /** Reload after transport reset, preserving the current unsaved draft. */
  reconnect(): void { this.lifetime++
    this.selectionGeneration++
    this.patch({ busy: false, exporting: false, reading: false })
    void this.load() }
  /** Read current metadata and filters. */
  async load(): Promise<void> {
    const generation = ++this.listGeneration; const lifetime = this.lifetime
    this.patch({ loading: true, error: null })
    try {
      const [metadata,
        page] = await Promise.all([this.ctx.remote.qianshouMemory.state(),
        this.ctx.remote.qianshouMemory.list(this.store.getSnapshot().query)])
      if (generation !== this.listGeneration || lifetime !== this.lifetime) return
      this.patch({ metadata: unwrap(metadata), page: unwrap(page), loading: false })
    } catch (error) { if (generation === this.listGeneration && lifetime === this.lifetime) this.patch({ error: failure(error),
      loading: false }) }
  }
  /**
   * Change owner filters; outstanding detail reads cannot populate another scope.
   * @param query - Explicit filters.
   */
  filter(query: MemoryQuery): void {
    this.selectionGeneration++; this.draftEpoch++
    this.patch({ query, detail: null, draft: null, reading: false }); void this.load()
  }
  /**
   * Read one selected original.
   * @param id - Host-provided record id.
   */
  async select(id: MemoryEntry['id']): Promise<void> {
    const generation = ++this.selectionGeneration; const lifetime = this.lifetime; this.draftEpoch++
    this.patch({ reading: true, detail: null, draft: null, error: null })
    try {
      const detail = unwrap(await this.ctx.remote.qianshouMemory.read(id))
      if (generation === this.selectionGeneration && lifetime === this.lifetime) this.patch({ detail,
        draft: draftOf(detail.entry),
        reading: false })
    } catch (error) { if (generation === this.selectionGeneration && lifetime === this.lifetime) this.patch({ error: failure(error),
      reading: false }) }
  }
  /** Read another bounded history page without replacing the unsaved draft. */
  async moreHistory(): Promise<void> {
    const detail = this.store.getSnapshot().detail
    if (!detail || detail.nextRevisionOffset === null) return
    const generation = this.selectionGeneration; const lifetime = this.lifetime; const history = ++this.historyGeneration
    try {
      const page = unwrap(await this.ctx.remote.qianshouMemory.history({ id: detail.entry.id,
        expectedRevision: detail.entry.revision },
      detail.nextRevisionOffset))
      if (generation !== this.selectionGeneration || lifetime !== this.lifetime || history !== this.historyGeneration) return
      this.patch({ detail: { ...detail,
        revisions: [...detail.revisions,
          ...page.revisions],
        nextRevisionOffset: page.nextOffset,
        revisionCount: page.total } })
    } catch (error) { if (generation === this.selectionGeneration && lifetime === this.lifetime) this.patch({ error: failure(error) }) }
  }
  /** Create a local unsaved draft under the selected owner destination. */
  create(): void {
    this.selectionGeneration++; this.draftEpoch++
    const query = this.store.getSnapshot().query
    this.patch({ detail: null, reading: false, error: null, draft: { title: '', content: '', kind: 'knowledge', scope: query.workspaceId ? 'workspace' : 'device', ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}) } })
  }
  /**
   * Preserve form edits separately from Host documents.
   * @param draft - Current owner draft.
   */
  edit(draft: MemoryInput): void { this.draftEpoch++; this.patch({ draft }) }
  private async mutate(operation: () => Promise<MemoryEntry | { deleted: true }>): Promise<void> {
    if (this.store.getSnapshot().busy) return
    const selection = this.selectionGeneration; const lifetime = this.lifetime
    this.patch({ busy: true, error: null })
    try {
      const entry = await operation()
      if (lifetime !== this.lifetime) return
      this.patch({ busy: false })
      if (selection === this.selectionGeneration) {
        if ('deleted' in entry) { this.selectionGeneration++; this.patch({ detail: null, draft: null }) }
        else await this.select(entry.id)
      }
      await this.load()
    } catch (error) { if (lifetime === this.lifetime) this.patch({ busy: false, error: failure(error) }) }
  }
  /** Commit exactly the current draft with its expected revision. */
  async save(): Promise<void> {
    const draft = this.store.getSnapshot().draft
    if (draft) await this.mutate(async () => unwrap(await this.ctx.remote.qianshouMemory.save(draft)))
  }
  /**
   * Submit a human candidate decision.
   * @param action - Accept or erase candidate.
   */
  async review(action: 'accept' | 'reject'): Promise<void> {
    const entry = this.store.getSnapshot().detail?.entry
    if (entry) await this.mutate(async () => unwrap(await this.ctx.remote.qianshouMemory.review({ id: entry.id,
      expectedRevision: entry.revision,
      action })))
  }
  /** Erase the selected unchanged entry after the page's explicit confirmation. */
  async delete(): Promise<void> {
    const entry = this.store.getSnapshot().detail?.entry
    if (entry) await this.mutate(async () => unwrap(await this.ctx.remote.qianshouMemory.delete({ id: entry.id,
      expectedRevision: entry.revision })))
  }
  /**
   * Collect a consistent paged export; failure never returns a partial file.
   * @returns Complete JSON or null after cancellation/failure.
   */
  async export(): Promise<string | null> {
    if (this.store.getSnapshot().exporting) return null
    const lifetime = this.lifetime; this.patch({ exporting: true, error: null })
    try {
      let page = unwrap(await this.ctx.remote.qianshouMemory.exportPage({}))
      const identity = { format: page.format, ownerKind: page.ownerKind, vaultId: page.vaultId, revision: page.revision }
      let bytes = 0
      const entries: MemoryExportPage['entries'] = []; const revisions: MemoryExportPage['revisions'] = []; const receipts: MemoryExportPage['receipts'] = []
      while (true) {
        if (lifetime !== this.lifetime) return null
        bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength
        if (bytes > 16 * 1024 * 1024) throw new Error('export-too-large')
        entries.push(...page.entries); revisions.push(...page.revisions); receipts.push(...page.receipts)
        if (!page.next) break
        page = unwrap(await this.ctx.remote.qianshouMemory.exportPage({ revision: identity.revision, ...page.next }))
      }
      this.patch({ exporting: false })
      return JSON.stringify({ ...identity, exportedAt: Date.now(), entries, revisions, receipts })
    } catch (error) { if (lifetime === this.lifetime) this.patch({ exporting: false, error: failure(error) }); return null }
  }
}
