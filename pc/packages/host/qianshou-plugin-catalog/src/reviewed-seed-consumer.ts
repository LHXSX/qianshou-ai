/** Account-bound Guangzhou free claim and private staging for the exact official CSV seed.
 *
 * This Host-only adapter never installs, activates, advertises or supplies a plugin. Its account
 * port must be backed by the existing Qianshou account service; no account id is sent in the
 * claim request and a missing port cannot become an anonymous or test-token download.
 */
import { unlink } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { marketApiUrl } from './market.ts'
import { CSV_SEED_IDENTITY, inspectOfficialCsvSeedArchive } from './official-seed-csv.ts'
import { approvalPayload, fetchSignedReleases, releasePayload, type SignedRelease } from './release-preview.ts'
import { stageReviewedPluginArchive } from './reviewed-staging.ts'

const CLAIM_RESPONSE_BYTES = 16 * 1024
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const LICENSE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const ACCESS_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/u
const MAX_TOKEN_LIFETIME_MS = 15 * 60 * 1000

/** Narrow projections of qianshouAccount.state() and the private accountSession access carrier. */
export interface ReviewedSeedAccountCarrier {
  readonly snapshot: () => Promise<{ phase: string; account: { id: string } | null }>
  readonly ensureAccessToken: () => Promise<string | null>
}

export interface ReviewedSeedAcquireRequest {
  /** Operator-configured Guangzhou origin, never a release-provided URL. */
  readonly apiBaseUrl: string
  readonly publisherKeys: Readonly<Record<string, string>>
  readonly operatorKeys: Readonly<Record<string, string>>
  /** Existing owner-only 0700 directory used only for temporary validated archives. */
  readonly stagingDir: string
  /** The active Host account carrier. Absent means the feature is unavailable. */
  readonly account?: ReviewedSeedAccountCarrier
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type ReviewedSeedLicenseRequest = Omit<ReviewedSeedAcquireRequest, 'stagingDir'>

/** A successful response must come from Guangzhou's separate request-bound Bearer route.
 * The browser Cookie route cannot be used as proof that this PC's token was checked.
 * @param request - Fixed market origin and the current account carrier.
 * @returns Whether a no-write check verified this request's account identity.
 */
export async function reviewedSeedClaimAuthChannel(
  request: Pick<ReviewedSeedLicenseRequest, 'apiBaseUrl' | 'account' | 'signal' | 'timeoutMs'>,
): Promise<'unverified' | 'verified'> {
  const carrier = request.account
  if (carrier === undefined) return 'unverified'
  const timeoutMs = request.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) invalid()
  const signal = AbortSignal.any([request.signal ?? new AbortController().signal,
    AbortSignal.timeout(timeoutMs)])
  try {
    const accountId = await currentAccount(carrier)
    const access = await carrier.ensureAccessToken()
    if (access === null || access.length < 16 || access.length > 8192
      || /[\u0000-\u001f\u007f]/u.test(access) || await currentAccount(carrier) !== accountId) invalid()
    const response = await fetch(new URL('/qianshou-market/license', marketApiUrl(request.apiBaseUrl)), {
      method: 'POST', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json',
        Accept: 'application/json' },
      body: JSON.stringify({ action: 'check' }),
    })
    if (response.status !== 200 || response.body === null
      || !/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '')
      || response.headers.get('content-encoding') !== null) {
      await response.body?.cancel().catch(() => undefined)
      return 'unverified'
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > CLAIM_RESPONSE_BYTES) invalid()
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
    if (body === null || !exact(body, ['ok', 'accountId', 'authMode'])
      || body.ok !== true || body.accountId !== accountId
      || body.authMode !== 'bearer-request-bound'
      || await currentAccount(carrier) !== accountId) return 'unverified'
    signal.throwIfAborted()
    return 'verified'
  } catch (error) {
    if (request.signal?.aborted) throw error
    return 'unverified'
  }
}

/** Current online claim, without a bearer token or installation side effect. */
export interface ReviewedSeedLicenseResult {
  readonly accountId: string
  readonly licenseId: string
  readonly releaseId: typeof CSV_SEED_IDENTITY.releaseId
  readonly pluginId: typeof CSV_SEED_IDENTITY.pluginId
  readonly version: typeof CSV_SEED_IDENTITY.version
  readonly packageSha256: typeof CSV_SEED_IDENTITY.packageSha256
  readonly checkedAt: number
}

/** A downloaded candidate tied to one verified free account claim; no install permission is implied. */
export interface ReviewedSeedAcquireResult {
  readonly archivePath: string
  readonly accountId: string
  readonly licenseId: string
  readonly releaseId: typeof CSV_SEED_IDENTITY.releaseId
  readonly pluginId: typeof CSV_SEED_IDENTITY.pluginId
  readonly version: typeof CSV_SEED_IDENTITY.version
  readonly packageSha256: typeof CSV_SEED_IDENTITY.packageSha256
  readonly samplePassed: true
  readonly scope: 'account-bound-private-candidate'
  readonly installable: false
  readonly dispatchable: false
}

function invalid(): never { throw new Error('QIANSHOU_REVIEWED_SEED_INVALID') }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

async function currentAccount(carrier: ReviewedSeedAccountCarrier): Promise<string> {
  const snapshot = await carrier.snapshot()
  const id = snapshot.account?.id
  if ((snapshot.phase !== 'authenticated' && snapshot.phase !== 'refreshing')
    || typeof id !== 'string' || !ACCOUNT_ID.test(id)) invalid()
  return id
}

/** Whether a signed release is the exact official CSV seed this Host can execute privately. */
export function isReviewedSeedCsvRelease(release: SignedRelease): boolean {
  const operation = release.operations[0]
  return release.releaseId === CSV_SEED_IDENTITY.releaseId
    && release.pluginId === CSV_SEED_IDENTITY.pluginId && release.version === CSV_SEED_IDENTITY.version
    && release.packageSha256 === CSV_SEED_IDENTITY.packageSha256
    && release.packageBytes === CSV_SEED_IDENTITY.packageBytes
    && release.platforms.includes(platform() as 'darwin' | 'win32' | 'linux')
    && release.architectures.includes(arch() as 'arm64' | 'x64' | 'ia32' | 'arm')
    && release.operations.length === 1 && operation !== undefined
    && operation.capabilityId === CSV_SEED_IDENTITY.capabilityId
    && operation.operationId === CSV_SEED_IDENTITY.operationId
    && operation.executorKind === 'node' && operation.permissions.length === 0
    && operation.inputSchemaSha256 === CSV_SEED_IDENTITY.inputSchemaSha256
    && operation.outputSchemaSha256 === CSV_SEED_IDENTITY.outputSchemaSha256
}

function seedRelease(release: SignedRelease): void {
  if (!isReviewedSeedCsvRelease(release)) invalid()
}

function parseClaim(value: unknown, release: SignedRelease, accountId: string): {
  readonly licenseId: string; readonly token: string; readonly expiresAt: number
} {
  const body = object(value)
  if (body === null || !exact(body, ['ok', 'releaseId', 'pluginId', 'version', 'packageSha256', 'license', 'download'])
    || body.ok !== true || body.releaseId !== release.releaseId
    || body.pluginId !== release.pluginId || body.version !== release.version
    || body.packageSha256 !== release.packageSha256) invalid()
  const license = object(body.license)
  const download = object(body.download)
  if (license === null || !exact(license, ['licenseId', 'kind', 'accountId', 'claimedAt'])
    || download === null || !exact(download, ['url', 'token', 'expiresAt'])
    || typeof license.licenseId !== 'string' || !LICENSE_ID.test(license.licenseId)
    || license.kind !== 'free' || license.accountId !== accountId
    || !Number.isSafeInteger(license.claimedAt) || (license.claimedAt as number) < 1
    || (license.claimedAt as number) > Date.now() + 5 * 60_000
    || download.url !== `/qianshou-market/releases?artifact=${release.releaseId}`
    || typeof download.token !== 'string' || !ACCESS_TOKEN.test(download.token)
    || !Number.isSafeInteger(download.expiresAt)
    || (download.expiresAt as number) <= Date.now() + 1_000
    || (download.expiresAt as number) > Date.now() + MAX_TOKEN_LIFETIME_MS) invalid()
  return { licenseId: license.licenseId, token: download.token, expiresAt: download.expiresAt as number }
}

async function claimFreeRelease(base: URL, release: SignedRelease, accountId: string,
  access: string, signal: AbortSignal): Promise<ReturnType<typeof parseClaim>> {
  const response = await fetch(new URL('/qianshou-market/license', base), {
    method: 'POST', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ action: 'claim', releaseId: release.releaseId }),
  })
  if (response.status !== 200 || response.body === null
    || !/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') ?? '')
    || response.headers.get('content-encoding') !== null) {
    await response.body?.cancel().catch(() => undefined)
    invalid()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > CLAIM_RESPONSE_BYTES) invalid()
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { invalid() }
  return parseClaim(value, release, accountId)
}

async function verifiedClaim(request: ReviewedSeedLicenseRequest): Promise<{
  readonly carrier: ReviewedSeedAccountCarrier
  readonly accountId: string
  readonly release: SignedRelease
  readonly grant: ReturnType<typeof parseClaim>
  readonly signal: AbortSignal
}> {
  const carrier = request.account
  if (carrier === undefined || typeof carrier.snapshot !== 'function'
    || typeof carrier.ensureAccessToken !== 'function') invalid()
  const timeoutMs = request.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) invalid()
  const base = marketApiUrl(request.apiBaseUrl)
  const signal = AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
  const accountId = await currentAccount(carrier)
  const releases = await fetchSignedReleases(base, signal, request.publisherKeys, request.operatorKeys)
  const release = releases.find(item => item.releaseId === CSV_SEED_IDENTITY.releaseId)
  if (release === undefined) invalid()
  seedRelease(release)
  if (await reviewedSeedClaimAuthChannel({ ...request, signal }) !== 'verified') invalid()
  const access = await carrier.ensureAccessToken()
  if (access === null || access.length < 16 || access.length > 8192 || /[\u0000-\u001f\u007f]/u.test(access)) invalid()
  if (await currentAccount(carrier) !== accountId) invalid()
  const grant = await claimFreeRelease(base, release, accountId, access, signal)
  if (await currentAccount(carrier) !== accountId) invalid()
  signal.throwIfAborted()
  return { carrier, accountId, release, grant, signal }
}

/** Re-read signed release metadata and make an authenticated, idempotent free claim. The server
 * must verify the current account online on every call. This Host helper returns no download
 * token and cannot, by itself, activate an installed plugin.
 */
export async function verifyReviewedSeedCsvLicense(
  request: ReviewedSeedLicenseRequest): Promise<ReviewedSeedLicenseResult> {
  const { carrier, accountId, grant, signal } = await verifiedClaim(request)
  if (Date.now() >= grant.expiresAt || await currentAccount(carrier) !== accountId) invalid()
  signal.throwIfAborted()
  return { accountId, licenseId: grant.licenseId,
    releaseId: CSV_SEED_IDENTITY.releaseId, pluginId: CSV_SEED_IDENTITY.pluginId,
    version: CSV_SEED_IDENTITY.version, packageSha256: CSV_SEED_IDENTITY.packageSha256,
    checkedAt: Date.now() }
}

/** Claim one free account license and verify the exact five-file official seed after download.
 * @param request - Current Host account, fixed Guangzhou origin, trust roots and private staging path.
 * @returns Account-bound private candidate, which still needs an explicit owner installation decision.
 */
export async function acquireReviewedSeedCsvFromMarket(
  request: ReviewedSeedAcquireRequest): Promise<ReviewedSeedAcquireResult> {
  const { carrier, accountId, release, grant, signal } = await verifiedClaim(request)
  const timeoutMs = request.timeoutMs ?? 120_000
  const stage = await stageReviewedPluginArchive({ apiBaseUrl: request.apiBaseUrl,
    releaseId: release.releaseId, publisherKeys: request.publisherKeys,
    operatorKeys: request.operatorKeys, artifactAccessToken: grant.token,
    stagingDir: request.stagingDir, signal, timeoutMs })
  let keep = false
  try {
    if (Date.now() >= grant.expiresAt || stage.signedRelease.installable !== false
      || releasePayload(stage.signedRelease) !== releasePayload(release)
      || approvalPayload(stage.signedRelease) !== approvalPayload(release)
      || stage.signedRelease.approval.signature !== release.approval.signature
      || stage.signedRelease.publisher.signature !== release.publisher.signature) invalid()
    seedRelease(stage.signedRelease)
    const checked = await inspectOfficialCsvSeedArchive(stage.archivePath, signal)
    if (!checked.samplePassed || await currentAccount(carrier) !== accountId) invalid()
    signal.throwIfAborted()
    keep = true
    return { archivePath: stage.archivePath, accountId, licenseId: grant.licenseId,
      releaseId: CSV_SEED_IDENTITY.releaseId, pluginId: CSV_SEED_IDENTITY.pluginId,
      version: CSV_SEED_IDENTITY.version, packageSha256: CSV_SEED_IDENTITY.packageSha256,
      samplePassed: true, scope: 'account-bound-private-candidate',
      installable: false, dispatchable: false }
  } finally {
    if (!keep) await unlink(stage.archivePath).catch(() => undefined)
  }
}
