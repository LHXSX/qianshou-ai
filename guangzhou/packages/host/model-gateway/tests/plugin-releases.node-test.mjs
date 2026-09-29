import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPluginReleasesRoute, readApprovedPluginReleases, PLUGIN_RELEASES_PATH } from '../src/plugin-releases.ts'

const publisher = generateKeyPairSync('ed25519')
const operator = generateKeyPairSync('ed25519')
const publicKey = pair => pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const publisherKeys = { 'creator-42': publicKey(publisher) }
const operatorKeys = { 'reviewer-7': publicKey(operator) }
const schemaHash = createHash('sha256').update('{}').digest('hex')

function approvedRelease(archive, overrides = {}) {
  const base = {
    pluginId: 'creator-42.article', version: '1.0.0', releaseId: 'release-one',
    title: '文章工作流', summary: '经过真实制品检查的发布元数据',
    packageSha256: createHash('sha256').update(archive).digest('hex'), packageBytes: archive.length,
    platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
    operations: [{ capabilityId: 'text.transform', operationId: 'rewrite', executorKind: 'workflow',
      inputSchemaSha256: schemaHash, outputSchemaSha256: schemaHash, permissions: ['workspace.read'] }],
    ...overrides,
  }
  const publisherProof = { id: 'creator-42', signature: sign(null, Buffer.from(JSON.stringify(base)), publisher.privateKey).toString('base64') }
  const approvalBody = { release: base, publisher: publisherProof,
    reviewId: 'review-one', reviewedAt: 1780000000000, operatorId: 'reviewer-7' }
  return { ...base, publisher: publisherProof,
    approval: { reviewId: approvalBody.reviewId, reviewedAt: approvalBody.reviewedAt,
      operatorId: approvalBody.operatorId,
      signature: sign(null, Buffer.from(JSON.stringify(approvalBody)), operator.privateKey).toString('base64') },
    installable: false }
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-releases-'))
  const registryPath = join(dir, 'releases.json')
  const artifactDir = join(dir, 'artifacts')
  await mkdir(artifactDir, { mode: 0o700 })
  try { await run({ dir, registryPath, artifactDir, publisherKeys, operatorKeys }) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

async function serve(route, run) {
  const server = createServer((request, response) => void route.handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const request = async (method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${address.port}${PLUGIN_RELEASES_PATH}`, { method })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  const artifact = (query, token) => fetch(`http://127.0.0.1:${address.port}${PLUGIN_RELEASES_PATH}${query}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  })
  try { await run(request, artifact) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('unconfigured release endpoint is empty and strictly read only', async () => {
  await serve(createPluginReleasesRoute({}), async request => {
    const empty = await request()
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { releases: [] })
    const denied = await request('POST')
    assert.equal(denied.status, 405)
    assert.equal(denied.headers.get('allow'), 'GET')
  })
  assert.throws(() => createPluginReleasesRoute({ registryPath: '/tmp/registry.json' }), /PLUGIN_RELEASE_PATH_INVALID/)
})

test('one reviewed archive is fetchable only with an explicit private-preview bearer', async () => {
  await fixture(async options => {
    const archive = Buffer.from('reviewed archive bytes for private staging')
    const release = approvedRelease(archive)
    const token = 'private-preview-token-with-at-least-32-bytes'
    await writeFile(join(options.artifactDir, `${release.packageSha256}.qspkg`), archive, { mode: 0o600 })
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [release] }))
    await serve(createPluginReleasesRoute(options), async (_request, artifact) => {
      const disabled = await artifact('?artifact=release-one', token)
      assert.equal(disabled.status, 403)
      assert.equal(disabled.headers.get('content-type'), 'application/json; charset=utf-8')
    })
    await serve(createPluginReleasesRoute({ ...options, artifactAccessToken: token }), async (request, artifact) => {
      for (const attempted of [undefined, 'wrong-private-preview-token', '']) {
        const denied = await artifact('?artifact=release-one', attempted)
        assert.equal(denied.status, 403)
        assert.equal(denied.headers.get('x-qianshou-package-sha256'), null)
      }
      const fetched = await artifact('?artifact=release-one', token)
      assert.equal(fetched.status, 200)
      assert.equal(fetched.headers.get('content-type'), 'application/octet-stream')
      assert.equal(fetched.headers.get('content-length'), String(archive.length))
      assert.equal(fetched.headers.get('x-qianshou-package-sha256'), release.packageSha256)
      assert.equal(fetched.headers.get('cache-control'), 'no-store')
      assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff')
      assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), archive)
      const metadata = await request()
      assert.equal(metadata.status, 200)
      assert.equal(metadata.body.releases[0].installable, false)
      assert.equal('packageUrl' in metadata.body.releases[0], false)
      const absent = await artifact('?artifact=not-in-registry', token)
      assert.equal(absent.status, 404)
      for (const query of ['?artifact=', '?artifact=../private', '?artifact=release-one&artifact=release-one', '?other=x']) {
        const invalid = await artifact(query, token)
        assert.equal(invalid.status, 400)
      }
    })
  })
  assert.throws(() => createPluginReleasesRoute({ artifactAccessToken: 'short' }), /PLUGIN_ARTIFACT_TOKEN_INVALID/)
})

test('a changed reviewed archive is refused before private retrieval', async () => {
  await fixture(async options => {
    const archive = Buffer.from('reviewed archive bytes')
    const release = approvedRelease(archive)
    const token = 'private-preview-token-with-at-least-32-bytes'
    const path = join(options.artifactDir, `${release.packageSha256}.qspkg`)
    await writeFile(path, archive, { mode: 0o600 })
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [release] }))
    await serve(createPluginReleasesRoute({ ...options, artifactAccessToken: token }), async (_request, artifact) => {
      assert.equal((await artifact('?artifact=release-one', token)).status, 200)
      await writeFile(path, Buffer.alloc(archive.length, 0x78))
      const changed = await artifact('?artifact=release-one', token)
      assert.equal(changed.status, 503)
      assert.equal(changed.headers.get('x-qianshou-package-sha256'), null)
    })
  })
})

test('public metadata requires two signatures and the exact archive bytes', async () => {
  await fixture(async options => {
    const archive = Buffer.from('safe workflow archive fixture')
    const release = approvedRelease(archive)
    await writeFile(join(options.artifactDir, `${release.packageSha256}.qspkg`), archive, { mode: 0o600 })
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [release] }))
    await serve(createPluginReleasesRoute(options), async request => {
      const valid = await request()
      assert.equal(valid.status, 200)
      assert.deepEqual(valid.body, { releases: [{ ...release, verificationScope: 'opaque-archive-bytes' }] })
      assert.equal(valid.body.releases[0].installable, false)
      assert.equal(valid.body.releases[0].verificationScope, 'opaque-archive-bytes')
      assert.equal('packageUrl' in valid.body.releases[0], false)
      assert.equal(valid.headers.get('cache-control'), 'no-store')
      // Equal-size in-place tampering must invalidate the inode fingerprint cache.
      await writeFile(join(options.artifactDir, `${release.packageSha256}.qspkg`), Buffer.alloc(archive.length, 0x78))
      const unavailable = await request()
      assert.equal(unavailable.status, 503)
      assert.deepEqual(unavailable.body, { error: { code: 'PLUGIN_RELEASES_UNAVAILABLE' } })
      assert.equal(JSON.stringify(unavailable.body).includes(options.dir), false)
      assert.equal(JSON.stringify(unavailable.body).includes(publisherKeys['creator-42']), false)
    })
    const forged = { ...release, approval: { ...release.approval, operatorId: 'untrusted' } }
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [forged] }))
    await serve(createPluginReleasesRoute(options), async request => assert.equal((await request()).status, 503))
  })
})

test('total archive size is bounded before any package is opened', async () => {
  await fixture(async options => {
    const one = 400 * 1024 * 1024
    const releases = [1, 2, 3].map(number => approvedRelease(Buffer.from('x'), {
      version: `${number}.0.0`, releaseId: `release-${number}`, packageBytes: one,
    }))
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases }))
    await assert.rejects(readApprovedPluginReleases(options), /PLUGIN_ARTIFACT_TOTAL_EXCEEDED/)
    await serve(createPluginReleasesRoute(options), async request => {
      const result = await request()
      assert.equal(result.status, 503)
      assert.deepEqual(result.body, { error: { code: 'PLUGIN_RELEASES_UNAVAILABLE' } })
    })
  })
})

test('private artifact directory and archive permissions are required', async () => {
  await fixture(async options => {
    const archive = Buffer.from('private artifact')
    const release = approvedRelease(archive)
    const artifact = join(options.artifactDir, `${release.packageSha256}.qspkg`)
    await writeFile(artifact, archive, { mode: 0o600 })
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [release] }))
    await serve(createPluginReleasesRoute(options), async request => {
      await chmod(artifact, 0o644)
      assert.equal((await request()).status, 503)
      await chmod(artifact, 0o600)
      assert.equal((await request()).status, 200)
      await chmod(options.artifactDir, 0o755)
      assert.equal((await request()).status, 503)
    })
  })
})

test('a signed release still cannot declare a permission the installer manifest rejects', async () => {
  await fixture(async options => {
    const archive = Buffer.from('permission fixture')
    const valid = approvedRelease(archive)
    const unknown = approvedRelease(archive, { operations: [{
      ...valid.operations[0], permissions: ['shell.root'],
    }] })
    await writeFile(join(options.artifactDir, `${valid.packageSha256}.qspkg`), archive, { mode: 0o600 })
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [unknown] }))
    await serve(createPluginReleasesRoute(options), async request => assert.equal((await request()).status, 503))
  })
})

test('one invalid, duplicate, or symlinked release rejects the whole registry', async () => {
  await fixture(async options => {
    const archive = Buffer.from('immutable package')
    const release = approvedRelease(archive)
    const artifact = join(options.artifactDir, `${release.packageSha256}.qspkg`)
    await writeFile(artifact, archive, { mode: 0o600 })
    for (const invalid of [
      { ...release, title: '未经签署的改名' },
      { ...release, installable: true },
      { ...release, verificationScope: 'executable-payload-verified' },
      { ...release, packageSha256: '0'.repeat(64) },
      { ...release, price: 100 },
    ]) {
      await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [release, invalid] }))
      await serve(createPluginReleasesRoute(options), async request => assert.equal((await request()).status, 503))
    }
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [release, release] }))
    await serve(createPluginReleasesRoute(options), async request => assert.equal((await request()).status, 503))
    await rm(artifact)
    await symlink(join(options.dir, 'outside'), artifact)
    await writeFile(join(options.dir, 'outside'), archive)
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [release] }))
    await serve(createPluginReleasesRoute(options), async request => assert.equal((await request()).status, 503))
  })
})

test('a running release endpoint rejects replacement or removal of a previously published version', async () => {
  await fixture(async options => {
    const firstArchive = Buffer.from('version one')
    const secondArchive = Buffer.from('same-version-different-bits')
    const first = approvedRelease(firstArchive)
    const replacement = approvedRelease(secondArchive, { releaseId: 'release-two' })
    await writeFile(join(options.artifactDir, `${first.packageSha256}.qspkg`), firstArchive, { mode: 0o600 })
    await writeFile(join(options.artifactDir, `${replacement.packageSha256}.qspkg`), secondArchive, { mode: 0o600 })
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [first] }))
    await serve(createPluginReleasesRoute(options), async request => {
      assert.equal((await request()).status, 200)
      await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [replacement] }))
      assert.equal((await request()).status, 503)
      await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [] }))
      assert.equal((await request()).status, 503)
    })
  })
})

test('the version pin survives a route restart and prevents a changed signed archive', async () => {
  await fixture(async options => {
    const firstArchive = Buffer.from('first approved bytes')
    const secondArchive = Buffer.from('second approved bytes')
    const first = approvedRelease(firstArchive)
    const replacement = approvedRelease(secondArchive, { releaseId: 'release-replacement' })
    await writeFile(join(options.artifactDir, `${first.packageSha256}.qspkg`), firstArchive, { mode: 0o600 })
    await writeFile(join(options.artifactDir, `${replacement.packageSha256}.qspkg`), secondArchive, { mode: 0o600 })
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [first] }))
    await serve(createPluginReleasesRoute(options), async request => assert.equal((await request()).status, 200))
    await writeFile(options.registryPath, JSON.stringify({ version: 1, releases: [replacement] }))
    await serve(createPluginReleasesRoute(options), async request => assert.equal((await request()).status, 503))
  })
})
