/** Account-bound free claims and short-lived, release-scoped archive download tokens. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Principal } from './admin-routes.ts'
import { readPinnedApprovedPluginReleases, type ApprovedPluginRelease, type PluginReleaseOptions,
  PLUGIN_RELEASES_PATH } from './plugin-releases.ts'
import { matchesSeedReleaseDeclaration, verifySeedPluginPackage } from './plugin-seed-package.ts'
import { PLUGIN_LICENSE_BEARER_PATH } from './plugin-license-bearer.ts'

/** Account-authenticated free license carrier path. */
export const PLUGIN_LICENSE_PATH = '/api/qianshou/ai/plugins/license'
const MAX_LEDGER_BYTES = 1024 * 1024
const TOKEN_LIFETIME_MS = 5 * 60 * 1000
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const SHA256 = /^[0-9a-f]{64}$/u

interface Claim {
  readonly licenseId: string
  readonly accountId: string
  readonly releaseId: string
  readonly packageSha256: string
  readonly claimedAt: number
}

interface Grant {
  readonly releaseId: string
  readonly packageSha256: string
  readonly accountId: string
  readonly expiresAt: number
}

/** Trusted release source, server identity and private persistence for free claims. */
export interface PluginFreeLicenseOptions {
  /** Private 0600 JSON ledger in a 0700 directory. Unset disables claiming. */
  readonly ledgerPath?: string
  readonly releaseOptions: PluginReleaseOptions
  /** Explicit free catalog policy. No release is free by default. */
  readonly freeReleaseIds?: readonly string[]
  readonly authenticate: (request: Request) => Promise<Principal | null>
  /** Distinguish failed online verification from an expired or absent account session. */
  readonly verifyUnavailable?: (request: Request) => boolean
  readonly now?: () => number
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}
function validClaim(raw: unknown): Claim | null {
  const value = object(raw)
  if (value === null || !only(value, ['licenseId', 'accountId', 'releaseId', 'packageSha256', 'claimedAt'])
    || typeof value['licenseId'] !== 'string' || !/^[0-9a-f-]{36}$/u.test(value['licenseId'])
    || typeof value['accountId'] !== 'string' || value['accountId'].length < 1 || value['accountId'].length > 128
    || typeof value['releaseId'] !== 'string' || !ID.test(value['releaseId'])
    || typeof value['packageSha256'] !== 'string' || !SHA256.test(value['packageSha256'])
    || typeof value['claimedAt'] !== 'number' || !Number.isSafeInteger(value['claimedAt']) || value['claimedAt'] < 1) return null
  return value as unknown as Claim
}

async function readClaims(path: string): Promise<readonly Claim[]> {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return []
    throw new Error('PLUGIN_LICENSE_LEDGER_INVALID')
  }
  let raw: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_LEDGER_BYTES || (info.mode & 0o077) !== 0) throw new Error('PLUGIN_LICENSE_LEDGER_INVALID')
    raw = await handle.readFile()
  } finally { await handle.close() }
  let decoded: unknown
  try { decoded = JSON.parse(raw.toString('utf8')) as unknown }
  catch { throw new Error('PLUGIN_LICENSE_LEDGER_INVALID') }
  const file = object(decoded)
  if (file === null || !only(file, ['version', 'claims']) || file['version'] !== 1
    || !Array.isArray(file['claims']) || file['claims'].length > 5000) throw new Error('PLUGIN_LICENSE_LEDGER_INVALID')
  const claims: Claim[] = []
  const ids = new Set<string>()
  const accounts = new Set<string>()
  for (const rawClaim of file['claims']) {
    const claim = validClaim(rawClaim)
    if (claim === null || ids.has(claim.licenseId)
      || accounts.has(`${claim.accountId}\u0000${claim.releaseId}`)) throw new Error('PLUGIN_LICENSE_LEDGER_INVALID')
    ids.add(claim.licenseId)
    accounts.add(`${claim.accountId}\u0000${claim.releaseId}`)
    claims.push(claim)
  }
  return claims
}

async function writeClaims(path: string, claims: readonly Claim[]): Promise<void> {
  const directory = await lstat(dirname(path))
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('PLUGIN_LICENSE_DIR_INVALID')
  const content = Buffer.from(JSON.stringify({ version: 1, claims }))
  if (content.length > MAX_LEDGER_BYTES) throw new Error('PLUGIN_LICENSE_LEDGER_FULL')
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** Keep all free grants on the server; archive retrieval never trusts caller-supplied account IDs.
 * @param options - Trusted signing keys, free policy, private ledger and account verifier.
 * @returns Authenticated carrier handler and release-scoped artifact bearer verifier.
 */
export function createPluginFreeLicenseService(options: PluginFreeLicenseOptions): {
  readonly handler: (request: Request) => Promise<Response>
  readonly authorizeArtifact: (token: string, release: ApprovedPluginRelease) => Promise<boolean>
} {
  if (options.ledgerPath !== undefined && !isAbsolute(options.ledgerPath)) throw new Error('PLUGIN_LICENSE_PATH_INVALID')
  const allow = new Set(options.freeReleaseIds ?? [])
  if ([...allow].some(value => !ID.test(value))) throw new Error('PLUGIN_FREE_RELEASE_ID_INVALID')
  const now = options.now ?? Date.now
  const grants = new Map<string, Grant>()
  let pending: Promise<void> = Promise.resolve()
  const authorizeArtifact = async (token: string, release: ApprovedPluginRelease): Promise<boolean> => {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return false
    const digest = createHash('sha256').update(token).digest('hex')
    const grant = grants.get(digest)
    if (grant === undefined) return false
    if (grant.expiresAt <= now()) {
      grants.delete(digest)
      return false
    }
    if (grant.releaseId !== release.releaseId || grant.packageSha256 !== release.packageSha256
      || options.ledgerPath === undefined) return false
    try {
      const claims = await readClaims(options.ledgerPath)
      return claims.some(claim => claim.accountId === grant.accountId
        && claim.releaseId === release.releaseId && claim.packageSha256 === release.packageSha256)
    } catch { return false }
  }
  const handler = async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
    if (options.ledgerPath === undefined || options.releaseOptions.registryPath === undefined
      || options.releaseOptions.artifactDir === undefined) return json({ ok: false, code: 'PLUGIN_LICENSE_UNAVAILABLE' }, 503)
    let principal: Principal | null
    try { principal = await options.authenticate(request) }
    catch { return json({ ok: false, code: 'ACCOUNT_VERIFICATION_UNAVAILABLE' }, 503) }
    if (principal === null) return options.verifyUnavailable?.(request)
      ? json({ ok: false, code: 'ACCOUNT_VERIFICATION_UNAVAILABLE' }, 503)
      : json({ ok: false, code: 'LOGIN_REQUIRED' }, 401)
    let body: unknown
    try {
      const raw = await request.text()
      if (Buffer.byteLength(raw) > 4096) return json({ ok: false, code: 'BAD_REQUEST' }, 400)
      body = JSON.parse(raw) as unknown
    } catch { return json({ ok: false, code: 'BAD_REQUEST' }, 400) }
    const input = object(body)
    if (new URL(request.url).pathname === PLUGIN_LICENSE_BEARER_PATH
      && input !== null && only(input, ['action']) && input['action'] === 'check') {
      return json({ ok: true, accountId: principal.accountId, authMode: 'bearer-request-bound' })
    }
    if (input === null || !only(input, ['action', 'releaseId']) || input['action'] !== 'claim'
      || typeof input['releaseId'] !== 'string' || !ID.test(input['releaseId'])) {
      return json({ ok: false, code: 'BAD_REQUEST' }, 400)
    }
    const releaseId = input['releaseId']
    if (!allow.has(releaseId)) return json({ ok: false, code: 'NOT_FREE' }, 403)
    const work = pending.then(async (): Promise<Response> => {
      const releases = await readPinnedApprovedPluginReleases(options.releaseOptions)
      const release = releases.find(value => value.releaseId === releaseId)
      if (release === undefined) return json({ ok: false, code: 'PLUGIN_RELEASE_NOT_FOUND' }, 404)
      if (release.packageBytes > 2 * 1024 * 1024) throw new Error('PLUGIN_FREE_PACKAGE_INVALID')
      const artifact = await open(join(options.releaseOptions.artifactDir!, `${release.packageSha256}.qspkg`),
        constants.O_RDONLY | constants.O_NOFOLLOW)
      let archive: Buffer
      try {
        const info = await artifact.stat()
        if (!info.isFile() || info.size !== release.packageBytes) throw new Error('PLUGIN_FREE_PACKAGE_INVALID')
        archive = await artifact.readFile()
      } finally { await artifact.close() }
      if (!matchesSeedReleaseDeclaration(verifySeedPluginPackage(archive), release)) {
        throw new Error('PLUGIN_FREE_PACKAGE_INVALID')
      }
      const directory = await lstat(dirname(options.ledgerPath!))
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('PLUGIN_LICENSE_DIR_INVALID')
      const writer = `${options.ledgerPath!}.writer.lock`
      const lock = await open(writer, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      let claim: Claim
      try {
        const claims = await readClaims(options.ledgerPath!)
        const existing = claims.find(value => value.accountId === principal.accountId && value.releaseId === releaseId)
        if (existing !== undefined && existing.packageSha256 !== release.packageSha256) {
          throw new Error('PLUGIN_LICENSE_RELEASE_CHANGED')
        }
        claim = existing ?? { licenseId: randomUUID(), accountId: principal.accountId, releaseId,
          packageSha256: release.packageSha256, claimedAt: now() }
        if (existing === undefined) await writeClaims(options.ledgerPath!, [...claims, claim])
      } finally { await lock.close(); await unlink(writer) }
      for (const [key, grant] of grants) if (grant.expiresAt <= now()) grants.delete(key)
      const token = randomBytes(48).toString('base64url')
      const expiresAt = now() + TOKEN_LIFETIME_MS
      grants.set(createHash('sha256').update(token).digest('hex'), {
        releaseId, packageSha256: release.packageSha256, accountId: principal.accountId, expiresAt,
      })
      return json({ ok: true, releaseId, pluginId: release.pluginId, version: release.version,
        packageSha256: release.packageSha256,
        license: { licenseId: claim.licenseId, kind: 'free', accountId: claim.accountId, claimedAt: claim.claimedAt },
        download: { url: `${PLUGIN_RELEASES_PATH}?artifact=${encodeURIComponent(releaseId)}`, token, expiresAt },
      })
    })
    pending = work.then(() => undefined, () => undefined)
    try { return await work }
    catch { return json({ ok: false, code: 'PLUGIN_LICENSE_UNAVAILABLE' }, 503) }
  }
  return { handler, authorizeArtifact }
}
