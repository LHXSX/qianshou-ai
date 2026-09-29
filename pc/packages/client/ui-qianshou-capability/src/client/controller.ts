/** Capability reads kept in three separate store fields; the Host owns every number. */
import type { Context } from '@deepseek-ai/cordis'
import type { AvailabilityView, CatalogView, EstimateIntent, EstimateView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One layer per field: a stale availability or estimate is cleared, never carried onto another capability. */
export interface CapabilityViewState {
  catalog: CatalogView | null
  /** Capability the user is inspecting, or null before any selection. */
  selected: string | null
  availability: AvailabilityView | null
  estimate: EstimateView | null
  busy: boolean
  /** The RPC itself failed, which is distinct from a view reporting a named failure. */
  failed: boolean
}

/** Coordinate the three reads and discard answers a newer user action has superseded. */
export class CapabilityController {
  /** Catalog, health and estimate as read, shared with the panel. */
  readonly store = createSnapshotStore<CapabilityViewState>({
    catalog: null, selected: null, availability: null, estimate: null, busy: false, failed: false,
  })

  private catalogRevision = 0
  private selectionRevision = 0

  constructor(private readonly ctx: Context) {}

  /** Read the whole catalog, leaving any selection and its two reads untouched. */
  async loadCatalog(): Promise<void> {
    const revision = ++this.catalogRevision
    this.store.set({ ...this.store.getSnapshot(), busy: true, failed: false })
    try {
      const result = await this.ctx.remote.qianshouCapability.catalog()
      if (revision !== this.catalogRevision) return
      const state = this.store.getSnapshot()
      this.store.set({ ...state, catalog: result.ok ? result.value : state.catalog, busy: false, failed: !result.ok })
    } catch {
      if (revision === this.catalogRevision) this.store.set({ ...this.store.getSnapshot(), busy: false, failed: true })
    }
  }

  /**
   * Select one capability and read the scheduler's counts for it.
   * @param capabilityId - Catalog id the user picked; its estimate is dropped because it belonged to the previous selection.
   */
  async select(capabilityId: string): Promise<void> {
    const revision = ++this.selectionRevision
    this.store.set({ ...this.store.getSnapshot(), selected: capabilityId, availability: null, estimate: null, busy: true, failed: false })
    try {
      const result = await this.ctx.remote.qianshouCapability.availability(capabilityId)
      if (revision !== this.selectionRevision) return
      const state = this.store.getSnapshot()
      this.store.set({ ...state, availability: result.ok ? result.value : null, busy: false, failed: !result.ok })
    } catch {
      if (revision === this.selectionRevision) this.store.set({ ...this.store.getSnapshot(), busy: false, failed: true })
    }
  }

  /**
   * Ask the server what the selected capability would cost. No quote is produced and no funds move.
   * @param intent - Goal plus the local budget cap, which the Host echoes for display rather than posting.
   */
  async runEstimate(intent: EstimateIntent): Promise<void> {
    const capabilityId = this.store.getSnapshot().selected
    if (capabilityId === null) return
    const revision = ++this.selectionRevision
    this.store.set({ ...this.store.getSnapshot(), busy: true, failed: false })
    try {
      const result = await this.ctx.remote.qianshouCapability.estimate(capabilityId, intent)
      if (revision !== this.selectionRevision) return
      const state = this.store.getSnapshot()
      this.store.set({ ...state, estimate: result.ok ? result.value : null, busy: false, failed: !result.ok })
    } catch {
      if (revision === this.selectionRevision) this.store.set({ ...this.store.getSnapshot(), busy: false, failed: true })
    }
  }
}
