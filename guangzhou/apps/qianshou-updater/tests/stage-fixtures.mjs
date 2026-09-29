/** Tiny complete application archives; no platform executable is run by updater unit tests. */
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { envelope, release, artifact, dependencies } from './fixtures.mjs'
import { updateLayout } from '../stage.mjs'
import { deflateRawSync, gzipSync } from 'node:zlib'

export const windows = { role: 'controller', platform: 'win32', arch: 'x64', currentVersion: '0.2.1' }
export const testing = { ...dependencies, verifyMacSignature: async () => {} }

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** ZIP fixtures preserve unsafe paths verbatim and optionally deflate files to exercise stream completion. */
export function zipBytes(entries) {
  const local = [], central = []
  let offset = 0
  for (const { name, data = '', mode = 0o100644, flags = 0x800, deflate = false } of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(data), crc = crc32(bytes)
    const compressed = deflate ? deflateRawSync(bytes) : bytes
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(deflate ? 8 : 0, 8)
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26)
    local.push(header, filename, compressed)
    const index = Buffer.alloc(46)
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x0314, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(flags, 8)
    index.writeUInt16LE(deflate ? 8 : 0, 10)
    index.writeUInt32LE(crc, 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(filename.length, 28)
    index.writeUInt32LE((mode << 16) >>> 0, 38); index.writeUInt32LE(offset, 42)
    central.push(index, filename)
    offset += header.length + filename.length + compressed.length
  }
  const directory = Buffer.concat(central), footer = Buffer.alloc(22)
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10)
  footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, footer])
}

export function tarBytes(entries) {
  const blocks = []
  for (const { name, data = '', type = '0', link = '' } of entries) {
    const content = Buffer.from(data), header = Buffer.alloc(512)
    header.write(name, 0, 100); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100); header.write('ustar\0', 257); header.write('00', 263)
    const sum = header.reduce((value, byte) => value + byte, 0)
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

export async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'qianshou-stage-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

export function appEntries(target = windows, version = '0.2.2') {
  const layout = updateLayout(target, version)
  return [
    { name: layout.entry, data: 'MZ signed full application fixture', mode: 0o100755 },
    { name: layout.package, data: JSON.stringify({ name: layout.product, version, main: 'main.mjs' }) },
    { name: `${path.posix.dirname(layout.package)}/main.mjs`, data: 'export const verified = true\n' },
  ]
}

export async function signedDownload(root, target = windows, entries = appEntries(target), version = '0.2.2', bytes = zipBytes(entries)) {
  const layout = updateLayout(target, version)
  const filename = `${layout.product}-${version}-${target.platform}-${target.arch}.${layout.format}`
  const downloadPath = path.join(root, filename)
  await writeFile(downloadPath, bytes, { mode: 0o600 })
  const item = artifact({ ...target, currentVersion: undefined })
  delete item.currentVersion
  Object.assign(item, { fileName: filename, url: `https://qianshousuanli.com/downloads/qianshou-agent/${version}/${filename}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  return { path: downloadPath, version, envelope: envelope(release({ version, artifacts: [item] })).toString('base64') }
}

export async function currentApp(root, target = windows, version = '0.2.1') {
  const entries = appEntries(target, version)
  const base = path.join(root, 'original')
  for (const entry of entries) {
    const destination = path.join(base, entry.name)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, entry.data)
    await chmod(destination, entry.mode & 0o777 || 0o644)
  }
  return path.join(base, updateLayout(target, version).entry)
}
