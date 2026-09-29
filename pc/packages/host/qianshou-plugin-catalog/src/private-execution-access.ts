/** Host-only self-use claim for a dual-signed, independently reviewed declarative program. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { verifyReviewableExecutionArtifact } from '@deepseek-ai/dsh-compute-core'
import type { ReviewedSeedAccountCarrier } from './reviewed-seed-consumer.ts'
import { marketApiUrl } from './market.ts'

const PATH = '/qianshou-market/execution-access'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u
const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const MAX_CLAIM_BYTES = 512 * 1024
const MAX_PACKAGE_BYTES = 256 * 1024

export interface PrivateExecutionAccessRequest {
  readonly apiBaseUrl: string
  readonly account: ReviewedSeedAccountCarrier
  readonly publisherKeys: Readonly<Record<string, string>>
  readonly operatorKeys: Readonly<Record<string, string>>
  readonly submissionId: string
  readonly packageSha256: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** Bytes stay in Host memory. This is self-use review evidence, never installation or supply. */
export type PrivateExecutionAccessResult =
  | { readonly state: 'unknown'; readonly submissionId: string; readonly packageSha256: string }
  | { readonly state: 'claimed'; readonly accountId: string; readonly submissionId: string;
    readonly releaseId: string; readonly pluginId: string; readonly version: string;
    readonly packageSha256: string; readonly licenseId: string; readonly bytes: Buffer;
    readonly installable: false; readonly saleable: false; readonly dispatchable: false }

function invalid(): never { throw new Error('QIANSHOU_EXECUTION_ACCESS_INVALID') }
function unavailable(): never { throw new Error('QIANSHOU_EXECUTION_ACCESS_UNAVAILABLE') }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function signed(payload: string, signature: unknown, encodedKey: string | undefined): boolean {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)
    || Buffer.from(signature, 'base64').toString('base64') !== signature
    || encodedKey === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) return false
  try {
    const key = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch { return false }
}
async function currentAccount(account: ReviewedSeedAccountCarrier): Promise<string> {
  const snapshot = await account.snapshot()
  const id = snapshot.account?.id
  if ((snapshot.phase !== 'authenticated' && snapshot.phase !== 'refreshing')
    || typeof id !== 'string' || !ACCOUNT.test(id)) unavailable()
  return id
}
async function bounded(response: Response, maximum: number): Promise<Buffer> {
  if (response.status !== 200 || response.redirected || response.body === null
    || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
    || response.headers.get('content-encoding') !== null) {
    await response.body?.cancel().catch(() => undefined)
    invalid()
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared)
    || Number(declared) > maximum)) invalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maximum) invalid()
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  return Buffer.concat(chunks, total)
}
function candidateVerified(raw: unknown, accountId: string, submissionId: string,
  packageSha256: string, bytes: Buffer,
  request: Pick<PrivateExecutionAccessRequest, 'publisherKeys' | 'operatorKeys'>): {
    readonly releaseId: string; readonly pluginId: string; readonly version: string
  } {
  const candidate = object(raw)
  const publisher = object(candidate?.['publisher'])
  const approval = object(candidate?.['approval'])
  const artifact = verifyReviewableExecutionArtifact(bytes)
  const manifest = artifact.manifest
  const operations = manifest.operations.map(item => ({
    operationId: item.operationId, capabilityId: item.capabilityId,
    executorKind: 'qianshou.string-map.v1', implementationSha256: item.implementationSha256,
    inputSchemaSha256: sha(Buffer.from(JSON.stringify(item.inputSchema))),
    outputSchemaSha256: sha(Buffer.from(JSON.stringify(item.outputSchema))),
    permissions: [], requirements: item.requirements,
  }))
  const releaseId = `execution.${packageSha256}`
  const tree = sha(Buffer.from(JSON.stringify([['artifact.json', packageSha256]])))
  if (candidate === null || !exact(candidate, ['format', 'submissionId', 'accountId', 'publisherId',
    'pluginId', 'version', 'releaseId', 'title', 'summary', 'packageSha256', 'packageBytes',
    'unpackedTreeSha256', 'verificationScope', 'operations', 'publisher', 'approval',
    'installable', 'saleable', 'dispatchable'])
    || candidate['format'] !== 'qianshou.execution-release-candidate.v1'
    || candidate['submissionId'] !== submissionId || candidate['accountId'] !== accountId
    || typeof candidate['publisherId'] !== 'string' || !ID.test(candidate['publisherId'])
    || candidate['pluginId'] !== manifest.pluginId || candidate['version'] !== manifest.version
    || candidate['releaseId'] !== releaseId || candidate['packageSha256'] !== packageSha256
    || candidate['packageBytes'] !== bytes.length || candidate['unpackedTreeSha256'] !== tree
    || candidate['verificationScope'] !== 'self-contained-declarative-program'
    || JSON.stringify(candidate['operations']) !== JSON.stringify(operations)
    || candidate['installable'] !== false || candidate['saleable'] !== false
    || candidate['dispatchable'] !== false || publisher === null || approval === null
    || !exact(publisher, ['id', 'accountId', 'signature'])
    || publisher['id'] !== candidate['publisherId'] || publisher['accountId'] !== accountId
    || !exact(approval, ['reviewId', 'operatorId', 'operatorAccountId', 'reviewedAt', 'signature'])
    || typeof approval['reviewId'] !== 'string' || !UUID.test(approval['reviewId'])
    || typeof approval['operatorId'] !== 'string' || !ID.test(approval['operatorId'])
    || typeof approval['operatorAccountId'] !== 'string'
    || approval['operatorAccountId'].length < 1 || approval['operatorAccountId'].length > 128
    || approval['operatorAccountId'] === accountId
    || !Number.isSafeInteger(approval['reviewedAt']) || (approval['reviewedAt'] as number) < 1) invalid()
  const document = {
    format: candidate['format'], submissionId: candidate['submissionId'],
    accountId: candidate['accountId'], publisherId: candidate['publisherId'],
    pluginId: candidate['pluginId'], version: candidate['version'], releaseId: candidate['releaseId'],
    title: candidate['title'], summary: candidate['summary'], packageSha256: candidate['packageSha256'],
    packageBytes: candidate['packageBytes'], unpackedTreeSha256: candidate['unpackedTreeSha256'],
    verificationScope: candidate['verificationScope'], operations: candidate['operations'],
    installable: candidate['installable'], saleable: candidate['saleable'],
    dispatchable: candidate['dispatchable'],
  }
  const publisherKey = Object.hasOwn(request.publisherKeys, candidate['publisherId'])
    ? request.publisherKeys[candidate['publisherId']] : undefined
  const operatorKey = Object.hasOwn(request.operatorKeys, approval['operatorId'])
    ? request.operatorKeys[approval['operatorId']] : undefined
  if (!signed(`qianshou-execution-candidate-publisher-v1\n${JSON.stringify(document)}`,
    publisher['signature'], publisherKey)
    || !signed(`qianshou-execution-candidate-review-v1\n${JSON.stringify({ candidate: document,
      publisher: { id: publisher['id'], accountId: publisher['accountId'], signature: publisher['signature'] },
      reviewId: approval['reviewId'], operatorId: approval['operatorId'],
      operatorAccountId: approval['operatorAccountId'], reviewedAt: approval['reviewedAt'],
    })}`, approval['signature'], operatorKey)) invalid()
  return { releaseId, pluginId: manifest.pluginId, version: manifest.version }
}

/** A mine receipt carries the complete canonical manifest but no download entitlement. */
export function verifiedPrivateExecutionReview(value: unknown, submission: Record<string, unknown>,
  expected: { readonly accountId: string; readonly submissionId: string; readonly packageSha256: string;
    readonly packageBytes: number; readonly title: string; readonly summary: string },
  keys: Pick<PrivateExecutionAccessRequest, 'publisherKeys' | 'operatorKeys'>): boolean {
  const review = object(value)
  const manifest = object(submission['manifest'])
  if (review === null || manifest === null || review['status'] !== 'execution-candidate-reviewed'
    || review['title'] !== expected.title || review['summary'] !== expected.summary
    || review['packageBytes'] !== expected.packageBytes
    || review['unpackedTreeSha256'] !== submission['unpackedTreeSha256']) return false
  const candidate = { ...review }
  delete candidate['status']
  try {
    const bytes = Buffer.from(JSON.stringify(manifest))
    if (sha(bytes) !== expected.packageSha256 || bytes.length !== expected.packageBytes) return false
    candidateVerified(candidate, expected.accountId, expected.submissionId,
      expected.packageSha256, bytes, keys)
    return true
  } catch { return false }
}

/** Claim once and independently verify both signatures and every downloaded program byte.
 * @param request - Host-configured trust, current owner, and exact reviewed submission identity.
 * @returns Private in-memory trial bytes or an uncertain claim requiring explicit reconciliation.
 */
export async function claimPrivateExecutionCandidate(
  request: PrivateExecutionAccessRequest,
): Promise<PrivateExecutionAccessResult> {
  if (!UUID.test(request.submissionId) || !SHA256.test(request.packageSha256)) invalid()
  const timeoutMs = request.timeoutMs ?? 120_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) invalid()
  const signal = AbortSignal.any([request.signal ?? new AbortController().signal,
    AbortSignal.timeout(timeoutMs)])
  const accountId = await currentAccount(request.account)
  const access = await request.account.ensureAccessToken()
  if (access === null || !/^[\x21-\x7e]{16,4096}$/u.test(access)
    || await currentAccount(request.account) !== accountId) unavailable()
  const endpoint = new URL(PATH, marketApiUrl(request.apiBaseUrl))
  let claim: Response
  try {
    claim = await fetch(endpoint, { method: 'POST', signal, redirect: 'error', credentials: 'omit',
      cache: 'no-store', referrerPolicy: 'no-referrer', headers: {
        Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json',
      }, body: JSON.stringify({ action: 'claim', submissionId: request.submissionId,
        packageSha256: request.packageSha256 }) })
  } catch {
    if (await currentAccount(request.account) !== accountId) unavailable()
    return { state: 'unknown', submissionId: request.submissionId,
      packageSha256: request.packageSha256 }
  }
  let response: Record<string, unknown>
  try { response = object(JSON.parse((await bounded(claim, MAX_CLAIM_BYTES)).toString('utf8')) as unknown) ?? invalid() }
  catch { unavailable() }
  if (!exact(response, ['ok', 'releaseId', 'pluginId', 'version', 'packageSha256', 'candidate',
    'license', 'installable', 'saleable', 'dispatchable', 'download']) || response['ok'] !== true
    || response['releaseId'] !== `execution.${request.packageSha256}`
    || response['packageSha256'] !== request.packageSha256
    || response['installable'] !== false || response['saleable'] !== false
    || response['dispatchable'] !== false) invalid()
  const license = object(response['license'])
  const download = object(response['download'])
  if (license === null || !exact(license, ['format', 'licenseId', 'submissionId', 'accountId',
    'releaseId', 'packageSha256', 'grantedAt', 'scope'])
    || license['format'] !== 'qianshou.execution-self-license.v1'
    || typeof license['licenseId'] !== 'string' || !UUID.test(license['licenseId'])
    || license['submissionId'] !== request.submissionId || license['accountId'] !== accountId
    || license['releaseId'] !== response['releaseId']
    || license['packageSha256'] !== request.packageSha256
    || !Number.isSafeInteger(license['grantedAt']) || (license['grantedAt'] as number) < 1
    || license['scope'] !== 'self-use-review-candidate'
    || download === null || !exact(download, ['url', 'token', 'expiresAt'])
    || download['url'] !== `${PATH}?submission=${request.submissionId}&sha256=${request.packageSha256}`
    || typeof download['token'] !== 'string' || !TOKEN.test(download['token'])
    || !Number.isSafeInteger(download['expiresAt'])
    || (download['expiresAt'] as number) <= Date.now()
    || (download['expiresAt'] as number) > Date.now() + 15 * 60_000) invalid()
  const packageResponse = await fetch(new URL(download['url'], endpoint), {
    method: 'GET', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    referrerPolicy: 'no-referrer', headers: { Authorization: `Bearer ${download['token']}`,
      Accept: 'application/json' },
  })
  const bytes = await bounded(packageResponse, MAX_PACKAGE_BYTES)
  if (packageResponse.headers.get('x-qianshou-package-sha256') !== request.packageSha256
    || sha(bytes) !== request.packageSha256) invalid()
  const verified = candidateVerified(response['candidate'], accountId, request.submissionId,
    request.packageSha256, bytes, request)
  if (response['releaseId'] !== verified.releaseId || response['pluginId'] !== verified.pluginId
    || response['version'] !== verified.version
    || await currentAccount(request.account) !== accountId) invalid()
  return { state: 'claimed', accountId, submissionId: request.submissionId,
    releaseId: verified.releaseId, pluginId: verified.pluginId, version: verified.version,
    packageSha256: request.packageSha256, licenseId: license['licenseId'] as string,
    bytes, installable: false, saleable: false, dispatchable: false }
}
