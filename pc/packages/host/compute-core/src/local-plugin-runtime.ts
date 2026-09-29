/**
 * Host-local runtime for one verified capability-plugin manifest.
 *
 * The lifecycle package owns installation and loader activation. This module
 * owns the smaller execution admission step: the manifest is parsed once, the
 * live executor registry is checked before every invocation, and a stale or
 * remote-only plugin is refused without calling plugin code.
 */
import { ComputeError } from './errors.ts'
import {
  assertCapabilityPluginExecutors,
  parseCapabilityPluginManifest,
  type ComputeCapabilityPluginManifest,
} from './capability-manifest.ts'
import { pluginManifestFingerprint } from './plugin-market.ts'
import {
  ComputeExecutorRegistry,
  type ComputeExecutionContext,
  type ComputeExecutionResult,
} from './executor.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'

/** Runtime state returned by the local manifest preflight. */
export type LocalPluginRuntimeState = 'ready' | 'quarantined'

/** One exact capability/version pair observed during a preflight. */
export interface LocalPluginCapabilityCheck {
  readonly capabilityId: string
  readonly version: string
  readonly executorRegistered: boolean
}

/** Safe, serializable result of the local plugin preflight. */
export interface LocalPluginPreflightReport {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly manifestFingerprint: string
  readonly state: LocalPluginRuntimeState
  readonly capabilities: readonly LocalPluginCapabilityCheck[]
  readonly reasons: readonly string[]
}

/** Runtime facade used by a local task runner after lifecycle activation. */
export interface LocalCapabilityPluginRuntime {
  /** Parsed and frozen manifest admitted by the market/lifecycle path. */
  readonly manifest: ComputeCapabilityPluginManifest
  /** Re-check the current registry without invoking any executor. */
  readonly preflight: () => LocalPluginPreflightReport
  /** Execute only after a fresh successful preflight. */
  readonly execute: (task: ComputeTaskEnvelope, context: ComputeExecutionContext) => Promise<ComputeExecutionResult>
}

/** Options for the host-local runtime facade. */
export interface LocalCapabilityPluginRuntimeOptions {
  /** Market/lifecycle manifest; parser validation happens before code execution. */
  readonly manifest: unknown
  /** Effect-owned registry populated by the active Cordis plugin generation. */
  readonly executors: ComputeExecutorRegistry
}

/**
 * Build the smallest local plugin runtime seam.
 *
 * This does not load a package, bypass the plugin lifecycle, or infer a
 * capability from an installed file. Loader activation contributes exact
 * executors to the registry; this facade only admits those contributions when
 * they still match the immutable manifest.
 *
 * @param options - Parsed through the same manifest validator used by install planning.
 * @returns A runtime whose every execution starts with manifest preflight.
 */
export function createLocalCapabilityPluginRuntime(options: LocalCapabilityPluginRuntimeOptions): LocalCapabilityPluginRuntime {
  if (!options || !(options.executors instanceof ComputeExecutorRegistry)) {
    throw new ComputeError('COMPUTE_LOCAL_PLUGIN_RUNTIME_INVALID')
  }
  const manifest = parseCapabilityPluginManifest(options.manifest)
  const manifestFingerprint = pluginManifestFingerprint(manifest)
  const preflight = (): LocalPluginPreflightReport => {
    const registered = options.executors.list()
    const registeredKeys = new Set(registered.map(item => executorKey(item.capabilityId, item.version)))
    const capabilities = manifest.capabilities.map(capability => Object.freeze({
      capabilityId: capability.id,
      version: capability.version,
      executorRegistered: registeredKeys.has(executorKey(capability.id, capability.version)),
    }))
    const reasons: string[] = []
    if (manifest.contract?.runtime === 'remote') reasons.push('COMPUTE_LOCAL_PLUGIN_REMOTE_RUNTIME')
    try {
      // The shared assertion enforces exact cardinality, no undeclared executor,
      // and no duplicate capability/version contribution.
      assertCapabilityPluginExecutors(manifest, registered)
    } catch (error) {
      reasons.push(error instanceof ComputeError ? error.code : 'COMPUTE_PLUGIN_EXECUTOR_MISMATCH')
    }
    return Object.freeze({
      pluginId: manifest.pluginId,
      pluginVersion: manifest.version,
      manifestFingerprint,
      state: reasons.length === 0 ? 'ready' as const : 'quarantined' as const,
      capabilities: Object.freeze(capabilities),
      reasons: Object.freeze([...new Set(reasons)]),
    })
  }
  return Object.freeze({
    manifest,
    preflight,
    async execute(task: ComputeTaskEnvelope, context: ComputeExecutionContext): Promise<ComputeExecutionResult> {
      const report = preflight()
      if (report.state !== 'ready') {
        throw new ComputeError('COMPUTE_PLUGIN_PREFLIGHT_FAILED', 409, report.reasons.join(','))
      }
      return options.executors.execute(task, context)
    },
  })
}

function executorKey(capabilityId: string, version: string): string { return `${capabilityId}\u0000${version}` }
