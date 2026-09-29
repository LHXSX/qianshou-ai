/** Per-profile, digest-pinned media adapter choice. Never stores an owner grant. */
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { SVG_VIDEO_PACKAGE_ALGORITHM } from './pinned-svg-video.ts'

export interface ArtifactAdapterSelection {
  readonly root: string
  readonly digest: string
  readonly packageDigest: string
  readonly inventoryAlgorithm: typeof SVG_VIDEO_PACKAGE_ALGORITHM
  readonly pythonPath: string
  readonly swiftPath: string
}

const FILE = 'qianshou-artifact-adapter.json'
const SHA256 = /^[0-9a-f]{64}$/u

function parse(value: unknown): ArtifactAdapterSelection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ARTIFACT_SELECTION_INVALID')
  const row = value as Record<string, unknown>
  // v2/v3 package digests are not the reproducible v4 inventory. The owner must
  // reselect and pass the current local self-test before any new platform claim.
  if (Object.keys(row).length !== 7 || row.version !== 4
    || row.inventoryAlgorithm !== SVG_VIDEO_PACKAGE_ALGORITHM || typeof row.digest !== 'string'
    || !SHA256.test(row.digest) || typeof row.root !== 'string' || !isAbsolute(row.root)
    || typeof row.packageDigest !== 'string' || !SHA256.test(row.packageDigest)
    || typeof row.pythonPath !== 'string' || !isAbsolute(row.pythonPath)
    || typeof row.swiftPath !== 'string' || !isAbsolute(row.swiftPath)) {
    throw new Error('ARTIFACT_SELECTION_INVALID')
  }
  return { root: row.root, digest: row.digest, packageDigest: row.packageDigest,
    inventoryAlgorithm: SVG_VIDEO_PACKAGE_ALGORITHM,
    pythonPath: row.pythonPath, swiftPath: row.swiftPath }
}

export function loadArtifactAdapterSelection(profileDir: string | undefined,
  fallback: ArtifactAdapterSelection | null): { selection: ArtifactAdapterSelection | null; valid: boolean } {
  if (profileDir === undefined) return { selection: fallback, valid: true }
  try {
    const path = join(profileDir, FILE)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) {
      throw new Error('ARTIFACT_SELECTION_INVALID')
    }
    const bytes = readFileSync(path)
    if (bytes.length !== stat.size) throw new Error('ARTIFACT_SELECTION_INVALID')
    return { selection: parse(JSON.parse(bytes.toString('utf8')) as unknown), valid: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { selection: fallback, valid: true }
    return { selection: null, valid: false }
  }
}

export async function saveArtifactAdapterSelection(profileDir: string,
  selection: ArtifactAdapterSelection): Promise<void> {
  const normalized = parse({ version: 4, ...selection })
  const path = join(profileDir, FILE)
  try {
    const existing = await lstat(path)
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('ARTIFACT_SELECTION_INVALID')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(profileDir, `${FILE}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ version: 4, ...normalized })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    if (JSON.stringify(parse(JSON.parse(await readFile(path, 'utf8') as string) as unknown)) !== JSON.stringify(normalized)) {
      throw new Error('ARTIFACT_SELECTION_WRITE_MISMATCH')
    }
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
}
