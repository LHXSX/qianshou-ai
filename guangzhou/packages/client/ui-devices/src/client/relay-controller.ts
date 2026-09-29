import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Credential-free native relay state; connectivity describes FRPC registration. */
export interface RelayStatus {
  configured: boolean
  enabled: boolean
  phase: 'unconfigured' | 'disabled' | 'connecting' | 'online' | 'error'
  endpoint: string | null
  error: string | null
}
/** Narrow preload capability; native file selection never exposes its path or secret. */
export interface RelayBridge {
  status: () => Promise<{ ok: boolean; status?: RelayStatus; error?: string }>
  importConfig: () => Promise<{ ok: boolean; status?: RelayStatus; error?: string }>
  setEnabled: (enabled: boolean) => Promise<{ ok: boolean; status?: RelayStatus; error?: string }>
}
/** Page-visible relay capability and action state. */
export interface RelayState {
  available: boolean
  busy: boolean
  status: RelayStatus
  error: string | null
}
const initial: RelayStatus = { configured: false, enabled: false, phase: 'unconfigured', endpoint: null, error: null }
function validStatus(value: RelayStatus | undefined): value is RelayStatus {
  return Boolean(value && typeof value.configured === 'boolean' && typeof value.enabled === 'boolean'
    && ['unconfigured', 'disabled', 'connecting', 'online', 'error'].includes(value.phase)
    && (value.endpoint === null || value.endpoint === 'https://203.0.113.20:24443')
    && (value.error === null || typeof value.error === 'string'))
}
/** Poll native status in the object layer; components only consume the injected snapshot. */
export class RelayController {
  readonly store
  private readonly bridge: RelayBridge | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private pending = false
  private closed = false
  private disposed(): boolean { return this.closed }
  private revision = 0
  constructor(bridge?: RelayBridge) {
    this.bridge = bridge
    this.store = createSnapshotStore<RelayState>({ available: Boolean(bridge), busy: false, status: initial, error: null })
  }
  /** Refresh actual registration state while retaining visible mutation failures. */
  async refresh(): Promise<void> {
    if (!this.bridge || this.pending || this.disposed()) return
    this.pending = true
    const revision = this.revision
    try {
      const result = await this.bridge.status()
      const status = result.status
      if (!result.ok || !validStatus(status)) throw new Error(result.error ?? 'RELAY_UNAVAILABLE')
      if (!this.disposed() && revision === this.revision) this.store.update((s) => { s.status = status; s.error = null })
    } catch {
      if (!this.disposed() && revision === this.revision) this.store.update((s) => { s.error = 'RELAY_UNAVAILABLE'; s.status = { ...s.status, phase: 'error' } })
    } finally { this.pending = false }
  }
  /** Run one user-requested native action; duplicate clicks are ignored until settlement. */
  async act(action: 'import' | 'enable' | 'disable'): Promise<void> {
    if (!this.bridge || this.store.getSnapshot().busy || this.disposed()) return
    this.revision++
    this.store.update((s) => { s.busy = true; s.error = null })
    try {
      const result = await (action === 'import' ? this.bridge.importConfig() : this.bridge.setEnabled(action === 'enable'))
      const status = result.status
      if (!result.ok || !validStatus(status)) throw new Error(result.error ?? 'RELAY_UNAVAILABLE')
      if (!this.disposed()) this.store.update((s) => { s.status = status })
    } catch (error) {
      if (!this.disposed()) this.store.update((s) => { s.error = error instanceof Error ? error.message : 'RELAY_UNAVAILABLE' })
    } finally {
      if (!this.disposed()) this.store.update((s) => { s.busy = false })
    }
  }
  /** Poll while the device page is visible; the desktop process owns connection lifetime. */
  attach(): () => void {
    void this.refresh()
    this.timer = setInterval(() => { if (!this.store.getSnapshot().busy) void this.refresh() }, 2000)
    return () => { clearInterval(this.timer); this.timer = undefined }
  }
  /** Stop view polling without disabling an explicitly enabled desktop connection. */
  dispose(): void { this.closed = true; clearInterval(this.timer) }
}
