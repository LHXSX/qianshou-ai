/** Shared payload shapes and the single byte budget used by every package source.
 *
 * One budget object is used while reading a directory, an archive or an
 * in-memory entry list, so a hostile source cannot bypass the same limits by
 * choosing a different transport.
 */
import { PluginLifecycleError } from './errors.ts'
import { canonicalPluginPath } from './package-path.ts'

/** One unverified file offered by a package source. */
export interface PluginPackageEntry { path: string; bytes: Uint8Array }

/** Host-owned resource limits for one plugin package. */
export interface PluginPackageLimits {
  maxFileCount: number
  maxFileBytes: number
  maxPackageBytes: number
}

/** Validate the limit declaration itself before any package I/O happens. */
export function assertPluginPackageLimits(limits: PluginPackageLimits): void {
  if (!positive(limits.maxFileCount) || !positive(limits.maxFileBytes) || !positive(limits.maxPackageBytes)
    || limits.maxFileBytes > limits.maxPackageBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_INVALID')
}

/** Accumulates observed bytes and file count, rejecting the first violation. */
export class PluginPackageBudget {
  private count = 0
  private bytes = 0
  private readonly paths = new Set<string>()

  /** @param limits - Positive per-package limits already validated by the caller. */
  constructor(private readonly limits: PluginPackageLimits) {}

  /** Number of files admitted so far. */
  get fileCount(): number { return this.count }
  /** Sum of admitted file bytes. */
  get packageBytes(): number { return this.bytes }

  /**
   * Admit one file, enforcing path canonicality, duplicates and both budgets.
   * @param path - Untrusted entry path.
   * @param bytes - Untrusted entry bytes.
   * @returns The canonical path that was admitted.
   */
  add(path: unknown, bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) throw new PluginLifecycleError('PLUGIN_FILE_INVALID')
    const canonical = canonicalPluginPath(path)
    if (this.paths.has(canonical)) throw new PluginLifecycleError('PLUGIN_PACKAGE_DUPLICATE_FILE')
    if (this.count + 1 > this.limits.maxFileCount || bytes.byteLength > this.limits.maxFileBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    const total = this.bytes + bytes.byteLength
    if (total > this.limits.maxPackageBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    this.paths.add(canonical)
    this.count += 1
    this.bytes = total
    return canonical
  }
}

function positive(value: number): boolean { return Number.isSafeInteger(value) && value >= 1 }
