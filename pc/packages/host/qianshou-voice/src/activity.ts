/** Synchronous reading of local voice work owned by this plugin's lifetime. */
export class VoiceActivityProjection {
  private inFlight = 0
  private readonly listeners = new Set<(active: boolean) => void>()

  /** Hold one admitted voice request until its upload, inference and cleanup finish. */
  hold(): () => void {
    this.inFlight += 1
    if (this.inFlight === 1) this.changed(true)
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight -= 1
      if (this.inFlight === 0) this.changed(false)
    }
  }

  active(): boolean { return this.inFlight > 0 }

  inFlightCount(): number { return this.inFlight }

  /** Notify consumers only when voice work crosses the idle/busy boundary. */
  subscribe(listener: (active: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(active: boolean): void {
    for (const listener of this.listeners) {
      // A failed observer must not leave an admitted voice request without its release function.
      try { listener(active) } catch { /* Other observers still receive the transition. */ }
    }
  }
}
