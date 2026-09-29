/** Filesystem persistence for verified capability packages; no plugin code runs here. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { PluginLifecycleError } from './errors.ts'
import { canonicalPluginPath } from './package-path.ts'
import { verifyStagedPluginPackage, type PluginIdentity, type StagedPluginFile, type StagedPluginPackage } from './staged-package.ts'

/** Host-owned private storage and explicit resource limits. */
export interface LocalPluginStoreOptions {
  root: string
  maxBundleBytes: number
  maxFileCount: number
}

/** Persisted owner preference; it does not claim that a process or capability is live. */
export interface LocalPluginInstallation extends PluginIdentity {
  packageDigest: string
  manifestFingerprint: string
  desiredState: 'enabled' | 'disabled'
}

interface StoredPackage {
  formatVersion: 1
  manifest: unknown
  packageDigest: string
  files: string[]
}

/**
 * Stores content-addressed packages and atomic installation preferences.
 * A fresh authorized plan is required when reading a package after restart.
 * The caller must stop the loader before forgetting an installed identity.
 */
export class LocalPluginStore {
  private readonly options: LocalPluginStoreOptions

  /** @param options - A private Host-owned directory and positive storage limits. */
  constructor(options: LocalPluginStoreOptions) {
    if (!Number.isSafeInteger(options.maxBundleBytes) || options.maxBundleBytes < 1
      || !Number.isSafeInteger(options.maxFileCount) || options.maxFileCount < 1) {
      throw new PluginLifecycleError('PLUGIN_STORE_LIMIT_INVALID')
    }
    this.options = { ...options, root: resolve(options.root) }
  }

  /**
   * Persist verified bytes under an immutable content identity.
   * @param plan - A trusted signature-checked plan with current owner grants.
   * @param files - Complete package payload; links and traversal are not accepted.
   */
  async stage(plan: ComputePluginInstallPlan, files: readonly StagedPluginFile[]): Promise<void> {
    this.checkFiles(files)
    const staged: StagedPluginPackage = { manifest: plan.manifest, packageDigest: plan.packageDigest,
      files, allowedFiles: files.map(file => file.path) }
    verifyStagedPluginPackage(plan, staged)
    const root = await this.directory('packages')
    const destination = join(root, objectKey(plan))
    const temporary = await mkdtemp(join(root, '.stage-'))
    try {
      const payload = join(temporary, 'payload')
      await mkdir(payload, { mode: 0o700 })
      for (const file of files) {
        const path = join(payload, file.path)
        await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
        await writeExclusive(path, file.bytes)
      }
      const metadata: StoredPackage = { formatVersion: 1, manifest: plan.manifest,
        packageDigest: plan.packageDigest, files: files.map(file => file.path) }
      const encoded = Buffer.from(JSON.stringify(metadata))
      if (encoded.byteLength > this.options.maxBundleBytes) throw new PluginLifecycleError('PLUGIN_STORE_LIMIT_EXCEEDED')
      await writeExclusive(join(temporary, 'manifest.json'), encoded)
      try {
        await rename(temporary, destination)
      } catch (error) {
        if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error
        // A concurrent writer may have committed the same content identity.
        await this.readStagedPackage(plan)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  /**
   * Revalidate persisted payload before the host resolves any loader entry.
   * @param plan - Newly verified manifest and permissions for this installation.
   * @returns Opaque bytes and exact allowed paths, never an executable specifier.
   */
  async readStagedPackage(plan: ComputePluginInstallPlan): Promise<StagedPluginPackage> {
    const root = await this.directory('packages')
    const directory = join(root, objectKey(plan))
    await assertRealDirectory(directory)
    const metadata = await this.readJson(join(directory, 'manifest.json'), directory)
    if (!isObject(metadata) || metadata.formatVersion !== 1 || !Array.isArray(metadata.files)
      || typeof metadata.packageDigest !== 'string' || metadata.files.length > this.options.maxFileCount) {
      throw new PluginLifecycleError('PLUGIN_STORE_METADATA_INVALID')
    }
    const payload = join(directory, 'payload')
    await assertRealDirectory(payload)
    const storedPaths = metadata.files
    const actualPaths = await this.payloadPaths(payload)
    if (actualPaths.length !== storedPaths.length || actualPaths.some(path => !storedPaths.includes(path))) {
      throw new PluginLifecycleError('PLUGIN_EXTRA_FILE')
    }
    const files: StagedPluginFile[] = []
    let bytes = 0
    for (const value of storedPaths) {
      const path = canonicalPluginPath(value)
      const content = await this.readBounded(join(payload, path), payload, this.options.maxBundleBytes - bytes)
      bytes += content.byteLength
      files.push({ path, bytes: content })
    }
    const staged: StagedPluginPackage = { manifest: metadata.manifest,
      packageDigest: metadata.packageDigest, files, allowedFiles: files.map(file => file.path) }
    verifyStagedPluginPackage(plan, staged)
    return staged
  }

  /**
   * Commit an owner preference only for an intact staged package.
   * @param plan - Current verified plan; signature and grants are not read from disk.
   * @param desiredState - Preference to restore after authorization at the next launch.
   * @returns A durable preference, not a running-process or capability receipt.
   */
  async setInstallation(plan: ComputePluginInstallPlan, desiredState: 'enabled' | 'disabled'): Promise<LocalPluginInstallation> {
    await this.readStagedPackage(plan)
    const record: LocalPluginInstallation = { pluginId: plan.manifest.pluginId, version: plan.manifest.version,
      packageDigest: plan.packageDigest, manifestFingerprint: plan.manifestFingerprint, desiredState }
    const root = await this.directory('installations')
    const temporary = await mkdtemp(join(root, '.receipt-'))
    try {
      const file = join(temporary, 'record.json')
      await writeExclusive(file, Buffer.from(JSON.stringify(record)))
      await rename(file, join(root, identityKey(record) + '.json'))
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return Object.freeze(record)
  }

  /**
   * Read persisted desired state without activating or advertising the plugin.
   * @param identity - Exact plugin and version to inspect.
   * @returns Stored preference, or undefined when never installed or removed.
   */
  async getInstallation(identity: PluginIdentity): Promise<LocalPluginInstallation | undefined> {
    const root = await this.directory('installations')
    let value: unknown
    try { value = await this.readJson(join(root, identityKey(identity) + '.json'), root) } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined
      throw error
    }
    if (!isObject(value) || value.pluginId !== identity.pluginId || value.version !== identity.version
      || !isDigest(value.packageDigest) || !isDigest(value.manifestFingerprint)
      || (value.desiredState !== 'enabled' && value.desiredState !== 'disabled')) {
      throw new PluginLifecycleError('PLUGIN_STORE_RECEIPT_INVALID')
    }
    return Object.freeze({ pluginId: identity.pluginId, version: identity.version,
      packageDigest: value.packageDigest, manifestFingerprint: value.manifestFingerprint, desiredState: value.desiredState })
  }

  /**
   * Remove the restart preference after the host has stopped the real loader.
   * Immutable payloads remain available for an explicitly authorized rollback.
   * @param identity - Exact installation whose preference is removed.
   */
  async forgetInstallation(identity: PluginIdentity): Promise<void> {
    const root = await this.directory('installations')
    try { await unlink(join(root, identityKey(identity) + '.json')) } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
  }

  private checkFiles(files: readonly StagedPluginFile[]): void {
    if (files.length > this.options.maxFileCount) throw new PluginLifecycleError('PLUGIN_STORE_LIMIT_EXCEEDED')
    let bytes = 0
    for (const file of files) {
      canonicalPluginPath(file.path)
      bytes += file.bytes.byteLength
      if (bytes > this.options.maxBundleBytes) throw new PluginLifecycleError('PLUGIN_STORE_LIMIT_EXCEEDED')
    }
  }

  private async directory(child: string): Promise<string> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    await assertRealDirectory(this.options.root)
    const root = await realpath(this.options.root)
    const path = join(root, child)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await assertRealDirectory(path)
    return path
  }

  private async readBounded(path: string, parent: string, limit: number): Promise<Buffer> {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_STORE_LINK_REJECTED')
    if (stat.size > limit) throw new PluginLifecycleError('PLUGIN_STORE_LIMIT_EXCEEDED')
    const canonical = await realpath(path)
    if (!canonical.startsWith((await realpath(parent)) + sep)) throw new PluginLifecycleError('PLUGIN_STORE_LINK_REJECTED')
    const result = await readFile(path)
    if (result.byteLength > limit) throw new PluginLifecycleError('PLUGIN_STORE_LIMIT_EXCEEDED')
    return result
  }

  private async readJson(path: string, parent: string): Promise<unknown> {
    const bytes = await this.readBounded(path, parent, this.options.maxBundleBytes)
    try { return JSON.parse(bytes.toString('utf8')) as unknown } catch {
      throw new PluginLifecycleError('PLUGIN_STORE_METADATA_INVALID')
    }
  }

  private async payloadPaths(root: string): Promise<string[]> {
    const files: string[] = []
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + item.name
        if (item.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_STORE_LINK_REJECTED')
        if (item.isDirectory()) await visit(join(directory, item.name), relative + '/')
        else if (item.isFile()) {
          files.push(relative)
          if (files.length > this.options.maxFileCount) throw new PluginLifecycleError('PLUGIN_STORE_LIMIT_EXCEEDED')
        } else throw new PluginLifecycleError('PLUGIN_FILE_INVALID')
      }
    }
    await visit(root, '')
    return files
  }
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

async function assertRealDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_STORE_LINK_REJECTED')
}

function identityKey(identity: PluginIdentity): string {
  if (typeof identity.pluginId !== 'string' || !identity.pluginId || typeof identity.version !== 'string' || !identity.version) {
    throw new PluginLifecycleError('PLUGIN_STORE_IDENTITY_INVALID')
  }
  return createHash('sha256').update(JSON.stringify([identity.pluginId, identity.version])).digest('hex')
}

function objectKey(plan: ComputePluginInstallPlan): string {
  if (!isDigest(plan.packageDigest) || !isDigest(plan.manifestFingerprint)) throw new PluginLifecycleError('PLUGIN_INSTALL_PLAN_INVALID')
  return plan.packageDigest + '-' + plan.manifestFingerprint
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function hasCode(error: unknown, code: string): boolean { return isObject(error) && error.code === code }
