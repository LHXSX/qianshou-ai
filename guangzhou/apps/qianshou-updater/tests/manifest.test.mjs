/** Signed-feed protocol and target/version rejection tests; no real keys or external network calls. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { checkForUpdate, compareVersions, verifyReleaseEnvelope, assertVerifiedRelease,
  updateOperation, MAX_FEED_BYTES, MAX_ARCHIVE_BYTES, UPDATE_FEED_URL } from '../manifest.mjs'
import { artifact, release, envelope, target, dependencies, now } from './fixtures.mjs'

test('verifies original signed bytes and selects exact role/platform/architecture', async () => {
  const bytes = envelope(release({ artifacts: [artifact({ role: 'companion' }), artifact({ platform: 'win32', arch: 'x64' }), artifact()] }))
  const verified = verifyReleaseEnvelope(bytes, target, dependencies)
  assert.equal(verified.artifact.role, 'controller')
  assert.equal(verified.artifact.platform, 'darwin')
  assert.equal(verified.artifact.arch, 'arm64')
  assert.equal(verified.envelope, bytes.toString('base64'))
  assert.equal(verified.version, '0.2.2')
  assert.throws(() => { verified.artifact.sha256 = '0'.repeat(64) }, TypeError)
  assert.throws(() => { verified.artifact.notes.push('injected') }, TypeError)
  assert.equal(assertVerifiedRelease(verified), verified)
  assert.throws(() => assertVerifiedRelease({ ...verified }), { code: 'UNVERIFIED_RELEASE' })
})

test('check only fetches fixed signed feed with redirects disabled and exposes available metadata', async () => {
  const requested = []
  const checked = await checkForUpdate(target, { ...dependencies, fetchImpl: async (url, options) => {
    requested.push({ url, options })
    return new Response(envelope())
  } })
  assert.equal(checked.status, 'available')
  assert.equal(checked.currentVersion, '0.2.1')
  assert.equal(requested.length, 1)
  assert.equal(requested[0].url, UPDATE_FEED_URL)
  assert.equal(requested[0].options.redirect, 'error')
  assert.equal(requested[0].options.credentials, 'omit')
  assert.equal(assertVerifiedRelease(checked), checked)
})

test('equal/older feeds are current and an unavailable target is never substituted', async () => {
  const fetchImpl = async () => new Response(envelope())
  for (const currentVersion of ['0.2.2', '0.3.0', '1.0.0']) {
    const checked = await checkForUpdate({ ...target, currentVersion }, { ...dependencies, fetchImpl })
    assert.equal(checked.status, 'current')
    assert.throws(() => assertVerifiedRelease(checked), { code: 'UNVERIFIED_RELEASE' })
  }
  const unavailable = await checkForUpdate({ ...target, role: 'companion' }, { ...dependencies, fetchImpl })
  assert.equal(unavailable.status, 'unsupported')
  assert.equal(unavailable.artifact, null)
  assert.equal(verifyReleaseEnvelope(envelope(), { ...target, currentVersion: '0.2.2' }, dependencies).version, '0.2.2')
  assert.throws(() => verifyReleaseEnvelope(envelope(), { ...target, currentVersion: '0.3.0' }, dependencies), { code: 'UPDATE_DOWNGRADE' })
})

test('refuses missing, modified, malformed, or foreign signatures and a non-Ed25519 trust key', () => {
  const plain = JSON.parse(envelope())
  assert.throws(() => verifyReleaseEnvelope(JSON.stringify(release()), target, dependencies), { code: 'INVALID_MANIFEST' })
  assert.throws(() => verifyReleaseEnvelope(JSON.stringify({ ...plain, signature: '' }), target, dependencies), { code: 'INVALID_MANIFEST' })
  assert.throws(() => verifyReleaseEnvelope(JSON.stringify({ ...plain, payload: Buffer.from('{}').toString('base64') }), target, dependencies), { code: 'INVALID_SIGNATURE' })
  assert.throws(() => verifyReleaseEnvelope(JSON.stringify({ ...plain, signature: `${plain.signature}\n` }), target, dependencies), { code: 'INVALID_MANIFEST' })
  const foreign = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  assert.throws(() => verifyReleaseEnvelope(envelope(), target, { ...dependencies, publicKeyPem: foreign }), { code: 'INVALID_SIGNATURE' })
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' })
  assert.throws(() => verifyReleaseEnvelope(envelope(), target, { ...dependencies, publicKeyPem: rsa }), { code: 'TRUST_KEY_UNAVAILABLE' })
})

test('strict schema rejects duplicate targets, unsigned extra fields and incompatible bootstraps', () => {
  for (const value of [release({ artifacts: [artifact(), artifact()] }), release({ channel: 'stable' }),
    release({ schemaVersion: 2 }), release({ product: 'another-product' }), release({ extra: true }),
    release({ artifacts: [] }), release({ artifacts: [artifact({ role: 'worker' })] })]) {
    assert.throws(() => verifyReleaseEnvelope(envelope(value), target, dependencies), { code: 'INVALID_MANIFEST' })
  }
  assert.throws(() => verifyReleaseEnvelope(envelope(release({ bootstrapVersion: 2 })), target, dependencies), { code: 'BOOTSTRAP_UNSUPPORTED' })
})

test('artifact URLs cannot redirect authority or traverse the release path', () => {
  const original = artifact().url
  for (const url of [original.replace('https:', 'http:'), original.replace('qianshousuanli.com', 'evil.example'),
    original.replace('https://', 'https://user:pass@'), `${original}?token=1`, `${original}#hash`,
    original.replace('/0.2.2/', '/0.2.1/'), original.replace('/0.2.2/', '/0.2.2/../'),
    original.replace('qianshou-agent-0.2.2', '%71ianshou-agent-0.2.2')]) {
    assert.throws(() => verifyReleaseEnvelope(envelope(release({ artifacts: [artifact({ url })] })), target, dependencies), { code: 'INVALID_MANIFEST' })
  }
  for (const fileName of ['../escape.zip', 'a/b.zip', 'a\\b.zip', 'CON.zip', 'trailing.', 'name.zip?x']) {
    assert.throws(() => verifyReleaseEnvelope(envelope(release({ artifacts: [artifact({ fileName })] })), target, dependencies), { code: 'INVALID_MANIFEST' })
  }
})

test('version comparison is numeric, strict and rejects unsafe integers', () => {
  assert.equal(compareVersions('0.10.0', '0.9.99'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  for (const version of ['01.2.3', 'v1.2.3', '1.2', '1.2.3-preview', '9007199254740992.1.0', '1.2.3\n']) {
    assert.throws(() => compareVersions(version, '1.2.3'), { code: 'INVALID_MANIFEST' })
  }
})

test('feed/archive limits and release timestamps reject malformed signed data', () => {
  assert.throws(() => verifyReleaseEnvelope(Buffer.alloc(MAX_FEED_BYTES + 1), target, dependencies), { code: 'INVALID_MANIFEST' })
  for (const size of [0, -1, 1.5, MAX_ARCHIVE_BYTES + 1]) {
    assert.throws(() => verifyReleaseEnvelope(envelope(release({ artifacts: [artifact({ size })] })), target, dependencies), { code: 'INVALID_MANIFEST' })
  }
  for (const releasedAt of ['not a date', '2026-02-31T00:00:00Z', new Date(now() + 301_000).toISOString()]) {
    assert.throws(() => verifyReleaseEnvelope(envelope(release({ releasedAt })), target, dependencies), { code: 'INVALID_MANIFEST' })
  }
})

test('HTTP redirects, unexpected response URLs and chunked oversized feeds fail', async () => {
  await assert.rejects(checkForUpdate(target, { ...dependencies, fetchImpl: async () => new Response('', { status: 302 }) }), { code: 'UPDATE_HTTP' })
  const unexpected = new Response(envelope())
  Object.defineProperty(unexpected, 'url', { value: 'https://evil.example/feed' })
  await assert.rejects(checkForUpdate(target, { ...dependencies, fetchImpl: async () => unexpected }), { code: 'UPDATE_HTTP' })
  await assert.rejects(checkForUpdate(target, { ...dependencies, fetchImpl: async () => new Response(Buffer.alloc(MAX_FEED_BYTES + 1)) }), { code: 'UPDATE_SIZE' })
  await assert.rejects(checkForUpdate(target, { ...dependencies, fetchImpl: async () => new Response('', { headers: { 'content-length': MAX_FEED_BYTES + 1 } }) }), { code: 'UPDATE_SIZE' })
})

test('pre-aborted checks do not fetch and timeout scopes propagate cancellation', async () => {
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  await assert.rejects(checkForUpdate(target, { ...dependencies, signal: controller.signal, fetchImpl: () => assert.fail('must not fetch') }), /caller cancelled/)
  const operation = updateOperation(undefined, 5)
  await new Promise(resolve => operation.signal.addEventListener('abort', resolve, { once: true }))
  assert.equal(operation.signal.reason.code, 'UPDATE_TIMEOUT')
  operation.dispose()
})

test('fetch errors do not expose remote response bodies or private transport details', async () => {
  await assert.rejects(checkForUpdate(target, { ...dependencies, fetchImpl: async () => {
    throw new Error('transport internal /private/example key=not-real')
  } }), error => error.code === 'UPDATE_NETWORK' && !error.message.includes('/private/') && !error.message.includes('key='))
})
