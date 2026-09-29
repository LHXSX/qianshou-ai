/** Pure trust and installation planning for capability plugins.
 *
 * This module never downloads, loads, installs or executes package code. A
 * deployment adapter supplies the signature verifier and performs the later
 * staged filesystem transaction after presenting this immutable plan.
 */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { parseCapabilityPluginManifest, type ComputeCapabilityPluginManifest, type ComputePluginPermission } from './capability-manifest.ts'

/** Signature verifier owned by the market transport or deployment trust store. */
export type ComputePluginSignatureVerifier = (fingerprint: string, signature: string) => boolean | Promise<boolean>

/** Facts required before a plugin can be staged for installation. */
export interface ComputePluginInstallRequest {
  manifest: unknown
  packageDigest: string
  signature: string
  hostVersion: string
  grantedPermissions: readonly ComputePluginPermission[]
  verifySignature: ComputePluginSignatureVerifier
}

/** Immutable result consumed by a deployment-owned staging transaction. */
export interface ComputePluginInstallPlan {
  manifest: ComputeCapabilityPluginManifest
  manifestFingerprint: string
  packageDigest: string
  grantedPermissions: readonly ComputePluginPermission[]
  requiresNativeReview: boolean
  phase: 'verified'
}

/**
 * Verify a market manifest and return a staging plan without touching package code.
 * @param request - Untrusted manifest, package digest, signature and explicit grants.
 * @returns A frozen plan that a deployment adapter may stage transactionally.
 */
export async function planCapabilityPluginInstall(request: ComputePluginInstallRequest): Promise<ComputePluginInstallPlan> {
  const requestValue: unknown = request
  if (requestValue === null || typeof requestValue !== 'object' || Array.isArray(requestValue)) throw invalidInstall()
  const input = requestValue as ComputePluginInstallRequest
  const manifest = parseCapabilityPluginManifest(input.manifest)
  if (!digest(input.packageDigest) || !signature(input.signature) || !version(input.hostVersion)
    || typeof input.verifySignature !== 'function') throw invalidInstall()
  if (!Array.isArray(input.grantedPermissions)
    || input.grantedPermissions.some(permission => !manifestPermission(permission))) throw invalidInstall()
  if (manifest.pluginDigest !== input.packageDigest) throw new ComputeError('COMPUTE_PLUGIN_DIGEST_MISMATCH', 400)
  if (!hostCompatible(input.hostVersion, manifest.hostRange)) throw new ComputeError('COMPUTE_PLUGIN_HOST_INCOMPATIBLE', 409)
  const declared = new Set(manifest.capabilities.flatMap(capability => capability.permissions))
  const granted = new Set(input.grantedPermissions)
  for (const permission of declared) if (!granted.has(permission)) throw new ComputeError('COMPUTE_PLUGIN_PERMISSION_REQUIRED', 403)
  const manifestFingerprint = pluginManifestFingerprint(manifest)
  let trusted = false
  try { trusted = await input.verifySignature(manifestFingerprint, input.signature) } catch {
    throw new ComputeError('COMPUTE_PLUGIN_SIGNATURE_UNAVAILABLE', 503)
  }
  if (!trusted) throw new ComputeError('COMPUTE_PLUGIN_SIGNATURE_INVALID', 401)
  return Object.freeze({
    manifest,
    manifestFingerprint,
    packageDigest: input.packageDigest,
    grantedPermissions: Object.freeze([...new Set(input.grantedPermissions)]),
    requiresNativeReview: manifest.capabilities.some(capability => capability.permissions.some(permission => permission === 'gpu' || permission === 'model.local')),
    phase: 'verified' as const,
  })
}

/** Fingerprint the canonical, parsed manifest for an external signature verifier. */
export function pluginManifestFingerprint(value: ComputeCapabilityPluginManifest): string {
  const manifest = parseCapabilityPluginManifest(value)
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex')
}

function invalidInstall(): ComputeError { return new ComputeError('COMPUTE_PLUGIN_INSTALL_REQUEST_INVALID', 400) }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function signature(value: unknown): value is string { return typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[A-Za-z0-9+/_=-]+$/u.test(value) }
function version(value: unknown): value is string { return typeof value === 'string' && /^\d+\.\d+\.\d+$/u.test(value) }
function manifestPermission(value: unknown): value is ComputePluginPermission {
  return value === 'workspace.read' || value === 'workspace.write' || value === 'network.declared' || value === 'model.local' || value === 'gpu'
}
function hostCompatible(hostVersion: string, hostRange: string): boolean {
  const host = parseVersion(hostVersion)
  if (!host) return false
  const trimmed = hostRange.trim()
  if (trimmed === '*' || trimmed === '') return trimmed === '*'
  const exact = parseVersion(trimmed)
  if (exact) return compare(host, exact) === 0
  const minimum = /^>=\s*(\d+\.\d+\.\d+)$/u.exec(trimmed)
  if (minimum) {
    const lower = parseVersion(minimum[1] ?? '')
    return lower !== null && compare(host, lower) >= 0
  }
  const caret = /^\^\s*(\d+)\.(\d+)\.(\d+)$/u.exec(trimmed)
  if (caret) {
    const lower = { major: Number(caret[1]), minor: Number(caret[2]), patch: Number(caret[3]) }
    const upper = { major: lower.major + 1, minor: 0, patch: 0 }
    return compare(host, lower) >= 0 && compare(host, upper) < 0
  }
  return false
}
type Version = { major: number; minor: number; patch: number }
function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)
  return match === null ? null : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}
function compare(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalidInstall(); return JSON.stringify(value) }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  throw invalidInstall()
}
