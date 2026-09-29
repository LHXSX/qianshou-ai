/** Bounded update intentions owned by one running profile manager. */
import { randomUUID } from 'node:crypto'
import type { PluginUpdateCurrent, PluginUpdateInspectionId, PluginUpdateTarget } from './types.ts'

/** Exact current and target identity kept until an update is admitted or expires. */
export interface UpdatePlan {
  readonly inspectionId: PluginUpdateInspectionId
  readonly expiresAt: number
  readonly current: PluginUpdateCurrent
  readonly target: PluginUpdateTarget
}

/** Fifteen-minute update inspections, capped at 32 and removed with their plugin owner. */
export class UpdatePlans {
  private readonly plans = new Map<PluginUpdateInspectionId, UpdatePlan>()

  /**
   * Retain a detached inspection without allowing callers to change its target.
   * @param current - Installed identity observed before lookup.
   * @param target - Exact registry version, never a mutable tag or range.
   * @returns The new bounded inspection.
   */
  add(current: PluginUpdateCurrent, target: PluginUpdateTarget): UpdatePlan {
    this.prune()
    while (this.plans.size >= 32) {
      const oldest = this.plans.keys().next().value
      if (oldest !== undefined) this.plans.delete(oldest)
    }
    const plan = Object.freeze({ inspectionId: randomUUID() as PluginUpdateInspectionId, expiresAt: Date.now() + 15 * 60_000,
      current: Object.freeze({ ...current }), target: Object.freeze({ ...target }) })
    this.plans.set(plan.inspectionId, plan)
    return plan
  }

  /**
   * Resolve a still-current process-local inspection.
   * @param id - Opaque inspection identity.
   * @returns The plan, or undefined after expiry, eviction, success or teardown.
   */
  get(id: PluginUpdateInspectionId): UpdatePlan | undefined { this.prune(); return this.plans.get(id) }

  /** Release a successfully consumed inspection.
   * @param id - Successfully consumed inspection identity.
   */
  delete(id: PluginUpdateInspectionId): void { this.plans.delete(id) }

  /** Release all inspections on manager disposal. */
  clear(): void { this.plans.clear() }

  private prune(): void {
    for (const [id, plan] of this.plans) if (plan.expiresAt <= Date.now()) this.plans.delete(id)
  }
}

/**
 * Compare the state whose replacement the user inspected.
 * @param left - The earlier installed observation.
 * @param right - Current observation made under the profile writer lock.
 * @returns Whether identity, dependency spec and activation selection still agree.
 */
export function sameUpdateCurrent(left: PluginUpdateCurrent, right: PluginUpdateCurrent): boolean {
  return left.name === right.name && left.version === right.version && left.spec === right.spec && left.enabled === right.enabled
}

/**
 * Admit only a complete registry version for a replacement target.
 * @param value - Registry metadata's version field.
 * @returns Whether the version is an exact SemVer value, not a range or tag.
 */
export function exactPackageVersion(value: string): boolean {
  return value.length <= 128 && EXACT_VERSION.test(value)
}

const EXACT_VERSION = new RegExp('^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)'
  + '(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$')
