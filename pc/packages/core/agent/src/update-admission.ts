/** Process-local installation vetoes for work that outlives its initiating HTTP request. */

/** An uncertain external submission is protected exactly like running work. */
export type UpdateWorkState = 'idle' | 'busy' | 'unknown'

/** Each producer owns its synchronous admission gate and original-work observation. */
export interface UpdateWorkParticipant {
  /** Set only update maintenance; owner grants and original GET/delivery remain unchanged. */
  setLocked(locked: boolean): void
  /** Inspect actual running/unknown work; a transport or journal error must reject. */
  inspect(): UpdateWorkState | Promise<UpdateWorkState>
}

/** Fixed refusal codes cross the Host control channel without paths or remote diagnostics. */
export class UpdateWorkError extends Error {
  readonly code: 'DESKTOP_UPDATE_WORK_BUSY' | 'DESKTOP_UPDATE_WORK_UNKNOWN' | 'DESKTOP_UPDATE_WORK_CHANGED'
  /** @param code - Busy, unknown or superseded inspection; none authorizes task interruption. */
  constructor(code: 'DESKTOP_UPDATE_WORK_BUSY' | 'DESKTOP_UPDATE_WORK_UNKNOWN' | 'DESKTOP_UPDATE_WORK_CHANGED') {
    super(code)
    this.code = code
  }
}

/** Shared by the Desktop Host and every producer on the same root Cordis context. */
export class UpdateWorkRegistry {
  private readonly participants = new Set<UpdateWorkParticipant>()
  private locked = false
  private revision = 0
  private generation = 0

  /**
   * Register the actual producer, including a producer loaded during maintenance.
   * @param participant - Owned admission setter and current work reader.
   * @returns Idempotent disposer for this exact registration.
   */
  register(participant: UpdateWorkParticipant): () => void {
    const entry = { setLocked: (locked: boolean) => { participant.setLocked(locked) },
      inspect: () => participant.inspect() }
    entry.setLocked(this.locked)
    this.participants.add(entry); this.revision++
    return () => { if (this.participants.delete(entry)) { this.revision++ } }
  }

  /**
   * Lock every producer synchronously before any asynchronous observation runs.
   * @param action - Inspect, enter maintenance or release only this update veto.
   * @returns Whether protected work exists. Lock refuses busy/unknown work instead of stopping it.
   */
  async control(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    if (action === 'unlock') {
      this.locked = false; this.generation++
      for (const participant of this.participants) participant.setLocked(false)
      return false
    }
    if (action === 'lock') {
      this.locked = true; this.generation++
      for (const participant of this.participants) participant.setLocked(true)
    }
    const generation = this.generation; const revision = this.revision
    const states = await Promise.all([...this.participants].map(async participant => await participant.inspect()))
      .catch(() => { throw new UpdateWorkError('DESKTOP_UPDATE_WORK_UNKNOWN') })
    if (generation !== this.generation || revision !== this.revision) throw new UpdateWorkError('DESKTOP_UPDATE_WORK_CHANGED')
    if (states.includes('unknown')) throw new UpdateWorkError('DESKTOP_UPDATE_WORK_UNKNOWN')
    const busy = states.includes('busy')
    if (action === 'lock' && busy) throw new UpdateWorkError('DESKTOP_UPDATE_WORK_BUSY')
    return busy
  }
}

const registries = new WeakMap<object, UpdateWorkRegistry>()

/**
 * Resolve one registry for the real root context; no global grants or persistence are added.
 * @param root - The owning Cordis root, shared by its plugin scopes.
 * @returns Stable process-local update work registry.
 */
export function updateWorkOf(root: object): UpdateWorkRegistry {
  let registry = registries.get(root)
  if (registry === undefined) { registry = new UpdateWorkRegistry(); registries.set(root, registry) }
  return registry
}
