/** Validated skill files owned by this computer, independent of one Session's skill winner. */
import type { LocalSkillArchiveEntry, LocalSkillArchiveReceipt, LocalSkillArchiveRequest, LocalSkillRestoreReceipt,
  LocalSkillRestoreRequest, LocalSkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { confirmedAuthorActivation } from './author-activation-receipt.ts'

export interface LocalSkillsView {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly skills: readonly LocalSkillEntry[]
  readonly eligibilityStatus?: 'loading' | 'ready' | 'unavailable'
  readonly orderEligible?: readonly LocalOrderSkillEligibility[]
  readonly activations?: Readonly<Record<string, {
    readonly phase: 'enabling' | 'ready' | 'failed'
    readonly reason?: string
    readonly runtimeKind?: 'native-h3'
  }>>
  readonly removals?: Readonly<Record<string, {
    readonly phase: 'archiving' | 'archived' | 'failed'
    readonly receipt?: LocalSkillArchiveReceipt
    readonly reason?: string
  }>>
  readonly archiveStatus?: 'loading' | 'ready' | 'error'
  readonly archives?: readonly LocalSkillArchiveEntry[]
  readonly restorations?: Readonly<Record<string, { readonly phase: 'restoring' | 'failed'; readonly reason?: string }>>
}

export interface LocalOrderSkillEligibility {
  readonly runtimeKind?: 'native-h3'
  readonly serviceTitle?: string
  readonly serviceDescription?: string
  readonly source: 'user-dsh' | 'user-agents'
  readonly name: string
  readonly path: string
  readonly taskType: string
  readonly artifactDigest: string
  readonly platformPriced?: boolean
}

interface LocalSkillsRemote {
  listLocal(): Promise<{ ok: true; value: { skills: readonly LocalSkillEntry[] } } | { ok: false; error: unknown }>
  archiveLocal?(request: LocalSkillArchiveRequest): Promise<{ ok: true; value: LocalSkillArchiveReceipt }
  | { ok: false; error: unknown }>
  archiveList?(): Promise<{ ok: true; value: { items: readonly LocalSkillArchiveEntry[] } } | { ok: false; error: unknown }>
  restoreLocal?(request: LocalSkillRestoreRequest): Promise<{ ok: true; value: LocalSkillRestoreReceipt } | { ok: false; error: unknown }>
}

interface LocalOrderEligibilityRemote {
  localOrderSkillEligibility(): Promise<{ ok: true; value: { items: readonly LocalOrderSkillEligibility[] } }
    | { ok: false; error: unknown }>
  activateAuthorOrderSkill?(request: { source: 'user-dsh' | 'user-agents'; name: string }):
    Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>
  orderSources?(): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>
  myCapabilities?(): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>
}

function restoreMatches(receipt: Omit<LocalSkillRestoreReceipt, 'state'> & { readonly state: string },
  selected: LocalSkillArchiveEntry): boolean {
  return receipt.state === 'restored' && receipt.archiveId === selected.archiveId && receipt.source === selected.source
    && receipt.name === selected.name && receipt.sha256 === selected.sha256
    && (receipt.path === selected.originalPath || receipt.path === `${selected.originalPath}/SKILL.md`
      || receipt.path === `${selected.originalPath}\\SKILL.md`)
}

/** Re-read the Host's controlled user roots after file changes or when the owner opens the page. */
export class LocalSkillsController {
  readonly store = createSnapshotStore<LocalSkillsView>({ status: 'idle', skills: [] })
  private generation = 0
  private pending: Promise<void> | null = null
  private disposed = false
  private readonly enabling = new Map<string, Promise<void>>()
  private readonly archiving = new Map<string, Promise<boolean>>()
  private readonly restoring = new Map<string, Promise<boolean>>()
  private archivePending: Promise<void> | null = null
  private archiveGeneration = 0
  private owner: number | null | undefined

  constructor(private readonly remote: LocalSkillsRemote,
    private readonly orderCatalog?: LocalOrderEligibilityRemote,
    private readonly readOwner?: () => Promise<number | null>) {}

  ensure(): Promise<void> {
    return this.store.getSnapshot().status === 'idle' ? this.reload() : this.pending ?? Promise.resolve()
  }

  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const generation = ++this.generation
    const activations = Object.fromEntries(Object.entries(this.store.getSnapshot().activations ?? {})
      .filter(([, action]) => action.phase !== 'ready'))
    this.store.set({ ...this.store.getSnapshot(), status: 'loading', skills: this.store.getSnapshot().skills,
      ...(this.orderCatalog === undefined ? {} : { activations }),
      ...(this.orderCatalog === undefined ? {} : { eligibilityStatus: 'loading' as const, orderEligible: [] }) })
    const pending = (async () => {
      let owner: number | null | undefined
      let ownerRead = false
      try {
        if (this.readOwner !== undefined) {
          owner = await this.readOwner()
          if (this.disposed || generation !== this.generation) return
          ownerRead = true
          if (owner !== this.owner) {
            this.owner = owner
            this.store.set({ status: 'loading', skills: [],
              ...(this.orderCatalog === undefined ? {} : { eligibilityStatus: 'loading' as const, orderEligible: [] }) })
          }
        }
        // Local files are useful before network-backed qualification completes.
        const eligibility = this.orderCatalog?.localOrderSkillEligibility().catch(() => null)
        const background = this.orderCatalog === undefined ? null : Promise.all([
          this.orderCatalog.orderSources?.().catch(() => null) ?? Promise.resolve(undefined),
          this.orderCatalog.myCapabilities?.().catch(() => null) ?? Promise.resolve(undefined),
        ])
        const result = await this.remote.listLocal()
        if (this.disposed || generation !== this.generation) return
        if (!result.ok) throw new Error('local skills list failed')
        if (this.readOwner !== undefined && await this.readOwner() !== owner) throw new Error('catalog-owner-changed')
        if (this.disposed || generation !== this.generation) return
        this.store.set({ ...this.store.getSnapshot(), status: 'ready', skills: result.value.skills })
        if (eligibility !== undefined) void eligibility.then(async (result) => {
          if (this.disposed || generation !== this.generation) return
          if (!await this.checkOwner(owner) || generation !== this.generation) return
          this.store.set({ ...this.store.getSnapshot(), ...result?.ok
            ? { eligibilityStatus: 'ready' as const, orderEligible: result.value.items }
            : { eligibilityStatus: 'unavailable' as const, orderEligible: [] } })
        })
        if (background !== null) void background.then(async ([sources, capabilities]) => {
          if (this.disposed || generation !== this.generation) return
          if (!await this.checkOwner(owner) || generation !== this.generation) return
          const activations = Object.fromEntries(Object.entries(this.store.getSnapshot().activations ?? {})
            .filter(([, action]) => action.phase !== 'ready'))
          const sourceRows = sources?.ok ? (sources.value as { sources?: unknown }).sources : undefined
          const order = capabilities?.ok ? (capabilities.value as { order?: { mode?: unknown } }).order : undefined
          if (Array.isArray(sourceRows) && order && ['idle', 'allowed'].includes(String(order.mode))) {
            for (const item of sourceRows as unknown[]) {
              if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
              const row = item as Record<string, unknown>
              const publication = row.authorPublication !== null && typeof row.authorPublication === 'object'
                && !Array.isArray(row.authorPublication) ? row.authorPublication as Record<string, unknown> : null
              const native = row.runtimeKind === 'native-h3' && row.capabilityId === 'video.render'
                && publication?.status === 'approved' && publication.archiveConfirmed === true
                && typeof publication.publicationId === 'string'
              const installed = row.runtimeKind === undefined && typeof row.authorProductId === 'string'
              if (row.kind === 'skill' && typeof row.source === 'string' && ['user-dsh', 'user-agents'].includes(row.source)
                && (native || installed) && row.serviceId === 'node' && row.eligible === true
                && row.enabled === true && row.reason === 'ready' && typeof row.id === 'string') {
                try {
                  const name = decodeURIComponent(row.id.slice(`skill:${row.source}:`.length))
                  if (row.id === `skill:${row.source}:${encodeURIComponent(name)}`) activations[`${row.source}:${name}`] = {
                    phase: 'ready', ...(native ? { runtimeKind: 'native-h3' as const } : {}) }
                } catch { /* An invalid recovery binding stays unavailable. */ }
              }
            }
          }
          this.store.set({ ...this.store.getSnapshot(),
            activations })
        })

      } catch {
        const sameOwner = this.readOwner === undefined || ownerRead
          && await this.readOwner().then(current => current === owner, () => false)
        if (this.disposed || generation !== this.generation) return
        if (!sameOwner) this.owner = undefined
        this.store.set({ status: 'error',
          skills: sameOwner ? this.store.getSnapshot().skills : [],
          ...(this.orderCatalog === undefined ? {} : { eligibilityStatus: 'unavailable' as const, orderEligible: [] }) })
      } finally {
        if (generation === this.generation) this.pending = null
      }
    })()
    this.pending = pending
    return pending
  }

  /** Enable only the selected author skill; a missing or unknown response never becomes success. */
  enable(source: 'user-dsh' | 'user-agents', name: string): Promise<void> {
    const key = `${source}:${name}`
    const existing = this.enabling.get(key)
    if (existing) return existing
    if (this.disposed) return Promise.resolve()
    const current = this.store.getSnapshot()
    if (current.status !== 'ready' || current.eligibilityStatus !== 'ready') return Promise.resolve()
    const owner = this.owner
    this.action(key, { phase: 'enabling' })
    const operation = (async () => {
      try {
        if (!await this.checkOwner(owner)) throw new Error('order-author-activation-unavailable')
        const remote = this.orderCatalog?.activateAuthorOrderSkill
        if (!remote) throw new Error('order-author-activation-unavailable')
        const result = await remote.call(this.orderCatalog, { source, name })
        if (!result.ok) {
          const error = result.error as { message?: unknown }
          throw new Error(typeof error?.message === 'string' ? error.message : 'order-author-activation-unknown')
        }
        const value = result.value
        if (!confirmedAuthorActivation(value, source, name)) {
          throw new Error('order-author-activation-unknown')
        }
        const native = 'runtimeKind' in value
        const latest = this.store.getSnapshot()
        if (native && !latest.orderEligible?.some(item => item.runtimeKind === 'native-h3'
          && item.source === source && item.name === name && latest.skills.some(skill => skill.source === source
            && skill.name === name && skill.path === item.path))) throw new Error('order-author-source-changed')
        if (!await this.checkOwner(owner)) throw new Error('order-author-activation-unavailable')
        if (!this.disposed) this.action(key, { phase: 'ready', ...(native ? { runtimeKind: 'native-h3' as const } : {}) })
      } catch (error) {
        if (!this.disposed && owner === this.owner) this.action(key, { phase: 'failed',
          reason: error instanceof Error ? error.message : 'order-author-activation-unknown' })
      } finally { this.enabling.delete(key) }
    })()
    this.enabling.set(key, operation)
    return operation
  }

  private action(key: string, action: NonNullable<LocalSkillsView['activations']>[string]): void {
    this.store.set({ ...this.store.getSnapshot(), activations: { ...this.store.getSnapshot().activations, [key]: action } })
  }

  /** Move only a selected current local file; refresh after a verified archive receipt. */
  archive(request: LocalSkillArchiveRequest): Promise<boolean> {
    const existing = this.archiving.get(request.path)
    if (existing) return existing
    const skill = this.store.getSnapshot().skills.find(skill => skill.path === request.path
      && skill.source === request.source && skill.name === request.name && skill.sha256 === request.sha256)
    if (this.disposed || this.store.getSnapshot().status !== 'ready' || skill?.canArchive !== true
      || this.enabling.has(`${request.source}:${request.name}`)) return Promise.resolve(false)
    const owner = this.owner
    this.removal(request.path, { phase: 'archiving' })
    const operation = (async () => {
      try {
        if (!await this.checkOwner(owner) || !this.remote.archiveLocal) throw new Error('local-archive-unavailable')
        const result = await this.remote.archiveLocal(request)
        if (!result.ok) {
          const error = result.error
          const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
          throw new Error(typeof code === 'string' ? code : 'local-archive-unavailable')
        }
        const receipt = result.value
        if (receipt.source !== request.source || receipt.name !== request.name
          || receipt.sha256 !== request.sha256 || !receipt.archivePath || !receipt.receiptPath
          || receipt.originalPath !== request.path && `${receipt.originalPath}/SKILL.md` !== request.path
          && `${receipt.originalPath}\\SKILL.md` !== request.path) throw new Error('local-archive-unconfirmed')
        if (!await this.checkOwner(owner)) return false
        this.removal(request.path, { phase: 'archived', receipt })
        this.store.set({ ...this.store.getSnapshot(),
          skills: this.store.getSnapshot().skills.filter(skill => skill.path !== request.path) })
        await this.reload()
        if (this.store.getSnapshot().archiveStatus !== undefined) await this.refreshArchives()
        return true
      } catch (error) {
        if (!this.disposed && owner === this.owner) this.removal(request.path, { phase: 'failed',
          reason: error instanceof Error ? error.message : 'local-archive-unavailable' })
        return false
      } finally { this.archiving.delete(request.path) }
    })()
    this.archiving.set(request.path, operation)
    return operation
  }

  /** Read the real local recovery inventory only when requested; coalesce concurrent opens. */
  refreshArchives(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.archivePending !== null) return this.archivePending
    const generation = ++this.archiveGeneration
    const owner = this.owner
    this.store.set({ ...this.store.getSnapshot(), archiveStatus: 'loading' })
    const pending = (async () => {
      try {
        if (!await this.checkOwner(owner) || !this.remote.archiveList) throw new Error('local-recovery-unavailable')
        const result = await this.remote.archiveList()
        if (!result.ok || !await this.checkOwner(owner)) throw new Error('local-recovery-unavailable')
        if (!this.currentArchiveRead(owner, generation)) return
        this.store.set({ ...this.store.getSnapshot(), archiveStatus: 'ready', archives: result.value.items })
      } catch {
        if (this.currentArchiveRead(owner, generation)) {
          this.store.set({ ...this.store.getSnapshot(), archiveStatus: 'error', archives: [] })
        }
      } finally { if (generation === this.archiveGeneration) this.archivePending = null }
    })()
    this.archivePending = pending
    return pending
  }

  private currentArchiveRead(owner: number | null | undefined, generation: number): boolean {
    return !this.disposed && owner === this.owner && generation === this.archiveGeneration
  }

  /** Explicit recovery uses the currently verified archive row and never enables orders. */
  restore(request: LocalSkillRestoreRequest): Promise<boolean> {
    const existing = this.restoring.get(request.archiveId)
    if (existing !== undefined) return existing
    const current = this.store.getSnapshot()
    const selected = current.archives?.find(item => item.archiveId === request.archiveId
      && item.source === request.source && item.sha256 === request.sha256)
    if (this.disposed || current.archiveStatus !== 'ready' || selected === undefined) return Promise.resolve(false)
    const owner = this.owner
    this.restoration(request.archiveId, { phase: 'restoring' })
    const operation = (async () => {
      try {
        if (!await this.checkOwner(owner) || !this.remote.restoreLocal) throw new Error('local-recovery-unavailable')
        const result = await this.remote.restoreLocal(request)
        if (!result.ok) {
          const error = result.error
          const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
          throw new Error(typeof code === 'string' ? code : 'local-recovery-unavailable')
        }
        const receipt = result.value
        if (!restoreMatches(receipt, selected)) throw new Error('local-recovery-unconfirmed')
        if (!await this.checkOwner(owner)) return false
        this.store.set({ ...this.store.getSnapshot(), archives: this.store.getSnapshot().archives
          ?.filter(item => item.archiveId !== selected.archiveId) ?? [] })
        await this.reload()
        await this.refreshArchives()
        return true
      } catch (error) {
        if (!this.disposed && owner === this.owner) this.restoration(request.archiveId, { phase: 'failed',
          reason: error instanceof Error ? error.message : 'local-recovery-unavailable' })
        return false
      } finally { this.restoring.delete(request.archiveId) }
    })()
    this.restoring.set(request.archiveId, operation)
    return operation
  }

  private restoration(id: string, action: NonNullable<LocalSkillsView['restorations']>[string]): void {
    this.store.set({ ...this.store.getSnapshot(), restorations: { ...this.store.getSnapshot().restorations, [id]: action } })
  }

  private removal(path: string, action: NonNullable<LocalSkillsView['removals']>[string]): void {
    this.store.set({ ...this.store.getSnapshot(), removals: { ...this.store.getSnapshot().removals, [path]: action } })
  }

  private async checkOwner(owner: number | null | undefined): Promise<boolean> {
    if (this.disposed || owner !== this.owner) return false
    if (this.readOwner === undefined) return true
    const current = await this.readOwner().then(value => value === owner, () => false)
    if (this.disposed || owner !== this.owner) return false
    if (current) return true
    this.owner = undefined
    this.generation++
    if (!this.disposed) this.store.set({ status: 'error', skills: [], eligibilityStatus: 'unavailable', orderEligible: [] })
    return false
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.pending = null
    this.archiveGeneration += 1
    this.archivePending = null
  }
}
