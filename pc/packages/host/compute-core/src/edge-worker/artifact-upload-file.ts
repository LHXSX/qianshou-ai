/** Host-only preparation for a versioned, lease-bound, streamed video result PUT. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { SupplyError } from '../supply/policy.ts'
import type { EdgeArtifactManifest, EdgeTaskIdentity } from './types.ts'

/** The platform artifact ceiling; this module does not change the live 16 MiB uploader. */
export const MAX_EDGE_VIDEO_FILE_BYTES = 2 * 1024 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ID = /^[A-Za-z0-9_-]{1,128}$/u
const OBJECT_VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u

/** Metadata-only request to a future authenticated lease-bound presign endpoint. */
export interface EdgeVideoFilePresignRequest {
  readonly identity: EdgeTaskIdentity
  readonly leaseToken: string
  readonly resultId: string
  readonly filename: 'result.mp4'
  readonly contentType: 'video/mp4'
  readonly sizeBytes: number
  readonly sha256: string
  readonly contentMd5: string
}

/** Exact object version submitted to Shanghai after the one media PUT. */
export interface EdgeVideoFileCompleteRequest {
  readonly identity: EdgeTaskIdentity
  readonly leaseToken: string
  readonly resultId: string
  readonly bucket: string
  readonly objectKey: string
  readonly objectVersionId: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly contentType: 'video/mp4'
}

/** The Host supplies both ports; no production server route is connected here. */
export interface EdgeVideoFileUploadInput {
  readonly sourcePath: string
  /** Values from the already-verified local executor, checked again against the same open file. */
  readonly expectedBytes: number
  readonly expectedSha256: string
  readonly identity: EdgeTaskIdentity
  readonly leaseToken: string
  readonly controlOrigin: URL
  /** Exact trusted object-store origin, configured outside the task payload. */
  readonly storageOrigin: URL
  /** Must verify that this exact worker, shard, attempt and lease are still active. */
  readonly assertLeaseActive: () => Promise<void>
  readonly issueUpload: (request: EdgeVideoFilePresignRequest) => Promise<unknown>
  /** Reviewed-video only. No artifact may be returned until Shanghai confirms this exact version. */
  readonly completeUpload?: (request: EdgeVideoFileCompleteRequest) => Promise<unknown>
  readonly resultId?: string
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

function fail(code: string): never { throw new SupplyError(code) }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fileIdentity(stat: BigIntStats): string {
  // BigIntStats preserves sub-millisecond change stamps and Windows file IDs where available.
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.birthtimeNs, stat.mtimeNs, stat.ctimeNs].join(':')
}

function assertRegular(stat: BigIntStats, expectedBytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(expectedBytes)) {
    fail('EDGE_VIDEO_FILE_CHANGED')
  }
}

async function hashFile(handle: FileHandle, size: number): Promise<{ sha256: string; md5: string }> {
  const sha256 = createHash('sha256')
  const md5 = createHash('md5')
  for (let position = 0; position < size;) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - position))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) fail('EDGE_VIDEO_FILE_CHANGED')
    const used = chunk.subarray(0, bytesRead)
    sha256.update(used)
    md5.update(used)
    position += bytesRead
  }
  return { sha256: sha256.digest('hex'), md5: md5.digest('base64') }
}

function checkedGrant(
  raw: unknown, input: EdgeVideoFileUploadInput, request: EdgeVideoFilePresignRequest,
): { url: URL; key: string; accountId: number; headers: Headers; bucket: unknown } {
  if (!record(raw) || raw.schemaVersion !== 'artifact-file.v1' || !record(raw.identity)
    || raw.identity.workerId !== input.identity.workerId
    || raw.identity.workloadId !== input.identity.workloadId
    || raw.identity.shardId !== input.identity.shardId
    || raw.identity.attempt !== input.identity.attempt
    || raw.leaseTokenSha256 !== createHash('sha256').update(input.leaseToken).digest('hex')
    || raw.resultId !== request.resultId || raw.sha256 !== request.sha256
    || raw.sizeBytes !== request.sizeBytes || raw.contentType !== 'video/mp4'
    || raw.method !== 'PUT' || !Number.isSafeInteger(raw.expiresAt)
    || (raw.expiresAt as number) <= (input.now ?? Date.now)() / 1000 + 5
    || typeof raw.objectKey !== 'string' || typeof raw.uploadUrl !== 'string') {
    fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
  }
  const key = raw.objectKey
  const parts = key.split('/')
  const account = /^account-([1-9][0-9]*)$/u.exec(parts[1] ?? '')
  const accountId = account === null ? NaN : Number(account[1])
  if (parts.length !== 7 || parts[0] !== 'v8' || !Number.isSafeInteger(accountId)
    || parts[2] !== `workload-${input.identity.workloadId}`
    || parts[3] !== `shard-${input.identity.shardId}` || parts[4] !== 'result'
    || parts[5] !== request.resultId || parts[6] !== 'result.mp4') {
    fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
  }
  let url: URL
  try { url = new URL(raw.uploadUrl) } catch { fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID') }
  if (url.protocol !== 'https:' || url.origin !== input.storageOrigin.origin
    || url.hostname === input.controlOrigin.hostname || url.username || url.password || url.hash
    || url.href.includes(input.leaseToken)) {
    fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
  }
  // Shanghai's immutable COS presign binds MD5, SHA-256 and the object lock, but
  // deliberately does not sign Content-Length for streamed Fetch bodies.
  const requiredSignedHeaders = ['content-type', 'content-md5', 'x-amz-checksum-sha256']
  const signedHeaderNames: unknown = raw.signedHeaderNames
  if (!record(raw.headers) || Object.keys(raw.headers).length > 16
    || !Array.isArray(signedHeaderNames)
    || signedHeaderNames.length !== Object.keys(raw.headers).length
    || !signedHeaderNames.every((name: unknown) => typeof name === 'string' && /^[a-z0-9-]{1,64}$/u.test(name))
    || new Set(signedHeaderNames).size !== signedHeaderNames.length
    || !Object.keys(raw.headers).every(name => signedHeaderNames.includes(name.toLowerCase()))
    || !requiredSignedHeaders.every(name => signedHeaderNames.includes(name))) {
    fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw.headers)) {
    const lower = name.toLowerCase()
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(name) || typeof value !== 'string' || value.length > 2048
      || /[\r\n]/u.test(value) || ['authorization', 'cookie', 'host', 'connection', 'transfer-encoding'].includes(lower)
      || lower.startsWith('proxy-') || lower.startsWith('x-forwarded-')
      || value.includes(input.leaseToken)) {
      fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
    }
    headers.set(name, value)
  }
  if (headers.get('content-type') !== 'video/mp4'
    || (headers.has('content-length') && headers.get('content-length') !== String(request.sizeBytes))
    || headers.get('content-md5') !== request.contentMd5
    || headers.get('x-amz-checksum-sha256') !== Buffer.from(request.sha256, 'hex').toString('base64')) {
    fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
  }
  const retentionUntil = Date.parse(headers.get('x-amz-object-lock-retain-until-date') ?? '')
  if (input.completeUpload !== undefined && (typeof raw.bucket !== 'string'
    || !/^[A-Za-z0-9._-]{1,255}$/u.test(raw.bucket)
    || headers.get('x-amz-meta-sha256') !== request.sha256
    || !signedHeaderNames.includes('x-amz-meta-sha256')
    || headers.get('x-amz-object-lock-mode') !== 'COMPLIANCE'
    || !signedHeaderNames.includes('x-amz-object-lock-mode')
    || !signedHeaderNames.includes('x-amz-object-lock-retain-until-date')
    // HTTP-date has second precision and a presign can spend time in transit.
    || !Number.isFinite(retentionUntil)
    || retentionUntil < (input.now ?? Date.now)() + (72 * 60 - 1) * 60 * 1000)) {
    fail('EDGE_VIDEO_UPLOAD_GRANT_INVALID')
  }
  return { url, key, accountId, headers, bucket: raw.bucket }
}

function checkedCompletion(raw: unknown, request: EdgeVideoFileCompleteRequest, accountId: number): void {
  if (!record(raw) || raw.ok !== true || raw.completed !== true
    || raw.bucket !== request.bucket || raw.object_key !== request.objectKey
    || raw.object_version_id !== request.objectVersionId || raw.sha256 !== request.sha256
    || raw.size_bytes !== request.sizeBytes || raw.content_type !== 'video/mp4'
    || !record(raw.signed_video_upload_completion_receipt)) {
    fail('EDGE_VIDEO_COMPLETE_OUTCOME_UNKNOWN')
  }
  const receipt = raw.signed_video_upload_completion_receipt
  const payload = receipt.payload
  if (typeof receipt.key_id !== 'string' || receipt.key_id.length < 1
    || typeof receipt.signature !== 'string' || receipt.signature.length < 1
    || !record(payload) || !record(payload.object)
    || payload.schema !== 'qianshou.reviewed-video-object-upload.v1'
    || payload.purpose !== 'shanghai.video.upload.v1' || payload.role !== 'output'
    || payload.account_id !== accountId || payload.workload_id !== request.identity.workloadId
    || payload.shard_id !== request.identity.shardId || payload.worker_id !== request.identity.workerId
    || payload.attempt !== request.identity.attempt
    || payload.object.bucket !== request.bucket || payload.object.key !== request.objectKey
    || payload.object.version_id !== request.objectVersionId
    || payload.object.sha256 !== request.sha256 || payload.object.size_bytes !== request.sizeBytes
    || payload.object.mime_type !== 'video/mp4') {
    fail('EDGE_VIDEO_COMPLETE_OUTCOME_UNKNOWN')
  }
}

/**
 * Stream one verified MP4 through exactly one signed PUT. The issuer receives metadata only.
 * After a PUT starts, any missing version, transport error, changed file or lease uncertainty
 * is an unknown outcome: callers must reconcile the object version, never blindly retry.
 */
export async function uploadEdgeVideoFile(input: EdgeVideoFileUploadInput): Promise<EdgeArtifactManifest> {
  // Freeze the caller's values before the first await; a mutable task adapter may not
  // switch the lease, digest or trusted destination while a presign is in flight.
  input = {
    ...input,
    identity: Object.freeze({ ...input.identity }),
    controlOrigin: new URL(input.controlOrigin.href),
    storageOrigin: new URL(input.storageOrigin.href),
  }
  const { identity } = input
  if (!isAbsolute(input.sourcePath) || !SHA256.test(input.expectedSha256)
    || !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1
    || input.expectedBytes > MAX_EDGE_VIDEO_FILE_BYTES
    || !ID.test(identity.workerId) || !ID.test(identity.workloadId) || !ID.test(identity.shardId)
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 0
    || !input.leaseToken || input.controlOrigin.protocol !== 'https:'
    || input.storageOrigin.protocol !== 'https:'
    || input.controlOrigin.hostname === input.storageOrigin.hostname) {
    fail('EDGE_VIDEO_UPLOAD_INPUT_INVALID')
  }
  const resultId = input.resultId ?? randomUUID()
  if (!UUID.test(resultId)) fail('EDGE_VIDEO_UPLOAD_INPUT_INVALID')
  const initialPathStat = await lstat(input.sourcePath, { bigint: true })
  assertRegular(initialPathStat, input.expectedBytes)
  const handle = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const initialHandleStat = await handle.stat({ bigint: true })
    assertRegular(initialHandleStat, input.expectedBytes)
    if (fileIdentity(initialPathStat) !== fileIdentity(initialHandleStat)) fail('EDGE_VIDEO_FILE_CHANGED')
    const firstPass = await hashFile(handle, input.expectedBytes)
    if (firstPass.sha256 !== input.expectedSha256
      || fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(initialHandleStat)
      || fileIdentity(await lstat(input.sourcePath, { bigint: true })) !== fileIdentity(initialPathStat)) {
      fail('EDGE_VIDEO_FILE_CHANGED')
    }
    await input.assertLeaseActive()
    const request: EdgeVideoFilePresignRequest = {
      identity, leaseToken: input.leaseToken, resultId, filename: 'result.mp4',
      contentType: 'video/mp4', sizeBytes: input.expectedBytes,
      sha256: firstPass.sha256, contentMd5: firstPass.md5,
    }
    const grant = checkedGrant(await input.issueUpload(request), input, request)
    await input.assertLeaseActive()
    if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(initialHandleStat)
      || fileIdentity(await lstat(input.sourcePath, { bigint: true })) !== fileIdentity(initialPathStat)) {
      fail('EDGE_VIDEO_FILE_CHANGED')
    }
    input.signal?.throwIfAborted()
    const streamedHash = createHash('sha256')
    let streamedBytes = 0
    const streamState = { complete: false }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, input.expectedBytes - streamedBytes))
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, streamedBytes)
          if (bytesRead === 0) throw new Error('source shortened during PUT')
          const used = chunk.subarray(0, bytesRead)
          streamedHash.update(used)
          streamedBytes += bytesRead
          controller.enqueue(used)
          // Close with the final chunk. Fetch may stop pulling once Content-Length
          // bytes are accepted, so an extra pull is not guaranteed.
          if (streamedBytes === input.expectedBytes) {
            streamState.complete = true
            controller.close()
          }
        } catch (error) { controller.error(error) }
      },
    }, { highWaterMark: 1 })
    let artifact: EdgeArtifactManifest
    try {
      const put = await (input.fetch ?? fetch)(grant.url, {
        method: 'PUT', headers: grant.headers, body, duplex: 'half',
        redirect: 'error', credentials: 'omit', signal: input.signal,
      } as RequestInit & { duplex: 'half' })
      await put.body?.cancel()
      const versions = ['x-amz-version-id', 'x-cos-version-id', 'x-oss-version-id']
        .map(name => put.headers.get(name)).filter((value): value is string => value !== null)
      const version = versions[0] ?? null
      if (!put.ok || !streamState.complete || streamedBytes !== input.expectedBytes
        || streamedHash.digest('hex') !== input.expectedSha256
        || version === null || !OBJECT_VERSION.test(version) || version.toLowerCase() === 'null'
        || versions.some(value => value !== version)) {
        fail('EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN')
      }
      await input.assertLeaseActive()
      if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(initialHandleStat)
        || fileIdentity(await lstat(input.sourcePath, { bigint: true })) !== fileIdentity(initialPathStat)) {
        fail('EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN')
      }
      artifact = Object.freeze({
        schema: 'artifact.v1', object_key: grant.key, object_version_id: version,
        filename: 'result.mp4', size_bytes: input.expectedBytes, content_type: 'video/mp4',
        sha256: input.expectedSha256, result_id: resultId,
        shard_id: identity.shardId, workload_id: identity.workloadId, account_id: grant.accountId,
      })
    } catch {
      // The object store may have committed bytes before the connection broke. No retry here.
      fail('EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN')
    } finally {
      await body.cancel().catch(() => undefined)
    }
    if (input.completeUpload !== undefined) {
      const complete: EdgeVideoFileCompleteRequest = {
        identity, leaseToken: input.leaseToken, resultId, bucket: grant.bucket as string,
        objectKey: grant.key, objectVersionId: artifact.object_version_id,
        sha256: input.expectedSha256, sizeBytes: input.expectedBytes, contentType: 'video/mp4',
      }
      try {
        await input.assertLeaseActive()
        checkedCompletion(await input.completeUpload(complete), complete, grant.accountId)
        await input.assertLeaseActive()
      } catch {
        // The exact complete may be reconciled, but the PUT and GPU attempt must never repeat.
        fail('EDGE_VIDEO_COMPLETE_OUTCOME_UNKNOWN')
      }
    }
    return artifact
  } finally {
    await handle.close()
  }
}
