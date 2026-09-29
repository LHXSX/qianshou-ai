/** Buyer-side quarantine. No downloaded adapter is executed or activated here. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { inspectOrderProductSourceArchive } from './order-product-source-archive.ts'
import { readVerifiedOrderAdapterSource, type VerifiedOrderAdapterSource } from './order-products-http.ts'
import { LEGACY_INVENTORY_ALGORITHM, validateOrderSourceInventory } from './order-source-inventory.ts'
import { CatalogFailure } from './registry.ts'
import { trustedOrderArchiveHostname } from './order-cos-host.ts'
import type { OrderAdapterSourceStage } from './types.ts'

const MAX_ARCHIVE = 16 * 1024 * 1024
const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/u

function inside(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}

/** First install creates its private home before staging; a symlink leaf is never trusted. */
export async function ensureOrderInstallHome(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CatalogFailure('order-install-not-ready')
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('unsafe install home')
    return await realpath(path)
  } catch { throw new CatalogFailure('order-install-not-ready') }
}

function stageResult(source: VerifiedOrderAdapterSource): OrderAdapterSourceStage {
  return { productId: source.check.productId, entitlementId: source.check.entitlementId,
    archiveVersionId: source.check.archiveVersionId, archiveDigest: source.check.archiveDigest,
    artifactDigest: source.artifactDigest, sourceVerified: true, deviceInstalled: false,
    chatAvailable: false, orderAvailable: false,
    nextStep: 'independent-device-install-attestation-required' }
}

async function existingMatches(target: string, source: VerifiedOrderAdapterSource): Promise<boolean> {
  try {
    const stat = await lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    const receipt = await lstat(join(target, 'source-stage.json'))
    if (!receipt.isFile() || receipt.isSymbolicLink() || receipt.size < 2 || receipt.size > 4096) return false
    const metadata = JSON.parse(await readFile(join(target, 'source-stage.json'), 'utf8')) as Record<string, unknown>
    if (metadata.schema !== 'qianshou.order-adapter-source-stage.v1'
      || metadata.entitlementId !== source.check.entitlementId
      || metadata.archiveDigest !== source.check.archiveDigest
      || metadata.archiveVersionId !== source.check.archiveVersionId
      || metadata.artifactDigest !== source.artifactDigest
      || metadata.reviewedSellerRuntimeDigest !== source.reviewedSellerRuntimeDigest
      || (metadata.inventoryAlgorithm !== source.inventoryAlgorithm
        && !(source.inventoryAlgorithm === LEGACY_INVENTORY_ALGORITHM
          && metadata.inventoryAlgorithm === undefined))) return false
    const expected = new Map<string, Set<string>>([['', new Set(['source-stage.json'])]])
    for (const row of source.files) {
      const segments = row.path.split('/')
      for (let index = 0; index < segments.length; index += 1) {
        const parent = segments.slice(0, index).join('/')
        expected.get(parent)?.add(segments[index]!)
        if (index < segments.length - 1) {
          const directory = segments.slice(0, index + 1).join('/')
          if (!expected.has(directory)) expected.set(directory, new Set())
        }
      }
    }
    for (const [directory, entries] of expected) {
      const path = join(target, directory)
      const item = await lstat(path)
      if (!item.isDirectory() || item.isSymbolicLink()) return false
      const found = await readdir(path)
      if (found.length !== entries.size || found.some(name => !entries.has(name))) return false
    }
    const hash = createHash('sha256')
    for (const row of source.files) {
      const path = join(target, row.path)
      const file = await lstat(path)
      if (!file.isFile() || file.isSymbolicLink() || file.size !== row.sizeBytes) return false
      const data = await readFile(path)
      if (data.length !== row.sizeBytes || createHash('sha256').update(data).digest('hex') !== row.sha256) return false
      hash.update(row.path).update('\0').update(String(data.length)).update('\0').update(data)
    }
    return `sha256:${hash.digest('hex')}` === source.artifactDigest
  } catch { return false }
}

async function ensureQuarantineDirectory(parent: string, name: string, home: string): Promise<string> {
  const child = join(parent, name)
  try { await mkdir(child, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const entry = await lstat(child)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CatalogFailure('order-install-not-ready')
  const resolved = await realpath(child)
  if (!inside(home, resolved)) throw new CatalogFailure('order-install-not-ready')
  return resolved
}

function archiveEndpoint(source: VerifiedOrderAdapterSource, trustedArchiveHostname: string): URL {
  const url = new URL(source.downloadUrl)
  const hostname = trustedOrderArchiveHostname(trustedArchiveHostname, source.archiveBucket)
  if (!hostname || !/^[a-z0-9.-]{1,253}$/u.test(hostname)
    || isIP(hostname) !== 0 || url.protocol !== 'https:'
    || url.hostname !== hostname || isIP(url.hostname) !== 0
    || url.searchParams.getAll('versionId').length !== 1
    || url.searchParams.get('versionId') !== source.check.archiveVersionId
    || Date.now() / 1000 >= source.expiresAt) throw new CatalogFailure('order-install-not-ready')
  return url
}

/**
 * Read only the pinned COS object version within the existing archive byte limit.
 * @param source - Source inventory already verified against owner-accessible signed manifests.
 * @param trustedArchiveHostname - Host-configured COS authority; no client override.
 * @param send - HTTP transport; credentials are never sent to storage.
 * @returns Archive bytes in memory; no staging, installation or execution.
 */
export async function downloadArchive(source: VerifiedOrderAdapterSource, trustedArchiveHostname: string,
  send: typeof fetch): Promise<Buffer> {
  const url = archiveEndpoint(source, trustedArchiveHostname)
  let response: Response
  try {
    response = await send(url, { method: 'GET', headers: { accept: 'application/zip' },
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30_000) })
  } catch { throw new CatalogFailure('order-install-download-failed') }
  if (!response.ok || !response.body) {
    try { await response.body?.cancel() } catch { /* No error body is exposed. */ }
    throw new CatalogFailure('order-install-download-failed')
  }
  const declaredSize = response.headers.get('content-length')
  if (declaredSize !== null && Number(declaredSize) !== source.check.archiveSizeBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new CatalogFailure('order-install-download-failed')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_ARCHIVE || total > source.check.archiveSizeBytes) {
        throw new CatalogFailure('order-install-download-failed')
      }
      chunks.push(part.value)
    }
  } catch { throw new CatalogFailure('order-install-download-failed') }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  if (total !== source.check.archiveSizeBytes) throw new CatalogFailure('order-install-download-failed')
  return Buffer.concat(chunks, total)
}

/**
 * Fetch exactly the independently reviewed object version and quarantine its signed source files.
 * No entitlement, archive verification, or local file can authorize runtime execution or seller settlement.
 */
export async function stageVerifiedOrderAdapterSource(source: VerifiedOrderAdapterSource, input: {
  trustedArchiveHostname: string; home: string; fetch?: typeof fetch
}): Promise<OrderAdapterSourceStage> {
  if (!isAbsolute(input.home)) throw new CatalogFailure('order-install-not-ready')
  validateOrderSourceInventory(source.inventoryAlgorithm, source.files)
  if (!SOURCE_ID.test(source.check.productId) || !SOURCE_ID.test(source.check.entitlementId)) {
    throw new CatalogFailure('order-install-manifest-invalid')
  }
  const send = input.fetch ?? fetch
  archiveEndpoint(source, input.trustedArchiveHostname)
  const home = await ensureOrderInstallHome(input.home)
  let actualBase = home
  for (const component of ['qianshou', 'order-adapter-quarantine',
    source.check.productId, source.check.entitlementId]) {
    actualBase = await ensureQuarantineDirectory(actualBase, component, home)
  }
  const versionKey = createHash('sha256').update(source.check.archiveVersionId).digest('hex')
  const target = join(actualBase, versionKey)
  if (await existingMatches(target, source)) return stageResult(source)
  try { await lstat(target); throw new CatalogFailure('order-install-not-ready') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const bytes = await downloadArchive(source, input.trustedArchiveHostname, send)
  const inspected = inspectOrderProductSourceArchive(bytes, source)
  const staging = await mkdtemp(join(actualBase, '.source-'))
  try {
    for (const [name, data] of inspected.files) {
      await mkdir(join(staging, dirname(name)), { recursive: true, mode: 0o700 })
      await writeFile(join(staging, name), data, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(staging, 'source-stage.json'), JSON.stringify({
      schema: 'qianshou.order-adapter-source-stage.v1',
      entitlementId: source.check.entitlementId, productId: source.check.productId,
      publicationId: source.check.publicationId,
      archiveDigest: source.check.archiveDigest,
      archiveVersionId: source.check.archiveVersionId,
      artifactDigest: source.artifactDigest,
      inventoryAlgorithm: source.inventoryAlgorithm,
      reviewedSellerRuntimeDigest: source.reviewedSellerRuntimeDigest,
      status: 'source-staged-awaiting-independent-install',
    }), { flag: 'wx', mode: 0o600 })
    await rename(staging, target)
    return stageResult(source)
  } catch (error) {
    if (await existingMatches(target, source)) return stageResult(source)
    throw error
  } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined) }
}

/** Manifest verification is mandatory before any network fetch or local write. */
export async function stageOrderAdapterProductSource(input: {
  origin: string; productId: string; token: string; trustedPackageIssuerKeys: Record<string, string>
  trustedArchiveHostname: string; home: string; fetch?: typeof fetch
}): Promise<OrderAdapterSourceStage> {
  const source = await readVerifiedOrderAdapterSource(input)
  return stageVerifiedOrderAdapterSource(source, input)
}
