import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pluginApprovalPayload, pluginReleasePayload } from '../src/plugin-releases.ts'
import { verifyDeclarationPluginPackage } from '../src/plugin-seed-package.ts'
import { createPluginSubmissionRoute, pluginDeclarationReviewPayload,
  pluginRejectionPayload } from '../src/plugin-submissions.ts'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const encode = value => Buffer.from(JSON.stringify(value))
const publisher = generateKeyPairSync('ed25519')
const operator = generateKeyPairSync('ed25519')
const key = pair => pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const creator = { accountId: 'generic-creator', role: 'personal', isAdmin: false }
const admin = { accountId: 'generic-reviewer', role: 'admin', isAdmin: true }
const publisherId = 'generic-publisher'
const operatorId = 'generic-reviewer-key'
const now = 1780000001000

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, bytes, mode = 0o100644 } of entries) {
    const path = Buffer.from(name)
    const crc = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(path.length, 26)
    locals.push(local, path, bytes)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE((3 << 8) | 20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt32LE(crc, 16)
    directory.writeUInt32LE(bytes.length, 20)
    directory.writeUInt32LE(bytes.length, 24)
    directory.writeUInt16LE(path.length, 28)
    directory.writeUInt32LE((mode << 16) >>> 0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, path)
    offset += local.length + path.length + bytes.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

function declaration(changedManifest = value => value, changedEntries = value => value, operationCount = 2) {
  const schemas = Array.from({ length: operationCount }, (_, index) => [
    encode({ type: 'object', properties: { value: { type: index % 2 === 0 ? 'string' : 'integer' } } }),
    encode({ type: 'object' }),
  ])
  const manifest = {
    format: 'qianshou.declaration.v1', pluginId: 'example.data-tool', version: '1.2.3',
    releaseId: 'example.data-tool-1.2.3', platforms: ['darwin', 'linux'], architectures: ['arm64'],
    operations: schemas.map(([input, output], index) => ({ capabilityId: 'text.transform',
      operationId: `example.operation-${index}`, executorKind: index === 0 ? 'tool' : 'workflow',
      inputSchemaSha256: sha(input), outputSchemaSha256: sha(output), permissions: [] })),
  }
  changedManifest(manifest)
  const entries = [{ name: 'manifest.json', bytes: encode(manifest) }]
  for (const [index, [input, output]] of schemas.entries()) {
    entries.push({ name: `schemas/${index}/input.json`, bytes: input })
    entries.push({ name: `schemas/${index}/output.json`, bytes: output })
  }
  changedEntries(entries)
  return storedZip(entries)
}

const post = (handler, body) => handler(new Request('https://example.test/api/qianshou/ai/plugins/submissions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

function signedRelease(verified) {
  const manifest = verified.manifest
  const base = { pluginId: manifest.pluginId, version: manifest.version, releaseId: manifest.releaseId,
    title: 'Example data tool', summary: 'Declaration only', packageSha256: verified.packageSha256,
    packageBytes: verified.packageBytes, platforms: manifest.platforms,
    architectures: manifest.architectures, operations: manifest.operations }
  const release = { ...base, publisher: { id: publisherId,
    signature: sign(null, Buffer.from(pluginReleasePayload(base)), publisher.privateKey).toString('base64') },
    approval: { reviewId: 'generic-review-1', reviewedAt: now, operatorId }, installable: false }
  release.approval.signature = sign(null, Buffer.from(pluginApprovalPayload(release)), operator.privateKey).toString('base64')
  return release
}

function signedDeclarationReview(submission, changed = {}, signer = operator) {
  const manifest = submission.manifest
  const base = { format: 'qianshou.declaration-review.v1', submissionId: submission.submissionId,
    accountId: submission.accountId, publisherId: submission.publisherId,
    pluginId: manifest.pluginId, version: manifest.version, releaseId: manifest.releaseId,
    title: submission.title, summary: submission.summary, packageSha256: submission.packageSha256,
    packageBytes: submission.packageBytes, unpackedTreeSha256: submission.unpackedTreeSha256,
    manifestSha256: sha(Buffer.from(JSON.stringify(manifest))),
    reviewId: 'e5fdb604-f76a-4a59-b297-5ab27ac5ea3f', operatorId,
    operatorAccountId: admin.accountId, reviewedAt: now, scope: 'declaration-only',
    installable: false, ...changed }
  return { ...base, signature: sign(null, Buffer.from(pluginDeclarationReviewPayload(base)),
    signer.privateKey).toString('base64') }
}

test('declaration ZIP accepts bounded canonical data and rejects unsafe or changed entries', () => {
  const archive = declaration()
  const verified = verifyDeclarationPluginPackage(archive)
  assert.equal(verified.packageSha256, sha(archive))
  assert.equal(verified.packageBytes, archive.length)
  assert.equal(verified.manifest.operations.length, 2)
  assert.match(verified.unpackedTreeSha256, /^[0-9a-f]{64}$/u)
  const reordered = verifyDeclarationPluginPackage(declaration(() => {}, entries => entries.reverse()))
  assert.notEqual(reordered.packageSha256, verified.packageSha256)
  assert.equal(reordered.unpackedTreeSha256, verified.unpackedTreeSha256)
  assert.throws(() => verifyDeclarationPluginPackage(declaration(manifest => {
    manifest.operations[0].inputSchemaSha256 = '0'.repeat(64)
  })))
  assert.throws(() => verifyDeclarationPluginPackage(declaration(manifest => {
    manifest.operations[1].operationId = manifest.operations[0].operationId
  })))
  assert.throws(() => verifyDeclarationPluginPackage(declaration(manifest => {
    manifest.operations[0].permissions = ['shell.execute']
  })))
  assert.throws(() => verifyDeclarationPluginPackage(declaration(() => {}, entries => {
    entries[0].bytes = Buffer.from(JSON.stringify(JSON.parse(entries[0].bytes), null, 2))
  })))
  assert.throws(() => verifyDeclarationPluginPackage(declaration(() => {}, entries => {
    entries.push({ name: '../execute.js', bytes: Buffer.from('alert(1)') })
  })))
  assert.throws(() => verifyDeclarationPluginPackage(declaration(() => {}, entries => {
    entries.push({ ...entries[1] })
  })))
  assert.throws(() => verifyDeclarationPluginPackage(declaration(() => {}, entries => {
    entries[1].mode = 0o120777
  })))
  const damaged = Buffer.from(archive)
  const schema = Buffer.from('{"type":"object","properties":{"value"')
  const at = damaged.indexOf(schema)
  assert.ok(at > 0)
  damaged[at + 2] ^= 1
  assert.throws(() => verifyDeclarationPluginPackage(damaged))
  const inflatedClaim = Buffer.from(archive)
  const central = inflatedClaim.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(central > 0)
  inflatedClaim.writeUInt32LE(512 * 1024 + 1, central + 24)
  assert.throws(() => verifyDeclarationPluginPackage(inflatedClaim))
  const commented = Buffer.concat([archive, Buffer.from('X')])
  commented.writeUInt16LE(1, archive.length - 2)
  assert.throws(() => verifyDeclarationPluginPackage(commented))
})

test('generic intake is account-bound and never approves or releases a declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-declaration-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  const registryPath = join(root, 'releases.json')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  const archive = declaration()
  const verified = verifyDeclarationPluginPackage(archive)
  let principal = creator
  const route = createPluginSubmissionRoute({ stagingDir,
    releaseOptions: { registryPath, artifactDir, publisherKeys: { [publisherId]: key(publisher) },
      operatorKeys: { [operatorId]: key(operator) } },
    publisherAccounts: { [publisherId]: creator.accountId },
    operatorAccounts: { [operatorId]: admin.accountId }, authenticate: async () => principal, now: () => now })
  const submit = { action: 'submit', publisherId, title: 'Example data tool',
    summary: 'Declaration only', archiveBase64: archive.toString('base64') }
  try {
    principal = null
    assert.equal((await post(route, submit)).status, 401)
    principal = creator
    assert.equal((await post(route, { ...submit, publisherId: 'unbound' })).status, 403)
    const oversized = await post(route, { ...submit, archiveBase64: 'A'.repeat(2 * 1024 * 1024) })
    assert.equal(oversized.status, 400)
    const accepted = await post(route, submit)
    assert.equal(accepted.status, 200)
    const { submission } = await accepted.json()
    assert.equal(submission.accountId, creator.accountId)
    assert.equal(submission.packageSha256, verified.packageSha256)
    assert.equal(submission.manifest.format, 'qianshou.declaration.v1')
    assert.equal((await readFile(join(stagingDir, `${submission.submissionId}.qspkg`))).equals(archive), true)
    const mine = await post(route, { action: 'mine' })
    assert.equal((await mine.json()).submissions[0].review.status, 'pending')
    principal = admin
    const pending = await post(route, { action: 'pending' })
    assert.equal((await pending.json()).submissions.length, 1)
    const release = signedRelease(verified)
    const approval = await post(route, { action: 'approve', submissionId: submission.submissionId, release })
    assert.equal(approval.status, 409)
    assert.equal((await approval.json()).code, 'PLUGIN_REVIEW_UNSUPPORTED')
    await assert.rejects(readFile(registryPath))
    const receipt = { submissionId: submission.submissionId, packageSha256: submission.packageSha256,
      reviewId: 'c79f5d9d-8084-4bad-a011-8e29d1890612', operatorId,
      operatorAccountId: admin.accountId, reviewedAt: now, note: 'No reviewed adapter' }
    const rejection = { ...receipt, signature: sign(null, Buffer.from(pluginRejectionPayload(receipt)),
      operator.privateKey).toString('base64') }
    assert.equal((await post(route, { action: 'reject', submissionId: submission.submissionId,
      rejection })).status, 200)
    assert.deepEqual((await (await post(route, { action: 'pending' })).json()).submissions, [])
    principal = creator
    assert.equal((await (await post(route, { action: 'mine' })).json()).submissions[0].review.status, 'rejected')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('independent reviewer signs declaration-only evidence without executable release or license', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-reviewed-declaration-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  const registryPath = join(root, 'releases.json')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  let principal = creator
  const options = { stagingDir,
    releaseOptions: { registryPath, artifactDir, publisherKeys: { [publisherId]: key(publisher) },
      operatorKeys: { [operatorId]: key(operator) } },
    publisherAccounts: { [publisherId]: creator.accountId },
    operatorAccounts: { [operatorId]: admin.accountId }, authenticate: async () => principal, now: () => now }
  const route = createPluginSubmissionRoute(options)
  try {
    const archive = declaration()
    const submitted = await post(route, { action: 'submit', publisherId, title: 'Example data tool',
      summary: 'Declaration only', archiveBase64: archive.toString('base64') })
    assert.equal(submitted.status, 200)
    const { submission } = await submitted.json()
    const review = signedDeclarationReview(submission)
    const action = { action: 'approve-declaration', submissionId: submission.submissionId, review }
    assert.equal((await post(route, action)).status, 403, 'the author cannot approve their own declaration')
    principal = admin
    const malicious = signedDeclarationReview(submission, { installable: true })
    assert.equal((await post(route, { ...action, review: malicious })).status, 400)
    const wrongAccount = signedDeclarationReview(submission, { operatorAccountId: 'someone-else' })
    assert.equal((await post(route, { ...action, review: wrongAccount })).status, 400)
    const wrongSignature = signedDeclarationReview(submission, {}, publisher)
    assert.equal((await post(route, { ...action, review: wrongSignature })).status, 400)
    const wrongKey = signedDeclarationReview(submission, { operatorId: 'unbound' })
    assert.equal((await post(route, { ...action, review: wrongKey })).status, 403)
    const stale = signedDeclarationReview(submission, { reviewedAt: now - 6 * 60 * 1000 })
    assert.equal((await post(route, { ...action, review: stale })).status, 400)
    const accepted = await post(route, action)
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json()).review.status, 'declaration-reviewed')
    assert.equal((await post(route, action)).status, 200, 'an identical retry is idempotent')
    const secondReview = signedDeclarationReview(submission,
      { reviewId: 'f5fdb604-f76a-4a59-b297-5ab27ac5ea3f' })
    assert.equal((await post(route, { ...action, review: secondReview })).status, 409)
    const rejected = { submissionId: submission.submissionId, packageSha256: submission.packageSha256,
      reviewId: 'd79f5d9d-8084-4bad-a011-8e29d1890612', operatorId,
      operatorAccountId: admin.accountId, reviewedAt: now, note: 'Cannot replace approval' }
    assert.equal((await post(route, { action: 'reject', submissionId: submission.submissionId,
      rejection: { ...rejected, signature: sign(null, Buffer.from(pluginRejectionPayload(rejected)),
        operator.privateKey).toString('base64') } })).status, 409)
    assert.deepEqual((await (await post(route, { action: 'pending' })).json()).submissions, [])
    principal = creator
    const mine = await post(route, { action: 'mine' })
    assert.equal(mine.status, 200)
    const row = (await mine.json()).submissions[0]
    assert.equal(row.review.status, 'declaration-reviewed')
    assert.equal(row.review.scope, 'declaration-only')
    assert.equal(row.review.installable, false)
    assert.equal(row.review.signature, review.signature)
    assert.deepEqual(await readdir(artifactDir), [])
    await assert.rejects(readFile(registryPath))
    const restarted = createPluginSubmissionRoute(options)
    assert.equal((await (await post(restarted, { action: 'mine' })).json()).submissions[0].review.status,
      'declaration-reviewed')
    const afterRebinding = createPluginSubmissionRoute({ ...options, operatorAccounts: {} })
    assert.equal((await (await post(afterRebinding, { action: 'mine' })).json()).submissions[0].review.status,
      'declaration-reviewed', 'historic signatures remain readable after operator-account revocation')
    const duplicate = await post(route, { action: 'submit', publisherId, title: 'Example data tool',
      summary: 'Declaration only', archiveBase64: archive.toString('base64') })
    const other = (await duplicate.json()).submission
    const changedArchive = declaration(manifest => {
      manifest.version = '1.2.4'
      manifest.releaseId = 'example.data-tool-1.2.4'
    })
    const changedSubmission = await post(route, { action: 'submit', publisherId, title: 'Changed archive',
      summary: 'Must be reverified', archiveBase64: changedArchive.toString('base64') })
    const changed = (await changedSubmission.json()).submission
    const changedBytes = Buffer.from(changedArchive)
    changedBytes[100] ^= 1
    await writeFile(join(stagingDir, `${changed.submissionId}.qspkg`), changedBytes)
    principal = admin
    const collision = await post(route, { action: 'approve-declaration', submissionId: other.submissionId,
      review: signedDeclarationReview(other) })
    assert.equal(collision.status, 409)
    assert.equal((await collision.json()).code, 'PLUGIN_DECLARATION_VERSION_EXISTS')
    const changedReview = await post(route, { action: 'approve-declaration', submissionId: changed.submissionId,
      review: signedDeclarationReview(changed) })
    assert.equal(changedReview.status, 409)
    assert.equal((await changedReview.json()).code, 'PLUGIN_SUBMISSION_CHANGED')
    await writeFile(join(stagingDir, `${submission.submissionId}.declaration-review.json`),
      Buffer.from(JSON.stringify({ ...review, title: 'Forged title' })))
    principal = creator
    assert.equal((await post(restarted, { action: 'mine' })).status, 503,
      'a modified stored review is never displayed as approved')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('maximum valid 16-operation declaration remains readable and cannot poison the intake queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-max-declaration-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  const registryPath = join(root, 'releases.json')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  const archive = declaration(manifest => {
    manifest.pluginId = 'p'.repeat(80)
    manifest.releaseId = 'r'.repeat(80)
    manifest.operations.forEach((operation, index) => {
      operation.capabilityId = 'c'.repeat(80)
      operation.operationId = `${'o'.repeat(78)}${String(index).padStart(2, '0')}`
      operation.permissions = ['workspace.read', 'workspace.write', 'network.declared', 'model.local', 'gpu']
    })
  }, value => value, 16)
  let principal = creator
  const route = createPluginSubmissionRoute({ stagingDir,
    releaseOptions: { registryPath, artifactDir, publisherKeys: { [publisherId]: key(publisher) },
      operatorKeys: { [operatorId]: key(operator) } },
    publisherAccounts: { [publisherId]: creator.accountId },
    operatorAccounts: { [operatorId]: admin.accountId }, authenticate: async () => principal, now: () => now })
  try {
    const accepted = await post(route, { action: 'submit', publisherId, title: 'T'.repeat(80),
      summary: 'S'.repeat(400), archiveBase64: archive.toString('base64') })
    assert.equal(accepted.status, 200)
    const { submission } = await accepted.json()
    const saved = await readFile(join(stagingDir, `${submission.submissionId}.json`))
    assert.ok(saved.length > 8192, 'the old fixed reader would reject this valid record')
    assert.equal((await (await post(route, { action: 'mine' })).json()).submissions.length, 1)
    assert.equal((await post(route, { action: 'submit', publisherId, title: 'Second',
      summary: 'Still readable', archiveBase64: archive.toString('base64') })).status, 200)
    principal = admin
    assert.equal((await (await post(route, { action: 'pending' })).json()).submissions.length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('publisher key must be an own configuration entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-key-binding-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  const route = createPluginSubmissionRoute({ stagingDir,
    releaseOptions: { registryPath: join(root, 'releases.json'), artifactDir, publisherKeys: {},
      operatorKeys: { [operatorId]: key(operator) } },
    publisherAccounts: { constructor: creator.accountId }, authenticate: async () => creator })
  try {
    const response = await post(route, { action: 'submit', publisherId: 'constructor', title: 'No key',
      summary: 'Inherited Object.prototype.constructor is not a signing key',
      archiveBase64: declaration().toString('base64') })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'PUBLISHER_NOT_BOUND')
  } finally { await rm(root, { recursive: true, force: true }) }
})
