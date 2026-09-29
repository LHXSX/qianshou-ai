/**
 * The updater trust root: the release verification key, loaded and pinned in one place.
 *
 * Why this exists as a module instead of two `readFileSync` calls: the trust root must be the
 * SAME artifact at packaging time and at runtime, and it must be impossible to swap silently.
 * `public-key.pem` ships as an application resource, so its fingerprint is pinned here as a
 * constant: a replaced file (different key, same name) fails closed instead of authenticating
 * someone else's updates. Rotating the release key therefore requires editing this constant —
 * that is the point, and the rotation must be reviewed like any other trust change.
 *
 * The private counterpart is never an application resource and never enters this repository.
 */
import { createHash, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Application-resource name of the pinned release verification key. */
export const TRUST_KEY_FILE = 'public-key.pem'

/** SPKI DER SHA-256 of the release verification key that signed the 0.2.1 preview channel. */
export const RELEASE_PUBLIC_KEY_SPKI_SHA256 = '0856a364466651cd91e6988ad61fb2da551639851e421261334c9a9e0ffcd542'

/** Trust-root failure raised before any signature is trusted; never contains key material. */
export class TrustKeyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TrustKeyError'
  }
}

/** SPKI DER SHA-256 of a PEM public key; the only comparable, loggable identity of a key. */
export function spkiSha256(pem) {
  let key
  try { key = createPublicKey(pem) }
  catch { throw new TrustKeyError('Release public key is not a parseable PEM public key') }
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

/**
 * Parse a PEM public key and require the shape the updater's verification relies on.
 * @param {string} pem PEM text.
 * @param {{pinned?:boolean}} options `pinned` also requires the shipped fingerprint; injected
 *   test keys stay injectable (they are never a deployment trust root) and only need Ed25519.
 * @returns {import('node:crypto').KeyObject}
 */
export function loadReleasePublicKey(pem, { pinned = false } = {}) {
  if (typeof pem !== 'string' || pem.trim() === '') throw new TrustKeyError('Release public key is empty')
  let key
  try { key = createPublicKey(pem) }
  catch { throw new TrustKeyError('Release public key is not a parseable PEM public key') }
  if (key.asymmetricKeyType !== 'ed25519') throw new TrustKeyError('The updater requires an Ed25519 public key')
  if (pinned) {
    const actual = spkiSha256(pem)
    if (actual !== RELEASE_PUBLIC_KEY_SPKI_SHA256) {
      throw new TrustKeyError(`Release public key fingerprint ${actual} is not the pinned release key`)
    }
  }
  return key
}

/**
 * Load `public-key.pem` from this application directory and require the pinned fingerprint.
 * Both the packaging gate and the installed runtime call this, so a release can never ship a
 * build whose trust root differs from the key the release was signed with.
 */
export function loadInstalledReleasePublicKey() {
  let pem
  try { pem = readFileSync(new URL(`./${TRUST_KEY_FILE}`, import.meta.url), 'utf8') }
  catch { throw new TrustKeyError(`${TRUST_KEY_FILE} is missing from the updater application directory`) }
  return loadReleasePublicKey(pem, { pinned: true })
}
