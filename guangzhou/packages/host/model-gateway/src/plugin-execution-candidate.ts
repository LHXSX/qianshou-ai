/** Dual-signed review evidence for a self-contained program; it grants no install or sale right. */
import { createPublicKey, verify } from 'node:crypto'
import type { VerifiedReviewableExecutionPackage } from './plugin-reviewable-execution.ts'

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u

export interface ExecutionCandidateSubmission {
  readonly submissionId: string
  readonly accountId: string
  readonly publisherId: string
  readonly title: string
  readonly summary: string
  readonly submittedAt: number
  readonly packageSha256: string
  readonly packageBytes: number
  readonly unpackedTreeSha256: string
}

/** The reviewed, immutable candidate is intentionally outside the public release registry. */
export interface PluginExecutionCandidate {
  readonly format: 'qianshou.execution-release-candidate.v1'
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
  readonly verificationScope: 'self-contained-declarative-program'
  readonly operations: VerifiedReviewableExecutionPackage['operations']
  readonly publisher: { readonly id: string; readonly accountId: string; readonly signature: string }
  readonly approval: { readonly reviewId: string; readonly operatorId: string;
    readonly operatorAccountId: string; readonly reviewedAt: number; readonly signature: string }
  readonly installable: false
  readonly saleable: false
  readonly dispatchable: false
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function only(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}
function signature(raw: unknown): raw is string {
  return typeof raw === 'string' && SIGNATURE.test(raw)
    && Buffer.from(raw, 'base64').toString('base64') === raw
}
function signedBy(payload: string, signatureBase64: string, key: string | undefined): boolean {
  if (key === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) return false
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    return publicKey.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signatureBase64, 'base64'))
  } catch { return false }
}

/** Stable publisher signature bytes, including account, exact program and every operation proof.
 * @param candidate - Candidate fields; signature fields are ignored.
 * @returns Domain-separated canonical payload.
 */
function publisherDocument(candidate: PluginExecutionCandidate): Record<string, unknown> {
  const { format, submissionId, accountId, publisherId, pluginId, version, releaseId, title, summary,
    packageSha256, packageBytes, unpackedTreeSha256, verificationScope, operations,
    installable, saleable, dispatchable } = candidate
  return { format, submissionId, accountId,
    publisherId, pluginId, version, releaseId, title, summary, packageSha256, packageBytes,
    unpackedTreeSha256, verificationScope, operations, installable, saleable, dispatchable }
}
export function pluginExecutionPublisherPayload(candidate: PluginExecutionCandidate): string {
  return `qianshou-execution-candidate-publisher-v1\n${JSON.stringify(publisherDocument(candidate))}`
}

/** Stable reviewer signature bytes bind the publisher proof and reviewer account.
 * @param candidate - Candidate with publisher proof and review identity.
 * @returns Domain-separated canonical payload.
 */
export function pluginExecutionApprovalPayload(candidate: PluginExecutionCandidate): string {
  return `qianshou-execution-candidate-review-v1\n${JSON.stringify({
    candidate: publisherDocument(candidate),
    publisher: candidate.publisher, reviewId: candidate.approval.reviewId,
    operatorId: candidate.approval.operatorId, operatorAccountId: candidate.approval.operatorAccountId,
    reviewedAt: candidate.approval.reviewedAt,
  })}`
}

/** Validate both signatures against independently observed archive content and account bindings.
 * @param raw - Untrusted candidate JSON.
 * @param submission - Account-bound intake record.
 * @param verified - Fresh, independent inspection of the stored program bytes.
 * @param keys - Trusted publisher and reviewer Ed25519 public keys.
 * @returns Exact signed candidate, or null when any field differs.
 */
export function validateExecutionCandidate(raw: unknown, submission: ExecutionCandidateSubmission,
  verified: VerifiedReviewableExecutionPackage,
  keys: { readonly publisherKeys?: Readonly<Record<string, string>>;
    readonly operatorKeys?: Readonly<Record<string, string>> }): PluginExecutionCandidate | null {
  const row = record(raw)
  if (row === null || !only(row, ['format', 'submissionId', 'accountId', 'publisherId', 'pluginId',
    'version', 'releaseId', 'title', 'summary', 'packageSha256', 'packageBytes',
    'unpackedTreeSha256', 'verificationScope', 'operations', 'publisher', 'approval',
    'installable', 'saleable', 'dispatchable'])
    || row['format'] !== 'qianshou.execution-release-candidate.v1'
    || row['submissionId'] !== submission.submissionId
    || row['accountId'] !== submission.accountId || row['publisherId'] !== submission.publisherId
    || row['pluginId'] !== verified.manifest.pluginId || row['version'] !== verified.manifest.version
    || row['releaseId'] !== `execution.${verified.packageSha256}`
    || row['title'] !== submission.title || row['summary'] !== submission.summary
    || row['packageSha256'] !== verified.packageSha256 || row['packageBytes'] !== verified.packageBytes
    || row['unpackedTreeSha256'] !== verified.unpackedTreeSha256
    || row['verificationScope'] !== 'self-contained-declarative-program'
    || JSON.stringify(row['operations']) !== JSON.stringify(verified.operations)
    || row['installable'] !== false || row['saleable'] !== false || row['dispatchable'] !== false) return null
  const publisher = record(row['publisher'])
  const approval = record(row['approval'])
  if (publisher === null || !only(publisher, ['id', 'accountId', 'signature'])
    || publisher['id'] !== submission.publisherId || publisher['accountId'] !== submission.accountId
    || !signature(publisher['signature'])
    || approval === null || !only(approval, ['reviewId', 'operatorId', 'operatorAccountId', 'reviewedAt', 'signature'])
    || typeof approval['reviewId'] !== 'string' || !UUID.test(approval['reviewId'])
    || typeof approval['operatorId'] !== 'string' || !ID.test(approval['operatorId'])
    || typeof approval['operatorAccountId'] !== 'string' || approval['operatorAccountId'].length < 1
    || approval['operatorAccountId'].length > 128
    || approval['operatorAccountId'] === submission.accountId
    || typeof approval['reviewedAt'] !== 'number' || !Number.isSafeInteger(approval['reviewedAt'])
    || approval['reviewedAt'] < submission.submittedAt || !signature(approval['signature'])) return null
  const candidate = row as unknown as PluginExecutionCandidate
  const publisherKey = Object.hasOwn(keys.publisherKeys ?? {}, submission.publisherId)
    ? keys.publisherKeys?.[submission.publisherId] : undefined
  const operatorKey = Object.hasOwn(keys.operatorKeys ?? {}, candidate.approval.operatorId)
    ? keys.operatorKeys?.[candidate.approval.operatorId] : undefined
  return signedBy(pluginExecutionPublisherPayload(candidate), candidate.publisher.signature, publisherKey)
    && signedBy(pluginExecutionApprovalPayload(candidate), candidate.approval.signature, operatorKey)
    ? candidate : null
}
