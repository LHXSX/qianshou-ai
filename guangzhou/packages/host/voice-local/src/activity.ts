/** Host-visible projection of real local voice work; this plugin is its only writer. */

/**
 * Report whether the owner is using voice on this machine right now.
 *
 * Owner and lifetime: `apply` creates exactly one instance and publishes it as the Cordis service
 * `voiceActivity` on the plugin's own fiber, so the projection appears and disappears with the plugin. A consumer
 * that cannot find the service must keep voice activity unknown; absence is never an idle observation.
 *
 * Reading: `active()` and `inFlightCount()` are synchronous and perform no I/O, so a supply probe can sample the
 * projection while a request is being served. `false` is a real observation: this producer is loaded and no local
 * voice request is in flight.
 *
 * Counting: a slot is held for the whole time one local voice request is being served — audio upload and
 * recognition for `/api/forge/voice/transcribe`, and JSON upload plus synthesis for `/api/forge/voice/synthesize`.
 * Only requests that passed admission hold a slot, and every slot is released on success, failure, cancellation
 * or upload timeout.
 */
export class VoiceActivityProjection {
  private inFlight = 0

  /**
   * Reserve one slot for a local voice request that is about to be served.
   * @returns Idempotent release; calling it twice never frees another request's slot.
   */
  hold(): () => void {
    this.inFlight += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.inFlight -= 1
    }
  }

  /** Number of local voice requests being served right now, including upload, recognition and synthesis.
   * @returns The number of slots currently held.
   */
  inFlightCount(): number {
    return this.inFlight
  }

  /** Whether at least one real local voice request is in flight right now.
   * @returns True while the owner's voice work is actually being served on this machine.
   */
  active(): boolean {
    return this.inFlight > 0
  }
}
