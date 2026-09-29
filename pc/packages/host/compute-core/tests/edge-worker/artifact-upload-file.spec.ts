import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_EDGE_VIDEO_FILE_BYTES, uploadEdgeVideoFile } from '../../src/edge-worker/artifact-upload-file.ts'
import type { EdgeVideoFileCompleteRequest, EdgeVideoFilePresignRequest } from '../../src/edge-worker/artifact-upload-file.ts'

const ID = { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 2 }
const RESULT_ID = '123e4567-e89b-42d3-a456-426614174000'
const KEY = `v8/account-42/workload-${ID.workloadId}/shard-${ID.shardId}/result/${RESULT_ID}/result.mp4`
const dirs: string[] = []

function requestUrl(url: URL | RequestInfo): string {
  return url instanceof URL ? url.href : url instanceof Request ? url.url : url
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function source(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edge-video-put-'))
  dirs.push(dir)
  const path = join(dir, 'result.mp4')
  await writeFile(path, bytes, { mode: 0o600 })
  return path
}

function fixture(path: string, bytes: Buffer) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const requests: EdgeVideoFilePresignRequest[] = []
  const calls: { url: string; init: RequestInit }[] = []
  const lease = vi.fn(async () => undefined)
  const input = {
    sourcePath: path, expectedBytes: bytes.byteLength, expectedSha256: digest,
    identity: ID, leaseToken: 'private-lease',
    controlOrigin: new URL('https://shanghai.example.test'),
    storageOrigin: new URL('https://media.example.test'),
    resultId: RESULT_ID, assertLeaseActive: lease,
    issueUpload: vi.fn(async (request: EdgeVideoFilePresignRequest) => {
      requests.push(request)
      return {
        schemaVersion: 'artifact-file.v1',
        identity: ID, leaseTokenSha256: createHash('sha256').update('private-lease').digest('hex'),
        resultId: RESULT_ID, sha256: request.sha256, sizeBytes: request.sizeBytes,
        contentType: 'video/mp4', method: 'PUT', objectKey: KEY,
        uploadUrl: 'https://media.example.test/upload?signature=opaque',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        headers: {
          'content-type': 'video/mp4', 'content-length': String(request.sizeBytes),
          'content-md5': request.contentMd5,
          'x-amz-checksum-sha256': Buffer.from(request.sha256, 'hex').toString('base64'),
        },
        signedHeaderNames: ['content-type', 'content-length', 'content-md5', 'x-amz-checksum-sha256'],
      }
    }),
    fetch: vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init: init ?? {} })
      const stream = init?.body as ReadableStream<Uint8Array>
      const reader = stream.getReader()
      const hash = createHash('sha256')
      let count = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        count += value.byteLength
        hash.update(value)
      }
      expect(count).toBe(bytes.byteLength)
      expect(hash.digest('hex')).toBe(digest)
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'version-1' } })
    }) as typeof fetch,
  }
  return { input, calls, requests, lease }
}

describe('Host-only streamed video PUT preparation', () => {
  it('waits for an exact Shanghai complete receipt after the sole versioned PUT', async () => {
    const bytes = Buffer.from('00000018ftypmp42reviewed')
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    const original = input.issueUpload
    input.issueUpload = vi.fn(async (request) => {
      const grant = await original(request)
      return { ...grant, bucket: 'reviewed-evidence',
        headers: { ...grant.headers, 'x-amz-meta-sha256': request.sha256,
          'x-amz-object-lock-mode': 'COMPLIANCE',
          'x-amz-object-lock-retain-until-date': new Date(Date.now() + 73 * 60 * 60 * 1000).toISOString() },
        signedHeaderNames: [...grant.signedHeaderNames, 'x-amz-meta-sha256',
          'x-amz-object-lock-mode', 'x-amz-object-lock-retain-until-date'] }
    })
    const completeUpload = vi.fn(async (request: EdgeVideoFileCompleteRequest) => ({ ok: true, completed: true,
      bucket: request.bucket, object_key: request.objectKey,
      object_version_id: request.objectVersionId, sha256: request.sha256,
      size_bytes: request.sizeBytes, content_type: 'video/mp4',
      signed_video_upload_completion_receipt: { key_id: 'upload-key', signature: 'a'.repeat(86),
        payload: { schema: 'qianshou.reviewed-video-object-upload.v1',
          purpose: 'shanghai.video.upload.v1', role: 'output', account_id: 42,
          workload_id: ID.workloadId, shard_id: ID.shardId, worker_id: ID.workerId,
          attempt: ID.attempt, object: { bucket: request.bucket, key: request.objectKey,
            version_id: request.objectVersionId, sha256: request.sha256,
            size_bytes: request.sizeBytes, mime_type: 'video/mp4' } } } }))
    const artifact = await uploadEdgeVideoFile({ ...input, completeUpload })
    expect(calls).toHaveLength(1)
    expect(completeUpload).toHaveBeenCalledOnce()
    expect(completeUpload.mock.calls[0]?.[0]).toMatchObject({ identity: ID,
      leaseToken: 'private-lease', resultId: RESULT_ID, bucket: 'reviewed-evidence',
      objectKey: KEY, objectVersionId: 'version-1', sha256: input.expectedSha256,
      sizeBytes: bytes.byteLength, contentType: 'video/mp4' })
    expect(artifact.object_version_id).toBe('version-1')

    completeUpload.mockImplementationOnce(async request => ({ ...(await completeUpload(request)),
      object_version_id: 'different-version' }))
    await expect(uploadEdgeVideoFile({ ...input, completeUpload }))
      .rejects.toMatchObject({ code: 'EDGE_VIDEO_COMPLETE_OUTCOME_UNKNOWN' })
    expect(calls).toHaveLength(2)
  })

  it('streams a file above the live 16 MiB ceiling in bounded chunks and returns only a versioned reference', async () => {
    const bytes = Buffer.alloc(17 * 1024 * 1024 + 23, 0x61)
    bytes.write('00000018ftypmp42', 0, 'ascii')
    const path = await source(bytes)
    const { input, calls, requests, lease } = fixture(path, bytes)
    const manifest = await uploadEdgeVideoFile(input)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ identity: ID, leaseToken: 'private-lease',
      resultId: RESULT_ID, sizeBytes: bytes.byteLength, sha256: input.expectedSha256 })
    expect(JSON.stringify(requests[0])).not.toContain('ftypmp42')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://media.example.test/upload?signature=opaque')
    expect(calls[0]?.init).toMatchObject({ method: 'PUT', redirect: 'error', credentials: 'omit', duplex: 'half' })
    expect(calls[0]?.init.body).toBeInstanceOf(ReadableStream)
    expect(new Headers(calls[0]?.init.headers).has('authorization')).toBe(false)
    expect(lease).toHaveBeenCalledTimes(3)
    expect(manifest).toMatchObject({ schema: 'artifact.v1', object_key: KEY,
      object_version_id: 'version-1', sha256: input.expectedSha256,
      size_bytes: bytes.byteLength, account_id: 42 })
    expect(JSON.stringify(manifest)).not.toContain('private-lease')
  })

  it.each(['sha256', 'leaseTokenSha256', 'identity', 'uploadUrl', 'headers', 'signedHeaderNames', 'expiresAt'])(
    'rejects a mismatched signed %s before any media PUT', async (field) => {
      const bytes = Buffer.from('00000018ftypmp42good')
      const path = await source(bytes)
      const { input, calls } = fixture(path, bytes)
      const original = input.issueUpload
      input.issueUpload = vi.fn(async (request) => {
        const grant = await original(request)
        const bad: Record<string, unknown> = {
          sha256: '0'.repeat(64), leaseTokenSha256: '0'.repeat(64),
          identity: { ...ID, attempt: 3 }, uploadUrl: 'https://shanghai.example.test/put',
          headers: { ...grant.headers, 'x-amz-checksum-sha256': Buffer.alloc(32).toString('base64') },
          signedHeaderNames: ['content-type', 'content-length'],
          expiresAt: 1,
        }
        return { ...grant, [field]: bad[field] }
      })
      await expect(uploadEdgeVideoFile(input)).rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_GRANT_INVALID' })
      expect(calls).toHaveLength(0)
    },
  )

  it('refuses a replaced source between presign and PUT', async () => {
    const bytes = Buffer.from('00000018ftypmp42good')
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    const original = input.issueUpload
    input.issueUpload = vi.fn(async (request) => {
      const grant = await original(request)
      await writeFile(path, Buffer.from('00000018ftypmp42evil'))
      return grant
    })
    await expect(uploadEdgeVideoFile(input)).rejects.toMatchObject({ code: 'EDGE_VIDEO_FILE_CHANGED' })
    expect(calls).toHaveLength(0)
  })

  it('does not retry after a broken PUT, even if the store read some bytes', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x72)
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    input.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init: init ?? {} })
      await (init?.body as ReadableStream<Uint8Array>).getReader().read()
      throw new Error('connection lost after possible commit')
    })
    await expect(uploadEdgeVideoFile(input)).rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN' })
    expect(calls).toHaveLength(1)
  })

  it('withholds the manifest when the source changes during a successful PUT', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x72)
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    input.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init: init ?? {} })
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader()
      await reader.read()
      await writeFile(path, Buffer.alloc(bytes.byteLength, 0x65))
      while (!(await reader.read()).done) { /* Drain the fake object-store request. */ }
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'version-1' } })
    })
    await expect(uploadEdgeVideoFile(input)).rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN' })
    expect(calls).toHaveLength(1)
  })

  it('treats an early fake-store success as unknown because it did not consume the stream', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x72)
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    input.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init: init ?? {} })
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'version-1' } })
    })
    await expect(uploadEdgeVideoFile(input)).rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN' })
    expect(calls).toHaveLength(1)
  })

  it('completes a one-chunk PUT without requiring another pull after Content-Length', async () => {
    const bytes = Buffer.from('00000018ftypmp42good')
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    input.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: requestUrl(url), init: init ?? {} })
      const first = await (init?.body as ReadableStream<Uint8Array>).getReader().read()
      expect(first.done).toBe(false)
      expect(Buffer.from(first.value ?? [])).toEqual(bytes)
      // A length-framed store may return at this point without another read().
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'version-1' } })
    })
    await expect(uploadEdgeVideoFile(input)).resolves.toMatchObject({ object_version_id: 'version-1' })
    expect(calls).toHaveLength(1)
  })

  it('does not claim a result when a successful PUT omits the object version', async () => {
    const bytes = Buffer.from('00000018ftypmp42good')
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    const original = input.fetch
    input.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      await original(url, init)
      return new Response(null, { status: 200 })
    })
    await expect(uploadEdgeVideoFile(input)).rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN' })
    expect(calls).toHaveLength(1)
  })

  it('rejects stale verified metadata and the 2 GiB platform ceiling without presigning', async () => {
    const bytes = Buffer.from('00000018ftypmp42good')
    const path = await source(bytes)
    const { input, calls } = fixture(path, bytes)
    await expect(uploadEdgeVideoFile({ ...input, expectedSha256: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'EDGE_VIDEO_FILE_CHANGED' })
    await expect(uploadEdgeVideoFile({ ...input, expectedBytes: MAX_EDGE_VIDEO_FILE_BYTES + 1 }))
      .rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_INPUT_INVALID' })
    expect(input.issueUpload).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})
