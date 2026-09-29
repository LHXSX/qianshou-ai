import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComputeCapability, ComputeConnectionState, ComputePlanDraft, ComputePlanId, ComputePlanRequest } from '@deepseek-ai/dsh-compute-core/protocol'
import { hostError, parseCapabilities, parseConnection, parseDraft, parseDrafts } from './wire.ts'

/** Last complete local bridge observation and finite draft mutation state. */
export interface ComputeState {
  connection: ComputeConnectionState | null
  capabilities: ComputeCapability[]
  drafts: ComputePlanDraft[]
  loading: boolean
  saving: boolean
  error: { code: string; message: string } | null
}
/** Own one authenticated bridge projection and reject stale or incomplete observations. */
export class ComputeController {
  /** Snapshot bound by the slot renderer, with no browser credential persistence. */
  readonly store = createSnapshotStore<ComputeState>({
    connection: null, capabilities: [], drafts: [], loading: true, saving: false, error: null,
  })
  private readonly abort = new AbortController()
  private generation = 0
  private refreshPending = false
  private hydrated = false
  constructor(private readonly transport: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  private async request(path: 'status' | 'capabilities' | 'plans' | 'plans/confirm' | 'plans/publish', body?: unknown): Promise<unknown> {
    const response = await this.transport('/api/qianshou/compute/' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: this.abort.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    let data: unknown
    try { data = await response.json() }
    catch { throw response.ok ? new Error('INVALID_COMPUTE_RESPONSE') : hostError(null, response.status) }
    if (!response.ok) throw hostError(data, response.status)
    return data
  }
  private publishError(error: unknown): void {
    if (this.abort.signal.aborted) return
    this.store.update((state) => {
      state.error = error instanceof Error
        ? { code: error.message === 'INVALID_COMPUTE_RESPONSE' ? 'INVALID_COMPUTE_RESPONSE' : error.name, message: error.message }
        : { code: 'REQUEST_FAILED', message: 'REQUEST_FAILED' }
    })
  }
  /** Refresh all bridge facts atomically; failed authentication invalidates the available catalog. */
  async refresh(): Promise<void> {
    if (this.refreshPending || this.abort.signal.aborted || this.store.getSnapshot().saving) return
    this.refreshPending = true
    const generation = ++this.generation
    this.store.update((state) => { state.loading = true; state.error = null })
    try {
      const [status, capabilities, drafts] = await Promise.all([
        this.request('status'), this.request('capabilities'), this.request('plans'),
      ])
      const next = { connection: parseConnection(status), capabilities: parseCapabilities(capabilities), drafts: parseDrafts(drafts) }
      if (this.isAborted() || generation !== this.generation) return
      this.store.update((state) => { Object.assign(state, next); state.loading = false })
      this.hydrated = true
    } catch (error) {
      if (generation === this.generation && !this.isAborted()) {
        this.store.update((state) => { state.connection = null; state.capabilities = []; state.loading = false })
        this.publishError(error)
      }
    } finally { this.refreshPending = false }
  }
  /** Save user-authored requirements locally; no quote acceptance or execution route exists here. */
  async saveDraft(request: ComputePlanRequest): Promise<boolean> {
    const snapshot = this.store.getSnapshot()
    if (snapshot.saving || snapshot.loading || this.isAborted()
      || !snapshot.capabilities.some(capability => capability.id === request.capabilityId && capability.available)) return false
    this.store.update((state) => { state.saving = true; state.error = null })
    try {
      const draft = parseDraft(await this.request('plans', request))
      if (this.isAborted()) return false
      this.store.update((state) => { state.drafts = [draft, ...state.drafts.filter(item => item.id !== draft.id)] })
      return true
    } catch (error) { this.publishError(error); return false }
    finally { if (!this.isAborted()) this.store.update((state) => { state.saving = false }) }
  }
  /** Confirm or decline a stored draft locally; this does not quote, submit, or charge. */
  async confirmDraft(id: ComputePlanId, decision: 'approved' | 'declined'): Promise<boolean> {
    if (this.store.getSnapshot().saving || this.isAborted()) return false
    this.store.update((state) => { state.saving = true; state.error = null })
    try {
      const draft = parseDraft(await this.request('plans/confirm', { id, decision }))
      if (this.isAborted()) return false
      this.store.update((state) => { state.drafts = [draft, ...state.drafts.filter(item => item.id !== draft.id)] })
      return true
    } catch (error) { this.publishError(error); return false }
    finally { if (!this.isAborted()) this.store.update((state) => { state.saving = false }) }
  }
  /** Publish an approved local draft; the Host POSTs the developer-task route. */
  async publishDraft(id: ComputePlanId): Promise<boolean> {
    if (this.store.getSnapshot().saving || this.isAborted()) return false
    this.store.update((state) => { state.saving = true; state.error = null })
    try {
      const draft = parseDraft(await this.request('plans/publish', { id }))
      if (this.isAborted()) return false
      this.store.update((state) => { state.drafts = [draft, ...state.drafts.filter(item => item.id !== draft.id)] })
      return true
    } catch (error) { this.publishError(error); return false }
    finally { if (!this.isAborted()) this.store.update((state) => { state.saving = false }) }
  }
  /** Load bridge facts once so conversation cards can overlay stored authorization. */
  ensureLoaded(): Promise<void> {
    if (this.hydrated || this.isAborted()) return Promise.resolve()
    return this.refresh()
  }
  /** Abort requests and suppress late responses when the plugin leaves. */
  dispose(): void { this.generation += 1; this.abort.abort() }

  private isAborted(): boolean {
    return this.abort.signal.aborted
  }
}
