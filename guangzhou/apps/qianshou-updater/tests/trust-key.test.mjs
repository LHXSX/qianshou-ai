/**
 * Trust-root tests for the updater: the shipped verification key exists, is Ed25519, matches the
 * pinned fingerprint, actually verifies the signed release envelope of a real release, and the
 * packaging gate refuses anything else before writing a single file.
 *
 * The real envelope fixture is the public manifest of the 2026-09-13 `0.2.1` preview release. It
 * is the only offline artifact that proves the committed public key pairs with the private release
 * key, and it needs no private material — verification is pure public-key cryptography.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildUpdater } from '../build.mjs'
import { verifyReleaseEnvelope } from '../manifest.mjs'
import { RELEASE_PUBLIC_KEY_SPKI_SHA256, TRUST_KEY_FILE, TrustKeyError,
  loadInstalledReleasePublicKey, loadReleasePublicKey, spkiSha256 } from '../trust-key.mjs'

// The release was published 2026-09-13; a fixed clock keeps the fixture deterministic.
const fixtureNow = () => Date.parse('2026-09-16T00:00:00Z')
const envelope = new URL('./release-envelope-0.2.1.json', import.meta.url)
const installedKey = new URL(`../${TRUST_KEY_FILE}`, import.meta.url)

test('ships an Ed25519 verification key whose fingerprint is the pinned one', () => {
  const key = loadInstalledReleasePublicKey()
  assert.equal(key.asymmetricKeyType, 'ed25519')
  assert.equal(spkiSha256(readFileSync(installedKey, 'utf8')), RELEASE_PUBLIC_KEY_SPKI_SHA256)
})

test('the pinned key verifies the signed envelope of the published 0.2.1 release', async () => {
  const bytes = await readFile(envelope)
  const verified = verifyReleaseEnvelope(bytes, { role: 'controller', platform: 'darwin', arch: 'arm64' }, { now: fixtureNow })
  assert.equal(verified.release.version, '0.2.1')
  assert.equal(verified.release.channel, 'preview')
  assert.equal(verified.release.artifacts.length, 5)
  assert.equal(verified.artifact.fileName, 'qianshou-agent-0.2.1-darwin-arm64.zip')
})

test('a different Ed25519 key is refused by the fingerprint even though it parses', () => {
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  assert.notEqual(spkiSha256(other), RELEASE_PUBLIC_KEY_SPKI_SHA256)
  assert.throws(() => loadReleasePublicKey(other, { pinned: true }), TrustKeyError)
  // Injected keys are test dependencies, not deployment trust roots: they parse, while the
  // installed file — the root production verifies against — always carries the fingerprint check.
  assert.equal(loadReleasePublicKey(other).asymmetricKeyType, 'ed25519')
})

test('non-Ed25519, empty and unparseable keys fail closed', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' })
  assert.throws(() => loadReleasePublicKey(rsa), { name: 'TrustKeyError', message: /Ed25519/ })
  assert.throws(() => loadReleasePublicKey(''), { name: 'TrustKeyError', message: /empty/ })
  assert.throws(() => loadReleasePublicKey('not a pem'), { name: 'TrustKeyError', message: /parseable/ })
})

test('the packaging gate refuses an untrusted key before writing any output', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'qianshou-updater-gate-'))
  const output = join(parent, 'release')
  await assert.rejects(
    buildUpdater(output, { trustKey: () => { throw new TrustKeyError('Release public key fingerprint deadbeef is not the pinned release key') } }),
    { name: 'TrustKeyError' })
  assert.equal(existsSync(output), false)
})
