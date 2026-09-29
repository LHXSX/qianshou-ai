import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { uploadPlatformOrderSourceArchive } from '../src/order-package-upload-http.ts'

const id = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
const ownerId = 111111
const objectKey = `v8/account-${ownerId}/publication/${id}/adapter/source.zip`
const bytes = Buffer.from('six reviewed source files packed in a canonical ZIP', 'utf8')
const archiveDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const archive = { bytes, archiveDigest, artifactDigest: `sha256:${'a'.repeat(64)}`,
  sizeBytes: bytes.length, files: [], platformDispatchable: true,
  inventoryAlgorithm: 'qianshou.source-package.v1' as const,
  taskType: 'text_reverse_v1', capabilityId: 'qianshou.text-reverse.v1' }
const packageDigest = `sha256:${'b'.repeat(64)}`
const checksum = Buffer.from(archiveDigest.slice(7), 'hex').toString('base64')
const contentMd5 = createHash('md5').update(bytes).digest('base64')
const input = { origin: 'https://shanghai.example/', token: 'author-jwt', publicationId: id,
  ownerId, packageDigest, archive, trustedArchiveHostname: 'archive.example' }

function uploadResponses(version = 'v-42', versionHeaders: HeadersInit = version ? { 'x-amz-version-id': version } : {},
  uploadUrl = 'https://archive.example/bucket/key?X-Amz-Signature=opaque', bucket?: string): typeof fetch {
  const send = vi.fn(async (url: URL, request: RequestInit) => {
    if (request.method === 'GET') return new Response(JSON.stringify({ publication_id: id, status: 'missing' }))
    if (url.pathname.endsWith('/prepare')) return new Response(JSON.stringify({
      publication_id: id, object_key: objectKey, status: 'prepared', method: 'PUT',
      url: uploadUrl, bucket, expires_in: 900,
      upload_intent: 'opaque.signed-intent', headers: {
        'Content-Type': 'application/zip', 'Content-MD5': contentMd5,
        'x-amz-checksum-sha256': checksum,
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': '2026-09-28T00:00:00Z',
      },
    }))
    if (request.method === 'PUT') return new Response(null, { status: 200, headers: versionHeaders })
    return new Response(JSON.stringify({ publication_id: id, status: 'confirmed',
      object_key: objectKey, archive_digest: archiveDigest, size_bytes: bytes.length,
      version_id: version }))
  })
  return send as unknown as typeof fetch
}

it('uploads directly to the pinned object host and confirms only its returned VersionId', async () => {
  const send = uploadResponses()
  await expect(uploadPlatformOrderSourceArchive({ ...input, fetch: send })).resolves.toBe('confirmed')
  const calls = vi.mocked(send).mock.calls
  expect(calls).toHaveLength(4)
  expect(calls.map(([, request]) => request?.method)).toEqual(['GET', 'POST', 'PUT', 'POST'])
  const [putUrl, put] = calls[2]!
  expect(String(putUrl)).toContain('https://archive.example/')
  expect((put?.headers as Record<string, string>)['x-amz-checksum-sha256']).toBe(checksum)
  expect((put?.headers as Record<string, string>)['Content-MD5']).toBe(contentMd5)
  expect((put?.headers as Record<string, string>).authorization).toBeUndefined()
  expect(Buffer.from(put?.body as Uint8Array)).toEqual(bytes)
  expect(JSON.parse(calls[1]![1]?.body as string).content_md5).toBe(contentMd5)
  expect(JSON.parse(calls[3]![1]?.body as string)).toEqual({
    upload_intent: 'opaque.signed-intent', version_id: 'v-42',
  })
})

it('does not claim archive confirmation when OSS omits VersionId', async () => {
  const send = uploadResponses('')
  await expect(uploadPlatformOrderSourceArchive({ ...input, fetch: send }))
    .rejects.toThrow('order-archive-unconfirmed')
  expect(vi.mocked(send).mock.calls).toHaveLength(3)
})

it('confirms COS native VersionId after a direct upload', async () => {
  const send = uploadResponses('cos-version-1', { 'x-cos-version-id': 'cos-version-1' })
  await expect(uploadPlatformOrderSourceArchive({ ...input, fetch: send })).resolves.toBe('confirmed')
  expect(JSON.parse(vi.mocked(send).mock.calls[3]![1]?.body as string).version_id).toBe('cos-version-1')
})

it('uses only the exact COS virtual host of the platform evidence bucket when no override is configured', async () => {
  const bucket = 'test-evidence-1463872884'
  const host = `${bucket}.cos.ap-shanghai.myqcloud.com`
  const send = uploadResponses('cos-version-2', { 'x-cos-version-id': 'cos-version-2' },
    `https://${host}/v8/source.zip?X-Amz-Signature=opaque`, bucket)
  await expect(uploadPlatformOrderSourceArchive({ ...input, trustedArchiveHostname: '', fetch: send }))
    .resolves.toBe('confirmed')
  const maliciousHost = uploadResponses('cos-version-3', { 'x-cos-version-id': 'cos-version-3' },
    'https://another.cos.ap-shanghai.myqcloud.com/v8/source.zip?X-Amz-Signature=opaque', bucket)
  await expect(uploadPlatformOrderSourceArchive({ ...input, trustedArchiveHostname: '', fetch: maliciousHost }))
    .rejects.toThrow('order-archive-untrusted-host')
  expect(vi.mocked(maliciousHost).mock.calls).toHaveLength(2)
})

it('rejects conflicting S3 and COS VersionId headers before confirm', async () => {
  const send = uploadResponses('s3-version', {
    'x-amz-version-id': 's3-version', 'x-cos-version-id': 'cos-version',
  })
  await expect(uploadPlatformOrderSourceArchive({ ...input, fetch: send }))
    .rejects.toThrow('order-archive-unconfirmed')
  expect(vi.mocked(send).mock.calls).toHaveLength(3)
})

it('rejects an unpinned signed-upload host before transmitting source bytes', async () => {
  const send = uploadResponses()
  await expect(uploadPlatformOrderSourceArchive({ ...input, trustedArchiveHostname: 'other.example', fetch: send }))
    .rejects.toThrow('order-archive-untrusted-host')
  expect(vi.mocked(send).mock.calls).toHaveLength(2)
})

it('does not upload twice after server confirms the same immutable archive', async () => {
  const send = vi.fn(async () => new Response(JSON.stringify({ publication_id: id, status: 'confirmed',
    object_key: objectKey, archive_digest: archiveDigest, size_bytes: bytes.length, version_id: 'v-42' })))
  await expect(uploadPlatformOrderSourceArchive({ ...input, fetch: send as unknown as typeof fetch }))
    .resolves.toBe('confirmed')
  expect(send).toHaveBeenCalledTimes(1)
})
