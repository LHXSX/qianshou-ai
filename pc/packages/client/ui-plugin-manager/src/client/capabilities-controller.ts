/** Owner-driven 我的能力 state: the installed declarations and the four-step publish wizard. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { capabilityErrorKeys, type CapabilityKey } from './capability-locales.ts'
import type { PreflightReportView } from './marketplace-controller.ts'

/** Who may see one declared capability. Only `public` reaches the node hello. */
export type CapabilityVisibility = 'draft' | 'private' | 'invite' | 'public'

/** Why this computer has no number for one measurement. */
export type CapabilityMetricReason = 'no-local-sample' | 'not-probed'

/** One number the page shows: what this computer measured, or why it has none. `unknown` is never zero. */
export type CapabilityMetric =
  | { readonly state: 'measured'; readonly value: number }
  | { readonly state: 'unknown'; readonly reason: CapabilityMetricReason }

/** One step of the publish wizard, in the order the host offers them. */
export type CapabilityWizardStep = 'identity' | 'run-preflight' | 'order-policy' | 'publish'

/** Write in flight on the page, or null. */
export type CapabilityBusy = 'save' | 'publish' | 'preflight' | 'supply' | null

/** One saved declaration, as the page renders it. */
export interface MarketRecordView {
  readonly id: string
  readonly capabilityId: string
  readonly version: string
  readonly installedAt: string
  readonly visibility: CapabilityVisibility
  readonly inviteAccountIds: string[]
}

/** The three published numbers of one capability. None of them falls back to a value. */
export interface CapabilityMetricsView {
  readonly successRate: CapabilityMetric
  readonly p95LatencyMs: CapabilityMetric
  readonly vramBytes: CapabilityMetric
}

/** One installed capability: its declaration, the numbers, and whether this computer can accept it. */
export interface MyCapability {
  readonly record: MarketRecordView
  /** Title the host supplies; a known id is translated by the page instead. */
  readonly title: string
  /** One-liner the host supplies; a known id is translated by the page instead. */
  readonly summary: string
  /** False when this computer cannot accept the capability at all; publishing is refused. */
  readonly advertisable: boolean
  /** Current Host observation; omitted by an older Host and therefore unknown. */
  readonly activity?: 'active' | 'inactive' | 'unknown'
  readonly metrics: CapabilityMetricsView
  readonly freeDiskBytes: number
  readonly totalMemoryBytes: number
}

/** A currently attested private runtime, separate from saved market declarations. */
export interface PrivateLocalCapabilityView {
  readonly kind: 'reviewed-private-mac-video'
  readonly packageName: 'qianshou-mac-drawn-video'
  readonly packageVersion: '0.1.0'
  readonly capabilityId: 'video.drawn-mac-5s'
  readonly capabilityVersion: '0.1.0'
  readonly pluginDigest: string
  readonly scope: 'private-local-trial'
  readonly dispatchable: false
}

/** This computer's saved order policy, or null when no compute service is loaded here. */
export interface CapabilityOrderView {
  readonly mode: 'off' | 'idle' | 'allowed'
  readonly maxConcurrency: number
  /** Saved owner-enabled IDs, not the number of verified or currently accepting executors. */
  readonly enabledServiceCount?: number
}

/** The sentence the page shows once after a write. */
export type CapabilityNotice =
  | { readonly kind: 'draftSaved' }
  | { readonly kind: 'published'; readonly visibility: CapabilityVisibility }
  | { readonly kind: 'supplySaved'; readonly enabled: boolean }

/** The open 我的能力 page. `loaded` stays false until the first read succeeds. */
export interface CapabilitiesView {
  loaded: boolean
  capabilities: MyCapability[]
  privateLocalCapabilities?: PrivateLocalCapabilityView[]
  wizardSteps: CapabilityWizardStep[]
  order: CapabilityOrderView | null
  loading: boolean
  busy: CapabilityBusy
  error: CapabilityKey | null
  notice: CapabilityNotice | null
  /** Capability whose wizard is open, or null. */
  selectedId: string | null
  /** Step the wizard highlights, or null while no wizard is open. */
  step: CapabilityWizardStep | null
  /** Visibility the owner is about to publish with. */
  visibility: CapabilityVisibility
  /** Whether the owner confirmed a public publish. */
  confirmed: boolean
  /** What the invite field holds, one account id per line. Stored on this computer only. */
  inviteText: string
  /** Report of the last run checks, or null. */
  report: PreflightReportView | null
}

// Same result shape as `marketplace-controller.ts`, written with the member
// delimiters `@stylistic/member-delimiter-style` requires of a single-line type literal.
type RemoteValue<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

/** What one read of 我的能力 returns: the installed declarations, the wizard steps, and the order policy. */
export interface CapabilitiesRead {
  capabilities: MyCapability[]
  /** Older Host builds omit this field; the client then shows no attested private runtimes. */
  privateLocalCapabilities?: PrivateLocalCapabilityView[]
  wizardSteps: CapabilityWizardStep[]
  order: CapabilityOrderView | null
}

interface CapabilityRemote {
  myCapabilities(): Promise<RemoteValue<CapabilitiesRead>>
  setOwnerSupplyEnabled(request: { enabled: boolean }): Promise<RemoteValue<CapabilityOrderView>>
  preflight(request: { id: string }): Promise<RemoteValue<PreflightReportView>>
  saveCapabilityDraft(request: { id: string; inviteAccountIds: string[] }): Promise<RemoteValue<MarketRecordView>>
  publishCapability(request: {
    id: string
    visibility: CapabilityVisibility
    confirmPublic: boolean
  }): Promise<RemoteValue<MarketRecordView>>
}

/**
 * 我的能力 calls for the PC client. Mac and Windows both use these methods.
 * @param ctx - Browser plugin context.
 * @returns The host capability remote.
 */
function capabilityRemote(ctx: Context): CapabilityRemote {
  return (ctx.remote as unknown as { qianshouPluginCatalog: CapabilityRemote }).qianshouPluginCatalog
}

/**
 * Unwrap one remote result, refusing with the code the host reported.
 * @param result - Settled remote call.
 * @returns The value of a successful call.
 * @throws Error - Carrying `error.message`, which is a stable host code.
 */
function expectValue<T>(result: RemoteValue<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * The account ids the invite field holds: one per line, without surrounding space and without repeats.
 * An empty line names no account. Whether a line is an account id at all is the host's decision.
 * @param text - What the owner typed into the invite field.
 * @returns The ids to store on this computer, in first-seen order.
 */
function parseInviteLines(text: string): string[] {
  const ids: string[] = []
  for (const line of text.split('\n')) {
    const id = line.trim()
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The invite field for one capability: its saved account ids, one per line.
 * @param item - Installed capability whose wizard is opening, or undefined.
 * @returns The field's initial text.
 */
function inviteLines(item: MyCapability | undefined): string {
  return item === undefined ? '' : item.record.inviteAccountIds.join('\n')
}

/** The dictionary key for one failed host call. */
function capabilityError(error: unknown): CapabilityKey {
  const message = error instanceof Error ? error.message : ''
  for (const [code, key] of Object.entries(capabilityErrorKeys)) {
    if (key !== undefined && message.includes(code)) return key
  }
  return 'errorGeneric'
}

/** Read-only request generations prevent a late load from replacing a newer one. */
export class CapabilitiesController {
  /** Current 我的能力 page. */
  readonly store = createSnapshotStore<CapabilitiesView>({
    loaded: false, capabilities: [], privateLocalCapabilities: [], wizardSteps: [], order: null, loading: false, busy: null, error: null,
    notice: null, selectedId: null, step: null, visibility: 'draft', confirmed: false, inviteText: '', report: null,
  })
  private generation = 0
  private disposed = false
  private started = false
  constructor(private readonly ctx: Context) {}
  private patch(value: Partial<CapabilitiesView>): void {
    if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), ...value })
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation }
  /** Invalidate late responses when the browser plugin unloads. */
  dispose(): void { this.disposed = true; this.generation++ }
  /** Load 我的能力 once, when the owner opens it. */
  ensure(): void { if (!this.disposed && !this.started) { this.started = true; void this.reload() } }
  /**
   * Read the installed declarations, the wizard steps and the order policy again.
   * @returns When the latest request settles.
   */
  async reload(): Promise<void> {
    this.started = true
    await this.read(null, true)
  }
  /** A market write may finish after this page's first read; read Host again when the page is open. */
  async refreshAfterMarketWrite(operation: Promise<void>): Promise<void> {
    await operation
    const view = this.store.getSnapshot()
    if (view.loaded || view.loading) await this.reload()
  }
  /**
   * Open the wizard on one installed capability, starting at its first step.
   * @param id - Market listing id of the declaration.
   */
  open(id: string): void {
    if (this.disposed) return
    const view = this.store.getSnapshot()
    const item = view.capabilities.find(entry => entry.record.id === id)
    this.patch({
      selectedId: id,
      step: view.wizardSteps[0] ?? null,
      // The wizard opens on the visibility this computer already saved, so publishing without
      // touching the choice republishes what the owner last chose rather than a default.
      visibility: item?.record.visibility ?? 'draft',
      confirmed: false,
      inviteText: inviteLines(item),
      report: null,
      busy: null,
      error: null,
      notice: null,
    })
  }
  /** Close the wizard without writing anything. */
  close(): void {
    if (this.disposed) return
    this.patch({ selectedId: null, step: null, confirmed: false, report: null, busy: null })
  }
  /**
   * Highlight one wizard step.
   * @param step - Step the owner selected.
   */
  selectStep(step: CapabilityWizardStep): void {
    if (this.disposed) return
    this.patch({ step })
  }
  /**
   * Choose the visibility the publish step will send.
   * A confirmation belongs to the public choice it was given for, so any change clears it.
   * @param visibility - Visibility the owner selected.
   */
  selectVisibility(visibility: CapabilityVisibility): void {
    if (this.disposed) return
    this.patch({ visibility, confirmed: false })
  }
  /**
   * Record the owner's confirmation, or its withdrawal.
   * @param next - Whether the owner confirmed a public publish.
   */
  confirmPublic(next: boolean): void {
    if (this.disposed) return
    this.patch({ confirmed: next })
  }
  /**
   * Replace the invite field's text. Nothing leaves this computer until a draft or publish is sent.
   * @param text - What the owner typed.
   */
  editInvite(text: string): void {
    if (this.disposed) return
    this.patch({ inviteText: text })
  }
  /**
   * Run the four install checks for one capability, writing nothing.
   * @param id - Market listing id of the declaration.
   * @returns When the checks settle.
   */
  async runPreflight(id: string): Promise<void> {
    await this.write('preflight', async (remote) => {
      this.patch({ report: expectValue(await remote.preflight({ id })) })
    })
  }
  /** Persist the owner master switch; per-service grants and rates remain Host-owned and unchanged. */
  async setSupplyEnabled(enabled: boolean): Promise<void> {
    if (this.disposed || this.store.getSnapshot().busy !== null) return
    if (this.store.getSnapshot().order === null) {
      this.patch({ error: 'errorSupplyUnavailable', notice: null })
      return
    }
    const saved = await this.write('supply', async (remote) => {
      expectValue(await remote.setOwnerSupplyEnabled({ enabled }))
    })
    const failure = saved ? null : this.store.getSnapshot().error
    // A Host observation can fail after the policy commit. Always read back the saved mode.
    await this.read(saved ? { kind: 'supplySaved', enabled } : null, false)
    if (failure !== null && this.store.getSnapshot().error === null) this.patch({ error: failure })
  }
  /**
   * Save the wizard's draft. The host stores the invite list on this computer and keeps the
   * visibility at draft, whatever step asked for it.
   * @param id - Market listing id of the declaration.
   * @returns When the save settles and the page has read the saved row back.
   */
  async saveDraft(id: string): Promise<void> {
    const inviteAccountIds = parseInviteLines(this.store.getSnapshot().inviteText)
    const saved = await this.write('save', async (remote) => {
      expectValue(await remote.saveCapabilityDraft({ id, inviteAccountIds }))
    })
    if (saved) await this.read({ kind: 'draftSaved' }, true)
  }
  /**
   * Publish one capability with the chosen visibility.
   * A public publish without the owner's confirmation is refused here, so no request carries it.
   * An invited publish stores its list on this computer first, because the invite list exists here only.
   * @param id - Market listing id of the declaration.
   * @returns When the publish settles and the page has read the saved row back.
   */
  async publish(id: string): Promise<void> {
    const view = this.store.getSnapshot()
    if (view.visibility === 'public' && !view.confirmed) {
      this.patch({ error: 'errorPublishUnconfirmed', notice: null })
      return
    }
    const { visibility, confirmed } = view
    const inviteAccountIds = parseInviteLines(view.inviteText)
    const saved = await this.write('publish', async (remote) => {
      if (visibility === 'invite') expectValue(await remote.saveCapabilityDraft({ id, inviteAccountIds }))
      expectValue(await remote.publishCapability({ id, visibility, confirmPublic: visibility === 'public' && confirmed }))
    })
    if (saved) await this.read({ kind: 'published', visibility }, true)
  }
  private async read(notice: CapabilityNotice | null, reseed: boolean): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    // The list keeps what it already shows while this read is in flight, so a refresh never
    // blanks a page the owner is reading.
    this.patch({ loading: true, error: null, notice })
    try {
      const read = expectValue(await capabilityRemote(this.ctx).myCapabilities())
      if (!this.current(generation)) return
      const capabilities = read.capabilities.map(item => ({ ...item,
        activity: item.activity ?? 'unknown',
        advertisable: item.advertisable && item.activity === 'active',
      }))
      const selectedId = this.store.getSnapshot().selectedId
      const item = capabilities.find(entry => entry.record.id === selectedId)
      this.patch({
        loading: false,
        loaded: true,
        capabilities,
        privateLocalCapabilities: read.privateLocalCapabilities ?? [],
        wizardSteps: read.wizardSteps,
        order: read.order,
        // A declaration that left the list takes its wizard with it; a saved row reseeds the
        // visibility and the invite field from what this computer now holds, and a confirmation
        // belongs to the choice it was given for, so the write that used it consumes it.
        ...item === undefined
          ? { selectedId: null, step: null, confirmed: false, inviteText: '' }
          : reseed ? { visibility: item.record.visibility, inviteText: inviteLines(item), confirmed: false } : {},
      })
    } catch (error) {
      if (!this.current(generation)) return
      this.patch({ loading: false, error: capabilityError(error) })
    }
  }
  private async write(
    kind: Exclude<CapabilityBusy, null>,
    run: (remote: CapabilityRemote) => Promise<void>,
  ): Promise<boolean> {
    if (this.disposed) return false
    const generation = ++this.generation
    this.patch({ busy: kind, error: null, notice: null })
    try {
      await run(capabilityRemote(this.ctx))
    } catch (error) {
      if (this.current(generation)) this.patch({ busy: null, error: capabilityError(error) })
      return false
    }
    if (!this.current(generation)) return false
    this.patch({ busy: null })
    return true
  }
}
