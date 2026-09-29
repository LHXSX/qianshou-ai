/** Synchronous admission reservations shared by work-owning services. */
export class WorkAdmission {
  private readonly guards = new Set<() => void>()
  private pendingCount = 0

  /** Reservations whose owner has not yet committed or abandoned admission. */
  get pending(): number { return this.pendingCount }

  /**
   * Install one synchronous veto; callers attach its disposer to their effect scope.
   * @param guard - throws before work can be admitted.
   * @returns an idempotent disposer for this registration only.
   */
  register(guard: () => void): () => void {
    const entry = () => { guard() }
    this.guards.add(entry)
    return () => { this.guards.delete(entry) }
  }

  /**
   * Reserve admission before invoking guards, including against synchronous reentry.
   * @returns an idempotent release called after commit or rollback, including asynchronous setup.
   * @throws the guard's refusal without retaining a reservation.
   */
  acquire(): () => void {
    this.pendingCount += 1
    try {
      for (const guard of this.guards) guard()
    } catch (error: unknown) {
      this.pendingCount -= 1
      throw error
    }
    let held = true
    return () => {
      if (!held) return
      held = false
      this.pendingCount -= 1
    }
  }
}
