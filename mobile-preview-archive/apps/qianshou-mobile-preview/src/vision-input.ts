/** Bounded, account-owned original uploads and intent selection before the existing edit router. */
import type { AgentPromptImage, AgentSessionBinding } from './window/mobile-workspace-types.ts'
import { visionCopy } from './vision-copy.ts'

export const VISION_INPUT_LIMITS = { count: 4, fileBytes: 8 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 } as const
const mediaTypes: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const editPatterns = [
  /修图|改图|编辑(?:这|那|一下|图片|图像)/u,
  /(?:修改|更换|替换|改变|去掉|移除|删除|擦除|换成|改成|调成|变成|加上|添加).*(?:背景|颜色|色彩|人物|衣服|水印|文字|物体|风格)/u,
  /(?:把|将).*(?:换|改|变|去掉|移除)|(?:背景|颜色|色彩|风格).*(?:换|改|调)/u,
  /(?:改|换)(?:一下|个|一种)?(?:背景|颜色|风格)/u,
  /\b(?:edit|retouch|remove|replace|change)\b.*\b(?:image|photo|picture|background|color|object|text|watermark)\b/u,
]
const understandingPatterns = [
  /这(?:张|个|幅)?(?:图(?:片)?|照片|画)?(?:里|中|上面)?(?:是|有什么|怎么样|怎么回事)/u,
  /识图|读图|看图|识别|分析|解读|描述|提取|提炼|读出|翻译|总结|图(?:片)?(?:里|中|上).*(?:文字|内容|什么)/u,
  /\b(?:ocr|describe|analy[sz]e|identify|recognize|read|transcribe|translate)\b|\bwhat(?:'s| is| are)\b/u,
]
const imageReferencePatterns = [
  /图片|图像|照片|这张|这幅|图里|图中|识图|读图|看图|修图|改图|背景|水印|这是什么|识别文字|提取文字/u,
  /\b(?:image|photo|picture|ocr|background|watermark|this|it)\b/u,
  /^(?:帮我|请|麻烦)?(?:分析|识别|解读|描述|看看)(?:一下|下)?[。！？!?]*$/u,
]
const sameBinding = (left: AgentSessionBinding | null, right: AgentSessionBinding): boolean =>
  left?.accountId === right.accountId && left.sessionId === right.sessionId

/** A recent original can be reused only by an explicit image operation in its owning Session. */
export interface RecentVisionImages<T> {
  readonly binding: AgentSessionBinding
  readonly sources: readonly T[]
  readonly at: number
  readonly userTurnsSinceImage: number
}
export type VisionInputDecision<T> =
  | { readonly route: 'vision' | 'edit'; readonly sources: readonly T[] }
  | { readonly route: 'clarify'; readonly message: string }
  | { readonly route: 'none' }

/** Select understanding versus editing without executing a capability or rewriting the user's prompt.
 * @param text - Original user input.
 * @param context - Current binding and its explicitly selected originals; recent media is bounded and never inferred across Sessions.
 * @returns A decision to consume before the generation/edit router; ordinary chat gets no media.
 */
export function resolveVisionInput<T>(text: string, context: {
  readonly binding: AgentSessionBinding
  readonly attachments: readonly T[]
  readonly recent?: RecentVisionImages<T>
  readonly now: number
}): VisionInputDecision<T> {
  const normalized = text.trim().toLowerCase()
  if (!context.attachments.length && /(?:什么是\s*ocr|ocr\s*是什么|(?:识图|读图)(?:功能|接口|技术)?.*(?:开发|实现|原理))/u.test(normalized))
    return { route: 'none' }
  // Ignore explicitly negated editing actions before checking affirmative image edits.
  const affirmative = normalized.replace(/(?:不要|别|不用|不需要|无需|不用再)(?:修改|编辑|改图|修图|改变|换背景)/gu, '')
  const edit = editPatterns.some(pattern => pattern.test(affirmative))
  const understand = understandingPatterns.some(pattern => pattern.test(normalized))
  const refersToImage = imageReferencePatterns.some(pattern => pattern.test(normalized))
  const recent = context.recent
  const sources = context.attachments.length ? context.attachments
    : recent && sameBinding(recent.binding, context.binding) && Number.isFinite(recent.at)
      && context.now >= recent.at && context.now - recent.at <= 5 * 60 * 1000
      && Number.isSafeInteger(recent.userTurnsSinceImage) && recent.userTurnsSinceImage >= 0 && recent.userTurnsSinceImage <= 2
      ? recent.sources : []
  if (edit && sources.length && (context.attachments.length || refersToImage)) return { route: 'edit', sources }
  if (understand && sources.length && (context.attachments.length || refersToImage)) return { route: 'vision', sources }
  if (context.attachments.length) return { route: 'clarify', message: visionCopy.chooseOperation }
  // An explicit missing image request must not be sent to a text-only model claiming to see it.
  if (/(?:识图|读图|看图|这(?:张|幅)图|这张照片|图片(?:里|中|上)|\b(?:this image|this photo|this picture|ocr)\b)/u.test(normalized)
    && understand) return { route: 'clarify', message: visionCopy.chooseImage }
  return { route: 'none' }
}

/** Validate outgoing bytes without decoding an untrusted raster in the browser; the server performs full image validation.
 * @param images - Canonical base64 payloads of original files.
 */
export function validateVisionImages(images: readonly AgentPromptImage[]): void {
  if (!Array.isArray(images) || !images.length || images.length > VISION_INPUT_LIMITS.count) throw new Error('MOBILE_AGENT_IMAGE_LIMIT')
  let total = 0
  for (const image of images) {
    if (image === null || typeof image !== 'object' || !mediaTypes.includes(image.mediaType)
      || typeof image.data !== 'string' || !image.data.length
      || (image.name !== undefined && (typeof image.name !== 'string' || image.name.length > 200))) throw new Error('MOBILE_AGENT_INVALID_IMAGE')
    if (image.data.length > 4 * Math.ceil(VISION_INPUT_LIMITS.fileBytes / 3)) throw new Error('MOBILE_AGENT_IMAGE_FILE_LIMIT')
    if (image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.data)) throw new Error('MOBILE_AGENT_INVALID_IMAGE')
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    if ((image.data.endsWith('==') && alphabet.indexOf(image.data.charAt(image.data.length - 3)) % 16 !== 0)
      || (image.data.endsWith('=') && !image.data.endsWith('==') && alphabet.indexOf(image.data.charAt(image.data.length - 2)) % 4 !== 0))
      throw new Error('MOBILE_AGENT_INVALID_IMAGE')
    const bytes = image.data.length / 4 * 3 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0)
    if (bytes > VISION_INPUT_LIMITS.fileBytes) throw new Error('MOBILE_AGENT_IMAGE_FILE_LIMIT')
    total += bytes
    if (total > VISION_INPUT_LIMITS.totalBytes) throw new Error('MOBILE_AGENT_REQUEST_LIMIT')
  }
}

/** Read selected originals with no resampling; account/Session switches discard even a late file read.
 * @param files - Original browser-owned Files, not URLs supplied in chat.
 * @param context - Captured owning binding, current binding getter and submission cancellation.
 * @returns The bounded submit-images payload, in selection order.
 */
export async function prepareVisionImages(files: readonly File[], context: {
  readonly binding: AgentSessionBinding
  readonly currentBinding: () => AgentSessionBinding | null
  readonly signal: AbortSignal
}): Promise<readonly AgentPromptImage[]> {
  const owner = { ...context.binding }
  const assertCurrent = (): void => {
    context.signal.throwIfAborted()
    if (!sameBinding(context.currentBinding(), owner)) throw new Error('MOBILE_AGENT_IMAGE_CONTEXT_CHANGED')
  }
  assertCurrent()
  if (!files.length || files.length > VISION_INPUT_LIMITS.count) throw new Error('MOBILE_AGENT_IMAGE_LIMIT')
  let total = 0
  for (const file of files) {
    if (!mediaTypes.includes(file.type) || !file.size) throw new Error('MOBILE_AGENT_INVALID_IMAGE')
    if (file.size > VISION_INPUT_LIMITS.fileBytes) throw new Error('MOBILE_AGENT_IMAGE_FILE_LIMIT')
    total += file.size
    if (total > VISION_INPUT_LIMITS.totalBytes) throw new Error('MOBILE_AGENT_REQUEST_LIMIT')
  }
  const images: AgentPromptImage[] = []
  for (const file of files) {
    assertCurrent()
    const data = await readOriginal(file, context.signal)
    assertCurrent()
    images.push({ mediaType: file.type as AgentPromptImage['mediaType'], data, name: file.name.slice(0, 200) })
  }
  validateVisionImages(images)
  return images
}

function readOriginal(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const onAbort = (): void => { cleanup(); reader.abort(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    reader.onerror = () => { cleanup(); reject(new Error('MOBILE_AGENT_INVALID_IMAGE')) }
    reader.onload = () => {
      cleanup()
      const prefix = `data:${file.type};base64,`
      if (typeof reader.result !== 'string' || !reader.result.startsWith(prefix)) reject(new Error('MOBILE_AGENT_INVALID_IMAGE'))
      else resolve(reader.result.slice(prefix.length))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) { onAbort(); return }
    reader.readAsDataURL(file)
  })
}

/** Map known bounded failure codes to local copy; never display raw provider errors.
 * @param error - A transport, file-read or abort failure.
 * @returns A concise notice safe to show beside the unchanged composer attachments.
 */
export function visionInputError(error: unknown): string {
  if (!(error instanceof Error)) return visionCopy.retry
  if (error.name === 'AbortError') return visionCopy.cancelled
  switch (error.message) {
    case 'MOBILE_AGENT_IMAGE_LIMIT': return visionCopy.count
    case 'MOBILE_AGENT_IMAGE_FILE_LIMIT': return visionCopy.fileSize
    case 'MOBILE_AGENT_REQUEST_LIMIT': return visionCopy.totalSize
    case 'MOBILE_AGENT_INVALID_IMAGE': return visionCopy.invalid
    case 'MOBILE_AGENT_IMAGE_UNAVAILABLE': return visionCopy.unavailable
    case 'MOBILE_AGENT_IMAGE_CONTEXT_CHANGED':
    case 'MOBILE_AGENT_ACCOUNT_CHANGED': return visionCopy.changed
    default: return visionCopy.retry
  }
}
