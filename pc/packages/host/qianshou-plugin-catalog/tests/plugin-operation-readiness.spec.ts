import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { approvalPayload, releasePayload } from '../src/release-preview.ts'
import { operationReviewPayload, projectPluginOperationReadiness,
  type PluginOperationIdentity, type PluginOperationReadinessInput,
  type SignedOperationReview } from '../src/plugin-operation-readiness.ts'

const publisher = generateKeyPairSync('ed25519')
const reviewer = generateKeyPairSync('ed25519')
const publisherKeys = { studio: publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const operatorKeys = { reviewer: reviewer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const nowMs = 1_800_000_000_000
const identity: PluginOperationIdentity = {
  pluginId: 'author.workflow', pluginVersion: '1.0.0', releaseId: 'release-1',
  packageSha256: 'a'.repeat(64), capabilityId: 'image.product.render',
  capabilityVersion: '1.0.0', operationId: 'render',
  inputSchemaSha256: 'b'.repeat(64), outputSchemaSha256: 'c'.repeat(64),
}

function signedRelease() {
  const release = { pluginId: identity.pluginId, version: identity.pluginVersion,
    releaseId: identity.releaseId, title: 'Image workflow', summary: 'Review-only test release',
    packageSha256: identity.packageSha256, packageBytes: 1024,
    platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
    operations: [{ capabilityId: identity.capabilityId, operationId: identity.operationId,
      executorKind: 'workflow', inputSchemaSha256: identity.inputSchemaSha256,
      outputSchemaSha256: identity.outputSchemaSha256, permissions: ['gpu'] }],
    publisher: { id: 'studio', signature: '' },
    approval: { reviewId: 'release-review-1', reviewedAt: nowMs - 10_000,
      operatorId: 'reviewer', signature: '' },
    verificationScope: 'opaque-archive-bytes', installable: false }
  release.publisher.signature = sign(null, Buffer.from(releasePayload(release as never)), publisher.privateKey).toString('base64')
  release.approval.signature = sign(null, Buffer.from(approvalPayload(release as never)), reviewer.privateKey).toString('base64')
  return release
}

function executionReview(): SignedOperationReview {
  const review: SignedOperationReview = { format: 'qianshou.operation-execution-review.v1', identity,
    releaseReviewId: 'release-review-1', operatorId: 'reviewer', reviewedAt: nowMs - 5_000,
    expiresAt: nowMs + 60_000, signature: '' }
  return { ...review, signature: sign(null, Buffer.from(operationReviewPayload(review)), reviewer.privateKey).toString('base64') }
}

function complete(): PluginOperationReadinessInput {
  return { nowMs, identity, signedRelease: signedRelease(), publisherKeys, operatorKeys,
    executionReview: executionReview(),
    installation: { identity, state: 'active', observedAt: nowMs - 1_000 },
    executor: { identity, state: 'active', observedAt: nowMs - 1_000 },
    sample: { identity, status: 'passed', checkedAt: nowMs - 5_000, validUntil: nowMs + 60_000 },
    license: { identity, accountId: 'owner-1', rights: ['use', 'serve'], validUntil: nowMs + 60_000 },
    owner: { accountId: 'owner-1', nodeId: 'node-1', totalEnabled: true, policyVersion: 'policy-1',
      grant: { identity, enabled: true, scope: 'public', inviteAccountIds: [] } },
    worker: { accountId: 'owner-1', nodeId: 'node-1', state: 'online', observedAt: nowMs - 1_000 },
    shanghai: { identity, accountId: 'owner-1', nodeId: 'node-1', policyVersion: 'policy-1',
      scope: 'public', state: 'accepted', validUntil: nowMs + 30_000 } }
}

it('requires a separate signed operation review beyond an opaque reviewed release', () => {
  const facts = complete()
  expect(projectPluginOperationReadiness({ ...facts, executionReview: null })).toMatchObject({
    selfUsable: true, dispatchable: false, reasons: ['EXECUTION_REVIEW_MISSING'] })
  const tampered = { ...facts.executionReview!, identity: { ...identity, operationId: 'another' } }
  expect(projectPluginOperationReadiness({ ...facts, executionReview: tampered }).reasons)
    .toContain('EXECUTION_REVIEW_INVALID')
  expect(projectPluginOperationReadiness(facts)).toMatchObject({
    selfUsable: true, scope: 'public', dispatchable: true, reasons: [] })
})

it('does not turn any single directory, purchase, draft, install, publication or online fact into an order', () => {
  const facts = complete()
  const base = { nowMs, identity, signedRelease: facts.signedRelease, publisherKeys, operatorKeys }
  const loneFacts: ReadonlyArray<[string, Partial<PluginOperationReadinessInput>]> = [
    ['directory', { signedRelease: facts.signedRelease }],
    ['purchase', { license: facts.license! }],
    ['draft', { owner: { ...facts.owner!, totalEnabled: false } }],
    ['installed', { installation: facts.installation! }],
    ['published', { executionReview: facts.executionReview! }],
    ['online', { worker: facts.worker! }],
  ]
  for (const [name, one] of loneFacts) {
    const projected = projectPluginOperationReadiness({ ...base, ...one })
    expect(projected.dispatchable, name).toBe(false)
    expect(projected.reasons.length, name).toBeGreaterThan(0)
  }
})

it('separates local private use from invite and public order scope', () => {
  const facts = complete()
  const privateOwner = { ...facts.owner!, grant: { ...facts.owner!.grant, scope: 'private' as const } }
  const local = projectPluginOperationReadiness({ ...facts, owner: privateOwner, shanghai: null })
  expect(local).toMatchObject({ selfUsable: true, scope: 'private', dispatchable: false })
  expect(local.reasons).toContain('PRIVATE_ONLY')
  const inviteOwner = { ...facts.owner!, grant: { ...facts.owner!.grant, scope: 'invite' as const } }
  const inviteShanghai = { ...facts.shanghai!, scope: 'invite' as const, requesterAccountId: 'buyer-1' }
  expect(projectPluginOperationReadiness({ ...facts, owner: inviteOwner, shanghai: inviteShanghai }).reasons)
    .toContain('INVITEES_MISSING')
  expect(projectPluginOperationReadiness({ ...facts, owner: { ...inviteOwner,
    grant: { ...inviteOwner.grant, inviteAccountIds: ['buyer-1'] } },
  shanghai: inviteShanghai }).reasons).toContain('INVITEE_NOT_ALLOWED')
  expect(projectPluginOperationReadiness({ ...facts, requesterAccountId: 'buyer-1', owner: { ...inviteOwner,
    grant: { ...inviteOwner.grant, inviteAccountIds: ['buyer-1'] } },
  shanghai: inviteShanghai })).toMatchObject({ scope: 'invite', dispatchable: true })
})

it('revokes readiness on exact package, executor, schema, sample, license, owner or server mismatch', () => {
  const facts = complete()
  const changed = { ...identity, packageSha256: 'd'.repeat(64) }
  const cases: ReadonlyArray<[string, Partial<PluginOperationReadinessInput>, string]> = [
    ['package', { installation: { identity: changed, state: 'active', observedAt: nowMs } }, 'INSTALLATION_NOT_ACTIVE'],
    ['executor version', { executor: { identity: { ...identity, capabilityVersion: '2.0.0' }, state: 'active', observedAt: nowMs } }, 'EXECUTOR_NOT_ACTIVE'],
    ['runtime stale', { executor: { ...facts.executor!, observedAt: nowMs - 31_000 } }, 'EXECUTOR_NOT_ACTIVE'],
    ['schema', { sample: { ...facts.sample!, identity: { ...identity, inputSchemaSha256: 'd'.repeat(64) } } }, 'SAMPLE_NOT_HEALTHY'],
    ['sample expired', { sample: { ...facts.sample!, validUntil: nowMs } }, 'SAMPLE_NOT_HEALTHY'],
    ['license expired', { license: { ...facts.license!, validUntil: nowMs } }, 'SELF_USE_LICENSE_MISSING'],
    ['total off', { owner: { ...facts.owner!, totalEnabled: false } }, 'OWNER_TOTAL_OFF'],
    ['grant off', { owner: { ...facts.owner!, grant: { ...facts.owner!.grant, enabled: false } } }, 'OWNER_GRANT_MISSING'],
    ['worker stale', { worker: { ...facts.worker!, observedAt: nowMs - 61_000 } }, 'WORKER_NOT_ONLINE'],
    ['server policy stale', { shanghai: { ...facts.shanghai!, policyVersion: 'old' } }, 'SHANGHAI_NOT_ACCEPTED'],
  ]
  for (const [name, patch, reason] of cases) {
    const result = projectPluginOperationReadiness({ ...facts, ...patch })
    expect(result.dispatchable, name).toBe(false)
    expect(result.reasons, name).toContain(reason)
  }
})

it('fails closed on a tampered release and on an invalid identity', () => {
  const facts = complete()
  expect(projectPluginOperationReadiness({ ...facts,
    signedRelease: { ...(facts.signedRelease as object), title: 'tampered' } }).reasons)
    .toContain('RELEASE_UNVERIFIED')
  expect(projectPluginOperationReadiness({ ...facts, nowMs: Number.NaN })).toMatchObject({
    selfUsable: false, dispatchable: false, reasons: ['INVALID_IDENTITY'] })
})
