/** Signed capability-plugin manifest shared by the market, host and node adapters. */
import { ComputeError } from './errors.ts'
import type { ComputeCapabilityId } from './protocol.ts'
import { parseComputePluginContract, type ComputePluginContract } from './plugin-contract.ts'

/** Permission declared by an installable capability plugin. */
export type ComputePluginPermission = 'workspace.read' | 'workspace.write' | 'network.declared' | 'model.local' | 'gpu'
/** Data scope exposed to an installable capability plugin. */
export type ComputePluginDataScope = 'none' | 'workspace' | 'task-inputs'

/** A capability exposed by one installable plugin version. */
export interface ComputePluginCapability {
  id: ComputeCapabilityId
  version: string
  inputKinds: readonly string[]
  outputKinds: readonly string[]
  permissions: readonly ComputePluginPermission[]
  dataScope: ComputePluginDataScope
}

/** Host-compatible, market-displayable plugin declaration. */
export interface ComputeCapabilityPluginManifest {
  manifestVersion: 1
  pluginId: string
  version: string
  displayName: string
  hostRange: string
  pluginDigest: string
  capabilities: readonly ComputePluginCapability[]
  /** Optional small declaration; omitted manifests remain backwards compatible. */
  contract?: ComputePluginContract
}

/** Parse and freeze an untrusted market/package manifest; no package code is loaded.
 * @param value - Untrusted manifest JSON.
 * @returns Validated immutable plugin manifest.
 */
export function parseCapabilityPluginManifest(value: unknown): ComputeCapabilityPluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  const pluginId = item.pluginId
  const packageVersion = item.version
  const displayName = item.displayName
  const hostRange = item.hostRange
  const pluginDigest = item.pluginDigest
  const rawCapabilities = item.capabilities
  const contract = item.contract === undefined ? undefined : parseComputePluginContract(item.contract)
  if (item.manifestVersion !== 1 || !id(pluginId) || !version(packageVersion) || !label(displayName)
    || !range(hostRange) || !digest(pluginDigest) || !Array.isArray(rawCapabilities)
    || rawCapabilities.length < 1 || rawCapabilities.length > 64) throw invalid()
  const capabilities = rawCapabilities.map(parseCapability)
  const seen = new Set(capabilities.map(capability => `${capability.id}\u0000${capability.version}`))
  if (seen.size !== capabilities.length) throw invalid()
  return freeze({ manifestVersion: 1, pluginId, version: packageVersion, displayName, hostRange, pluginDigest,
    capabilities, ...(contract ? { contract } : {}) })
}

/** Verify that a loaded plugin supplies exactly the executor versions it declared.
 * @param manifest - Validated plugin manifest.
 * @param executors - Executors exposed by the loaded plugin.
 */
export function assertCapabilityPluginExecutors(manifest: ComputeCapabilityPluginManifest, executors: readonly unknown[]): void {
  const parsed = parseCapabilityPluginManifest(manifest)
  if (!Array.isArray(executors) || executors.length !== parsed.capabilities.length) throw new ComputeError('COMPUTE_PLUGIN_EXECUTOR_MISMATCH')
  const declared = new Set(parsed.capabilities.map(capability => `${capability.id}\u0000${capability.version}`))
  const provided = new Set<string>()
  for (const executor of executors) {
    if (!executor || typeof executor !== 'object' || Array.isArray(executor)) throw new ComputeError('COMPUTE_PLUGIN_EXECUTOR_MISMATCH')
    const candidate = executor as Record<string, unknown>
    if (typeof candidate.capabilityId !== 'string' || typeof candidate.version !== 'string') throw new ComputeError('COMPUTE_PLUGIN_EXECUTOR_MISMATCH')
    const key = `${candidate.capabilityId}\u0000${candidate.version}`
    if (!declared.has(key) || provided.has(key)) throw new ComputeError('COMPUTE_PLUGIN_EXECUTOR_MISMATCH')
    provided.add(key)
  }
}

function parseCapability(value: unknown): ComputePluginCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  const capabilityId = item.id
  const capabilityVersion = item.version
  const inputKinds = item.inputKinds
  const outputKinds = item.outputKinds
  const permissions = item.permissions
  const dataScope = item.dataScope
  if (!id(capabilityId) || !version(capabilityVersion) || !stringList(inputKinds, 16) || !stringList(outputKinds, 16)
    || !isPermissionList(permissions)
    || !DATA_SCOPES.has(dataScope as ComputePluginDataScope)) throw invalid()
  return {
    id: capabilityId as ComputeCapabilityId,
    version: capabilityVersion,
    inputKinds: Object.freeze([...inputKinds]),
    outputKinds: Object.freeze([...outputKinds]),
    permissions: Object.freeze([...permissions]),
    dataScope: dataScope as ComputePluginDataScope,
  }
}

function stringList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(item => id(item))
}
function isPermissionList(value: unknown): value is ComputePluginPermission[] {
  return Array.isArray(value) && value.length <= 16 && value.every(item => (
    typeof item === 'string' && PERMISSIONS.has(item as ComputePluginPermission)
  ))
}
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) }
function label(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}
function version(value: unknown): value is string { return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u.test(value) }
function range(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value)
}
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function invalid(): ComputeError { return new ComputeError('COMPUTE_PLUGIN_MANIFEST_INVALID') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child) } return value }
const PERMISSIONS = new Set<ComputePluginPermission>(['workspace.read', 'workspace.write', 'network.declared', 'model.local', 'gpu'])
const DATA_SCOPES = new Set<ComputePluginDataScope>(['none', 'workspace', 'task-inputs'])
