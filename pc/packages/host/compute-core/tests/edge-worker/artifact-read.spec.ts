import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { readPinnedFileAttachment, readPinnedVideoFirstFrame } from '../../src/edge-worker/artifact-read.ts'

const body = Buffer.from('bounded input')
const pinned = { objectKey: 'v8/account-167/prior/source.txt', objectVersionId: 'locked-v1',
  sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: body.length, contentType: 'text/plain' }
const grant = { ...pinned, url: `https://storage.example/${pinned.objectKey}?versionId=locked-v1`, expiresAt: 2000 }
function options() {
  return { coreOrigin: new URL('https://shanghai.example'), trustedStorageHostname: 'storage.example',
    pinned, maxBytes: 32, contentTypes: ['text/plain'], authorize: vi.fn(async () => grant), now: () => 1000,
    fetch: vi.fn(async () => new Response(body, { headers: { 'content-length': String(body.length), 'x-cos-version-id': 'locked-v1' } })) }
}
it.each([
  { ...grant, objectKey: 'v8/account-6/other' }, { ...grant, sha256: '0'.repeat(64) },
  { ...grant, expiresAt: 0 }, { ...grant, url: `https://shanghai.example/${pinned.objectKey}?versionId=locked-v1` },
  { ...grant, url: `https://storage.example/${pinned.objectKey}?versionId=other` },
  { ...grant, url: `https://storage.example/${pinned.objectKey}?versionId=locked-v1&versionId=other` },
  { ...grant, url: `https://evil.example/${pinned.objectKey}?versionId=locked-v1` },
  { ...grant, url: `https://user:secret@storage.example/${pinned.objectKey}?versionId=locked-v1` },
])('rejects a grant outside the pinned lease metadata before fetching %j', async (altered) => {
  const input = options()
  input.authorize = vi.fn(async () => altered)
  await expect(readPinnedFileAttachment(input)).rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
  expect(input.fetch).not.toHaveBeenCalled()
})
it.each([
  new Response(body, { headers: { 'content-length': String(body.length), 'x-cos-version-id': 'other' } }),
  new Response(body, { headers: { 'content-length': String(body.length), 'x-cos-version-id': 'locked-v1', 'x-amz-version-id': 'other' } }),
  new Response(body, { headers: { 'x-cos-version-id': 'locked-v1' } }),
  new Response(Buffer.alloc(body.length + 1), { headers: { 'content-length': String(body.length), 'x-cos-version-id': 'locked-v1' } }),
  new Response(Buffer.alloc(body.length), { headers: { 'content-length': String(body.length), 'x-cos-version-id': 'locked-v1' } }),
  new Response(null, { status: 302, headers: { location: 'https://shanghai.example/bytes' } }),
])('rejects replacement version, size/hash mismatch and redirect', async (response) => {
  await expect(readPinnedFileAttachment({ ...options(), fetch: vi.fn(async () => response) }))
    .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
})
it('cancels before authorization or read on an aborted lease', async () => {
  const input = options()
  await expect(readPinnedFileAttachment({ ...input, signal: AbortSignal.abort() })).rejects.toThrow()
  expect(input.authorize).not.toHaveBeenCalled()
})

it('reads a larger first frame only through the exact buyer and object version', async () => {
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(20 * 1024)])
  const key = `v8/account-167/developer/${'a'.repeat(32)}/input/first.png`
  const imagePinned = { objectKey: key, objectVersionId: 'image-version-1',
    sha256: createHash('sha256').update(image).digest('hex'), sizeBytes: image.length, contentType: 'image/png' }
  const authorization = vi.fn(async () => ({ ...imagePinned,
    url: `https://storage.example/${key}?versionId=image-version-1`, expiresAt: 2000 }))
  const imageFetch = vi.fn(async () => new Response(image, { headers: {
    'content-length': String(image.length), 'x-cos-version-id': 'image-version-1',
  } }))
  const input = { coreOrigin: new URL('https://shanghai.example'), trustedStorageHostname: 'storage.example',
    buyerAccountId: 167, pinned: imagePinned, maxBytes: 16 * 1024 * 1024,
    authorize: authorization, now: () => 1000, fetch: imageFetch }
  await expect(readPinnedFileAttachment({ ...input, contentTypes: ['image/png'] }))
    .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
  expect(authorization).not.toHaveBeenCalled()
  const result = await readPinnedVideoFirstFrame(input)
  expect(result.sha256).toBe(imagePinned.sha256)
  expect(result.bytes).toEqual(image)
  await expect(readPinnedVideoFirstFrame({ ...input, buyerAccountId: 168 }))
    .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
  expect(imageFetch).toHaveBeenCalledTimes(1)
})

it('refuses changed image version, digest, type and content before local execution', async () => {
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  const key = `v8/account-167/developer/${'a'.repeat(32)}/input/first.png`
  const imagePinned = { objectKey: key, objectVersionId: 'locked-v1',
    sha256: createHash('sha256').update(image).digest('hex'), sizeBytes: image.length, contentType: 'image/png' }
  const base = { coreOrigin: new URL('https://shanghai.example'), trustedStorageHostname: 'storage.example',
    buyerAccountId: 167, pinned: imagePinned, maxBytes: 16 * 1024 * 1024,
    authorize: vi.fn(async () => ({ ...imagePinned,
      url: `https://storage.example/${key}?versionId=locked-v1`, expiresAt: 2000 })), now: () => 1000 }
  const response = (bytes: Buffer, version = 'locked-v1') => new Response(new Uint8Array(bytes), { headers: {
    'content-length': String(bytes.length), 'x-cos-version-id': version,
  } })
  await expect(readPinnedVideoFirstFrame({ ...base, fetch: vi.fn(async () => response(image, 'other')) }))
    .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
  await expect(readPinnedVideoFirstFrame({ ...base, pinned: { ...imagePinned, sha256: '0'.repeat(64) },
    fetch: vi.fn(async () => response(image)) }))
    .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
  await expect(readPinnedVideoFirstFrame({ ...base, pinned: { ...imagePinned, contentType: 'text/plain' },
    fetch: vi.fn(async () => response(image)) }))
    .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
  const invalid = Buffer.alloc(image.length)
  await expect(readPinnedVideoFirstFrame({ ...base, pinned: { ...imagePinned,
    sha256: createHash('sha256').update(invalid).digest('hex') },
  authorize: vi.fn(async () => ({ ...imagePinned,
    sha256: createHash('sha256').update(invalid).digest('hex'),
    url: `https://storage.example/${key}?versionId=locked-v1`, expiresAt: 2000 })),
  fetch: vi.fn(async () => response(invalid)) })).rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
})

it.each(['virtual-host', 'path-style'])(
  'reads the Shanghai reviewed-video evidence bucket through exact %s COS URL', async (style) => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const key = `v8/account-167/reviewed-video/input/${'a'.repeat(32)}/frame.png`
    const videoPinned = { objectKey: key, objectVersionId: 'locked-v1',
      sha256: createHash('sha256').update(image).digest('hex'),
      sizeBytes: image.length, contentType: 'image/png' }
    const path = style === 'virtual-host' ? key : `evidence/${key}`
    const host = style === 'virtual-host' ? 'evidence.storage.example' : 'storage.example'
    const url = `https://${host}/${path}?versionId=locked-v1&signature=opaque`
    const imageFetch = vi.fn(async () => new Response(image, { headers: {
      'content-length': String(image.length), 'x-cos-version-id': 'locked-v1',
    } }))
    const input = { coreOrigin: new URL('https://shanghai.example'),
      trustedStorageHostname: 'storage.example', trustedStorageBucket: 'evidence',
      buyerAccountId: 167, pinned: videoPinned, maxBytes: 16 * 1024 * 1024,
      authorize: async () => ({ ...videoPinned, url, expiresAt: 2000 }),
      now: () => 1000, fetch: imageFetch }
    expect((await readPinnedVideoFirstFrame(input)).bytes).toEqual(image)
    for (const invalidUrl of [
      `https://other.storage.example/${key}?versionId=locked-v1`,
      `https://storage.example/other/${key}?versionId=locked-v1`,
      `https://storage.example/${key}?versionId=locked-v1`,
      `https://evidence.storage.example/evidence/${key}?versionId=locked-v1`,
    ]) {
      await expect(readPinnedVideoFirstFrame({ ...input,
        authorize: async () => ({ ...videoPinned, url: invalidUrl, expiresAt: 2000 }) }))
        .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
    }
    expect(imageFetch).toHaveBeenCalledTimes(1)
  })
