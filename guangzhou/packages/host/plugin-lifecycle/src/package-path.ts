/** Relative-path rules shared by package intake, the local store and the installer.
 *
 * Two strictness levels exist on purpose:
 * - `normalizeRelativePluginPath` mirrors the digest/traversal rules used by the
 *   staged-package verifier. It keeps the historical behaviour that the package
 *   digest was defined on.
 * - `canonicalPluginPath` is the strictest form and is the only one admitted at a
 *   real filesystem boundary (store payload, installer generation, archive entry).
 *   It additionally rejects Windows drive colons and any non-normalised spelling.
 */
import { posix } from 'node:path'
import { PluginLifecycleError } from './errors.ts'

/** Normalise a package path for digesting; traversal and absolute paths fail. */
export function normalizeRelativePluginPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\u0000') || posix.isAbsolute(value)) throw new PluginLifecycleError('PLUGIN_PATH_INVALID')
  const normalized = posix.normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/')) throw new PluginLifecycleError('PLUGIN_PATH_INVALID')
  return normalized
}

/** Canonical path admitted at a filesystem or archive boundary. */
export function canonicalPluginPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || value.includes(':') || posix.isAbsolute(value) || posix.normalize(value) !== value
    || value === '.' || value === '..' || value.startsWith('../') || value.endsWith('/')) {
    throw new PluginLifecycleError('PLUGIN_PATH_INVALID')
  }
  return value
}
