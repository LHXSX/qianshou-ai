/** Loader-registration seam for verified, on-disk plugin generations.
 *
 * The lifecycle owns files and receipts; the host owns how a verified directory
 * becomes a loader entry. This module defines that boundary and ships one
 * in-memory registry so the install path can be exercised end to end in tests.
 *
 * It never touches a Cordis Loader. Wiring the real registry to
 * `CordisLoaderDeployment` is a host-side step that requires a live host
 * environment; nothing here claims that a plugin was loaded or executed.
 */
import type { ComputeCapabilityPluginManifest } from '@deepseek-ai/dsh-compute-core/capability-manifest'
import { assertPluginLoaderSpecifier } from './cordis-deployment.ts'
import { PluginLifecycleError } from './errors.ts'
import type { PluginIdentity } from './staged-package.ts'

/** Everything a host needs to bind one verified generation to its loader. */
export interface PluginRegistrationRequest {
  identity: PluginIdentity
  /** Absolute directory containing the verified, immutable payload. */
  directory: string
  manifest: ComputeCapabilityPluginManifest
  /** Logical entry id from the signed contract, when present. */
  entryId?: string
  /** Configuration the host passes to the loader entry. */
  entryConfig?: unknown
}

/** Host-owned mapping from a verified directory to a trusted loader specifier. */
export interface PluginLoaderRegistry {
  /** Stable identifier recorded in the installation receipt. */
  readonly kind: string
  /**
   * Advertise the capability and register the verified directory.
   * @param request - Verified generation; never untrusted bytes.
   * @returns The loader specifier the host recorded, validated by this module.
   */
  register(request: PluginRegistrationRequest): Promise<string>
  /**
   * Revoke advertisement so no new task routes to this plugin.
   * In-flight work is drained by the installer, not by this call.
   * @param identity - Exact installed plugin and version.
   */
  unregister(identity: PluginIdentity): Promise<void>
}

/** Default logical specifier for a plugin entry; safe for the loader root. */
export function defaultPluginLoaderSpecifier(identity: PluginIdentity): string {
  return `plugin:${identity.pluginId}@${identity.version}`
}

/**
 * In-memory registry used to exercise installation without a live host.
 * It records registrations and validates every specifier; it loads nothing.
 */
export class InMemoryPluginLoaderRegistry implements PluginLoaderRegistry {
  readonly kind = 'in-memory'
  private readonly entries = new Map<string, PluginRegistrationRequest & { specifier: string }>()
  private readonly specifier: (request: PluginRegistrationRequest) => string

  /** @param specifier - Host-supplied mapping; defaults to the logical plugin specifier. */
  constructor(specifier?: (request: PluginRegistrationRequest) => string) {
    this.specifier = specifier ?? (request => request.entryId ?? defaultPluginLoaderSpecifier(request.identity))
  }

  /** Record one verified generation and return its validated specifier. */
  async register(request: PluginRegistrationRequest): Promise<string> {
    if (!request || typeof request.directory !== 'string' || request.directory.length === 0) throw new PluginLifecycleError('PLUGIN_REGISTRATION_INVALID')
    const specifier = this.specifier(request)
    assertPluginLoaderSpecifier(specifier)
    this.entries.set(key(request.identity), { ...request, specifier })
    return specifier
  }

  /** Drop the record for an identity; repeated calls are idempotent. */
  async unregister(identity: PluginIdentity): Promise<void> { this.entries.delete(key(identity)) }

  /** Current registrations, for hosts and tests that need to observe advertisement. */
  list(): readonly (PluginRegistrationRequest & { specifier: string })[] { return [...this.entries.values()] }

  /** One registration, or undefined when the plugin is not advertised. */
  get(identity: PluginIdentity): (PluginRegistrationRequest & { specifier: string }) | undefined { return this.entries.get(key(identity)) }
}

function key(identity: PluginIdentity): string { return `${identity.pluginId}\u0000${identity.version}` }
