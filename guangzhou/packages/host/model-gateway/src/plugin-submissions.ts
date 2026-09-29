/** Owner-bound package intake; data-only reviews never enter executable release publication. */
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Principal } from './admin-routes.ts'
import { readPinnedApprovedPluginReleases, validateApprovedPluginRelease,
  type ApprovedPluginRelease, type PluginReleaseOptions } from './plugin-releases.ts'
import { matchesSeedReleaseDeclaration, verifyDeclarationPluginPackage, verifySeedPluginPackage,
  type DeclarationPackageManifest, type SeedPackageManifest,
  type VerifiedDeclarationPackage, type VerifiedSeedPackage } from './plugin-seed-package.ts'
import { verifyReviewableExecutionPackage, type ReviewableExecutionManifest,
  type VerifiedReviewableExecutionPackage } from './plugin-reviewable-execution.ts'
import { pluginExecutionApprovalPayload, pluginExecutionPublisherPayload,
  validateExecutionCandidate, type PluginExecutionCandidate } from './plugin-execution-candidate.ts'

/** Account-authenticated plugin intake and review carrier path. */
export const PLUGIN_SUBMISSIONS_PATH = '/api/qianshou/ai/plugins/submissions'
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const SUBMISSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TEXT_CONTROL = /[\u0000-\u001f\u007f]/u
// Base64 adds roughly one third to the 2 MiB bounded archive, plus JSON fields.
export const PLUGIN_SUBMISSION_MAX_BODY_BYTES = 3 * 1024 * 1024
const MAX_ARCHIVE_BASE64_CHARS = Math.ceil((2 * 1024 * 1024) / 3) * 4
const MAX_SUBMISSIONS_PER_ACCOUNT = 1000
const MAX_STAGED_FILES = 50_000
const MAX_STAGED_BYTES = 16 * 1024 * 1024 * 1024
const MAX_LIST_PAGE_RECORDS = 20
const MAX_LIST_PAGE_BYTES = 3 * 1024 * 1024
const MAX_SUBMISSION_RECORD_BYTES = 320 * 1024

interface Submission {
  readonly submissionId: string
  readonly accountId: string
  readonly publisherId: string
  readonly title: string
  readonly summary: string
  readonly submittedAt: number
  readonly packageSha256: string
  readonly packageBytes: number
  readonly unpackedTreeSha256: string
  readonly manifest: SeedPackageManifest | DeclarationPackageManifest | ReviewableExecutionManifest
}

/** A reviewer-signed, account-bound moderation decision; the service stores no signing private key. */
export interface PluginRejectionReceipt {
  readonly submissionId: string
  readonly packageSha256: string
  readonly reviewId: string
  readonly operatorId: string
  readonly operatorAccountId: string
  readonly reviewedAt: number
  readonly note: string
  readonly signature: string
}

/** Signed evidence that only a declaration's metadata and schema archive were reviewed. */
export interface PluginDeclarationReviewReceipt {
  readonly format: 'qianshou.declaration-review.v1'
  readonly submissionId: string
  readonly accountId: string
  readonly publisherId: string
  readonly pluginId: string
  readonly version: string
  readonly releaseId: string
  readonly title: string
  readonly summary: string
  readonly packageSha256: string
  readonly packageBytes: number
  readonly unpackedTreeSha256: string
  readonly manifestSha256: string
  readonly reviewId: string
  readonly operatorId: string
  readonly operatorAccountId: string
  readonly reviewedAt: number
  readonly scope: 'declaration-only'
  readonly installable: false
  readonly signature: string
}

/** Domain-separated bytes for a review that conveys no executable or commercial approval.
 * @param receipt - Every reviewed field except the detached signature.
 * @returns UTF-8 payload signed by the independent review operator.
 */
export function pluginDeclarationReviewPayload(receipt: Omit<PluginDeclarationReviewReceipt, 'signature'>): string {
  const { format, submissionId, accountId, publisherId, pluginId, version, releaseId, title, summary,
    packageSha256, packageBytes, unpackedTreeSha256, manifestSha256, reviewId, operatorId,
    operatorAccountId, reviewedAt, scope, installable } = receipt
  return `qianshou-plugin-declaration-review-v1\n${JSON.stringify({ format, submissionId, accountId,
    publisherId, pluginId, version, releaseId, title, summary, packageSha256, packageBytes,
    unpackedTreeSha256, manifestSha256, reviewId, operatorId, operatorAccountId, reviewedAt,
    scope, installable })}`
}

/** Stable bytes signed with the review operator's Ed25519 key.
 * @param receipt - Every decision field except the detached signature.
 * @returns Domain-separated UTF-8 payload for signing and verification.
 */
export function pluginRejectionPayload(receipt: Omit<PluginRejectionReceipt, 'signature'>): string {
  const { submissionId, packageSha256, reviewId, operatorId, operatorAccountId, reviewedAt, note } = receipt
  return `qianshou-plugin-rejection-v1\n${JSON.stringify({ submissionId, packageSha256, reviewId,
    operatorId, operatorAccountId, reviewedAt, note })}`
}

/** Private intake storage and explicit account-to-signing-key bindings. */
export interface PluginSubmissionOptions {
  readonly stagingDir?: string
  readonly releaseOptions: PluginReleaseOptions
  /** Publisher id to verified account id; no implicit public submission. */
  readonly publisherAccounts?: Readonly<Record<string, string>>
  /** Operator id to verified administrator account id. */
  readonly operatorAccounts?: Readonly<Record<string, string>>
  /** Resolve identity for this exact request. Browser and Mac Bearer callers must not share a process session. */
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly now?: () => number
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !TEXT_CONTROL.test(value) ? value : null
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}
async function requestJson(request: Request): Promise<unknown> {
  if (request.body === null) throw new Error('PLUGIN_SUBMISSION_BODY_INVALID')
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > PLUGIN_SUBMISSION_MAX_BODY_BYTES) throw new Error('PLUGIN_SUBMISSION_BODY_INVALID')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown
}
async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('PLUGIN_SUBMISSION_DIR_INVALID')
}
async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maximum || (info.mode & 0o077) !== 0) throw new Error('PLUGIN_SUBMISSION_FILE_INVALID')
    const bytes = await handle.readFile()
    if (bytes.length > maximum) throw new Error('PLUGIN_SUBMISSION_FILE_INVALID')
    return bytes
  } finally { await handle.close() }
}
async function exclusive(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() }
  finally { await handle.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() }
  finally { await handle.close() }
}
async function atomic(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await exclusive(temporary, bytes); await rename(temporary, path) }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error }
}
async function publishExclusive(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await exclusive(temporary, bytes)
    // The fully synced inode appears at the final path in one no-overwrite link operation.
    await link(temporary, path)
    await unlink(temporary).catch(() => undefined)
    // Ack only after the final directory entry is durable, including after power loss.
    await syncDirectory(dirname(path))
  } finally { await unlink(temporary).catch(() => undefined) }
}
function submissionFile(dir: string, id: string): string { return join(dir, `${id}.json`) }
function archiveFile(dir: string, id: string): string { return join(dir, `${id}.qspkg`) }
function rejectionFile(dir: string, id: string): string { return join(dir, `${id}.rejection.json`) }
function declarationReviewFile(dir: string, id: string): string { return join(dir, `${id}.declaration-review.json`) }
function executionCandidateFile(dir: string, id: string): string { return join(dir, `${id}.execution-candidate.json`) }
function manifestSha256(manifest: DeclarationPackageManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}
function submitted(value: unknown): Submission {
  const record = object(value)
  if (record === null || !only(record, ['submissionId', 'accountId', 'publisherId', 'title', 'summary',
    'submittedAt', 'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'manifest'])
    || typeof record['submissionId'] !== 'string' || !/^[0-9a-f-]{36}$/u.test(record['submissionId'])
    || typeof record['accountId'] !== 'string' || record['accountId'].length < 1 || record['accountId'].length > 128
    || typeof record['publisherId'] !== 'string' || !ID.test(record['publisherId'])
    || text(record['title'], 80) === null || text(record['summary'], 400) === null
    || typeof record['submittedAt'] !== 'number' || !Number.isSafeInteger(record['submittedAt'])
    || typeof record['packageSha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(record['packageSha256'])
    || typeof record['unpackedTreeSha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(record['unpackedTreeSha256'])
    || typeof record['packageBytes'] !== 'number' || !Number.isSafeInteger(record['packageBytes'])
    || object(record['manifest']) === null
    || !['qianshou.seed-csv-profile.v1', 'qianshou.declaration.v1', 'qianshou.reviewable-execution.v1']
      .includes((record['manifest'] as Record<string, unknown>)['format'] as string)) {
    throw new Error('PLUGIN_SUBMISSION_INVALID')
  }
  return record as unknown as Submission
}
async function readSubmission(dir: string, id: string): Promise<Submission> {
  if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error('PLUGIN_SUBMISSION_INVALID')
  const record = submitted(JSON.parse((await boundedFile(submissionFile(dir, id), MAX_SUBMISSION_RECORD_BYTES)).toString('utf8')) as unknown)
  if (record.submissionId !== id) throw new Error('PLUGIN_SUBMISSION_INVALID')
  return record
}
function verifiedRejection(raw: unknown, submission: Submission,
  options: PluginSubmissionOptions): PluginRejectionReceipt {
  const value = object(raw)
  if (value === null || !only(value, ['submissionId', 'packageSha256', 'reviewId', 'operatorId',
    'operatorAccountId', 'reviewedAt', 'note', 'signature'])
    || value['submissionId'] !== submission.submissionId
    || value['packageSha256'] !== submission.packageSha256
    || typeof value['reviewId'] !== 'string' || !/^[0-9a-f-]{36}$/u.test(value['reviewId'])
    || typeof value['operatorId'] !== 'string' || !ID.test(value['operatorId'])
    || typeof value['operatorAccountId'] !== 'string' || value['operatorAccountId'].length < 1
    || value['operatorAccountId'].length > 128
    || typeof value['reviewedAt'] !== 'number' || !Number.isSafeInteger(value['reviewedAt'])
    || value['reviewedAt'] < submission.submittedAt
    || text(value['note'], 500) === null || (value['note'] as string).trim() !== value['note']
    || typeof value['signature'] !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value['signature'])) {
    throw new Error('PLUGIN_REJECTION_INVALID')
  }
  const receipt = value as unknown as PluginRejectionReceipt
  const operatorId = receipt.operatorId
  // Historic decisions remain readable after an administrator account is revoked or rebound.
  // The active account binding is checked only when the decision is submitted.
  if (!Object.hasOwn(options.releaseOptions.operatorKeys ?? {}, operatorId)) {
    throw new Error('PLUGIN_REJECTION_INVALID')
  }
  try {
    const encodedKey = options.releaseOptions.operatorKeys![operatorId]!
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) throw new Error('PLUGIN_REJECTION_INVALID')
    const publicKey = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
    const signature = Buffer.from(receipt.signature, 'base64')
    if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64
      || !verify(null, Buffer.from(pluginRejectionPayload(receipt)), publicKey, signature)) {
      throw new Error('PLUGIN_REJECTION_INVALID')
    }
  } catch { throw new Error('PLUGIN_REJECTION_INVALID') }
  return receipt
}
async function readRejection(dir: string, submission: Submission,
  options: PluginSubmissionOptions): Promise<PluginRejectionReceipt | null> {
  let bytes: Buffer
  try { bytes = await boundedFile(rejectionFile(dir, submission.submissionId), 8192) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return null
    throw error
  }
  let raw: unknown
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown }
  catch { throw new Error('PLUGIN_REJECTION_INVALID') }
  return verifiedRejection(raw, submission, options)
}

function verifiedDeclarationReview(raw: unknown, submission: Submission,
  options: PluginSubmissionOptions): PluginDeclarationReviewReceipt {
  const value = object(raw)
  if (submission.manifest.format !== 'qianshou.declaration.v1' || value === null
    || !only(value, ['format', 'submissionId', 'accountId', 'publisherId', 'pluginId', 'version',
      'releaseId', 'title', 'summary', 'packageSha256', 'packageBytes', 'unpackedTreeSha256',
      'manifestSha256', 'reviewId', 'operatorId', 'operatorAccountId', 'reviewedAt', 'scope',
      'installable', 'signature'])
    || value['format'] !== 'qianshou.declaration-review.v1'
    || value['submissionId'] !== submission.submissionId
    || value['accountId'] !== submission.accountId
    || value['publisherId'] !== submission.publisherId
    || value['pluginId'] !== submission.manifest.pluginId
    || value['version'] !== submission.manifest.version
    || value['releaseId'] !== submission.manifest.releaseId
    || value['title'] !== submission.title || value['summary'] !== submission.summary
    || value['packageSha256'] !== submission.packageSha256
    || value['packageBytes'] !== submission.packageBytes
    || value['unpackedTreeSha256'] !== submission.unpackedTreeSha256
    || value['manifestSha256'] !== manifestSha256(submission.manifest)
    || typeof value['reviewId'] !== 'string' || !SUBMISSION_UUID.test(value['reviewId'])
    || typeof value['operatorId'] !== 'string' || !ID.test(value['operatorId'])
    || typeof value['operatorAccountId'] !== 'string' || value['operatorAccountId'].length < 1
    || value['operatorAccountId'].length > 128
    || value['operatorAccountId'] === submission.accountId
    || typeof value['reviewedAt'] !== 'number' || !Number.isSafeInteger(value['reviewedAt'])
    || value['reviewedAt'] < submission.submittedAt
    || value['scope'] !== 'declaration-only' || value['installable'] !== false
    || typeof value['signature'] !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(value['signature'])
    || Buffer.from(value['signature'], 'base64').toString('base64') !== value['signature']) {
    throw new Error('PLUGIN_DECLARATION_REVIEW_INVALID')
  }
  const receipt = value as unknown as PluginDeclarationReviewReceipt
  const encodedKey = Object.hasOwn(options.releaseOptions.operatorKeys ?? {}, receipt.operatorId)
    ? options.releaseOptions.operatorKeys?.[receipt.operatorId] : undefined
  if (encodedKey === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) {
    throw new Error('PLUGIN_DECLARATION_REVIEW_INVALID')
  }
  try {
    const publicKey = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
    if (publicKey.asymmetricKeyType !== 'ed25519'
      || !verify(null, Buffer.from(pluginDeclarationReviewPayload(receipt)), publicKey,
        Buffer.from(receipt.signature, 'base64'))) throw new Error('PLUGIN_DECLARATION_REVIEW_INVALID')
  } catch { throw new Error('PLUGIN_DECLARATION_REVIEW_INVALID') }
  return receipt
}

async function readDeclarationReview(dir: string, submission: Submission,
  options: PluginSubmissionOptions): Promise<PluginDeclarationReviewReceipt | null> {
  if (submission.manifest.format !== 'qianshou.declaration.v1') return null
  let bytes: Buffer
  try { bytes = await boundedFile(declarationReviewFile(dir, submission.submissionId), 8192) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return null
    throw error
  }
  let raw: unknown
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown }
  catch { throw new Error('PLUGIN_DECLARATION_REVIEW_INVALID') }
  return verifiedDeclarationReview(raw, submission, options)
}

async function readExecutionCandidate(dir: string, submission: Submission,
  options: PluginSubmissionOptions): Promise<PluginExecutionCandidate | null> {
  if (submission.manifest.format !== 'qianshou.reviewable-execution.v1') return null
  let bytes: Buffer
  try { bytes = await boundedFile(executionCandidateFile(dir, submission.submissionId), 32 * 1024) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return null
    throw error
  }
  let raw: unknown
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown }
  catch { throw new Error('PLUGIN_EXECUTION_CANDIDATE_INVALID') }
  const artifact = await boundedFile(archiveFile(dir, submission.submissionId), 256 * 1024)
  const verified = verifyReviewableExecutionPackage(artifact)
  if (verified.packageSha256 !== submission.packageSha256
    || verified.packageBytes !== submission.packageBytes
    || verified.unpackedTreeSha256 !== submission.unpackedTreeSha256
    || JSON.stringify(verified.manifest) !== JSON.stringify(submission.manifest)) {
    throw new Error('PLUGIN_EXECUTION_CANDIDATE_INVALID')
  }
  const candidate = validateExecutionCandidate(raw, submission, verified, options.releaseOptions)
  if (candidate === null) throw new Error('PLUGIN_EXECUTION_CANDIDATE_INVALID')
  return candidate
}

/** Read one independently reviewed program and its exact bytes for a separate owner license route.
 * @param options - Private staging path and retained publisher/reviewer public keys.
 * @param submissionId - Exact account-bound submission UUID.
 * @returns Verified candidate and program, or null when no reviewed candidate exists.
 */
export async function readReviewedExecutionArtifact(options: PluginSubmissionOptions,
  submissionId: string): Promise<{ readonly candidate: PluginExecutionCandidate; readonly bytes: Buffer } | null> {
  if (!SUBMISSION_UUID.test(submissionId) || options.stagingDir === undefined) return null
  await privateDirectory(options.stagingDir)
  let submission: Submission
  try { submission = await readSubmission(options.stagingDir, submissionId) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return null
    throw error
  }
  const candidate = await readExecutionCandidate(options.stagingDir, submission, options)
  if (candidate === null) return null
  if (await readRejection(options.stagingDir, submission, options) !== null) {
    throw new Error('PLUGIN_REVIEW_CONFLICT')
  }
  const bytes = await boundedFile(archiveFile(options.stagingDir, submissionId), 256 * 1024)
  return { candidate, bytes }
}
async function listSubmissions(dir: string, accountId: string | null): Promise<readonly Submission[]> {
  const names = (await readdir(dir)).filter(name => /^[0-9a-f-]{36}\.json$/u.test(name))
  const records: Submission[] = []
  for (const name of names) {
    const record = await readSubmission(dir, name.slice(0, -5))
    if (accountId === null || accountId === record.accountId) records.push(record)
  }
  return records.sort((left, right) => right.submittedAt - left.submittedAt
    || right.submissionId.localeCompare(left.submissionId))
}

/** Global disk guard applies only to new intake; a full disk never hides existing account history. */
async function stagingHasRoom(dir: string, incomingBytes: number): Promise<boolean> {
  const names = await readdir(dir)
  if (names.length + 2 > MAX_STAGED_FILES) return false
  let used = 0
  for (const name of names) {
    const info = await lstat(join(dir, name))
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
      throw new Error('PLUGIN_SUBMISSION_STAGING_INVALID')
    }
    used += info.size
    if (used + incomingBytes > MAX_STAGED_BYTES) return false
  }
  return true
}

async function published(options: PluginReleaseOptions): Promise<readonly ApprovedPluginRelease[]> {
  const path = options.registryPath
  if (path === undefined) return []
  try { await lstat(path) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return []
    throw error
  }
  return await readPinnedApprovedPluginReleases(options)
}

function releaseMatchesSubmission(release: ApprovedPluginRelease, submission: Submission): boolean {
  return submission.manifest.format === 'qianshou.seed-csv-profile.v1'
    && release.releaseId === submission.manifest.releaseId
    && release.packageSha256 === submission.packageSha256
    && release.publisher.id === submission.publisherId
    && release.title === submission.title && release.summary === submission.summary
}

/** Intake and review use separate identities; both are server-verified, not request-supplied roles.
 * @param options - Private staging/release paths, trusted keys and server account verifier.
 * @returns A carrier request handler for submission and review actions.
 */
export function createPluginSubmissionRoute(options: PluginSubmissionOptions): (request: Request) => Promise<Response> {
  if (options.stagingDir !== undefined && !isAbsolute(options.stagingDir)) throw new Error('PLUGIN_SUBMISSION_PATH_INVALID')
  const now = options.now ?? Date.now
  let pending: Promise<void> = Promise.resolve()
  return async (request) => {
    if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405)
    const dir = options.stagingDir
    const registry = options.releaseOptions.registryPath
    const artifacts = options.releaseOptions.artifactDir
    if (dir === undefined || registry === undefined || artifacts === undefined) {
      return json({ ok: false, code: 'PLUGIN_SUBMISSION_UNAVAILABLE' }, 503)
    }
    let principal: Principal | null
    try { principal = await options.authenticate(request) }
    catch { return json({ ok: false, code: 'ACCOUNT_VERIFICATION_UNAVAILABLE' }, 503) }
    if (principal === null) return json({ ok: false, code: 'LOGIN_REQUIRED' }, 401)
    let body: unknown
    try { body = await requestJson(request) }
    catch { return json({ ok: false, code: 'BAD_REQUEST' }, 400) }
    const input = object(body)
    if (input === null || typeof input['action'] !== 'string') return json({ ok: false, code: 'BAD_REQUEST' }, 400)
    const work = pending.then(async (): Promise<Response> => {
      await privateDirectory(dir)
      if (input['action'] === 'mine' || input['action'] === 'pending') {
        if ((input['cursor'] === undefined ? !only(input, ['action'])
          : !only(input, ['action', 'cursor']) || typeof input['cursor'] !== 'string'
            || !SUBMISSION_UUID.test(input['cursor']))
          || (input['action'] === 'pending' && !principal.isAdmin)) {
          return json({ ok: false, code: 'FORBIDDEN' }, 403)
        }
        const candidates = await listSubmissions(dir, input['action'] === 'mine' ? principal.accountId : null)
        const cursorIndex = input['cursor'] === undefined ? -1
          : candidates.findIndex(item => item.submissionId === input['cursor'])
        if (input['cursor'] !== undefined && cursorIndex < 0) {
          return json({ ok: false, code: 'BAD_CURSOR' }, 400)
        }
        const releases = await published(options.releaseOptions)
        const submissions: Record<string, unknown>[] = []
        let pageBytes = 128
        let index = cursorIndex + 1
        let lastScanned = input['cursor'] as string | undefined
        for (; index < candidates.length; index++) {
          const candidate = candidates[index]!
          const release = releases.find(value => releaseMatchesSubmission(value, candidate))
          const rejection = await readRejection(dir, candidate, options)
          const declarationReview = await readDeclarationReview(dir, candidate, options)
          const executionCandidate = await readExecutionCandidate(dir, candidate, options)
          if ([release !== undefined, rejection !== null, declarationReview !== null,
            executionCandidate !== null].filter(Boolean).length > 1) {
            throw new Error('PLUGIN_REVIEW_CONFLICT')
          }
          const item = { ...candidate, review: executionCandidate !== null
            ? { status: 'execution-candidate-reviewed', ...executionCandidate }
            : declarationReview !== null
              ? { status: 'declaration-reviewed', ...declarationReview }
            : release === undefined
              ? rejection === null ? { status: 'pending' } : { status: 'rejected', reviewId: rejection.reviewId,
              operatorId: rejection.operatorId, operatorAccountId: rejection.operatorAccountId,
              reviewedAt: rejection.reviewedAt, note: rejection.note, signature: rejection.signature }
            : { status: 'approved', reviewId: release.approval.reviewId,
              operatorId: release.approval.operatorId, reviewedAt: release.approval.reviewedAt } }
          if (input['action'] === 'pending' && item.review.status !== 'pending') {
            lastScanned = candidate.submissionId
            continue
          }
          const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1
          if (submissions.length > 0 && pageBytes + itemBytes > MAX_LIST_PAGE_BYTES) break
          submissions.push(item)
          pageBytes += itemBytes
          lastScanned = candidate.submissionId
          if (submissions.length >= MAX_LIST_PAGE_RECORDS) { index++; break }
        }
        return json({ ok: true, submissions, nextCursor: index < candidates.length ? lastScanned : null })
      }
      if (input['action'] === 'submit') {
        if (!only(input, ['action', 'publisherId', 'title', 'summary', 'archiveBase64'])) {
          return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        }
        const publisherId = input['publisherId']
        const title = text(input['title'], 80)
        const summary = text(input['summary'], 400)
        const base64 = input['archiveBase64']
        if (typeof publisherId !== 'string' || !ID.test(publisherId) || title === null || summary === null
          || typeof base64 !== 'string' || base64.length < 1 || base64.length > MAX_ARCHIVE_BASE64_CHARS
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
          return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        }
        if (!Object.hasOwn(options.publisherAccounts ?? {}, publisherId)
          || options.publisherAccounts?.[publisherId] !== principal.accountId
          || !Object.hasOwn(options.releaseOptions.publisherKeys ?? {}, publisherId)
          || typeof options.releaseOptions.publisherKeys?.[publisherId] !== 'string') {
          return json({ ok: false, code: 'PUBLISHER_NOT_BOUND' }, 403)
        }
        const archive = Buffer.from(base64, 'base64')
        let verified: VerifiedSeedPackage | VerifiedDeclarationPackage | VerifiedReviewableExecutionPackage
        try { verified = verifySeedPluginPackage(archive) }
        catch {
          try { verified = verifyDeclarationPluginPackage(archive) }
          catch {
            try { verified = verifyReviewableExecutionPackage(archive) }
            catch { return json({ ok: false, code: 'PLUGIN_PACKAGE_INVALID' }, 400) }
          }
        }
        const ownCount = await listSubmissions(dir, principal.accountId)
        if (ownCount.length >= MAX_SUBMISSIONS_PER_ACCOUNT) {
          return json({ ok: false, code: 'PLUGIN_SUBMISSION_ACCOUNT_LIMIT' }, 429)
        }
        const submission: Submission = {
          submissionId: randomUUID(), accountId: principal.accountId, publisherId,
          title, summary, submittedAt: now(), packageSha256: verified.packageSha256,
          packageBytes: verified.packageBytes, unpackedTreeSha256: verified.unpackedTreeSha256,
          manifest: verified.manifest,
        }
        const submissionBytes = Buffer.from(JSON.stringify(submission))
        if (submissionBytes.length > MAX_SUBMISSION_RECORD_BYTES) {
          return json({ ok: false, code: 'PLUGIN_SUBMISSION_RECORD_TOO_LARGE' }, 400)
        }
        if (!await stagingHasRoom(dir, archive.length + submissionBytes.length)) {
          return json({ ok: false, code: 'PLUGIN_SUBMISSION_STORAGE_LIMIT' }, 507)
        }
        await exclusive(archiveFile(dir, submission.submissionId), archive)
        try { await exclusive(submissionFile(dir, submission.submissionId), submissionBytes) }
        catch (error) { await unlink(archiveFile(dir, submission.submissionId)).catch(() => undefined); throw error }
        return json({ ok: true, submission })
      }
      if (input['action'] === 'approve') {
        if (!principal.isAdmin) return json({ ok: false, code: 'FORBIDDEN' }, 403)
        if (!only(input, ['action', 'submissionId', 'release']) || typeof input['submissionId'] !== 'string') {
          return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        }
        const submission = await readSubmission(dir, input['submissionId'])
        if (submission.manifest.format !== 'qianshou.seed-csv-profile.v1') {
          return json({ ok: false, code: 'PLUGIN_REVIEW_UNSUPPORTED' }, 409)
        }
        const rawRelease = object(input['release'])
        const release = validateApprovedPluginRelease(rawRelease, options.releaseOptions)
        if (release === null || options.operatorAccounts?.[release.approval.operatorId] !== principal.accountId
          || options.publisherAccounts?.[submission.publisherId] !== submission.accountId
          || release.title !== submission.title || release.summary !== submission.summary
          || release.publisher.id !== submission.publisherId) return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
        const archive = await boundedFile(archiveFile(dir, submission.submissionId), 2 * 1024 * 1024)
        const verified = verifySeedPluginPackage(archive)
        if (verified.packageSha256 !== submission.packageSha256
          || verified.packageBytes !== submission.packageBytes
          || verified.unpackedTreeSha256 !== submission.unpackedTreeSha256
          || JSON.stringify(verified.manifest) !== JSON.stringify(submission.manifest)) {
          return json({ ok: false, code: 'PLUGIN_SUBMISSION_CHANGED' }, 409)
        }
        if (!matchesSeedReleaseDeclaration(verified, release)) {
          return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
        }
        await privateDirectory(artifacts)
        await privateDirectory(dirname(registry))
        const publishLock = `${registry}.writer.lock`
        const lock = await open(publishLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          if (await readRejection(dir, submission, options) !== null) {
            return json({ ok: false, code: 'PLUGIN_REVIEW_EXISTS' }, 409)
          }
          const existing = await published(options.releaseOptions)
          if (existing.some(item => item.releaseId === release.releaseId
            || item.pluginId === release.pluginId && item.version === release.version)) {
            return json({ ok: false, code: 'PLUGIN_RELEASE_EXISTS' }, 409)
          }
          for (const candidate of await listSubmissions(dir, null)) {
            const review = await readDeclarationReview(dir, candidate, options)
            if (review !== null && (review.releaseId === release.releaseId
              || review.pluginId === release.pluginId && review.version === release.version)) {
              return json({ ok: false, code: 'PLUGIN_DECLARATION_VERSION_EXISTS' }, 409)
            }
            if (candidate.manifest.format === 'qianshou.reviewable-execution.v1'
              && candidate.manifest.pluginId === release.pluginId
              && candidate.manifest.version === release.version
              && await readExecutionCandidate(dir, candidate, options) !== null) {
              return json({ ok: false, code: 'PLUGIN_EXECUTION_VERSION_EXISTS' }, 409)
            }
          }
          const artifact = join(artifacts, `${release.packageSha256}.qspkg`)
          try { await exclusive(artifact, archive) }
          catch (error) {
            if (object(error)?.['code'] !== 'EEXIST') throw error
            const prior = await boundedFile(artifact, 2 * 1024 * 1024)
            if (!prior.equals(archive)) throw new Error('PLUGIN_ARTIFACT_CHANGED')
          }
          await atomic(registry, Buffer.from(JSON.stringify({ version: 1,
            releases: [...existing, rawRelease] })))
          return json({ ok: true, releaseId: release.releaseId, packageSha256: release.packageSha256,
            reviewId: release.approval.reviewId, operatorId: release.approval.operatorId,
            publisherId: release.publisher.id, submittedBy: submission.accountId })
        } finally { await lock.close(); await unlink(publishLock) }
      }
      if (input['action'] === 'approve-declaration') {
        if (!principal.isAdmin) return json({ ok: false, code: 'FORBIDDEN' }, 403)
        if (!only(input, ['action', 'submissionId', 'review'])
          || typeof input['submissionId'] !== 'string' || !SUBMISSION_UUID.test(input['submissionId'])
          || object(input['review']) === null) return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        let submission: Submission
        try { submission = await readSubmission(dir, input['submissionId']) }
        catch (error) {
          if (object(error)?.['code'] === 'ENOENT') return json({ ok: false, code: 'PLUGIN_SUBMISSION_NOT_FOUND' }, 404)
          throw error
        }
        if (submission.manifest.format !== 'qianshou.declaration.v1') {
          return json({ ok: false, code: 'PLUGIN_REVIEW_UNSUPPORTED' }, 409)
        }
        if (principal.accountId === submission.accountId) {
          return json({ ok: false, code: 'INDEPENDENT_REVIEW_REQUIRED' }, 403)
        }
        if (!Object.hasOwn(options.publisherAccounts ?? {}, submission.publisherId)
          || options.publisherAccounts?.[submission.publisherId] !== submission.accountId) {
          return json({ ok: false, code: 'PUBLISHER_NOT_BOUND' }, 403)
        }
        const rawReview = object(input['review'])!
        const operatorId = rawReview['operatorId']
        if (typeof operatorId !== 'string' || !ID.test(operatorId)) return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        if (!Object.hasOwn(options.operatorAccounts ?? {}, operatorId)
          || options.operatorAccounts?.[operatorId] !== principal.accountId) {
          return json({ ok: false, code: 'OPERATOR_NOT_BOUND' }, 403)
        }
        let review: PluginDeclarationReviewReceipt
        try { review = verifiedDeclarationReview(rawReview, submission, options) }
        catch { return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400) }
        if (review.operatorAccountId !== principal.accountId) {
          return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
        }
        const archive = await boundedFile(archiveFile(dir, submission.submissionId), 2 * 1024 * 1024)
        let verified: VerifiedDeclarationPackage
        try { verified = verifyDeclarationPluginPackage(archive) }
        catch { return json({ ok: false, code: 'PLUGIN_SUBMISSION_CHANGED' }, 409) }
        if (verified.packageSha256 !== submission.packageSha256
          || verified.packageBytes !== submission.packageBytes
          || verified.unpackedTreeSha256 !== submission.unpackedTreeSha256
          || JSON.stringify(verified.manifest) !== JSON.stringify(submission.manifest)) {
          return json({ ok: false, code: 'PLUGIN_SUBMISSION_CHANGED' }, 409)
        }
        await privateDirectory(dirname(registry))
        const publishLock = `${registry}.writer.lock`
        const lock = await open(publishLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          if (await readRejection(dir, submission, options) !== null) {
            return json({ ok: false, code: 'PLUGIN_REVIEW_EXISTS' }, 409)
          }
          const prior = await readDeclarationReview(dir, submission, options)
          if (prior !== null) {
            if (pluginDeclarationReviewPayload(prior) !== pluginDeclarationReviewPayload(review)
              || prior.signature !== review.signature) {
              return json({ ok: false, code: 'PLUGIN_REVIEW_EXISTS' }, 409)
            }
            await syncDirectory(dir)
            return json({ ok: true, review: { status: 'declaration-reviewed', ...prior } })
          }
          const releases = await published(options.releaseOptions)
          if (releases.some(release => release.releaseId === review.releaseId
            || release.pluginId === review.pluginId && release.version === review.version)) {
            return json({ ok: false, code: 'PLUGIN_RELEASE_EXISTS' }, 409)
          }
          const submissions = await listSubmissions(dir, null)
          for (const candidate of submissions) {
            if (candidate.submissionId === submission.submissionId) continue
            const earlier = await readDeclarationReview(dir, candidate, options)
            if (earlier !== null && (earlier.releaseId === review.releaseId
              || earlier.pluginId === review.pluginId && earlier.version === review.version)) {
              return json({ ok: false, code: 'PLUGIN_DECLARATION_VERSION_EXISTS' }, 409)
            }
            if (candidate.manifest.format === 'qianshou.reviewable-execution.v1'
              && candidate.manifest.pluginId === review.pluginId
              && candidate.manifest.version === review.version
              && await readExecutionCandidate(dir, candidate, options) !== null) {
              return json({ ok: false, code: 'PLUGIN_EXECUTION_VERSION_EXISTS' }, 409)
            }
          }
          if (Math.abs(now() - review.reviewedAt) > 5 * 60 * 1000) {
            return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
          }
          await publishExclusive(declarationReviewFile(dir, submission.submissionId), Buffer.from(JSON.stringify(review)))
          return json({ ok: true, review: { status: 'declaration-reviewed', ...review } })
        } finally { await lock.close(); await unlink(publishLock) }
      }
      if (input['action'] === 'approve-execution') {
        if (!principal.isAdmin) return json({ ok: false, code: 'FORBIDDEN' }, 403)
        if (!only(input, ['action', 'submissionId', 'candidate'])
          || typeof input['submissionId'] !== 'string' || !SUBMISSION_UUID.test(input['submissionId'])
          || object(input['candidate']) === null) return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        let submission: Submission
        try { submission = await readSubmission(dir, input['submissionId']) }
        catch (error) {
          if (object(error)?.['code'] === 'ENOENT') return json({ ok: false, code: 'PLUGIN_SUBMISSION_NOT_FOUND' }, 404)
          throw error
        }
        if (submission.manifest.format !== 'qianshou.reviewable-execution.v1') {
          return json({ ok: false, code: 'PLUGIN_REVIEW_UNSUPPORTED' }, 409)
        }
        if (principal.accountId === submission.accountId) {
          return json({ ok: false, code: 'INDEPENDENT_REVIEW_REQUIRED' }, 403)
        }
        if (!Object.hasOwn(options.publisherAccounts ?? {}, submission.publisherId)
          || options.publisherAccounts?.[submission.publisherId] !== submission.accountId) {
          return json({ ok: false, code: 'PUBLISHER_NOT_BOUND' }, 403)
        }
        const rawCandidate = object(input['candidate'])!
        const approval = object(rawCandidate['approval'])
        const operatorId = approval?.['operatorId']
        if (typeof operatorId !== 'string' || !ID.test(operatorId)) return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        if (!Object.hasOwn(options.operatorAccounts ?? {}, operatorId)
          || options.operatorAccounts?.[operatorId] !== principal.accountId) {
          return json({ ok: false, code: 'OPERATOR_NOT_BOUND' }, 403)
        }
        const archive = await boundedFile(archiveFile(dir, submission.submissionId), 256 * 1024)
        let verified: VerifiedReviewableExecutionPackage
        try { verified = verifyReviewableExecutionPackage(archive) }
        catch { return json({ ok: false, code: 'PLUGIN_SUBMISSION_CHANGED' }, 409) }
        if (verified.packageSha256 !== submission.packageSha256
          || verified.packageBytes !== submission.packageBytes
          || verified.unpackedTreeSha256 !== submission.unpackedTreeSha256
          || JSON.stringify(verified.manifest) !== JSON.stringify(submission.manifest)) {
          return json({ ok: false, code: 'PLUGIN_SUBMISSION_CHANGED' }, 409)
        }
        const candidate = validateExecutionCandidate(rawCandidate, submission, verified, options.releaseOptions)
        if (candidate === null || candidate.approval.operatorAccountId !== principal.accountId) {
          return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
        }
        await privateDirectory(dirname(registry))
        const publishLock = `${registry}.writer.lock`
        const lock = await open(publishLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          if (await readRejection(dir, submission, options) !== null) {
            return json({ ok: false, code: 'PLUGIN_REVIEW_EXISTS' }, 409)
          }
          const prior = await readExecutionCandidate(dir, submission, options)
          if (prior !== null) {
            if (pluginExecutionPublisherPayload(prior) !== pluginExecutionPublisherPayload(candidate)
              || pluginExecutionApprovalPayload(prior) !== pluginExecutionApprovalPayload(candidate)
              || prior.publisher.signature !== candidate.publisher.signature
              || prior.approval.signature !== candidate.approval.signature) {
              return json({ ok: false, code: 'PLUGIN_REVIEW_EXISTS' }, 409)
            }
            await syncDirectory(dir)
            return json({ ok: true, review: { status: 'execution-candidate-reviewed', ...prior } })
          }
          const releases = await published(options.releaseOptions)
          if (releases.some(release => release.releaseId === candidate.releaseId
            || release.pluginId === candidate.pluginId && release.version === candidate.version)) {
            return json({ ok: false, code: 'PLUGIN_RELEASE_EXISTS' }, 409)
          }
          for (const other of await listSubmissions(dir, null)) {
            if (other.submissionId === submission.submissionId) continue
            const declaration = await readDeclarationReview(dir, other, options)
            if (declaration !== null && (declaration.releaseId === candidate.releaseId
              || declaration.pluginId === candidate.pluginId && declaration.version === candidate.version)) {
              return json({ ok: false, code: 'PLUGIN_DECLARATION_VERSION_EXISTS' }, 409)
            }
            if (other.manifest.format === 'qianshou.reviewable-execution.v1'
              && (other.packageSha256 === candidate.packageSha256
                || other.manifest.pluginId === candidate.pluginId && other.manifest.version === candidate.version)
              && await readExecutionCandidate(dir, other, options) !== null) {
              return json({ ok: false, code: 'PLUGIN_EXECUTION_VERSION_EXISTS' }, 409)
            }
          }
          if (Math.abs(now() - candidate.approval.reviewedAt) > 5 * 60 * 1000) {
            return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
          }
          await publishExclusive(executionCandidateFile(dir, submission.submissionId),
            Buffer.from(JSON.stringify(candidate)))
          return json({ ok: true, review: { status: 'execution-candidate-reviewed', ...candidate } })
        } finally { await lock.close(); await unlink(publishLock) }
      }
      if (input['action'] === 'reject') {
        if (!principal.isAdmin) return json({ ok: false, code: 'FORBIDDEN' }, 403)
        if (!only(input, ['action', 'submissionId', 'rejection'])
          || typeof input['submissionId'] !== 'string' || !SUBMISSION_UUID.test(input['submissionId'])
          || object(input['rejection']) === null) {
          return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        }
        const rawRejection = object(input['rejection'])!
        const operatorId = rawRejection['operatorId']
        if (typeof operatorId !== 'string' || !ID.test(operatorId)) return json({ ok: false, code: 'BAD_REQUEST' }, 400)
        if (!Object.hasOwn(options.operatorAccounts ?? {}, operatorId)
          || options.operatorAccounts?.[operatorId] !== principal.accountId) {
          return json({ ok: false, code: 'OPERATOR_NOT_BOUND' }, 403)
        }
        let submission: Submission
        try { submission = await readSubmission(dir, input['submissionId']) }
        catch (error) {
          if (object(error)?.['code'] === 'ENOENT') {
            return json({ ok: false, code: 'PLUGIN_SUBMISSION_NOT_FOUND' }, 404)
          }
          throw error
        }
        let rejection: PluginRejectionReceipt
        try { rejection = verifiedRejection(rawRejection, submission, options) }
        catch { return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400) }
        if (rejection.operatorAccountId !== principal.accountId) {
          return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
        }
        await privateDirectory(dirname(registry))
        const publishLock = `${registry}.writer.lock`
        const lock = await open(publishLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          const prior = await readRejection(dir, submission, options)
          const released = (await published(options.releaseOptions)).some(release =>
            releaseMatchesSubmission(release, submission))
            || await readDeclarationReview(dir, submission, options) !== null
            || await readExecutionCandidate(dir, submission, options) !== null
          if (prior !== null && released) throw new Error('PLUGIN_REVIEW_CONFLICT')
          if (prior !== null) {
            if (pluginRejectionPayload(prior) !== pluginRejectionPayload(rejection)
              || prior.signature !== rejection.signature) {
              return json({ ok: false, code: 'PLUGIN_REVIEW_EXISTS' }, 409)
            }
            // A prior response may have failed after link but before the directory sync.
            await syncDirectory(dir)
            return json({ ok: true, review: { status: 'rejected', ...prior } })
          }
          if (released) {
            return json({ ok: false, code: 'PLUGIN_REVIEW_EXISTS' }, 409)
          }
          if (Math.abs(now() - rejection.reviewedAt) > 5 * 60 * 1000) {
            return json({ ok: false, code: 'PLUGIN_REVIEW_INVALID' }, 400)
          }
          await publishExclusive(rejectionFile(dir, submission.submissionId), Buffer.from(JSON.stringify(rejection)))
          return json({ ok: true, review: { status: 'rejected', ...rejection } })
        } finally { await lock.close(); await unlink(publishLock) }
      }
      return json({ ok: false, code: 'BAD_REQUEST' }, 400)
    })
    pending = work.then(() => undefined, () => undefined)
    try { return await work }
    catch { return json({ ok: false, code: 'PLUGIN_SUBMISSION_UNAVAILABLE' }, 503) }
  }
}
