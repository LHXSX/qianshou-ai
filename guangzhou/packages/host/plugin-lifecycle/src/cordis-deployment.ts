/** Cordis Loader adapter for the transactional lifecycle.
 *
 * The adapter only receives a trusted entry specifier from the staging layer; it
 * never reads archives or evaluates package bytes.
 */
import type { ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { PluginLifecycleError } from './errors.ts'
import type { PluginLifecycleDeployment } from './plugin-lifecycle.ts'
import type { PluginIdentity, StagedPluginPackage } from './staged-package.ts'

/** Narrow seam for the real Cordis Loader API used by the deployment adapter. */
export interface CordisLoaderLike {
  create(options: { name: string; config?: unknown; disabled?: boolean }): Promise<string>
  update(id: string, options: { disabled?: boolean }): Promise<void>
  remove(id: string): Promise<void>
  await(): Promise<void>
  resolve?(id: string): { fiber?: { await(): Promise<unknown> } }
}

/** Options for wiring verified staged packages to a host Cordis Loader. */
export interface CordisLoaderDeploymentOptions {
  loader: CordisLoaderLike
  readStagedPackage: PluginLifecycleDeployment['readStagedPackage']
  /** Resolve an entry only from trusted, already-scanned staging metadata. */
  entrySpecifier(identity: PluginIdentity, staged: StagedPluginPackage): string
}

interface LoaderRecord { id: string; active: boolean; packageDigest: string }

/**
 * Cordis Loader adapter for the transactional lifecycle.
 *
 * The adapter only receives a trusted entry specifier from the staging layer;
 * it never reads archives or evaluates package bytes. Loader `await()` and the
 * owning fiber's `await()` are both used as the drain barrier before a state
 * transition is reported to the lifecycle coordinator.
 */
export class CordisLoaderDeployment implements PluginLifecycleDeployment {
  private readonly entries = new Map<string, LoaderRecord[]>()
  private failedActivation = new Set<string>()

  constructor(private readonly options: CordisLoaderDeploymentOptions) {}

  readStagedPackage(plan: ComputePluginInstallPlan): Promise<StagedPluginPackage> {
    return this.options.readStagedPackage(plan)
  }

  async activate(identity: PluginIdentity, staged: StagedPluginPackage): Promise<void> {
    const records = this.entries.get(key(identity)) ?? []
    const existing = records.find(record => record.active && record.packageDigest === staged.packageDigest)
    if (existing) {
      await this.drain(existing.id)
      return
    }
    const name = this.options.entrySpecifier(identity, staged)
    assertPluginLoaderSpecifier(name)
    const id = await this.options.loader.create({ name, config: staged.entryConfig })
    records.push({ id, active: true, packageDigest: staged.packageDigest })
    this.entries.set(key(identity), records)
    try {
      await this.drain(id)
    } catch (error) {
      // Keep the entry visible so PluginLifecycle can deactivate the failed
      // generation and perform its normal rollback path.
      this.failedActivation.add(key(identity))
      throw error
    }
  }

  async deactivate(identity: PluginIdentity): Promise<void> {
    const records = this.entries.get(key(identity))
    if (!records) return
    const active = records.filter(record => record.active)
    if (!active.length) return
    const failed = this.failedActivation.delete(key(identity))
    // Replacement activation drains the new generation before the lifecycle
    // asks us to stop the old one. A failed generation is the reverse case.
    const record = failed || active.length === 1 ? active.at(-1) : active[0]
    if (!record) return
    await this.options.loader.update(record.id, { disabled: true })
    await this.drain(record.id)
    record.active = false
  }

  async remove(identity: PluginIdentity): Promise<void> {
    const records = this.entries.get(key(identity))
    if (!records) return
    for (const record of [...records].reverse()) {
      if (record.active) {
        await this.options.loader.update(record.id, { disabled: true })
        await this.drain(record.id)
        record.active = false
      }
      await this.options.loader.remove(record.id)
      await this.options.loader.await()
    }
    this.entries.delete(key(identity))
    this.failedActivation.delete(key(identity))
  }

  private async drain(id: string): Promise<void> {
    await this.options.loader.await()
    const resolved = this.options.loader.resolve?.(id)
    const fiber = resolved ? resolved.fiber : undefined
    if (fiber) await fiber.await()
    await this.options.loader.await()
  }
}

/** Prefix of the one absolute form a specifier may take: a canonical `file:` URL. */
const FILE_URL_PREFIX = 'file://'

/**
 * Reject a specifier that could escape the host's loader root.
 *
 * Two accepted forms:
 * - a bare, relative package/entry specifier, which the Loader resolves against
 *   its own root (no leading `/`, no Windows drive letter, no `.`/`..` segment);
 * - a canonical `file:` URL, the form the installer's registry produces for one
 *   verified generation directory. The URL is already absolute, so the traversal
 *   rules that apply to a bare specifier (no `/`-prefixed path, no `..` segment,
 *   no backslash, no control byte, no whitespace) are the ones enforced here.
 * @param value - Candidate loader specifier.
 * @throws PluginLifecycleError when the value is neither form.
 */
export function assertPluginLoaderSpecifier(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000') || value.includes('\\')
    || value.split('/').includes('..') || /\s/u.test(value)) {
    throw new PluginLifecycleError('PLUGIN_ENTRY_SPECIFIER_INVALID')
  }
  if (value.startsWith(FILE_URL_PREFIX)) {
    // `file:` URLs carry no scheme-relative host in this codebase (`file:///…`),
    // so exactly the empty authority is accepted; anything else would name a host.
    if (!value.startsWith(`${FILE_URL_PREFIX}/`) || value.split('/').some(part => part === '.')) {
      throw new PluginLifecycleError('PLUGIN_ENTRY_SPECIFIER_INVALID')
    }
    return
  }
  if (value.startsWith('/') || /^[a-z]:/iu.test(value) || value.split('/').some(part => part === '.')) {
    throw new PluginLifecycleError('PLUGIN_ENTRY_SPECIFIER_INVALID')
  }
}

function key(identity: PluginIdentity): string { return `${identity.pluginId}\u0000${identity.version}` }
