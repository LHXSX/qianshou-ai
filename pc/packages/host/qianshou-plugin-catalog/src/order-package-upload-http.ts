/** Account-scoped upload intent followed by a direct immutable OSS PUT. */
import { createHash } from 'node:crypto'
import { CatalogFailure } from './registry.ts'
import { trustedOrderArchiveHostname } from './order-cos-host.ts'
import type { CanonicalOrderArchive } from './order-source-archive.ts'

const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u
const MAX_RESPONSE_BYTES = 32 * 1024

function trustedUploadUrl(value: unknown, hostname: string): URL {
  if (typeof value !== 'string' || value.length > 8192 || hostname === ''
    || hostname !== hostname.toLowerCase() || !/^[a-z0-9.-]+$/u.test(hostname)) {
    throw new CatalogFailure('order-archive-untrusted-host')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new CatalogFailure('order-archive-untrusted-host') }
  if (url.protocol !== 'https:' || url.hostname !== hostname || url.username || url.password
    || url.hash || !url.search || url.port) throw new CatalogFailure('order-archive-untrusted-host')
  return url
}

function platformUrl(origin: string, id: string, suffix = ''): URL {
  if (!ID.test(id)) throw new CatalogFailure('order-archive-unavailable')
  let url: URL
  try { url = new URL(origin) } catch { throw new CatalogFailure('order-archive-unavailable') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new CatalogFailure('order-archive-unavailable')
  }
  return new URL(`/api/v8/task-adapter-publications/${id}/package-upload${suffix}`, url)
}

async function json(response: Response): Promise<Record<string, unknown>> {
  if (response.body === null) throw new CatalogFailure('order-archive-unavailable')
  const reader = response.body.getReader()
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new CatalogFailure('order-archive-unavailable')
      chunks.push(next.value)
    }
  } finally {
    try { await reader.cancel() } catch { /* Already closed. */ }
    reader.releaseLock()
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* Reject malformed platform response. */ }
  throw new CatalogFailure('order-archive-unavailable')
}

async function platformRequest(url: URL, token: string, method: 'GET' | 'POST',
  body: Record<string, unknown> | null, send: typeof fetch): Promise<Record<string, unknown>> {
  if (!token || /[\r\n]/u.test(token)) throw new CatalogFailure('order-auth-required')
  let response: Response
  try {
    response = await send(url, { method, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(15_000), headers: {
        accept: 'application/json', authorization: `Bearer ${token}`,
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      }, ...(body === null ? {} : { body: JSON.stringify(body) }) })
  } catch { throw new CatalogFailure('order-archive-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Ignore untrusted response text. */ }
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    if (response.status === 409) throw new CatalogFailure('order-publication-conflict')
    throw new CatalogFailure('order-archive-unavailable')
  }
  return json(response)
}

export interface OrderArchiveUploadInput {
  readonly origin: string
  readonly token: string
  readonly publicationId: string
  readonly ownerId: number
  readonly packageDigest: string
  readonly archive: CanonicalOrderArchive
  readonly trustedArchiveHostname: string
  readonly fetch?: typeof fetch
}

/** Confirm storage only; Guangzhou's independent package receipt is still required. */
export async function uploadPlatformOrderSourceArchive(input: OrderArchiveUploadInput): Promise<'confirmed'> {
  const { archive, publicationId, ownerId } = input
  if (!ID.test(publicationId) || !Number.isSafeInteger(ownerId) || ownerId < 1
    || !/^sha256:[0-9a-f]{64}$/u.test(input.packageDigest)
    || archive.sizeBytes !== archive.bytes.length || archive.sizeBytes < 1
    || archive.sizeBytes > 16 * 1024 * 1024
    || archive.archiveDigest !== `sha256:${createHash('sha256').update(archive.bytes).digest('hex')}`) {
    throw new CatalogFailure('order-archive-unavailable')
  }
  const send = input.fetch ?? fetch
  const base = platformUrl(input.origin, publicationId)
  const status = await platformRequest(base, input.token, 'GET', null, send)
  if (status.publication_id !== publicationId || !['missing', 'prepared', 'confirmed'].includes(String(status.status))) {
    throw new CatalogFailure('order-archive-unavailable')
  }
  if (status.status === 'confirmed') {
    const objectKey = `v8/account-${ownerId}/publication/${publicationId}/adapter/source.zip`
    if (status.archive_digest !== archive.archiveDigest || status.size_bytes !== archive.sizeBytes
      || status.object_key !== objectKey
      || typeof status.version_id !== 'string' || !VERSION.test(status.version_id)) {
      throw new CatalogFailure('order-publication-conflict')
    }
    return 'confirmed'
  }
  const prepared = await platformRequest(platformUrl(input.origin, publicationId, '/prepare'), input.token,
    'POST', { artifact_digest: archive.artifactDigest, package_digest: input.packageDigest,
      archive_digest: archive.archiveDigest, size_bytes: archive.sizeBytes,
      content_md5: createHash('md5').update(archive.bytes).digest('base64') }, send)
  const objectKey = `v8/account-${ownerId}/publication/${publicationId}/adapter/source.zip`
  if (prepared.publication_id !== publicationId || prepared.object_key !== objectKey
    || prepared.method !== 'PUT' || prepared.status !== 'prepared'
    || typeof prepared.upload_intent !== 'string' || prepared.upload_intent.length > 2048
    || prepared.upload_intent.length < 10 || !Number.isInteger(prepared.expires_in)
    || (prepared.expires_in as number) < 1 || (prepared.expires_in as number) > 900
    || prepared.headers === null || typeof prepared.headers !== 'object' || Array.isArray(prepared.headers)) {
    throw new CatalogFailure('order-archive-unavailable')
  }
  const headers = prepared.headers as Record<string, unknown>
  const expectedChecksum = Buffer.from(archive.archiveDigest.slice(7), 'hex').toString('base64')
  const expectedMd5 = createHash('md5').update(archive.bytes).digest('base64')
  if (Object.keys(headers).sort().join(',') !== [
    'Content-MD5', 'Content-Type', 'x-amz-checksum-sha256', 'x-amz-object-lock-mode',
    'x-amz-object-lock-retain-until-date',
  ].sort().join(',') || headers['Content-MD5'] !== expectedMd5
    || headers['Content-Type'] !== 'application/zip'
    || headers['x-amz-checksum-sha256'] !== expectedChecksum
    || headers['x-amz-object-lock-mode'] !== 'COMPLIANCE'
    || typeof headers['x-amz-object-lock-retain-until-date'] !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(headers['x-amz-object-lock-retain-until-date'])) {
    throw new CatalogFailure('order-archive-unavailable')
  }
  const url = trustedUploadUrl(prepared.url,
    trustedOrderArchiveHostname(input.trustedArchiveHostname, prepared.bucket))
  let uploaded: Response
  try {
    uploaded = await send(url, { method: 'PUT', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(60_000), headers: headers as Record<string, string>,
      body: new Uint8Array(archive.bytes) })
  } catch { throw new CatalogFailure('order-archive-upload-failed') }
  if (!uploaded.ok) {
    try { await uploaded.body?.cancel() } catch { /* Ignore OSS response text. */ }
    throw new CatalogFailure('order-archive-upload-failed')
  }
  const versions = ['x-amz-version-id', 'x-cos-version-id']
    .map(name => uploaded.headers.get(name)).filter((value): value is string => value !== null)
  const version = versions[0] ?? null
  try { await uploaded.body?.cancel() } catch { /* Nothing required from PUT body. */ }
  if (version === null || !VERSION.test(version) || version.toLowerCase() === 'null'
    || versions.some(value => value !== version)) {
    throw new CatalogFailure('order-archive-unconfirmed')
  }
  const confirmed = await platformRequest(platformUrl(input.origin, publicationId, '/confirm'), input.token,
    'POST', { upload_intent: prepared.upload_intent, version_id: version }, send)
  if (confirmed.publication_id !== publicationId || confirmed.status !== 'confirmed'
    || confirmed.archive_digest !== archive.archiveDigest
    || confirmed.size_bytes !== archive.sizeBytes || confirmed.object_key !== objectKey
    || confirmed.version_id !== version) throw new CatalogFailure('order-archive-unconfirmed')
  return 'confirmed'
}
