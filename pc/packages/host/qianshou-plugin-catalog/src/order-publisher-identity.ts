/** Private, account-scoped author key and signed declaration for one order publication. */
import { constants } from 'node:fs'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { lstat, link, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CatalogFailure } from './registry.ts'
import type { CanonicalOrderArchive } from './order-source-archive.ts'
import { validateOrderSourceInventory } from './order-source-inventory.ts'
import { decodeWindowsPublisherSecret, encodeWindowsPublisherSecret,
  windowsPublisherSecret } from './order-publisher-windows-secret.ts'

const KEY_SCHEMA = 'qianshou.order-adapter-key-enrollment.v1'
const AUTHOR_SCHEMA = 'qianshou.order-adapter-author-manifest.v2'
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MAX_REPLY = 16 * 1024

/** Python json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=False). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new CatalogFailure('order-author-unavailable')
  return encoded
}

function safeOrigin(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new CatalogFailure('order-author-unavailable') }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new CatalogFailure('order-author-unavailable')
  }
  return url
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (response.body === null) throw new CatalogFailure('order-author-unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      count += item.value.byteLength
      if (count > MAX_REPLY) throw new CatalogFailure('order-author-unavailable')
      chunks.push(item.value)
    }
  } finally { try { await reader.cancel() } catch { /* Complete. */ } reader.releaseLock() }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* Invalid platform body. */ }
  throw new CatalogFailure('order-author-unavailable')
}

async function post(origin: URL, path: string, token: string, body: Record<string, unknown> | null,
  send: typeof fetch): Promise<Record<string, unknown>> {
  if (!token || /[\r\n]/u.test(token)) throw new CatalogFailure('order-auth-required')
  let response: Response
  try {
    response = await send(new URL(path, origin), {
      method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', authorization: `Bearer ${token}`,
        ...(body === null ? {} : { 'content-type': 'application/json' }) },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    })
  } catch { throw new CatalogFailure('order-author-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Ignore untrusted detail. */ }
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    if (response.status === 409) throw new CatalogFailure('order-publication-conflict')
    throw new CatalogFailure('order-author-unavailable')
  }
  return boundedJson(response)
}

async function identityDirectory(profileDir: string): Promise<string> {
  if (!isAbsolute(profileDir)) throw new CatalogFailure('order-author-key-unavailable')
  const rootStat = await lstat(profileDir)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || (typeof process.getuid === 'function' && rootStat.uid !== process.getuid())) {
    throw new CatalogFailure('order-author-key-unavailable')
  }
  const root = await realpath(profileDir)
  const dir = join(root, 'order-publisher-identities')
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const stat = await lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || await realpath(dir) !== dir) throw new CatalogFailure('order-author-key-unavailable')
  return dir
}

async function privateKeyBytes(path: string, ownerId: number): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
    || before.size < 100 || before.size > (process.platform === 'win32' ? 16 * 1024 : 4096)
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    throw new CatalogFailure('order-author-key-unavailable')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) {
      throw new CatalogFailure('order-author-key-unavailable')
    }
    // A mutable inode cannot make readFile allocate an unbounded replacement between checks.
    const buffer = Buffer.alloc((process.platform === 'win32' ? 16 * 1024 : 4096) + 1)
    let count = 0
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, count)
      if (read.bytesRead === 0) break
      count += read.bytesRead
    }
    if (count !== before.size) { buffer.fill(0); throw new CatalogFailure('order-author-key-unavailable') }
    const bytes = buffer.subarray(0, count)
    const after = await lstat(path)
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
      || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)) {
      buffer.fill(0)
      throw new CatalogFailure('order-author-key-unavailable')
    }
    return process.platform === 'win32'
      ? await windowsPublisherSecret('unprotect', decodeWindowsPublisherSecret(bytes, ownerId), ownerId) : bytes
  } finally { await file.close() }
}

export interface OrderPublisherIdentity {
  readonly ownerId: number
  readonly keyId: string
  readonly publicKey: string
  /** Sign only canonical, fixed-schema payloads inside this module. */
  sign(payload: Record<string, unknown>): string
}

/** Create once per local profile+account; no key bytes ever leave the Host. */
export async function accountOrderPublisherIdentity(profileDir: string,
  ownerId: number): Promise<OrderPublisherIdentity> {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new CatalogFailure('order-author-key-unavailable')
  let dir: string
  try { dir = await identityDirectory(profileDir) }
  catch { throw new CatalogFailure('order-author-key-unavailable') }
  const directoryBefore = await lstat(dir)
  const path = join(dir, process.platform === 'win32' ? `owner-${ownerId}.dpapi.json` : `owner-${ownerId}.pem`)
  try { await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CatalogFailure('order-author-key-unavailable')
    const pair = generateKeyPairSync('ed25519')
    const pem = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))
    let stored: Buffer
    try {
      stored = process.platform === 'win32'
        ? encodeWindowsPublisherSecret(await windowsPublisherSecret('protect', pem, ownerId), ownerId) : pem
    } catch { pem.fill(0); throw new CatalogFailure('order-author-key-unavailable') }
    const temporary = join(dir, `.owner-${ownerId}-${randomBytes(16).toString('hex')}.tmp`)
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      try { await file.writeFile(stored); await file.sync() } finally { await file.close() }
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CatalogFailure('order-author-key-unavailable')
    } finally { pem.fill(0); stored.fill(0); await unlink(temporary).catch(() => undefined) }
    // If another caller won creation, load only its verified 0600 file.
  }
  let privateKey
  try {
    const bytes = await privateKeyBytes(path, ownerId)
    try { privateKey = createPrivateKey(bytes) } finally { bytes.fill(0) }
  }
  catch { throw new CatalogFailure('order-author-key-unavailable') }
  try {
    const directoryAfter = await lstat(dir)
    if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
      || directoryAfter.ino !== directoryBefore.ino
      || directoryAfter.dev !== directoryBefore.dev
      || (process.platform !== 'win32' && (directoryAfter.mode & 0o077) !== 0)
      || await realpath(dir) !== dir) {
      throw new CatalogFailure('order-author-key-unavailable')
    }
  } catch { throw new CatalogFailure('order-author-key-unavailable') }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new CatalogFailure('order-author-key-unavailable')
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  // RFC 8410 Ed25519 SPKI is the fixed 12-byte prefix followed by Raw32.
  const prefix = Buffer.from('302a300506032b6570032100', 'hex')
  if (!Buffer.isBuffer(spki) || spki.length !== 44 || !spki.subarray(0, 12).equals(prefix)) {
    throw new CatalogFailure('order-author-key-unavailable')
  }
  const raw = spki.subarray(12)
  const keyId = `author-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`
  return { ownerId, keyId, publicKey: raw.toString('base64url'),
    sign: payload => sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64url') }
}

export interface AuthorManifestInput {
  readonly origin: string
  readonly token: string
  readonly publicationId: string
  readonly ownerId: number
  readonly packageDigest: string
  readonly version: string
  readonly archive: CanonicalOrderArchive
  readonly profileDir: string
  readonly fetch?: typeof fetch
}

/** An owner declaration only; Guangzhou must still verify the locked ZIP and runtime. */
export async function signAndRecordOrderAuthorManifest(input: AuthorManifestInput): Promise<void> {
  if (!ID.test(input.publicationId) || !DIGEST.test(input.packageDigest)
    || !DIGEST.test(input.archive.artifactDigest)
    || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/u.test(input.version)
    || !input.archive.platformDispatchable) {
    throw new CatalogFailure('order-author-unavailable')
  }
  try {
    validateOrderSourceInventory(input.archive.inventoryAlgorithm,
      input.archive.files.map(file => ({ path: file.path, sizeBytes: file.size_bytes, sha256: file.sha256 })))
  } catch { throw new CatalogFailure('order-author-unavailable') }
  const origin = safeOrigin(input.origin)
  const send = input.fetch ?? fetch
  const signer = await accountOrderPublisherIdentity(input.profileDir, input.ownerId)
  const challenge = await post(origin, '/api/v8/task-adapter-publisher-keys/challenge', input.token, null, send)
  if (challenge.schema !== KEY_SCHEMA || challenge.owner_id !== input.ownerId
    || typeof challenge.challenge_id !== 'string' || !ID.test(challenge.challenge_id)
    || typeof challenge.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(challenge.nonce)
    || typeof challenge.expires_at !== 'number' || !Number.isSafeInteger(challenge.expires_at)
    || challenge.expires_at < 1) {
    throw new CatalogFailure('order-author-unavailable')
  }
  const enrollment = { schema: KEY_SCHEMA, owner_id: input.ownerId,
    key_id: signer.keyId, public_key: signer.publicKey,
    challenge_id: challenge.challenge_id, nonce: challenge.nonce }
  const enrolled = await post(origin, '/api/v8/task-adapter-publisher-keys', input.token, {
    key_id: signer.keyId, public_key: signer.publicKey,
    challenge_id: challenge.challenge_id, signature: signer.sign(enrollment),
  }, send)
  if (enrolled.schema !== 'qianshou.order-adapter-publisher-key.v1'
    || enrolled.owner_id !== input.ownerId || enrolled.key_id !== signer.keyId
    || enrolled.public_key !== signer.publicKey || enrolled.status !== 'active') {
    throw new CatalogFailure('order-author-unavailable')
  }
  const payload = { schema: AUTHOR_SCHEMA, publication_id: input.publicationId,
    owner_id: input.ownerId, publisher_key_id: signer.keyId,
    task_type: input.archive.taskType, capability_id: input.archive.capabilityId,
    inventory_algorithm: input.archive.inventoryAlgorithm,
    artifact_digest: input.archive.artifactDigest,
    package_digest: input.packageDigest, version: input.version,
    files: input.archive.files, platform_dispatchable_claim: true }
  const authorManifest = { key_id: signer.keyId, payload, signature: signer.sign(payload) }
  const result = await post(origin,
    `/api/v8/task-adapter-publications/${input.publicationId}/author-manifest`,
    input.token, { author_manifest: authorManifest }, send)
  if (result.publication_id !== input.publicationId || result.owner_id !== input.ownerId
    || result.key_id !== signer.keyId || result.status !== 'recorded') {
    throw new CatalogFailure('order-author-unavailable')
  }
}
