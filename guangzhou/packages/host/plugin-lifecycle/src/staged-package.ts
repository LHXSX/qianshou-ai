/** Verified-package contract shared by intake, the local store and the installer.
 *
 * Bytes handled here are opaque payload: this module never imports, evaluates or
 * executes plugin code, and it never performs network or filesystem I/O.
 */
import { createHash } from 'node:crypto'
import { parseCapabilityPluginManifest, type ComputeCapabilityPluginManifest } from '@deepseek-ai/dsh-compute-core/capability-manifest'
import { assertComputePluginBundleSize } from '@deepseek-ai/dsh-compute-core/plugin-contract'
import { pluginManifestFingerprint, type ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { PluginLifecycleError } from './errors.ts'
import { normalizeRelativePluginPath } from './package-path.ts'

/** A staged package file; bytes are opaque and are never evaluated here. */
export interface StagedPluginFile { path: string; bytes: Uint8Array }
/** Package returned by a deployment-owned staging area. */
export interface StagedPluginPackage {
  manifest: unknown
  packageDigest: string
  files: readonly StagedPluginFile[]
  /** Exact relative paths allowed by the deployment's package policy. */
  allowedFiles: readonly string[]
  /** Trusted loader specifier selected by the staging adapter after scanning. */
  entrySpecifier?: string
  /** Configuration passed to the loader entry. */
  entryConfig?: unknown
}
/** Plugin identity used by deployment activation and cleanup adapters. */
export interface PluginIdentity { pluginId: string; version: string }

/** Deterministically hash staged files, including names and bytes. */
export function stagedPackageDigest(files: readonly StagedPluginFile[]): string {
  const normalized = normalizeFiles(files)
  const hash = createHash('sha256')
  for (const file of normalized) {
    const pathBytes = Buffer.from(file.path, 'utf8')
    const size = Buffer.allocUnsafe(4); size.writeUInt32BE(pathBytes.byteLength)
    hash.update(size).update(pathBytes).update(Buffer.from([0]))
    const byteSize = Buffer.allocUnsafe(8); byteSize.writeBigUInt64BE(BigInt(file.bytes.byteLength))
    hash.update(byteSize).update(file.bytes)
  }
  return hash.digest('hex')
}

/**
 * Validate a previously authorized install plan and its complete staged bytes.
 * @param plan - Plan produced after publisher verification and explicit grants.
 * @param staged - Opaque package to persist or pass to a trusted loader adapter.
 */
export function verifyStagedPluginPackage(plan: ComputePluginInstallPlan, staged: StagedPluginPackage): void {
  validatePlan(plan)
  validateStaged(plan, staged)
}

/** Validate only the frozen plan shape, identity and grants. */
export function validatePluginInstallPlan(plan: ComputePluginInstallPlan): void { validatePlan(plan) }

function validatePlan(plan: ComputePluginInstallPlan): void {
  const value: unknown = plan
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PluginLifecycleError('PLUGIN_INSTALL_PLAN_INVALID')
  const item = value as Record<string, unknown>
  if (item.phase !== 'verified' || typeof item.packageDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(item.packageDigest) || typeof item.manifestFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(item.manifestFingerprint) || !Array.isArray(item.grantedPermissions)) throw new PluginLifecycleError('PLUGIN_INSTALL_PLAN_INVALID')
  let manifest: ComputeCapabilityPluginManifest
  try { manifest = parseCapabilityPluginManifest(item.manifest) } catch { throw new PluginLifecycleError('PLUGIN_INSTALL_PLAN_INVALID') }
  if (manifest.pluginDigest !== item.packageDigest || pluginManifestFingerprint(manifest) !== item.manifestFingerprint) throw new PluginLifecycleError('PLUGIN_INSTALL_PLAN_INVALID')
  const declared = new Set<string>(manifest.capabilities.flatMap(capability => capability.permissions))
  const granted = new Set(item.grantedPermissions.filter(permission => typeof permission === 'string'))
  if (item.grantedPermissions.some(permission => typeof permission !== 'string' || !declared.has(permission))
    || [...declared].some(permission => !granted.has(permission))) throw new PluginLifecycleError('PLUGIN_INSTALL_PLAN_INVALID')
}
function validateStaged(plan: ComputePluginInstallPlan, staged: StagedPluginPackage): void {
  if (typeof staged !== 'object' || !Array.isArray(staged.files) || !Array.isArray(staged.allowedFiles)) throw new PluginLifecycleError('PLUGIN_STAGED_PACKAGE_INVALID')
  if (staged.packageDigest !== plan.packageDigest) throw new PluginLifecycleError('PLUGIN_DIGEST_MISMATCH')
  const manifest = parseManifest(staged.manifest)
  if (manifest.pluginId !== plan.manifest.pluginId || manifest.version !== plan.manifest.version
    || pluginManifestFingerprint(manifest) !== plan.manifestFingerprint) throw new PluginLifecycleError('PLUGIN_MANIFEST_MISMATCH')
  const files = normalizeFiles(staged.files)
  if (manifest.contract) assertComputePluginBundleSize(manifest.contract, files.reduce((total, file) => total + file.bytes.byteLength, 0))
  const allowed = normalizePaths(staged.allowedFiles)
  if (new Set(allowed).size !== allowed.length || files.length !== staged.files.length
    || files.some(file => !allowed.includes(file.path))) throw new PluginLifecycleError('PLUGIN_EXTRA_FILE')
  if (stagedPackageDigest(files) !== plan.packageDigest) throw new PluginLifecycleError('PLUGIN_DIGEST_MISMATCH')
}
function parseManifest(value: unknown): ComputeCapabilityPluginManifest {
  try { return parseCapabilityPluginManifest(value) } catch { throw new PluginLifecycleError('PLUGIN_MANIFEST_MISMATCH') }
}
function normalizeFiles(files: readonly StagedPluginFile[]): StagedPluginFile[] {
  const paths = new Set<string>()
  return files.map((file) => {
    const path = normalizeRelativePluginPath(file.path)
    if (paths.has(path) || !(file.bytes instanceof Uint8Array)) throw new PluginLifecycleError('PLUGIN_FILE_INVALID')
    paths.add(path); return { path, bytes: file.bytes }
  }).sort((a, b) => a.path.localeCompare(b.path))
}
function normalizePaths(paths: readonly string[]): string[] { return paths.map(path => normalizeRelativePluginPath(path)).sort() }
