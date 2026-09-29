/** A fail-closed, read-only projection for one reviewed plugin operation.
 *
 * This module has no production evidence adapters. The caller must obtain loader,
 * sample, license, owner and Shanghai facts from their respective authorities;
 * a model, market listing or saved draft must never construct those facts.
 */
import { createPublicKey, verify } from 'node:crypto'
import { parseSignedReleaseBody } from './release-preview.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const FRESH_RUNTIME_MS = 30_000
const FRESH_WORKER_MS = 60_000

/** Exact identity shared by the reviewed release, local runtime and one order. */
export interface PluginOperationIdentity {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly releaseId: string
  readonly packageSha256: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operationId: string
  readonly inputSchemaSha256: string
  readonly outputSchemaSha256: string
}

/** Separate operator approval of execution; today's opaque-archive review is insufficient. */
export interface SignedOperationReview {
  readonly format: 'qianshou.operation-execution-review.v1'
  readonly identity: PluginOperationIdentity
  readonly releaseReviewId: string
  readonly operatorId: string
  readonly reviewedAt: number
  readonly expiresAt: number
  readonly signature: string
}

/** Canonical bytes that a future Guangzhou operation-review authority must sign. */
export function operationReviewPayload(review: SignedOperationReview): string {
  const identity = review.identity
  return JSON.stringify({ format: review.format,
    identity: { pluginId: identity.pluginId, pluginVersion: identity.pluginVersion,
      releaseId: identity.releaseId, packageSha256: identity.packageSha256,
      capabilityId: identity.capabilityId, capabilityVersion: identity.capabilityVersion,
      operationId: identity.operationId, inputSchemaSha256: identity.inputSchemaSha256,
      outputSchemaSha256: identity.outputSchemaSha256 },
    releaseReviewId: review.releaseReviewId, operatorId: review.operatorId,
    reviewedAt: review.reviewedAt, expiresAt: review.expiresAt })
}

/** Host-owned facts. Each source remains independently revocable. */
export interface PluginOperationReadinessInput {
  readonly nowMs: number
  /** Required for an invite decision; public scope may be evaluated without a requester. */
  readonly requesterAccountId?: string
  readonly identity: PluginOperationIdentity
  readonly signedRelease: unknown
  readonly publisherKeys: Readonly<Record<string, string>>
  readonly operatorKeys: Readonly<Record<string, string>>
  readonly executionReview?: SignedOperationReview | null
  readonly installation?: {
    readonly identity: PluginOperationIdentity
    readonly state: 'active' | 'inactive'
    readonly observedAt: number
  } | null
  readonly executor?: {
    readonly identity: PluginOperationIdentity
    readonly state: 'active' | 'inactive'
    readonly observedAt: number
  } | null
  readonly sample?: {
    readonly identity: PluginOperationIdentity
    readonly status: 'passed' | 'failed'
    readonly checkedAt: number
    readonly validUntil: number
  } | null
  readonly license?: {
    readonly identity: PluginOperationIdentity
    readonly accountId: string
    readonly rights: readonly ('use' | 'serve')[]
    readonly validUntil: number
  } | null
  readonly owner?: {
    readonly accountId: string
    readonly nodeId: string
    readonly totalEnabled: boolean
    readonly policyVersion: string
    readonly grant: {
      readonly identity: PluginOperationIdentity
      readonly enabled: boolean
      readonly scope: 'private' | 'invite' | 'public'
      readonly inviteAccountIds: readonly string[]
    }
  } | null
  readonly worker?: {
    readonly accountId: string
    readonly nodeId: string
    readonly state: 'online' | 'offline'
    readonly observedAt: number
  } | null
  readonly shanghai?: {
    readonly identity: PluginOperationIdentity
    readonly accountId: string
    readonly nodeId: string
    readonly policyVersion: string
    readonly scope: 'invite' | 'public'
    readonly requesterAccountId?: string
    readonly state: 'accepted' | 'rejected'
    readonly validUntil: number
  } | null
}

export type PluginOperationReadinessReason =
  | 'INVALID_IDENTITY' | 'RELEASE_UNVERIFIED' | 'RELEASE_OPERATION_MISMATCH'
  | 'INSTALLATION_NOT_ACTIVE' | 'EXECUTOR_NOT_ACTIVE' | 'SAMPLE_NOT_HEALTHY'
  | 'SELF_USE_LICENSE_MISSING' | 'EXECUTION_REVIEW_MISSING' | 'EXECUTION_REVIEW_INVALID'
  | 'SERVE_LICENSE_MISSING' | 'OWNER_TOTAL_OFF' | 'OWNER_GRANT_MISSING'
  | 'PRIVATE_ONLY' | 'INVITEES_MISSING' | 'INVITEE_NOT_ALLOWED'
  | 'WORKER_NOT_ONLINE' | 'SHANGHAI_NOT_ACCEPTED'

/** A local answer, not a lease or permission to start an order. */
export interface PluginOperationReadiness {
  readonly identity: PluginOperationIdentity
  readonly selfUsable: boolean
  readonly scope: 'private' | 'invite' | 'public' | null
  readonly dispatchable: boolean
  readonly reasons: readonly PluginOperationReadinessReason[]
}

function same(a: PluginOperationIdentity | undefined | null, b: PluginOperationIdentity): boolean {
  return a !== undefined && a !== null && a.pluginId === b.pluginId && a.pluginVersion === b.pluginVersion
    && a.releaseId === b.releaseId && a.packageSha256 === b.packageSha256
    && a.capabilityId === b.capabilityId && a.capabilityVersion === b.capabilityVersion
    && a.operationId === b.operationId && a.inputSchemaSha256 === b.inputSchemaSha256
    && a.outputSchemaSha256 === b.outputSchemaSha256
}

function validIdentity(identity: unknown, nowMs: number): identity is PluginOperationIdentity {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || identity === null || typeof identity !== 'object') return false
  const item = identity as Record<string, unknown>
  return [item.pluginId, item.pluginVersion, item.releaseId, item.capabilityId,
    item.capabilityVersion, item.operationId].every(value =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    && [item.packageSha256, item.inputSchemaSha256, item.outputSchemaSha256].every(value =>
      typeof value === 'string' && SHA256.test(value))
}

function validThrough(until: number, now: number): boolean {
  return Number.isSafeInteger(until) && until > now
}

function fresh(observedAt: number, now: number, maximumAge: number): boolean {
  return Number.isSafeInteger(observedAt) && observedAt <= now && now - observedAt <= maximumAge
}

function reviewedExecution(input: PluginOperationReadinessInput, releaseReviewId: string,
  publisherId: string): boolean {
  const review = input.executionReview
  if (review?.format !== 'qianshou.operation-execution-review.v1'
    || !same(review.identity, input.identity) || review.releaseReviewId !== releaseReviewId
    || !Number.isSafeInteger(review.reviewedAt) || review.reviewedAt < 1 || review.reviewedAt > input.nowMs
    || !validThrough(review.expiresAt, input.nowMs)
    || typeof review.operatorId !== 'string'
    || typeof review.signature !== 'string') return false
  const operatorKey = input.operatorKeys[review.operatorId]
  if (operatorKey === undefined) return false
  try {
    const key = createPublicKey({ key: Buffer.from(operatorKey, 'base64'),
      format: 'der', type: 'spki' })
    const publisherKey = input.publisherKeys[publisherId]
    if (publisherKey === undefined || Buffer.from(publisherKey, 'base64').equals(Buffer.from(operatorKey, 'base64'))) return false
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(operationReviewPayload(review)), key, Buffer.from(review.signature, 'base64'))
  } catch { return false }
}

/** Compute readiness from independent Host evidence; missing/stale/mismatched facts deny orders. */
export function projectPluginOperationReadiness(input: PluginOperationReadinessInput): PluginOperationReadiness {
  const reasons: PluginOperationReadinessReason[] = []
  const id = input.identity
  if (!validIdentity(id, input.nowMs)) return Object.freeze({ identity: id, selfUsable: false,
    scope: null, dispatchable: false, reasons: Object.freeze(['INVALID_IDENTITY' as const]) })
  let releaseReviewId = ''
  let releasePublisherId = ''
  let releaseOperation = false
  try {
    const releases = parseSignedReleaseBody({ releases: [input.signedRelease] },
      input.publisherKeys, input.operatorKeys)
    const release = releases?.[0]
    if (!release) reasons.push('RELEASE_UNVERIFIED')
    else {
      releaseReviewId = release.approval.reviewId
      releasePublisherId = release.publisher.id
      releaseOperation = release.pluginId === id.pluginId && release.version === id.pluginVersion
        && release.releaseId === id.releaseId && release.packageSha256 === id.packageSha256
        && release.operations.some(operation => operation.capabilityId === id.capabilityId
          && operation.operationId === id.operationId
          && operation.inputSchemaSha256 === id.inputSchemaSha256
          && operation.outputSchemaSha256 === id.outputSchemaSha256)
      if (!releaseOperation) reasons.push('RELEASE_OPERATION_MISMATCH')
    }
  } catch { reasons.push('RELEASE_UNVERIFIED') }

  if (input.installation?.state !== 'active' || !same(input.installation.identity, id)
    || !fresh(input.installation.observedAt, input.nowMs, FRESH_RUNTIME_MS)) reasons.push('INSTALLATION_NOT_ACTIVE')
  if (input.executor?.state !== 'active' || !same(input.executor.identity, id)
    || !fresh(input.executor.observedAt, input.nowMs, FRESH_RUNTIME_MS)) reasons.push('EXECUTOR_NOT_ACTIVE')
  if (input.sample?.status !== 'passed' || !same(input.sample.identity, id)
    || !Number.isSafeInteger(input.sample.checkedAt) || input.sample.checkedAt > input.nowMs
    || !validThrough(input.sample.validUntil, input.nowMs)) reasons.push('SAMPLE_NOT_HEALTHY')

  const owner = input.owner
  const license = input.license
  const licenseMatches = !!owner && !!license && same(license.identity, id)
    && license.accountId === owner.accountId && validThrough(license.validUntil, input.nowMs)
  if (!licenseMatches || !Array.isArray(license.rights) || !license.rights.includes('use')) reasons.push('SELF_USE_LICENSE_MISSING')
  const selfUsable = !reasons.some(reason => [
    'INVALID_IDENTITY', 'RELEASE_UNVERIFIED', 'RELEASE_OPERATION_MISMATCH',
    'INSTALLATION_NOT_ACTIVE', 'EXECUTOR_NOT_ACTIVE', 'SAMPLE_NOT_HEALTHY',
    'SELF_USE_LICENSE_MISSING',
  ].includes(reason))

  if (!input.executionReview) reasons.push('EXECUTION_REVIEW_MISSING')
  else if (!releaseOperation || !reviewedExecution(input, releaseReviewId, releasePublisherId)) reasons.push('EXECUTION_REVIEW_INVALID')
  if (!licenseMatches || !Array.isArray(license.rights) || !license.rights.includes('serve')) reasons.push('SERVE_LICENSE_MISSING')
  if (!owner?.totalEnabled) reasons.push('OWNER_TOTAL_OFF')
  if (!owner?.grant.enabled || !same(owner.grant.identity, id)) reasons.push('OWNER_GRANT_MISSING')
  const scope = owner?.grant.scope ?? null
  if (scope !== 'private' && scope !== 'invite' && scope !== 'public') reasons.push('OWNER_GRANT_MISSING')
  if (scope === 'private') reasons.push('PRIVATE_ONLY')
  if (scope === 'invite' && (!Array.isArray(owner?.grant.inviteAccountIds)
    || owner.grant.inviteAccountIds.length === 0)) reasons.push('INVITEES_MISSING')
  if (scope === 'invite' && (!input.requesterAccountId
    || !Array.isArray(owner?.grant.inviteAccountIds)
    || !owner.grant.inviteAccountIds.includes(input.requesterAccountId))) reasons.push('INVITEE_NOT_ALLOWED')
  const worker = input.worker
  if (!owner || !worker || worker.accountId !== owner.accountId || worker.nodeId !== owner.nodeId
    || worker.state !== 'online' || !fresh(worker.observedAt, input.nowMs, FRESH_WORKER_MS)) {
    reasons.push('WORKER_NOT_ONLINE')
  }
  const shanghai = input.shanghai
  if (!owner || !shanghai || !same(shanghai.identity, id) || shanghai.accountId !== owner.accountId
    || shanghai.nodeId !== owner.nodeId || shanghai.policyVersion !== owner.policyVersion
    || shanghai.scope !== scope || shanghai.state !== 'accepted'
    || (scope === 'invite' && shanghai.requesterAccountId !== input.requesterAccountId)
    || !validThrough(shanghai.validUntil, input.nowMs)) reasons.push('SHANGHAI_NOT_ACCEPTED')
  return Object.freeze({ identity: id, selfUsable, scope,
    dispatchable: selfUsable && (scope === 'invite' || scope === 'public') && reasons.length === 0,
    reasons: Object.freeze(reasons) })
}
