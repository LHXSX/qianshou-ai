/** Test-only ZIP writer: builds real archives, including deliberately hostile ones.
 *
 * Nothing here is production code. It exists so the strict reader is exercised
 * against genuine ZIP byte layouts (local headers, central directory, EOCD)
 * instead of a hand-written parser assumption.
 */
import { deflateRawSync } from 'node:zlib'

/** One entry to encode, with optional fields made intentionally wrong. */
export interface ZipEntrySpec {
  name: string
  bytes?: Uint8Array
  method?: number
  flags?: number
  /** Unix mode stored in the high half of external attributes (0o120777 = symlink). */
  mode?: number
  versionMadeBy?: number
  crcOverride?: number
  declaredUncompressedSize?: number
  declaredCompressedSize?: number
  /** Local-header name that no longer matches the central directory. */
  localNameOverride?: string
}

/** Whole-archive overrides used to build malformed files. */
export interface ZipBuildOptions {
  comment?: string
  totalEntriesOverride?: number
  entriesOnDiskOverride?: number
  diskNumberOverride?: number
  centralSizeOverride?: number
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

/** CRC32 as the ZIP format stores it. */
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0
  return (value ^ 0xffffffff) >>> 0
}

/** Build a ZIP archive from the given specs. */
export function buildZip(entries: readonly ZipEntrySpec[], options: ZipBuildOptions = {}): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array()
    const method = entry.method ?? 0
    const name = Buffer.from(entry.name, 'utf8')
    const localName = Buffer.from(entry.localNameOverride ?? entry.name, 'utf8')
    const payload = method === 8 ? deflateRawSync(bytes) : Buffer.from(bytes)
    const crc = entry.crcOverride ?? crc32(bytes)
    const compressed = entry.declaredCompressedSize ?? payload.byteLength
    const uncompressed = entry.declaredUncompressedSize ?? bytes.byteLength

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(entry.flags ?? 0x0800, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed, 18)
    localHeader.writeUInt32LE(uncompressed, 22)
    localHeader.writeUInt16LE(localName.byteLength, 26)
    localHeader.writeUInt16LE(0, 28)
    local.push(localHeader, localName, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(entry.versionMadeBy ?? 0x031e, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(entry.flags ?? 0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed, 20)
    centralHeader.writeUInt32LE(uncompressed, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.byteLength + localName.byteLength + payload.byteLength
  }
  const localBytes = Buffer.concat(local)
  const centralBytes = Buffer.concat(central)
  const comment = Buffer.from(options.comment ?? '', 'utf8')
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(options.diskNumberOverride ?? 0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(options.entriesOnDiskOverride ?? entries.length, 8)
  eocd.writeUInt16LE(options.totalEntriesOverride ?? entries.length, 10)
  eocd.writeUInt32LE(options.centralSizeOverride ?? centralBytes.byteLength, 12)
  eocd.writeUInt32LE(localBytes.byteLength, 16)
  eocd.writeUInt16LE(comment.byteLength, 20)
  return Buffer.concat([localBytes, centralBytes, eocd, comment])
}
