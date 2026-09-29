/** Verified full-archive installation. This module never overwrites an installed app or user data. */
import { createHash, randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import * as tar from 'tar'
import { verifyReleaseEnvelope, UpdateError } from './manifest.mjs'
import { verifyArchive } from './download.mjs'

// Archive members are physical bytes, including .asar files; this never changes Electron's global fs behavior.
const fileSystem = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs
const { createReadStream, createWriteStream } = fileSystem
const { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink } = fileSystem.promises

const MAX_FILES = 120_000
const MAX_UNPACKED_BYTES = 6 * 1024 ** 3
const execute = promisify(execFile)
const unsafe = message => { throw new UpdateError('UNSAFE_INSTALL', message) }
const controlCharacters = value => [...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Fixed package entry points; signed feeds and receipts cannot supply executable paths. */
export function updateLayout({ role, platform, arch }, version) {
  if (!['controller', 'companion'].includes(role) || !/^\d+\.\d+\.\d+$/.test(version)) unsafe('Invalid application identity')
  const product = role === 'controller' ? 'qianshou-agent' : 'qianshou-companion'
  if (platform === 'darwin' && arch === 'arm64') {
    const root = role === 'controller' ? '千手智能体.app' : '千手协作端.app'
    return { root, entry: `${root}/Contents/MacOS/Electron`, package: `${root}/Contents/Resources/app/package.json`, format: 'zip', product }
  }
  if (platform === 'win32' && arch === 'x64') {
    const root = `${product}-${version}-win32-x64`
    return { root, entry: `${root}/${role === 'controller' ? 'QianshouAgent.exe' : 'QianshouCompanion.exe'}`, package: `${root}/resources/app/package.json`, format: 'zip', product }
  }
  if (role === 'companion' && platform === 'linux' && arch === 'x64') {
    const root = `${product}-${version}-linux-x64`
    return { root, entry: `${root}/qianshou-companion`, package: `${root}/resources/app/package.json`, format: 'tar.gz', product }
  }
  throw new UpdateError('UNSUPPORTED_TARGET', 'This application has no supported full-archive installation for this system')
}

/** Resolve the caller-owned update root once; private ancestors below it cannot be symlinks. */
export async function updateDirectory(directory, create = true) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) unsafe('Update directory must be absolute')
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  const resolved = await realpath(directory)
  const info = await lstat(resolved)
  if (!info.isDirectory() || (process.platform !== 'win32' && ((info.mode & 0o022) || info.uid !== process.getuid()))) unsafe('Update directory must be private to this user')
  return resolved
}

async function childDirectory(root, name, create = true) {
  const directory = path.join(root, name)
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) unsafe('Installation directory cannot be a link')
  return directory
}

/** Persist a bounded state file through same-directory rename, without following an existing link. */
export async function writeUpdateJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const output = await open(temporary, 'wx', 0o600)
    try { await output.writeFile(`${JSON.stringify(value)}\n`); await output.sync() }
    finally { await output.close() }
    await rename(temporary, file)
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r')
      try { await directory.sync() }
      finally { await directory.close() }
    }
  } finally { await rm(temporary, { force: true }) }
}

export async function readUpdateJson(file) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) unsafe('Invalid update receipt')
  return JSON.parse(await readFile(file, 'utf8'))
}

function memberPath(name, layout) {
  if (typeof name !== 'string' || name.length > 4096 || controlCharacters(name) || /[\\:]/.test(name) || name.startsWith('/')) unsafe('Archive contains an unsafe path')
  const normal = name.replace(/\/$/, '')
  const pieces = normal.split('/')
  if (pieces.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) unsafe('Archive contains an unsafe path component')
  if (pieces[0] !== layout.root && !(layout.format === 'zip' && pieces[0] === '__MACOSX')) unsafe('Archive has an unexpected application root')
  return normal
}

function linkPath(name, target, layout) {
  if (!target || controlCharacters(target) || /[\\:]/.test(target) || target.startsWith('/')) unsafe('Archive contains an unsafe symbolic link')
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
  if (resolved !== layout.root && !resolved.startsWith(`${layout.root}/`)) unsafe('Archive symbolic link escapes the application')
}

async function digestStream(stream, signal, limit) {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const hash = createHash('sha256')
    const fail = error => { signal?.removeEventListener('abort', abort); stream.destroy?.(); reject(error) }
    const abort = () => fail(signal.reason)
    stream.on('error', fail)
    stream.on('data', chunk => {
      bytes += chunk.length
      if (bytes > limit) { fail(new UpdateError('UNSAFE_INSTALL', 'Unpacked file exceeds the archive limit')); return }
      hash.update(chunk)
    })
    stream.on('end', () => { signal?.removeEventListener('abort', abort); resolve({ bytes, hash: hash.digest('hex') }) })
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Own the physical input and parser so aborting an entry cannot leave the parser waiting for its end event. */
async function readTarArchive(archive, signal, onReadEntry) {
  signal?.throwIfAborted()
  const input = createReadStream(archive)
  const closed = new Promise(resolve => input.once('close', resolve))
  const active = new Set()
  const parser = new tar.Parser({ strict: true })
  let abort
  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const fail = error => {
        if (settled) return
        settled = true
        input.unpipe(parser)
        input.destroy()
        parser.abort(error)
        for (const entry of active) entry.destroy(error)
        reject(error)
      }
      abort = () => fail(signal.reason)
      input.on('error', fail)
      parser.on('error', fail)
      parser.on('entry', entry => {
        active.add(entry)
        entry.once('end', () => active.delete(entry))
        entry.once('close', () => active.delete(entry))
        entry.on('error', fail)
        try { onReadEntry(entry) } catch (error) { fail(error) }
      })
      parser.once('end', () => { if (!settled) { settled = true; resolve() } })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else input.pipe(parser)
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    input.destroy()
    await closed
  }
}

/** Inspect every archive entry before extraction; expected file hashes come from the signed archive. */
async function inspectArchive(archive, layout, signal) {
  const entries = new Map()
  const folded = new Set()
  let total = 0
  function accept(name, kind, bytes, mode, link) {
    const relative = memberPath(name, layout)
    const insensitive = relative.normalize('NFC').toLowerCase()
    if (entries.has(relative) || folded.has(insensitive)) unsafe('Archive contains duplicate or ambiguous paths')
    if (++total > MAX_FILES || !Number.isSafeInteger(bytes) || bytes < 0) unsafe('Archive has too many entries')
    folded.add(insensitive)
    if ((mode & 0o6000) !== 0) unsafe('Privileged archive modes are not supported')
    const entry = { kind, bytes, mode: mode & 0o777, link }
    entries.set(relative, entry)
    if (kind === 'link') linkPath(relative, link, layout)
    return entry
  }
  let unpacked = 0
  if (layout.format === 'zip') {
    const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true, decodeStrings: false }, (error, result) => error ? reject(error) : resolve(result)))
    try {
      await new Promise((resolve, reject) => {
        zip.on('error', reject)
        zip.on('end', resolve)
        zip.on('entry', item => {
          ;(async () => {
            signal?.throwIfAborted()
            if (item.isEncrypted()) unsafe('Encrypted archives are not supported')
            const fileName = utf8.decode(item.fileName)
            const mode = item.externalFileAttributes >>> 16
            const type = mode & 0o170000
            const kind = fileName.endsWith('/') ? 'directory' : type === 0o120000 ? 'link' : 'file'
            if (type && ![0o100000, 0o040000, 0o120000].includes(type)) unsafe('Archive contains a special file')
            unpacked += item.uncompressedSize
            if (unpacked > MAX_UNPACKED_BYTES) unsafe('Archive unpacked size exceeds the limit')
            let link
            let hash
            if (kind !== 'directory') {
              if (kind === 'link' && item.uncompressedSize > 4096) unsafe('Symbolic link is too long')
              const stream = await new Promise((resolveStream, rejectStream) => zip.openReadStream(item, (error, result) => error ? rejectStream(error) : resolveStream(result)))
              if (kind === 'link') {
                link = await new Promise((resolveLink, rejectLink) => {
                  const chunks = []
                  stream.on('error', rejectLink)
                  stream.on('data', chunk => chunks.push(chunk))
                  stream.on('end', () => { try { resolveLink(utf8.decode(Buffer.concat(chunks))) } catch (error) { rejectLink(error) } })
                })
              } else hash = (await digestStream(stream, signal, item.uncompressedSize)).hash
            }
            accept(fileName, kind, item.uncompressedSize, mode, link).hash = hash
            zip.readEntry()
          })().catch(reject)
        })
        zip.readEntry()
      })
    } finally { zip.close() }
  } else {
    const pending = []
    let inspectionError
    try { await readTarArchive(archive, signal, item => {
      try {
        if (inspectionError) { item.resume(); return }
        signal?.throwIfAborted()
        const kinds = { File: 'file', Directory: 'directory', SymbolicLink: 'link' }
        const kind = kinds[item.type]
        if (!kind) unsafe('Archive contains unsupported hard links or special files')
        unpacked += item.size
        if (unpacked > MAX_UNPACKED_BYTES) unsafe('Archive unpacked size exceeds the limit')
        const entry = accept(item.path, kind, item.size, item.mode, kind === 'link' ? item.linkpath : undefined)
        if (kind === 'file') pending.push(digestStream(item, signal, item.size).then(result => { entry.hash = result.hash }, error => { inspectionError ??= error }))
        else item.resume()
      } catch (error) { inspectionError ??= error; item.resume() }
    }) } catch (error) { inspectionError ??= error }
    await Promise.all(pending)
    if (inspectionError) throw inspectionError
  }
  for (const name of entries.keys()) {
    let parent = path.posix.dirname(name)
    while (parent !== '.') {
      if (entries.has(parent) && entries.get(parent).kind !== 'directory') unsafe('Archive writes through a symbolic link or file')
      parent = path.posix.dirname(parent)
    }
  }
  if (entries.get(layout.entry)?.kind !== 'file' || entries.get(layout.package)?.kind !== 'file') unsafe('Archive is missing the application entry or identity')
  // AppleDouble metadata does not participate in application execution; ordinary signed bundle files remain intact.
  return new Map([...entries].filter(([name]) => !name.startsWith('__MACOSX/')))
}

/** Apple ditto ZIPs store UTF-8 names without the UTF-8 flag; decode raw names explicitly after the complete preflight. */
async function extractCheckedZip(archive, content, entries, signal) {
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true, decodeStrings: false }, (error, result) => error ? reject(error) : resolve(result)))
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', item => {
        ;(async () => {
          signal?.throwIfAborted()
          const relative = utf8.decode(item.fileName).replace(/\/$/, '')
          const entry = entries.get(relative)
          if (!entry) {
            if (!relative.startsWith('__MACOSX/')) unsafe('Archive changed after inspection')
            zip.readEntry(); return
          }
          const destination = path.join(content, relative)
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 })
          if (entry.kind === 'directory') await mkdir(destination, { recursive: true, mode: entry.mode || 0o755 })
          else if (entry.kind === 'link') await symlink(entry.link, destination)
          else {
            const stream = await new Promise((resolveStream, rejectStream) => zip.openReadStream(item, (error, result) => error ? rejectStream(error) : resolveStream(result)))
            await pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: entry.mode || 0o644 }), { signal })
            if (process.platform !== 'win32') await chmod(destination, entry.mode || 0o644)
          }
          zip.readEntry()
        })().catch(reject)
      })
      zip.readEntry()
    })
  } finally { zip.close() }
}

/** The tar parser provides verified entry streams; physical writes bypass Electron's virtual ASAR filesystem. */
async function extractCheckedTar(archive, content, entries, signal) {
  const pending = []
  let extractionError
  try { await readTarArchive(archive, signal, item => {
    const operation = (async () => {
      if (extractionError) return
      signal?.throwIfAborted()
      const relative = item.path.replace(/\/$/, '')
      const entry = entries.get(relative)
      const kind = { File: 'file', Directory: 'directory', SymbolicLink: 'link' }[item.type]
      if (!entry || entry.kind !== kind || entry.bytes !== item.size || (kind === 'link' && entry.link !== item.linkpath)) unsafe('Archive changed after inspection')
      const destination = path.join(content, relative)
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 })
      if (kind === 'directory') await mkdir(destination, { recursive: true, mode: entry.mode || 0o755 })
      else if (kind === 'link') await symlink(entry.link, destination)
      else {
        await pipeline(item, createWriteStream(destination, { flags: 'wx', mode: entry.mode || 0o644 }), { signal })
        if (process.platform !== 'win32') await chmod(destination, entry.mode || 0o644)
      }
    })()
    pending.push(operation.catch(error => { extractionError ??= error }).finally(() => item.resume()))
  }) } catch (error) { extractionError ??= error }
  await Promise.all(pending)
  if (extractionError) throw extractionError
}

async function verifyTree(content, entries, signal) {
  const visited = new Set()
  async function visit(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      signal?.throwIfAborted()
      const relative = prefix ? `${prefix}/${name}` : name
      const absolute = path.join(directory, name)
      const info = await lstat(absolute)
      const expected = entries.get(relative)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (expected && expected.kind !== 'directory') unsafe('Installed file type differs from signed archive')
        if (!expected && ![...entries.keys()].some(key => key.startsWith(`${relative}/`))) unsafe('Installed application has unexpected directories')
        await visit(absolute, relative)
      } else if (info.isSymbolicLink()) {
        if (expected?.kind !== 'link' || await readlink(absolute) !== expected.link) unsafe('Installed symbolic link differs from signed archive')
      } else {
        if (!info.isFile() || expected?.kind !== 'file' || info.size !== expected.bytes) unsafe('Installed application has unexpected files')
        const digest = await digestStream(createReadStream(absolute), signal, expected.bytes)
        if (digest.hash !== expected.hash) unsafe('Installed file differs from the signed archive')
        if (process.platform !== 'win32' && expected.mode && (info.mode & 0o777) !== expected.mode) unsafe('Installed file permissions differ from the signed archive')
      }
      visited.add(relative)
    }
  }
  await visit(content)
  for (const [name, item] of entries) if (item.kind !== 'directory' && !visited.has(name)) unsafe('Installed application is incomplete')
}

async function platformIntegrity(content, layout, target, dependencies) {
  if (target.platform === 'darwin') {
    const verify = dependencies.verifyMacSignature ?? (app => execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 60_000 }))
    await verify(path.join(content, layout.root))
  }
}

function verifiedReceipt(receipt, target, dependencies) {
  if (receipt?.schemaVersion !== 1 || typeof receipt.envelope !== 'string' || receipt.envelope.length > 1_400_000) unsafe('Invalid stage receipt')
  const verified = verifyReleaseEnvelope(Buffer.from(receipt.envelope, 'base64'), target, dependencies)
  if (!verified.artifact || receipt.version !== verified.version) unsafe('Stage receipt does not match the signed release')
  return verified
}

function stageName(verified) { return `${verified.artifact.role}-${verified.artifact.platform}-${verified.artifact.arch}-${verified.version}-${verified.artifact.sha256.slice(0, 16)}` }

/** Fully verify an existing stage using signed archive bytes, never an editable local file-hash list. */
export async function verifyStagedUpdate(receipt, { updatesDirectory, target, signal }, dependencies = {}) {
  const verified = verifiedReceipt(receipt, target, dependencies)
  const root = await updateDirectory(updatesDirectory, false)
  const versions = await childDirectory(root, 'versions', false)
  const directory = await childDirectory(versions, stageName(verified), false)
  const content = await childDirectory(directory, 'content', false)
  const layout = updateLayout(target, verified.version)
  const archive = path.join(directory, `archive.${layout.format}`)
  await verifyArchive(verified, archive, { signal })
  const entries = await inspectArchive(archive, layout, signal)
  await verifyTree(content, entries, signal)
  const identity = await readUpdateJson(path.join(content, layout.package))
  if (identity.version !== verified.version || identity.name !== layout.product) unsafe('Application identity does not match the signed release')
  await platformIntegrity(content, layout, target, dependencies)
  return Object.freeze({ schemaVersion: 1, envelope: verified.envelope, version: verified.version, target: { role: target.role, platform: target.platform, arch: target.arch }, directory, entryPoint: path.join(content, layout.entry), receiptPath: path.join(directory, 'receipt.json') })
}

/** Install a verified download beside all existing versions; cancellation removes only this private staging directory. */
export async function stageUpdate(download, { updatesDirectory, target, signal }, dependencies = {}) {
  const receipt = { schemaVersion: 1, envelope: download.envelope, version: download.version }
  const verified = verifiedReceipt(receipt, target, dependencies)
  const root = await updateDirectory(updatesDirectory)
  const versions = await childDirectory(root, 'versions')
  const final = path.join(versions, stageName(verified))
  try {
    await lstat(final)
    return await verifyStagedUpdate(receipt, { updatesDirectory: root, target, signal }, dependencies)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = await childDirectory(versions, `.staging-${randomUUID()}`)
  try {
    await verifyArchive(verified, download.path, { signal })
    const layout = updateLayout(target, verified.version)
    const archive = path.join(temporary, `archive.${layout.format}`)
    await copyFile(download.path, archive)
    await verifyArchive(verified, archive, { signal })
    const entries = await inspectArchive(archive, layout, signal)
    const content = await childDirectory(temporary, 'content')
    if (layout.format === 'zip') await extractCheckedZip(archive, content, entries, signal)
    else await extractCheckedTar(archive, content, entries, signal)
    signal?.throwIfAborted()
    await verifyTree(content, entries, signal)
    const identity = await readUpdateJson(path.join(content, layout.package))
    if (identity.version !== verified.version || identity.name !== layout.product) unsafe('Application identity does not match the signed release')
    await platformIntegrity(content, layout, target, dependencies)
    await writeUpdateJson(path.join(temporary, 'receipt.json'), receipt)
    await rename(temporary, final)
    return Object.freeze({ ...receipt, target: { role: target.role, platform: target.platform, arch: target.arch }, directory: final, entryPoint: path.join(final, 'content', layout.entry), receiptPath: path.join(final, 'receipt.json') })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw error
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
