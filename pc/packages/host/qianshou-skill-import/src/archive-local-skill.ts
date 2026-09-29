/** Reversible local removal; no market, entitlement or installed-runtime operation. */
import { randomUUID, createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parseSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { LocalSkillArchiveEntry, LocalSkillArchiveReceipt, LocalSkillArchiveRequest,
  LocalSkillRestoreReceipt, LocalSkillRestoreRequest } from './types.ts'

type UserRoot = { readonly source: LocalSkillArchiveRequest['source']; readonly path: string }
const ARCHIVE_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const restoring = new Set<string>()

/** Read only valid archive manifests and payloads; missing/unsafe entries cannot be restored. */
export async function listLocalSkillArchives(roots: readonly UserRoot[]): Promise<readonly LocalSkillArchiveEntry[]> {
  const entries: LocalSkillArchiveEntry[] = []
  for (const root of roots) {
    const archiveRoot = join(dirname(root.path), '.qianshou-skill-archives')
    let names
    try {
      await assertDirectories(archiveRoot)
      names = await readdir(archiveRoot, { withFileTypes: true })
    } catch (error) { if (isMissing(error)) continue; throw error }
    for (const name of names.filter(name => name.isDirectory() && ARCHIVE_ID.test(name.name)).slice(0, 200)) {
      try { entries.push(await readArchive(root, name.name, roots)) }
      catch { /* Invalid or already restored payloads never become restoration authority. */ }
    }
  }
  return entries.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
}

/** Restore an exact archived payload into its original trusted root, refusing name conflicts. */
export async function restoreLocalSkill(request: LocalSkillRestoreRequest, roots: readonly UserRoot[],
  signal: AbortSignal, beforeRestore?: (entry: LocalSkillArchiveEntry) => Promise<void>): Promise<LocalSkillRestoreReceipt> {
  if (!ARCHIVE_ID.test(request.archiveId) || !/^[a-f0-9]{64}$/u.test(request.sha256)) {
    throw new RemoteError('skill-import/invalid', 'Select a verified recovery entry', {})
  }
  const root = roots.find(root => root.source === request.source)
  if (root === undefined) unsafe()
  const entry = await readArchive(root, request.archiveId, roots)
  if (entry.sha256 !== request.sha256) changed()
  await beforeRestore?.(entry)
  if (restoring.has(entry.originalPath)) conflict()
  restoring.add(entry.originalPath)
  const created: Array<{ path: string; info: Stats }> = []
  let restored = false
  try {
    await assertDirectories(root.path)
    if (!owned(await lstat(root.path))) unsafe()
    signal.throwIfAborted()
    for (const path of [join(root.path, entry.name), join(root.path, `${entry.name}.md`)]) {
      try { await lstat(path); conflict() } catch (error) { if (!isMissing(error)) throw error }
    }
    const payload = await lstat(entry.archivePath)
    if (payload.isFile()) {
      await copyExclusive(entry.archivePath, entry.originalPath, signal, created)
    } else {
      // Every target is exclusive. SKILL.md is last, so an incomplete copy is not discoverable.
      try { await mkdir(entry.originalPath, { mode: 0o700 }) }
      catch (error) { if (isExisting(error)) conflict(); throw error }
      created.push({ path: entry.originalPath, info: await lstat(entry.originalPath) })
      for (const name of (await readdir(entry.archivePath)).filter(name => name !== 'SKILL.md')) {
        await copyExclusive(join(entry.archivePath, name), join(entry.originalPath, name), signal, created)
      }
      await copyExclusive(join(entry.archivePath, 'SKILL.md'), join(entry.originalPath, 'SKILL.md'), signal, created)
    }
    const path = payload.isFile() ? entry.originalPath : join(entry.originalPath, 'SKILL.md')
    if (await instructionDigest(path) !== entry.sha256) changed()
    await writeFile(join(dirname(entry.receiptPath), 'restored.json'), JSON.stringify({
      schema: 'qianshou.local-skill-restored.v1', source: entry.source, archiveId: request.archiveId,
      sha256: entry.sha256, path, restoredAt: new Date().toISOString(),
    }) + '\n', { flag: 'wx', mode: 0o600 })
    restored = true
    return { state: 'restored', source: entry.source, archiveId: request.archiveId,
      name: entry.name, sha256: entry.sha256, path }
  } finally {
    restoring.delete(entry.originalPath)
    if (!restored) {
      for (const item of created.reverse()) {
        const current = await lstat(item.path).catch(() => null)
        if (current?.dev === item.info.dev && current.ino === item.info.ino) {
          await (current.isDirectory() ? rmdir(item.path) : unlink(item.path))
            .catch(() => { /* Never remove concurrent files or the preserved archive. */ })
        }
      }
    }
  }
}

async function copyExclusive(source: string, target: string, signal: AbortSignal,
  created: Array<{ path: string; info: Stats }>): Promise<void> {
  signal.throwIfAborted()
  if (created.length >= 10000) throw new RemoteError('skill-import/invalid', 'Archive has too many entries', {})
  const info = await lstat(source)
  if (!owned(info)) unsafe()
  await assertDirectories(dirname(target))
  try {
    if (info.isSymbolicLink()) {
      await symlink(await readlink(source), target, process.platform === 'win32' ? 'junction' : undefined)
      created.push({ path: target, info: await lstat(target) })
    } else if (info.isDirectory()) {
      await assertDirectories(source)
      await mkdir(target, { mode: 0o700 })
      created.push({ path: target, info: await lstat(target) })
      for (const name of await readdir(source)) await copyExclusive(join(source, name), join(target, name), signal, created)
    } else if (info.isFile()) {
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const actual = await input.stat()
        if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino) changed()
        const output = await open(target, 'wx', info.mode & 0o777)
        try {
          created.push({ path: target, info: await output.stat() })
          const buffer = Buffer.alloc(64 * 1024)
          for (;;) {
            signal.throwIfAborted()
            const { bytesRead } = await input.read(buffer)
            if (bytesRead === 0) break
            let offset = 0
            while (offset < bytesRead) offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten
          }
        } finally { await output.close() }
      } finally { await input.close() }
    } else unsafe()
  } catch (error) { if (isExisting(error)) conflict(); throw error }
}

async function readArchive(root: UserRoot, archiveId: string, roots: readonly UserRoot[]): Promise<LocalSkillArchiveEntry> {
  const archiveRoot = join(dirname(root.path), '.qianshou-skill-archives')
  if (roots.some(item => inside(item.path, archiveRoot))) unsafe()
  const directory = join(archiveRoot, archiveId)
  await assertDirectories(directory)
  if (!owned(await lstat(archiveRoot)) || !owned(await lstat(directory))) unsafe()
  const receiptPath = join(directory, 'restore.json')
  try { await lstat(join(directory, 'restored.json')); changed() }
  catch (error) { if (!isMissing(error)) throw error }
  const handle = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let value: unknown
  try {
    const info = await handle.stat()
    if (!info.isFile() || !owned(info) || info.size < 1 || info.size > 16 * 1024) unsafe()
    value = JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) unsafe()
  const row = value as Record<string, unknown>
  if (row.schema !== 'qianshou.local-skill-archive.v1' || row.state !== 'archived' || row.source !== root.source
    || typeof row.name !== 'string' || !isSkillName(row.name) || row.name.length > 64
    || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)
    || row.receiptPath !== receiptPath || typeof row.archivedAt !== 'string' || row.archivedAt.length > 64
    || !Number.isFinite(Date.parse(row.archivedAt))) unsafe()
  const flat = row.archivePath === join(directory, `${row.name}.md`)
  const archivePath = join(directory, flat ? `${row.name}.md` : row.name)
  const originalPath = join(root.path, flat ? `${row.name}.md` : row.name)
  if (row.archivePath !== archivePath || row.originalPath !== originalPath) unsafe()
  const payload = await lstat(archivePath)
  if (!owned(payload) || payload.isSymbolicLink() || (flat ? !payload.isFile() : !payload.isDirectory())) unsafe()
  const instruction = flat ? archivePath : join(archivePath, 'SKILL.md')
  const document = parseSkillDocument((await instructionBytes(instruction)).toString('utf8'))
  if (!await localSkillMayArchive(instruction) || await instructionDigest(instruction) !== row.sha256
    || document.name !== row.name || document.content.trim() === '' || document.description.trim() === '') changed()
  const label = document.metadata?.displayName
  const displayName = typeof label === 'string' && label.trim().length > 0 && label.length <= 120
    ? label.trim() : document.content.match(/^#\s+(.+)$/mu)?.[1]?.trim().slice(0, 120) ?? document.name
  return { state: 'archived', archiveId, source: root.source, name: row.name, originalPath,
    archivePath, receiptPath, sha256: row.sha256, archivedAt: row.archivedAt,
    displayName, description: document.description.slice(0, 1024) }
}

function conflict(): never {
  throw new RemoteError('skill-import/conflict', 'An existing skill occupies the original location; keep both copies', {})
}

/**
 * Move one current user skill out of discovery while preserving its complete directory.
 * @param request - Exact path and instruction digest returned by the local inventory.
 * @param roots - Host-configured user roots; no client root or archive path is accepted.
 * @param signal - Cancellation before the atomic move; a completed move remains a receipt.
 * @returns The original path, archived payload and restoration metadata file.
 */
export async function archiveLocalSkill(request: LocalSkillArchiveRequest, roots: readonly UserRoot[],
  signal: AbortSignal): Promise<LocalSkillArchiveReceipt> {
  if (!isSkillName(request.name) || request.name.length > 64
    || typeof request.path !== 'string' || !/^[a-f0-9]{64}$/u.test(request.sha256)) {
    throw new RemoteError('skill-import/invalid', 'Select a current local skill and instruction digest', {})
  }
  const root = roots.find(root => root.source === request.source)?.path
  const bundledPath = root === undefined ? '' : join(root, request.name, 'SKILL.md')
  const flatPath = root === undefined ? '' : join(root, `${request.name}.md`)
  if (root === undefined || request.path !== bundledPath && request.path !== flatPath) {
    throw new RemoteError('skill-import/unsafe-path', 'Skill path is outside the selected user root', {})
  }
  const originalPath = request.path === flatPath ? flatPath : dirname(bundledPath)
  await assertDirectories(root)
  const entry = await lstat(originalPath)
  if (entry.isSymbolicLink() || (request.path === flatPath ? !entry.isFile() : !entry.isDirectory())) unsafe()
  if (!owned(entry)) throw new RemoteError('skill-import/not-owned', 'Skill is not owned by this OS user', {})
  if (!await localSkillMayArchive(request.path)) {
    throw new RemoteError('skill-import/managed', 'Use package management for an installed runtime', {})
  }
  if (await instructionDigest(request.path) !== request.sha256) changed()
  const archiveRoot = join(dirname(root), '.qianshou-skill-archives')
  if (roots.some(item => inside(item.path, archiveRoot))) unsafe()
  signal.throwIfAborted()
  await assertDirectories(archiveRoot, true)
  const directory = join(archiveRoot, randomUUID())
  await mkdir(directory, { mode: 0o700 })
  const archivePath = join(directory, request.path === flatPath ? `${request.name}.md` : request.name)
  const receiptPath = join(directory, 'restore.json')
  const receipt: LocalSkillArchiveReceipt = { state: 'archived', source: request.source,
    name: request.name, originalPath, archivePath, receiptPath, sha256: request.sha256 }
  let moved = false
  try {
    await writeFile(receiptPath, JSON.stringify({ schema: 'qianshou.local-skill-archive.v1',
      ...receipt, archivedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
    await assertDirectories(root)
    await assertDirectories(directory)
    const current = await lstat(originalPath)
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino
      || await instructionDigest(request.path) !== request.sha256) changed()
    signal.throwIfAborted()
    // rename moves the opaque directory, including nested links, without reading their targets.
    await rename(originalPath, archivePath)
    moved = true
    return receipt
  } finally {
    if (!moved) {
      await unlink(receiptPath).catch((error: unknown) => { if (!isMissing(error)) throw error })
      await rmdir(directory).catch((error: unknown) => { if (!isMissing(error)) throw error })
    }
  }
}

/**
 * Recognize user-owned files and refuse direct installed-runtime/package markers.
 * @param skillPath - A regular instruction file under a validated user root.
 * @returns Whether the inventory may offer reversible local removal.
 */
export async function localSkillMayArchive(skillPath: string): Promise<boolean> {
  const file = await lstat(skillPath)
  if (file.isSymbolicLink() || !file.isFile() || !owned(file)) return false
  const directory = dirname(skillPath)
  const parent = await lstat(directory)
  if (parent.isSymbolicLink() || !parent.isDirectory() || !owned(parent)) return false
  for (const marker of ['local-install.json', 'source-stage.json']) {
    try { await lstat(join(directory, marker)); return false }
    catch (error) { if (!isMissing(error)) throw error }
  }
  return true
}

function owned(info: Stats): boolean {
  return process.getuid === undefined || info.uid === process.getuid()
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep)
}

async function instructionDigest(path: string): Promise<string> {
  return createHash('sha256').update(await instructionBytes(path)).digest('hex')
}

async function instructionBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > 256 * 1024) changed()
    return await handle.readFile()
  } finally { await handle.close() }
}

async function assertDirectories(path: string, create = false): Promise<void> {
  const absolute = resolve(path)
  const base = parse(absolute).root
  const parts = [base]
  for (let current = absolute; current !== base; current = dirname(current)) parts.splice(1, 0, current)
  for (const part of parts) {
    let info
    try { info = await lstat(part) } catch (error) {
      if (!create || !isMissing(error)) throw error
      try { await mkdir(part, { mode: 0o700 }) } catch (error) { if (!isExisting(error)) throw error }
      info = await lstat(part)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) unsafe()
  }
  if (await realpath(path) !== absolute) unsafe()
}

function unsafe(): never {
  throw new RemoteError('skill-import/unsafe-path', 'Skill path contains an unsafe directory or link', {})
}

function changed(): never {
  throw new RemoteError('skill-import/changed', 'Skill changed; refresh before removing it', {})
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isExisting(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
