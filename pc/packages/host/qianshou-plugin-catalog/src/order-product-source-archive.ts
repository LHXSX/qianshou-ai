/** Exact, bounded reader for ZIP_STORED archives with a signed source inventory. */
import { createHash } from 'node:crypto'
import { CatalogFailure } from './registry.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import { validateOrderSourceInventory } from './order-source-inventory.ts'

const MAX_ARCHIVE = 16 * 1024 * 1024
const DOS_DATE = 33 // 1980-01-01
const UNIX_REGULAR_0644 = 0o100644

function invalid(): never { throw new CatalogFailure('order-install-manifest-invalid') }
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255]!
  return (value ^ 0xffffffff) >>> 0
}

function bounded(bytes: Buffer, start: number, length: number): Buffer {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0
    || start + length > bytes.length) invalid()
  return bytes.subarray(start, start + length)
}

function u16(bytes: Buffer, offset: number): number { return bounded(bytes, offset, 2).readUInt16LE(0) }
function u32(bytes: Buffer, offset: number): number { return bounded(bytes, offset, 4).readUInt32LE(0) }

/** Reject all ZIP ambiguity: extra members, descriptors, ZIP64, links, compression and trailing data. */
export function inspectOrderProductSourceArchive(bytes: Buffer, source: VerifiedOrderAdapterSource):
  { files: ReadonlyMap<string, Buffer>; artifactDigest: string } {
  validateOrderSourceInventory(source.inventoryAlgorithm, source.files)
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_ARCHIVE
    || bytes.length !== source.check.archiveSizeBytes
    || `sha256:${sha256(bytes)}` !== source.check.archiveDigest) invalid()
  const eocd = bytes.length - 22
  if (u32(bytes, eocd) !== 0x06054b50 || u16(bytes, eocd + 4) !== 0
    || u16(bytes, eocd + 6) !== 0 || u16(bytes, eocd + 8) !== source.files.length
    || u16(bytes, eocd + 10) !== source.files.length || u16(bytes, eocd + 20) !== 0) invalid()
  const centralSize = u32(bytes, eocd + 12)
  const centralStart = u32(bytes, eocd + 16)
  if (centralStart + centralSize !== eocd) invalid()
  const files = new Map<string, Buffer>()
  const artifact = createHash('sha256')
  let localEnd = 0
  let cursor = centralStart
  for (let index = 0; index < source.files.length; index += 1) {
    const row = source.files[index]!
    const expected = row.path
    if (u32(bytes, cursor) !== 0x02014b50
      || u16(bytes, cursor + 4) !== 0x0314 || u16(bytes, cursor + 6) !== 20
      || u16(bytes, cursor + 8) !== 0
      || u16(bytes, cursor + 10) !== 0 || u16(bytes, cursor + 12) !== 0
      || u16(bytes, cursor + 14) !== DOS_DATE || u16(bytes, cursor + 30) !== 0
      || u16(bytes, cursor + 32) !== 0 || u16(bytes, cursor + 34) !== 0
      || u16(bytes, cursor + 36) !== 0
      || u32(bytes, cursor + 38) !== ((UNIX_REGULAR_0644 << 16) >>> 0)) invalid()
    const size = u32(bytes, cursor + 24)
    const length = u16(bytes, cursor + 28)
    const offset = u32(bytes, cursor + 42)
    if (size !== u32(bytes, cursor + 20) || size !== row.sizeBytes
      || size < 1 || size > 2_000_000 || length !== Buffer.byteLength(expected)
      || bounded(bytes, cursor + 46, length).toString('ascii') !== expected
      || offset !== localEnd || u32(bytes, offset) !== 0x04034b50
      || u16(bytes, offset + 4) !== 20 || u16(bytes, offset + 6) !== 0
      || u16(bytes, offset + 8) !== 0
      || u16(bytes, offset + 10) !== 0 || u16(bytes, offset + 12) !== DOS_DATE
      || u32(bytes, offset + 14) !== u32(bytes, cursor + 16)
      || u32(bytes, offset + 18) !== size || u32(bytes, offset + 22) !== size
      || u16(bytes, offset + 26) !== length || u16(bytes, offset + 28) !== 0
      || bounded(bytes, offset + 30, length).toString('ascii') !== expected) invalid()
    const data = bounded(bytes, offset + 30 + length, size)
    if (crc32(data) !== u32(bytes, cursor + 16) || sha256(data) !== row.sha256) invalid()
    artifact.update(expected).update('\0').update(String(size)).update('\0').update(data)
    files.set(expected, data)
    localEnd = offset + 30 + length + size
    cursor += 46 + length
  }
  if (localEnd !== centralStart || cursor !== eocd) invalid()
  const artifactDigest = `sha256:${artifact.digest('hex')}`
  if (artifactDigest !== source.artifactDigest) invalid()
  return { files, artifactDigest }
}
