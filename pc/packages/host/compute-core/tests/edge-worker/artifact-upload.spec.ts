import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { uploadEdgeArtifact } from '../../src/edge-worker/artifact-upload.ts'

const ID = {
  workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0,
}
const RESULT_ID = '123e4567-e89b-42d3-a456-426614174000'
// The customer/workload account can differ from the worker's authenticated account.
const KEY = `v8/account-42/workload-${ID.workloadId}/shard-${ID.shardId}/result/${RESULT_ID}/result.mp4`

function fixture(change: Record<string, unknown> = {}, putHeaders: HeadersInit = { 'x-amz-version-id': 'oss-version-1' }) {
  const sent: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} })
    if (sent.length === 1) {
      const posted = JSON.parse(String(init?.body)) as { sha256: string; content_md5: string; filename: string; content_type: string }
      return Response.json({
      schema_version: 'artifact.v1', method: 'PUT', object_key: KEY.replace('result.mp4', posted.filename),
      upload_url: 'https://oss.example.test/put?signature=opaque',
      headers: { 'content-type': posted.content_type,
        'Content-MD5': posted.content_md5,
        'x-amz-checksum-sha256': Buffer.from(posted.sha256, 'hex').toString('base64') },
      expires_at: Math.floor(Date.now() / 1000) + 600,
      ...change,
    })
    }
    return new Response(null, { status: 200, headers: putHeaders })
  }) as typeof fetch
  return { sent, fetcher }
}

describe('lease-bound result upload', () => {
  it.each([
    ['result.png', 'image/png'], ['report.pdf', 'application/pdf'],
    ['audio.flac', 'audio/flac'], ['output.bin', 'application/octet-stream'],
  ])('uploads generic %s only to storage with exact MIME, checksums and version', async (filename, contentType) => {
    const { sent, fetcher } = fixture()
    const bytes = Buffer.from('bounded-test-file')
    const manifest = await uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename, contentType, bytes, resultId: RESULT_ID, fetch: fetcher,
    })
    expect(sent).toHaveLength(2)
    expect(JSON.parse(String(sent[0]?.init.body))).toMatchObject({ filename, content_type: contentType })
    expect(String(sent[0]?.init.body)).not.toContain('bounded-test-file')
    expect(sent[1]?.url).toBe('https://oss.example.test/put?signature=opaque')
    expect(new Headers(sent[1]?.init.headers).get('content-type')).toBe(contentType)
    expect(new Headers(sent[1]?.init.headers).has('authorization')).toBe(false)
    expect(manifest).toMatchObject({ filename, content_type: contentType,
      sha256: createHash('sha256').update(bytes).digest('hex'), object_version_id: 'oss-version-1' })
  })

  it.each(['image/*', 'Image/png', 'text/plain; charset=utf-8', 'text/plain\r\nx-evil: value',
    'application/', '/pdf', `application/${'a'.repeat(128)}`])('rejects noncanonical MIME %j before presign', async contentType => {
    const { sent, fetcher } = fixture()
    await expect(uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.bin', contentType, bytes: Buffer.from('file'),
      resultId: RESULT_ID, fetch: fetcher,
    })).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_INPUT_INVALID' })
    expect(sent).toHaveLength(0)
  })

  it.each(['https://edge.example.test/upload', 'https://edge.example.test:9443/upload'])(
    'refuses a signed PUT to the control plane %s before sending bytes', async uploadUrl => {
      const { sent, fetcher } = fixture({ upload_url: uploadUrl })
      await expect(uploadEdgeArtifact({
        origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
        identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
        bytes: Buffer.from('file'), resultId: RESULT_ID, fetch: fetcher,
      })).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_SIGNED_URL_INVALID' })
      expect(sent).toHaveLength(1)
    },
  )

  it('sends metadata to the platform, bytes only to signed storage, and returns a small reference', async () => {
    const { sent, fetcher } = fixture()
    const bytes = Buffer.from('0000ftyp-mp4-bytes')
    const manifest = await uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
      bytes, resultId: RESULT_ID, fetch: fetcher,
    })
    expect(sent).toHaveLength(2)
    expect(sent[0]?.url).toBe('https://edge.example.test/api/v8/files/result-upload-url')
    expect(sent[0]?.init.headers).toMatchObject({ authorization: 'Bearer account-token' })
    const posted = JSON.parse(String(sent[0]?.init.body))
    expect(posted).toMatchObject({ worker_id: ID.workerId, shard_id: ID.shardId, result_id: RESULT_ID,
      lease_token: 'private-lease', size_bytes: bytes.length, content_type: 'video/mp4' })
    expect(posted.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(posted.content_md5).toBe(createHash('md5').update(bytes).digest('base64'))
    expect(String(sent[0]?.init.body)).not.toContain('ftyp-mp4-bytes')
    expect(sent[1]?.url).toBe('https://oss.example.test/put?signature=opaque')
    expect(sent[1]?.init.method).toBe('PUT')
    expect(Buffer.from(sent[1]?.init.body as Buffer)).toEqual(bytes)
    expect(new Headers(sent[1]?.init.headers).has('authorization')).toBe(false)
    expect(new Headers(sent[1]?.init.headers).get('x-amz-checksum-sha256'))
      .toBe(Buffer.from(posted.sha256, 'hex').toString('base64'))
    expect(new Headers(sent[1]?.init.headers).get('content-md5')).toBe(posted.content_md5)
    expect(sent[1]?.init.redirect).toBe('error')
    expect(manifest).toMatchObject({ schema: 'artifact.v1', object_key: KEY,
      object_version_id: 'oss-version-1', sha256: posted.sha256,
      filename: 'result.mp4', size_bytes: bytes.length, account_id: 42 })
    expect(JSON.stringify(manifest)).not.toContain('private-lease')
    expect(JSON.stringify(manifest)).not.toContain('account-token')
  })

  it('refuses a mismatched object key and never uploads bytes', async () => {
    const { sent, fetcher } = fixture({ object_key: 'v8/account-8/other' })
    await expect(uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
      bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
    })).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID' })
    expect(sent).toHaveLength(1)
  })

  it('refuses expiry and a signed URL that could leak bytes to local network', async () => {
    for (const change of [
      { expires_at: Math.floor(Date.now() / 1000) - 1 },
      { upload_url: 'http://192.168.1.9/upload' },
      { headers: { Authorization: 'Bearer account-token' } },
    ]) {
      const { sent, fetcher } = fixture(change)
      await expect(uploadEdgeArtifact({
        origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
        identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
        bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
      })).rejects.toMatchObject({ code: expect.stringMatching(/^EDGE_ARTIFACT_/) })
      expect(sent).toHaveLength(1)
    }
  })

  it('rejects a presigned checksum for different bytes before any PUT', async () => {
    const { sent, fetcher } = fixture({ headers: {
      'content-type': 'video/mp4', 'content-md5': createHash('md5').update('video').digest('base64'),
      'x-amz-checksum-sha256': Buffer.alloc(32).toString('base64'),
    } })
    await expect(uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
      bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
    })).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID' })
    expect(sent).toHaveLength(1)
  })

  it('rejects a presigned MD5 for different bytes before any PUT', async () => {
    const { sent, fetcher } = fixture({ headers: {
      'content-type': 'video/mp4', 'content-md5': Buffer.alloc(16).toString('base64'),
      'x-amz-checksum-sha256': createHash('sha256').update('video').digest('base64'),
    } })
    await expect(uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
      bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
    })).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID' })
    expect(sent).toHaveLength(1)
  })

  it('requires signed Content-MD5 for a dedicated review-evidence bucket', async () => {
    const { sent, fetcher } = fixture({ bucket: 'locked-evidence', headers: {
      'content-type': 'video/mp4',
      'x-amz-checksum-sha256': createHash('sha256').update('video').digest('base64'),
    } })
    await expect(uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
      bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
    })).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_UPLOAD_RESPONSE_INVALID' })
    expect(sent).toHaveLength(1)
  })

  it.each([{}, { 'x-amz-version-id': 'null' }, { 'x-amz-version-id': 'bad/version' }])(
    'does not return a manifest when the successful PUT lacks a real VersionId (%j)',
    async putHeaders => {
      const { sent, fetcher } = fixture({}, putHeaders)
      await expect(uploadEdgeArtifact({
        origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
        identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
        bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
      })).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_VERSION_UNCONFIRMED' })
      expect(sent).toHaveLength(2)
    },
  )

  it('accepts an OSS x-oss-version-id alias when the S3 header is absent', async () => {
    const { fetcher } = fixture({}, { 'x-oss-version-id': 'oss-version-2' })
    const manifest = await uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
      bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
    })
    expect(manifest.object_version_id).toBe('oss-version-2')
  })

  it('accepts COS native VersionId and rejects conflicting storage headers', async () => {
    const upload = async (putHeaders: HeadersInit) => {
      const { sent, fetcher } = fixture({}, putHeaders)
      const result = uploadEdgeArtifact({
        origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
        identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
        bytes: Buffer.from('video'), resultId: RESULT_ID, fetch: fetcher,
      })
      return { sent, result }
    }
    const native = await upload({ 'x-cos-version-id': 'cos-version-1' })
    await expect(native.result).resolves.toMatchObject({ object_version_id: 'cos-version-1' })
    expect(native.sent).toHaveLength(2)
    const conflicting = await upload({ 'x-cos-version-id': 'cos-version-1', 'x-amz-version-id': 'other-version' })
    await expect(conflicting.result).rejects.toMatchObject({ code: 'EDGE_ARTIFACT_VERSION_UNCONFIRMED' })
    expect(conflicting.sent).toHaveLength(2)
  })

  it('uploads the same frozen bytes that were hashed even if the caller mutates its buffer during presign', async () => {
    const { sent, fetcher: baseFetch } = fixture()
    const bytes = Buffer.from('original-media-bytes')
    const expected = Buffer.from(bytes)
    const fetcher: typeof fetch = async (url, init) => {
      const response = await baseFetch(url, init)
      if (sent.length === 1) bytes.fill(0)
      return response
    }
    const manifest = await uploadEdgeArtifact({
      origin: new URL('https://edge.example.test'), token: 'account-token', leaseToken: 'private-lease',
      identity: ID, filename: 'result.mp4', contentType: 'video/mp4',
      bytes, resultId: RESULT_ID, fetch: fetcher,
    })
    expect(Buffer.from(sent[1]?.init.body as Buffer)).toEqual(expected)
    expect(manifest.sha256).toBe(createHash('sha256').update(expected).digest('hex'))
  })
})
