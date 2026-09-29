/** Select and copy the local npm tarball closures that supply Desktop dsh and its private Host. */

import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, posix, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  parseDesktopCorePackageSet,
  type DesktopCorePackageRecord,
} from '../src/core-package-set.ts'
import { capture } from '../../../scripts/release/process.ts'
import { tarballFiles } from '../../../scripts/release/tarball.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const QIANSHOU_MEMORY_PACKAGE = '@deepseek-ai/dsh-host-qianshou-memory'
const ROOT_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE] as const
const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const QIANSHOU_PRESETS_DIR = join(REPOSITORY_ROOT, 'qianshou', 'presets')

const REQUIRED_DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies'] as const
const OPTIONAL_DEPENDENCY_SECTION = 'optionalDependencies'

/** Packed package information needed to form the local Desktop closure. */
export interface PackedDesktopPackage {
  readonly tarball: string
  readonly manifest: Readonly<Record<string, unknown>>
}

function dependencyNames(manifest: Readonly<Record<string, unknown>>, section: string): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${String(manifest.name)} has invalid ${section}`)
  }
  return Object.keys(value).sort()
}

/**
 * Select workspace dependencies rooted at dsh and its private Host; npm resolves external packages.
 * Reads the repository workspace manifest and package manifests to distinguish required local packages from npm-resolved externals.
 * @param available - Packed packages indexed by package name.
 * @returns Selected packages sorted by name.
 */
export function selectDesktopPackageClosure(
  available: ReadonlyMap<string, PackedDesktopPackage>,
): PackedDesktopPackage[] {
  const workspace = yaml.load(readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const workspaceNames = new Set(globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: REPOSITORY_ROOT })
    .map(path => (JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as { name: string }).name))
  const selected = new Map<string, PackedDesktopPackage>()
  const visit = (name: string): void => {
    if (selected.has(name)) return
    const packed = available.get(name)
    if (packed === undefined) throw new Error(`desktop package set: packed inputs omit required package ${name}`)
    selected.set(name, packed)
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(packed.manifest, section)) {
        if (available.has(dependency)) visit(dependency)
        else if (workspaceNames.has(dependency)) {
          throw new Error(`desktop package set: ${name} requires unpacked package ${dependency}`)
        }
      }
    }
    for (const dependency of dependencyNames(packed.manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      if (available.has(dependency)) visit(dependency)
    }
  }
  for (const name of ROOT_PACKAGES) {
    if (!available.has(name)) throw new Error(`desktop package set: packed inputs omit ${name}`)
    visit(name)
  }
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, packed]) => packed)
}

function packedManifest(tarball: string): Record<string, unknown> {
  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${tarball} has no package manifest`)
  }
  return value as Record<string, unknown>
}

function packedPackages(inputs: readonly string[]): Map<string, PackedDesktopPackage> {
  const available = new Map<string, PackedDesktopPackage>()
  for (const input of inputs) {
    const tarballs = readdirSync(input).filter(file => file.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`desktop package set: ${input} contains no tarballs`)
    for (const file of tarballs) {
      const tarball = join(input, file)
      const manifest = packedManifest(tarball)
      const name = manifest.name
      if (typeof name !== 'string' || name === '') throw new Error(`desktop package set: ${tarball} has no package name`)
      if (available.has(name)) throw new Error(`desktop package set: duplicate packed package ${name}`)
      available.set(name, { tarball, manifest })
    }
  }
  return available
}

/**
 * Require every private Host file used before the Desktop profile can pass its health check.
 * @param files - Tarball paths rooted at `package/`.
 * @returns Nothing.
 */
export function assertDesktopHostPackageFiles(files: readonly string[]): void {
  const available = new Set(files)
  const missing = DESKTOP_HOST_RUNTIME_FILES
    .map(file => `package/${file}`)
    .filter(file => !available.has(file))
  if (missing.length > 0) {
    throw new Error(`desktop package set: ${DESKTOP_HOST_PACKAGE} tarball omits required file(s): ${missing.join(', ')}`)
  }
}

/** Follow packaged ESM-relative imports from entry points, including generated shared chunks. */
export function assertPackedRelativeImportClosure(
  files: readonly string[],
  entries: readonly string[],
  read: (file: string) => string,
): void {
  const available = new Set(files)
  const visited = new Set<string>()
  const pending = [...entries]
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (visited.has(file)) continue
    if (!available.has(file)) throw new Error(`desktop package set: packed module omits ${file}`)
    visited.add(file)
    const source = read(file)
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/gu)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[1] as string))
      if (!target.startsWith('package/')) throw new Error(`desktop package set: ${file} imports outside package: ${target}`)
      if (!available.has(target)) throw new Error(`desktop package set: ${file} imports missing packed module ${target}`)
      if (target.endsWith('.js')) pending.push(target)
    }
  }
}

/** Collect the exact package entry points mounted by shipped Qianshou agent presets. */
export function presetPackageSpecifiers(presetsDir: string): string[] {
  const specifiers = new Set<string>()
  for (const preset of globSync('**/agent.cordis.yml', { cwd: presetsDir })) {
    const source = readFileSync(join(presetsDir, preset), 'utf8')
    for (const match of source.matchAll(/^[ \t]*(?:-[ \t]+)?name:[ \t]*['"]?(@deepseek-ai\/[\w.-]+(?:\/[\w./-]+)?)/gmu)) {
      specifiers.add(match[1] as string)
    }
  }
  return [...specifiers].sort()
}

function runtimeExportPath(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const conditions = value as Record<string, unknown>
  for (const key of ['node', 'import', 'default', 'require']) {
    if (key in conditions) {
      const path = runtimeExportPath(conditions[key])
      if (path !== null) return path
    }
  }
  return null
}

/** Resolve a preset package specifier from the packed manifest, never from the checkout. */
export function packedPresetEntry(specifier: string, manifest: Readonly<Record<string, unknown>>): string {
  const match = /^(@deepseek-ai\/[\w.-]+)(?:\/(.+))?$/u.exec(specifier)
  if (match === null || manifest.name !== match[1]) {
    throw new Error(`desktop package set: invalid preset package ${specifier}`)
  }
  const subpath = match[2] === undefined ? '.' : `./${match[2]}`
  const exports = manifest.exports
  const target = exports !== null && typeof exports === 'object' && !Array.isArray(exports)
    ? runtimeExportPath((exports as Record<string, unknown>)[subpath])
    : subpath === '.' ? runtimeExportPath(manifest.main) : null
  if (target === null || !/^\.\/(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs)$/u.test(target)) {
    throw new Error(`desktop package set: ${specifier} has no exact packed runtime export`)
  }
  return `package/${target.slice(2)}`
}

/** Check the packed exports and ESM chunk closure for every entry mounted by a shipped preset. */
export function assertPackedPresetPackageClosures(
  specifiers: readonly string[],
  selected: readonly PackedDesktopPackage[],
  files: (packed: PackedDesktopPackage) => readonly string[],
  read: (packed: PackedDesktopPackage, file: string) => string,
): void {
  const packages = new Map(selected.map(packed => [packed.manifest.name, packed]))
  const entries = new Map<PackedDesktopPackage, string[]>()
  for (const specifier of specifiers) {
    const name = /^(@deepseek-ai\/[\w.-]+)/u.exec(specifier)?.[1]
    const packed = name === undefined ? undefined : packages.get(name)
    if (packed === undefined) throw new Error(`desktop package set: preset requires unpacked package ${specifier}`)
    const entry = packedPresetEntry(specifier, packed.manifest)
    entries.set(packed, [...(entries.get(packed) ?? []), entry])
  }
  for (const [packed, paths] of entries) {
    assertPackedRelativeImportClosure(files(packed), paths, file => read(packed, file))
  }
}

/** Prepare a package set from release tarball directories. */
export function prepareDesktopPackageSet(inputs: readonly string[], output: string): void {
  const selected = selectDesktopPackageClosure(packedPackages(inputs))
  const host = selected.find(packed => packed.manifest.name === DESKTOP_HOST_PACKAGE)
  if (host === undefined) throw new Error(`desktop package set: selected closure omits ${DESKTOP_HOST_PACKAGE}`)
  assertDesktopHostPackageFiles(tarballFiles(host.tarball))
  const memory = selected.find(packed => packed.manifest.name === QIANSHOU_MEMORY_PACKAGE)
  if (memory !== undefined) {
    assertPackedRelativeImportClosure(tarballFiles(memory.tarball), [
      'package/lib/index.js', 'package/lib/tools.js',
    ], file => capture('tar', ['-xOzf', memory.tarball, file]))
  }
  assertPackedPresetPackageClosures(presetPackageSpecifiers(QIANSHOU_PRESETS_DIR), selected,
    packed => tarballFiles(packed.tarball),
    (packed, file) => capture('tar', ['-xOzf', packed.tarball, file]))
  rmSync(output, { recursive: true, force: true })
  const packageDir = join(output, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDir, { recursive: true })
  const records: DesktopCorePackageRecord[] = selected.map((packed) => {
    const name = packed.manifest.name
    const version = packed.manifest.version
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`desktop package set: ${packed.tarball} has no package identity`)
    }
    const file = basename(packed.tarball)
    const destination = join(packageDir, file)
    copyFileSync(packed.tarball, destination, constants.COPYFILE_EXCL)
    const body = readFileSync(destination)
    return {
      name,
      version,
      file,
      bytes: statSync(destination).size,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    }
  })
  const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: records })
  writeFileSync(join(output, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify(packageSet, undefined, 2)}\n`, { mode: 0o600 })
}

function main(): void {
  const buildPaths = resolveDesktopTargetBuildPaths()
  const defaultInputs = [
    buildPaths.packedDsh,
    buildPaths.packedVendor,
    buildPaths.packedLandlock,
  ]
  const { values } = parseArgs({
    options: { from: { type: 'string', multiple: true }, out: { type: 'string' } },
    allowPositionals: false,
  })
  const inputs = (values.from ?? defaultInputs).map(path => resolve(REPOSITORY_ROOT, path))
  const output = values.out === undefined ? buildPaths.packageSet : resolve(REPOSITORY_ROOT, values.out)
  prepareDesktopPackageSet(inputs, output)
  console.log(`desktop package set: prepared ${output}`)
}

if (import.meta.main) main()
