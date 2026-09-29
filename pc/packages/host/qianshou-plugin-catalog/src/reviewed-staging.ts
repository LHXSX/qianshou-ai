/** Host-only private staging for one dual-signed Guangzhou release. No install side effects. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { marketApiUrl } from './market.ts'
import { fetchSignedReleases, type SignedRelease } from './release-preview.ts'
import { inspectReviewedArchive, type ReviewedArchiveEntry } from './reviewed-archive.ts'

const RELEASE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/u

/** Operator-owned input for one private, test-token-backed artifact fetch. */
export interface ReviewedStageRequest {
  /** Operator-configured Guangzhou origin, never a user-supplied URL. */
  readonly apiBaseUrl: string
  readonly releaseId: string
  readonly publisherKeys: Readonly<Record<string, string>>
  readonly operatorKeys: Readonly<Record<string, string>>
  /** Internal test-only Bearer token; never expose through Remote or PC UI. */
  readonly artifactAccessToken: string
  /** Existing absolute 0700 private directory, separate from install/declaration directories. */
  readonly stagingDir: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Verified transport candidate; it conveys no installation or execution approval. */
export interface ReviewedStageResult {
  readonly archivePath: string
  readonly releaseId: string
  readonly pluginId: string
  readonly version: string
  readonly packageSha256: string
  readonly packageBytes: number
  /** Exact double-signed declaration retained in Host memory; never projected to a client. */
  readonly signedRelease: SignedRelease
  readonly entries: readonly ReviewedArchiveEntry[]
  /** The archive remains a private candidate, never an installed capability. */
  readonly installable: false
}

function invalid(): never { throw new Error('QIANSHOU_REVIEWED_STAGE_INVALID') }

/** Fetch fresh signed metadata, stream one immutable archive, then inspect its ZIP entries.
 * @param request - Host-owned release identity, trust roots, token and private staging directory.
 * @returns A private validated archive candidate with installation still disabled.
 */
export async function stageReviewedPluginArchive(request: ReviewedStageRequest): Promise<ReviewedStageResult> {
  if (!RELEASE_ID.test(request.releaseId) || request.releaseId.length > 80
    || !ACCESS_TOKEN.test(request.artifactAccessToken)
    || !isAbsolute(request.stagingDir)) invalid()
  const timeoutMs = request.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) invalid()
  const base = marketApiUrl(request.apiBaseUrl)
  const dirStat = await lstat(request.stagingDir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0) invalid()
  const directory = await realpath(request.stagingDir)
  const realStat = await lstat(directory)
  if (!realStat.isDirectory() || realStat.isSymbolicLink() || (realStat.mode & 0o077) !== 0
    || realStat.dev !== dirStat.dev || realStat.ino !== dirStat.ino) invalid()
  const signal = AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
  const releases = await fetchSignedReleases(base, signal, request.publisherKeys, request.operatorKeys)
  const release = releases.find(item => item.releaseId === request.releaseId)
  if (release === undefined || release.installable !== false) invalid()
  const url = new URL('/qianshou-market/releases', base)
  url.searchParams.set('artifact', request.releaseId)
  const response = await fetch(url, {
    method: 'GET', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${request.artifactAccessToken}` },
  })
  if (response.status !== 200 || response.body === null
    || response.headers.get('content-type') !== 'application/octet-stream'
    || response.headers.get('content-length') !== String(release.packageBytes)
    || response.headers.get('x-qianshou-package-sha256') !== release.packageSha256
    || response.headers.get('content-encoding') !== null) {
    await response.body?.cancel().catch(() => undefined)
    invalid()
  }
  const archivePath = join(directory, `reviewed-${randomUUID()}.qspkg`)
  const reader = response.body.getReader()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let keep = false
  try {
    handle = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const digest = createHash('sha256')
    let received = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      received += next.value.byteLength
      if (received > release.packageBytes) invalid()
      digest.update(next.value)
      const bytes = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset)
        if (result.bytesWritten === 0) invalid()
        offset += result.bytesWritten
      }
    }
    if (received !== release.packageBytes || digest.digest('hex') !== release.packageSha256) invalid()
    await handle.sync()
    await handle.close()
    const entries = await inspectReviewedArchive(archivePath, release.packageBytes, signal)
    keep = true
    return { archivePath, releaseId: release.releaseId, pluginId: release.pluginId,
      version: release.version, packageSha256: release.packageSha256,
      packageBytes: release.packageBytes, signedRelease: release, entries, installable: false }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await handle?.close().catch(() => undefined)
    if (!keep) await unlink(archivePath).catch(() => undefined)
  }
}
