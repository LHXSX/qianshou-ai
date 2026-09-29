/** Publish one Host-built five-file native skill locally, without cloud or supply actions. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, normalize, parse } from 'node:path'
import { parseSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'

const FILES = ['scripts/order_adapter/package.json', 'scripts/order_adapter/pnpm-lock.yaml',
  'scripts/order_adapter/local-adapter.json', 'scripts/order_adapter/task-definition.json', 'SKILL.md'] as const

/** Only the native metadata inventory and complete skill instructions may be created. */
export type NativeSkillDraftFile = typeof FILES[number]

/** Host-only inputs; the skill-import service derives root and the catalog builds all files. */
export interface NativeSkillDraftRequest {
  readonly name: string
  readonly files: Readonly<Record<NativeSkillDraftFile, string>>
  /** Recheck current author, profile, revision and real local binding before publication. */
  readonly assertCurrent: () => Promise<void>
  /** Validate the actual five saved files through the owning native source reader. */
  readonly verifyWritten: (skillPath: string) => Promise<void>
}

/** Verified local files only; no platform approval, install, entitlement or supply is granted. */
export interface NativeSkillDraftReceipt {
  readonly state: 'written'
  readonly name: string
  readonly path: string
  readonly sha256: string
  readonly files: readonly { readonly path: NativeSkillDraftFile; readonly sha256: string; readonly bytes: number }[]
}

const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const inode = (stat: Stats): string => `${stat.dev}:${stat.ino}`
const code = (error: unknown, value: string): boolean => error instanceof Error && 'code' in error && error.code === value
const invalid = (): never => { throw new Error('NATIVE_SKILL_DRAFT_INVALID') }
const pathEqual = (a: string, b: string): boolean => process.platform === 'win32'
  ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b)

async function directories(path: string, create: boolean): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) invalid()
  let current = parse(path).root
  for (const piece of path.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, piece)
    try { if (create) await mkdir(current, { mode: 0o700 }) }
    catch (error) { if (!code(error, 'EEXIST')) throw error }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !pathEqual(current, await realpath(current))) invalid()
  }
}

async function bytesAt(path: string): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024) invalid()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (inode(opened) !== inode(before) || opened.nlink !== 1) invalid()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || inode(await lstat(path)) !== inode(before)) invalid()
    return bytes
  } finally { await handle.close() }
}

/** Exclusively create a real five-file skill, with SKILL.md becoming visible only after metadata.
 * @param root - Trusted install root derived by the owning skill-import service.
 * @param request - Host-generated instructions and native metadata, plus current-owner verification.
 * @param signal - Cancels before completion; rollback removes only unchanged transaction-owned bytes.
 * @returns Exact disk receipt; existing skills and cloud state remain unchanged.
 */
export async function installNativeSkillDraft(root: string, request: NativeSkillDraftRequest,
  signal: AbortSignal): Promise<NativeSkillDraftReceipt> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(request.name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(request.name)
    || Object.keys(request.files).sort().join(',') !== [...FILES].sort().join(',')) invalid()
  const content = request.files['SKILL.md']
  if (!content.isWellFormed() || content.includes('\0')) invalid()
  const document = parseSkillDocument(content)
  if (document.name !== request.name || !document.description.trim() || !document.content.trim()) invalid()
  for (const name of FILES) {
    const text = request.files[name]
    if (!text.isWellFormed() || text.includes('\0') || !text.length
      || Buffer.byteLength(text) > (name === 'SKILL.md' ? 256 * 1024 : 8192)) invalid()
  }
  signal.throwIfAborted(); await request.assertCurrent(); await directories(root, true)
  const conflicts = await readdir(root)
  if (conflicts.some(name => [request.name, request.name + '.md'].includes(name.toLowerCase()))) {
    throw new Error('NATIVE_SKILL_DRAFT_CONFLICT')
  }
  const skillDir = join(root, request.name)
  const createdDirs = new Map<string, Stats>()
  const createdFiles = new Map<string, { stat: Stats; sha256: string }>()
  let complete = false
  const checkDirectory = async (checkConflicts = true) => {
    await directories(root, false)
    if (checkConflicts && (await readdir(root)).some(name => (name.toLowerCase() === request.name && name !== request.name)
      || name.toLowerCase() === request.name + '.md')) invalid()
    for (const [path, stat] of createdDirs) {
      const current = await lstat(path)
      if (!current.isDirectory() || current.isSymbolicLink() || inode(current) !== inode(stat)
        || !pathEqual(await realpath(path), path)) invalid()
    }
  }
  const write = async (path: string, text: string) => {
    await checkDirectory(); signal.throwIfAborted()
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const stat = await handle.stat(); createdFiles.set(path, { stat, sha256: digest(text) })
    try { await handle.writeFile(text, { encoding: 'utf8', signal }); await handle.sync() }
    finally { await handle.close() }
    if (digest(await bytesAt(path)) !== digest(text)) invalid()
  }
  try {
    for (const path of [skillDir, join(skillDir, 'scripts'), join(skillDir, 'scripts/order_adapter')]) {
      await checkDirectory(); signal.throwIfAborted()
      await mkdir(path, { mode: 0o700 }); createdDirs.set(path, await lstat(path))
    }
    for (const name of FILES.filter(name => name !== 'SKILL.md')) await write(join(skillDir, name), request.files[name])
    await request.assertCurrent(); await checkDirectory(); signal.throwIfAborted()
    const temporary = join(skillDir, '.SKILL-' + randomUUID() + '.tmp')
    await write(temporary, content)
    const target = join(skillDir, 'SKILL.md')
    await request.assertCurrent(); await checkDirectory(); signal.throwIfAborted()
    await link(temporary, target)
    const stat = await lstat(target); createdFiles.set(target, { stat, sha256: digest(content) })
    await unlink(temporary); createdFiles.delete(temporary)
    for (const name of FILES) {
      if (digest(await bytesAt(join(skillDir, name))) !== digest(request.files[name])) invalid()
    }
    await request.verifyWritten(target); await request.assertCurrent(); await checkDirectory(); signal.throwIfAborted()
    complete = true
    return { state: 'written', name: request.name, path: target, sha256: digest(content),
      files: FILES.map(path => ({ path, sha256: digest(request.files[path]), bytes: Buffer.byteLength(request.files[path]) })) }
  } finally {
    if (!complete) {
      for (const [path, owned] of [...createdFiles].reverse()) {
        try {
          await checkDirectory(false)
          if (inode(await lstat(path)) === inode(owned.stat) && digest(await bytesAt(path)) === owned.sha256) await unlink(path)
        } catch (error) { if (!code(error, 'ENOENT') && !(error instanceof Error)) throw error }
      }
      for (const [path, owned] of [...createdDirs].reverse()) {
        try {
          const current = await lstat(path)
          if (current.isDirectory() && !current.isSymbolicLink() && inode(current) === inode(owned)
            && pathEqual(await realpath(path), path)) await rmdir(path)
        } catch (error) { if (!code(error, 'ENOENT') && !code(error, 'ENOTEMPTY')) throw error }
      }
    }
  }
}
