/** Cordis plugin entry for the capability-plugin lifecycle.
 *
 * This module is the host-side assembly point the package was missing: it binds
 * the already-tested transaction (`LocalPluginInstaller`, `PluginLifecycle`,
 * `CordisLoaderDeployment`) to the *real* Cordis Loader of the running host and
 * exposes the result as a readable service. It adds no new lifecycle logic.
 *
 * Guarantees this entry keeps:
 * - nothing is downloaded: a caller supplies the `PluginPackageSource`;
 * - nothing is executed: an installed generation is registered as an immutable
 *   directory whose entry the Loader imports exactly like any other row;
 * - `recover()` is never run at boot: it deletes files, so it stays an explicit
 *   operator call (`service.recover()`), and `install()` keeps failing loudly on
 *   a leftover journal until it has run.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import type { ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { assertPluginLoaderSpecifier, CordisLoaderDeployment, type CordisLoaderLike } from './cordis-deployment.ts'
import { PluginLifecycleError } from './errors.ts'
import { LocalPluginInstaller, type PluginCrashRecoveryReport, type PluginInstallationReceipt, type PluginUninstallResult } from './installer.ts'
import { defaultPluginLoaderSpecifier, type PluginLoaderRegistry, type PluginRegistrationRequest } from './loader-registry.ts'
import { PluginLifecycle } from './plugin-lifecycle.ts'
import type { PluginPackageSource } from './package-source.ts'
import type { PluginIdentity } from './staged-package.ts'

/** Cordis service key this plugin provides. */
export const PLUGIN_LIFECYCLE_SERVICE = 'pluginLifecycle'

/** Cordis service key of the Loader registration seam. */
export const PLUGIN_LIFECYCLE_REGISTRY_SERVICE = 'pluginLifecycleRegistry'

/** Stable plugin identity. */
export const name = 'qianshou-plugin-lifecycle'

/** The loader owns the tree this plugin registers into; Connection carries the status route. */
export const inject = ['loader', 'connection']

/** Deployment-owned storage, budget and drain policy. */
export interface Config {
  /** Absolute host-private plugin root; empty resolves under `$DSH_HOME/qianshou/plugins`. */
  root?: string
  /** Maximum files admitted per package. */
  maxFileCount?: number
  /** Maximum bytes admitted per file. */
  maxFileBytes?: number
  /** Maximum bytes admitted per package; must be at least `maxFileBytes`. */
  maxPackageBytes?: number
  /** Generations kept per plugin identity; 1 means replace. */
  retainGenerations?: number
}

/** Runtime-validated storage and package budget. */
export const Config: z<Config> = z.object({
  root: z.string().default(''),
  maxFileCount: z.number().step(1).min(1).max(4096).default(256),
  maxFileBytes: z.number().step(1).min(1).max(268_435_456).default(16_777_216),
  maxPackageBytes: z.number().step(1).min(1).max(536_870_912).default(67_108_864),
  retainGenerations: z.number().step(1).min(1).max(16).default(1),
})

/** Health and startup facts of this host's plugin lifecycle. */
export interface PluginLifecycleStatus {
  /** Stable marker for the module that produced this projection. */
  source: 'plugin-lifecycle'
  /** Absolute host-private plugin root the installer owns. */
  root: string
  /** Loader seam kind currently bound to the lifecycle. */
  registryKind: string
  /** Installations observed through this service since mount; a projection, not a disk scan. */
  installations: number
}

/** Operator surface of the installed-plugin lifecycle. */
export interface PluginLifecycleService {
  /** Current status projection; never performs I/O. */
  status(): PluginLifecycleStatus
  /** Every durable installation receipt, read from disk. */
  list(): Promise<readonly PluginInstallationReceipt[]>
  /** One receipt by identity, or undefined when nothing is installed. */
  get(identity: PluginIdentity): Promise<PluginInstallationReceipt | undefined>
  /** Install one already-verified plan from a host-supplied byte source. */
  install(plan: ComputePluginInstallPlan, source: PluginPackageSource): Promise<{ receipt: PluginInstallationReceipt; reused: boolean }>
  /** Deactivate, revoke and delete one installation. */
  uninstall(identity: PluginIdentity): Promise<PluginUninstallResult>
  /** Clean crash leftovers; deletes files, so it is never implicit. */
  recover(): Promise<PluginCrashRecoveryReport>
}

/**
 * Loader registry that turns one verified, immutable generation directory into a
 * real Cordis Loader entry.
 *
 * The specifier stays a canonical `file:` URL under the generation directory, so
 * the Loader imports exactly the bytes the installer verified and no package name
 * of a market plugin can shadow a host module. An absent entry file is a
 * structured refusal: this adapter never reports a registration it did not make.
 */
export class CordisPluginLoaderRegistry implements PluginLoaderRegistry {
  readonly kind = 'cordis-loader'
  private readonly entries = new Map<string, string>()
  private readonly deployment: CordisLoaderDeployment

  /** @param loader - The host's own Cordis Loader. */
  constructor(private readonly loader: CordisLoaderLike) {
    this.deployment = new CordisLoaderDeployment({
      loader,
      readStagedPackage: () => {
        // Reachable only through `PluginLifecycle`; registration never stages bytes.
        throw new PluginLifecycleError('PLUGIN_STAGING_NOT_AUTHORIZED_HERE')
      },
      entrySpecifier: (identity, staged) => staged.entrySpecifier ?? defaultPluginLoaderSpecifier(identity),
    })
  }

  /** Adapter `PluginLifecycle` calls to activate and deactivate a verified generation. */
  get activation(): CordisLoaderDeployment { return this.deployment }

  async register(request: PluginRegistrationRequest): Promise<string> {
    if (!request || typeof request.directory !== 'string' || request.directory.length === 0) {
      throw new PluginLifecycleError('PLUGIN_REGISTRATION_INVALID')
    }
    const directory = await realDirectory(request.directory)
    const entryName = entryFile(directory, request.entryId ?? defaultPluginLoaderSpecifier(request.identity))
    let resolvedEntry: string
    try {
      resolvedEntry = require.resolve(entryName)
    } catch {
      throw new PluginLifecycleError('PLUGIN_ENTRY_FILE_ABSENT')
    }
    // Both sides are canonical, so a symlinked host root (macOS `/var`) cannot
    // make an in-generation entry look like an escape.
    const realEntry = await realDirectory(resolvedEntry)
    if (!realEntry.startsWith(directory + sep)) throw new PluginLifecycleError('PLUGIN_ENTRY_OUTSIDE_GENERATION')
    const specifier = pathToFileURL(realEntry).href
    assertPluginLoaderSpecifier(specifier)
    const id = await this.loader.create({ name: specifier, config: request.entryConfig })
    this.entries.set(key(request.identity), id)
    // A failed drain keeps the entry visible: the lifecycle's own rollback path
    // deactivates or removes this identity through `activation`.
    await this.drain(id)
    return specifier
  }

  async unregister(identity: PluginIdentity): Promise<void> {
    const id = this.entries.get(key(identity))
    if (id === undefined) return
    await this.loader.update(id, { disabled: true })
    await this.drain(id)
    await this.loader.remove(id)
    await this.loader.await()
    this.entries.delete(key(identity))
  }

  private async drain(id: string): Promise<void> {
    await this.loader.await()
    const fiber = this.loader.resolve?.(id)?.fiber
    if (fiber) await fiber.await()
    await this.loader.await()
  }
}

/** Bound installer, lifecycle coordinator and registry behind one readable service. */
export function createPluginLifecycle(options: {
  loader: CordisLoaderLike
  root: string
  limits: { maxFileCount: number; maxFileBytes: number; maxPackageBytes: number }
  retainGenerations: number
}): { service: PluginLifecycleService; lifecycle: PluginLifecycle; registry: CordisPluginLoaderRegistry } {
  const registry = new CordisPluginLoaderRegistry(options.loader)
  const installer = new LocalPluginInstaller({
    root: options.root,
    limits: options.limits,
    registry,
    retainGenerations: options.retainGenerations,
  })
  const lifecycle = new PluginLifecycle(registry.activation)
  let installations = 0
  const service: PluginLifecycleService = {
    status: () => Object.freeze({
      source: 'plugin-lifecycle' as const,
      root: options.root,
      registryKind: registry.kind,
      installations,
    }),
    async list() {
      const receipts = await installer.listInstallations()
      installations = receipts.length
      return receipts
    },
    get: identity => installer.getInstallation(identity),
    install: async (plan, source) => {
      const receipt = await installer.install(plan, source)
      installations = (await installer.listInstallations()).length
      return receipt
    },
    uninstall: async (identity) => {
      const result = await installer.uninstall(identity)
      installations = (await installer.listInstallations()).length
      return result
    },
    recover: async () => {
      const report = await installer.recover()
      installations = (await installer.listInstallations()).length
      return report
    },
  }
  return { service, lifecycle, registry }
}

/**
 * Mount the plugin-market lifecycle on a real Cordis Loader.
 * @param ctx - Host scope owning the Loader and the authenticated Connection carrier.
 * @param config - Host-private root, package budget and retention policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const root = resolvePluginRoot(config.root)
  const limits = {
    maxFileCount: config.maxFileCount ?? 256,
    maxFileBytes: config.maxFileBytes ?? 16_777_216,
    maxPackageBytes: config.maxPackageBytes ?? 67_108_864,
  }
  if (limits.maxFileBytes > limits.maxPackageBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_INVALID')
  const { service, registry } = createPluginLifecycle({
    loader: ctx.loader,
    root,
    limits,
    retainGenerations: config.retainGenerations ?? 1,
  })
  ctx.provide(PLUGIN_LIFECYCLE_SERVICE, service)
  ctx.provide(PLUGIN_LIFECYCLE_REGISTRY_SERVICE, registry)
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/qianshou/plugins/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json(service.status(), {
      status: 200,
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    }),
  }), 'plugin-lifecycle: status route')
}

/** This package's own version, read without assuming the process working directory. */
export const PACKAGE_VERSION: string = readPackageVersion()

/**
 * Canonical path of one entry, refusing anything that cannot be resolved.
 *
 * Following symlinks is the point: a link inside a generation directory that
 * points outside it must fail the containment check above rather than become the
 * module the host imports.
 */
async function realDirectory(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    throw new PluginLifecycleError('PLUGIN_ENTRY_FILE_ABSENT')
  }
}

/** The entry file a generation directory must hold for a logical contract entry id. */
function entryFile(directory: string, entryId: string): string {
  const candidate = entryId.startsWith('cordis:') ? entryId.slice('cordis:'.length) : entryId
  if (candidate.length === 0 || candidate.includes('\u0000') || candidate.includes('\\')
    || candidate.includes('/') || candidate.includes(sep)) {
    throw new PluginLifecycleError('PLUGIN_ENTRY_SPECIFIER_INVALID')
  }
  return join(directory, `${candidate}.js`)
}

function key(identity: PluginIdentity): string { return `${identity.pluginId}\u0000${identity.version}` }

function readPackageVersion(): string {
  const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new PluginLifecycleError('PLUGIN_PACKAGE_MANIFEST_INVALID')
  }
  return manifest.version
}

/** Resolve the host-private plugin root: explicit, else under `$DSH_HOME/qianshou/plugins`. */
function resolvePluginRoot(configured: string | undefined): string {
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured)) throw new PluginLifecycleError('PLUGIN_ROOT_NOT_ABSOLUTE')
    return resolve(configured)
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
  return resolve(join(home, 'qianshou', 'plugins'))
}
