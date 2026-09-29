/** Shanghai control-plane calls for an already authenticated reviewed-video Edge lease. */
import { createHash } from 'node:crypto'
import { requestJson } from '../supply/http.ts'
import { SupplyError } from '../supply/policy.ts'
import type { EdgeVideoFileCompleteRequest, EdgeVideoFilePresignRequest } from './artifact-upload-file.ts'

const RESPONSE_LIMIT = 16_384
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u

export interface ShanghaiReviewedVideoFileControlOptions {
  readonly origin: URL
  /** Must read the active authenticated account, not an order parameter. */
  readonly tokenProvider: () => string | undefined
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function authenticated(options: ShanghaiReviewedVideoFileControlOptions): string {
  if (options.origin.protocol !== 'https:' || options.origin.username || options.origin.password
    || options.origin.search || options.origin.hash || options.origin.pathname !== '/') {
    throw new SupplyError('EDGE_VIDEO_CONTROL_INVALID')
  }
  const token = options.tokenProvider()
  if (typeof token !== 'string' || token.length < 1) throw new SupplyError('EDGE_AUTH_REQUIRED')
  return token
}

function issuanceMatches(value: unknown, request: EdgeVideoFilePresignRequest, objectKey: string): boolean {
  if (!record(value) || !record(value.payload) || typeof value.key_id !== 'string'
    || typeof value.signature !== 'string' || !SIGNATURE.test(value.signature)) return false
  const payload = value.payload
  return payload.schema === 'qianshou.artifact-upload-issuance.v1'
    && payload.workload_id === request.identity.workloadId
    && payload.shard_id === request.identity.shardId
    && payload.worker_id === request.identity.workerId
    && payload.attempt === request.identity.attempt
    && payload.result_id === request.resultId && payload.object_key === objectKey
    && payload.sha256 === request.sha256 && payload.size_bytes === request.sizeBytes
    && payload.content_type === 'video/mp4'
}

/**
 * These calls carry metadata only. The lease-bound PUT still goes directly to
 * the pinned object-storage origin and is never repeated after an uncertain result.
 */
export function createShanghaiReviewedVideoFileControl(options: ShanghaiReviewedVideoFileControlOptions): {
  issueUpload: (request: EdgeVideoFilePresignRequest) => Promise<unknown>
  completeUpload: (request: EdgeVideoFileCompleteRequest) => Promise<unknown>
} {
  const transport = { timeoutMs: 15_000, maxResponseBytes: RESPONSE_LIMIT,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }
  return {
    async issueUpload(request) {
      const token = authenticated(options)
      const raw = await requestJson(new URL('/api/v8/files/result-upload-url', options.origin), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ shard_id: request.identity.shardId, worker_id: request.identity.workerId,
          lease_token: request.leaseToken, result_id: request.resultId, filename: 'result.mp4',
          size_bytes: request.sizeBytes, sha256: request.sha256, content_md5: request.contentMd5,
          content_type: 'video/mp4' }),
      }, transport, options.signal)
      if (!record(raw) || raw.schema_version !== 'artifact.v1' || raw.method !== 'PUT'
        || typeof raw.object_key !== 'string' || typeof raw.upload_url !== 'string'
        || raw.url !== raw.upload_url || typeof raw.bucket !== 'string' || !raw.bucket
        || typeof raw.upload_hostname !== 'string' || !raw.upload_hostname
        || !Number.isSafeInteger(raw.expires_at) || !record(raw.headers)
        || !issuanceMatches(raw.issuance_receipt, request, raw.object_key)) {
        throw new SupplyError('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
      }
      let uploadUrl: URL
      try { uploadUrl = new URL(raw.upload_url) }
      catch { throw new SupplyError('EDGE_VIDEO_UPLOAD_GRANT_INVALID') }
      if (uploadUrl.hostname !== raw.upload_hostname) throw new SupplyError('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
      return Object.freeze({ schemaVersion: 'artifact-file.v1', identity: { ...request.identity },
        leaseTokenSha256: createHash('sha256').update(request.leaseToken).digest('hex'),
        resultId: request.resultId, sha256: request.sha256, sizeBytes: request.sizeBytes,
        contentType: 'video/mp4', method: 'PUT', objectKey: raw.object_key,
        uploadUrl: raw.upload_url, bucket: raw.bucket, expiresAt: raw.expires_at,
        headers: raw.headers, signedHeaderNames: Object.keys(raw.headers).map(name => name.toLowerCase()) })
    },
    async completeUpload(request) {
      const token = authenticated(options)
      return requestJson(new URL('/api/v8/files/reviewed-video/result-complete', options.origin), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ shard_id: request.identity.shardId, worker_id: request.identity.workerId,
          lease_token: request.leaseToken, result_id: request.resultId,
          object_key: request.objectKey, object_version_id: request.objectVersionId }),
      }, transport, options.signal)
    },
  }
}
