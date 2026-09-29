/** Authenticated delivery of the host's explicitly staged companion archives. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { constants, type ReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'

const TARGETS = ['darwin-arm64', 'win32-x64', 'linux-x64'] as const
const PREFIX = '/api/qianshou/companion-downloads'
const MAX_ARCHIVE = 512 * 1024 * 1024
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
/** Public release facts; private source paths and credentials never cross this boundary. */
export interface CompanionRelease {
  id: typeof TARGETS[number]
  version: string
  filename: string
  bytes: number
  sha256: string
  validation: 'local-mac-verified' | 'packaged-only'
}
function release(value: unknown): CompanionRelease {
  if (typeof value !== 'object' || value === null) throw new Error('INVALID_RELEASE_MANIFEST')
  const v = value as Record<string, unknown>
  if (!TARGETS.some(id => id === v.id) || typeof v.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(v.version)
    || typeof v.filename !== 'string' || !/^qianshou-companion-[a-z0-9.-]+\.(zip|tar\.gz)$/.test(v.filename)
    || typeof v.bytes !== 'number' || !Number.isSafeInteger(v.bytes) || v.bytes < 1 || v.bytes > MAX_ARCHIVE
    || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256)
    || (v.validation !== 'local-mac-verified' && v.validation !== 'packaged-only')) throw new Error('INVALID_RELEASE_MANIFEST')
  const id = TARGETS.find(id => id === v.id)
  if (id === undefined || v.filename !== `qianshou-companion-${v.version}-${id}.${id === 'linux-x64' ? 'tar.gz' : 'zip'}`
    || (v.validation === 'local-mac-verified' && id !== 'darwin-arm64')) throw new Error('INVALID_RELEASE_MANIFEST')
  return { id, version: v.version, filename: v.filename, bytes: v.bytes, sha256: v.sha256, validation: v.validation }
}
/** Fixed-file archive owner: verifies staged checksums and streams downloads with cancellation. */
export class CompanionDownloads {
  private readonly streams = new Set<ReadStream>()
  private readonly verified = new Map<string, string>()
  private disposed = false
  constructor(private readonly directory: string) {}

  private async manifest(): Promise<CompanionRelease[]> {
    let file
    try { file = await open(join(this.directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
      throw new Error('INVALID_RELEASE_MANIFEST')
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16384) throw new Error('INVALID_RELEASE_MANIFEST')
      const buffer = Buffer.alloc(16385)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 16384) throw new Error('INVALID_RELEASE_MANIFEST')
      const parsed: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead))
      if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
        || !('releases' in parsed) || !Array.isArray(parsed.releases) || parsed.releases.length > 3) throw new Error('INVALID_RELEASE_MANIFEST')
      const releases = parsed.releases.map(release)
      if (new Set(releases.map(item => item.id)).size !== releases.length) throw new Error('INVALID_RELEASE_MANIFEST')
      return releases
    } finally { await file.close() }
  }

  private async verifiedFile(item: CompanionRelease) {
    const file = await open(join(this.directory, item.filename), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size !== item.bytes) throw new Error('RELEASE_UNAVAILABLE')
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${item.sha256}`
      if (this.verified.get(item.id) !== stamp) {
        const hash = createHash('sha256')
        const buffer = Buffer.alloc(1024 * 1024)
        for (let position = 0; position < stat.size;) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position)
          if (bytesRead === 0) throw new Error('RELEASE_UNAVAILABLE')
          hash.update(buffer.subarray(0, bytesRead))
          position += bytesRead
        }
        if (hash.digest('hex') !== item.sha256) throw new Error('RELEASE_CHECKSUM_MISMATCH')
        const after = await file.stat()
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('RELEASE_UNAVAILABLE')
        this.verified.set(item.id, stamp)
      }
      return file
    } catch (error) { await file.close(); throw error }
  }

  /**
   * List only archives whose staged size and SHA-256 match the manifest.
   * @returns Public release metadata and fixed authenticated download paths.
   */
  async catalog(): Promise<{ releases: Array<CompanionRelease & { href: string }>; unavailable: string[] }> {
    const releases: Array<CompanionRelease & { href: string }> = []
    const unavailable: string[] = []
    for (const item of await this.manifest()) {
      try {
        const file = await this.verifiedFile(item)
        await file.close()
        releases.push({ ...item, href: `${PREFIX}/${item.id}` })
      } catch { unavailable.push(item.id) }
    }
    return { releases, unavailable }
  }

  /**
   * Stream one fixed, verified archive without loading it into memory.
   * @param id - Platform id from a registered route, never a caller-controlled path.
   * @param signal - Download request cancellation lifetime.
   * @returns An attachment response or a bounded unavailable response.
   */
  async download(id: string, signal: AbortSignal): Promise<Response> {
    const item = (await this.manifest()).find(item => item.id === id)
    if (item === undefined) return Response.json({ error: 'RELEASE_UNAVAILABLE' }, { status: 404, headers })
    const file = await this.verifiedFile(item)
    if (signal.aborted || this.disposed) { await file.close(); throw new Error('DOWNLOAD_CANCELLED') }
    const stream = file.createReadStream({ start: 0, end: item.bytes - 1, autoClose: true })
    this.streams.add(stream)
    const cancel = () => { stream.destroy() }
    signal.addEventListener('abort', cancel, { once: true })
    stream.once('close', () => { this.streams.delete(stream); signal.removeEventListener('abort', cancel) })
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: { ...headers, 'Content-Type': item.filename.endsWith('.zip') ? 'application/zip' : 'application/gzip',
        'Content-Length': String(item.bytes), 'Content-Disposition': `attachment; filename="${item.filename}"`,
        'X-Archive-SHA256': item.sha256 },
    })
  }

  /** Stop active archive streams when the owning plugin is disposed. */
  dispose(): void { this.disposed = true; for (const stream of this.streams) stream.destroy(); this.streams.clear() }
}

/**
 * Register archive catalog and downloads behind the existing browser authentication boundary.
 * @param ctx - Host plugin scope owning authenticated routes.
 * @param directory - Trusted staging directory populated by the companion release script.
 */
export function registerCompanionDownloads(ctx: Context, directory: string): void {
  const downloads = new CompanionDownloads(directory)
  ctx.effect(() => () =>{  downloads.dispose() }, 'companion downloads lifetime')
  for (const id of [undefined, ...TARGETS]) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: id === undefined ? PREFIX : `${PREFIX}/${id}`, methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return id === undefined ? Response.json(await downloads.catalog(), { headers }) : await downloads.download(id, request.signal)
        } catch { return Response.json({ error: 'RELEASE_UNAVAILABLE' }, { status: 503, headers }) }
      },
    }), `companion download ${id ?? 'catalog'}`)
  }
}
