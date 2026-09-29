/** Capture a bounded ordinary skill without executing or following any package link. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const LIMIT = 2 * 1024 * 1024
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function invalid(): never { throw new Error('ORDINARY_SKILL_PACKAGE_INVALID') }
function pathAllowed(path: string): boolean {
  return path.length <= 240 && path === path.normalize('NFC') && !/[\\:\u0000-\u001f\u007f]/u.test(path)
    && path.split('/').every(p => p !== '' && p !== '.' && p !== '..' && !/[. ]$/u.test(p)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))
}
function excluded(name: string): boolean {
  return name.startsWith('.') || /^(?:credentials?|secrets?|passwords?|tokens?)(?:\.|$)/iu.test(name)
    || /\.(?:pem|key|p12|pfx)$/iu.test(name)
}
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const b of bytes) {
    value ^= b
    for (let i = 0; i < 8; i++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

/** One immutable ZIP snapshot; contents are never returned to the renderer. */
export interface OrdinarySkillArchive {
  bytes: Buffer
  packageSha256: string
  packageBytes: number
  unpackedTreeSha256: string
  skillMdSha256: string
  skillMdPath: 'SKILL.md'
  files: { path: string; sha256: string; sizeBytes: number }[]
}

/** Read an inventory-owned SKILL.md directory and create a canonical, regular-file-only ZIP.
 * @param skillPath - Absolute SKILL.md supplied by the local skill inventory, never the browser.
 * @returns Captured package bytes and file hashes; hidden/credential files are excluded.
 */
export async function captureOrdinarySkill(skillPath: string): Promise<OrdinarySkillArchive> {
  if (!isAbsolute(skillPath) || basename(skillPath) !== 'SKILL.md') invalid()
  const root = dirname(skillPath)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) invalid()
  const canonicalRoot = await realpath(root)
  const captures: { path: string; bytes: Buffer }[] = []
  const checks: (() => Promise<void>)[] = []
  let total = 0
  let entries = 0
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 12) invalid()
    const before = await lstat(directory)
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== join(canonicalRoot, prefix)) invalid()
    const names = (await readdir(directory)).sort()
    entries += names.length
    if (entries > 512) invalid()
    for (const name of names) {
      if (excluded(name)) continue
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (!pathAllowed(path)) invalid()
      const full = join(directory, name)
      const prior = await lstat(full)
      if (prior.isSymbolicLink()) invalid()
      if (prior.isDirectory()) { await walk(full, path, depth + 1); continue }
      if (!prior.isFile() || prior.nlink !== 1 || prior.size > 512 * 1024 || captures.length >= 128) invalid()
      if (await realpath(full) !== join(canonicalRoot, path)) invalid()
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== prior.dev || opened.ino !== prior.ino || opened.size !== prior.size) invalid()
        const bytes = await handle.readFile()
        const after = await handle.stat()
        if (bytes.length !== prior.size || after.mtimeMs !== prior.mtimeMs || after.ctimeMs !== prior.ctimeMs) invalid()
        total += bytes.length
        if (total > LIMIT) invalid()
        captures.push({ path, bytes })
        checks.push(async () => {
          const current = await lstat(full)
          if (!current.isFile() || current.isSymbolicLink() || current.dev !== prior.dev || current.ino !== prior.ino
            || current.size !== prior.size || current.mtimeMs !== prior.mtimeMs || current.ctimeMs !== prior.ctimeMs) invalid()
        })
      } finally { await handle.close() }
    }
    checks.push(async () => {
      const current = await lstat(directory)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) invalid()
    })
  }
  await walk(root, '', 0)
  for (const check of checks) await check()
  captures.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (new Set(captures.map(f => f.path.toLowerCase())).size !== captures.length) invalid()
  const skill = captures.find(f => f.path === 'SKILL.md')
  if (skill === undefined || skill.bytes.length > 256 * 1024
    || captures.some(f => f.path !== 'SKILL.md' && f.path.endsWith('/SKILL.md'))) invalid()
  const text = new TextDecoder('utf-8', { fatal: true }).decode(skill.bytes)
  if (text.trim() === '' || text.includes('\0')) invalid()
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0
  for (const entry of captures) {
    const name = Buffer.from(entry.path, 'utf8'); const crc = crc32(entry.bytes)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, entry.bytes)
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50); head.writeUInt16LE(0x0314, 4)
    head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(0x21, 14)
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(entry.bytes.length, 20); head.writeUInt32LE(entry.bytes.length, 24)
    head.writeUInt16LE(name.length, 28); head.writeUInt32LE((0o100644 << 16) >>> 0, 38); head.writeUInt32LE(offset, 42)
    central.push(head, name); offset += local.length + name.length + entry.bytes.length
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(captures.length, 8); end.writeUInt16LE(captures.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  const bytes = Buffer.concat([...locals, directory, end])
  if (bytes.length > LIMIT) invalid()
  const files = captures.map(f => ({ path: f.path, sha256: digest(f.bytes), sizeBytes: f.bytes.length }))
  return { bytes, packageBytes: bytes.length, packageSha256: digest(bytes),
    unpackedTreeSha256: digest(Buffer.from(JSON.stringify(files.map(f => [f.path, f.sha256])))),
    skillMdSha256: digest(skill.bytes), skillMdPath: 'SKILL.md', files }
}
