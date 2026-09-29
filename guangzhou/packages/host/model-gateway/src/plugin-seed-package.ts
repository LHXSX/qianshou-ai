/** Bounded inspection of the first reviewed Qianshou package format. No archive entry is executed. */
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import type { ApprovedPluginRelease } from './plugin-releases.ts'

const FILES = [
  'manifest.json', 'schemas/input.json', 'schemas/output.json',
  'samples/basic-input.json', 'samples/basic-output.json',
] as const
const MAX_ARCHIVE = 2 * 1024 * 1024
const MAX_ENTRY = 512 * 1024
const MAX_UNPACKED = 2 * 1024 * 1024
const MAX_DECLARATION_OPERATIONS = 16
const SHA256 = /^[0-9a-f]{64}$/u
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const
const EXECUTORS = ['workflow', 'node', 'python', 'model', 'tool'] as const
const PERMISSIONS = ['workspace.read', 'workspace.write', 'network.declared', 'model.local', 'gpu'] as const

/** Fixed, non-executable manifest for the first official CSV adapter. */
export interface SeedPackageManifest {
  readonly format: 'qianshou.seed-csv-profile.v1'
  readonly pluginId: string
  readonly version: string
  readonly releaseId: string
  readonly operationId: string
  readonly capabilityId: string
  readonly executorId: 'qianshou.csv-profile.adapter.v1'
  readonly inputSchemaSha256: string
  readonly outputSchemaSha256: string
}

/** Archive and unpacked-file digests observed from one bounded ZIP. */
export interface VerifiedSeedPackage {
  readonly manifest: SeedPackageManifest
  readonly packageSha256: string
  readonly packageBytes: number
  readonly inputSchemaSha256: string
  readonly outputSchemaSha256: string
  /** Canonical digest of every uncompressed entry name and SHA-256, independent of ZIP layout. */
  readonly unpackedTreeSha256: string
}

/** Untrusted metadata only: this format carries no executable or adapter implementation. */
export interface DeclarationPackageManifest {
  readonly format: 'qianshou.declaration.v1'
  readonly pluginId: string
  readonly version: string
  readonly releaseId: string
  readonly platforms: readonly string[]
  readonly architectures: readonly string[]
  readonly operations: readonly {
    readonly capabilityId: string
    readonly operationId: string
    readonly executorKind: string
    readonly inputSchemaSha256: string
    readonly outputSchemaSha256: string
    readonly permissions: readonly string[]
  }[]
}

/** Exact transport and uncompressed-entry hashes for one declaration-only archive. */
export interface VerifiedDeclarationPackage {
  readonly manifest: DeclarationPackageManifest
  readonly packageSha256: string
  readonly packageBytes: number
  readonly unpackedTreeSha256: string
}

function invalid(): never { throw new Error('PLUGIN_SEED_PACKAGE_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid()
}
function json(bytes: Buffer): Record<string, unknown> {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return record(JSON.parse(decoded) as unknown)
  } catch { return invalid() }
}
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function zipEntries(archive: Buffer, maximumEntries: number,
  allowedName: (name: string) => boolean): ReadonlyMap<string, Buffer> {
  if (archive.length < 22 || archive.length > MAX_ARCHIVE) invalid()
  let eocd = -1
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50 && at + 22 + archive.readUInt16LE(at + 20) === archive.length) {
      eocd = at
      break
    }
  }
  if (eocd < 0 || archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0
    || archive.readUInt16LE(eocd + 8) !== archive.readUInt16LE(eocd + 10)
    || archive.readUInt16LE(eocd + 10) < 1 || archive.readUInt16LE(eocd + 10) > maximumEntries
    || archive.readUInt16LE(eocd + 20) !== 0) invalid()
  const count = archive.readUInt16LE(eocd + 10)
  const directorySize = archive.readUInt32LE(eocd + 12)
  const directoryOffset = archive.readUInt32LE(eocd + 16)
  if (directoryOffset + directorySize !== eocd) invalid()
  const entries = new Map<string, Buffer>()
  const spans: { start: number; end: number }[] = []
  let cursor = directoryOffset
  let unpacked = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== 0x02014b50) invalid()
    const madeBy = archive.readUInt16LE(cursor + 4)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressed = archive.readUInt32LE(cursor + 20)
    const uncompressed = archive.readUInt32LE(cursor + 24)
    const nameBytes = archive.readUInt16LE(cursor + 28)
    const extra = archive.readUInt16LE(cursor + 30)
    const comment = archive.readUInt16LE(cursor + 32)
    const disk = archive.readUInt16LE(cursor + 34)
    const external = archive.readUInt32LE(cursor + 38)
    const local = archive.readUInt32LE(cursor + 42)
    const end = cursor + 46 + nameBytes + extra + comment
    if (end > eocd || flags & ~0x0800 || disk !== 0 || extra !== 0 || comment !== 0
      || (method !== 0 && method !== 8)
      || uncompressed > MAX_ENTRY || compressed > MAX_ENTRY || compressed === 0xffffffff
      || uncompressed === 0xffffffff || local === 0xffffffff) invalid()
    if ((madeBy >> 8) === 3 && ((external >>> 16) & 0xf000) !== 0x8000) invalid()
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameBytes)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName)
    if (!allowedName(name) || entries.has(name) || (external & 0x10) !== 0) invalid()
    if (local + 30 > directoryOffset || archive.readUInt32LE(local) !== 0x04034b50
      || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method
      || archive.readUInt32LE(local + 14) !== crc
      || archive.readUInt32LE(local + 18) !== compressed
      || archive.readUInt32LE(local + 22) !== uncompressed) invalid()
    const localNameBytes = archive.readUInt16LE(local + 26)
    const localExtra = archive.readUInt16LE(local + 28)
    const data = local + 30 + localNameBytes + localExtra
    if (localNameBytes !== nameBytes || localExtra !== 0
      || !archive.subarray(local + 30, local + 30 + nameBytes).equals(rawName)
      || data + compressed > directoryOffset) invalid()
    const raw = archive.subarray(data, data + compressed)
    let bytes: Buffer
    try { bytes = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(uncompressed, 1) }) }
    catch { return invalid() }
    if (bytes.length !== uncompressed || crc32(bytes) !== crc) invalid()
    unpacked += bytes.length
    if (unpacked > MAX_UNPACKED) invalid()
    entries.set(name, bytes)
    spans.push({ start: local, end: data + compressed })
    cursor = end
  }
  if (cursor !== eocd || entries.size !== count) invalid()
  spans.sort((left, right) => left.start - right.start)
  if (spans[0]?.start !== 0 || spans[spans.length - 1]?.end !== directoryOffset
    || spans.some((span, index) => index > 0 && span.start !== spans[index - 1]!.end)) invalid()
  return entries
}

/** Ordinary instruction skills are packages, without an adapter capability ABI.
 * Inspection binds bytes only; staff must pull and test the original package before publication.
 */
export function verifyOrdinarySkillPackage(archive: Buffer): {
  packageSha256: string; packageBytes: number; unpackedTreeSha256: string; skillMdSha256: string; skillMdPath: string
  files: readonly { path: string; sha256: string; sizeBytes: number }[]
} {
  const entries = zipEntries(archive, 128, name => name.length <= 240 && name === name.normalize('NFC')
    && !name.startsWith('/') && !/[\\:\u0000-\u001f\u007f]/u.test(name) && name.split('/').every(part => part !== '' && part !== '.' && part !== '..'
      && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))
  const names = [...entries.keys()].sort()
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) invalid()
  const skills = names.filter(n => n === 'SKILL.md' || /^[^/]+\/SKILL\.md$/u.test(n))
  if (skills.length !== 1) invalid()
  const skillMdPath = skills[0]!
  const root = skillMdPath === 'SKILL.md' ? '' : skillMdPath.slice(0, -'SKILL.md'.length)
  if (root !== '' && names.some(n => !n.startsWith(root))) invalid()
  const bytes = entries.get(skillMdPath)!
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return invalid() }
  if (bytes.length > 256 * 1024 || text.trim() === '' || text.includes('\0')) invalid()
  const files = names.map(path => ({ path, sha256: sha(entries.get(path)!), sizeBytes: entries.get(path)!.length }))
  return { packageSha256: sha(archive), packageBytes: archive.length,
    unpackedTreeSha256: sha(Buffer.from(JSON.stringify(files.map(f => [f.path, f.sha256])))),
    skillMdSha256: sha(bytes), skillMdPath, files }
}

/** Verify the exact v1 seed archive and bind its manifest and schema bytes to their digests.
 * @param archive - Complete downloaded ZIP bytes.
 * @returns Parsed seed manifest and verified archive/unpacked digests.
 */
export function verifySeedPluginPackage(archive: Buffer): VerifiedSeedPackage {
  const files = zipEntries(archive, FILES.length, name => FILES.includes(name as typeof FILES[number]))
  if (files.size !== FILES.length) invalid()
  const manifest = json(files.get('manifest.json')!)
  exact(manifest, ['format', 'pluginId', 'version', 'releaseId', 'operationId', 'capabilityId',
    'executorId', 'inputSchemaSha256', 'outputSchemaSha256'])
  if (manifest['format'] !== 'qianshou.seed-csv-profile.v1'
    || manifest['pluginId'] !== 'qianshou.csv-profile' || manifest['executorId'] !== 'qianshou.csv-profile.adapter.v1'
    || typeof manifest['version'] !== 'string' || !VERSION.test(manifest['version'])
    || typeof manifest['releaseId'] !== 'string' || !ID.test(manifest['releaseId'])
    || manifest['operationId'] !== 'csv.profile' || manifest['capabilityId'] !== 'text.transform'
    || typeof manifest['inputSchemaSha256'] !== 'string' || !SHA256.test(manifest['inputSchemaSha256'])
    || typeof manifest['outputSchemaSha256'] !== 'string' || !SHA256.test(manifest['outputSchemaSha256'])) invalid()
  const inputBytes = files.get('schemas/input.json')!
  const outputBytes = files.get('schemas/output.json')!
  const inputSchema = json(inputBytes)
  const outputSchema = json(outputBytes)
  if (inputSchema['type'] !== 'object' || outputSchema['type'] !== 'object'
    || sha(inputBytes) !== manifest['inputSchemaSha256']
    || sha(outputBytes) !== manifest['outputSchemaSha256']) invalid()
  json(files.get('samples/basic-input.json')!)
  json(files.get('samples/basic-output.json')!)
  const unpackedTreeSha256 = sha(Buffer.from(JSON.stringify(FILES.map(path => [path, sha(files.get(path)!)]))))
  return {
    manifest: manifest as unknown as SeedPackageManifest,
    packageSha256: sha(archive), packageBytes: archive.length,
    inputSchemaSha256: sha(inputBytes), outputSchemaSha256: sha(outputBytes),
    unpackedTreeSha256,
  }
}

function canonicalJson(bytes: Buffer): Record<string, unknown> {
  const value = json(bytes)
  try {
    if (Buffer.from(JSON.stringify(value), 'utf8').equals(bytes)) return value
  } catch { return invalid() }
  return invalid()
}

function enumList(value: unknown, allowed: readonly string[], requireOne: boolean): value is string[] {
  return Array.isArray(value) && value.length <= allowed.length && (!requireOne || value.length > 0)
    && value.every(item => typeof item === 'string' && allowed.includes(item))
    && new Set(value).size === value.length
}

/** Verify one bounded declaration-only ZIP. Paths are fixed by operation indexes; no other entry is accepted.
 * @param archive - Complete ZIP bytes submitted by an account-bound publisher.
 * @returns Parsed declaration and hashes of the exact archive and every uncompressed entry.
 */
export function verifyDeclarationPluginPackage(archive: Buffer): VerifiedDeclarationPackage {
  const files = zipEntries(archive, 1 + 2 * MAX_DECLARATION_OPERATIONS,
    name => name === 'manifest.json' || /^schemas\/(?:0|[1-9]|1[0-5])\/(?:input|output)\.json$/u.test(name))
  const manifest = canonicalJson(files.get('manifest.json') ?? invalid())
  exact(manifest, ['format', 'pluginId', 'version', 'releaseId', 'platforms', 'architectures', 'operations'])
  const operations = manifest['operations']
  if (manifest['format'] !== 'qianshou.declaration.v1'
    || typeof manifest['pluginId'] !== 'string' || manifest['pluginId'].length > 80 || !ID.test(manifest['pluginId'])
    || typeof manifest['version'] !== 'string' || manifest['version'].length > 40 || !VERSION.test(manifest['version'])
    || typeof manifest['releaseId'] !== 'string' || manifest['releaseId'].length > 80 || !ID.test(manifest['releaseId'])
    || !enumList(manifest['platforms'], PLATFORMS, true)
    || !enumList(manifest['architectures'], ARCHITECTURES, true)
    || !Array.isArray(operations) || operations.length < 1 || operations.length > MAX_DECLARATION_OPERATIONS
    || files.size !== 1 + 2 * operations.length) invalid()
  const expected = ['manifest.json']
  const seen = new Set<string>()
  for (const [index, raw] of operations.entries()) {
    const operation = record(raw)
    exact(operation, ['capabilityId', 'operationId', 'executorKind', 'inputSchemaSha256',
      'outputSchemaSha256', 'permissions'])
    const capabilityId = operation['capabilityId']
    const operationId = operation['operationId']
    const executorKind = operation['executorKind']
    if (typeof capabilityId !== 'string' || !OPERATION_ID.test(capabilityId)
      || typeof operationId !== 'string' || !OPERATION_ID.test(operationId)
      || typeof executorKind !== 'string' || !EXECUTORS.includes(executorKind as typeof EXECUTORS[number])
      || typeof operation['inputSchemaSha256'] !== 'string' || !SHA256.test(operation['inputSchemaSha256'])
      || typeof operation['outputSchemaSha256'] !== 'string' || !SHA256.test(operation['outputSchemaSha256'])
      || !enumList(operation['permissions'], PERMISSIONS, false)
      || seen.has(`${capabilityId}\n${operationId}`)) invalid()
    seen.add(`${capabilityId}\n${operationId}`)
    for (const kind of ['input', 'output'] as const) {
      const path = `schemas/${index}/${kind}.json`
      expected.push(path)
      const bytes = files.get(path)
      if (bytes === undefined || sha(bytes) !== operation[`${kind}SchemaSha256`]
        || canonicalJson(bytes)['type'] !== 'object') invalid()
    }
  }
  if (expected.some(path => !files.has(path))) invalid()
  const unpackedTreeSha256 = sha(Buffer.from(JSON.stringify(expected.map(path => [path, sha(files.get(path)!)]))))
  return { manifest: manifest as unknown as DeclarationPackageManifest,
    packageSha256: sha(archive), packageBytes: archive.length, unpackedTreeSha256 }
}

/** Compare the independently signed release operation with the unpacked seed manifest.
 * @param seed - Already verified archive contents.
 * @param release - Independently signed release declaration.
 * @returns Whether the same fixed operation and bytes were approved.
 */
export function matchesSeedReleaseDeclaration(seed: VerifiedSeedPackage, release: ApprovedPluginRelease): boolean {
  const manifest = seed.manifest
  return release.pluginId === manifest.pluginId && release.version === manifest.version
    && release.releaseId === manifest.releaseId && release.packageSha256 === seed.packageSha256
    && release.packageBytes === seed.packageBytes
    && JSON.stringify(release.platforms) === JSON.stringify(['darwin', 'win32'])
    && JSON.stringify(release.architectures) === JSON.stringify(['arm64', 'x64'])
    && release.operations.length === 1 && release.operations[0]!.capabilityId === manifest.capabilityId
    && release.operations[0]!.operationId === manifest.operationId
    && release.operations[0]!.executorKind === 'node'
    && release.operations[0]!.inputSchemaSha256 === seed.inputSchemaSha256
    && release.operations[0]!.outputSchemaSha256 === seed.outputSchemaSha256
    && release.operations[0]!.permissions.length === 0
}
