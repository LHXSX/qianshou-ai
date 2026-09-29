import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPluginLicenseBearerVerifier } from '../src/plugin-license-bearer.ts'
import { createPluginSubmissionBearerRoute, PLUGIN_SUBMISSIONS_BEARER_PATH } from '../src/plugin-submission-bearer.ts'
import { createPluginSubmissionRoute } from '../src/plugin-submissions.ts'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const ownerToken = 'owner-token-167-valid'
const otherToken = 'other-token-999-valid'
const publisherId = 'bound-publisher'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, bytes } of entries) {
    const path = Buffer.from(name)
    const checksum = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(path.length, 26)
    locals.push(local, path, bytes)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE((3 << 8) | 20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(bytes.length, 20)
    directory.writeUInt32LE(bytes.length, 24)
    directory.writeUInt16LE(path.length, 28)
    directory.writeUInt32LE((0o100600 << 16) >>> 0, 38)
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

function declaration() {
  const input = Buffer.from(JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }))
  const output = Buffer.from(JSON.stringify({ type: 'object' }))
  const manifest = Buffer.from(JSON.stringify({
    format: 'qianshou.declaration.v1', pluginId: 'example.bearer-tool', version: '1.0.0',
    releaseId: 'draft.bearer-tool-1.0.0', platforms: ['darwin'], architectures: ['arm64'],
    operations: [{ capabilityId: 'text.transform', operationId: 'tool.run', executorKind: 'tool',
      inputSchemaSha256: sha(input), outputSchemaSha256: sha(output), permissions: [] }],
  }))
  return zip([{ name: 'manifest.json', bytes: manifest },
    { name: 'schemas/0/input.json', bytes: input }, { name: 'schemas/0/output.json', bytes: output }])
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function rawPost(url, headers, body) {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('public Mac submission bridge binds each Bearer to Shanghai and exposes only submit/mine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-bearer-submit-'))
  const stagingDir = join(root, 'staging')
  const artifactDir = join(root, 'artifacts')
  const registryPath = join(root, 'releases.json')
  await mkdir(stagingDir, { mode: 0o700 })
  await mkdir(artifactDir, { mode: 0o700 })
  const keyPair = generateKeyPairSync('ed25519')
  const publicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  let bridge
  let accountAvailable = true
  const server = createServer((incoming, outgoing) => {
    if (incoming.url === '/api/v8/auth/me') {
      if (!accountAvailable) {
        outgoing.writeHead(503); outgoing.end(); return
      }
      const token = incoming.headers.authorization
      const id = token === `Bearer ${ownerToken}` ? 167 : token === `Bearer ${otherToken}` ? 999 : null
      outgoing.writeHead(id === null ? 401 : 200, { 'content-type': 'application/json' })
      outgoing.end(id === null ? JSON.stringify({ ok: false }) : JSON.stringify({ ok: true,
        account: { id, role: 'personal' } }))
      return
    }
    if (bridge === undefined) { outgoing.writeHead(503); outgoing.end(); return }
    void bridge.handler(incoming, outgoing)
  })
  const origin = await listen(server)
  const verifyBearer = createPluginLicenseBearerVerifier({ accountApiOrigin: origin })
  const submissions = createPluginSubmissionRoute({ stagingDir, releaseOptions: {
    registryPath, artifactDir, publisherKeys: { [publisherId]: publicKey }, operatorKeys: {},
  }, publisherAccounts: { [publisherId]: '167' }, authenticate: request => verifyBearer(request) })
  bridge = createPluginSubmissionBearerRoute({ handle: submissions })
  const url = `${origin}${PLUGIN_SUBMISSIONS_BEARER_PATH}`
  const send = async (body, token = ownerToken, headers = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const archive = declaration()
  const submit = { action: 'submit', publisherId, title: 'Bearer tool', summary: 'A bounded data declaration',
    archiveBase64: archive.toString('base64') }
  try {
    const missing = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submit) })
    assert.equal(missing.status, 401)
    assert.equal((await send(submit, 'invalid-token-but-long-enough')).status, 401)
    assert.deepEqual(await send(submit, otherToken), { status: 403,
      body: { ok: false, code: 'PUBLISHER_NOT_BOUND' } })
    assert.equal((await send(submit, ownerToken, { origin: 'https://example.test' })).status, 403)
    assert.equal((await send(submit, ownerToken, { cookie: 'browser-session=other' })).status, 403)
    assert.equal((await send(submit, ownerToken, { 'content-encoding': 'gzip' })).status, 400)
    assert.equal(await rawPost(url, ['authorization', `Bearer ${ownerToken}`,
      'authorization', `Bearer ${otherToken}`, 'content-type', 'application/json'],
    JSON.stringify({ action: 'mine' })), 400) // Node rejects the duplicate before the bridge can read it.
    assert.equal((await send({ action: 'approve', submissionId: 'anything', release: {} })).status, 403)
    assert.equal((await send({ action: 'approve-declaration', submissionId: 'anything', review: {} })).status, 403)
    assert.equal((await send({ action: 'approve-execution', submissionId: 'anything', candidate: {} })).status, 403)
    assert.equal((await send({ action: 'pending' })).status, 403)
    assert.equal((await fetch(url, { method: 'GET' })).status, 405)
    accountAvailable = false
    assert.equal((await send(submit)).status, 503)
    accountAvailable = true
    const accepted = await send(submit)
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.ok, true)
    assert.equal(accepted.body.submission.accountId, '167')
    assert.equal(accepted.body.submission.packageSha256, sha(archive))
    assert.equal(accepted.body.submission.manifest.format, 'qianshou.declaration.v1')
    const mine = await send({ action: 'mine' })
    assert.equal(mine.status, 200)
    assert.deepEqual(mine.body.submissions.map(row => row.submissionId),
      [accepted.body.submission.submissionId])
    assert.equal(mine.body.submissions[0].review.status, 'pending')
    const otherMine = await send({ action: 'mine' }, otherToken)
    assert.deepEqual(otherMine.body.submissions, [])
    const oversized = await fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json',
    }, body: ' '.repeat(3 * 1024 * 1024 + 1) })
    assert.equal(oversized.status, 413)
    const noIdentity = createPluginSubmissionRoute({ stagingDir, releaseOptions: {
      registryPath, artifactDir, publisherKeys: { [publisherId]: publicKey }, operatorKeys: {},
    }, publisherAccounts: { [publisherId]: '167' },
    authenticate: createPluginLicenseBearerVerifier({}) })
    bridge = createPluginSubmissionBearerRoute({ handle: noIdentity })
    assert.equal((await send({ action: 'mine' })).status, 503)
    bridge = createPluginSubmissionBearerRoute({ handle: async () => Response.json({
      ok: true, submissions: 'x'.repeat(4 * 1024 * 1024),
    }) })
    assert.equal((await send({ action: 'mine' })).status, 503)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
