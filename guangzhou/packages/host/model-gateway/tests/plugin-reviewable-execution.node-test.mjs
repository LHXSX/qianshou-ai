import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pluginExecutionApprovalPayload, pluginExecutionPublisherPayload } from '../src/plugin-execution-candidate.ts'
import { verifyReviewableExecutionPackage } from '../src/plugin-reviewable-execution.ts'
import { createPluginExecutionAccessRoute } from '../src/plugin-execution-access.ts'
import { createPluginSubmissionRoute, pluginRejectionPayload } from '../src/plugin-submissions.ts'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const encode = value => Buffer.from(JSON.stringify(value))
const publisher = generateKeyPairSync('ed25519')
const operator = generateKeyPairSync('ed25519')
const publicKey = pair => pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const creator = { accountId: 'execution-creator', role: 'personal', isAdmin: false }
const admin = { accountId: 'execution-reviewer', role: 'admin', isAdmin: true }
const publisherId = 'execution-publisher'
const operatorId = 'execution-reviewer-key'
const now = 1780000001000

function archive(changed = value => value) {
  const inputSchema = { type: 'object', properties: { source: { type: 'string' } },
    required: ['source'], additionalProperties: false }
  const outputSchema = { type: 'object', properties: { cleaned: { type: 'string' } },
    required: ['cleaned'], additionalProperties: false }
  const executor = { kind: 'qianshou.string-map.v1', program: {
    mappings: [{ from: 'source', to: 'cleaned', transform: 'trim' }] } }
  const artifact = { format: 'qianshou.reviewable-execution.v1', pluginId: 'creator.string-kit',
    version: '1.0.0', operations: [{ operationId: 'text.clean', capabilityId: 'text.transform',
      inputSchema, outputSchema,
      requirements: { platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
        maxInputBytes: 4096, maxOutputBytes: 4096, maxRunMs: 10000 }, executor,
      implementationSha256: sha(encode(executor)) }] }
  changed(artifact)
  return encode(artifact)
}

function signedCandidate(submission, verified, changed = {}, signingPublisher = publisher,
  signingOperator = operator) {
  const candidate = { format: 'qianshou.execution-release-candidate.v1',
    submissionId: submission.submissionId, accountId: submission.accountId,
    publisherId: submission.publisherId, pluginId: verified.manifest.pluginId,
    version: verified.manifest.version, releaseId: `execution.${verified.packageSha256}`,
    title: submission.title, summary: submission.summary, packageSha256: verified.packageSha256,
    packageBytes: verified.packageBytes, unpackedTreeSha256: verified.unpackedTreeSha256,
    verificationScope: 'self-contained-declarative-program', operations: verified.operations,
    publisher: { id: publisherId, accountId: creator.accountId, signature: '' },
    approval: { reviewId: '01e7909f-852a-4c4b-bdde-d24894f4d0a0', operatorId,
      operatorAccountId: admin.accountId, reviewedAt: now, signature: '' },
    installable: false, saleable: false, dispatchable: false, ...changed }
  candidate.publisher.signature = sign(null, Buffer.from(pluginExecutionPublisherPayload(candidate)),
    signingPublisher.privateKey).toString('base64')
  candidate.approval.signature = sign(null, Buffer.from(pluginExecutionApprovalPayload(candidate)),
    signingOperator.privateKey).toString('base64')
  return candidate
}

const post = (route, body) => route(new Request('https://example.test/api/qianshou/ai/plugins/submissions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

test('Guangzhou independently verifies the exact canonical program and all implementation bytes', () => {
  const bytes = archive()
  const verified = verifyReviewableExecutionPackage(bytes)
  assert.equal(verified.packageSha256, sha(bytes))
  assert.equal(verified.operations[0].implementationSha256,
    verified.manifest.operations[0].implementationSha256)
  assert.equal(verified.operations[0].inputSchemaSha256, sha(encode(verified.manifest.operations[0].inputSchema)))
  assert.deepEqual(verified.operations[0].permissions, [])
  assert.throws(() => verifyReviewableExecutionPackage(archive(value => {
    value.operations[0].executor.program.mappings[0].transform = 'copy'
  })))
  assert.throws(() => verifyReviewableExecutionPackage(archive(value => {
    value.operations[0].executor.kind = 'qianshou.shell.v1'
  })))
  assert.throws(() => verifyReviewableExecutionPackage(archive(value => {
    value.operations[0].executor.program.mappings[0].literal = 'secret'
  })))
  assert.throws(() => verifyReviewableExecutionPackage(archive(value => {
    value.operations[0].permissions = ['workspace.read']
  })))
  assert.throws(() => verifyReviewableExecutionPackage(archive(value => {
    value.operations[0].requirements.maxOutputBytes = 65537
  })))
  assert.throws(() => verifyReviewableExecutionPackage(archive(value => {
    value.operations[0].inputSchema.properties['/Users/owner/key'] = { type: 'string' }
  })))
  assert.throws(() => verifyReviewableExecutionPackage(Buffer.from(`${bytes.toString('utf8')} `)))
  assert.throws(() => verifyReviewableExecutionPackage(Buffer.from('{"format":"a","format":"b"}')))
  assert.throws(() => verifyReviewableExecutionPackage(Buffer.from([0xff, 0xff])))
  assert.throws(() => verifyReviewableExecutionPackage(Buffer.alloc(256 * 1024 + 1)))
})

test('owner-submitted program reaches a dual-signed private candidate but no public release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-execution-candidate-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  const registryPath = join(root, 'releases.json')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  let principal = creator
  const options = { stagingDir, releaseOptions: { registryPath, artifactDir,
    publisherKeys: { [publisherId]: publicKey(publisher) }, operatorKeys: { [operatorId]: publicKey(operator) } },
  publisherAccounts: { [publisherId]: creator.accountId },
  operatorAccounts: { [operatorId]: admin.accountId }, authenticate: async () => principal, now: () => now }
  const route = createPluginSubmissionRoute(options)
  try {
    const bytes = archive()
    const verified = verifyReviewableExecutionPackage(bytes)
    const submitted = await post(route, { action: 'submit', publisherId, title: 'String kit',
      summary: 'Pure string maps', archiveBase64: bytes.toString('base64') })
    assert.equal(submitted.status, 200)
    const { submission } = await submitted.json()
    assert.equal(submission.manifest.format, 'qianshou.reviewable-execution.v1')
    const candidate = signedCandidate(submission, verified)
    const action = { action: 'approve-execution', submissionId: submission.submissionId, candidate }
    assert.equal((await post(route, { action: 'approve', submissionId: submission.submissionId,
      release: {} })).status, 403)
    assert.equal((await post(route, action)).status, 403)
    principal = admin
    assert.equal((await post(route, { action: 'approve', submissionId: submission.submissionId,
      release: {} })).status, 409, 'old CSV release approval cannot consume this program')
    assert.equal((await post(route, { action: 'approve-declaration', submissionId: submission.submissionId,
      review: {} })).status, 409, 'data-only review cannot consume this program')
    const wrongPublisher = signedCandidate(submission, verified, {}, operator)
    assert.equal((await post(route, { ...action, candidate: wrongPublisher })).status, 400)
    const wrongReviewer = signedCandidate(submission, verified, {}, publisher, publisher)
    assert.equal((await post(route, { ...action, candidate: wrongReviewer })).status, 400)
    const alteredOperation = signedCandidate(submission, verified,
      { operations: [{ ...verified.operations[0], implementationSha256: '0'.repeat(64) }] })
    assert.equal((await post(route, { ...action, candidate: alteredOperation })).status, 400)
    const installable = signedCandidate(submission, verified, { installable: true })
    assert.equal((await post(route, { ...action, candidate: installable })).status, 400)
    const accepted = await post(route, action)
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json()).review.status, 'execution-candidate-reviewed')
    assert.equal((await post(route, action)).status, 200)
    const changedDecision = signedCandidate(submission, verified, {
      approval: { ...candidate.approval, reviewId: '11e7909f-852a-4c4b-bdde-d24894f4d0a0' } })
    assert.equal((await post(route, { ...action, candidate: changedDecision })).status, 409)
    const rejection = { submissionId: submission.submissionId, packageSha256: submission.packageSha256,
      reviewId: '21e7909f-852a-4c4b-bdde-d24894f4d0a0', operatorId,
      operatorAccountId: admin.accountId, reviewedAt: now, note: 'Cannot replace approval' }
    assert.equal((await post(route, { action: 'reject', submissionId: submission.submissionId,
      rejection: { ...rejection, signature: sign(null, Buffer.from(pluginRejectionPayload(rejection)),
        operator.privateKey).toString('base64') } })).status, 409)
    principal = creator
    const mine = (await (await post(route, { action: 'mine' })).json()).submissions
    assert.equal(mine[0].review.status, 'execution-candidate-reviewed')
    assert.equal(mine[0].review.installable, false)
    assert.equal(mine[0].review.dispatchable, false)
    assert.deepEqual(await readdir(artifactDir), [])
    await assert.rejects(readFile(registryPath))
    let accessNow = now
    const access = createPluginExecutionAccessRoute({ submissionOptions: options,
      authenticate: async request => request.headers.get('authorization') === 'Bearer owner-session-token-12345'
        ? creator : request.headers.get('authorization') === 'Bearer other-session-token-12345'
          ? { accountId: 'other-account', role: 'personal', isAdmin: false } : null,
      now: () => accessNow })
    const server = createServer((request, response) => { void access.handler(request, response) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${server.address().port}${access.path}`
      const claim = (authorization, sha256 = submission.packageSha256) => fetch(base, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'claim', submissionId: submission.submissionId, packageSha256: sha256 }),
      })
      assert.equal((await fetch(base, { method: 'POST', headers: {
        authorization: 'Bearer owner-session-token-12345', origin: 'https://other.example',
        'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim',
          submissionId: submission.submissionId, packageSha256: submission.packageSha256 }) })).status, 403)
      assert.equal((await claim('Bearer unknown-session-token-12345')).status, 401)
      assert.equal((await claim('Bearer other-session-token-12345')).status, 403)
      assert.equal((await claim('Bearer owner-session-token-12345', '0'.repeat(64))).status, 403)
      const granted = await claim('Bearer owner-session-token-12345')
      assert.equal(granted.status, 200)
      const accessBody = await granted.json()
      assert.deepEqual(accessBody.candidate, candidate)
      assert.equal(accessBody.releaseId, `execution.${submission.packageSha256}`)
      assert.equal(accessBody.license.accountId, creator.accountId)
      assert.equal(accessBody.license.scope, 'self-use-review-candidate')
      assert.equal(accessBody.installable, false)
      assert.equal(accessBody.saleable, false)
      assert.equal(accessBody.dispatchable, false)
      assert.equal((await (await claim('Bearer owner-session-token-12345')).json()).license.licenseId,
        accessBody.license.licenseId, 'durable claim is idempotent')
      const download = await fetch(`http://127.0.0.1:${server.address().port}${accessBody.download.url}`, {
        headers: { authorization: `Bearer ${accessBody.download.token}` },
      })
      assert.equal(download.status, 200)
      assert.equal(download.headers.get('x-qianshou-package-sha256'), submission.packageSha256)
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${accessBody.download.url}`, {
        headers: { authorization: 'Bearer ' + 'z'.repeat(43) },
      })).status, 403)
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${access.path}`
        + `?submission=${submission.submissionId}&sha256=${'0'.repeat(64)}`, {
        headers: { authorization: `Bearer ${accessBody.download.token}` },
      })).status, 403)
      const archivePath = join(stagingDir, `${submission.submissionId}.qspkg`)
      await writeFile(archivePath, Buffer.from(`${bytes.toString('utf8')} `))
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${accessBody.download.url}`, {
        headers: { authorization: `Bearer ${accessBody.download.token}` },
      })).status, 503, 'a changed program must fail closed after a token was granted')
      await writeFile(archivePath, bytes)
      const contradictory = { submissionId: submission.submissionId,
        packageSha256: submission.packageSha256, reviewId: randomUUID(), operatorId,
        operatorAccountId: admin.accountId, reviewedAt: now, note: 'Conflicting decision' }
      const rejectionPath = join(stagingDir, `${submission.submissionId}.rejection.json`)
      await writeFile(rejectionPath, JSON.stringify({ ...contradictory,
        signature: sign(null, Buffer.from(pluginRejectionPayload(contradictory)),
          operator.privateKey).toString('base64') }), { mode: 0o600 })
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${accessBody.download.url}`, {
        headers: { authorization: `Bearer ${accessBody.download.token}` },
      })).status, 503, 'contradictory signed reviews must fail closed')
      await rm(rejectionPath)
      accessNow += 5 * 60 * 1000
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${accessBody.download.url}`, {
        headers: { authorization: `Bearer ${accessBody.download.token}` },
      })).status, 403)
      const license = JSON.parse(await readFile(join(stagingDir,
        `${submission.submissionId}.execution-self-license.json`), 'utf8'))
      assert.equal(license.packageSha256, submission.packageSha256)
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    const afterRestart = createPluginSubmissionRoute({ ...options, operatorAccounts: {} })
    assert.equal((await (await post(afterRestart, { action: 'mine' })).json()).submissions[0].review.status,
      'execution-candidate-reviewed')
    const reviewPath = join(stagingDir, `${submission.submissionId}.execution-candidate.json`)
    await writeFile(reviewPath, Buffer.from(JSON.stringify({ ...candidate, title: 'Forged' })))
    assert.equal((await post(afterRestart, { action: 'mine' })).status, 503)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('submission quota is per account; global staged bytes guard never hides mine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-execution-account-quota-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  const bytes = archive()
  const verified = verifyReviewableExecutionPackage(bytes)
  const crowded = { accountId: 'crowded-account', role: 'personal', isAdmin: false }
  const newcomer = { accountId: 'newcomer-account', role: 'personal', isAdmin: false }
  let principal = crowded
  const route = createPluginSubmissionRoute({ stagingDir,
    releaseOptions: { registryPath: join(root, 'releases.json'), artifactDir,
      publisherKeys: { crowded: publicKey(publisher), newcomer: publicKey(publisher) },
      operatorKeys: {} },
    publisherAccounts: { crowded: crowded.accountId, newcomer: newcomer.accountId },
    authenticate: async () => principal, now: () => now })
  try {
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(Array.from({ length: 100 }, async () => {
        const submissionId = randomUUID()
        const record = { submissionId, accountId: crowded.accountId, publisherId: 'crowded',
          title: 'Existing', summary: 'Existing', submittedAt: now,
          packageSha256: verified.packageSha256, packageBytes: verified.packageBytes,
          unpackedTreeSha256: verified.unpackedTreeSha256, manifest: verified.manifest }
        await writeFile(join(stagingDir, `${submissionId}.json`), JSON.stringify(record), { mode: 0o600 })
      }))
    }
    const upload = publisherId => ({ action: 'submit', publisherId, title: 'String kit',
      summary: 'Pure string maps', archiveBase64: bytes.toString('base64') })
    const firstPage = await (await post(route, { action: 'mine' })).json()
    assert.equal(firstPage.submissions.length, 20)
    assert.match(firstPage.nextCursor, /^[0-9a-f-]{36}$/)
    const secondPage = await (await post(route, { action: 'mine', cursor: firstPage.nextCursor })).json()
    assert.equal(secondPage.submissions.length, 20)
    assert.notEqual(secondPage.submissions[0].submissionId, firstPage.submissions[0].submissionId)
    assert.equal((await post(route, upload('crowded'))).status, 429)
    principal = newcomer
    assert.equal((await post(route, { action: 'mine' })).status, 200,
      'another account must read its own history after the old global 1000 threshold')
    const accepted = await post(route, upload('newcomer'))
    assert.equal(accepted.status, 200)
    assert.equal((await (await post(route, { action: 'mine' })).json()).submissions.length, 1)
    const sparse = join(stagingDir, 'global-storage-guard.bin')
    await writeFile(sparse, '', { mode: 0o600 })
    await truncate(sparse, 16 * 1024 * 1024 * 1024)
    const full = await post(route, upload('newcomer'))
    assert.equal(full.status, 507)
    assert.equal((await full.json()).code, 'PLUGIN_SUBMISSION_STORAGE_LIMIT')
    assert.equal((await (await post(route, { action: 'mine' })).json()).submissions.length, 1,
      'a full staging volume must not hide review history')
  } finally { await rm(root, { recursive: true, force: true }) }
})
