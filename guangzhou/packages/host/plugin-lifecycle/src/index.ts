/** Public surface of the Qianshou capability-plugin lifecycle package.
 *
 * The package owns the transactional, non-executing half of the plugin market:
 * trust planning input, package intake from a `PluginPackageSource`, atomic
 * content-addressed installation with crash recovery, loader registration seams
 * and revocation-safe uninstall. It never downloads from the network and never
 * evaluates plugin code.
 */
export { PluginLifecycleError } from './errors.ts'
export { canonicalPluginPath, normalizeRelativePluginPath } from './package-path.ts'
export {
  stagedPackageDigest,
  validatePluginInstallPlan,
  verifyStagedPluginPackage,
  type PluginIdentity,
  type StagedPluginFile,
  type StagedPluginPackage,
} from './staged-package.ts'
export {
  PluginLifecycle,
  type PluginLifecycleDeployment,
  type PluginLifecyclePhase,
  type PluginLifecycleRecord,
} from './plugin-lifecycle.ts'
export {
  CordisLoaderDeployment,
  assertPluginLoaderSpecifier,
  type CordisLoaderDeploymentOptions,
  type CordisLoaderLike,
} from './cordis-deployment.ts'
export { LocalPluginStore, type LocalPluginInstallation, type LocalPluginStoreOptions } from './local-store.ts'
export {
  PluginPackageBudget,
  assertPluginPackageLimits,
  type PluginPackageEntry,
  type PluginPackageLimits,
} from './package-payload.ts'
export {
  ArchivePluginPackageSource,
  DirectoryPluginPackageSource,
  StaticPluginPackageSource,
  type PluginPackageRequest,
  type PluginPackageSource,
} from './package-source.ts'
export { readPluginZipArchive, type PluginZipArchiveOptions } from './zip-archive.ts'
export {
  loadVerifiedPluginPackage,
  type PluginPackageAsset,
  type PluginPackageIntakeOptions,
  type VerifiedPluginPackage,
} from './package-intake.ts'
export {
  InMemoryPluginLoaderRegistry,
  defaultPluginLoaderSpecifier,
  type PluginLoaderRegistry,
  type PluginRegistrationRequest,
} from './loader-registry.ts'
export {
  LocalPluginInstaller,
  type LocalPluginInstallerOptions,
  type PluginCrashRecoveryReport,
  type PluginInstallationReceipt,
  type PluginUninstallResult,
} from './installer.ts'
export {
  apply,
  Config,
  CordisPluginLoaderRegistry,
  createPluginLifecycle,
  inject,
  name,
  PACKAGE_VERSION,
  PLUGIN_LIFECYCLE_REGISTRY_SERVICE,
  PLUGIN_LIFECYCLE_SERVICE,
  type PluginLifecycleService,
  type PluginLifecycleStatus,
} from './plugin.ts'
