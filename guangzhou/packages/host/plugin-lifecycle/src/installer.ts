/** Atomic, content-addressed installation of verified capability packages.
 *
 * Layout under the host-private root (all directories mode 0700):
 *
 * ```
 * <root>/generations/<identityKey>/<packageDigest>-<manifestFingerprint>/payload files
 * <root>/receipts/<identityKey>.json      durable installation receipt
 * <root>/journal/<identityKey>.json       in-progress transaction marker
 * <root>/.staging/<name>/payload files    uncommitted staging area
 * ```
 *
 * Commit protocol for one install: verify → stage → fsync → atomic `rename` into
 * the content-addressed generation → re-read and re-hash what is on disk →
 * register with the loader seam → atomically replace the receipt → drop the
 * journal. The receipt is the visibility commit point: a generation without a
 * matching receipt was never advertised and is rolled back by `recover()`.
 *
 * `recover()` is a host-startup step and must run once before any install in the
 * same process; a leftover journal makes `install()` fail loudly instead of
 * silently overwriting an unfinished transaction. It performs no network or
 * plugin-code work.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseCapabilityPluginManifest, type ComputeCapabilityPluginManifest } from '@deepseek-ai/dsh-compute-core/capability-manifest'
import type { ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { PluginLifecycleError } from './errors.ts'
import type { PluginLoaderRegistry } from './loader-registry.ts'
import { loadVerifiedPluginPackage, type PluginPackageAsset } from './package-intake.ts'
import { assertPluginPackageLimits, type PluginPackageLimits } from './package-payload.ts'
import type { PluginPackageSource } from './package-source.ts'
import { stagedPackageDigest, validatePluginInstallPlan, type PluginIdentity, type StagedPluginFile } from './staged-package.ts'

/** Host-owned storage, loader seam and process-boundary policy. */
export interface LocalPluginInstallerOptions {
  /** Private host directory owned by this installer only. */
  root: string
  /** Byte and file-count budget applied to packages and to on-disk generations. */
  limits: PluginPackageLimits
  /** Loader registration seam; the installer never calls a loader directly. */
  registry: PluginLoaderRegistry
  /**
   * Optional host hook awaited after advertisement is revoked and before any
   * file is deleted, so an uninstall cannot cut a running task's payload.
   */
  awaitInFlight?: (identity: PluginIdentity) => Promise<void>
  /** Generation directories kept per identity. Default 1 (replace semantics). */
  retainGenerations?: number
}

/** Durable record of one installed generation; the receipt is the commit point. */
export interface PluginInstallationReceipt extends PluginIdentity {
  formatVersion: 1
  packageDigest: string
  manifestFingerprint: string
  /** Verified manifest, kept so a restart can re-advertise without the market. */
  manifest: ComputeCapabilityPluginManifest
  grantedPermissions: readonly string[]
  /** Generation directory name under `<root>/generations/<identityKey>`. */
  generation: string
  files: readonly string[]
  assets: readonly PluginPackageAsset[]
  entryId?: string
  loaderSpecifier: string
  registryKind: string
  sourceKind: string
  installedAt: string
  /** True when this install replaced a different generation of the same identity. */
  replaced: boolean
}

/** Outcome of `recover()`; every list holds identity keys or relative names. */
export interface PluginCrashRecoveryReport {
  removedStaging: readonly string[]
  rolledBackGenerations: readonly string[]
  /** Generations removed because no receipt referenced them or their bytes no longer verified. */
  removedOrphanGenerations: readonly string[]
  droppedJournals: readonly string[]
  verifiedInstallations: readonly string[]
  invalidInstallations: readonly string[]
}

/** Outcome of `uninstall()`. */
export interface PluginUninstallResult {
  removed: boolean
  /** True when the loader seam was asked to revoke advertisement. */
  revoked: boolean
  /** True when a host `awaitInFlight` hook was awaited before deletion. */
  drained: boolean
}

interface InstallJournal {
  formatVersion: 1
  pluginId: string
  version: string
  packageDigest: string
  manifestFingerprint: string
  generation: string
  staging: string
}

interface CommitInput {
  identity: PluginIdentity
  plan: ComputePluginInstallPlan
  generation: string
  files: readonly string[]
  assets: readonly PluginPackageAsset[]
  entryId?: string
  loaderSpecifier: string
  sourceKind: string
  replaced: boolean
}

const GENERATION_PATTERN = /^[a-f0-9]{64}-[a-f0-9]{64}$/u

/**
 * Installs verified packages atomically and removes them without touching
 * in-flight work. It stores bytes and writes receipts; it never executes plugin
 * code, never loads a Cordis entry and never performs network I/O.
 */
export class LocalPluginInstaller {
  private readonly root: string
  private readonly retainGenerations: number
  private readonly locks = new Map<string, Promise<void>>()

  /** @param options - Private root, budget, loader seam and drain policy. */
  constructor(private readonly options: LocalPluginInstallerOptions) {
    assertPluginPackageLimits(options.limits)
    const retain = options.retainGenerations ?? 1
    if (!Number.isSafeInteger(retain) || retain < 1) throw new PluginLifecycleError('PLUGIN_INSTALLER_OPTIONS_INVALID')
    if (!options.registry || typeof options.registry.register !== 'function' || typeof options.registry.unregister !== 'function') throw new PluginLifecycleError('PLUGIN_INSTALLER_OPTIONS_INVALID')
    if (typeof options.root !== 'string' || options.root.length === 0) throw new PluginLifecycleError('PLUGIN_INSTALLER_OPTIONS_INVALID')
    this.root = resolve(options.root)
    this.retainGenerations = retain
  }

  /**
   * Install a verified plan from a package source.
   * @param plan - Frozen plan from the trust planner (signature and grants already checked).
   * @param source - Untrusted byte source; every byte is re-verified here.
   * @returns The committed receipt and whether the call reused an intact installation.
   */
  async install(plan: ComputePluginInstallPlan, source: PluginPackageSource): Promise<{ receipt: PluginInstallationReceipt; reused: boolean }> {
    validatePluginInstallPlan(plan)
    const identity: PluginIdentity = { pluginId: plan.manifest.pluginId, version: plan.manifest.version }
    return this.serial(identity, async () => {
      const existing = await this.readReceipt(identity)
      if (existing && existing.packageDigest === plan.packageDigest && existing.manifestFingerprint === plan.manifestFingerprint) {
        if (await this.generationMatches(existing)) return { receipt: existing, reused: true }
        // A receipt whose bytes no longer verify was never safely usable: fail
        // closed by retracting both the receipt and the corrupted generation,
        // otherwise the stale directory would block a fresh install.
        await this.removeReceipt(identity)
        await rm(await this.generationPath(identity, existing.generation), { recursive: true, force: true })
      }
      const verified = await loadVerifiedPluginPackage(source, plan, { limits: this.options.limits })
      const generation = `${plan.packageDigest}-${plan.manifestFingerprint}`
      const stagingName = randomBytes(12).toString('hex')
      const stagingRoot = await this.directory('.staging')
      const stagingDirectory = join(stagingRoot, stagingName)
      const destination = await this.generationPath(identity, generation)
      const journal: InstallJournal = { formatVersion: 1, pluginId: identity.pluginId, version: identity.version,
        packageDigest: plan.packageDigest, manifestFingerprint: plan.manifestFingerprint, generation, staging: stagingName }
      await this.writeJournal(identity, journal)
      let committed = false
      let created = false
      try {
        await mkdir(stagingDirectory, { mode: 0o700 })
        const payload = join(stagingDirectory, 'payload')
        await mkdir(payload, { mode: 0o700 })
        await writePayload(payload, verified.staged.files)
        await syncDirectory(payload)
        created = await this.promote(payload, destination, identity, generation, plan)
        if (created) await syncDirectory(await this.generationRoot(identity))
        const onDisk = await this.readGeneration(identity, generation)
        if (stagedPackageDigest(onDisk) !== plan.packageDigest) throw new PluginLifecycleError('PLUGIN_DIGEST_MISMATCH')
        const specifier = await this.options.registry.register({
          identity,
          directory: destination,
          manifest: plan.manifest,
          ...(verified.entryId === undefined ? {} : { entryId: verified.entryId }),
        })
        const receipt = await this.commitReceipt({
          identity, plan, generation, files: onDisk.map(file => file.path), assets: verified.assets,
          ...(verified.entryId === undefined ? {} : { entryId: verified.entryId }),
          loaderSpecifier: specifier, sourceKind: verified.sourceKind, replaced: existing !== undefined,
        })
        committed = true
        await this.dropJournal(identity)
        await this.pruneGenerations(await this.generationRoot(identity), generation)
        return { receipt, reused: false }
      } finally {
        await rm(stagingDirectory, { recursive: true, force: true })
        if (!committed) {
          // Nothing was advertised, so the promoted directory must not linger.
          if (created) await rm(destination, { recursive: true, force: true })
          await this.dropJournal(identity)
        }
      }
    })
  }

  /**
   * Revoke advertisement, drain in-flight work, then delete files and receipt.
   * Repeated calls are idempotent and never affect a task that already started.
   * @param identity - Exact installed plugin and version.
   * @returns What the call actually did.
   */
  async uninstall(identity: PluginIdentity): Promise<PluginUninstallResult> {
    assertIdentity(identity)
    return this.serial(identity, async () => {
      const receipt = await this.readReceipt(identity)
      if (!receipt) return { removed: false, revoked: false, drained: false }
      await this.options.registry.unregister(identity)
      const drained = this.options.awaitInFlight !== undefined
      if (this.options.awaitInFlight) await this.options.awaitInFlight(identity)
      // Removing the receipt first makes the removal visible even if the process
      // dies mid-delete; `recover()` then cleans the orphan directory.
      await this.removeReceipt(identity)
      await rm(await this.generationRoot(identity), { recursive: true, force: true })
      return { removed: true, revoked: true, drained }
    })
  }

  /**
   * Inspect one installation without re-reading its payload.
   * @param identity - Exact plugin and version.
   * @returns Stored receipt, or undefined when nothing is installed.
   */
  async getInstallation(identity: PluginIdentity): Promise<PluginInstallationReceipt | undefined> {
    assertIdentity(identity)
    return this.readReceipt(identity)
  }

  /** List every stored receipt (for restart-time re-advertisement). */
  async listInstallations(): Promise<readonly PluginInstallationReceipt[]> {
    const directory = await this.directory('receipts')
    const receipts: PluginInstallationReceipt[] = []
    for (const name of await listNames(directory)) {
      if (!name.endsWith('.json')) continue
      receipts.push(parseReceipt(await this.readJson(join(directory, name), directory)))
    }
    return Object.freeze(receipts)
  }

  /**
   * Re-hash the on-disk generation and compare it with the receipt.
   * @param identity - Exact plugin and version.
   * @returns True only when the payload still matches the receipt digest.
   */
  async verifyInstallation(identity: PluginIdentity): Promise<boolean> {
    assertIdentity(identity)
    const receipt = await this.readReceipt(identity)
    return receipt === undefined ? false : this.generationMatches(receipt)
  }

  /**
   * Absolute payload directory for a receipt, to hand to the loader seam.
   * @param receipt - Receipt returned by `install`, `getInstallation` or `listInstallations`.
   */
  async directoryOf(receipt: PluginInstallationReceipt): Promise<string> {
    return this.generationPath(receipt, receipt.generation)
  }

  /**
   * Clean up transactions interrupted by a crash; run once at host startup.
   * A generation without a matching receipt was never advertised, so it is
   * rolled back instead of published. An aborted upgrade never retracts the
   * previously committed generation.
   * @returns Everything that was removed, kept or found invalid.
   */
  async recover(): Promise<PluginCrashRecoveryReport> {
    const stagingRoot = await this.directory('.staging')
    const journalRoot = await this.directory('journal')
    const generations = await this.directory('generations')
    const stagingNames = await listNames(stagingRoot)
    const journals = new Map<string, InstallJournal>()
    for (const name of await listNames(journalRoot)) {
      if (!name.endsWith('.json')) continue
      journals.set(name.slice(0, -'.json'.length), parseJournal(await this.readJson(join(journalRoot, name), journalRoot)))
    }
    const referencedStaging = new Set([...journals.values()].map(journal => journal.staging))
    const removedStaging: string[] = []
    const rolledBackGenerations: string[] = []
    const removedOrphanGenerations: string[] = []
    const droppedJournals: string[] = []
    const verifiedInstallations: string[] = []
    const invalidInstallations: string[] = []

    for (const [identityKeyValue, journal] of journals) {
      const receipt = await this.readReceiptByKey(identityKeyValue)
      const journalGeneration = join(generations, identityKeyValue, journal.generation)
      const committedHere = receipt !== undefined && receipt.packageDigest === journal.packageDigest
        && receipt.manifestFingerprint === journal.manifestFingerprint && receipt.generation === journal.generation
      if (committedHere) {
        // The transaction committed; only the journal marker is left behind.
        if (await isDirectory(journalGeneration)) verifiedInstallations.push(identityKeyValue)
        else { await this.removeReceiptByKey(identityKeyValue); invalidInstallations.push(identityKeyValue) }
      } else if (await isDirectory(journalGeneration)) {
        // Uncommitted promotion: roll it back and keep any earlier receipt.
        await rm(journalGeneration, { recursive: true, force: true })
        rolledBackGenerations.push(`${identityKeyValue}/${journal.generation}`)
      }
      await this.removeJournalByKey(identityKeyValue)
      droppedJournals.push(identityKeyValue)
    }

    for (const name of stagingNames) {
      if (referencedStaging.has(name)) continue
      // A crash between mkdir and the journal write leaves an unreferenced
      // staging directory; it was never part of a commit.
      await rm(join(stagingRoot, name), { recursive: true, force: true })
      removedStaging.push(name)
    }

    for (const identityKeyValue of await listNames(generations)) {
      const identityDirectory = join(generations, identityKeyValue)
      if (!(await isDirectory(identityDirectory))) continue
      const names = await listNames(identityDirectory)
      const receipt = await this.readReceiptByKey(identityKeyValue)
      if (!receipt) {
        for (const name of names) {
          await rm(join(identityDirectory, name), { recursive: true, force: true })
          removedOrphanGenerations.push(`${identityKeyValue}/${name}`)
        }
        continue
      }
      if (!names.includes(receipt.generation) || !(await this.generationMatches(receipt))) {
        // Fail closed: never advertise bytes that no longer verify, and drop the
        // unusable payload so a later install is not blocked by it.
        await this.removeReceiptByKey(identityKeyValue)
        invalidInstallations.push(identityKeyValue)
        for (const name of names) {
          await rm(join(identityDirectory, name), { recursive: true, force: true })
          removedOrphanGenerations.push(`${identityKeyValue}/${name}`)
        }
        continue
      }
      verifiedInstallations.push(identityKeyValue)
      await this.pruneGenerations(identityDirectory, receipt.generation, removedOrphanGenerations, identityKeyValue)
    }

    return {
      removedStaging: Object.freeze(removedStaging),
      rolledBackGenerations: Object.freeze(rolledBackGenerations),
      removedOrphanGenerations: Object.freeze(removedOrphanGenerations),
      droppedJournals: Object.freeze(droppedJournals),
      verifiedInstallations: Object.freeze([...new Set(verifiedInstallations)]),
      invalidInstallations: Object.freeze([...new Set(invalidInstallations)]),
    }
  }

  /** Atomically publish the staged payload; identical content is reused. */
  private async promote(payload: string, destination: string, identity: PluginIdentity, generation: string, plan: ComputePluginInstallPlan): Promise<boolean> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    try {
      await rename(payload, destination)
      return true
    } catch (error) {
      if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EISDIR')) throw error
      // Identical content identity already on disk: keep the committed copy and
      // prove it still matches before the receipt points at it.
      const existing = await this.readGeneration(identity, generation)
      if (stagedPackageDigest(existing) !== plan.packageDigest) throw new PluginLifecycleError('PLUGIN_DIGEST_MISMATCH')
      return false
    }
  }

  private async commitReceipt(input: CommitInput): Promise<PluginInstallationReceipt> {
    const receipt: PluginInstallationReceipt = {
      formatVersion: 1,
      pluginId: input.identity.pluginId,
      version: input.identity.version,
      packageDigest: input.plan.packageDigest,
      manifestFingerprint: input.plan.manifestFingerprint,
      manifest: input.plan.manifest,
      grantedPermissions: Object.freeze([...input.plan.grantedPermissions]),
      generation: input.generation,
      files: Object.freeze([...input.files]),
      assets: Object.freeze([...input.assets]),
      ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
      loaderSpecifier: input.loaderSpecifier,
      registryKind: this.options.registry.kind,
      sourceKind: input.sourceKind,
      installedAt: new Date().toISOString(),
      replaced: input.replaced,
    }
    const destination = await this.receiptPath(input.identity)
    const temporary = `${destination}.${randomBytes(6).toString('hex')}.tmp`
    await writeExclusive(temporary, Buffer.from(JSON.stringify(receipt)))
    try { await rename(temporary, destination) } finally { await rm(temporary, { force: true }) }
    return Object.freeze(receipt)
  }

  /** Keep `keep` plus the newest retained generations; report what was removed. */
  private async pruneGenerations(directory: string, keep: string, removed?: string[], prefix?: string): Promise<void> {
    const names = (await listNames(directory)).filter(name => name !== keep)
    const ordered: { name: string; modified: number }[] = []
    for (const name of names) {
      try { ordered.push({ name, modified: (await lstat(join(directory, name))).mtimeMs }) } catch { /* Raced away; nothing to prune. */ }
    }
    ordered.sort((left, right) => right.modified - left.modified)
    for (const item of ordered.slice(Math.max(0, this.retainGenerations - 1))) {
      await rm(join(directory, item.name), { recursive: true, force: true })
      if (removed && prefix !== undefined) removed.push(`${prefix}/${item.name}`)
    }
  }

  private async generationMatches(receipt: PluginInstallationReceipt): Promise<boolean> {
    try {
      const files = await this.readGeneration(receipt, receipt.generation)
      return stagedPackageDigest(files) === receipt.packageDigest
    } catch { return false }
  }

  /** Re-read one generation from disk under the full budget, refusing links. */
  private async readGeneration(identity: PluginIdentity, generation: string): Promise<StagedPluginFile[]> {
    if (!GENERATION_PATTERN.test(generation)) throw new PluginLifecycleError('PLUGIN_INSTALLER_OPTIONS_INVALID')
    const directory = await this.generationPath(identity, generation)
    await assertRealDirectory(directory)
    const files: StagedPluginFile[] = []
    let bytes = 0
    const visit = async (current: string, prefix: string): Promise<void> => {
      for (const item of await readdir(current, { withFileTypes: true })) {
        const relative = prefix + item.name
        if (item.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
        if (item.isDirectory()) { await visit(join(current, item.name), relative + '/'); continue }
        if (!item.isFile()) throw new PluginLifecycleError('PLUGIN_PACKAGE_SOURCE_INVALID')
        if (files.length + 1 > this.options.limits.maxFileCount) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
        const path = join(current, item.name)
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
        if (stat.size > this.options.limits.maxFileBytes || bytes + stat.size > this.options.limits.maxPackageBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
        const canonical = await realpath(path)
        if (!canonical.startsWith(directory + sep)) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
        const content = await readFile(path)
        bytes += content.byteLength
        files.push({ path: relative, bytes: content })
      }
    }
    await visit(directory, '')
    return files.sort((left, right) => left.path.localeCompare(right.path))
  }

  private async readReceipt(identity: PluginIdentity): Promise<PluginInstallationReceipt | undefined> {
    return this.readReceiptByKey(identityKey(identity), identity)
  }

  private async readReceiptByKey(identityKeyValue: string, expected?: PluginIdentity): Promise<PluginInstallationReceipt | undefined> {
    const directory = await this.directory('receipts')
    let value: unknown
    try { value = await this.readJson(join(directory, identityKeyValue + '.json'), directory) } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined
      throw error
    }
    const receipt = parseReceipt(value)
    if (identityKey(receipt) !== identityKeyValue
      || (expected !== undefined && (receipt.pluginId !== expected.pluginId || receipt.version !== expected.version))) {
      throw new PluginLifecycleError('PLUGIN_INSTALLER_RECEIPT_INVALID')
    }
    return receipt
  }

  private async removeReceipt(identity: PluginIdentity): Promise<void> { return this.removeReceiptByKey(identityKey(identity)) }

  private async removeReceiptByKey(identityKeyValue: string): Promise<void> {
    await rm(join(await this.directory('receipts'), identityKeyValue + '.json'), { force: true })
  }

  private async writeJournal(identity: PluginIdentity, journal: InstallJournal): Promise<void> {
    const directory = await this.directory('journal')
    const path = join(directory, identityKey(identity) + '.json')
    if (await exists(path)) throw new PluginLifecycleError('PLUGIN_INSTALLER_RECOVERY_REQUIRED')
    await writeExclusive(path, Buffer.from(JSON.stringify(journal)))
  }

  private async dropJournal(identity: PluginIdentity): Promise<void> { return this.removeJournalByKey(identityKey(identity)) }

  private async removeJournalByKey(identityKeyValue: string): Promise<void> {
    await rm(join(await this.directory('journal'), identityKeyValue + '.json'), { force: true })
  }

  private async receiptPath(identity: PluginIdentity): Promise<string> {
    return join(await this.directory('receipts'), identityKey(identity) + '.json')
  }

  private async generationRoot(identity: PluginIdentity): Promise<string> {
    const path = join(await this.directory('generations'), identityKey(identity))
    await mkdir(path, { recursive: true, mode: 0o700 })
    return path
  }

  private async generationPath(identity: PluginIdentity, generation: string): Promise<string> {
    return join(await this.generationRoot(identity), generation)
  }

  private async directory(child: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await assertRealDirectory(this.root)
    const root = await realpath(this.root)
    if (child === '') return root
    const path = join(root, child)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await assertRealDirectory(path)
    return path
  }

  private async readJson(path: string, parent: string): Promise<unknown> {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
    if (stat.size > this.options.limits.maxPackageBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    const canonical = await realpath(path)
    if (!canonical.startsWith(parent + sep)) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
    const bytes = await readFile(path)
    try { return JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new PluginLifecycleError('PLUGIN_INSTALLER_RECEIPT_INVALID') }
  }

  private async serial<T>(identity: PluginIdentity, operation: () => Promise<T>): Promise<T> {
    const key = `${identity.pluginId}\u0000${identity.version}`
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.then(() => current)
    this.locks.set(key, chain)
    await previous
    try { return await operation() } finally { release(); if (this.locks.get(key) === chain) this.locks.delete(key) }
  }
}

async function writePayload(directory: string, files: readonly StagedPluginFile[]): Promise<void> {
  for (const file of files) {
    const path = join(directory, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeExclusive(path, file.bytes)
  }
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

/** Directory fsync is best-effort: some platforms refuse it, file fsync never is. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch { /* Durability hint only; the rename itself is still atomic. */ }
}

async function assertRealDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function isDirectory(path: string): Promise<boolean> {
  try { const stat = await lstat(path); return stat.isDirectory() && !stat.isSymbolicLink() } catch { return false }
}

async function listNames(directory: string): Promise<string[]> {
  try { return await readdir(directory) } catch (error) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
}

function parseReceipt(value: unknown): PluginInstallationReceipt {
  if (!isObject(value) || value.formatVersion !== 1 || typeof value.pluginId !== 'string' || typeof value.version !== 'string'
    || !isDigest(value.packageDigest) || !isDigest(value.manifestFingerprint) || typeof value.generation !== 'string'
    || !Array.isArray(value.files) || !value.files.every(file => typeof file === 'string')
    || typeof value.loaderSpecifier !== 'string' || typeof value.installedAt !== 'string'
    || typeof value.registryKind !== 'string' || typeof value.sourceKind !== 'string'
    || !Array.isArray(value.grantedPermissions) || !value.grantedPermissions.every(permission => typeof permission === 'string')
    || typeof value.replaced !== 'boolean' || !GENERATION_PATTERN.test(value.generation)) {
    throw new PluginLifecycleError('PLUGIN_INSTALLER_RECEIPT_INVALID')
  }
  let manifest: ComputeCapabilityPluginManifest
  try { manifest = parseCapabilityPluginManifest(value.manifest) } catch { throw new PluginLifecycleError('PLUGIN_INSTALLER_RECEIPT_INVALID') }
  if (manifest.pluginId !== value.pluginId || manifest.version !== value.version) throw new PluginLifecycleError('PLUGIN_INSTALLER_RECEIPT_INVALID')
  return Object.freeze({
    formatVersion: 1,
    pluginId: value.pluginId,
    version: value.version,
    packageDigest: value.packageDigest,
    manifestFingerprint: value.manifestFingerprint,
    manifest,
    grantedPermissions: Object.freeze([...value.grantedPermissions]),
    generation: value.generation,
    files: Object.freeze([...value.files]),
    assets: Object.freeze(Array.isArray(value.assets) ? value.assets.filter(isAsset) : []),
    ...(typeof value.entryId === 'string' ? { entryId: value.entryId } : {}),
    loaderSpecifier: value.loaderSpecifier,
    registryKind: value.registryKind,
    sourceKind: value.sourceKind,
    installedAt: value.installedAt,
    replaced: value.replaced,
  })
}

function parseJournal(value: unknown): InstallJournal {
  if (!isObject(value) || value.formatVersion !== 1 || typeof value.pluginId !== 'string' || typeof value.version !== 'string'
    || !isDigest(value.packageDigest) || !isDigest(value.manifestFingerprint)
    || typeof value.generation !== 'string' || !GENERATION_PATTERN.test(value.generation)
    || typeof value.staging !== 'string' || !/^[a-f0-9]{24}$/u.test(value.staging)) {
    throw new PluginLifecycleError('PLUGIN_INSTALLER_JOURNAL_INVALID')
  }
  return { formatVersion: 1, pluginId: value.pluginId, version: value.version, packageDigest: value.packageDigest,
    manifestFingerprint: value.manifestFingerprint, generation: value.generation, staging: value.staging }
}

function assertIdentity(identity: PluginIdentity): void {
  if (!isObject(identity) || typeof identity.pluginId !== 'string' || !identity.pluginId
    || typeof identity.version !== 'string' || !identity.version
    || identity.pluginId.includes('\u0000') || identity.version.includes('\u0000')
    || identity.pluginId.includes('/') || identity.version.includes('/')) {
    throw new PluginLifecycleError('PLUGIN_IDENTITY_INVALID')
  }
}

function identityKey(identity: PluginIdentity): string {
  return createHash('sha256').update(JSON.stringify([identity.pluginId, identity.version])).digest('hex')
}

function isAsset(value: unknown): value is PluginPackageAsset {
  return isObject(value) && typeof value.path === 'string' && typeof value.bytes === 'number' && typeof value.sha256 === 'string'
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function hasCode(error: unknown, code: string): boolean { return isObject(error) && error.code === code }
