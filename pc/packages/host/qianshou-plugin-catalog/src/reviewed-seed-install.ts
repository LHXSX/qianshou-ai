/** Buyer-account-bound private install and use for the reviewed official CSV seed.
 *
 * This path has its own receipt. It cannot borrow the offline development trial receipt,
 * register a market capability, advertise node health or accept a Shanghai order.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CSV_SEED_IDENTITY, executeOfficialCsvProfile, inspectOfficialCsvSeedArchive,
  type CsvProfileOutput } from './official-seed-csv.ts'
import { verifyReviewedSeedCsvLicense, type ReviewedSeedAcquireResult,
  type ReviewedSeedLicenseRequest } from './reviewed-seed-consumer.ts'

const ARCHIVE_NAME = 'market-qianshou.csv-profile-1.0.0.qspkg'
const RECEIPT_NAME = 'market-qianshou.csv-profile-1.0.0.json'
const RECEIPT_FORMAT = 'qianshou.market-csv-seed-install.v1'
const MAX_RECEIPT_BYTES = 2048
const RECEIPT_KEYS = ['format', 'accountId', 'licenseId', 'releaseId', 'pluginId',
  'version', 'packageSha256', 'archiveName', 'installedAt', 'scope', 'dispatchable'] as const

export interface ReviewedSeedInstallIdentity {
  readonly accountId: string
  readonly licenseId: string
  readonly releaseId: typeof CSV_SEED_IDENTITY.releaseId
  readonly pluginId: typeof CSV_SEED_IDENTITY.pluginId
  readonly version: typeof CSV_SEED_IDENTITY.version
  readonly packageSha256: typeof CSV_SEED_IDENTITY.packageSha256
}

export interface ReviewedSeedMarketInstallRequest {
  readonly candidate: ReviewedSeedAcquireResult
  readonly license: ReviewedSeedLicenseRequest
  /** Existing 0700 private directory; market files use names distinct from development trials. */
  readonly privateDir: string
  readonly signal: AbortSignal
  /** An active owner session must approve this exact account, release, version and digest. */
  readonly approveOwner: (identity: ReviewedSeedInstallIdentity, signal: AbortSignal) => Promise<boolean>
}

export interface ReviewedSeedMarketInstallResult extends ReviewedSeedInstallIdentity {
  readonly archivePath: string
  readonly installed: true
  readonly scope: 'account-bound-private'
  readonly dispatchable: false
}

export interface ReviewedSeedMarketRunRequest {
  readonly privateDir: string
  readonly license: ReviewedSeedLicenseRequest
  readonly input: unknown
  readonly signal: AbortSignal
}

function invalid(): never { throw new Error('QIANSHOU_REVIEWED_SEED_INSTALL_INVALID') }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}

async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) invalid()
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) invalid()
  const resolved = await realpath(path)
  const verified = await lstat(resolved)
  if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o077) !== 0
    || stat.dev !== verified.dev || stat.ino !== verified.ino) invalid()
  return resolved
}

async function exactSeedBytes(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) invalid()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || stat.size !== CSV_SEED_IDENTITY.packageBytes) invalid()
    const bytes = await handle.readFile()
    if (createHash('sha256').update(bytes).digest('hex') !== CSV_SEED_IDENTITY.packageSha256) invalid()
    return bytes
  } finally { await handle.close() }
}

function identityOf(value: Pick<ReviewedSeedInstallIdentity, keyof ReviewedSeedInstallIdentity>): ReviewedSeedInstallIdentity {
  if (value.releaseId !== CSV_SEED_IDENTITY.releaseId
    || value.pluginId !== CSV_SEED_IDENTITY.pluginId
    || value.version !== CSV_SEED_IDENTITY.version
    || value.packageSha256 !== CSV_SEED_IDENTITY.packageSha256
    || typeof value.accountId !== 'string' || typeof value.licenseId !== 'string') invalid()
  return { accountId: value.accountId, licenseId: value.licenseId,
    releaseId: CSV_SEED_IDENTITY.releaseId, pluginId: CSV_SEED_IDENTITY.pluginId,
    version: CSV_SEED_IDENTITY.version, packageSha256: CSV_SEED_IDENTITY.packageSha256 }
}

function sameIdentity(left: ReviewedSeedInstallIdentity, right: ReviewedSeedInstallIdentity): boolean {
  return left.accountId === right.accountId && left.licenseId === right.licenseId
    && left.releaseId === right.releaseId && left.pluginId === right.pluginId
    && left.version === right.version && left.packageSha256 === right.packageSha256
}

function licenseRequest(request: ReviewedSeedLicenseRequest, signal: AbortSignal): ReviewedSeedLicenseRequest {
  return { ...request, signal: AbortSignal.any([request.signal ?? new AbortController().signal, signal]) }
}

async function checkedOnlineLicense(request: ReviewedSeedLicenseRequest,
  expected: ReviewedSeedInstallIdentity, signal: AbortSignal): Promise<void> {
  const live = identityOf(await verifyReviewedSeedCsvLicense(licenseRequest(request, signal)))
  if (!sameIdentity(live, expected)) invalid()
  signal.throwIfAborted()
}

async function writeExclusive(path: string, bytes: Buffer | string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let failed = false
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    failed = true
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
    if (failed && handle !== undefined) await rm(path, { force: true }).catch(() => undefined)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function alreadyExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}

/** Install one already downloaded, signed, account-claimed seed after fresh online license
 * checks and owner approval. Only a private receipt is written; it is never a node declaration.
 */
export async function installReviewedSeedCsvForOwner(
  request: ReviewedSeedMarketInstallRequest): Promise<ReviewedSeedMarketInstallResult> {
  if (typeof request.approveOwner !== 'function') invalid()
  request.signal.throwIfAborted()
  const directory = await privateDirectory(request.privateDir)
  const candidate = request.candidate
  if (candidate.scope !== 'account-bound-private-candidate'
    || candidate.installable !== false || candidate.dispatchable !== false
    || candidate.samplePassed !== true) invalid()
  const identity = identityOf(candidate)
  await checkedOnlineLicense(request.license, identity, request.signal)
  const bytes = await exactSeedBytes(candidate.archivePath)
  const archivePath = join(directory, ARCHIVE_NAME)
  const receiptPath = join(directory, RECEIPT_NAME)
  // A complete receipt is never silently replaced. A sole exact archive can be recovered after
  // a process interruption, but a partial or foreign file must remain untouched for inspection.
  if (await pathExists(receiptPath)) invalid()
  if (await pathExists(archivePath)) await inspectOfficialCsvSeedArchive(archivePath, request.signal)
  const temporary = join(directory, `.market-csv-${randomUUID()}.qspkg`)
  try {
    await writeExclusive(temporary, bytes)
    await inspectOfficialCsvSeedArchive(temporary, request.signal)
    request.signal.throwIfAborted()
    if (!await request.approveOwner(identity, request.signal)) invalid()
    // Approval may have taken time or crossed an account switch. Verify the same license again.
    await checkedOnlineLicense(request.license, identity, request.signal)
    let archiveCreated = false
    try {
      try {
        await writeExclusive(archivePath, bytes)
        archiveCreated = true
      } catch (error) {
        if (!alreadyExists(error)) throw error
        // Another attempt may have created the exact archive after our first check. Never
        // overwrite it; re-verify the entire fixed package before publishing any receipt.
      }
      await inspectOfficialCsvSeedArchive(archivePath, request.signal)
      request.signal.throwIfAborted()
      await writeExclusive(receiptPath, JSON.stringify({ format: RECEIPT_FORMAT, ...identity,
        archiveName: ARCHIVE_NAME, installedAt: Date.now(),
        scope: 'account-bound-private', dispatchable: false }) + '\n')
    } catch (error) {
      if (archiveCreated && !await pathExists(receiptPath)) await rm(archivePath, { force: true })
      throw error
    }
    return { ...identity, archivePath, installed: true,
      scope: 'account-bound-private', dispatchable: false }
  } finally { await rm(temporary, { force: true }) }
}

async function installedIdentity(directory: string): Promise<ReviewedSeedInstallIdentity> {
  const handle = await open(join(directory, RECEIPT_NAME), constants.O_RDONLY | constants.O_NOFOLLOW)
  let value: unknown
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) invalid()
    try { value = JSON.parse((await handle.readFile()).toString('utf8')) as unknown }
    catch { invalid() }
  } finally { await handle.close() }
  const receipt = object(value)
  if (receipt === null || !exact(receipt, RECEIPT_KEYS) || receipt.format !== RECEIPT_FORMAT
    || receipt.archiveName !== ARCHIVE_NAME || receipt.scope !== 'account-bound-private'
    || receipt.dispatchable !== false || !Number.isSafeInteger(receipt.installedAt)
    || (receipt.installedAt as number) < 1 || (receipt.installedAt as number) > Date.now() + 60_000) invalid()
  return identityOf(receipt as unknown as ReviewedSeedInstallIdentity)
}

/** Execute the fixed Host-owned adapter only while the original owner account, online Guangzhou
 * free license, exact archive, manifest, schemas and packaged sample remain valid.
 */
export async function runReviewedSeedCsvForOwner(
  request: ReviewedSeedMarketRunRequest): Promise<CsvProfileOutput> {
  request.signal.throwIfAborted()
  const directory = await privateDirectory(request.privateDir)
  const identity = await installedIdentity(directory)
  const account = request.license.account
  if (account === undefined) invalid()
  const snapshot = await account.snapshot()
  if ((snapshot.phase !== 'authenticated' && snapshot.phase !== 'refreshing')
    || snapshot.account?.id !== identity.accountId) invalid()
  const archivePath = join(directory, ARCHIVE_NAME)
  await inspectOfficialCsvSeedArchive(archivePath, request.signal)
  await checkedOnlineLicense(request.license, identity, request.signal)
  await inspectOfficialCsvSeedArchive(archivePath, request.signal)
  request.signal.throwIfAborted()
  return executeOfficialCsvProfile(request.input)
}
