/** Transactional lifecycle for already verified local capability-plugin packages.
 *
 * The module owns state transitions and input validation. A deployment adapter
 * owns filesystem atomicity and process isolation; this package never imports,
 * evaluates or executes plugin code.
 */
import type { ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { PluginLifecycleError } from './errors.ts'
import { validatePluginInstallPlan, verifyStagedPluginPackage, type PluginIdentity, type StagedPluginPackage } from './staged-package.ts'

/** Deployment-owned filesystem/process seam. Implementations must be atomic. */
export interface PluginLifecycleDeployment {
  /** Read bytes and metadata from a trusted staging area. */
  readStagedPackage(plan: ComputePluginInstallPlan): Promise<StagedPluginPackage>
  /** Atomically activate the staged package without running untrusted code in this process. */
  activate(identity: PluginIdentity, staged: StagedPluginPackage): Promise<void>
  /** Stop a previously activated package. */
  deactivate(identity: PluginIdentity): Promise<void>
  /** Remove staged and active package data after deactivation. */
  remove(identity: PluginIdentity): Promise<void>
}

/** Observable lifecycle phase. */
export type PluginLifecyclePhase = 'staged' | 'active' | 'disabled' | 'rolled_back'
/** Current state retained by the in-process coordinator. */
export interface PluginLifecycleRecord extends PluginIdentity {
  phase: PluginLifecyclePhase
  packageDigest: string
  manifestFingerprint: string
}

/** Coordinates serialized install, disable and uninstall operations per plugin. */
export class PluginLifecycle {
  private readonly records = new Map<string, { record: PluginLifecycleRecord; package: StagedPluginPackage }>()
  private readonly locks = new Map<string, Promise<void>>()
  /** @param deployment - Adapter for staged bytes and atomic process/filesystem actions. */
  constructor(private readonly deployment: PluginLifecycleDeployment) {}

  /** Install a verified plan idempotently, rolling back on every activation failure. */
  async install(plan: ComputePluginInstallPlan): Promise<PluginLifecycleRecord> {
    validatePluginInstallPlan(plan)
    const identity = identityOf(plan)
    return this.serial(identity, async () => {
      const current = this.records.get(key(identity))
      if (current?.record.phase === 'active' && current.record.packageDigest === plan.packageDigest
        && current.record.manifestFingerprint === plan.manifestFingerprint) return current.record
      const staged = await this.deployment.readStagedPackage(plan)
      verifyStagedPluginPackage(plan, staged)
      const stagedRecord: PluginLifecycleRecord = Object.freeze({ ...identity, phase: 'staged' as const, packageDigest: plan.packageDigest, manifestFingerprint: plan.manifestFingerprint })
      const previous = current?.record.phase === 'active' ? current : undefined
      this.records.set(key(identity), { record: stagedRecord, package: staged })
      try {
        await this.deployment.activate(identity, staged)
        if (previous) await this.deployment.deactivate(identity)
        const active = Object.freeze({ ...stagedRecord, phase: 'active' as const })
        this.records.set(key(identity), { record: active, package: staged })
        return active
      } catch (error) {
        try { await this.deployment.deactivate(identity) } catch { /* Preserve the activation failure and continue rollback. */ }
        if (previous) {
          try {
            await this.deployment.activate(identity, previous.package)
          } catch { /* Preserve rolled_back state; deployment must surface recovery. */ }
        } else {
          try { await this.deployment.remove(identity) } catch { /* Preserve rolled_back state; deployment must surface recovery. */ }
        }
        this.records.set(key(identity), { record: Object.freeze({ ...stagedRecord, phase: 'rolled_back' as const }), package: staged })
        throw error
      }
    })
  }

  /** Deactivate an active plugin while retaining its staged bytes for reactivation. */
  async disable(identity: PluginIdentity): Promise<PluginLifecycleRecord> {
    return this.serial(identity, async () => {
      const current = this.records.get(key(identity))
      if (!current) throw new PluginLifecycleError('PLUGIN_NOT_INSTALLED')
      if (current.record.phase === 'disabled') return current.record
      if (current.record.phase !== 'active') throw new PluginLifecycleError('PLUGIN_NOT_ACTIVE')
      await this.deployment.deactivate(identity)
      const disabled = Object.freeze({ ...current.record, phase: 'disabled' as const })
      this.records.set(key(identity), { record: disabled, package: current.package })
      return disabled
    })
  }

  /** Deactivate and remove all package data; repeated calls are idempotent. */
  async uninstall(identity: PluginIdentity): Promise<void> {
    return this.serial(identity, async () => {
      const current = this.records.get(key(identity))
      if (!current) return
      if (current.record.phase === 'active') await this.deployment.deactivate(identity)
      await this.deployment.remove(identity)
      this.records.delete(key(identity))
    })
  }

  /** Read a frozen state snapshot for an installed identity. */
  get(identity: PluginIdentity): PluginLifecycleRecord | undefined { return this.records.get(key(identity))?.record }

  private async serial<T>(identity: PluginIdentity, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key(identity)) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.locks.set(key(identity), chain)
    await previous
    try { return await operation() } finally { release(); if (this.locks.get(key(identity)) === chain) this.locks.delete(key(identity)) }
  }
}

function identityOf(plan: ComputePluginInstallPlan): PluginIdentity {
  return { pluginId: plan.manifest.pluginId, version: plan.manifest.version }
}
function key(identity: PluginIdentity): string { return `${identity.pluginId}\u0000${identity.version}` }
