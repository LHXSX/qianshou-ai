/** Package-transport seam: where verified-package bytes come from.
 *
 * A source yields an untrusted, complete file list. It never writes to the
 * host's plugin directories, never verifies signatures and never executes
 * package code: `package-intake.ts` owns all verification after this seam.
 *
 * The only implementation shipped here reads from the local filesystem (a
 * directory or a local archive), so the install path is usable with no network
 * endpoint. A future market endpoint implements the same interface; this work
 * package deliberately ships no HTTPS downloader.
 */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { PluginLifecycleError } from './errors.ts'
import { PluginPackageBudget, assertPluginPackageLimits, type PluginPackageEntry, type PluginPackageLimits } from './package-payload.ts'
import { readPluginZipArchive } from './zip-archive.ts'

/** One fetch request: which verified plan, under which budget. */
export interface PluginPackageRequest {
  /** Verified plan that the returned bytes must satisfy. */
  plan: ComputePluginInstallPlan
  /** Budget the source must enforce while reading. */
  limits: PluginPackageLimits
}

/** Untrusted package source. Implementations must not trust their own input. */
export interface PluginPackageSource {
  /** Stable identifier recorded in the installation receipt. */
  readonly kind: string
  /**
   * Read the complete package file list.
   * @param request - Verified plan plus the byte budget to enforce.
   * @returns Untrusted entries; the intake verifies them afterwards.
   */
  load(request: PluginPackageRequest): Promise<readonly PluginPackageEntry[]>
}

/** Reads a package from an unpacked directory tree (development, offline install). */
export class DirectoryPluginPackageSource implements PluginPackageSource {
  readonly kind = 'directory'
  /** @param directory - Absolute or relative directory holding the package files. */
  constructor(private readonly directory: string) {}

  /** Read every regular file below the directory; links and specials are refused. */
  async load(request: PluginPackageRequest): Promise<readonly PluginPackageEntry[]> {
    assertPluginPackageLimits(request.limits)
    const root = resolve(this.directory)
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_SOURCE_INVALID')
    const canonicalRoot = await realpath(root)
    const budget = new PluginPackageBudget(request.limits)
    const entries: PluginPackageEntry[] = []
    await visit(canonicalRoot, '', request.limits, budget, entries)
    return entries
  }
}

/** Reads a package from a local archive file; parsing is done by the strict ZIP reader. */
export class ArchivePluginPackageSource implements PluginPackageSource {
  readonly kind = 'archive'
  /** @param archivePath - Local path of the `.zip` package. */
  constructor(private readonly archivePath: string) {}

  /** Read the archive under a bounded size and parse it in memory. */
  async load(request: PluginPackageRequest): Promise<readonly PluginPackageEntry[]> {
    assertPluginPackageLimits(request.limits)
    const path = resolve(this.archivePath)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_SOURCE_INVALID')
    // Stored entries add roughly one header per file; the allowance keeps a
    // legitimate uncompressed archive admissible without lifting the payload budget.
    const ceiling = request.limits.maxPackageBytes + request.limits.maxFileCount * 512 + 1024
    if (stat.size > ceiling) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    const bytes = await readFile(path)
    if (bytes.byteLength > ceiling) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    return readPluginZipArchive(bytes, { limits: request.limits })
  }
}

/** Serves an entry list the caller already holds (tests, embedded packages, a market cache). */
export class StaticPluginPackageSource implements PluginPackageSource {
  readonly kind: string
  /**
   * @param entries - Entries to return verbatim; they stay untrusted.
   * @param kind - Source label recorded in the receipt.
   */
  constructor(private readonly entries: readonly PluginPackageEntry[], kind = 'static') { this.kind = kind }

  /** Return the held entries without touching the filesystem. */
  async load(request: PluginPackageRequest): Promise<readonly PluginPackageEntry[]> {
    assertPluginPackageLimits(request.limits)
    const budget = new PluginPackageBudget(request.limits)
    return this.entries.map(entry => ({ path: budget.add(entry.path, entry.bytes), bytes: entry.bytes }))
  }
}

async function visit(
  root: string,
  prefix: string,
  limits: PluginPackageLimits,
  budget: PluginPackageBudget,
  entries: PluginPackageEntry[],
): Promise<void> {
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix + item.name
    if (item.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
    if (item.isDirectory()) { await visit(root, relative + '/', limits, budget, entries); continue }
    if (!item.isFile()) throw new PluginLifecycleError('PLUGIN_PACKAGE_SOURCE_INVALID')
    const path = join(root, relative)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
    if (stat.size > limits.maxFileBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    const canonical = await realpath(path)
    if (!canonical.startsWith(root + sep)) throw new PluginLifecycleError('PLUGIN_PACKAGE_LINK_REJECTED')
    const bytes = await readFile(path)
    if (bytes.byteLength > limits.maxFileBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    entries.push({ path: budget.add(relative, bytes), bytes })
  }
}
