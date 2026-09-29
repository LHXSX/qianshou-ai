import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Public companion identity and workspaces reported by the coordinator. */
export interface Device {
  id: string
  name: string
  platform: string
  arch: string
  connected: boolean
  lastSeen: string
  workspaces: { id: string; name: string; path: string }[]
}
/** Finite tasks requiring an explicit approval on the target companion. */
export type JobKind = 'command' | 'list' | 'read' | 'write' | 'desktop'
/** Coordinator receipt displayed by the device workspace. */
export interface Job {
  id: string
  deviceId: string
  kind: JobKind
  status: string
  output: string
  error?: string
  result?: unknown
  cancelRequested?: boolean
}
/** Verified release metadata returned by the authenticated companion catalog. */
export interface CompanionRelease {
  id: 'darwin-arm64' | 'win32-x64' | 'linux-x64'
  version: string
  filename: string
  bytes: number
  sha256: string
  validation: 'local-mac-verified' | 'packaged-only'
  href: string
}
/** Observable network state; drafts and selections remain page-local. */
export interface DeviceState {
  devices: Device[]
  jobs: Job[]
  loading: boolean
  busy: boolean
  error: string | null
  pairing: { code: string; expiresAt: string } | null
  releases: CompanionRelease[]
  releasesLoading: boolean
  releasesError: string | null
}
/** Own the live device catalog, authenticated requests and cancellation lifetime. */
export class DevicesController {
  /** Current catalog, receipts and visible request errors. */
  readonly store = createSnapshotStore<DeviceState>({
    devices: [],
    jobs: [],
    loading: true,
    busy: false,
    error: null,
    pairing: null,
    releases: [], releasesLoading: true, releasesError: null,
  })
  private readonly abort = new AbortController()
  private refreshPending = false
  private timer: ReturnType<typeof setInterval> | undefined
  private releasesPending = false
  private disposed(): boolean { return this.abort.signal.aborted }
  constructor(
    private readonly transport: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.transport('/api/qianshou/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: this.abort.signal,
      ...(body === undefined
        ? {}
        : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    })
    const data: unknown = await response.json()
    if (!response.ok)
      throw new Error(
        typeof data === 'object' && data !== null && 'error' in data
          ? String(data.error)
          : 'HTTP_' + String(response.status),
      )
    return data as T
  }
  /** Refresh actual coordinator state, sharing one in-flight read. */
  async refresh(): Promise<void> {
    if (this.refreshPending || this.disposed()) return
    this.refreshPending = true
    try {
      const data = await this.request<{ devices: Device[]; jobs: Job[] }>(
        'devices',
      )
      if (!Array.isArray(data.devices) || !Array.isArray(data.jobs))
        throw new Error('INVALID_RESPONSE')
      if (!this.disposed())
        this.store.update((s) => {
          s.devices = data.devices
          s.jobs = data.jobs
          s.loading = false
          s.error = null
          if (s.pairing && Date.parse(s.pairing.expiresAt) <= Date.now())
            s.pairing = null
        })
    } catch (error) {
      if (!this.disposed())
        this.store.update((s) => {
          s.loading = false
          s.error = String(error instanceof Error ? error.message : error)
        })
    } finally {
      this.refreshPending = false
    }
  }
  /** Load verified archives independently from the frequently refreshed task state. */
  async loadReleases(): Promise<void> {
    if (this.releasesPending || this.disposed()) return
    this.releasesPending = true
    this.store.update((s) => { s.releasesLoading = true })
    try {
      const data = await this.request<{ releases: CompanionRelease[]; unavailable: string[] }>('companion-downloads')
      if (!Array.isArray(data.releases) || !Array.isArray(data.unavailable)
        || data.releases.some(r => !['darwin-arm64', 'win32-x64', 'linux-x64'].includes(r.id)
          || r.href !== '/api/qianshou/companion-downloads/' + r.id
          || typeof r.filename !== 'string' || typeof r.version !== 'string'
          || typeof r.bytes !== 'number' || !Number.isSafeInteger(r.bytes) || r.bytes < 1
          || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256)
          || !['local-mac-verified', 'packaged-only'].includes(r.validation))) throw new Error('INVALID_RELEASE_CATALOG')
      if (!this.disposed()) this.store.update((s) => {
        s.releases = data.releases
        s.releasesError = data.unavailable.length ? 'RELEASE_UNAVAILABLE' : null
      })
    } catch (error) {
      if (!this.disposed()) this.store.update((s) => {
        s.releases = []
        s.releasesError = String(error instanceof Error ? error.message : error)
      })
    } finally {
      this.releasesPending = false
      if (!this.disposed()) this.store.update((s) => { s.releasesLoading = false })
    }
  }
  /**
   * Submit one authenticated mutation and refresh its coordinator receipt.
   * @param path - Action name below the fixed Qianshou API prefix.
   * @param body - Action payload, validated by the coordinator.
   */
  async act(path: string, body: unknown): Promise<void> {
    if (this.store.getSnapshot().busy || this.disposed()) return
    this.store.update((s) => {
      s.busy = true
      s.error = null
    })
    try {
      const result = await this.request<{ code: string; expiresAt: string }>(
        path,
        body,
      )
      if (this.disposed()) return
      if (path === 'pairings')
        this.store.update((s) => {
          s.pairing = { code: result.code, expiresAt: result.expiresAt }
        })
      await this.refresh()
    } catch (error) {
      if (!this.disposed())
        this.store.update((s) => {
          s.error = String(error instanceof Error ? error.message : error)
        })
    } finally {
      if (!this.disposed())
        this.store.update((s) => {
          s.busy = false
        })
    }
  }
  /**
   * Poll while the page is mounted.
   * @returns Cleanup that stops this view's polling timer.
   */
  attach(): () => void {
    void this.refresh()
    void this.loadReleases()
    this.timer = setInterval(() => {
      void this.refresh()
    }, 2000)
    return () => {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
  /** Stop polling and abort requests when the plugin is unloaded. */
  dispose(): void {
    clearInterval(this.timer)
    this.abort.abort()
  }
}
