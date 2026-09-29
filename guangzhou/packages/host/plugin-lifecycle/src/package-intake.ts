/** Turns untrusted source bytes into a verified, immutably described package.
 *
 * Verification order is deliberate: the whole-package digest gate runs first, so
 * a tampered payload fails before any declared asset is interpreted. Nothing
 * here writes to disk or executes package code.
 *
 * Scope note: a package carries payload files only. It deliberately does NOT
 * carry a manifest document that declares its own package digest, because such
 * a digest would have to cover the file that states it — a hash fixed point.
 * The signed manifest arrives from the market (`ComputePluginInstallPlan`) and
 * binds the payload through `packageDigest`; per-file digests come from the
 * manifest's declared `contract.assets`.
 */
import { createHash } from 'node:crypto'
import type { ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { PluginLifecycleError } from './errors.ts'
import { PluginPackageBudget, assertPluginPackageLimits, type PluginPackageEntry, type PluginPackageLimits } from './package-payload.ts'
import type { PluginPackageSource } from './package-source.ts'
import { verifyStagedPluginPackage, type StagedPluginFile, type StagedPluginPackage } from './staged-package.ts'

/** Intake policy; the limits are the same budget every source enforces. */
export interface PluginPackageIntakeOptions { limits: PluginPackageLimits }

/** One manifest-declared asset that was verified against the payload. */
export interface PluginPackageAsset { path: string; bytes: number; sha256: string }

/** Result of a successful intake: verifiable bytes plus their provenance. */
export interface VerifiedPluginPackage {
  staged: StagedPluginPackage
  sourceKind: string
  assets: readonly PluginPackageAsset[]
  /** Logical entry id declared by the contract, when the manifest carries one. */
  entryId?: string
}

/**
 * Load and verify one package from a source.
 * @param source - Untrusted byte source (directory, local archive or static entries).
 * @param plan - Frozen plan produced by the trust planner.
 * @param options - Package limits enforced on the returned byte set.
 * @returns Verified staged package ready for atomic installation.
 */
export async function loadVerifiedPluginPackage(
  source: PluginPackageSource,
  plan: ComputePluginInstallPlan,
  options: PluginPackageIntakeOptions,
): Promise<VerifiedPluginPackage> {
  assertPluginPackageLimits(options.limits)
  const entries: readonly PluginPackageEntry[] = await source.load({ plan, limits: options.limits })
  if (!Array.isArray(entries)) throw new PluginLifecycleError('PLUGIN_PACKAGE_SOURCE_INVALID')
  const budget = new PluginPackageBudget(options.limits)
  const files: StagedPluginFile[] = entries
    .map(entry => ({ path: budget.add(entry.path, entry.bytes), bytes: entry.bytes }))
    // Canonical order keeps receipts, allowed-file lists and logs deterministic
    // regardless of the order a filesystem happens to return.
    .sort((left, right) => left.path.localeCompare(right.path))
  if (files.length === 0) throw new PluginLifecycleError('PLUGIN_PACKAGE_EMPTY')
  const staged: StagedPluginPackage = { manifest: plan.manifest, packageDigest: plan.packageDigest, files, allowedFiles: files.map(file => file.path) }
  // Primary gate: the complete byte set must hash to the signed package digest.
  verifyStagedPluginPackage(plan, staged)
  const assets = verifyDeclaredAssets(files, plan)
  const entryId = plan.manifest.contract?.entryId
  return { staged, sourceKind: source.kind, assets, ...(entryId === undefined ? {} : { entryId }) }
}

function verifyDeclaredAssets(files: readonly StagedPluginFile[], plan: ComputePluginInstallPlan): readonly PluginPackageAsset[] {
  const contract = plan.manifest.contract
  if (!contract) return []
  const verified: PluginPackageAsset[] = []
  for (const asset of contract.assets) {
    const file = files.find(candidate => candidate.path === asset.path)
    if (!file) throw new PluginLifecycleError('PLUGIN_PACKAGE_ASSET_MISSING')
    if (file.bytes.byteLength !== asset.bytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_ASSET_SIZE_MISMATCH')
    const sha256 = createHash('sha256').update(file.bytes).digest('hex')
    if (sha256 !== asset.sha256) throw new PluginLifecycleError('PLUGIN_PACKAGE_ASSET_DIGEST_MISMATCH')
    verified.push(Object.freeze({ path: asset.path, bytes: asset.bytes, sha256 }))
  }
  return Object.freeze(verified)
}
