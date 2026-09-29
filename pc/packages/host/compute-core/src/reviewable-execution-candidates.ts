/** Private content-addressed storage for independently reviewable execution candidates. */
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'
import { verifyReviewableExecutionArtifact,
  type ReviewableExecutionArtifact, type VerifiedReviewableExecutionArtifact,
} from './reviewable-execution-artifact.ts'

const SHA = /^[0-9a-f]{64}$/u
const MAX_CANDIDATES = 32
const MAX_BYTES = 256 * 1024

function invalid(code = 'COMPUTE_REVIEWABLE_CANDIDATE_INVALID', status = 400): never {
  throw new ComputeError(code, status)
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }

/** Exact local bytes are retained for owner export and future independent review, not installed. */
export class ReviewableExecutionCandidateStore {
  private readonly root: string

  constructor(directory: string) {
    if (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)
      || directory.split(sep).some(part => part === '.' || part === '..')
      || resolve(directory) === parse(resolve(directory)).root) invalid()
    this.root = resolve(directory)
  }

  private path(sha256: string): string {
    if (!SHA.test(sha256)) invalid()
    return join(this.root, `${sha256}.json`)
  }

  private async ensureRoot(create: boolean): Promise<void> {
    let cursor = parse(this.root).root
    for (const segment of this.root.slice(cursor.length).split(sep)) {
      cursor = join(cursor, segment)
      let made = false
      let info
      try { info = await lstat(cursor) }
      catch (error) {
        if (!create || !missing(error)) throw error
        try { await mkdir(cursor, { mode: 0o700 }); made = true }
        catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError }
        info = await lstat(cursor)
      }
      if (!info.isDirectory() || info.isSymbolicLink()) invalid('COMPUTE_REVIEWABLE_CANDIDATE_ROOT_UNSAFE', 403)
      if (made) { await chmod(cursor, 0o700); info = await lstat(cursor) }
      if (cursor === this.root && ((info.mode & 0o777) !== 0o700
        || (process.getuid !== undefined && info.uid !== process.getuid()))) {
        invalid('COMPUTE_REVIEWABLE_CANDIDATE_ROOT_UNSAFE', 403)
      }
    }
    if (await realpath(this.root) !== this.root) invalid('COMPUTE_REVIEWABLE_CANDIDATE_ROOT_UNSAFE', 403)
  }

  /** Persist canonical bytes without replacing an existing object or following a symlink. */
  async save(artifact: ReviewableExecutionArtifact): Promise<VerifiedReviewableExecutionArtifact> {
    const snapshot = Buffer.from(artifact.bytes)
    const checked = verifyReviewableExecutionArtifact(snapshot)
    if (checked.packageSha256 !== artifact.packageSha256) invalid()
    await this.ensureRoot(true)
    return withFileLock(join(this.root, '.candidate-store'), async () => {
      await this.ensureRoot(false)
      const destination = this.path(checked.packageSha256)
      try { return (await this.readChecked(destination, checked.packageSha256)).verified }
      catch (error) {
        if (!(error instanceof ComputeError) || error.code !== 'COMPUTE_REVIEWABLE_CANDIDATE_NOT_FOUND') throw error
      }
      const entries = await readdir(this.root)
      if (entries.filter(name => /^[0-9a-f]{64}\.json$/u.test(name)).length >= MAX_CANDIDATES) {
        invalid('COMPUTE_REVIEWABLE_CANDIDATE_STORE_FULL', 409)
      }
      const staging = join(this.root, `.candidate-${checked.packageSha256}.${randomUUID()}.tmp`)
      let file: Awaited<ReturnType<typeof open>> | undefined
      try {
        file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await file.chmod(0o600)
        await file.writeFile(snapshot)
        await file.sync()
        await file.close()
        file = undefined
        await this.readChecked(staging, checked.packageSha256)
        await this.ensureRoot(false)
        try { await link(staging, destination) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          return (await this.readChecked(destination, checked.packageSha256)).verified
        }
        await unlink(staging)
        return (await this.readChecked(destination, checked.packageSha256)).verified
      } finally {
        await file?.close().catch(() => {})
        await unlink(staging).catch(error => { if (!missing(error)) throw error })
      }
    }, { waitMs: 10_000 })
  }

  /** Reverify disk bytes, owner permissions and identity on every read. */
  async read(sha256: string): Promise<{ readonly bytes: Buffer; readonly verified: VerifiedReviewableExecutionArtifact }> {
    const path = this.path(sha256)
    try { await this.ensureRoot(false) }
    catch (error) { if (missing(error)) invalid('COMPUTE_REVIEWABLE_CANDIDATE_NOT_FOUND', 404); throw error }
    return this.readChecked(path, sha256)
  }

  private async readChecked(path: string, sha256: string): Promise<{
    readonly bytes: Buffer; readonly verified: VerifiedReviewableExecutionArtifact }> {
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (missing(error)) invalid('COMPUTE_REVIEWABLE_CANDIDATE_NOT_FOUND', 404)
      invalid('COMPUTE_REVIEWABLE_CANDIDATE_CHANGED', 409)
    }
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size < 2 || info.size > MAX_BYTES
        || (info.mode & 0o777) !== 0o600
        || (process.getuid !== undefined && info.uid !== process.getuid())) {
        invalid('COMPUTE_REVIEWABLE_CANDIDATE_CHANGED', 409)
      }
      const bytes = await file.readFile()
      const verified = verifyReviewableExecutionArtifact(bytes)
      if (verified.packageSha256 !== sha256) invalid('COMPUTE_REVIEWABLE_CANDIDATE_CHANGED', 409)
      return { bytes, verified }
    } finally { await file.close() }
  }

  async export(sha256: string): Promise<{ readonly fileName: string; readonly contentType: 'application/json';
    readonly contents: string; readonly packageSha256: string; readonly reviewed: false;
    readonly installable: false; readonly dispatchable: false }> {
    const { bytes, verified } = await this.read(sha256)
    return { fileName: `${verified.manifest.pluginId}-${verified.manifest.version}.reviewable-execution.json`,
      contentType: 'application/json', contents: bytes.toString('utf8'), packageSha256: verified.packageSha256,
      reviewed: false, installable: false, dispatchable: false }
  }
}
