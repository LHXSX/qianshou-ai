/** Inspect a downloaded .qspkg without extracting, installing or executing it. */
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_ENTRIES = 256
const MAX_CENTRAL_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_READ_BYTES = 256 * 1024

/** One validated regular file in a private staged ZIP archive. */
export interface ReviewedArchiveEntry {
  readonly path: string
  readonly bytes: number
  readonly compressedBytes: number
  /** SHA-256 of the decompressed regular-file content. */
  readonly sha256: string
}

interface IndexedEntry extends Omit<ReviewedArchiveEntry, 'sha256'> {
  readonly method: number
  readonly crc: number
  readonly dataOffset: number
  readonly localOffset: number
  readonly localEnd: number
  readonly directory: boolean
}

function invalid(): never { throw new Error('QIANSHOU_REVIEWED_ARCHIVE_INVALID') }

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const result = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(result, done, length - done, offset + done)
    if (bytesRead === 0) invalid()
    done += bytesRead
  }
  return result
}

function pathFrom(raw: Buffer, utf8: boolean): { path: string; directory: boolean } {
  if (raw.length === 0 || raw.length > 1024) invalid()
  let value: string
  try {
    if (!utf8 && raw.some(byte => byte < 0x20 || byte > 0x7e)) invalid()
    value = new TextDecoder(utf8 ? 'utf-8' : 'ascii', { fatal: true }).decode(raw)
  } catch { invalid() }
  const directory = value.endsWith('/')
  const path = (directory ? value.slice(0, -1) : value).normalize('NFC')
  if (path.length === 0 || path.length > 512 || path.startsWith('/') || path.includes('\\')
    || /[\u0000-\u001f\u007f:]/u.test(path)) invalid()
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) invalid()
  return { path, directory }
}

function regularEntry(versionMadeBy: number, externalAttributes: number, directory: boolean): void {
  const dosDirectory = (externalAttributes & 0x10) !== 0
  if (dosDirectory !== directory) invalid()
  if (versionMadeBy >> 8 !== 3) return
  const mode = (externalAttributes >>> 16) & 0xffff
  if (mode !== 0 && (mode & 0xf000) !== (directory ? 0x4000 : 0x8000)) invalid()
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1
    table[index] = value >>> 0
  }
  return table
}
const CRC = crcTable()

async function verifyEntryData(handle: FileHandle, entry: IndexedEntry, signal: AbortSignal,
  capture: boolean): Promise<{ sha256: string; content?: Buffer }> {
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  if (entry.compressedBytes === 0) {
    if (entry.method !== 0 || entry.bytes !== 0 || entry.crc !== 0) invalid()
    return { sha256: hash.digest('hex'), ...(capture ? { content: Buffer.alloc(0) } : {}) }
  }
  let bytes = 0
  let crc = 0xffffffff
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > entry.bytes) { callback(new Error('QIANSHOU_REVIEWED_ARCHIVE_INVALID')); return }
      hash.update(chunk)
      if (capture) chunks.push(Buffer.from(chunk))
      for (const byte of chunk) crc = (CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
      callback()
    },
  })
  const source = handle.createReadStream({ start: entry.dataOffset,
    end: entry.dataOffset + entry.compressedBytes - 1, autoClose: false })
  try {
    if (entry.method === 0) await pipeline(source, sink, { signal })
    else await pipeline(source, createInflateRaw(), sink, { signal })
  } catch { invalid() }
  if (bytes !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) invalid()
  return { sha256: hash.digest('hex'), ...(capture ? { content: Buffer.concat(chunks, bytes) } : {}) }
}

/** Verify ZIP structure, paths, file sizes, CRC and content hashes without extracting or executing.
 * @param path - Private candidate archive path.
 * @param expectedBytes - Signed transport byte count.
 * @param signal - Cancellation signal for streamed decompression.
 * @returns Validated regular-file entries; this does not validate a plugin manifest.
 */
async function scanReviewedArchive(path: string, expectedBytes: number, signal: AbortSignal,
  selection?: { path: string; expectedSha256: string; maxBytes: number }):
  Promise<{ entries: readonly ReviewedArchiveEntry[]; content?: Buffer }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== expectedBytes || (stat.mode & 0o077) !== 0
      || stat.size < 22 || stat.size > MAX_FILE_BYTES) invalid()
    const tailLength = Math.min(stat.size, 22 + 0xffff)
    const tail = await readAt(handle, stat.size - tailLength, tailLength)
    let end = -1
    for (let cursor = tail.length - 22; cursor >= 0; cursor -= 1) {
      if (tail.readUInt32LE(cursor) === EOCD && cursor + 22 + tail.readUInt16LE(cursor + 20) === tail.length) {
        end = stat.size - tailLength + cursor; break
      }
    }
    if (end < 0) invalid()
    const eocd = tail.subarray(end - (stat.size - tailLength))
    const count = eocd.readUInt16LE(10)
    const centralBytes = eocd.readUInt32LE(12)
    const centralOffset = eocd.readUInt32LE(16)
    if (eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0
      || eocd.readUInt16LE(8) !== count || count === 0 || count > MAX_ENTRIES
      || count === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
      || centralBytes > MAX_CENTRAL_BYTES || centralOffset + centralBytes !== end) invalid()
    const central = await readAt(handle, centralOffset, centralBytes)
    const entries: IndexedEntry[] = []
    const seen = new Set<string>()
    let cursor = 0
    let totalBytes = 0
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL) invalid()
      const madeBy = central.readUInt16LE(cursor + 4)
      const needed = central.readUInt16LE(cursor + 6)
      const flags = central.readUInt16LE(cursor + 8)
      const method = central.readUInt16LE(cursor + 10)
      const crc = central.readUInt32LE(cursor + 16)
      const compressedBytes = central.readUInt32LE(cursor + 20)
      const bytes = central.readUInt32LE(cursor + 24)
      const nameBytes = central.readUInt16LE(cursor + 28)
      const extraBytes = central.readUInt16LE(cursor + 30)
      const commentBytes = central.readUInt16LE(cursor + 32)
      const disk = central.readUInt16LE(cursor + 34)
      const attributes = central.readUInt32LE(cursor + 38)
      const localOffset = central.readUInt32LE(cursor + 42)
      const next = cursor + 46 + nameBytes + extraBytes + commentBytes
      if (next > central.length || needed > 20 || disk !== 0 || (flags & ~0x0800) !== 0
        || (method !== 0 && method !== 8) || compressedBytes === 0xffffffff
        || bytes === 0xffffffff || localOffset === 0xffffffff || bytes > MAX_FILE_BYTES) invalid()
      const rawName = central.subarray(cursor + 46, cursor + 46 + nameBytes)
      const { path: name, directory } = pathFrom(rawName, (flags & 0x0800) !== 0)
      const folded = name.toLocaleLowerCase('en-US')
      if (seen.has(folded)) invalid()
      seen.add(folded)
      regularEntry(madeBy, attributes, directory)
      if (directory && (bytes !== 0 || compressedBytes !== 0 || crc !== 0 || method !== 0)) invalid()
      if (method === 0 && bytes !== compressedBytes) invalid()
      totalBytes += bytes
      if (totalBytes > MAX_TOTAL_BYTES) invalid()
      const local = await readAt(handle, localOffset, 30)
      if (local.readUInt32LE(0) !== LOCAL || local.readUInt16LE(6) !== flags
        || local.readUInt16LE(8) !== method || local.readUInt32LE(14) !== crc
        || local.readUInt32LE(18) !== compressedBytes || local.readUInt32LE(22) !== bytes
        || local.readUInt16LE(26) !== nameBytes) invalid()
      const localName = await readAt(handle, localOffset + 30, nameBytes)
      if (!localName.equals(rawName)) invalid()
      const dataOffset = localOffset + 30 + nameBytes + local.readUInt16LE(28)
      const localEnd = dataOffset + compressedBytes
      if (dataOffset > centralOffset || localEnd > centralOffset) invalid()
      entries.push({ path: name, directory, bytes, compressedBytes, method, crc,
        dataOffset, localOffset, localEnd })
      cursor = next
    }
    if (cursor !== central.length || !entries.some(entry => !entry.directory)) invalid()
    for (const entry of entries) {
      if (entry.directory) continue
      for (const other of entries) {
        if (other !== entry && !other.path.startsWith(`${entry.path}/`)) continue
        if (other !== entry) invalid()
      }
    }
    let nextOffset = 0
    for (const entry of [...entries].sort((left, right) => left.localOffset - right.localOffset)) {
      if (entry.localOffset !== nextOffset) invalid()
      nextOffset = entry.localEnd
    }
    if (nextOffset !== centralOffset) invalid()
    const selected = selection === undefined ? undefined : entries.find(entry => !entry.directory && entry.path === selection.path)
    if (selection !== undefined && (selected === undefined || selected.bytes > selection.maxBytes)) invalid()
    const reviewed: ReviewedArchiveEntry[] = []
    let content: Buffer | undefined
    for (const entry of entries) {
      if (entry.directory) continue
      const result = await verifyEntryData(handle, entry, signal, entry === selected)
      reviewed.push({ path: entry.path, bytes: entry.bytes,
        compressedBytes: entry.compressedBytes, sha256: result.sha256 })
      if (entry === selected) {
        if (result.sha256 !== selection!.expectedSha256 || result.content === undefined) invalid()
        content = result.content
      }
    }
    return { entries: reviewed, ...(content === undefined ? {} : { content }) }
  } finally { await handle.close() }
}

export async function inspectReviewedArchive(path: string, expectedBytes: number,
  signal: AbortSignal): Promise<readonly ReviewedArchiveEntry[]> {
  return (await scanReviewedArchive(path, expectedBytes, signal)).entries
}

/** Re-open a private archive without following a link, re-validate every ZIP entry and read one
 * regular file into memory. The caller must supply its SHA-256 from a prior inspection; no
 * archive path is extracted, installed or executed. A hard 256 KiB cap applies to reads.
 */
export async function readReviewedArchiveEntry(path: string, expectedBytes: number,
  entryPath: string, expectedSha256: string, maxBytes: number,
  signal: AbortSignal): Promise<Buffer> {
  if (typeof entryPath !== 'string' || typeof expectedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(expectedSha256)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES) invalid()
  const parsed = pathFrom(Buffer.from(entryPath, 'utf8'), true)
  if (parsed.directory || parsed.path !== entryPath) invalid()
  const result = await scanReviewedArchive(path, expectedBytes, signal,
    { path: entryPath, expectedSha256, maxBytes })
  if (result.content === undefined) invalid()
  return result.content
}
