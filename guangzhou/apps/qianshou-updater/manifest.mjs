/** Signed update discovery shared by both desktop applications; never downloads an archive. */
import { verify } from 'node:crypto'
import { loadInstalledReleasePublicKey, loadReleasePublicKey } from './trust-key.mjs'

export const UPDATE_ORIGIN = 'https://qianshousuanli.com'
export const UPDATE_FEED_URL = `${UPDATE_ORIGIN}/downloads/qianshou-agent/updates/latest.json`
export const MAX_FEED_BYTES = 1024 * 1024
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
const FEED_TIMEOUT_MS = 30_000
const verifiedReleases = new WeakSet()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Stable updater failure code; messages never contain network response bodies or local keys. */
export class UpdateError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'UpdateError'
    this.code = code
  }
}

function invalid(message) { throw new UpdateError('INVALID_MANIFEST', message) }

function object(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    invalid(`Invalid ${label} fields`)
  }
}

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) invalid('Version must be x.y.z')
  const parts = version.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) invalid('Version component is too large')
  return parts
}

/** Compare strict three-component release versions, without coercion or prerelease aliases. */
export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  return 0
}

function validateTarget(target) {
  if (target === null || typeof target !== 'object'
    || !['controller', 'companion'].includes(target.role)
    || !['darwin', 'win32', 'linux'].includes(target.platform)
    || !['arm64', 'x64'].includes(target.arch)) invalid('Invalid update target')
  if (target.currentVersion !== undefined) versionParts(target.currentVersion)
}

function base64(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FEED_BYTES
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid(`Invalid ${label} encoding`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) invalid(`Invalid ${label} encoding`)
  return bytes
}

function parseJson(bytes, label) {
  try { return JSON.parse(decoder.decode(bytes)) }
  catch { invalid(`Invalid ${label} JSON or UTF-8`) }
}

function validateRelease(release, now) {
  object(release, ['schemaVersion', 'product', 'version', 'channel', 'releasedAt', 'bootstrapVersion', 'artifacts'], 'release')
  if (release.schemaVersion !== 1 || release.product !== 'qianshou-agent' || release.channel !== 'preview') invalid('Unsupported release schema')
  if (release.bootstrapVersion !== 1) throw new UpdateError('BOOTSTRAP_UNSUPPORTED', 'This release requires another updater bootstrap')
  versionParts(release.version)
  const timestamp = Date.parse(release.releasedAt)
  if (typeof release.releasedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(release.releasedAt)
    || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().replace('.000Z', 'Z') !== release.releasedAt.replace('.000Z', 'Z')
    || timestamp > now() + 5 * 60_000) invalid('Invalid release time')
  if (!Array.isArray(release.artifacts) || release.artifacts.length === 0 || release.artifacts.length > 64) invalid('Invalid artifact count')
  const targets = new Set()
  for (const artifact of release.artifacts) {
    object(artifact, ['role', 'platform', 'arch', 'fileName', 'url', 'size', 'sha256', 'notes'], 'artifact')
    validateTarget(artifact)
    const target = `${artifact.role}/${artifact.platform}/${artifact.arch}`
    if (targets.has(target)) invalid('Duplicate artifact target')
    targets.add(target)
    if (typeof artifact.fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(artifact.fileName)
      || artifact.fileName.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(artifact.fileName)) invalid('Invalid artifact filename')
    // Equality rejects credentials, redirects, queries, fragments, encoded traversal and alternate origins.
    if (artifact.url !== `${UPDATE_ORIGIN}/downloads/qianshou-agent/${release.version}/${artifact.fileName}`) invalid('Artifact URL is outside the release directory')
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_ARCHIVE_BYTES) invalid('Invalid artifact size')
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) invalid('Invalid artifact SHA-256')
    if (!Array.isArray(artifact.notes) || artifact.notes.length > 32
      || artifact.notes.some(note => typeof note !== 'string' || note.length > 2000
        || [...note].some(character => character.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(character)))) invalid('Invalid release notes')
    Object.freeze(artifact.notes)
    Object.freeze(artifact)
  }
  Object.freeze(release.artifacts)
  return Object.freeze(release)
}

/**
 * Verify the original envelope bytes offline and select exactly one application/platform/architecture.
 * Same versions are valid for bootstrap verification; an optional currentVersion rejects downgrades.
 * @param {Uint8Array|string} rawBytes Original UTF-8 envelope, not its base64 transport representation.
 * @param {{role:string,platform:string,arch:string,currentVersion?:string}} target Fixed local application identity.
 * @param {{publicKeyPem?:string,now?:()=>number}} dependencies Tests may inject a public key and clock.
 * @returns {object} Frozen verified release, selected artifact or null, and base64 of the original envelope bytes.
 */
export function verifyReleaseEnvelope(rawBytes, target, { publicKeyPem, now = Date.now } = {}) {
  validateTarget(target)
  if (!(rawBytes instanceof Uint8Array) && typeof rawBytes !== 'string') invalid('Envelope must contain UTF-8 bytes')
  const bytes = Buffer.from(rawBytes)
  if (bytes.length === 0 || bytes.length > MAX_FEED_BYTES) invalid('Envelope exceeds its size limit')
  const envelope = parseJson(bytes, 'envelope')
  object(envelope, ['schemaVersion', 'payload', 'signature'], 'signed envelope')
  if (envelope.schemaVersion !== 1) invalid('Unsupported envelope schema')
  const payload = base64(envelope.payload, 'payload')
  const signature = base64(envelope.signature, 'signature')
  let key
  // An injected key is a test dependency; the installed file is the deployment trust root and
  // must additionally match the pinned fingerprint (see trust-key.mjs).
  try { key = publicKeyPem === undefined ? loadInstalledReleasePublicKey() : loadReleasePublicKey(publicKeyPem) }
  catch { throw new UpdateError('TRUST_KEY_UNAVAILABLE', 'The installed updater public key is unavailable') }
  if (signature.length !== 64 || !verify(null, payload, key, signature)) throw new UpdateError('INVALID_SIGNATURE', 'Update signature verification failed')
  const release = validateRelease(parseJson(payload, 'release'), now)
  if (target.currentVersion !== undefined && compareVersions(release.version, target.currentVersion) < 0) {
    throw new UpdateError('UPDATE_DOWNGRADE', 'The signed release is older than the installed application')
  }
  const artifact = release.artifacts.find(item => item.role === target.role && item.platform === target.platform && item.arch === target.arch) ?? null
  const result = Object.freeze({ release, artifact, version: release.version, envelope: bytes.toString('base64') })
  verifiedReleases.add(result)
  return result
}

/** Reject reconstructed objects that have not passed signature validation in this process. */
export function assertVerifiedRelease(value) {
  if (!verifiedReleases.has(value) || value.artifact === null) throw new UpdateError('UNVERIFIED_RELEASE', 'A verified artifact is required')
  return value
}

/** Shared timed cancellation scope for fetch and its complete streamed response. */
export function updateOperation(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new UpdateError('UPDATE_TIMEOUT', 'Update request timed out')), timeoutMs)
  return { signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
}

/** Reject HTTP failure and any redirected response, including redirects hidden by a fetch wrapper. */
export function assertUpdateResponse(response, expectedUrl, limit) {
  if (response.status !== 200 || response.redirected || (response.url && response.url !== expectedUrl)) {
    throw new UpdateError('UPDATE_HTTP', 'Update server returned an unexpected response')
  }
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) {
    throw new UpdateError('UPDATE_SIZE', 'Update response exceeds its size limit')
  }
  if (!response.body) throw new UpdateError('UPDATE_HTTP', 'Update response has no body')
}

/**
 * Fetch only the fixed signed feed. No archive is downloaded or installed by this operation.
 * @param {{role:string,platform:string,arch:string,currentVersion:string}} target Local application identity and version.
 * @param {{signal?:AbortSignal,fetchImpl?:typeof fetch,publicKeyPem?:string,now?:()=>number}} dependencies Trusted test dependencies.
 * @returns {Promise<object>} Available, current, or unsupported result. Only available results can be downloaded.
 */
export async function checkForUpdate(target, { signal, fetchImpl = globalThis.fetch, publicKeyPem, now = Date.now } = {}) {
  validateTarget(target)
  versionParts(target.currentVersion)
  const operation = updateOperation(signal, FEED_TIMEOUT_MS)
  let response
  try {
    operation.signal.throwIfAborted()
    response = await fetchImpl(UPDATE_FEED_URL, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: operation.signal })
    assertUpdateResponse(response, UPDATE_FEED_URL, MAX_FEED_BYTES)
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      operation.signal.throwIfAborted()
      length += chunk.byteLength
      if (length > MAX_FEED_BYTES) throw new UpdateError('UPDATE_SIZE', 'Update feed exceeds its size limit')
      chunks.push(chunk)
    }
    operation.signal.throwIfAborted()
    // Downgrade feeds are reported as current. Offline verification can independently enforce an installed floor.
    const verified = verifyReleaseEnvelope(Buffer.concat(chunks, length), targetWithoutVersion(target), { publicKeyPem, now })
    const status = compareVersions(verified.version, target.currentVersion) <= 0 ? 'current' : verified.artifact ? 'available' : 'unsupported'
    const result = Object.freeze({ ...verified, currentVersion: target.currentVersion, status })
    if (status === 'available') verifiedReleases.add(result)
    return result
  } catch (error) {
    if (operation.signal.aborted) throw operation.signal.reason
    if (error instanceof UpdateError) throw error
    throw new UpdateError('UPDATE_NETWORK', 'Could not retrieve the signed update feed')
  } finally {
    operation.dispose()
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => { /* Completed or failed body is already closed. */ })
  }
}

function targetWithoutVersion({ role, platform, arch }) { return { role, platform, arch } }
