/** Stable opaque PC identity: configured, else persisted beneath DSH_HOME, else generated once and persisted. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MobileSyncFailure } from './failure.ts'
import { isOpaqueId, record } from './validation.ts'

/** Durable file format; a different version is refused, never migrated silently. */
export const PC_ID_FILE_VERSION = 1
const MAX_FILE_BYTES = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Resolved identity with its provenance for diagnostics. */
export interface ResolvedPcId {
  readonly pcId: string
  readonly source: 'configured' | 'persisted' | 'generated'
}

async function writePrivateAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, path)
  } catch (error) {
    // Removing the private temporary is best effort: its own failure must not replace the write failure.
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
function parseFile(text: string): string {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new MobileSyncFailure('PC_ID_INVALID') }
  const row = record(value)
  if (row.version !== PC_ID_FILE_VERSION || typeof row.pcId !== 'string' || !UUID.test(row.pcId)) throw new MobileSyncFailure('PC_ID_INVALID')
  return row.pcId
}
/**
 * Resolve this PC's identity. A configured value wins; otherwise the persisted file is read strictly, and only a
 * missing file causes a fresh UUID to be generated and written with owner-only permissions. A malformed or
 * foreign file is refused so a damaged identity can never silently become a new PC at the relay.
 * @param configured - Deployment-chosen opaque id; empty means unconfigured.
 * @param path - Private JSON file path beneath DSH_HOME.
 * @returns The identity and where it came from.
 */
export async function resolvePcId(configured: string, path: string): Promise<ResolvedPcId> {
  if (configured.length > 0) {
    if (!isOpaqueId(configured)) throw new MobileSyncFailure('PC_ID_INVALID')
    return { pcId: configured, source: 'configured' }
  }
  let text: string | undefined
  try { text = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MobileSyncFailure('PC_ID_INVALID') }
  if (text !== undefined) {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new MobileSyncFailure('PC_ID_INVALID')
    return { pcId: parseFile(text), source: 'persisted' }
  }
  const pcId = randomUUID()
  try { await writePrivateAtomic(path, `${JSON.stringify({ version: PC_ID_FILE_VERSION, pcId })}\n`) }
  catch { throw new MobileSyncFailure('STORAGE_FAILED') }
  return { pcId, source: 'generated' }
}
