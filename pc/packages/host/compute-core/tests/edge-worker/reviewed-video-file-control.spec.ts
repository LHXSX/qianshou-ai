import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createShanghaiReviewedVideoFileControl } from '../../src/edge-worker/reviewed-video-file-control.ts'
import type { EdgeVideoFileCompleteRequest, EdgeVideoFilePresignRequest } from '../../src/edge-worker/artifact-upload-file.ts'

const identity = { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 2 }
const resultId = '123e4567-e89b-42d3-a456-426614174000'
const objectKey = `v8/account-42/workload-${identity.workloadId}/shard-${identity.shardId}/result/${resultId}/result.mp4`
const request: EdgeVideoFilePresignRequest = { identity, leaseToken: 'secret-lease', resultId,
  filename: 'result.mp4', contentType: 'video/mp4', sizeBytes: 4096,
  sha256: 'a'.repeat(64), contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==' }

function jsonBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected JSON body')
  return JSON.parse(init.body) as Record<string, unknown>
}

function presign(requested: EdgeVideoFilePresignRequest) {
  return { schema_version: 'artifact.v1', method: 'PUT', object_key: objectKey,
    bucket: 'reviewed-evidence', upload_hostname: 'media.example.test',
    url: 'https://media.example.test/result?signature=opaque',
    upload_url: 'https://media.example.test/result?signature=opaque',
    expires_at: Math.floor(Date.now() / 1000) + 600,
    headers: { 'Content-Type': 'video/mp4', 'Content-MD5': requested.contentMd5,
      'x-amz-checksum-sha256': Buffer.from(requested.sha256, 'hex').toString('base64'),
      'x-amz-meta-sha256': requested.sha256,
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': new Date(Date.now() + 73 * 60 * 60 * 1000).toISOString() },
    issuance_receipt: { key_id: 'issuance-key', signature: 'a'.repeat(86),
      payload: { schema: 'qianshou.artifact-upload-issuance.v1',
        workload_id: identity.workloadId, shard_id: identity.shardId,
        worker_id: identity.workerId, attempt: identity.attempt, result_id: resultId,
        object_key: objectKey, sha256: requested.sha256, size_bytes: requested.sizeBytes,
        content_type: 'video/mp4' } } }
}

describe('Shanghai reviewed-video metadata control', () => {
  it('posts only frozen metadata and the same versioned complete using account auth', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = []
    const fetchPort = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const body = jsonBody(init)
      const address = url instanceof URL ? url : url instanceof Request ? new URL(url.url) : new URL(url)
      seen.push({ url: address.pathname, body, auth: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify(address.pathname.endsWith('result-upload-url')
        ? presign(request) : { ok: true }), { status: 200 })
    }) as typeof fetch
    const control = createShanghaiReviewedVideoFileControl({
      origin: new URL('https://shanghai.example.test/'), tokenProvider: () => 'account-token', fetch: fetchPort })
    const grant = await control.issueUpload(request) as Record<string, unknown>
    expect(grant).toMatchObject({ schemaVersion: 'artifact-file.v1', identity,
      leaseTokenSha256: createHash('sha256').update(request.leaseToken).digest('hex'),
      objectKey, bucket: 'reviewed-evidence' })
    const completion: EdgeVideoFileCompleteRequest = { identity, leaseToken: request.leaseToken,
      resultId, bucket: 'reviewed-evidence', objectKey, objectVersionId: 'version-1',
      sha256: request.sha256, sizeBytes: request.sizeBytes, contentType: 'video/mp4' }
    await control.completeUpload(completion)
    expect(seen).toEqual([
      { url: '/api/v8/files/result-upload-url', auth: 'Bearer account-token',
        body: { shard_id: identity.shardId, worker_id: identity.workerId,
          lease_token: request.leaseToken, result_id: resultId, filename: 'result.mp4',
          size_bytes: request.sizeBytes, sha256: request.sha256,
          content_md5: request.contentMd5, content_type: 'video/mp4' } },
      { url: '/api/v8/files/reviewed-video/result-complete', auth: 'Bearer account-token',
        body: { shard_id: identity.shardId, worker_id: identity.workerId,
          lease_token: request.leaseToken, result_id: resultId,
          object_key: objectKey, object_version_id: 'version-1' } },
    ])
    expect(JSON.stringify(grant)).not.toContain('secret-lease')
  })

  it('refuses a presign without matching Shanghai issuance before returning a grant', async () => {
    const response = presign(request)
    response.issuance_receipt.payload.object_key = 'different-key'
    const control = createShanghaiReviewedVideoFileControl({
      origin: new URL('https://shanghai.example.test/'), tokenProvider: () => 'account-token',
      fetch: vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })) })
    await expect(control.issueUpload(request)).rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_GRANT_INVALID' })
  })
})
