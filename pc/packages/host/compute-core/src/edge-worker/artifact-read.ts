/** Exact-version, bounded attachment read on the compute Host. No URL or credentials enter QuickJS. */
import { createHash } from 'node:crypto'
import { isArtifactContentType } from '../artifact-content-type.ts'
import { SupplyError } from '../supply/policy.ts'

export interface PinnedAttachment {
  readonly objectKey: string
  readonly objectVersionId: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly contentType: string
}
export interface AttachmentReadGrant extends PinnedAttachment {
  readonly url: string
  readonly expiresAt: number
}

interface PinnedReadInput {
  readonly coreOrigin: URL
  readonly trustedStorageHostname: string
  /** When set, accept only this bucket's virtual-host or path-style COS URL. */
  readonly trustedStorageBucket?: string
  readonly pinned: PinnedAttachment
  readonly maxBytes: number
  readonly contentTypes: readonly string[]
  readonly authorize: () => Promise<AttachmentReadGrant>
  readonly signal?: AbortSignal
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

async function readPinnedAttachment(input: PinnedReadInput, maximumAllowedBytes: number):
Promise<{ readonly contentType: string; readonly sha256: string; readonly bytes: Uint8Array }> {
  const fail = (): never => { throw new SupplyError('EDGE_ATTACHMENT_READ_DENIED') }
  const pinned = Object.freeze({ ...input.pinned })
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > maximumAllowedBytes
    || !Number.isSafeInteger(pinned.sizeBytes) || pinned.sizeBytes < 1 || pinned.sizeBytes > input.maxBytes
    || !/^[0-9a-f]{64}$/u.test(pinned.sha256) || !isArtifactContentType(pinned.contentType)
    || !input.contentTypes.includes(pinned.contentType)
    || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(pinned.objectVersionId) || pinned.objectVersionId.toLowerCase() === 'null'
    || !pinned.objectKey.startsWith('v8/account-') || pinned.objectKey.length > 1024
    || /[\x00-\x1f\x7f]/u.test(pinned.objectKey) || pinned.objectKey.includes('..')) fail()
  input.signal?.throwIfAborted()
  const grant = await input.authorize()
  if (Object.keys(pinned).some(key => grant[key as keyof PinnedAttachment] !== pinned[key as keyof PinnedAttachment])
    || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= (input.now ?? Date.now)() / 1000 + 5) fail()
  let url: URL
  try { url = new URL(grant.url) } catch { return fail() }
  let objectPath: string
  try { objectPath = decodeURIComponent(url.pathname) } catch { return fail() }
  const expectedPath = '/' + pinned.objectKey
  const exactStorageLocation = input.trustedStorageBucket === undefined
    ? url.hostname === input.trustedStorageHostname && objectPath === expectedPath
    : url.hostname === `${input.trustedStorageBucket}.${input.trustedStorageHostname}`
      && objectPath === expectedPath
      || url.hostname === input.trustedStorageHostname
        && objectPath === `/${input.trustedStorageBucket}${expectedPath}`
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || !exactStorageLocation
    || url.hostname === input.coreOrigin.hostname || url.username || url.password || url.hash
    || url.searchParams.getAll('versionId').length !== 1
    || url.searchParams.get('versionId') !== pinned.objectVersionId) fail()
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  const response = await (input.fetch ?? fetch)(url, { method: 'GET', redirect: 'error',
    credentials: 'omit', signal })
  if (!response.ok || response.body === null) { await response.body?.cancel(); return fail() }
  const sizeHeader = response.headers.get('content-length')
  const versions = ['x-cos-version-id', 'x-amz-version-id'].map(name => response.headers.get(name))
    .filter((value): value is string => value !== null)
  if (versions.length === 0 || versions.some(version => version !== pinned.objectVersionId) || sizeHeader === null
    || !/^[0-9]+$/u.test(sizeHeader) || Number(sizeHeader) !== pinned.sizeBytes) {
    await response.body.cancel(); return fail()
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      signal.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > pinned.sizeBytes || total > input.maxBytes) fail()
      chunks.push(item.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  if (total !== pinned.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== pinned.sha256) fail()
  return { contentType: pinned.contentType, sha256: pinned.sha256, bytes }
}

/** `authorize` is the Host's authenticated, lease-bound metadata port. It is not author code.
 * @param input - Small file metadata, current lease grant and exact storage origin.
 * @returns At most 16 KiB of verified bytes for the existing file runtime.
 */
export async function readPinnedFileAttachment(input: PinnedReadInput):
Promise<{ readonly contentType: string; readonly sha256: string; readonly bytes: Uint8Array }> {
  return readPinnedAttachment(input, 16 * 1024)
}

/** Read one buyer-uploaded first frame through a current lease-bound authorization port.
 * This does not authorize a task, install a workflow or accept a video result.
 * @param input - Pinned buyer image and exact-version storage grant.
 * @returns Verified PNG/JPEG bytes for a reviewed video runner.
 */
export async function readPinnedVideoFirstFrame(input: Omit<PinnedReadInput, 'contentTypes'> & {
  readonly buyerAccountId: number
}): Promise<{ readonly contentType: 'image/png' | 'image/jpeg'
  readonly sha256: string
  readonly bytes: Uint8Array }> {
  const fail = (): never => { throw new SupplyError('EDGE_ATTACHMENT_READ_DENIED') }
  const { pinned, buyerAccountId } = input
  const objectKey = pinned.objectKey
  const contentType = pinned.contentType
  const developerKey = /^v8\/account-[1-9]\d{0,15}\/developer\/[a-f0-9]{32}\/input\/[^/\\\u0000-\u001f]{1,128}$/u.test(objectKey)
  const reviewedKey = /^v8\/account-[1-9]\d{0,15}\/reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg)$/u.test(objectKey)
  if (!Number.isSafeInteger(buyerAccountId) || buyerAccountId < 1
    || !objectKey.startsWith(`v8/account-${buyerAccountId}/`)
    || !developerKey && !reviewedKey) fail()
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') fail()
  const result = await readPinnedAttachment({ ...input, contentTypes: [contentType] }, 16 * 1024 * 1024)
  const bytes = result.bytes
  const png = contentType === 'image/png' && bytes.length >= 8
    && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
  const jpeg = contentType === 'image/jpeg' && bytes.length >= 4
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
  if (!png && !jpeg) fail()
  if (contentType === 'image/png') return { contentType, sha256: result.sha256, bytes }
  if (contentType === 'image/jpeg') return { contentType, sha256: result.sha256, bytes }
  return fail()
}
