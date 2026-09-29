/**
 * Small, declarative contract for a capability plugin.
 *
 * A contract carries routing metadata and schema references only. It is safe
 * to show in a market card and to sign with the capability manifest; executable
 * code, model weights and client runtimes remain outside this object.
 */
import { ComputeError } from './errors.ts'

export type ComputePluginRuntime = 'host' | 'node' | 'remote'

export interface ComputePluginToolContract {
  id: string
  description: string
  inputSchemaRef: string
  outputSchemaRef: string
}

export interface ComputePluginDependency {
  id: string
  version: string
  optional?: boolean
}

export interface ComputePluginAsset {
  path: string
  bytes: number
  sha256: string
}

export interface ComputePluginFootprintBudget {
  /** Maximum sum of declared asset and package bytes admitted by a host. */
  maxBundleBytes: number
  maxDependencies: number
  maxAssets: number
  maxTools: number
}

export interface ComputePluginContract {
  contractVersion: 1
  runtime: ComputePluginRuntime
  /** Logical entry id. Deployment maps it to a trusted loader specifier. */
  entryId: string
  tools: readonly ComputePluginToolContract[]
  dependencies: readonly ComputePluginDependency[]
  assets: readonly ComputePluginAsset[]
  budget: ComputePluginFootprintBudget
}

/** Parse and freeze the small, declarative part of a plugin package. */
export function parseComputePluginContract(value: unknown): ComputePluginContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (item.contractVersion !== 1 || !isRuntime(item.runtime) || !logicalId(item.entryId)
    || !Array.isArray(item.tools) || !Array.isArray(item.dependencies) || !Array.isArray(item.assets)
    || !budget(item.budget)) throw invalid()
  const tools = item.tools.map(parseTool)
  const dependencies = item.dependencies.map(parseDependency)
  const assets = item.assets.map(parseAsset)
  const seenTools = new Set(tools.map(tool => tool.id))
  const seenDependencies = new Set(dependencies.map(dependency => dependency.id))
  const seenAssets = new Set(assets.map(asset => asset.path))
  const limits = item.budget
  if (seenTools.size !== tools.length || seenDependencies.size !== dependencies.length || seenAssets.size !== assets.length
    || tools.length > limits.maxTools || dependencies.length > limits.maxDependencies || assets.length > limits.maxAssets
    || assets.reduce((sum, asset) => sum + asset.bytes, 0) > limits.maxBundleBytes) throw invalid()
  return freeze({ contractVersion: 1, runtime: item.runtime, entryId: item.entryId, tools, dependencies, assets, budget: limits })
}

/** Check observed staged bytes before a deployment adapter activates a plugin. */
export function assertComputePluginBundleSize(contract: ComputePluginContract, observedBytes: number): void {
  const parsed = parseComputePluginContract(contract)
  if (!Number.isSafeInteger(observedBytes) || observedBytes < 0 || observedBytes > parsed.budget.maxBundleBytes) throw new ComputeError('COMPUTE_PLUGIN_BUNDLE_TOO_LARGE', 413)
}

function parseTool(value: unknown): ComputePluginToolContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (!logicalId(item.id) || !label(item.description)
    || !schemaRef(item.inputSchemaRef) || !schemaRef(item.outputSchemaRef)) throw invalid()
  return { id: item.id, description: item.description, inputSchemaRef: item.inputSchemaRef, outputSchemaRef: item.outputSchemaRef }
}

function parseDependency(value: unknown): ComputePluginDependency {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (!logicalId(item.id) || !version(item.version)
    || (item.optional !== undefined && typeof item.optional !== 'boolean')) throw invalid()
  return { id: item.id, version: item.version, ...(item.optional === undefined ? {} : { optional: item.optional }) }
}

function parseAsset(value: unknown): ComputePluginAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const item = value as Record<string, unknown>
  if (!relativePath(item.path) || !bytes(item.bytes) || !/^[a-f0-9]{64}$/u.test(String(item.sha256))) throw invalid()
  return { path: item.path, bytes: item.bytes, sha256: item.sha256 as string }
}

function budget(value: unknown): value is ComputePluginFootprintBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return bytes(item.maxBundleBytes) && integer(item.maxDependencies, 0, 64)
    && integer(item.maxAssets, 0, 256) && integer(item.maxTools, 1, 128)
}
function logicalId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) }
function schemaRef(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value) }
function label(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) }
function relativePath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\\') && !value.includes('\u0000') && !value.startsWith('/') && !value.split('/').includes('..') }
function version(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^(?:\*|\^?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|>=\s*\d+\.\d+\.\d+)$/u.test(value)
}
function integer(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max }
function bytes(value: unknown): value is number { return integer(value, 0, 134217728) }
function invalid(): ComputeError { return new ComputeError('COMPUTE_PLUGIN_CONTRACT_INVALID') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child) } return value }
const RUNTIMES = new Set<ComputePluginRuntime>(['host', 'node', 'remote'])
function isRuntime(value: unknown): value is ComputePluginRuntime {
  return typeof value === 'string' && RUNTIMES.has(value as ComputePluginRuntime)
}
