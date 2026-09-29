/** Bounded ordinary SKILL.md ZIP inspection; no adapter, release or submission dependency. */
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
const MAX_ARCHIVE=2*1024*1024
const MAX_ENTRY=512*1024
const MAX_UNPACKED=2*1024*1024
function invalid(): never { throw new Error('PLUGIN_SEED_PACKAGE_INVALID') }
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
