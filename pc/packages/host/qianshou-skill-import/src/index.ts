/** Host-owned import of a single reviewed SKILL.md into the user skill root. */
import { installNativeSkillDraft, type NativeSkillDraftRequest, type NativeSkillDraftReceipt } from './native-skill-draft.ts'
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { access, link, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { parseSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { archiveLocalSkill, listLocalSkillArchives, localSkillMayArchive, restoreLocalSkill } from './archive-local-skill.ts'
import type { LocalSkillArchiveEntry, LocalSkillArchiveReceipt, LocalSkillArchiveRequest, LocalSkillRestoreReceipt, LocalSkillRestoreRequest, LocalSkillEntry, LocalSkillList, SkillAuthoringContext, SkillImportInspection, SkillImportInspectionId, SkillImportReceipt, SkillImportVerification } from './types.ts'

export type * from './types.ts'

/** Maximum UTF-8 instruction bytes accepted through one Remote request. */
export const MAX_SKILL_IMPORT_BYTES = 256 * 1024
const MAX_PENDING_INSPECTIONS = 16
const INSPECTION_LIFETIME_MS = 10 * 60 * 1000
const PENDING_SWEEP_INTERVAL_MS = 60 * 1000
const SHA256_HEX = /^[a-f0-9]{64}$/

/** Empty uses the current Harness home; an override must be an absolute, trusted Host path. */
export interface Config {
  /** Skill root, normally `$DSH_HOME/skills`; intended for explicit Host deployment and tests. */
  installRoot: string
  /** Additional shared user root. Empty uses `~/.agents/skills` only with the default install root. */
  agentsRoot?: string
}

interface PendingInspection {
  content: string
  inspection: SkillImportInspection
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    qianshouSkillImport: QianshouSkillImport
  }
}

/** Preflight once, then write only the exact reviewed text into a controlled local root. */
export class QianshouSkillImport extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({
    installRoot: Schema.string().default(''),
    agentsRoot: Schema.string().default(''),
  })

  private readonly root: string
  private readonly agentsRoot: string | null
  private readonly pending = new Map<SkillImportInspectionId, PendingInspection>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'qianshouSkillImport')
    if (config.installRoot !== '' && !isAbsolute(config.installRoot)) {
      throw new TypeError('qianshou-skill-import: installRoot must be absolute')
    }
    if (config.agentsRoot !== undefined && config.agentsRoot !== '' && !isAbsolute(config.agentsRoot)) {
      throw new TypeError('qianshou-skill-import: agentsRoot must be absolute')
    }
    this.root = resolve(config.installRoot === '' ? join(resolveDshHome(), 'skills') : config.installRoot)
    this.agentsRoot = config.agentsRoot === '' || config.agentsRoot === undefined
      ? config.installRoot === ''
        ? resolve(join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills'))
        : null
      : resolve(config.agentsRoot)
    ctx.effect(() => {
      const timer = setInterval(() => { this.expirePending() }, PENDING_SWEEP_INTERVAL_MS)
      timer.unref()
      return () => { clearInterval(timer); this.pending.clear() }
    }, 'qianshou-skill-import: pending inspection lifetime')
  }

  /** Install only five Host-built native files under this service's trusted local root.
   * This Host-only method has no remote files or destination argument.
   * @param request - Catalog-built files and current-author verification callbacks.
   * @param signal - Cancellation before publishing SKILL.md.
   * @returns A local file receipt; no publication, supply grant or market approval occurs.
   */
  installNativeSkillDraft(request: NativeSkillDraftRequest, signal: AbortSignal): Promise<NativeSkillDraftReceipt> {
    return installNativeSkillDraft(this.root, request, signal)
  }

  /**
   * Validate one UTF-8 SKILL.md and reserve its exact content for a short review window.
   * @param content - Complete text from a local file; URL, archive and filesystem paths are not accepted.
   * @returns Metadata, digest, destination and an opaque single-use installation id.
   */
  @Remote
  async inspect(content: string): Promise<SkillImportInspection> {
    if (typeof content !== 'string') throw invalid('SKILL.md content must be text')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes === 0 || bytes > MAX_SKILL_IMPORT_BYTES) {
      throw invalid(`SKILL.md must contain 1 to ${MAX_SKILL_IMPORT_BYTES} UTF-8 bytes`)
    }
    if (content.includes('\0') || content.includes('\uFFFD') || Buffer.from(content, 'utf8').toString('utf8') !== content) {
      throw invalid('SKILL.md must be valid UTF-8 text without NUL or replacement characters')
    }
    let parsed: ReturnType<typeof parseSkillDocument>
    try { parsed = parseSkillDocument(content) } catch (error) { throw invalid(String(error)) }
    if (parsed.name.length > 64 || parsed.description.trim() === '' || parsed.description.length > 1024 || parsed.content === '') {
      throw invalid('SKILL.md requires a name of at most 64 characters, a description of at most 1024 characters, and a nonempty body')
    }
    await assertDirectoryChain(this.root, false)
    const targetPath = join(this.root, parsed.name, 'SKILL.md')
    await assertAbsent(join(this.root, parsed.name))
    await assertAbsent(join(this.root, `${parsed.name}.md`))
    const inspectionId = brandString<SkillImportInspectionId>(randomUUID())
    const inspection: SkillImportInspection = {
      inspectionId, name: parsed.name, description: parsed.description,
      modelInvocable: parsed.invocation.modelInvocable,
      userInvocable: parsed.invocation.userInvocable,
      sha256: digest(content), bytes, targetPath,
      expiresAt: Date.now() + INSPECTION_LIFETIME_MS,
    }
    this.expirePending()
    if (this.pending.size >= MAX_PENDING_INSPECTIONS) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    this.pending.set(inspectionId, { content, inspection })
    return inspection
  }

  /**
   * Consume one inspection and publish its exact bytes without replacing an existing skill.
   * @param inspectionId - Opaque id returned by inspect; a repeated or expired id is refused.
   * @param signal - Cancels before publication.
   * @returns Verified disk-write receipt; callers separately query Session skill discovery.
   */
  @Remote
  async install(inspectionId: SkillImportInspectionId, signal: AbortSignal): Promise<SkillImportReceipt> {
    signal.throwIfAborted()
    const pending = this.pending.get(inspectionId)
    this.pending.delete(inspectionId)
    if (pending === undefined || pending.inspection.expiresAt <= Date.now()) {
      throw new RemoteError('skill-import/expired', 'Skill inspection expired; inspect the file again', {})
    }
    const { content, inspection } = pending
    const skillDir = join(this.root, inspection.name)
    const targetPath = join(skillDir, 'SKILL.md')
    await assertDirectoryChain(this.root, true)
    await assertAbsent(join(this.root, `${inspection.name}.md`))
    signal.throwIfAborted()
    try {
      await mkdir(skillDir, { mode: 0o700 })
    } catch (error) {
      if (isCode(error, 'EEXIST')) throw new RemoteError('skill-import/conflict', `Skill ${inspection.name} already exists`, {})
      throw error
    }
    const temporaryPath = join(skillDir, `.SKILL.md.${randomUUID()}.tmp`)
    let published = false
    try {
      await assertDirectoryChain(this.root, false)
      const canonicalRoot = await realpath(this.root)
      if (await realpath(skillDir) !== join(canonicalRoot, inspection.name)) {
        throw new RemoteError('skill-import/unsafe-path', 'Skill destination changed while installing', {})
      }
      const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      const handle = await open(temporaryPath, writeFlags, 0o600)
      try {
        await handle.writeFile(content, { encoding: 'utf8', signal })
        await handle.sync()
      } finally { await handle.close() }
      signal.throwIfAborted()
      await link(temporaryPath, targetPath)
      published = true
      await unlink(temporaryPath)
      const saved = await readBoundedFile(targetPath, MAX_SKILL_IMPORT_BYTES)
      const info = await lstat(targetPath)
      if (saved === null || !info.isFile() || info.isSymbolicLink()
        || saved.length !== inspection.bytes || digest(saved) !== inspection.sha256) {
        throw new Error('published SKILL.md failed byte verification')
      }
      const parsed = parseSkillDocument(saved.toString('utf8'))
      if (parsed.name !== inspection.name) throw new Error('published SKILL.md changed its name')
      return { state: 'written', name: inspection.name, sha256: inspection.sha256, path: targetPath, bytes: inspection.bytes }
    } finally {
      if (!published) {
        await unlink(temporaryPath).catch((error: unknown) => { if (!isCode(error, 'ENOENT')) throw error })
        await rmdir(skillDir).catch((error: unknown) => { if (!isCode(error, 'ENOENT') && !isCode(error, 'ENOTEMPTY')) throw error })
      }
    }
  }

  /**
   * Check one expected digest at the controlled skill path after an uncertain install response.
   * @param name - Previously inspected kebab-case skill name.
   * @param sha256 - Lowercase SHA-256 digest returned by inspect.
   * @returns Matched bytes, changed or unsafe bytes, or an absent file; no Session visibility claim.
   */
  @Remote
  async verify(name: string, sha256: string): Promise<SkillImportVerification> {
    if (!isSkillName(name) || name.length > 64 || !SHA256_HEX.test(sha256)) {
      throw invalid('Verification requires a valid skill name and lowercase SHA-256 digest')
    }
    const before = await inspectVerificationPath(this.root, name)
    if (before !== 'regular') return { state: before }
    const path = join(this.root, name, 'SKILL.md')
    let saved: Buffer | null
    try {
      saved = await readBoundedFile(path, MAX_SKILL_IMPORT_BYTES)
    } catch (error) {
      if (isCode(error, 'ENOENT')) return { state: 'missing' }
      if (isCode(error, 'ELOOP') || isCode(error, 'ENOTDIR')) return { state: 'different' }
      throw error
    }
    const after = await inspectVerificationPath(this.root, name)
    if (after !== 'regular') return { state: after }
    return { state: saved !== null && digest(saved) === sha256 ? 'matched' : 'different' }
  }

  /**
   * Read valid user skill files from the two roots scanned by the filesystem provider.
   * This is a local inventory, not proof that a particular Session selects a skill.
   * @returns Valid user skill entries from the configured roots, without claiming Session selection.
   */
  @Remote
  async listLocal(): Promise<LocalSkillList> {
    const roots: Array<{ path: string; source: LocalSkillEntry['source'] }> = [
      { path: this.root, source: 'user-dsh' },
    ]
    if (this.agentsRoot !== null && this.agentsRoot !== this.root) {
      roots.push({ path: this.agentsRoot, source: 'user-agents' })
    }
    const skills: LocalSkillEntry[] = []
    for (const root of roots) skills.push(...await listRootSkills(root.path, root.source))
    return { skills }
  }

  /**
   * Archive only an exact current user skill; installed runtime and market records are separate.
   * @param request - Source, name, path and digest returned by listLocal.
   * @param signal - Cancels before the whole-directory move.
   * @returns Local restoration paths; no cloud withdrawal or package uninstall claim.
   */
  @Remote
  async archiveLocal(request: LocalSkillArchiveRequest, signal: AbortSignal): Promise<LocalSkillArchiveReceipt> {
    if (typeof request.name !== 'string' || typeof request.path !== 'string') {
      throw invalid('Select a current local skill')
    }
    const selected = (await this.listLocal()).skills.find(skill => skill.source === request.source
      && skill.name === request.name && skill.path === request.path)
    if (!selected || selected.sha256 !== request.sha256) {
      throw new RemoteError('skill-import/changed', 'Skill changed; refresh before removing it', {})
    }
    if (selected.canArchive !== true) {
      throw new RemoteError('skill-import/managed', 'Use package management for an installed runtime', {})
    }
    await this.assertNotNodeBinding(dirname(request.path))
    const roots: Array<{ path: string; source: LocalSkillEntry['source'] }> = [
      { path: this.root, source: 'user-dsh' },
    ]
    if (this.agentsRoot !== null && this.agentsRoot !== this.root) {
      roots.push({ path: this.agentsRoot, source: 'user-agents' })
    }
    return archiveLocalSkill(request, roots, signal)
  }

  /**
   * List only recoverable payloads in this Host's configured user roots.
   * @returns Only validated recoverable entries under the configured user archive roots.
   */
  @Remote
  async archiveList(): Promise<{ items: readonly LocalSkillArchiveEntry[] }> {
    return { items: await listLocalSkillArchives(this.archiveRoots()) }
  }

  /**
   * Explicit local restoration; it does not publish, install or enable orders.
   * @param request - The archive source, identifier, and digest returned by the validated archive list.
   * @param signal - Cancellation for validation and restoration before the local copy is committed.
   * @returns The local restoration receipt; publication and supply authorization stay separate.
   */
  @Remote
  async restoreLocal(request: LocalSkillRestoreRequest, signal: AbortSignal): Promise<LocalSkillRestoreReceipt> {
    return restoreLocalSkill(request, this.archiveRoots(), signal, entry => this.assertNotNodeBinding(entry.originalPath))
  }

  private async assertNotNodeBinding(directory: string): Promise<void> {
    const profile = this.ctx.get('profileContext') as { dir?: string } | undefined
    if (profile?.dir === undefined) return
    let bytes: Buffer | null = null
    try { bytes = await readBoundedFile(join(profile.dir, 'qianshou-artifact-adapter.json'), 4096) }
    catch (error) { if (!isCode(error, 'ENOENT')) throw error }
    if (bytes === null) return
    const binding = JSON.parse(bytes.toString('utf8')) as { root?: unknown }
    if (typeof binding.root === 'string' && (binding.root === directory || binding.root.startsWith(`${directory}${sep}`))) {
      throw new RemoteError('skill-import/in-use', 'Skill is selected for node execution; change its binding first', {})
    }
  }

  private archiveRoots(): Array<{ path: string; source: LocalSkillEntry['source'] }> {
    const roots: Array<{ path: string; source: LocalSkillEntry['source'] }> = [{ path: this.root, source: 'user-dsh' }]
    if (this.agentsRoot !== null && this.agentsRoot !== this.root) roots.push({ path: this.agentsRoot, source: 'user-agents' })
    return roots
  }

  /**
   * Return this live owner's configured roots without creating or modifying files.
   * @param name - An optional exact kebab-case skill name of at most 64 characters.
   * @returns The configured writable roots and exact-name authoring destinations, if requested.
   */
  async authoringContext(name?: string): Promise<SkillAuthoringContext> {
    if (name !== undefined && (!isSkillName(name) || name.length > 64)) {
      throw invalid('Authoring name must be a kebab-case skill name of at most 64 characters')
    }
    const locations: Array<{ path: string; source: LocalSkillEntry['source'] }> = [
      { path: this.root, source: 'user-dsh' },
    ]
    if (this.agentsRoot !== null && this.agentsRoot !== this.root) {
      locations.push({ path: this.agentsRoot, source: 'user-agents' })
    }
    const roots: SkillAuthoringContext['roots'][number][] = []
    for (const location of locations) {
      let exists = false
      try {
        await assertDirectoryChain(location.path, false)
        let anchor = location.path
        for (;;) {
          try { await lstat(anchor); exists = anchor === location.path; break }
          catch (error) { if (!isCode(error, 'ENOENT')) throw error; anchor = dirname(anchor) }
        }
        await access(anchor, constants.W_OK | constants.X_OK)
        roots.push({ ...location, exists, hostWritable: true })
      } catch (error) {
        const problem = error instanceof RemoteError && error.code === 'skill-import/unsafe-path'
          ? 'unsafe-path' : isCode(error, 'EACCES') || isCode(error, 'EPERM') || isCode(error, 'EROFS')
            ? 'not-writable' : 'unreadable'
        roots.push({ ...location, exists, hostWritable: false, problem })
      }
    }
    const preferred = roots.find(root => root.hostWritable)
    if (name === undefined || preferred === undefined) return { roots, destination: null }
    const directory = join(preferred.path, name)
    let conflict = false
    for (const path of [directory, join(preferred.path, `${name}.md`)]) {
      try { await lstat(path); conflict = true }
      catch (error) { if (!isCode(error, 'ENOENT')) throw error }
    }
    return { roots, destination: { source: preferred.source, directory,
      skillFile: join(directory, 'SKILL.md'), conflict } }
  }

  private expirePending(): void {
    const now = Date.now()
    for (const [id, pending] of this.pending) {
      if (pending.inspection.expiresAt <= now) this.pending.delete(id)
    }
  }
}

function invalid(message: string): RemoteError<'skill-import/invalid'> {
  return new RemoteError('skill-import/invalid', message, {})
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

const LOCAL_CATEGORIES = new Set([
  'text', 'image', 'video', 'ppt', 'spreadsheet', 'research',
  'development', 'automation', 'design', 'data', 'other',
])

async function listRootSkills(root: string, source: LocalSkillEntry['source']): Promise<LocalSkillEntry[]> {
  await assertDirectoryChain(root, false)
  let entries: Dirent[]
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (isCode(error, 'ENOENT')) return []
    throw error
  }
  const skills: LocalSkillEntry[] = []
  for (const entry of entries) {
    const bundle = entry.isDirectory() && isSkillName(entry.name) && entry.name.length <= 64
    const flat = entry.isFile() && entry.name.endsWith('.md')
      && isSkillName(entry.name.slice(0, -3)) && entry.name.length <= 67
    if (!bundle && !flat) continue
    const expectedName = bundle ? entry.name : entry.name.slice(0, -3)
    const path = bundle ? join(root, entry.name, 'SKILL.md') : join(root, entry.name)
    if (bundle) {
      let directory
      try { directory = await lstat(join(root, entry.name)) } catch (error) {
        if (isCode(error, 'ENOENT')) continue
        throw error
      }
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue
    }
    let file
    try { file = await lstat(path) } catch (error) {
      if (isCode(error, 'ENOENT')) continue
      throw error
    }
    if (!file.isFile() || file.isSymbolicLink()) continue
    let bytes: Buffer | null
    try { bytes = await readBoundedFile(path, MAX_SKILL_IMPORT_BYTES) } catch (error) {
      if (isCode(error, 'ENOENT') || isCode(error, 'ELOOP')) continue
      throw error
    }
    if (bytes === null) continue
    const content = bytes.toString('utf8')
    if (!Buffer.from(content, 'utf8').equals(bytes)) continue
    let parsed: ReturnType<typeof parseSkillDocument>
    try { parsed = parseSkillDocument(content) } catch { continue }
    if (parsed.name !== expectedName || parsed.description.trim() === '' || parsed.content === '') continue
    const displayName = shortLabel(parsed.metadata?.displayName)
      ?? shortLabel(parsed.content.match(/^#\s+(.+)$/m)?.[1]) ?? parsed.name
    const category = parsed.metadata?.category
    skills.push({
      name: parsed.name, displayName, description: parsed.description,
      ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
      ...typeof category === 'string' && LOCAL_CATEGORIES.has(category) ? { category } : {},
      source, path, updatedAt: file.mtimeMs,
      sha256: digest(bytes), canArchive: await localSkillMayArchive(path),
      modelInvocable: parsed.invocation.modelInvocable,
      userInvocable: parsed.invocation.userInvocable,
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function shortLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= 80
    ? value.trim() : undefined
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) return null
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}

async function inspectVerificationPath(root: string, name: string): Promise<'regular' | SkillImportVerification['state']> {
  try {
    await assertDirectoryChain(root, false)
  } catch (error) {
    if (error instanceof RemoteError && error.code === 'skill-import/unsafe-path') return 'different'
    throw error
  }
  const directory = await lstatForVerification(join(root, name))
  if (typeof directory === 'string') return directory
  if (!directory.isDirectory() || directory.isSymbolicLink()) return 'different'
  const file = await lstatForVerification(join(root, name, 'SKILL.md'))
  if (typeof file === 'string') return file
  return file.isFile() && !file.isSymbolicLink() ? 'regular' : 'different'
}

async function lstatForVerification(path: string): Promise<Awaited<ReturnType<typeof lstat>> | 'different' | 'missing'> {
  try { return await lstat(path) } catch (error) {
    if (isCode(error, 'ENOENT')) return 'missing'
    if (isCode(error, 'ENOTDIR')) return 'different'
    throw error
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new RemoteError('skill-import/conflict', `Skill path already exists: ${path}`, {})
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
}

/** Reject every existing symlink component before any install creates a child. */
async function assertDirectoryChain(path: string, create: boolean): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const components: string[] = []
  for (let current = absolute; current !== root; current = dirname(current)) components.push(current)
  components.push(root)
  for (const component of components.reverse()) {
    let info
    try {
      info = await lstat(component)
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error
      if (!create) continue
      try { await mkdir(component, { mode: 0o700 }) } catch (creationError) {
        if (!isCode(creationError, 'EEXIST')) throw creationError
      }
      info = await lstat(component)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new RemoteError('skill-import/unsafe-path', `Skill root contains a symlink or non-directory: ${component}`, {})
    }
  }
}

export default QianshouSkillImport
