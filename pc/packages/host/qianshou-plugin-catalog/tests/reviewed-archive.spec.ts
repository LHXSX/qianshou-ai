import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { inspectReviewedArchive, readReviewedArchiveEntry } from '../src/reviewed-archive.ts'

function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(files: readonly { name: string; content: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const data = file.deflate ? deflateRawSync(file.content) : file.content
    const crc = crc32(file.content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(file.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(file.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    const front = Buffer.concat([local, name, data])
    locals.push(front)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(file.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(file.content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, name]))
    offset += front.length
  }
  const middle = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(middle.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, middle, end])
}

async function withArchive(archive: Buffer, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-reviewed-archive-'))
  const path = join(dir, 'candidate.qspkg')
  try {
    await writeFile(path, archive, { mode: 0o600 })
    await run(path)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

const signal = new AbortController().signal
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')

it('reports decompressed SHA-256 for stored, deflated and empty files, then reads one checked entry', async () => {
  const manifest = Buffer.from('{"plugin":"sample"}')
  const graph = Buffer.from('{"nodes":[1,2]}')
  const archive = zip([{ name: 'manifest.json', content: manifest },
    { name: 'comfy/graph.json', content: graph, deflate: true },
    { name: 'empty.txt', content: Buffer.alloc(0) }])
  await withArchive(archive, async path => {
    const entries = await inspectReviewedArchive(path, archive.length, signal)
    expect(entries).toEqual([
      { path: 'manifest.json', bytes: manifest.length, compressedBytes: manifest.length, sha256: digest(manifest) },
      { path: 'comfy/graph.json', bytes: graph.length,
        compressedBytes: deflateRawSync(graph).length, sha256: digest(graph) },
      { path: 'empty.txt', bytes: 0, compressedBytes: 0, sha256: digest(Buffer.alloc(0)) },
    ])
    expect(await readReviewedArchiveEntry(path, archive.length, 'comfy/graph.json',
      entries[1]!.sha256, 256 * 1024, signal)).toEqual(graph)
    expect(await readReviewedArchiveEntry(path, archive.length, 'empty.txt',
      entries[2]!.sha256, 0, signal)).toEqual(Buffer.alloc(0))
  })
})

it('rejects a same-size archive substitution even if its structure and CRC are valid', async () => {
  const original = zip([{ name: 'manifest.json', content: Buffer.from('hello') }])
  const replacement = zip([{ name: 'manifest.json', content: Buffer.from('world') }])
  expect(replacement.length).toBe(original.length)
  await withArchive(original, async path => {
    const [entry] = await inspectReviewedArchive(path, original.length, signal)
    await writeFile(path, replacement, { mode: 0o600 })
    await expect(readReviewedArchiveEntry(path, original.length, 'manifest.json',
      entry!.sha256, 256 * 1024, signal)).rejects.toThrow('QIANSHOU_REVIEWED_ARCHIVE_INVALID')
  })
})

it('bounds decompressed reads and rejects missing, noncanonical and traversal paths', async () => {
  const large = Buffer.alloc(256 * 1024 + 1, 0x41)
  const archive = zip([{ name: 'comfy/graph.json', content: large, deflate: true }])
  await withArchive(archive, async path => {
    const [entry] = await inspectReviewedArchive(path, archive.length, signal)
    for (const [name, limit] of [
      ['comfy/graph.json', 256 * 1024],
      ['comfy/graph.json', 256 * 1024 + 1],
      ['comfy/../graph.json', 256 * 1024],
      ['missing.json', 256 * 1024],
    ] as const) {
      await expect(readReviewedArchiveEntry(path, archive.length, name,
        entry!.sha256, limit, signal)).rejects.toThrow('QIANSHOU_REVIEWED_ARCHIVE_INVALID')
    }
  })
})

it('rejects corrupted data and a symlinked archive on re-open', async () => {
  const archive = zip([{ name: 'manifest.json', content: Buffer.from('hello') }])
  await withArchive(archive, async path => {
    const [entry] = await inspectReviewedArchive(path, archive.length, signal)
    const corrupt = Buffer.from(archive)
    const dataOffset = 30 + Buffer.byteLength('manifest.json')
    corrupt[dataOffset] = corrupt[dataOffset]! ^ 1
    await writeFile(path, corrupt, { mode: 0o600 })
    await expect(readReviewedArchiveEntry(path, archive.length, 'manifest.json',
      entry!.sha256, 256 * 1024, signal)).rejects.toThrow('QIANSHOU_REVIEWED_ARCHIVE_INVALID')
    await writeFile(path, archive, { mode: 0o600 })
    const linked = `${path}-link`
    await symlink(path, linked)
    await expect(readReviewedArchiveEntry(linked, archive.length, 'manifest.json',
      entry!.sha256, 256 * 1024, signal)).rejects.toThrow()
  })
})
