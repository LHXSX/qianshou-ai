/** Retry a prepared, signed Desktop update only while automatic installation remains enabled. */

import type { DesktopUpdateState } from './ipc.ts'

/** A process-owned timer; a busy or unknown Host leaves the verified package ready. */
export class DesktopUpdateAutoInstall {
  private timer: ReturnType<typeof setTimeout> | undefined
  private operation: Promise<void> | undefined
  private version: string | undefined
  private deferredVersion: string | undefined
  private disposed = false

  /**
   * @param status - Current coordinator state, including the exact prepared version.
   * @param install - Installs only after a fresh idle and admission-lock check.
   * @param enabled - Live packaged-feed and owner-preference check.
   * @param initialDelayMs - Time for the new-version notice to remain visible.
   * @param retryDelayMs - Delay before another idle check after busy or unknown work.
   */
  constructor(
    private readonly status: () => DesktopUpdateState,
    private readonly install: (version: string) => Promise<DesktopUpdateState>,
    private readonly enabled: () => boolean,
    private readonly initialDelayMs = 30_000,
    private readonly retryDelayMs = 60_000,
  ) {}

  /** Reconcile an updater event or a changed owner preference without replaying a transfer. */
  refresh(): void {
    if (this.disposed || !this.enabled()) { this.cancel(); return }
    const state = this.status()
    if (state.phase !== 'ready' || state.version === undefined) {
      clearTimeout(this.timer); this.timer = undefined
      return
    }
    if (this.deferredVersion !== undefined && this.deferredVersion !== state.version) this.deferredVersion = undefined
    if (this.deferredVersion === state.version) {
      clearTimeout(this.timer); this.timer = undefined
      return
    }
    if (this.version !== state.version) {
      this.version = state.version
      clearTimeout(this.timer); this.timer = undefined
    }
    if (this.timer === undefined && this.operation === undefined) this.schedule(this.initialDelayMs)
  }

  /** A user's “Later” choice suppresses automatic restart for this version until the next launch. */
  defer(version: string): void {
    this.deferredVersion = version
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Explicitly enabling the device preference renews automatic installation. */
  enableAgain(): void { this.deferredVersion = undefined; this.refresh() }

  /** Stop queued attempts; an in-flight Host handoff checks the preference again. */
  dispose(): void { this.disposed = true; this.cancel() }

  private cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.version = undefined
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      const version = this.version
      const state = this.status()
      if (this.disposed || !this.enabled() || version === undefined
        || state.phase !== 'ready' || state.version !== version) return
      this.operation = this.install(version).then((result) => {
        if (result.phase === 'ready' && result.version === version && !this.disposed && this.enabled()) {
          this.schedule(this.retryDelayMs)
        }
      }).catch((error: unknown) => { console.error('desktop update: automatic installation attempt failed', error) })
        .finally(() => { this.operation = undefined })
    }, delay)
    this.timer.unref()
  }
}
