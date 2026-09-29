/** Host-only, account-bound submission of sanitized plugin declarations to Guangzhou. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { verifyReviewableExecutionArtifact } from '@deepseek-ai/dsh-compute-core'
import { marketApiUrl } from './market.ts'
import { verifiedPrivateExecutionReview } from './private-execution-access.ts'

const ENDPOINT = '/qianshou-market/submissions'
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024
const MAX_SUBMIT_RESPONSE_BYTES = 64 * 1024
const MAX_MINE_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_SUBMISSIONS = 1000
const MAX_MINE_PAGES = 100
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const PUBLISHER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u
const ACCESS_TOKEN = /^[\x21-\x7e]{16,4096}$/u
const TEXT_CONTROL = /[\u0000-\u001f\u007f]/u

/** Existing account state and access token are read only inside the Host process. */
export interface PrivatePluginSubmissionAccount {
  readonly snapshot: () => Promise<{ phase: string; account: { id: string } | null }>
  readonly ensureAccessToken: () => Promise<string | null>
}

/** The operator fixes the origin; no origin, token or archive can arrive from a Remote argument. */
export interface PrivatePluginSubmissionConnection {
  readonly apiBaseUrl: string
  readonly account?: PrivatePluginSubmissionAccount
  /** Operator-owned trust roots. A declaration review is never accepted without its signer. */
  readonly operatorKeys?: Readonly<Record<string, string>>
  readonly publisherKeys?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** The Host must obtain this approval for the exact declaration bytes and account before calling. */
export interface PrivatePluginDeclarationSubmitRequest extends PrivatePluginSubmissionConnection {
  readonly publisherId: string
  readonly title: string
  readonly summary: string
  readonly archiveBytes: Uint8Array
  readonly approvedAccountId: string
  readonly approvedPackageSha256: string
}

/** Safe receipt projection; archive, manifest, token and local paths are never returned. */
export interface PrivatePluginSubmissionReceipt {
  readonly submissionId: string
  readonly accountId: string
  readonly publisherId: string
  readonly title: string
  readonly summary: string
  readonly submittedAt: number
  readonly packageSha256: string
  readonly packageBytes: number
  readonly reviewStatus: 'pending' | 'approved' | 'declaration-reviewed' | 'execution-candidate-reviewed' | 'rejected'
  readonly reviewId?: string
  readonly reviewNote?: string
}

/** An uncertain POST may have committed on the server; callers must query mine before any retry. */
export type PrivatePluginDeclarationSubmitResult =
  | { readonly state: 'submitted'; readonly receipt: PrivatePluginSubmissionReceipt }
  | { readonly state: 'refused'; readonly reason: 'publisher-not-bound' | 'sign-in-required' }
  | { readonly state: 'unknown'; readonly accountId: string; readonly packageSha256: string;
    readonly reconciliation: 'mine-required' }

/** Only records for the account checked before and after this read are returned. */
export interface MyPrivatePluginSubmissions {
  readonly accountId: string
  readonly submissions: readonly PrivatePluginSubmissionReceipt[]
}

function invalid(): never { throw new Error('QIANSHOU_PLUGIN_SUBMISSION_INVALID') }
function unavailable(): never { throw new Error('QIANSHOU_PLUGIN_SUBMISSION_UNAVAILABLE') }
function accountChanged(): never { throw new Error('QIANSHOU_PLUGIN_SUBMISSION_ACCOUNT_CHANGED') }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !TEXT_CONTROL.test(value)
}
function connection(request: PrivatePluginSubmissionConnection): {
  readonly url: URL; readonly account: PrivatePluginSubmissionAccount; readonly signal: AbortSignal
} {
  const account = request.account
  if (account === undefined || typeof account.snapshot !== 'function'
    || typeof account.ensureAccessToken !== 'function') unavailable()
  const timeoutMs = request.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) invalid()
  const base = marketApiUrl(request.apiBaseUrl)
  return { url: new URL(ENDPOINT, base), account,
    signal: AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]) }
}
async function currentAccount(account: PrivatePluginSubmissionAccount): Promise<string> {
  const snapshot = await account.snapshot()
  const id = snapshot.account?.id
  if ((snapshot.phase !== 'authenticated' && snapshot.phase !== 'refreshing')
    || typeof id !== 'string' || !ACCOUNT_ID.test(id)) unavailable()
  return id
}
async function accessToken(account: PrivatePluginSubmissionAccount, accountId: string,
  signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const token = await account.ensureAccessToken()
  if (token === null || !ACCESS_TOKEN.test(token)) unavailable()
  if (await currentAccount(account) !== accountId) accountChanged()
  signal.throwIfAborted()
  return token
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (response.status !== 200 || response.redirected || response.body === null
    || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
    || response.headers.get('content-encoding') !== null) {
    await response.body?.cancel().catch(() => undefined)
    invalid()
  }
  const announced = response.headers.get('content-length')
  if (announced !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(announced)
    || Number(announced) > maximum)) {
    await response.body.cancel().catch(() => undefined)
    invalid()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximum) invalid()
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true })
    .decode(Buffer.concat(chunks, length))) as unknown
}
/** These exact Guangzhou failures occur before its durable submission write. */
async function definiteRefusal(response: Response): Promise<
  'publisher-not-bound' | 'sign-in-required' | null> {
  if (response.status !== 401 && response.status !== 403) return null
  if (response.redirected || response.body === null
    || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
    || response.headers.get('content-encoding') !== null) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 4096) return null
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true })
    .decode(Buffer.concat(chunks, length))) as unknown }
  catch { return null }
  const row = object(parsed)
  if (row === null || !exact(row, ['ok', 'code']) || row['ok'] !== false) return null
  if (response.status === 403 && row['code'] === 'PUBLISHER_NOT_BOUND') return 'publisher-not-bound'
  if (response.status === 401 && row['code'] === 'LOGIN_REQUIRED') return 'sign-in-required'
  return null
}
function submission(value: unknown, expectedAccountId: string): PrivatePluginSubmissionReceipt {
  const row = object(value)
  if (row === null || !exact(row, ['submissionId', 'accountId', 'publisherId', 'title', 'summary',
    'submittedAt', 'packageSha256', 'packageBytes', 'unpackedTreeSha256', 'manifest'])
    || typeof row['submissionId'] !== 'string' || !SUBMISSION_ID.test(row['submissionId'])
    || row['accountId'] !== expectedAccountId
    || typeof row['publisherId'] !== 'string' || !PUBLISHER_ID.test(row['publisherId'])
    || !text(row['title'], 80) || !text(row['summary'], 400)
    || !Number.isSafeInteger(row['submittedAt']) || (row['submittedAt'] as number) < 1
    || typeof row['packageSha256'] !== 'string' || !SHA256.test(row['packageSha256'])
    || !Number.isSafeInteger(row['packageBytes']) || (row['packageBytes'] as number) < 1
    || (row['packageBytes'] as number) > MAX_ARCHIVE_BYTES
    || typeof row['unpackedTreeSha256'] !== 'string' || !SHA256.test(row['unpackedTreeSha256'])
    || !['qianshou.declaration.v1', 'qianshou.reviewable-execution.v1']
      .includes(String(object(row['manifest'])?.['format']))) invalid()
  if (object(row['manifest'])?.['format'] === 'qianshou.reviewable-execution.v1') {
    try {
      const checked = verifyReviewableExecutionArtifact(Buffer.from(JSON.stringify(row['manifest'])))
      const tree = createHash('sha256').update(JSON.stringify([['artifact.json', checked.packageSha256]])).digest('hex')
      if (checked.packageSha256 !== row['packageSha256']
        || Buffer.byteLength(JSON.stringify(row['manifest'])) !== row['packageBytes']
        || tree !== row['unpackedTreeSha256']) invalid()
    } catch { invalid() }
  }
  return { submissionId: row['submissionId'], accountId: expectedAccountId,
    publisherId: row['publisherId'], title: row['title'], summary: row['summary'],
    submittedAt: row['submittedAt'] as number, packageSha256: row['packageSha256'],
    packageBytes: row['packageBytes'] as number, reviewStatus: 'pending' }
}
function verifiedDeclarationReview(value: Record<string, unknown>, submission: Record<string, unknown>,
  receipt: PrivatePluginSubmissionReceipt, operatorKeys: Readonly<Record<string, string>>): boolean {
  const fields = ['status', 'format', 'submissionId', 'accountId', 'publisherId', 'pluginId',
    'version', 'releaseId', 'title', 'summary', 'packageSha256', 'packageBytes',
    'unpackedTreeSha256', 'manifestSha256', 'reviewId', 'operatorId', 'operatorAccountId',
    'reviewedAt', 'scope', 'installable', 'signature'] as const
  const manifest = object(submission['manifest'])
  if (!exact(value, fields) || value['status'] !== 'declaration-reviewed'
    || value['format'] !== 'qianshou.declaration-review.v1'
    || value['submissionId'] !== receipt.submissionId || value['accountId'] !== receipt.accountId
    || value['publisherId'] !== receipt.publisherId || value['pluginId'] !== manifest?.['pluginId']
    || value['version'] !== manifest?.['version'] || value['releaseId'] !== manifest?.['releaseId']
    || value['title'] !== receipt.title || value['summary'] !== receipt.summary
    || value['packageSha256'] !== receipt.packageSha256
    || value['packageBytes'] !== receipt.packageBytes
    || value['unpackedTreeSha256'] !== submission['unpackedTreeSha256']
    || value['manifestSha256'] !== createHash('sha256')
      .update(JSON.stringify(manifest)).digest('hex')
    || typeof value['reviewId'] !== 'string' || !SUBMISSION_ID.test(value['reviewId'])
    || typeof value['operatorId'] !== 'string' || !PUBLISHER_ID.test(value['operatorId'])
    || !text(value['operatorAccountId'], 128)
    || !Number.isSafeInteger(value['reviewedAt'])
    || (value['reviewedAt'] as number) < receipt.submittedAt
    || value['scope'] !== 'declaration-only' || value['installable'] !== false
    || typeof value['signature'] !== 'string' || !SIGNATURE.test(value['signature'])
    || Buffer.from(value['signature'], 'base64').toString('base64') !== value['signature']) return false
  const encodedKey = Object.hasOwn(operatorKeys, value['operatorId'])
    ? operatorKeys[value['operatorId']] : undefined
  if (encodedKey === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) return false
  const payload = `qianshou-plugin-declaration-review-v1\n${JSON.stringify({
    format: value['format'], submissionId: value['submissionId'], accountId: value['accountId'],
    publisherId: value['publisherId'], pluginId: value['pluginId'], version: value['version'],
    releaseId: value['releaseId'], title: value['title'], summary: value['summary'],
    packageSha256: value['packageSha256'], packageBytes: value['packageBytes'],
    unpackedTreeSha256: value['unpackedTreeSha256'], manifestSha256: value['manifestSha256'],
    reviewId: value['reviewId'], operatorId: value['operatorId'],
    operatorAccountId: value['operatorAccountId'], reviewedAt: value['reviewedAt'],
    scope: value['scope'], installable: value['installable'],
  })}`
  try {
    const key = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(payload), key, Buffer.from(value['signature'], 'base64'))
  } catch { return false }
}
function verifiedRejection(value: Record<string, unknown>,
  receipt: PrivatePluginSubmissionReceipt, operatorKeys: Readonly<Record<string, string>>): boolean {
  if (!exact(value, ['status', 'reviewId', 'operatorId', 'operatorAccountId',
    'reviewedAt', 'note', 'signature']) || value['status'] !== 'rejected'
    || typeof value['reviewId'] !== 'string' || !SUBMISSION_ID.test(value['reviewId'])
    || typeof value['operatorId'] !== 'string' || !PUBLISHER_ID.test(value['operatorId'])
    || !text(value['operatorAccountId'], 128)
    || !Number.isSafeInteger(value['reviewedAt'])
    || (value['reviewedAt'] as number) < receipt.submittedAt
    || !text(value['note'], 500)
    || typeof value['signature'] !== 'string' || !SIGNATURE.test(value['signature'])
    || Buffer.from(value['signature'], 'base64').toString('base64') !== value['signature']) return false
  const encodedKey = Object.hasOwn(operatorKeys, value['operatorId'])
    ? operatorKeys[value['operatorId']] : undefined
  if (encodedKey === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) return false
  const payload = `qianshou-plugin-rejection-v1\n${JSON.stringify({
    submissionId: receipt.submissionId, packageSha256: receipt.packageSha256,
    reviewId: value['reviewId'], operatorId: value['operatorId'],
    operatorAccountId: value['operatorAccountId'], reviewedAt: value['reviewedAt'],
    note: value['note'],
  })}`
  try {
    const key = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(payload), key, Buffer.from(value['signature'], 'base64'))
  } catch { return false }
}
function reviewed(value: unknown, accountId: string,
  operatorKeys: Readonly<Record<string, string>>,
  publisherKeys: Readonly<Record<string, string>>): PrivatePluginSubmissionReceipt {
  const row = object(value)
  if (row === null || !Object.hasOwn(row, 'review')) invalid()
  const base = { ...row }
  delete base['review']
  const receipt = submission(base, accountId)
  const review = object(row['review'])
  if (review === null) invalid()
  if (exact(review, ['status']) && review['status'] === 'pending') return receipt
  if (review['status'] === 'declaration-reviewed') {
    if (!verifiedDeclarationReview(review, base, receipt, operatorKeys)) invalid()
    return { ...receipt, reviewStatus: 'declaration-reviewed', reviewId: review['reviewId'] as string }
  }
  if (review['status'] === 'execution-candidate-reviewed') {
    if (object(base['manifest'])?.['format'] !== 'qianshou.reviewable-execution.v1'
      || !verifiedPrivateExecutionReview(review, base, receipt,
        { operatorKeys, publisherKeys })) invalid()
    const approval = object(review['approval'])
    return { ...receipt, reviewStatus: 'execution-candidate-reviewed',
      reviewId: approval?.['reviewId'] as string }
  }
  if (review['status'] === 'rejected' && verifiedRejection(review, receipt, operatorKeys)) {
    return { ...receipt, reviewStatus: 'rejected', reviewId: review['reviewId'] as string,
      reviewNote: review['note'] as string }
  }
  return invalid()
}

/** Send exactly once after Host-side owner approval; an uncertain response requires mine reconciliation.
 * @param request - Sanitized declaration ZIP and approval bound to its bytes and active account.
 * @returns A verified account/package receipt or an unknown state that must not be auto-retried.
 */
export async function submitPrivatePluginDeclaration(
  request: PrivatePluginDeclarationSubmitRequest,
): Promise<PrivatePluginDeclarationSubmitResult> {
  const { url, account, signal } = connection(request)
  if (typeof request.publisherId !== 'string' || !PUBLISHER_ID.test(request.publisherId)
    || !text(request.title, 80) || !text(request.summary, 400)
    || !(request.archiveBytes instanceof Uint8Array)
    || request.archiveBytes.byteLength < 1 || request.archiveBytes.byteLength > MAX_ARCHIVE_BYTES
    || typeof request.approvedPackageSha256 !== 'string'
    || !SHA256.test(request.approvedPackageSha256)) invalid()
  const bytes = Buffer.from(request.archiveBytes)
  const packageSha256 = createHash('sha256').update(bytes).digest('hex')
  if (packageSha256 !== request.approvedPackageSha256) invalid()
  const accountId = await currentAccount(account)
  if (request.approvedAccountId !== accountId) accountChanged()
  const token = await accessToken(account, accountId, signal)
  // All pre-send checks finish before the only POST. Never retry this mutating request.
  const body = JSON.stringify({ action: 'submit', publisherId: request.publisherId,
    title: request.title, summary: request.summary, archiveBase64: bytes.toString('base64') })
  signal.throwIfAborted()
  try {
    const response = await fetch(url, { method: 'POST', signal, redirect: 'error',
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json' }, body })
    const refusal = await definiteRefusal(response)
    if (refusal !== null) {
      if (await currentAccount(account) !== accountId) accountChanged()
      return { state: 'refused', reason: refusal }
    }
    const result = object(await boundedJson(response, MAX_SUBMIT_RESPONSE_BYTES))
    if (result === null || !exact(result, ['ok', 'submission']) || result['ok'] !== true) invalid()
    const receipt = submission(result['submission'], accountId)
    if (receipt.publisherId !== request.publisherId || receipt.title !== request.title
      || receipt.summary !== request.summary || receipt.packageSha256 !== packageSha256
      || receipt.packageBytes !== bytes.byteLength) invalid()
    if (await currentAccount(account) !== accountId) accountChanged()
    signal.throwIfAborted()
    return { state: 'submitted', receipt }
  } catch {
    if (await currentAccount(account) !== accountId) accountChanged()
    return { state: 'unknown', accountId, packageSha256, reconciliation: 'mine-required' }
  }
}

/** Read only the current account's bounded submission history from the Bearer endpoint.
 * @param request - Fixed operator origin and active Host account carrier.
 * @returns Bounded, account-checked receipts with no package or token data.
 */
export async function listMyPrivatePluginSubmissions(
  request: PrivatePluginSubmissionConnection,
): Promise<MyPrivatePluginSubmissions> {
  const { url, account, signal } = connection(request)
  const accountId = await currentAccount(account)
  const token = await accessToken(account, accountId, signal)
  try {
    const submissions: PrivatePluginSubmissionReceipt[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    let complete = false
    for (let page = 0; page < MAX_MINE_PAGES; page += 1) {
      if (await currentAccount(account) !== accountId) accountChanged()
      const response = await fetch(url, { method: 'POST', signal, redirect: 'error',
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          Accept: 'application/json' }, body: JSON.stringify(cursor === null
          ? { action: 'mine' } : { action: 'mine', cursor }) })
      const result = object(await boundedJson(response, MAX_MINE_RESPONSE_BYTES))
      const paged = result !== null && Object.hasOwn(result, 'nextCursor')
      if (result === null || !exact(result, paged
        ? ['ok', 'submissions', 'nextCursor'] : ['ok', 'submissions'])
        || result['ok'] !== true || !Array.isArray(result['submissions'])
        || result['submissions'].length > (paged ? 20 : MAX_SUBMISSIONS)
        || (paged && result['nextCursor'] !== null
          && (typeof result['nextCursor'] !== 'string' || !SUBMISSION_ID.test(result['nextCursor'])))) invalid()
      for (const raw of result['submissions']) {
        const receipt = reviewed(raw, accountId, request.operatorKeys ?? {},
          request.publisherKeys ?? {})
        if (seen.has(receipt.submissionId) || submissions.length >= MAX_SUBMISSIONS) invalid()
        seen.add(receipt.submissionId)
        submissions.push(receipt)
      }
      if (await currentAccount(account) !== accountId) accountChanged()
      const next = paged ? result['nextCursor'] as string | null : null
      if (next === null) { complete = true; break }
      if (result['submissions'].length === 0 || next === cursor || seen.has(next) === false) invalid()
      cursor = next
    }
    if (!complete) invalid()
    signal.throwIfAborted()
    return { accountId, submissions }
  } catch {
    unavailable()
  }
}
