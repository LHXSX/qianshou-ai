/** Prepare transient PNG/JPEG bytes and explicit ordered roles without persisting attachment content. */
import type { SubmitAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { FormalMediaAssetIntent } from './formal-media-transport.ts'

/** Decode supported conversation attachments before requesting an official asset ticket.
 * @param sessionId - Original conversation identity.
 * @param capability - Selected @ image or video entry.
 * @param attachments - Original ordered attachments; video order is first frame then last frame.
 * @returns Transient bytes and stable identifiers; callers persist identifiers before uploading.
 */
export async function formalMediaAttachments(sessionId: string, capability: 'image' | 'video', attachments: readonly SubmitAttachment[]) {
  if (attachments.length > (capability === 'video' ? 2 : 8)) throw new Error('COMPUTE_MEDIA_ASSET_INVALID')
  const prepared: Array<{ intent: FormalMediaAssetIntent; data: string }> = []
  for (const [index, image] of attachments.entries()) {
    if (image.type !== 'image' || !['image/png', 'image/jpeg'].includes(image.mediaType)
      || image.data.length < 1 || image.data.length > Math.ceil(16777216 / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)) {
      throw new Error('COMPUTE_MEDIA_ASSET_INVALID')
    }
    const binary = atob(image.data)
    if (btoa(binary) !== image.data || binary.length > 16777216) throw new Error('COMPUTE_MEDIA_ASSET_INVALID')
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    if (image.mediaType === 'image/png'
      ? ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, offset) => bytes[offset] === byte)
      : bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('COMPUTE_MEDIA_ASSET_INVALID')
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))]
      .map(value => value.toString(16).padStart(2, '0')).join('')
    prepared.push({ data: image.data, intent: { assetId: randomUUID(), sessionId, sha256,
      mediaType: image.mediaType as FormalMediaAssetIntent['mediaType'],
      role: capability === 'image' ? 'reference' : index === 0 ? 'first_frame' : 'last_frame' } })
  }
  return prepared
}
