/** Canonical ZIP for an author order adapter, byte-identical to the signed source inventory. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { CatalogFailure } from './registry.ts'
import { readGenericOrderSource } from './generic-order-source.ts'
import { readNativeH3OrderSource } from './native-h3-order-source.ts'
import { readComfyVideoOrderSource } from './comfy-video-order-source.ts'
import { assertCanonicalSourceJson } from './order-source-json.ts'
import { LEGACY_INVENTORY_ALGORITHM, SOURCE_INVENTORY_ALGORITHM, NATIVE_BINDING_INVENTORY_ALGORITHM,
  COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM,
  validateOrderSourceInventory } from './order-source-inventory.ts'

const FILES = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
  'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift'] as const
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MAX_FILE_BYTES = 2_000_000
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024

function inside(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

interface SourceEntry { readonly name: string; readonly bytes: Buffer; readonly checksum: number;
  readonly offset: number }

function localHeader(entry: SourceEntry): Buffer {
  const name = Buffer.from(entry.name, 'ascii')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0x21, 12)
  header.writeUInt32LE(entry.checksum, 14)
  header.writeUInt32LE(entry.bytes.length, 18)
  header.writeUInt32LE(entry.bytes.length, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, name, entry.bytes])
}

function centralHeader(entry: SourceEntry): Buffer {
  const name = Buffer.from(entry.name, 'ascii')
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(0x0314, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(0x21, 14)
  header.writeUInt32LE(entry.checksum, 16)
  header.writeUInt32LE(entry.bytes.length, 20)
  header.writeUInt32LE(entry.bytes.length, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  header.writeUInt32LE(entry.offset, 42)
  return Buffer.concat([header, name])
}

function archiveEnd(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return end
}

export interface CanonicalOrderArchive {
  readonly bytes: Buffer
  readonly archiveDigest: string
  readonly artifactDigest: string
  readonly sizeBytes: number
  readonly files: readonly { readonly path: string; readonly size_bytes: number; readonly sha256: string }[]
  readonly platformDispatchable: boolean
  readonly inventoryAlgorithm: typeof LEGACY_INVENTORY_ALGORITHM | typeof SOURCE_INVENTORY_ALGORITHM
    | typeof NATIVE_BINDING_INVENTORY_ALGORITHM | typeof COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM
  readonly taskType: string
  readonly capabilityId: string
}

/**
 * Read the exact registered source once and create the format Guangzhou independently checks.
 * @param root - Installed adapter root after local self-test.
 * @param expectedArtifactDigest - Pinned source digest returned by the registered adapter.
 * @returns Canonical ZIP bytes and digests for the exact captured files.
 */
export async function buildCanonicalOrderArchive(root: string,
  expectedArtifactDigest: string, inventoryAlgorithm: typeof LEGACY_INVENTORY_ALGORITHM
    | typeof SOURCE_INVENTORY_ALGORITHM | typeof NATIVE_BINDING_INVENTORY_ALGORITHM
    | typeof COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM = LEGACY_INVENTORY_ALGORITHM): Promise<CanonicalOrderArchive> {
  if (!isAbsolute(root) || !DIGEST.test(expectedArtifactDigest)) throw new CatalogFailure('order-adapter-invalid')
  if (inventoryAlgorithm === SOURCE_INVENTORY_ALGORITHM || inventoryAlgorithm === NATIVE_BINDING_INVENTORY_ALGORITHM
    || inventoryAlgorithm === COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM) {
    const skillPath = join(root, '..', '..', 'SKILL.md')
    const source = inventoryAlgorithm === NATIVE_BINDING_INVENTORY_ALGORITHM
      ? await readNativeH3OrderSource(skillPath)
      : inventoryAlgorithm === COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM
        ? await readComfyVideoOrderSource(skillPath) : await readGenericOrderSource(skillPath)
    assertCanonicalSourceJson(source.files)
    if (source.root !== await realpath(root) || `sha256:${source.digest}` !== expectedArtifactDigest) {
      throw new CatalogFailure('order-adapter-invalid')
    }
    const entries: SourceEntry[] = []
    let offset = 0
    for (const file of source.files) {
      entries.push({ name: file.path, bytes: file.bytes, checksum: crc32(file.bytes), offset })
      offset += 30 + Buffer.byteLength(file.path, 'ascii') + file.bytes.length
    }
    const listed = source.files.map(file => ({ path: file.path, size_bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex') }))
    validateOrderSourceInventory(inventoryAlgorithm, listed.map(file => ({ path: file.path,
      sizeBytes: file.size_bytes, sha256: file.sha256 })))
    const local = entries.map(localHeader)
    const central = entries.map(centralHeader)
    const centralSize = central.reduce((sum, item) => sum + item.length, 0)
    const bytes = Buffer.concat([...local, ...central, archiveEnd(entries.length, centralSize, offset)])
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new CatalogFailure('order-adapter-invalid')
    return { bytes, archiveDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      artifactDigest: expectedArtifactDigest, sizeBytes: bytes.length, files: listed,
      platformDispatchable: source.declaration.platformDispatchable,
      inventoryAlgorithm, taskType: source.declaration.taskType,
      capabilityId: source.declaration.capabilityId }
  }
  if (inventoryAlgorithm !== LEGACY_INVENTORY_ALGORITHM) throw new CatalogFailure('order-adapter-invalid')
  for (const directory of [root, join(root, 'src')]) {
    const entry = await lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CatalogFailure('order-adapter-invalid')
  }
  const resolved = await realpath(root)
  const source = createHash('sha256')
  const entries: SourceEntry[] = []
  let offset = 0
  for (const name of FILES) {
    const path = join(resolved, name)
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_FILE_BYTES
      || !inside(resolved, await realpath(path))) throw new CatalogFailure('order-adapter-invalid')
    const bytes = await readFile(path)
    const after = await lstat(path)
    if (!after.isFile() || after.isSymbolicLink() || bytes.length !== before.size
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || !inside(resolved, await realpath(path))) throw new CatalogFailure('order-adapter-invalid')
    source.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes)
    const entry = { name, bytes, checksum: crc32(bytes), offset }
    entries.push(entry)
    offset += 30 + Buffer.byteLength(name, 'ascii') + bytes.length
  }
  const artifactDigest = `sha256:${source.digest('hex')}`
  if (artifactDigest !== expectedArtifactDigest) throw new CatalogFailure('order-adapter-invalid')
  let declaration: unknown
  try { declaration = JSON.parse(entries[2]!.bytes.toString('utf8')) }
  catch { throw new CatalogFailure('order-adapter-invalid') }
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new CatalogFailure('order-adapter-invalid')
  }
  const local = entries.map(localHeader)
  const central = entries.map(centralHeader)
  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const bytes = Buffer.concat([...local, ...central, archiveEnd(entries.length, centralSize, offset)])
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new CatalogFailure('order-adapter-invalid')
  return { bytes, archiveDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    artifactDigest, sizeBytes: bytes.length,
    files: entries.map(entry => ({ path: entry.name, size_bytes: entry.bytes.length,
      sha256: createHash('sha256').update(entry.bytes).digest('hex') })),
    platformDispatchable: (declaration as Record<string, unknown>).platformDispatchable === true,
    inventoryAlgorithm, taskType: 'bar_chart_svg_v1', capabilityId: 'video.render' }
}
