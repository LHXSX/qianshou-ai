/** Reviewed plugin metadata and explicitly gated archive transfer; neither grants install rights. */
import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export const PLUGIN_RELEASES_PATH = '/qianshou-market/releases'
const MAX_REGISTRY_BYTES = 1024 * 1024
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_ARTIFACT_BYTES = 1024 * 1024 * 1024
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const ARTIFACT_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/u
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const
const EXECUTORS = ['workflow', 'node', 'python', 'model'] as const
// Keep the release declaration within compute-core's capability-manifest permission vocabulary.
const PERMISSIONS = ['workspace.read', 'workspace.write', 'network.declared', 'model.local', 'gpu'] as const

export interface ApprovedPluginRelease {
  readonly pluginId: string
  readonly version: string
  readonly releaseId: string
  readonly title: string
  readonly summary: string
  readonly packageSha256: string
  readonly packageBytes: number
  readonly platforms: readonly (typeof PLATFORMS)[number][]
  readonly architectures: readonly (typeof ARCHITECTURES)[number][]
  readonly operations: readonly {
    readonly capabilityId: string
    readonly operationId: string
    readonly executorKind: (typeof EXECUTORS)[number]
    readonly inputSchemaSha256: string
    readonly outputSchemaSha256: string
    readonly permissions: readonly string[]
  }[]
  readonly publisher: { readonly id: string; readonly signature: string }
  readonly approval: {
    readonly reviewId: string
    readonly reviewedAt: number
    readonly operatorId: string
    readonly signature: string
  }
  /** The server verified only transport-archive bytes, not ZIP entries or an executable manifest. */
  readonly verificationScope: 'opaque-archive-bytes'
  /** Deliberately false until client-side verification, license and execution are implemented. */
  readonly installable: false
}

export interface PluginReleaseOptions {
  readonly registryPath?: string
  /** Directory of immutable `<packageSha256>.qspkg` files; transfer requires the preview bearer. */
  readonly artifactDir?: string
  /** Durable version pin; defaults to `${registryPath}.lock.json`. Keep this file in release backups. */
  readonly lockPath?: string
  /** Base64 SPKI DER Ed25519 keys. Private keys must stay outside the server. */
  readonly publisherKeys?: Readonly<Record<string, string>>
  readonly operatorKeys?: Readonly<Record<string, string>>
  /** Explicit private-preview bearer. Absence disables artifact retrieval; this is not a purchase license. */
  readonly artifactAccessToken?: string
  /** Short-lived account-license token verifier; the static preview bearer remains independent. */
  readonly authorizeLicensedArtifact?: (token: string, release: ApprovedPluginRelease) => Promise<boolean>
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function only(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key)) && fields.every(key => Object.hasOwn(value, key))
}

function string(value: unknown, max: number, pattern?: RegExp): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value)
    && (pattern === undefined || pattern.test(value)) ? value : null
}

function enumArray<T extends string>(value: unknown, values: readonly T[]): readonly T[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= values.length
    && value.every(item => typeof item === 'string' && values.includes(item as T))
    && new Set(value).size === value.length ? value as T[] : null
}

function signatureBytes(raw: unknown): string | null {
  const value = string(raw, 88, SIGNATURE)
  return value !== null && Buffer.from(value, 'base64').toString('base64') === value ? value : null
}

/** Stable signature bytes: publisher signs the release; operator signs release plus publisher proof. */
export function pluginReleasePayload(release: Omit<ApprovedPluginRelease, 'publisher' | 'approval' | 'verificationScope' | 'installable'>): string {
  return JSON.stringify({
    pluginId: release.pluginId, version: release.version, releaseId: release.releaseId,
    title: release.title, summary: release.summary, packageSha256: release.packageSha256,
    packageBytes: release.packageBytes, platforms: release.platforms, architectures: release.architectures,
    operations: release.operations.map(operation => ({
      capabilityId: operation.capabilityId, operationId: operation.operationId,
      executorKind: operation.executorKind, inputSchemaSha256: operation.inputSchemaSha256,
      outputSchemaSha256: operation.outputSchemaSha256, permissions: operation.permissions,
    })),
  })
}

export function pluginApprovalPayload(release: ApprovedPluginRelease): string {
  return JSON.stringify({
    release: JSON.parse(pluginReleasePayload(release)) as unknown,
    publisher: release.publisher,
    reviewId: release.approval.reviewId,
    reviewedAt: release.approval.reviewedAt,
    operatorId: release.approval.operatorId,
  })
}

function signedBy(payload: string, signature: string, key: string | undefined): boolean {
  if (key === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) return false
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    return publicKey.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64'))
  } catch { return false }
}

function approvedRelease(raw: unknown, options: PluginReleaseOptions): ApprovedPluginRelease | null {
  const item = object(raw)
  if (item === null || !only(item, [
    'pluginId', 'version', 'releaseId', 'title', 'summary', 'packageSha256', 'packageBytes',
    'platforms', 'architectures', 'operations', 'publisher', 'approval', 'installable',
  ]) || item.installable !== false) return null
  const pluginId = string(item.pluginId, 80, ID)
  const version = string(item.version, 40, VERSION)
  const releaseId = string(item.releaseId, 80, ID)
  const title = string(item.title, 80)
  const summary = string(item.summary, 400)
  const packageSha256 = string(item.packageSha256, 64, SHA256)
  const packageBytes = item.packageBytes
  const platforms = enumArray(item.platforms, PLATFORMS)
  const architectures = enumArray(item.architectures, ARCHITECTURES)
  if (pluginId === null || version === null || releaseId === null || title === null || summary === null
    || packageSha256 === null || typeof packageBytes !== 'number' || !Number.isSafeInteger(packageBytes)
    || packageBytes < 1 || packageBytes > MAX_PACKAGE_BYTES || platforms === null || architectures === null
    || !Array.isArray(item.operations) || item.operations.length < 1 || item.operations.length > 16) return null
  const operations: ApprovedPluginRelease['operations'][number][] = []
  for (const rawOperation of item.operations) {
    const operation = object(rawOperation)
    if (operation === null || !only(operation, [
      'capabilityId', 'operationId', 'executorKind', 'inputSchemaSha256', 'outputSchemaSha256', 'permissions',
    ])) return null
    const capabilityId = string(operation.capabilityId, 80, OPERATION_ID)
    const operationId = string(operation.operationId, 80, OPERATION_ID)
    const executorKind = string(operation.executorKind, 20)
    const inputSchemaSha256 = string(operation.inputSchemaSha256, 64, SHA256)
    const outputSchemaSha256 = string(operation.outputSchemaSha256, 64, SHA256)
    if (capabilityId === null || operationId === null || executorKind === null
      || !EXECUTORS.includes(executorKind as typeof EXECUTORS[number]) || inputSchemaSha256 === null
      || outputSchemaSha256 === null || !Array.isArray(operation.permissions)
      || operation.permissions.length > PERMISSIONS.length
      || operation.permissions.some(value => typeof value !== 'string' || !PERMISSIONS.includes(value as typeof PERMISSIONS[number]))
      || new Set(operation.permissions).size !== operation.permissions.length
      || operations.some(previous => previous.capabilityId === capabilityId && previous.operationId === operationId)) return null
    operations.push({ capabilityId, operationId, executorKind: executorKind as typeof EXECUTORS[number],
      inputSchemaSha256, outputSchemaSha256, permissions: operation.permissions as string[] })
  }
  const publisher = object(item.publisher)
  const approval = object(item.approval)
  if (publisher === null || !only(publisher, ['id', 'signature'])
    || approval === null || !only(approval, ['reviewId', 'reviewedAt', 'operatorId', 'signature'])) return null
  const publisherId = string(publisher.id, 80, ID)
  const publisherSignature = signatureBytes(publisher.signature)
  const reviewId = string(approval.reviewId, 80, ID)
  const reviewedAt = approval.reviewedAt
  const operatorId = string(approval.operatorId, 80, ID)
  const operatorSignature = signatureBytes(approval.signature)
  if (publisherId === null || publisherSignature === null || reviewId === null || operatorId === null
    || operatorSignature === null || typeof reviewedAt !== 'number' || !Number.isSafeInteger(reviewedAt)
    || reviewedAt < 1) return null
  const release: ApprovedPluginRelease = {
    pluginId, version, releaseId, title, summary, packageSha256, packageBytes,
    platforms, architectures, operations,
    publisher: { id: publisherId, signature: publisherSignature },
    approval: { reviewId, reviewedAt, operatorId, signature: operatorSignature },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  const publisherKey = Object.hasOwn(options.publisherKeys ?? {}, publisherId) ? options.publisherKeys?.[publisherId] : undefined
  const operatorKey = Object.hasOwn(options.operatorKeys ?? {}, operatorId) ? options.operatorKeys?.[operatorId] : undefined
  if (publisherKey === undefined || operatorKey === undefined
    || Buffer.from(publisherKey, 'base64').equals(Buffer.from(operatorKey, 'base64'))
    || !signedBy(pluginReleasePayload(release), publisherSignature, publisherKey)
    || !signedBy(pluginApprovalPayload(release), operatorSignature, operatorKey)) return null
  return release
}

/** Verify both signatures and the complete signed operation declaration before publication.
 * @param raw - Untrusted candidate release metadata.
 * @param options - Trusted publisher and operator public keys.
 * @returns A normalized signed release, or null when any field or signature fails.
 */
export function validateApprovedPluginRelease(raw: unknown, options: PluginReleaseOptions): ApprovedPluginRelease | null {
  return approvedRelease(raw, options)
}

async function readBounded(path: string, privateFile = false): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_REGISTRY_BYTES
      || (info.mode & (privateFile ? 0o077 : 0o022)) !== 0) throw new Error('PLUGIN_RELEASE_REGISTRY_INVALID')
    const content = await handle.readFile()
    if (content.length > MAX_REGISTRY_BYTES) throw new Error('PLUGIN_RELEASE_REGISTRY_INVALID')
    return content
  } finally { await handle.close() }
}

function fileFingerprint(info: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint;
  readonly mtimeNs: bigint; readonly ctimeNs: bigint }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

async function verifyArtifact(dir: string, release: ApprovedPluginRelease, cache?: Map<string, string>): Promise<void> {
  const handle = await open(join(dir, `${release.packageSha256}.qspkg`), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.size !== BigInt(release.packageBytes)
      || (info.mode & 0o077n) !== 0n) throw new Error('PLUGIN_ARTIFACT_INVALID')
    const fingerprint = fileFingerprint(info)
    // A previously verified inode is safe to reuse while size, mtime and ctime stay unchanged.
    // The first read and every filesystem change still rehashes the full archive bytes.
    if (cache?.get(release.packageSha256) === fingerprint) return
    const digest = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk)
    if (digest.digest('hex') !== release.packageSha256) throw new Error('PLUGIN_ARTIFACT_INVALID')
    if (fileFingerprint(await handle.stat({ bigint: true })) !== fingerprint) throw new Error('PLUGIN_ARTIFACT_CHANGED')
    cache?.set(release.packageSha256, fingerprint)
  } finally { await handle.close() }
}

/** Recheck the selected inode before streaming; the PC also verifies every received byte. */
async function serveArtifact(response: ServerResponse, dir: string, release: ApprovedPluginRelease): Promise<void> {
  const handle = await open(join(dir, `${release.packageSha256}.qspkg`), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(release.packageBytes) || (before.mode & 0o077n) !== 0n) {
      throw new Error('PLUGIN_ARTIFACT_INVALID')
    }
    const fingerprint = fileFingerprint(before)
    const digest = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk)
    if (digest.digest('hex') !== release.packageSha256
      || fileFingerprint(await handle.stat({ bigint: true })) !== fingerprint) throw new Error('PLUGIN_ARTIFACT_CHANGED')
    response.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': String(release.packageBytes),
      'x-qianshou-package-sha256': release.packageSha256,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    })
    await pipeline(handle.createReadStream({ start: 0, end: release.packageBytes - 1, autoClose: false }), response)
  } finally { await handle.close() }
}

function previewAuthorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return false
  const supplied = request.headers.authorization
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return false
  const left = createHash('sha256').update(supplied.slice(7)).digest()
  const right = createHash('sha256').update(token).digest()
  return timingSafeEqual(left, right)
}

/** A single bad signature, missing archive, or duplicate version rejects the entire registry. */
async function readApprovedPluginReleasesCached(options: PluginReleaseOptions, artifactCache?: Map<string, string>): Promise<readonly ApprovedPluginRelease[]> {
  if (options.registryPath === undefined || options.registryPath === '') return []
  if (options.artifactDir === undefined || !isAbsolute(options.registryPath) || !isAbsolute(options.artifactDir)) {
    throw new Error('PLUGIN_RELEASE_PATH_INVALID')
  }
  let document: unknown
  try { document = JSON.parse((await readBounded(options.registryPath)).toString('utf8')) as unknown }
  catch { throw new Error('PLUGIN_RELEASE_REGISTRY_INVALID') }
  const parsed = object(document)
  if (parsed === null || !only(parsed, ['version', 'releases']) || parsed.version !== 1
    || !Array.isArray(parsed.releases) || parsed.releases.length > 100) throw new Error('PLUGIN_RELEASE_REGISTRY_INVALID')
  const releases: ApprovedPluginRelease[] = []
  const versionKeys = new Set<string>()
  const releaseIds = new Set<string>()
  let totalArtifactBytes = 0
  for (const rawRelease of parsed.releases) {
    const release = approvedRelease(rawRelease, options)
    if (release === null) throw new Error('PLUGIN_RELEASE_REGISTRY_INVALID')
    const key = `${release.pluginId}@${release.version}`
    if (versionKeys.has(key) || releaseIds.has(release.releaseId)) throw new Error('PLUGIN_RELEASE_REGISTRY_INVALID')
    versionKeys.add(key)
    releaseIds.add(release.releaseId)
    totalArtifactBytes += release.packageBytes
    if (totalArtifactBytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error('PLUGIN_ARTIFACT_TOTAL_EXCEEDED')
    releases.push(release)
  }
  const directory = await lstat(options.artifactDir)
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('PLUGIN_ARTIFACT_DIR_INVALID')
  for (const release of releases) await verifyArtifact(options.artifactDir, release, artifactCache)
  return releases
}

/** Direct callers always verify archive bytes; only the HTTP route owns a stat-bound cache. */
export async function readApprovedPluginReleases(options: PluginReleaseOptions): Promise<readonly ApprovedPluginRelease[]> {
  return await readApprovedPluginReleasesCached(options)
}

/** Read signed archives and enforce the durable version pin before granting a new license.
 * @param options - Trusted release registry, artifacts and signing keys.
 * @returns All verified releases in the pinned registry.
 */
export async function readPinnedApprovedPluginReleases(options: PluginReleaseOptions): Promise<readonly ApprovedPluginRelease[]> {
  const releases = await readApprovedPluginReleasesCached(options)
  if (options.registryPath !== undefined && options.registryPath !== '') {
    await pinReleaseVersions(options.lockPath ?? `${options.registryPath}.lock.json`, releases)
  }
  return releases
}

/** An already observed version cannot disappear or change while this server is running. */
export function assertAppendOnlyReleases(previous: readonly ApprovedPluginRelease[], next: readonly ApprovedPluginRelease[]): void {
  const byVersion = new Map(next.map(release => [`${release.pluginId}@${release.version}`, release] as const))
  for (const release of previous) {
    const current = byVersion.get(`${release.pluginId}@${release.version}`)
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(release)) throw new Error('PLUGIN_RELEASE_VERSION_CHANGED')
  }
}

interface VersionLock { readonly version: 1; readonly releases: readonly {
  readonly pluginId: string; readonly pluginVersion: string; readonly fingerprint: string
}[] }

function releaseFingerprint(release: ApprovedPluginRelease): string {
  return createHash('sha256').update(JSON.stringify(release)).digest('hex')
}

async function readVersionLock(path: string): Promise<VersionLock | null> {
  let raw: Buffer
  try { raw = await readBounded(path, true) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return null
    throw new Error('PLUGIN_RELEASE_LOCK_INVALID')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw.toString('utf8')) as unknown }
  catch { throw new Error('PLUGIN_RELEASE_LOCK_INVALID') }
  const document = object(parsed)
  if (document === null || !only(document, ['version', 'releases']) || document.version !== 1
    || !Array.isArray(document.releases) || document.releases.length > 100) throw new Error('PLUGIN_RELEASE_LOCK_INVALID')
  const keys = new Set<string>()
  const releases: VersionLock['releases'][number][] = []
  for (const rawRelease of document.releases) {
    const release = object(rawRelease)
    if (release === null || !only(release, ['pluginId', 'pluginVersion', 'fingerprint'])) throw new Error('PLUGIN_RELEASE_LOCK_INVALID')
    const pluginId = string(release.pluginId, 80, ID)
    const pluginVersion = string(release.pluginVersion, 40, VERSION)
    const fingerprint = string(release.fingerprint, 64, SHA256)
    if (pluginId === null || pluginVersion === null || fingerprint === null) throw new Error('PLUGIN_RELEASE_LOCK_INVALID')
    const key = `${pluginId}@${pluginVersion}`
    if (keys.has(key)) throw new Error('PLUGIN_RELEASE_LOCK_INVALID')
    keys.add(key)
    releases.push({ pluginId, pluginVersion, fingerprint })
  }
  return { version: 1, releases }
}

async function saveVersionLock(path: string, lock: VersionLock): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(JSON.stringify(lock))
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** Persist observed versions so a process restart cannot silently replace or remove them. */
async function pinReleaseVersions(path: string, releases: readonly ApprovedPluginRelease[]): Promise<void> {
  const previous = await readVersionLock(path)
  const current = new Map(releases.map(release => [`${release.pluginId}@${release.version}`, release] as const))
  for (const pin of previous?.releases ?? []) {
    const release = current.get(`${pin.pluginId}@${pin.pluginVersion}`)
    if (release === undefined || releaseFingerprint(release) !== pin.fingerprint) throw new Error('PLUGIN_RELEASE_VERSION_CHANGED')
  }
  if (previous?.releases.length === releases.length) return
  await saveVersionLock(path, { version: 1, releases: releases.map(release => ({
    pluginId: release.pluginId, pluginVersion: release.version, fingerprint: releaseFingerprint(release),
  })) })
}

export function createPluginReleasesRoute(options: PluginReleaseOptions): {
  readonly kind: 'exact'
  readonly path: typeof PLUGIN_RELEASES_PATH
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
} {
  if (options.registryPath !== undefined && options.registryPath !== ''
    && (options.artifactDir === undefined || !isAbsolute(options.registryPath) || !isAbsolute(options.artifactDir)
      || (options.lockPath !== undefined && !isAbsolute(options.lockPath)))) {
    throw new Error('PLUGIN_RELEASE_PATH_INVALID')
  }
  if (options.artifactAccessToken !== undefined && !ARTIFACT_TOKEN.test(options.artifactAccessToken)) {
    throw new Error('PLUGIN_ARTIFACT_TOKEN_INVALID')
  }
  let prior: readonly ApprovedPluginRelease[] = []
  let pending: Promise<void> = Promise.resolve()
  const artifactCache = new Map<string, string>()
  const loadReleases = async (): Promise<readonly ApprovedPluginRelease[]> => {
    const task = pending.then(async () => {
      const releases = await readApprovedPluginReleasesCached(options, artifactCache)
      assertAppendOnlyReleases(prior, releases)
      if (options.registryPath !== undefined && options.registryPath !== '') {
        await pinReleaseVersions(options.lockPath ?? `${options.registryPath}.lock.json`, releases)
      }
      prior = releases
      return releases
    })
    pending = task.then(() => undefined, () => undefined)
    return await task
  }
  return {
    kind: 'exact', path: PLUGIN_RELEASES_PATH,
    handler: async (request, response) => {
      const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' }
      if (request.method !== 'GET') {
        response.writeHead(405, { ...jsonHeaders, allow: 'GET' })
        response.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED' } }))
        return
      }
      let artifactId: string | null
      try {
        const url = new URL(request.url ?? '', 'http://localhost')
        const keys = [...url.searchParams.keys()]
        if (url.pathname !== PLUGIN_RELEASES_PATH || keys.some(key => key !== 'artifact')
          || keys.length > 1) throw new Error('PLUGIN_RELEASE_QUERY_INVALID')
        artifactId = url.searchParams.get('artifact')
        if (artifactId !== null && !ID.test(artifactId)) throw new Error('PLUGIN_RELEASE_QUERY_INVALID')
      } catch {
        response.writeHead(400, jsonHeaders)
        response.end(JSON.stringify({ error: { code: 'PLUGIN_RELEASE_QUERY_INVALID' } }))
        return
      }
      if (artifactId !== null && options.artifactAccessToken === undefined
        && options.authorizeLicensedArtifact === undefined) {
        response.writeHead(403, jsonHeaders)
        response.end(JSON.stringify({ error: { code: 'PLUGIN_ARTIFACT_FORBIDDEN' } }))
        return
      }
      try {
        // Serialize both paths so concurrent reads cannot race the durable version pin.
        const releases = await loadReleases()
        if (artifactId === null) {
          response.writeHead(200, jsonHeaders)
          response.end(JSON.stringify({ releases }))
          return
        }
        const release = releases.find(item => item.releaseId === artifactId)
        if (release === undefined) {
          response.writeHead(404, jsonHeaders)
          response.end(JSON.stringify({ error: { code: 'PLUGIN_ARTIFACT_NOT_FOUND' } }))
          return
        }
        const bearer = request.headers.authorization
        const token = typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : ''
        if (!previewAuthorized(request, options.artifactAccessToken)
          && (token === '' || !(await options.authorizeLicensedArtifact?.(token, release)))) {
          response.writeHead(403, jsonHeaders)
          response.end(JSON.stringify({ error: { code: 'PLUGIN_ARTIFACT_FORBIDDEN' } }))
          return
        }
        if (options.artifactDir === undefined) throw new Error('PLUGIN_ARTIFACT_DIR_INVALID')
        await serveArtifact(response, options.artifactDir, release)
      } catch {
        if (response.headersSent) response.destroy()
        else {
          response.writeHead(503, jsonHeaders)
          response.end(JSON.stringify({ error: { code: 'PLUGIN_RELEASES_UNAVAILABLE' } }))
        }
      }
    },
  }
}
