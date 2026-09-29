import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPluginFreeLicenseService, PLUGIN_LICENSE_PATH } from '../src/plugin-license.ts'
import { createPluginLicenseBearerVerifier, PLUGIN_LICENSE_BEARER_PATH } from '../src/plugin-license-bearer.ts'
import { pluginApprovalPayload, pluginReleasePayload, createPluginReleasesRoute,
  PLUGIN_RELEASES_PATH } from '../src/plugin-releases.ts'
import { verifySeedPluginPackage } from '../src/plugin-seed-package.ts'
import { createPluginSubmissionRoute, pluginRejectionPayload } from '../src/plugin-submissions.ts'

const fixturePath = new URL('./fixtures/qianshou.csv-profile-1.0.0.qspkg', import.meta.url)
const publisher = generateKeyPairSync('ed25519')
const otherPublisher = generateKeyPairSync('ed25519')
const operator = generateKeyPairSync('ed25519')
const publicKey = pair => pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const publisherId = 'qianshou-official'
const otherPublisherId = 'other-creator'
const operatorId = 'reviewer-seven'
const creator = { accountId: 'creator-account-42', role: 'personal', isAdmin: false }
const otherCreator = { accountId: 'creator-account-43', role: 'personal', isAdmin: false }
const admin = { accountId: 'reviewer-account-7', role: 'admin', isAdmin: true }

function approved(seed, title, summary) {
  const base = {
    pluginId: seed.manifest.pluginId, version: seed.manifest.version, releaseId: seed.manifest.releaseId,
    title, summary, packageSha256: seed.packageSha256, packageBytes: seed.packageBytes,
    platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
    operations: [{ capabilityId: seed.manifest.capabilityId, operationId: seed.manifest.operationId,
      executorKind: 'node', inputSchemaSha256: seed.inputSchemaSha256,
      outputSchemaSha256: seed.outputSchemaSha256, permissions: [] }],
  }
  const release = { ...base, publisher: { id: publisherId,
    signature: sign(null, Buffer.from(pluginReleasePayload(base)), publisher.privateKey).toString('base64') },
    approval: { reviewId: 'review-csv-1', reviewedAt: 1780000000000, operatorId }, installable: false }
  release.approval.signature = sign(null, Buffer.from(pluginApprovalPayload(release)), operator.privateKey).toString('base64')
  return release
}

function signedRejection(submission, note, changed = {}) {
  const receipt = { submissionId: submission.submissionId, packageSha256: submission.packageSha256,
    reviewId: randomUUID(), operatorId, operatorAccountId: admin.accountId,
    reviewedAt: submission.submittedAt, note, ...changed }
  return { ...receipt, signature: sign(null, Buffer.from(pluginRejectionPayload(receipt)),
    operator.privateKey).toString('base64') }
}

function post(handler, body) {
  return handler(new Request(`https://example.test${PLUGIN_LICENSE_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}

function postBearer(handler, body, token = 'mac-owner-access-token-0000000001') {
  return handler(new Request(`https://guangzhou.example${PLUGIN_LICENSE_BEARER_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }))
}

test('the actual Mac seed ZIP has fixed manifest/schema bytes and rejects one changed byte', async () => {
  const archive = await readFile(fixturePath)
  const seed = verifySeedPluginPackage(archive)
  assert.equal(seed.packageSha256, '257064f2a39b3b5bf4a410bebfba138af769bf4e1a7a23054b3aa31ca993f480')
  assert.equal(seed.packageBytes, 3058)
  assert.equal(seed.manifest.executorId, 'qianshou.csv-profile.adapter.v1')
  assert.equal(seed.inputSchemaSha256, 'a7889e85c462a9d0670d2fb7d79e9a5ebefceba8e978bde8bc2e22184f07ab39')
  const changed = Buffer.from(archive)
  changed[100] ^= 1
  assert.throws(() => verifySeedPluginPackage(changed))
})

test('verified submitter, independent reviewer, free claim, and scoped download reach the same immutable bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-seed-flow-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  const registryPath = join(root, 'releases.json')
  const ledgerPath = join(root, 'licenses.json')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  const archive = await readFile(fixturePath)
  const seed = verifySeedPluginPackage(archive)
  const title = 'CSV 数据体检'
  const summary = '离线统计 CSV 的列和样例，不读写工作区。'
  const release = approved(seed, title, summary)
  const releaseOptions = { registryPath, artifactDir,
    publisherKeys: { [publisherId]: publicKey(publisher), [otherPublisherId]: publicKey(otherPublisher) },
    operatorKeys: { [operatorId]: publicKey(operator) } }
  let principal = null
  let time = 1780000001000
  const authenticate = async () => principal
  const submit = createPluginSubmissionRoute({ stagingDir, releaseOptions,
    publisherAccounts: { [publisherId]: creator.accountId, [otherPublisherId]: otherCreator.accountId },
    operatorAccounts: { [operatorId]: admin.accountId },
    authenticate, now: () => time })
  const license = createPluginFreeLicenseService({ ledgerPath, releaseOptions,
    freeReleaseIds: [seed.manifest.releaseId], authenticate, now: () => time })
  const releaseRoute = createPluginReleasesRoute({ ...releaseOptions,
    authorizeLicensedArtifact: license.authorizeArtifact })
  const server = createServer((request, response) => void releaseRoute.handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}${PLUGIN_RELEASES_PATH}`
  try {
    const anonymous = await post(license.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal(anonymous.status, 401)
    principal = creator
    const wrongPublisher = await post(submit, { action: 'submit', publisherId: 'another-publisher', title, summary,
      archiveBase64: archive.toString('base64') })
    assert.equal(wrongPublisher.status, 403)
    const brokenArchive = Buffer.from(archive)
    brokenArchive[100] ^= 1
    const malformed = await post(submit, { action: 'submit', publisherId, title, summary,
      archiveBase64: brokenArchive.toString('base64') })
    assert.equal(malformed.status, 400)
    const submittedResponse = await post(submit, { action: 'submit', publisherId, title, summary,
      archiveBase64: archive.toString('base64') })
    assert.equal(submittedResponse.status, 200)
    const submitted = await submittedResponse.json()
    assert.equal(submitted.submission.accountId, creator.accountId)
    assert.match(submitted.submission.unpackedTreeSha256, /^[0-9a-f]{64}$/u)
    const priorClaim = await post(license.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal(priorClaim.status, 503)
    const creatorApproval = await post(submit, { action: 'approve', submissionId: submitted.submission.submissionId, release })
    assert.equal(creatorApproval.status, 403)
    principal = admin
    const forged = structuredClone(release)
    forged.operations[0].permissions = ['network.declared']
    const rejected = await post(submit, { action: 'approve', submissionId: submitted.submission.submissionId,
      release: forged })
    assert.equal(rejected.status, 400)
    const approvedResponse = await post(submit, { action: 'approve', submissionId: submitted.submission.submissionId,
      release })
    assert.equal(approvedResponse.status, 200)
    const receipt = await approvedResponse.json()
    assert.equal(receipt.releaseId, seed.manifest.releaseId)
    assert.equal(receipt.submittedBy, creator.accountId)
    const duplicate = await post(submit, { action: 'approve', submissionId: submitted.submission.submissionId,
      release })
    assert.equal(duplicate.status, 409)
    principal = otherCreator
    const unreviewedResponse = await post(submit, { action: 'submit', publisherId: otherPublisherId,
      title, summary, archiveBase64: archive.toString('base64') })
    assert.equal(unreviewedResponse.status, 200)
    const unreviewed = (await unreviewedResponse.json()).submission
    const otherMine = await post(submit, { action: 'mine' })
    assert.equal((await otherMine.json()).submissions[0].review.status, 'pending')
    principal = creator
    const changedTitle = (await (await post(submit, { action: 'submit', publisherId,
      title: 'Changed title', summary, archiveBase64: archive.toString('base64') })).json()).submission
    const changedSummary = (await (await post(submit, { action: 'submit', publisherId,
      title, summary: 'Changed summary', archiveBase64: archive.toString('base64') })).json()).submission
    const creatorMine = await post(submit, { action: 'mine' })
    const creatorReviews = (await creatorMine.json()).submissions
    assert.equal(creatorReviews.find(item => item.submissionId === changedTitle.submissionId).review.status, 'pending')
    assert.equal(creatorReviews.find(item => item.submissionId === changedSummary.submissionId).review.status, 'pending')
    principal = admin
    const pendingOther = await post(submit, { action: 'pending' })
    assert.deepEqual((await pendingOther.json()).submissions.map(item => item.submissionId).sort(),
      [unreviewed.submissionId, changedTitle.submissionId, changedSummary.submissionId].sort())
    const otherRejection = await post(submit, { action: 'reject', submissionId: unreviewed.submissionId,
      rejection: signedRejection(unreviewed, '这个发布者的投稿尚未审核') })
    assert.equal(otherRejection.status, 200)
    const lateRejection = await post(submit, { action: 'reject', submissionId: submitted.submission.submissionId,
      rejection: signedRejection(submitted.submission, '已经批准的版本不能撤销为拒绝') })
    assert.equal(lateRejection.status, 409)
    const metadata = await fetch(url)
    assert.equal(metadata.status, 200)
    const releases = await metadata.json()
    assert.equal(releases.releases[0].installable, false)
    assert.equal(releases.releases[0].packageSha256, seed.packageSha256)
    const withoutLicense = await fetch(`${url}?artifact=${seed.manifest.releaseId}`)
    assert.equal(withoutLicense.status, 403)
    principal = creator
    const grantedResponse = await post(license.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal(grantedResponse.status, 200)
    const granted = await grantedResponse.json()
    assert.equal(granted.license.accountId, creator.accountId)
    assert.equal(granted.license.kind, 'free')
    assert.equal(granted.packageSha256, seed.packageSha256)
    assert.equal(granted.download.url, `${PLUGIN_RELEASES_PATH}?artifact=${seed.manifest.releaseId}`)
    assert.equal(granted.download.expiresAt, time + 5 * 60 * 1000)
    const fetched = await fetch(new URL(granted.download.url, url), {
      headers: { authorization: `Bearer ${granted.download.token}` },
    })
    assert.equal(fetched.status, 200)
    assert.equal(fetched.headers.get('x-qianshou-package-sha256'), seed.packageSha256)
    const bytes = Buffer.from(await fetched.arrayBuffer())
    assert.ok(bytes.equals(archive))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), seed.packageSha256)
    const again = await post(license.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal((await again.json()).license.licenseId, granted.license.licenseId)
    let unavailable = false
    const bearerVerifier = createPluginLicenseBearerVerifier({ accountApiOrigin: 'https://account.example',
      fetcher: async (_url, init) => {
        if (unavailable) throw new Error('private outage detail')
        if (init.headers.authorization.includes('revoked')) return Response.json({ ok: false }, { status: 401 })
        return Response.json({ ok: true, account: { id: 167, role: 'personal' } })
      } })
    const macLicense = createPluginFreeLicenseService({ ledgerPath, releaseOptions,
      freeReleaseIds: [seed.manifest.releaseId], authenticate: bearerVerifier, now: () => time })
    // A different browser session must not affect request-bound Mac identity.
    principal = admin
    const beforeCheck = await readFile(ledgerPath)
    const checked = await postBearer(macLicense.handler, { action: 'check' })
    assert.equal(checked.status, 200)
    assert.deepEqual(await checked.json(), { ok: true, accountId: '167', authMode: 'bearer-request-bound' })
    assert.ok((await readFile(ledgerPath)).equals(beforeCheck))
    const macClaimResponse = await postBearer(macLicense.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal(macClaimResponse.status, 200)
    const macClaim = await macClaimResponse.json()
    assert.equal(macClaim.license.accountId, '167')
    assert.notEqual(macClaim.license.licenseId, granted.license.licenseId)
    const macAgain = await postBearer(macLicense.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal((await macAgain.json()).license.licenseId, macClaim.license.licenseId)
    const revoked = await postBearer(macLicense.handler, { action: 'claim', releaseId: seed.manifest.releaseId },
      'revoked-access-token-0000000000000001')
    assert.equal(revoked.status, 401)
    const forgedAccount = await postBearer(macLicense.handler,
      { action: 'claim', releaseId: seed.manifest.releaseId, accountId: admin.accountId })
    assert.equal(forgedAccount.status, 400)
    unavailable = true
    const outage = await postBearer(macLicense.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal(outage.status, 503)
    assert.equal((await outage.json()).code, 'ACCOUNT_VERIFICATION_UNAVAILABLE')
    principal = creator
    const restarted = createPluginFreeLicenseService({ ledgerPath, releaseOptions,
      freeReleaseIds: [seed.manifest.releaseId], authenticate, now: () => time })
    const afterRestart = await post(restarted.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal((await afterRestart.json()).license.licenseId, granted.license.licenseId)
    principal = null
    const afterLogout = await post(license.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal(afterLogout.status, 401)
    principal = creator
    time += 5 * 60 * 1000
    const expired = await fetch(`${url}?artifact=${seed.manifest.releaseId}`, {
      headers: { authorization: `Bearer ${granted.download.token}` },
    })
    assert.equal(expired.status, 403)
    await chmod(artifactDir, 0o755)
    const unhealthy = await post(license.handler, { action: 'claim', releaseId: seed.manifest.releaseId })
    assert.equal(unhealthy.status, 503)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('a bound reviewer leaves an immutable rejection receipt and rejected submissions cannot publish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-seed-rejection-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  const registryPath = join(root, 'releases.json')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  const archive = await readFile(fixturePath)
  const seed = verifySeedPluginPackage(archive)
  const title = 'CSV 数据体检'
  const summary = '离线统计 CSV 的列和样例，不读写工作区。'
  const release = approved(seed, title, summary)
  const alternateOperatorId = 'reviewer-eight'
  const alternateOperator = generateKeyPairSync('ed25519')
  const releaseOptions = { registryPath, artifactDir,
    publisherKeys: { [publisherId]: publicKey(publisher) }, operatorKeys: {
      [operatorId]: publicKey(operator), [alternateOperatorId]: publicKey(alternateOperator),
    } }
  let principal = creator
  let time = 1780000002000
  const options = { stagingDir, releaseOptions,
    publisherAccounts: { [publisherId]: creator.accountId }, operatorAccounts: {
      [operatorId]: admin.accountId, [alternateOperatorId]: admin.accountId,
    },
    authenticate: async () => principal, now: () => time }
  const handler = createPluginSubmissionRoute(options)
  try {
    const submittedResponse = await post(handler, { action: 'submit', publisherId, title, summary,
      archiveBase64: archive.toString('base64') })
    assert.equal(submittedResponse.status, 200)
    const submitted = (await submittedResponse.json()).submission
    const rejection = signedRejection(submitted, '需要修正插件说明')
    const ownerCannotReject = await post(handler, { action: 'reject', submissionId: submitted.submissionId,
      rejection })
    assert.equal(ownerCannotReject.status, 403)
    principal = admin
    const badId = await post(handler, { action: 'reject', submissionId: 'bad-id', rejection })
    assert.equal(badId.status, 400)
    assert.equal((await badId.json()).code, 'BAD_REQUEST')
    const absentId = randomUUID()
    const absent = await post(handler, { action: 'reject', submissionId: absentId, rejection })
    assert.equal(absent.status, 404)
    assert.equal((await absent.json()).code, 'PLUGIN_SUBMISSION_NOT_FOUND')
    const corruptId = randomUUID()
    const corruptPath = join(stagingDir, `${corruptId}.json`)
    await writeFile(corruptPath, '{', { mode: 0o600 })
    const corrupt = await post(handler, { action: 'reject', submissionId: corruptId, rejection })
    assert.equal(corrupt.status, 503)
    await unlink(corruptPath)
    const wrongOperator = await post(createPluginSubmissionRoute({ ...options,
      operatorAccounts: { [operatorId]: 'other-reviewer' } }), {
      action: 'reject', submissionId: submitted.submissionId, rejection,
    })
    assert.equal(wrongOperator.status, 403)
    const blankNote = await post(handler, { action: 'reject', submissionId: submitted.submissionId,
      rejection: signedRejection(submitted, '   ') })
    assert.equal(blankNote.status, 400)
    const forgedNote = await post(handler, { action: 'reject', submissionId: submitted.submissionId,
      rejection: { ...rejection, note: '无需修改' } })
    assert.equal(forgedNote.status, 400)
    const forgedOperator = await post(handler, { action: 'reject', submissionId: submitted.submissionId,
      rejection: { ...rejection, operatorId: alternateOperatorId } })
    assert.equal(forgedOperator.status, 400)
    const residualPath = join(stagingDir, `${submitted.submissionId}.rejection.json.crash.tmp`)
    await writeFile(residualPath, '')
    const beforeReview = await post(handler, { action: 'pending' })
    assert.equal((await beforeReview.json()).submissions.length, 1)
    const probe = await open(stagingDir, 'r')
    const fileHandlePrototype = Object.getPrototypeOf(probe)
    const originalSync = fileHandlePrototype.sync
    await probe.close()
    let failedDirectorySync = false
    fileHandlePrototype.sync = async function () {
      if ((await this.stat()).isDirectory() && !failedDirectorySync) {
        failedDirectorySync = true
        throw new Error('injected directory fsync failure')
      }
      return originalSync.call(this)
    }
    let interrupted
    try { interrupted = await post(handler, { action: 'reject', submissionId: submitted.submissionId, rejection }) }
    finally { fileHandlePrototype.sync = originalSync }
    assert.equal(failedDirectorySync, true)
    assert.equal(interrupted.status, 503)
    const receiptPath = join(stagingDir, `${submitted.submissionId}.rejection.json`)
    assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).signature, rejection.signature)
    time += 10 * 60 * 1000
    const rejectedResponse = await post(handler, { action: 'reject', submissionId: submitted.submissionId,
      rejection })
    assert.equal(rejectedResponse.status, 200)
    const review = (await rejectedResponse.json()).review
    assert.equal(review.status, 'rejected')
    assert.equal(review.operatorAccountId, admin.accountId)
    assert.equal(review.note, '需要修正插件说明')
    assert.equal(review.signature, rejection.signature)
    assert.match(review.reviewId, /^[0-9a-f-]{36}$/u)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(receipt.reviewId, review.reviewId)
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600)
    const again = await post(handler, { action: 'reject', submissionId: submitted.submissionId,
      rejection: signedRejection(submitted, '重复拒绝') })
    assert.equal(again.status, 409)
    const refusedApproval = await post(handler, { action: 'approve', submissionId: submitted.submissionId,
      release })
    assert.equal(refusedApproval.status, 409)
    assert.equal((await refusedApproval.json()).code, 'PLUGIN_REVIEW_EXISTS')
    const queue = await post(handler, { action: 'pending' })
    assert.deepEqual((await queue.json()).submissions, [])
    principal = creator
    const restarted = createPluginSubmissionRoute(options)
    const ownerView = await post(restarted, { action: 'mine' })
    const ownerRecord = (await ownerView.json()).submissions[0]
    assert.equal(ownerRecord.review.status, 'rejected')
    assert.equal(ownerRecord.review.reviewId, review.reviewId)
    assert.equal(ownerRecord.review.note, '需要修正插件说明')
    const revoked = createPluginSubmissionRoute({ ...options, operatorAccounts: {} })
    const afterRevocation = await post(revoked, { action: 'mine' })
    assert.equal(afterRevocation.status, 200)
    assert.equal((await afterRevocation.json()).submissions[0].review.reviewId, review.reviewId)
    const rebound = createPluginSubmissionRoute({ ...options,
      operatorAccounts: { [operatorId]: 'new-reviewer-account' } })
    const afterRebinding = await post(rebound, { action: 'mine' })
    assert.equal(afterRebinding.status, 200)
    assert.equal((await afterRebinding.json()).submissions[0].review.note, '需要修正插件说明')
    const secondResponse = await post(handler, { action: 'submit', publisherId, title, summary,
      archiveBase64: archive.toString('base64') })
    assert.equal(secondResponse.status, 200)
    const second = (await secondResponse.json()).submission
    principal = admin
    const revokedWriter = await post(rebound, { action: 'reject', submissionId: second.submissionId,
      rejection: signedRejection(second, '旧账号已撤销') })
    assert.equal(revokedWriter.status, 403)
    principal = { ...admin, accountId: 'new-reviewer-account' }
    const reusedSignature = await post(rebound, { action: 'reject', submissionId: second.submissionId,
      rejection: signedRejection(second, '旧账号签名不能冒充新账号') })
    assert.equal(reusedSignature.status, 400)
    principal = creator
    await assert.rejects(readFile(registryPath), { code: 'ENOENT' })
    await writeFile(receiptPath, JSON.stringify({ ...receipt, note: '伪造原因' }))
    assert.equal((await post(restarted, { action: 'mine' })).status, 503)
    await writeFile(receiptPath, JSON.stringify({ ...receipt, operatorId: alternateOperatorId }))
    assert.equal((await post(restarted, { action: 'mine' })).status, 503)
    await writeFile(receiptPath, '')
    assert.equal((await post(restarted, { action: 'mine' })).status, 503)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a transient online account-verification failure never reuses a previous free claim', async () => {
  const route = createPluginFreeLicenseService({
    ledgerPath: '/tmp/unused-private-license.json', releaseOptions: { registryPath: '/tmp/unused-releases.json',
      artifactDir: '/tmp/unused-private-artifacts' }, freeReleaseIds: ['qianshou.csv-profile-1.0.0'],
    authenticate: async () => null, verifyUnavailable: () => true,
  })
  const response = await post(route.handler, { action: 'claim', releaseId: 'qianshou.csv-profile-1.0.0' })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'ACCOUNT_VERIFICATION_UNAVAILABLE')
})
