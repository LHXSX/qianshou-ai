import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { SHARING_CONSENT_VERSION, type SharingAction, type SharingCommand, type SharingMode,
  type SharingPendingOperation, type SharingSnapshot, type SharingViewState } from './sharing-types.ts'
import { sharingReadFailure, type SharingTransport } from './sharing-transport.ts'

// Some local IPC carriers cannot cancel a pending read. Its late result must not keep the view loading.
function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new Error('SHARING_REQUEST_ABORTED')) }
    signal.addEventListener('abort', abort, { once: true })
    operation.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error('SHARING_REQUEST_FAILED'))
      })
    if (signal.aborted) abort()
  })
}

/** One controller survives navigation; consent and unknown operations remain bound to the original scope. */
export class SharingController {
  readonly store = createSnapshotStore<SharingViewState>({ phase: 'loading', readFailure: null, snapshot: null, busyMode: null,
    actionFailed: false, confirmation: null, pendingOperation: null })
  private generation = 0
  private pending: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  constructor(private readonly transport: SharingTransport) {}
  private isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation }

  start(): void {
    if (this.disposed || this.timer !== null) return
    this.timer = setInterval(() => { void this.refresh() }, 5000)
    void this.refresh()
  }
  invalidate(): void {
    this.generation += 1
    this.pending?.abort(); this.pending = null
    this.store.set({ phase: 'loading', readFailure: null, snapshot: null, busyMode: null, actionFailed: false,
      confirmation: null, pendingOperation: null })
    void this.refresh()
  }
  dispose(): void {
    this.disposed = true; this.generation += 1; this.pending?.abort()
    this.store.set({ ...this.store.getSnapshot(), confirmation: null, pendingOperation: null, busyMode: null })
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
  private observe(snapshot: SharingSnapshot): void {
    const state = this.store.getSnapshot()
    const original = state.pendingOperation
    const sameScope = snapshot.authenticated && snapshot.scopeId != null
      && (state.snapshot?.scopeId == null || state.snapshot.scopeId === snapshot.scopeId)
      && (original === null || original.scopeId === snapshot.scopeId)
    let pendingOperation = sameScope ? original : null
    let actionFailed = sameScope ? state.actionFailed : false
    if (pendingOperation !== null && snapshot.operation?.requestId === pendingOperation.requestId) {
      const operation = snapshot.operation
      if (operation.status === 'not_found') { pendingOperation = null; actionFailed = true }
      else if (operation.mode === pendingOperation.mode && operation.action === pendingOperation.action) {
        pendingOperation = null; actionFailed = false
      }
    }
    this.store.set({ phase: 'ready', readFailure: null, snapshot,
      busyMode: pendingOperation === null ? null : state.busyMode,
      actionFailed, pendingOperation,
      confirmation: sameScope && state.confirmation?.scopeId === snapshot.scopeId ? state.confirmation : null })
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.pending !== null) return
    const generation = this.generation
    const pending = new AbortController(); this.pending = pending
    const deadline = setTimeout(() => { pending.abort() }, 10000)
    try {
      const original = this.store.getSnapshot().pendingOperation
      const snapshot = await beforeAbort(this.transport.read(pending.signal, original?.requestId), pending.signal)
      if (!this.isCurrent(generation)) return
      this.observe(snapshot)
    } catch (error) {
      if (this.isCurrent(generation)) {
        const current = this.store.getSnapshot()
        this.store.set({ ...current, phase: 'unavailable', readFailure: sharingReadFailure(error), confirmation: null,
          snapshot: current.snapshot === null ? null : {
            ...current.snapshot, connection: { gateway: 'unknown', deviceAuthorization: 'unknown', channel: 'offline',
              heartbeat: 'unknown', checkedAt: null, heartbeatAt: null },
            modes: current.snapshot.modes.map(mode => ({ ...mode, local: { inventory: 'unknown', modelCount: null,
              runtime: 'unknown', adapter: null, adoption: 'unmatched', checkedAt: null },
            api: { status: 'unknown', adapter: null, modelName: null, workflowName: null,
              registration: 'unknown', lastProbedAt: null, probeStatus: 'unknown' } })),
          } })
      }
    } finally { clearTimeout(deadline); if (this.pending === pending) this.pending = null }
  }
  /** Reuse current device consent for preparation; stage a dialog only when that consent is absent. */
  async command(mode: SharingMode, action: SharingAction): Promise<void> {
    const state = this.store.getSnapshot(); const scopeId = state.snapshot?.scopeId
    if (this.disposed || state.busyMode !== null || state.pendingOperation !== null || state.phase !== 'ready'
      || !state.snapshot?.authenticated || scopeId == null) return
    const intent: SharingPendingOperation = { mode, action, scopeId, requestId: randomUUID() }
    if (action === 'enable' || action === 'resume') {
      if (state.confirmation !== null) return
      const authorization = state.snapshot.modes.find(row => row.mode === mode)?.authorization
      if (authorization?.connection === 'granted' && authorization.execution === 'idle_only' && authorization.deviceBound) {
        await this.send({ ...intent, action,
          consent: { version: SHARING_CONSENT_VERSION, connection: true, execution: 'idle_only' } })
        return
      }
      this.store.set({ ...state, confirmation: intent, actionFailed: false }); return
    }
    this.store.set({ ...state, confirmation: null })
    await this.send({ ...intent, action })
  }
  cancelConfirmation(requestId: string): void {
    const state = this.store.getSnapshot()
    if (state.confirmation?.requestId === requestId) this.store.set({ ...state, confirmation: null })
  }
  /** Consume the original dialog once, before any asynchronous write can start. */
  async confirm(requestId: string, scopeId: string): Promise<void> {
    const state = this.store.getSnapshot(); const intent = state.confirmation
    if (this.disposed || state.phase !== 'ready' || !state.snapshot?.authenticated || intent === null
      || intent.requestId !== requestId || intent.scopeId !== scopeId || state.snapshot.scopeId !== intent.scopeId
      || state.busyMode !== null || state.pendingOperation !== null
      || (intent.action !== 'enable' && intent.action !== 'resume')) return
    this.store.set({ ...state, confirmation: null })
    await this.send({ ...intent, action: intent.action,
      consent: { version: SHARING_CONSENT_VERSION, connection: true, execution: 'idle_only' } })
  }
  private async send(command: SharingCommand): Promise<void> {
    this.pending?.abort(); this.pending = null
    const generation = ++this.generation
    const pending = new AbortController(); this.pending = pending
    const deadline = setTimeout(() => { pending.abort() }, 10000)
    const { mode, action, requestId, scopeId } = command
    this.store.set({ ...this.store.getSnapshot(), busyMode: mode, actionFailed: false,
      confirmation: null, pendingOperation: { mode, action, requestId, scopeId } })
    try {
      const snapshot = await beforeAbort(this.transport.command(command, pending.signal), pending.signal)
      if (!this.isCurrent(generation)) return
      this.observe(snapshot)
      if (this.store.getSnapshot().pendingOperation !== null) {
        this.store.set({ ...this.store.getSnapshot(), busyMode: null, actionFailed: true })
      }
    } catch {
      if (this.isCurrent(generation)) {
        this.store.set({ ...this.store.getSnapshot(), busyMode: null, actionFailed: true })
      }
    } finally {
      clearTimeout(deadline)
      if (this.pending === pending) this.pending = null
      if (this.isCurrent(generation)) await this.refresh()
    }
  }
}

/** Framework binds the observable; components receive only plain callbacks. */
export function createSharingInjection(controller: SharingController, openIntake: () => void,
  openSkills: () => void, openAccount: () => void) {
  return { hooks: { sharing: controller.store }, refresh: () => { void controller.refresh() },
    command: (mode: SharingMode, action: SharingAction) => { void controller.command(mode, action) },
    confirmSharing: (requestId: string, scopeId: string) => { void controller.confirm(requestId, scopeId) },
    cancelSharing: (requestId: string) => { controller.cancelConfirmation(requestId) },
    openIntake, openSkills, openAccount }
}
