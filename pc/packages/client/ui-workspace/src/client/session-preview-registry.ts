/** Lifecycle-owned, bounded Session previews; providers never alter Session history. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSessionPreview, WorkspaceSessionPreviewProvider, WorkspaceSessionPreviewSnapshot } from './session-preview.ts'

const UNAVAILABLE: WorkspaceSessionPreview = Object.freeze({ kind: 'unavailable' })
const MAX_PROVIDER_TEXT_CODE_UNITS = 4096

function text(value: string, limit: number, ellipsis = false): string {
  const normalized = value.replaceAll('\0', '').replace(/\s+/g, ' ').trim()
  const characters = Array.from(normalized)
  return characters.length > limit
    ? `${characters.slice(0, ellipsis ? limit - 1 : limit).join('')}${ellipsis ? '…' : ''}`
    : normalized
}

function equal(left: WorkspaceSessionPreview | undefined, right: WorkspaceSessionPreview | null): boolean {
  if (left === undefined || right === null) return left === undefined && right === null
  if (left.kind !== right.kind) return false
  return left.kind === 'unavailable' || right.kind === 'unavailable'
    || left.title === right.title && left.searchText === right.searchText && left.updatedAt === right.updatedAt
}

interface Registration {
  readonly provider: WorkspaceSessionPreviewProvider
  active: boolean
  stop?: () => void
}

/** Internal owner of the Workspace service's exact-Session preview registrations. */
export class WorkspaceSessionPreviewRegistry {
  private readonly state = createSnapshotStore<WorkspaceSessionPreviewSnapshot>(new Map())
  private readonly providers = new Set<Registration>()
  private known = new Set<SessionId>()
  private disposed = false
  private readonly stopCatalog: () => void
  readonly snapshots: HostObservable<WorkspaceSessionPreviewSnapshot> = {
    getSnapshot: () => this.state.getSnapshot(),
    subscribe: listener => this.state.subscribe(listener),
  }

  /** @param catalog - authoritative identities; unknown Session notifications never enter the snapshot. */
  constructor(private readonly catalog: HostObservable<SessionListState>) {
    this.reconcileCatalog()
    this.stopCatalog = catalog.subscribe(() => { if (!this.disposed) this.reconcileCatalog() })
  }

  /**
   * Register one provider for the caller's effect lifetime.
   * @param provider - synchronous reader and exact-Session invalidation source.
   * @returns idempotent removal of both the subscription and preview contribution.
   */
  register(provider: WorkspaceSessionPreviewProvider): () => void {
    if (this.disposed) throw new Error('Workspace Session previews are disposed')
    const registration: Registration = { provider, active: true }
    this.providers.add(registration)
    try {
      registration.stop = provider.subscribe((sessionId) => {
        if (registration.active && !this.disposed && this.known.has(sessionId)) this.refresh(sessionId)
      })
    } catch (error) {
      registration.active = false
      this.providers.delete(registration)
      this.refreshAll()
      throw error
    }
    if (!registration.active) this.stop(registration)
    else this.refreshAll()
    return () => {
      if (!registration.active) return
      registration.active = false
      this.providers.delete(registration)
      this.stop(registration)
      if (!this.disposed) this.refreshAll()
    }
  }

  /**
   * Read fresh data for a navigation decision without depending on delivered notifications.
   * @param sessionId - exact known Session whose reuse is being considered.
   * @returns bounded known content, unavailable content, or confirmed absence.
   */
  read(sessionId: SessionId): WorkspaceSessionPreview | null {
    if (this.disposed) return null
    const catalog = this.catalog.getSnapshot()
    if (catalog.byId[sessionId] === undefined || !catalog.ids.includes(sessionId)) return null
    let occupied = false
    let unavailable = false
    let title = ''
    let searchText = ''
    let updatedAt: number | undefined
    for (const registration of this.providers) {
      try {
        const preview = registration.provider.read(sessionId)
        if (preview === null) continue
        if (preview.kind === 'unavailable') { unavailable = true; continue }
        if (preview.title.length > MAX_PROVIDER_TEXT_CODE_UNITS
          || (preview.searchText?.length ?? 0) > MAX_PROVIDER_TEXT_CODE_UNITS) {
          unavailable = true
          continue
        }
        occupied = true
        const candidateTitle = text(preview.title, 48, true)
        if (title === '') title = candidateTitle
        searchText = text(`${searchText} ${preview.title} ${preview.searchText ?? ''}`, 512)
        if (preview.updatedAt !== undefined && Number.isFinite(preview.updatedAt) && preview.updatedAt >= 0) {
          updatedAt = Math.max(updatedAt ?? 0, preview.updatedAt)
        }
      } catch (_error) {
        // An unreadable provider cannot turn an occupied Session into a reusable blank.
        unavailable = true
      }
    }
    return occupied
      ? Object.freeze({ kind: 'content', title, searchText, ...(updatedAt === undefined ? {} : { updatedAt }) })
      : unavailable ? UNAVAILABLE : null
  }

  /** Close notifications before removing provider listeners; late callbacks are inert. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopCatalog()
    for (const registration of this.providers) registration.active = false
    for (const registration of this.providers) this.stop(registration)
    this.providers.clear()
    this.known.clear()
    this.state.set(new Map())
  }

  private stop(registration: Registration): void {
    try { registration.stop?.() }
    catch (_error) { /* A provider's cleanup failure must not prevent other providers from leaving. */ }
  }

  private reconcileCatalog(): void {
    const list = this.catalog.getSnapshot()
    const known = new Set(list.ids.filter(id => list.byId[id] !== undefined))
    const previous = this.known
    this.known = known
    const snapshot = this.state.getSnapshot()
    const next = new Map(snapshot)
    for (const id of previous) if (!known.has(id)) next.delete(id)
    for (const id of known) {
      if (previous.has(id)) continue
      const preview = this.read(id)
      if (preview !== null) next.set(id, preview)
    }
    if (next.size !== snapshot.size || [...next].some(([id, preview]) => !equal(snapshot.get(id), preview))) {
      this.state.set(next)
    }
  }

  private refreshAll(): void {
    const snapshot = this.state.getSnapshot()
    const next = new Map<SessionId, WorkspaceSessionPreview>()
    for (const sessionId of this.known) {
      const preview = this.read(sessionId)
      if (preview !== null) next.set(sessionId, preview)
    }
    if (next.size !== snapshot.size || [...next].some(([id, preview]) => !equal(snapshot.get(id), preview))) {
      this.state.set(next)
    }
  }

  private refresh(sessionId: SessionId): void {
    this.publish(sessionId, this.read(sessionId))
  }

  private publish(sessionId: SessionId, preview: WorkspaceSessionPreview | null): void {
    const snapshot = this.state.getSnapshot()
    if (equal(snapshot.get(sessionId), preview)) return
    const next = new Map(snapshot)
    if (preview === null) next.delete(sessionId)
    else next.set(sessionId, preview)
    this.state.set(next)
  }
}
