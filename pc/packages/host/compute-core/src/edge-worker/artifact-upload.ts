/** Lease-bound file result upload. The POST carries metadata only; PUT goes to object storage. */
import { createHash, randomUUID } from 'node:crypto'
import { isArtifactContentType } from '../artifact-content-type.ts'
import { requestJson } from '../supply/http.ts'
import { SupplyError } from '../supply/policy.ts'
import type { EdgeArtifactManifest, EdgeTaskIdentity } from './types.ts'

/** Deliberately smaller than the platform's 2 GiB ceiling until streaming upload is implemented. */
export const MAX_EDGE_ARTIFACT_BYTES = 16 * 1024 * 1024
const RESPONSE_LIMIT = 16_384
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const OBJECT_VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export interface EdgeArtifactUploadInput {
  readonly origin: URL
  readonly token: string
  readonly leaseToken: string
  readonly identity: EdgeTaskIdentity
  readonly filename: string
  readonly contentType: string
  readonly bytes: Uint8Array
  readonly signal?: AbortSignal
  /** Test-only transport and clock ports. */
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly resultId?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A presigned URL can be external HTTPS, or literal loopback HTTP for an isolated test. */
function signedUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new SupplyError('EDGE_ARTIFACT_SIGNED_URL_INVALID') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new SupplyError('EDGE_ARTIFACT_SIGNED_URL_INVALID')
  }
  return url
}

/** Validate signed headers without allowing the account bearer token onto the object-store PUT. */
function signedHeaders(raw: unknown, contentType: string): Headers {
  if (!record(raw) || Object.keys(raw).length > 16) throw new SupplyError('EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID')
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(key) || typeof value !== 'string' || value.length > 2048
      || /[\r\n]/u.test(value) || key.toLowerCase() === 'authorization' || key.toLowerCase() === 'cookie') {
      throw new SupplyError('EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID')
    }
    headers.set(key, value)
  }
  if (headers.has('content-type') && headers.get('content-type') !== contentType) {
    throw new SupplyError('EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID')
  }
  headers.set('content-type', contentType)
  return headers
}

/**
 * Upload one bounded, already-generated file under a live worker lease. The caller owns the
 * lease and account token; neither is returned to a task adapter or included in the manifest.
 * A successful PUT is only a transfer fact, never platform result acceptance or settlement.
 */
export async function uploadEdgeArtifact(input: EdgeArtifactUploadInput): Promise<EdgeArtifactManifest> {
  const { identity, bytes } = input
  if (!SAFE_FILENAME.test(input.filename) || !isArtifactContentType(input.contentType)
    || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_EDGE_ARTIFACT_BYTES
    || typeof input.token !== 'string' || input.token.length === 0
    || typeof input.leaseToken !== 'string' || input.leaseToken.length === 0) {
    throw new SupplyError('EDGE_ARTIFACT_INPUT_INVALID')
  }
  const resultId = input.resultId ?? randomUUID()
  if (!UUID.test(resultId)) throw new SupplyError('EDGE_ARTIFACT_INPUT_INVALID')
  // Capture the exact payload before awaiting the presign call. The caller's
  // Uint8Array may otherwise change between checksum calculation and PUT.
  const uploadBytes = Buffer.from(bytes)
  const digest = createHash('sha256').update(uploadBytes).digest('hex')
  const contentMd5 = createHash('md5').update(uploadBytes).digest('base64')
  if (!SHA256.test(digest)) throw new SupplyError('EDGE_ARTIFACT_INPUT_INVALID')
  const response = await requestJson(new URL('/api/v8/files/result-upload-url', input.origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      shard_id: identity.shardId, worker_id: identity.workerId, lease_token: input.leaseToken,
      result_id: resultId, filename: input.filename, size_bytes: uploadBytes.byteLength,
      sha256: digest, content_md5: contentMd5, content_type: input.contentType,
    }),
  }, { timeoutMs: 15_000, maxResponseBytes: RESPONSE_LIMIT, ...(input.fetch ? { fetch: input.fetch } : {}) }, input.signal)
  if (!record(response) || response.schema_version !== 'artifact.v1' || response.method !== 'PUT'
    || typeof response.object_key !== 'string' || typeof response.upload_url !== 'string'
    || !Number.isSafeInteger(response.expires_at) || (response.expires_at as number) <= (input.now ?? Date.now)() / 1000 + 5) {
    throw new SupplyError('EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID')
  }
  // The account segment is the *customer/workload owner*, not this worker's
  // account. It is assigned by the authenticated lease-bound presign endpoint.
  const parts = response.object_key.split('/')
  const customer = /^account-([1-9][0-9]*)$/u.exec(parts[1] ?? '')
  const accountId = customer === null ? NaN : Number(customer[1])
  if (parts.length !== 7 || parts[0] !== 'v8' || !Number.isSafeInteger(accountId)
    || parts[2] !== `workload-${identity.workloadId}`
    || parts[3] !== `shard-${identity.shardId}` || parts[4] !== 'result'
    || parts[5] !== resultId || parts[6] !== input.filename) {
    throw new SupplyError('EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID')
  }
  const url = signedUrl(response.upload_url)
  // Shanghai is the control plane: even a faulty presign response may not send
  // file bytes to its host (including a different port or protocol).
  if (url.hostname === input.origin.hostname) throw new SupplyError('EDGE_ARTIFACT_SIGNED_URL_INVALID')
  const headers = signedHeaders(response.headers, input.contentType)
  // The platform must sign the exact bytes we send; do not accept a presign for
  // one digest and then report the locally computed digest for different bytes.
  const checksum = Buffer.from(digest, 'hex').toString('base64')
  // Locked review evidence requires COS to verify transfer bytes with Content-MD5.
  // Legacy result storage need not support that header; Guangzhou still recomputes SHA-256.
  if (headers.get('x-amz-checksum-sha256') !== checksum
    || (headers.has('content-md5') && headers.get('content-md5') !== contentMd5)
    || (typeof response.bucket === 'string' && response.bucket !== ''
      && headers.get('content-md5') !== contentMd5)) {
    throw new SupplyError('EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID')
  }
  const deadline = AbortSignal.timeout(120_000)
  const combined = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  let objectVersionId: string
  try {
    combined.throwIfAborted()
    // No account Authorization header is forwarded. No redirect may take bytes to a third URL.
    const put = await (input.fetch ?? fetch)(url, {
      method: 'PUT', body: uploadBytes, headers, signal: combined,
      redirect: 'error', credentials: 'omit',
    })
    if (!put.ok) {
      await put.body?.cancel().catch(() => undefined)
      throw new SupplyError('EDGE_ARTIFACT_UPLOAD_FAILED')
    }
    const versions = ['x-amz-version-id', 'x-cos-version-id', 'x-oss-version-id']
      .map(name => put.headers.get(name)).filter((value): value is string => value !== null)
    const version = versions[0] ?? null
    await put.body?.cancel().catch(() => undefined)
    if (version === null || !OBJECT_VERSION.test(version) || version.toLowerCase() === 'null'
      || versions.some(value => value !== version)) {
      throw new SupplyError('EDGE_ARTIFACT_VERSION_UNCONFIRMED')
    }
    objectVersionId = version
  } catch (error) {
    if (input.signal?.aborted) throw new SupplyError('SUPPLY_ABORTED')
    if (deadline.aborted) throw new SupplyError('SUPPLY_TIMEOUT')
    if (error instanceof SupplyError) throw error
    throw new SupplyError('EDGE_ARTIFACT_UPLOAD_FAILED')
  }
  return Object.freeze({
    schema: 'artifact.v1', object_key: response.object_key, object_version_id: objectVersionId,
    filename: input.filename,
    size_bytes: uploadBytes.byteLength, content_type: input.contentType, sha256: digest,
    result_id: resultId, shard_id: identity.shardId, workload_id: identity.workloadId,
    account_id: accountId,
  })
}
