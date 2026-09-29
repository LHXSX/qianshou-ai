/** Host-only private persistence for untrusted, non-installable offline plugin archives. */
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'
import { readVerifiedOfflinePluginActivationMaterial, verifyOfflinePluginArtifact,
  type OfflinePluginArtifact, type VerifiedOfflinePluginActivationMaterial,
  type VerifiedOfflinePluginArtifact } from './offline-plugin-artifact.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const ROOT_MODE = 0o700
const FILE_MODE = 0o600
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024

/** No archive bytes, sample JSON, private path, or executable status enter this receipt. */
export interface PrivateOfflinePluginArtifactSummary {
  readonly format: 'qianshou.private-offline-plugin-artifact-store.v1'
  readonly packageSha256: string
  readonly candidateSha256: string
  readonly pluginId: string
  readonly version: string
  readonly operationIds: readonly string[]
  readonly bytes: number
  readonly state: 'stored-private-uninstalled' | 'removed-private'
  readonly executionVerified: false
  readonly installable: false
  readonly dispatchable: false
}

function refused(code: string, status = 409): ComputeError { return new ComputeError(code, status) }
function invalidDigest(value: unknown): boolean { return typeof value !== 'string' || !SHA256.test(value) }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }
function owned(stat: { readonly uid: number }): boolean {
  return process.getuid === undefined || stat.uid === process.getuid()
}
function summary(verified: VerifiedOfflinePluginArtifact, bytes: number,
  state: PrivateOfflinePluginArtifactSummary['state']): PrivateOfflinePluginArtifactSummary {
  return Object.freeze({ format: 'qianshou.private-offline-plugin-artifact-store.v1',
    packageSha256: verified.packageSha256, candidateSha256: verified.candidateSha256,
    pluginId: verified.pluginId, version: verified.version,
    operationIds: Object.freeze([...verified.operationIds]), bytes, state,
    executionVerified: false, installable: false, dispatchable: false })
}

/** The caller supplies one fixed Host profile root. No model-provided path is accepted by methods. */
export class PrivateOfflinePluginArtifactStore {
  private readonly root: string

  constructor(root: string) {
    if (typeof root !== 'string' || !isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)
      || root.split(sep).some(part => part === '.' || part === '..')
      || resolve(root) === parse(resolve(root)).root) {
      throw refused('COMPUTE_PRIVATE_ARTIFACT_ROOT_INVALID', 400)
    }
    this.root = resolve(root)
  }

  /** Persist a Host-produced archive atomically; a concurrent identical write returns the same receipt. */
  async persist(artifact: OfflinePluginArtifact): Promise<PrivateOfflinePluginArtifactSummary> {
    let snapshot: Buffer
    let expected: { packageSha256: string; candidateSha256: string }
    try {
      if (artifact?.state !== 'built-offline-uninstalled' || artifact.packageProduced !== true
        || artifact.executionVerified !== false || artifact.installable !== false
        || artifact.dispatchable !== false || !Buffer.isBuffer(artifact.bytes)
        || artifact.bytes.length > MAX_ARCHIVE_BYTES
        || invalidDigest(artifact.packageSha256) || invalidDigest(artifact.candidateSha256)) {
        throw refused('COMPUTE_PRIVATE_ARTIFACT_INPUT_INVALID', 400)
      }
      snapshot = Buffer.from(artifact.bytes)
      expected = { packageSha256: artifact.packageSha256, candidateSha256: artifact.candidateSha256 }
    } catch (error) {
      if (error instanceof ComputeError) throw error
      throw refused('COMPUTE_PRIVATE_ARTIFACT_INPUT_INVALID', 400)
    }
    const verified = verifyOfflinePluginArtifact(snapshot, expected)
    await this.ensureRoot(true)
    const destination = this.path(expected.packageSha256)
    try {
      return await withFileLock(destination, async () => {
        await this.ensureRoot(false)
        try { return await this.readVerified(destination, expected) }
        catch (error) {
          if (!(error instanceof ComputeError) || error.code !== 'COMPUTE_PRIVATE_ARTIFACT_NOT_FOUND') throw error
        }
        const staging = join(this.root, `.artifact-${expected.packageSha256}.${randomUUID()}.tmp`)
        let file: Awaited<ReturnType<typeof open>> | undefined
        try {
          file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            | constants.O_NOFOLLOW, FILE_MODE)
          await file.chmod(FILE_MODE)
          await file.writeFile(snapshot)
          await file.sync()
          await file.close()
          file = undefined
          await this.readVerified(staging, expected)
          await this.ensureRoot(false)
          try { await link(staging, destination) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            return this.readVerified(destination, expected)
          }
          await unlink(staging)
          await this.syncRoot()
          const stored = await this.readVerified(destination, expected)
          if (stored.pluginId !== verified.pluginId || stored.version !== verified.version) {
            throw refused('COMPUTE_PRIVATE_ARTIFACT_CHANGED')
          }
          return stored
        } finally {
          await file?.close().catch(() => {})
          await unlink(staging).catch(error => { if (!isMissing(error)) throw error })
        }
      }, { waitMs: 10_000 })
    } catch (error) { return this.fail(error) }
  }

  /** Re-read and verify the exact pinned private archive without returning sample contents or its path. */
  async inspect(packageSha256: string, candidateSha256: string): Promise<PrivateOfflinePluginArtifactSummary> {
    const expected = this.expected(packageSha256, candidateSha256)
    try {
      await this.ensureRoot(false)
      return await this.readVerified(this.path(packageSha256), expected)
    } catch (error) { return this.fail(error) }
  }

  /** Host-only verified declarations for private activation; never return this from a route or model tool. */
  async loadForActivation(packageSha256: string, candidateSha256: string):
  Promise<VerifiedOfflinePluginActivationMaterial> {
    const expected = this.expected(packageSha256, candidateSha256)
    try {
      await this.ensureRoot(false)
      return (await this.readChecked(this.path(packageSha256), expected)).material
    } catch (error) { return this.fail(error) }
  }

  /** Hold the archive's removal lock while committing an activation or running a trusted callback. */
  async withActivationArchive<T>(packageSha256: string, candidateSha256: string,
    action: (material: VerifiedOfflinePluginActivationMaterial) => Promise<T>): Promise<T> {
    const expected = this.expected(packageSha256, candidateSha256)
    await this.ensureRoot(false)
    return withFileLock(this.path(packageSha256), async () => {
      const material = (await this.readChecked(this.path(packageSha256), expected)).material
      return action(material)
    }, { waitMs: 180_000 })
  }

  /** Remove one exact, reverified artifact as a separate Host lifecycle action. */
  async remove(packageSha256: string, candidateSha256: string): Promise<PrivateOfflinePluginArtifactSummary> {
    const expected = this.expected(packageSha256, candidateSha256)
    try {
      await this.ensureRoot(false)
      const destination = this.path(packageSha256)
      return await withFileLock(destination, async () => {
        await this.ensureRoot(false)
        const stored = await this.readVerified(destination, expected)
        await unlink(destination)
        await this.syncRoot()
        return Object.freeze({ ...stored, state: 'removed-private' as const })
      }, { waitMs: 10_000 })
    } catch (error) { return this.fail(error) }
  }

  private expected(packageSha256: string, candidateSha256: string): {
    packageSha256: string; candidateSha256: string } {
    if (invalidDigest(packageSha256) || invalidDigest(candidateSha256)) {
      throw refused('COMPUTE_PRIVATE_ARTIFACT_DIGEST_INVALID', 400)
    }
    return { packageSha256, candidateSha256 }
  }

  private path(packageSha256: string): string {
    if (invalidDigest(packageSha256)) throw refused('COMPUTE_PRIVATE_ARTIFACT_DIGEST_INVALID', 400)
    return join(this.root, `artifact-${packageSha256}.zip`)
  }

  private async ensureRoot(create: boolean): Promise<void> {
    let cursor = parse(this.root).root
    for (const segment of this.root.slice(cursor.length).split(sep)) {
      cursor = join(cursor, segment)
      let made = false
      let stat
      try { stat = await lstat(cursor) }
      catch (error) {
        if (!isMissing(error) || !create) throw error
        try { await mkdir(cursor, { mode: ROOT_MODE }); made = true }
        catch (creationError) {
          if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError
        }
        stat = await lstat(cursor)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused('COMPUTE_PRIVATE_ARTIFACT_ROOT_UNSAFE', 403)
      if (made) {
        await chmod(cursor, ROOT_MODE)
        stat = await lstat(cursor)
      }
      if (cursor === this.root && (!owned(stat) || (stat.mode & 0o777) !== ROOT_MODE)) {
        throw refused('COMPUTE_PRIVATE_ARTIFACT_ROOT_UNSAFE', 403)
      }
    }
    if (await realpath(this.root) !== this.root) throw refused('COMPUTE_PRIVATE_ARTIFACT_ROOT_UNSAFE', 403)
  }

  private async readVerified(path: string, expected: { packageSha256: string; candidateSha256: string }):
  Promise<PrivateOfflinePluginArtifactSummary> {
    return (await this.readChecked(path, expected)).summary
  }

  private async readChecked(path: string, expected: { packageSha256: string; candidateSha256: string }):
  Promise<{ readonly summary: PrivateOfflinePluginArtifactSummary;
    readonly material: VerifiedOfflinePluginActivationMaterial }> {
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (isMissing(error)) throw refused('COMPUTE_PRIVATE_ARTIFACT_NOT_FOUND', 404)
      throw refused('COMPUTE_PRIVATE_ARTIFACT_CHANGED')
    }
    try {
      const before = await file.stat()
      if (!before.isFile() || !owned(before) || before.nlink !== 1
        || (before.mode & 0o777) !== FILE_MODE || before.size < 22 || before.size > MAX_ARCHIVE_BYTES) {
        throw refused('COMPUTE_PRIVATE_ARTIFACT_CHANGED')
      }
      const bytes = await file.readFile()
      const after = await lstat(path)
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.nlink !== 1 || (after.mode & 0o777) !== FILE_MODE
        || !owned(after) || bytes.length !== before.size) throw refused('COMPUTE_PRIVATE_ARTIFACT_CHANGED')
      let material: VerifiedOfflinePluginActivationMaterial
      try { material = readVerifiedOfflinePluginActivationMaterial(bytes, expected) }
      catch { throw refused('COMPUTE_PRIVATE_ARTIFACT_CHANGED') }
      return { summary: summary(material.verified, bytes.length, 'stored-private-uninstalled'), material }
    } finally { await file.close() }
  }

  private async syncRoot(): Promise<void> {
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() }
    finally { await directory.close() }
  }

  private fail(error: unknown): never {
    if (error instanceof ComputeError) throw error
    if (isMissing(error)) throw refused('COMPUTE_PRIVATE_ARTIFACT_NOT_FOUND', 404)
    throw refused('COMPUTE_PRIVATE_ARTIFACT_IO_FAILED', 503)
  }
}
