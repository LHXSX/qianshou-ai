/** Owner-local plugin packages prepared in conversation and verified again by the Host. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface LocalPluginCandidateView {
  readonly draftId: string
  readonly packageName: string
  readonly packagePath: string
  readonly toolName: string
  readonly sourceDigest: string
  readonly packageDigest: string
  readonly displayName: string
  readonly description: string
  readonly operationTitle: string
  readonly preparedAt: number
  readonly orderAdapter?: {
    readonly version: 1
    readonly capabilityId: 'text.transform'
    readonly taskType: 'word_count'
    readonly inputKind: 'inline'
    readonly outputKind: 'inline_json'
    readonly contractVersion: 'v1'
  }
  readonly installableLocally: true
  readonly published: false
  readonly dispatchable: false
}

export interface LocalPluginCandidatesView {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly candidates: readonly LocalPluginCandidateView[]
  readonly installedChecks?: Readonly<Record<string, 'checking' | 'matched' | 'changed' | 'unavailable'>>
}

interface LocalCandidatesRemote {
  localCandidates(): Promise<{ ok: true; value: { candidates: LocalPluginCandidateView[] } } | { ok: false; error: unknown }>
  checkLocalCandidateInstall?(request: { draftId: string; packageDigest: string; requireOrderAdapter: false }):
    Promise<{ ok: true; value: { packageName: string; packageDigest: string; matched: boolean;
      reason: 'matched' | 'not-installed' | 'changed' | 'adapter-missing' | 'unavailable' } }
      | { ok: false; error: unknown }>
}

/** Read only. Installation continues through the existing plugin manager review dialog. */
export class LocalPluginCandidatesController {
  readonly store = createSnapshotStore<LocalPluginCandidatesView>({ status: 'idle', candidates: [], installedChecks: {} })
  private generation = 0
  private disposed = false
  private readonly checkVersions = new Map<string, number>()

  constructor(private readonly remote: LocalCandidatesRemote) {}

  ensure(): Promise<void> {
    return this.store.getSnapshot().status === 'idle' ? this.reload() : Promise.resolve()
  }

  async reload(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.checkVersions.clear()
    this.store.set({ ...this.store.getSnapshot(), status: 'loading' })
    try {
      const result = await this.remote.localCandidates()
      if (this.disposed || generation !== this.generation) return
      if (!result.ok) throw new Error('candidate inventory unavailable')
      this.store.set({ status: 'ready', candidates: result.value.candidates, installedChecks: {} })
    } catch {
      if (!this.disposed && generation === this.generation) this.store.set({ status: 'error', candidates: [], installedChecks: {} })
    }
  }

  invalidateInstalledChecks(): void {
    if (this.disposed) return
    this.checkVersions.clear()
    const state = this.store.getSnapshot()
    this.store.set({ ...state, installedChecks: {} })
  }

  /** Read-only comparison. A matching package name or enabled flag is not byte identity. */
  async checkInstalled(candidate: LocalPluginCandidateView): Promise<void> {
    if (this.disposed) return
    const key = `${candidate.draftId}:${candidate.packageDigest}`
    const current = this.store.getSnapshot()
    if (!current.candidates.some(item => item.draftId === candidate.draftId
      && item.packageDigest === candidate.packageDigest && item.packageName === candidate.packageName
      && item.packagePath === candidate.packagePath)) return
    const version = (this.checkVersions.get(key) ?? 0) + 1
    this.checkVersions.set(key, version)
    this.store.set({ ...current, installedChecks: { ...current.installedChecks, [key]: 'checking' } })
    let status: 'matched' | 'changed' | 'unavailable' = 'unavailable'
    try {
      const answer = await this.remote.checkLocalCandidateInstall?.({ draftId: candidate.draftId,
        packageDigest: candidate.packageDigest, requireOrderAdapter: false })
      if (answer?.ok && answer.value.packageName === candidate.packageName
        && answer.value.packageDigest === candidate.packageDigest) {
        status = answer.value.matched ? 'matched'
          : answer.value.reason === 'unavailable' ? 'unavailable' : 'changed'
      }
    } catch { /* Keep an unknown comparison distinct from a mismatch. */ }
    if (this.disposed || version !== this.checkVersions.get(key)) return
    const latest = this.store.getSnapshot()
    if (!latest.candidates.some(item => item.draftId === candidate.draftId
      && item.packageDigest === candidate.packageDigest && item.packageName === candidate.packageName
      && item.packagePath === candidate.packagePath)) return
    this.store.set({ ...latest, installedChecks: { ...latest.installedChecks, [key]: status } })
  }

  dispose(): void { this.disposed = true; this.generation++ }
}
