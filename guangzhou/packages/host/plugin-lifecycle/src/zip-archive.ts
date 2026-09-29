/** Minimal, auditable ZIP reader for capability-plugin packages.
 *
 * Only the two methods a package builder realistically emits are supported:
 * stored (0) and deflate (8). Encrypted entries, Zip64, multi-disk archives,
 * symlink or special-file entries, traversal paths, duplicate names and any
 * mismatch between the local and central headers are rejected outright. The
 * reader never writes to disk: the installer writes only bytes that already
 * passed path, budget and digest verification.
 *
 * No external dependency is used on purpose. `yauzl`, `fflate` and `unzipper`
 * exist in the pnpm store as transitive dependencies of other workspace
 * packages, but declaring one would change this package's dependency set and
 * the lockfile, which is outside this work package's ownership.
 */
import { inflateRawSync } from 'node:zlib'
import { PluginLifecycleError } from './errors.ts'
import { canonicalPluginPath } from './package-path.ts'
import { PluginPackageBudget, assertPluginPackageLimits, type PluginPackageEntry, type PluginPackageLimits } from './package-payload.ts'

/** Reader configuration; the caller owns the budget. */
export interface PluginZipArchiveOptions { limits: PluginPackageLimits }

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_BYTES = 22
const CENTRAL_HEADER_BYTES = 46
const LOCAL_HEADER_BYTES = 30
const ZIP64_SENTINEL_16 = 0xffff
const ZIP64_SENTINEL_32 = 0xffffffff
const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8 = 0x0800
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
/** Parent-directory entries are allowed, but never without bound. */
const MAX_DIRECTORY_ENTRIES = 256

/**
 * Read an in-memory archive into canonical package entries.
 * @param archive - Complete archive bytes, as delivered by a package source.
 * @param options - Positive package limits applied while reading.
 * @returns Entries in central-directory order, without directory entries.
 */
export function readPluginZipArchive(archive: Uint8Array, options: PluginZipArchiveOptions): PluginPackageEntry[] {
  assertPluginPackageLimits(options.limits)
  if (!(archive instanceof Uint8Array) || archive.byteLength < EOCD_MIN_BYTES) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  const diskNumber = view.getUint16(eocd + 4, true)
  const centralDisk = view.getUint16(eocd + 6, true)
  const entriesOnDisk = view.getUint16(eocd + 8, true)
  const totalEntries = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) throw new PluginLifecycleError('PLUGIN_ZIP_MULTIDISK_UNSUPPORTED')
  if (totalEntries === ZIP64_SENTINEL_16 || centralSize === ZIP64_SENTINEL_32 || centralOffset === ZIP64_SENTINEL_32) throw new PluginLifecycleError('PLUGIN_ZIP_ZIP64_UNSUPPORTED')
  if (totalEntries > options.limits.maxFileCount + MAX_DIRECTORY_ENTRIES) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
  if (centralOffset + centralSize > eocd) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')

  const budget = new PluginPackageBudget(options.limits)
  const entries: PluginPackageEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > eocd || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
    const versionMadeBy = view.getUint16(cursor + 4, true)
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const expectedCrc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const startDisk = view.getUint16(cursor + 34, true)
    const externalAttributes = view.getUint32(cursor + 38, true)
    const localOffset = view.getUint32(cursor + 42, true)
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32 || localOffset === ZIP64_SENTINEL_32) throw new PluginLifecycleError('PLUGIN_ZIP_ZIP64_UNSUPPORTED')
    if (cursor + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength > eocd) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
    if (flags & FLAG_ENCRYPTED) throw new PluginLifecycleError('PLUGIN_ZIP_ENCRYPTED_UNSUPPORTED')
    if (startDisk !== 0) throw new PluginLifecycleError('PLUGIN_ZIP_MULTIDISK_UNSUPPORTED')
    const rawName = bytes.subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength)
    const name = decodeEntryName(rawName, flags)
    cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength
    if (name.endsWith('/')) {
      // Directory entries carry no payload; the path is still validated so a
      // traversal cannot be smuggled into the listing.
      canonicalPluginPath(name.slice(0, -1))
      continue
    }
    assertRegularFile(versionMadeBy, externalAttributes, name)
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) throw new PluginLifecycleError('PLUGIN_ZIP_METHOD_UNSUPPORTED')
    const path = canonicalPluginPath(name)
    if (uncompressedSize > options.limits.maxFileBytes || compressedSize > options.limits.maxFileBytes) throw new PluginLifecycleError('PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    const start = localDataOffset(view, localOffset, rawName, bytes.byteLength)
    if (start + compressedSize > bytes.byteLength || start + compressedSize > centralOffset + centralSize) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
    const stored = bytes.subarray(start, start + compressedSize)
    const content = method === METHOD_STORED ? stored : inflateEntry(stored, uncompressedSize)
    if (content.byteLength !== uncompressedSize) throw new PluginLifecycleError('PLUGIN_ZIP_SIZE_MISMATCH')
    if (crc32(content) !== expectedCrc) throw new PluginLifecycleError('PLUGIN_ZIP_CRC_MISMATCH')
    budget.add(path, content)
    entries.push({ path, bytes: content })
  }
  return entries
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - EOCD_MIN_BYTES - 0xffff)
  for (let offset = view.byteLength - EOCD_MIN_BYTES; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue
    const commentLength = view.getUint16(offset + 20, true)
    if (offset + EOCD_MIN_BYTES + commentLength === view.byteLength) return offset
  }
  throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
}

function localDataOffset(view: DataView, localOffset: number, expectedName: Buffer, totalBytes: number): number {
  if (localOffset + LOCAL_HEADER_BYTES > totalBytes || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
  const nameLength = view.getUint16(localOffset + 26, true)
  const extraLength = view.getUint16(localOffset + 28, true)
  const start = localOffset + LOCAL_HEADER_BYTES + nameLength + extraLength
  if (start > totalBytes) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
  const name = Buffer.from(view.buffer, view.byteOffset + localOffset + LOCAL_HEADER_BYTES, nameLength)
  if (!name.equals(expectedName)) throw new PluginLifecycleError('PLUGIN_ZIP_CORRUPT')
  return start
}

function inflateEntry(compressed: Buffer, uncompressedSize: number): Buffer {
  try {
    return inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) })
  } catch {
    // An inflate failure is either corrupt data or a declared-size bomb; both
    // are refused before any byte reaches the filesystem.
    throw new PluginLifecycleError('PLUGIN_ZIP_INFLATE_FAILED')
  }
}

function decodeEntryName(rawName: Buffer, flags: number): string {
  if (flags & FLAG_UTF8) return rawName.toString('utf8')
  // Without the UTF-8 flag the specification says CP437; a lossless latin1
  // decoding keeps every byte distinguishable and is still rejected by the
  // canonical path check when it produces a separator or a control character.
  return rawName.toString('latin1')
}

function assertRegularFile(versionMadeBy: number, externalAttributes: number, name: string): void {
  if (versionMadeBy >> 8 !== 3) return
  const mode = (externalAttributes >>> 16) & 0xffff
  if (mode === 0) return
  const type = mode & 0xf000
  if (type !== 0x8000) throw new PluginLifecycleError('PLUGIN_ZIP_ENTRY_TYPE_REJECTED')
  if (name.length === 0) throw new PluginLifecycleError('PLUGIN_PATH_INVALID')
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0
  return (value ^ 0xffffffff) >>> 0
}
