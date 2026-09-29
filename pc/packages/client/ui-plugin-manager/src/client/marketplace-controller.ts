/** Owner-driven market state. The first read waits until the owner opens the market. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One row the page can render without importing the host package. */
export interface MarketListingView {
  id: string
  title: string
  summary: string
  capabilityId: string
  version: string
  installable: boolean
  /** Empty for a built-in capability declaration without a downloadable plugin package. */
  packageSpec?: string
  requirements?: {
    signature: { kind: 'catalog-digest' | 'publisher', publisher: string, value: string } | null
    packages: { name: string, minimumVersion: string }[]
    model: string
    minFreeDiskBytes: number
    minTotalMemoryBytes: number
    platforms?: ('darwin' | 'win32' | 'linux')[]
    architectures?: ('arm64' | 'x64' | 'ia32' | 'arm')[]
  }
}

/** A Host-saved market declaration. Its id alone cannot prove the current listing is installed. */
export interface MarketInstalledRecordView {
  id: string
  version: string
  capabilityId: string
}

/** One ordered install check as the panel shows it. */
export interface PreflightStepView {
  id: string
  state: 'passed' | 'failed' | 'not-checked'
  /** Stable reason code, empty when the step passed. */
  reason: string
  /** Observed facts the host reported, empty when the step passed. */
  detail: string
}

/** A preflight the host ran for one listing, with the recovery choices it offered. */
export interface PreflightReportView {
  listingId: string
  steps: PreflightStepView[]
  verdict: 'passed' | 'failed'
  failedStep: string | null
  actions: string[]
  compatibility?: {
    platform: { state: 'matched' | 'mismatched' | 'not-declared' | 'not-checked', observed: string, required: readonly string[] | null }
    architecture: { state: 'matched' | 'mismatched' | 'not-declared' | 'not-checked', observed: string, required: readonly string[] | null }
    gpuMemory: { state: 'not-probed' }
  }
}

/** What a repair, recheck or rollback just did, shown once. */
export type MarketplaceNotice =
  | 'repairRepaired'
  | 'repairUnchanged'
  | 'repairUnavailable'
  | 'rollbackRestored'
  | 'rollbackNothing'

/** The open market page. `mode` stays null until the first read finishes. */
export interface MarketplaceView {
  mode: 'shipped' | 'api' | null
  source: string
  listings: MarketListingView[]
  installedRecords: readonly MarketInstalledRecordView[]
  loading: boolean
  busyId: string | null
  /** Listing whose preflight, repair, recheck or rollback is in flight. */
  workingId: string | null
  error: 'unavailable' | 'notAdvertisable' | 'unknown' | 'installFailed' | 'activationPending' | 'preflightFailed' | null
  /** The last preflight the owner is looking at, whether it passed or failed. */
  report: PreflightReportView | null
  notice: MarketplaceNotice | null
}

type RemoteValue<T> = { ok: true, value: T } | { ok: false, error: { message: string } }

interface MarketRemote {
  listings(): Promise<RemoteValue<{ mode: 'shipped' | 'api', source: string, listings: MarketListingView[] }>>
  installed(): Promise<RemoteValue<{ records: MarketInstalledRecordView[] }>>
  installListing(request: { id: string }): Promise<RemoteValue<{ id: string }>>
  preflight(request: { id: string }): Promise<RemoteValue<PreflightReportView>>
  repairListing(request: { id: string }): Promise<RemoteValue<{
    listingId: string
    step: string | null
    outcome: 'repaired' | 'unchanged' | 'unavailable'
    detail: string
    report: PreflightReportView
  }>>
  rollbackListing(request: { id: string }): Promise<RemoteValue<{
    listingId: string
    restored: boolean
    reverted: string[]
    detail: string
  }>>
}

/**
 * Market calls for the PC client. Mac and Windows both use these methods.
 * @param ctx - Browser plugin context.
 * @returns The host market remote.
 */
function marketRemote(ctx: Context): MarketRemote {
  return (ctx.remote as unknown as { qianshouPluginCatalog: MarketRemote }).qianshouPluginCatalog
}

const NOTICES: Record<'repaired' | 'unchanged' | 'unavailable', MarketplaceNotice> = {
  repaired: 'repairRepaired',
  unchanged: 'repairUnchanged',
  unavailable: 'repairUnavailable',
}

/** Read-only request generations prevent a late load from replacing a newer one. */
export class MarketplaceController {
  /** Current market page. */
  readonly store = createSnapshotStore<MarketplaceView>({
    mode: null, source: '', listings: [], installedRecords: [], loading: false, busyId: null, workingId: null,
    error: null, report: null, notice: null,
  })
  private generation = 0
  private disposed = false
  private started = false
  constructor(private readonly ctx: Context) {}
  private patch(value: Partial<MarketplaceView>): void {
    if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), ...value })
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation }
  /** Invalidate late responses when the browser plugin unloads. */
  dispose(): void { this.disposed = true; this.generation++ }
  /** Load the market once, when the owner opens it. */
  ensure(): void { if (!this.disposed && !this.started) { this.started = true; void this.reload() } }
  /**
   * Read listings and saved declarations again.
   * @returns When the latest request settles.
   */
  async reload(): Promise<void> {
    await this.read(null)
  }
  private async read(notice: MarketplaceNotice | null): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.patch({ loading: true, error: null, report: null, notice })
    try {
      const remote = marketRemote(this.ctx)
      const listed = await remote.listings()
      if (!this.current(generation)) return
      if (!listed.ok) throw new Error(listed.error.message)
      const saved = await remote.installed()
      if (!this.current(generation)) return
      if (!saved.ok) throw new Error(saved.error.message)
      this.patch({
        loading: false,
        mode: listed.value.mode,
        source: listed.value.source,
        listings: listed.value.listings,
        installedRecords: saved.value.records,
      })
    } catch (error) {
      if (!this.current(generation)) return
      this.patch({ loading: false, error: marketError(error) })
    }
  }
  /**
   * Get one plugin: the host checks it first, then downloads, installs and registers it.
   * A failed check shows the failing step and offers fix, recheck, cancel and rollback.
   * @param id - Market listing id.
   * @returns When the check and any following install settle.
   */
  async install(id: string): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.patch({ busyId: id, error: null, notice: null })
    try {
      const remote = marketRemote(this.ctx)
      const checked = await remote.preflight({ id })
      if (!this.current(generation)) return
      if (!checked.ok) throw new Error(checked.error.message)
      if (checked.value.verdict !== 'passed') {
        this.patch({ busyId: null, error: 'preflightFailed', report: checked.value })
        return
      }
      const result = await remote.installListing({ id })
      if (!this.current(generation)) return
      if (!result.ok) throw new Error(result.error.message)
      const listed = await remote.listings()
      const saved = await remote.installed()
      if (!this.current(generation)) return
      if (!listed.ok) throw new Error(listed.error.message)
      if (!saved.ok) throw new Error(saved.error.message)
      this.patch({
        loading: false,
        busyId: null,
        mode: listed.value.mode,
        source: listed.value.source,
        listings: listed.value.listings,
        installedRecords: saved.value.records,
        report: checked.value,
      })
    } catch (error) {
      if (!this.current(generation)) return
      this.patch({ busyId: null, error: marketError(error) })
    }
  }
  /**
   * Check this computer for one listing without installing anything.
   * @param id - Market listing id.
   * @returns When the check settles.
   */
  async inspect(id: string): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.patch({ workingId: id, error: null, report: null, notice: null })
    try {
      const checked = await marketRemote(this.ctx).preflight({ id })
      if (!this.current(generation)) return
      if (!checked.ok) throw new Error(checked.error.message)
      this.patch({
        workingId: null,
        error: checked.value.verdict === 'passed' ? null : 'preflightFailed',
        report: checked.value,
      })
    } catch (error) {
      if (this.current(generation)) this.patch({ workingId: null, error: marketError(error) })
    }
  }
  /** Re-run the same read-only check after a repair or a device change. */
  async recheck(id: string): Promise<void> { await this.inspect(id) }
  /**
   * Attempt the host's repair for the failing step, then show the checks again.
   * @param id - Market listing id.
   * @returns When the repair settles.
   */
  async repair(id: string): Promise<void> {
    await this.runRecovery(id, async (remote) => {
      const repaired = await remote.repairListing({ id })
      if (!repaired.ok) throw new Error(repaired.error.message)
      this.patch({
        error: repaired.value.report.verdict === 'passed' ? null : 'preflightFailed',
        report: repaired.value.report,
        notice: NOTICES[repaired.value.outcome],
      })
    })
  }
  /**
   * Return this computer to its pre-install state and read the market again.
   * @param id - Market listing id.
   * @returns When the rollback and the following read settle.
   */
  async rollback(id: string): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.patch({ workingId: id, notice: null })
    let notice: MarketplaceNotice = 'rollbackNothing'
    try {
      const rolled = await marketRemote(this.ctx).rollbackListing({ id })
      if (!this.current(generation)) return
      if (!rolled.ok) throw new Error(rolled.error.message)
      notice = rolled.value.restored ? 'rollbackRestored' : 'rollbackNothing'
      this.patch({ error: null, report: null, workingId: null })
    } catch (error) {
      if (!this.current(generation)) return
      this.patch({ workingId: null, error: marketError(error) })
      return
    }
    await this.read(notice)
  }
  /** Drop the failed report without changing this computer, keeping the listing row visible. */
  dismiss(): void {
    if (this.disposed) return
    this.generation++
    this.patch({ error: null, report: null, notice: null, busyId: null, workingId: null })
  }
  private async runRecovery(id: string, run: (remote: MarketRemote) => Promise<void>): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.patch({ workingId: id, notice: null })
    try {
      await run(marketRemote(this.ctx))
    } catch (error) {
      if (!this.current(generation)) return
      this.patch({ error: marketError(error) })
    } finally {
      if (this.current(generation)) this.patch({ workingId: null })
    }
  }
}

function marketError(error: unknown): MarketplaceView['error'] {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('not-advertisable')) return 'notAdvertisable'
  if (message.includes('unknown-listing')) return 'unknown'
  if (message.includes('activation-pending')) return 'activationPending'
  if (message.includes('install-failed') || message.includes('installer-unavailable')) return 'installFailed'
  if (message.includes('preflight-failed')) return 'preflightFailed'
  return 'unavailable'
}
