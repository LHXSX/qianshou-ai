/** Browser-local first-frame approval before a video task may upload or request a quote. */
import { marketInputFile, type MarketInputFile, type MarketTaskType,
  type MarketTaskTransport, type MarketVideoReviewExpectation } from './market-task-transport.ts'

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_CHOICES = 4
const MAX_PROMPT_BYTES = 8192

/** One real, privately held first-frame option; its bytes are never uploaded by preparation. */
export interface VideoImageChoice {
  readonly id: string
  readonly file: File
  readonly mimeType: 'image/png' | 'image/jpeg'
  readonly bytes: number
  readonly sha256: string
}

/** The exact buyer-approved image revision and prompt. This is local UI intent, not payment consent. */
export interface ConfirmedVideoCreativeChoice {
  readonly choice: VideoImageChoice
  readonly prompt: string
  readonly approvedSha256: string
  readonly expectedVideoReview: MarketVideoReviewExpectation | null
}

/** Object-store receipt for the approved image; the storage version is required. */
export interface VideoStagedAsset {
  readonly file: MarketInputFile & { readonly objectVersionId: string }
  readonly approvedSha256: string
}

class ApprovedChoice implements ConfirmedVideoCreativeChoice {
  readonly choice: VideoImageChoice
  readonly prompt: string
  readonly approvedSha256: string

  readonly expectedVideoReview: MarketVideoReviewExpectation | null

  constructor(choice: VideoImageChoice, prompt: string, taskType?: MarketTaskType) {
    this.choice = choice
    this.prompt = prompt
    this.approvedSha256 = choice.sha256
    const review = taskType?.reviewedVideoInput
    const publication = taskType?.reviewedPublication
    this.expectedVideoReview = taskType !== undefined && supportsVideoFirstFrameTask(taskType, choice.mimeType)
      && review !== undefined && publication !== undefined
      ? Object.freeze({ publicationId: review.publicationId,
        approvedContractDigest: review.approvedContractDigest,
        artifactDigest: publication.artifactDigest, contractSha256: publication.contractSha256 }) : null
    Object.freeze(this)
  }
}

class StagedAsset implements VideoStagedAsset {
  readonly file: MarketInputFile & { readonly objectVersionId: string }
  readonly approvedSha256: string
  private readonly confirmation: ConfirmedVideoCreativeChoice

  constructor(file: MarketInputFile & { readonly objectVersionId: string },
    confirmation: ConfirmedVideoCreativeChoice) {
    this.file = Object.freeze({ ...file })
    this.approvedSha256 = confirmation.approvedSha256
    this.confirmation = confirmation
    Object.freeze(this)
  }

  matches(confirmation: ConfirmedVideoCreativeChoice): boolean { return this.confirmation === confirmation }
}

/** Exact existing market-plan fields; payment remains a later, separate quote confirmation. */
export interface VideoMarketTaskRequest {
  readonly taskType: string
  readonly goal: string
  readonly params: Readonly<Record<string, string | number | boolean>>
  readonly files: readonly MarketInputFile[]
  readonly expectedVideoReview: MarketVideoReviewExpectation
}

function invalid(): never { throw new Error('VIDEO_CREATIVE_INPUT_INVALID') }

async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = Reflect.get(globalThis.crypto, 'subtle') as SubtleCrypto | undefined
  if (subtle === undefined) throw new Error('VIDEO_IMAGE_DIGEST_UNAVAILABLE')
  const input = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  input.set(bytes)
  const value = await subtle.digest('SHA-256', input.buffer)
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')
}

function imageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10]
    .every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg'
  return null
}

/** Snapshot up to four real local pictures for preview and selection, without any network call.
 * @param files - Browser-selected PNG/JPEG images; not catalogue thumbnails.
 * @returns Immutable choice metadata and private file snapshots.
 */
export async function prepareVideoImageChoices(files: readonly File[]): Promise<readonly VideoImageChoice[]> {
  if (files.length < 1 || files.length > MAX_CHOICES) invalid()
  const choices: VideoImageChoice[] = []
  for (const [index, file] of files.entries()) {
    if (!(file instanceof File) || file.size < 8 || file.size > MAX_IMAGE_BYTES) invalid()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const mimeType = imageMime(bytes)
    if (mimeType === null || file.type !== mimeType || bytes.length !== file.size) invalid()
    const sha256 = await digest(bytes)
    const extension = mimeType === 'image/png' ? 'png' : 'jpg'
    const snapshot = new File([bytes], `first-frame-${index + 1}-${sha256.slice(0, 12)}.${extension}`,
      { type: mimeType })
    choices.push(Object.freeze({ id: `image_${index + 1}_${sha256.slice(0, 12)}`,
      file: snapshot, mimeType, bytes: snapshot.size, sha256 }))
  }
  return Object.freeze(choices)
}

/** Record the user's explicit choice; calling this does not upload, quote, or dispatch.
 * @param choices - Previously prepared local images.
 * @param id - The image ID selected in the preview.
 * @param prompt - Final natural-language brief after the user's answers.
 * @param taskType - Current reviewed task form, if one is available.
 * @returns A revision-bound creative approval for the next step.
 */
export function confirmVideoImageChoice(choices: readonly VideoImageChoice[], id: string,
  prompt: string, taskType?: MarketTaskType): ConfirmedVideoCreativeChoice {
  const choice = choices.find(item => item.id === id)
  if (!choice || typeof prompt !== 'string' || !prompt.isWellFormed()
    || prompt.trim().length === 0 || new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) invalid()
  return new ApprovedChoice(choice, prompt, taskType)
}

/** Upload only the expressly chosen snapshot and check the immutable object-store receipt.
 * @param confirmation - Local buyer creative approval.
 * @param upload - Existing authenticated PC Host upload method.
 * @param signal - Cancellation before and after the upload.
 * @returns Storage receipt bound to the selected content digest and object version.
 */
export async function stageConfirmedVideoChoice(confirmation: ConfirmedVideoCreativeChoice,
  upload: NonNullable<MarketTaskTransport['uploadInputFile']>, signal: AbortSignal): Promise<VideoStagedAsset> {
  if (!(confirmation instanceof ApprovedChoice) || confirmation.expectedVideoReview === null) invalid()
  signal.throwIfAborted()
  const { choice } = confirmation
  const bytes = new Uint8Array(await choice.file.arrayBuffer())
  if (bytes.length !== choice.bytes || imageMime(bytes) !== choice.mimeType
    || await digest(bytes) !== confirmation.approvedSha256
    || choice.sha256 !== confirmation.approvedSha256) invalid()
  signal.throwIfAborted()
  const receipt = marketInputFile(await upload(choice.file, signal, 'reviewed-video-first-frame'))
  signal.throwIfAborted()
  if (receipt.sha256 !== confirmation.approvedSha256 || receipt.bytes !== choice.bytes
    || receipt.contentType !== choice.mimeType
    || receipt.filename !== (choice.mimeType === 'image/png' ? 'frame.png' : 'frame.jpg')
    || !/^v8\/account-[1-9]\d*\/reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg)$/u.test(receipt.objectKey)
    || receipt.objectVersionId === undefined) throw new Error('VIDEO_IMAGE_UPLOAD_MISMATCH')
  return new StagedAsset(receipt as MarketInputFile & { objectVersionId: string }, confirmation)
}

/** Check whether the current signed task form can deliver both first-frame bytes and prompt text.
 * @param type - Current live catalogue row, not a retained local copy.
 * @param imageMimeType - Optional chosen first-frame MIME type.
 * @returns Whether a mixed input may proceed to upload preparation.
 */
export function supportsVideoFirstFrameTask(type: MarketTaskType,
  imageMimeType?: VideoImageChoice['mimeType']): boolean {
  const fields = type.paramFields ?? []
  const prompt = fields.find(field => field.name === 'prompt')
  const review = type.reviewedVideoInput
  const publication = type.reviewedPublication
  return type.capabilityId === 'video.render' && type.canQuoteFiles === true
    && review?.schema === 'qianshou.reviewed-video-task-input.v1'
    && review.firstFrameSlot === 'first_frame' && review.promptSlot === 'prompt'
    && /^sha256:[a-f0-9]{64}$/u.test(review.approvedContractDigest)
    && publication?.schema === 'qianshou.reviewed-publication-selection.v1'
    && publication.publicationId === review.publicationId
    && /^sha256:[a-f0-9]{64}$/u.test(publication.artifactDigest)
    && /^sha256:[a-f0-9]{64}$/u.test(publication.contractSha256)
    && (imageMimeType === undefined || review.mimeType === imageMimeType)
    && review.maxBytes >= 8 && review.maxPromptUtf8Bytes >= 1
    && type.acceptedInputKinds.includes('multi_file')
    && type.requiredParams.includes('input_manifest') && type.requiredParams.includes('prompt')
    && prompt?.type === 'string' && prompt.required
    && type.requiredParams.every(name => name === 'input_manifest'
      || fields.some(field => field.name === name && field.required))
}

/** Only fixed signed frame and frame-rate fields establish an exact video length.
 * @param type - Current Host-verified task form.
 * @returns Fixed seconds, or null when either signed field is not a required single value.
 */
export function reviewedFixedVideoDurationSeconds(type: MarketTaskType): number | null {
  if (!supportsVideoFirstFrameTask(type)) return null
  const fixed = (name: 'frames' | 'fps'): number | null => {
    const fields = (type.paramFields ?? []).filter(field => field.name === name)
    if (fields.length !== 1 || !type.requiredParams.includes(name)) return null
    const [field] = fields
    const value = field?.minimum
    return field?.required && field.type === 'integer' && value !== undefined
      && Number.isSafeInteger(value) && value > 0 && field.maximum === value
      && (field.choices === undefined || field.choices.includes(value)) ? value : null
  }
  const frames = fixed('frames')
  const fps = fixed('fps')
  return frames === null || fps === null ? null : frames / fps
}

/** Match the fixed generation settings in the five-second AI asset plan.
 * @param type - Current Host-verified task form.
 * @returns Whether the reviewed form fixes 120 frames at 24 FPS.
 */
export function supportsReviewedFiveSecondVideoPlan(type: MarketTaskType): boolean {
  if (reviewedFixedVideoDurationSeconds(type) !== 5) return false
  const fields = type.paramFields ?? []
  return fields.find(field => field.name === 'frames')?.minimum === 120
    && fields.find(field => field.name === 'fps')?.minimum === 24
}

const durationMention = /(\d+(?:\.\d+)?|[一二三四五六七八九十百半两]+)\s*(小时|分钟|分半|秒半|秒|seconds?|secs?|minutes?|mins?|s|m|h)(?![a-z])/giu
const combinedMinuteSeconds = /(\d+(?:\.\d+)?)\s*m\s*(\d+(?:\.\d+)?)\s*s(?![a-z])/giu
const chineseMinuteSeconds = /(\d+(?:\.\d+)?|[一二三四五六七八九十百半两]+)\s*分\s*(?:零\s*)?(\d+(?:\.\d+)?|[一二三四五六七八九十百半两]+)\s*秒/gu
const clockDuration = /(\d{1,2}):([0-5]\d)(?!\d)/gu

/** Bare `m` may describe a camera movement in metres, so require nearby time/video context. */
function minuteShorthandContext(value: string, start: number, end: number): boolean {
  const before = value.slice(Math.max(0, start - 24), start)
  const after = value.slice(end, end + 16)
  return /(?:时长|片长|持续|做|生成|制作|剪成|出片|改成|改为|调整为)\s*[：:为是]?\s*$/u.test(before)
    || /^\s*(?:的|个)?\s*(?:视频|短片|片段|影片|动画|钟)/u.test(after)
    || value.trim() === value.slice(start, end)
}

function explicitVideoDurations(value: string): number[] {
  const seconds: number[] = []
  for (const match of value.matchAll(combinedMinuteSeconds)) {
    seconds.push(Number(match[1]) * 60 + Number(match[2]))
  }
  for (const match of value.matchAll(chineseMinuteSeconds)) {
    const minutes = match[1] ?? ''
    const remainder = match[2] ?? ''
    seconds.push((/^[\d.]+$/u.test(minutes) ? Number(minutes) : NaN) * 60
      + (/^[\d.]+$/u.test(remainder) ? Number(remainder) : NaN))
  }
  for (const match of value.matchAll(clockDuration)) {
    const minute = match[1] ?? ''
    const before = value.slice(Math.max(0, match.index - 24), match.index)
    const after = value.slice(match.index + match[0].length, match.index + match[0].length + 16)
    // Leading-zero clocks are duration notation; `9:16` without a duration cue is an aspect ratio.
    const durationCue = /(?:时长|片长|持续|长达)\s*[：:为是]?\s*$/u.test(before)
    const videoNoun = /^\s*(?:的|个)?\s*(?:视频|短片|片段|影片|动画|成片)/u.test(after)
    if (minute.startsWith('0') || durationCue || match[0] !== '9:16' && videoNoun) {
      seconds.push(Number(minute) * 60 + Number(match[2]))
    }
  }
  for (const match of value.matchAll(durationMention)) {
    const amount = match[1] ?? ''
    const unit = (match[2] ?? '').toLowerCase()
    if (unit === 'm' && !minuteShorthandContext(value, match.index, match.index + match[0].length)) continue
    const number = amount === '五' ? 5 : /^[\d.]+$/u.test(amount) ? Number(amount) : NaN
    seconds.push(/^(?:秒|s|secs?|seconds?)$/u.test(unit) ? number
      : /^(?:分钟|m|mins?|minutes?)$/u.test(unit) ? number * 60
        : /^(?:小时|h)$/u.test(unit) ? number * 3600 : NaN)
  }
  return seconds
}

/** User-specified length remains a requirement even when phrased inside a creative brief.
 * @param value - Buyer's natural-language brief.
 * @returns Whether the brief names an explicit duration.
 */
export function asksForSpecificVideoDuration(value: string): boolean {
  return explicitVideoDurations(value).length > 0
}

/** A five-second promise requires the current signed form to fix frame count and frame rate.
 * @param value - Buyer's natural-language brief.
 * @param fixedSeconds - Exact length derived from the current signed task form.
 * @returns Whether the requested length lacks a matching reviewed fixed duration.
 */
export function asksForUnverifiedVideoDuration(value: string, fixedSeconds: number | null): boolean {
  const mentions = explicitVideoDurations(value)
  if (mentions.length === 0) return false
  if (fixedSeconds !== 5) return true
  return mentions.some(seconds => seconds !== 5)
}

/** Exact buyer-approved publication, artifact and contract must still be current. */
export function matchesReviewedVideoSelection(type: MarketTaskType,
  expected: MarketVideoReviewExpectation): boolean {
  const review = type.reviewedVideoInput
  const publication = type.reviewedPublication
  return review?.publicationId === expected.publicationId
    && review.approvedContractDigest === expected.approvedContractDigest
    && publication?.publicationId === expected.publicationId
    && publication.artifactDigest === expected.artifactDigest
    && publication.contractSha256 === expected.contractSha256
}

/** Admit a mixed image-and-text market plan only when Shanghai's live signed form declares it.
 * @param taskType - Live task form, never inferred from a video title or category.
 * @param confirmation - Buyer's image and natural-language approval.
 * @param asset - Matching completed upload receipt.
 * @param additionalParams - Other signed scalar task fields, such as frame count.
 * @returns Local plan request; this function neither quotes nor publishes it.
 */
export function videoMarketTaskRequest(taskType: MarketTaskType,
  confirmation: ConfirmedVideoCreativeChoice, asset: VideoStagedAsset,
  additionalParams: Readonly<Record<string, string | number | boolean>> = {}): VideoMarketTaskRequest {
  const review = taskType.reviewedVideoInput
  if (!(confirmation instanceof ApprovedChoice) || !(asset instanceof StagedAsset)
    || !asset.matches(confirmation)
    || asset.approvedSha256 !== confirmation.approvedSha256
    || asset.file.sha256 !== confirmation.approvedSha256
    || !supportsVideoFirstFrameTask(taskType, confirmation.choice.mimeType)
    || review === undefined || confirmation.expectedVideoReview === null
    || !matchesReviewedVideoSelection(taskType, confirmation.expectedVideoReview)
    || asset.file.bytes > review.maxBytes
    || new TextEncoder().encode(confirmation.prompt).length > review.maxPromptUtf8Bytes
    || asksForUnverifiedVideoDuration(confirmation.prompt, reviewedFixedVideoDurationSeconds(taskType))) invalid()
  const fields = taskType.paramFields ?? []
  const promptField = fields.find(field => field.name === 'prompt')
  if (promptField?.type !== 'string' || !promptField.required
    || Object.hasOwn(additionalParams, 'prompt') || Object.hasOwn(additionalParams, 'input_manifest')) invalid()
  const params: Record<string, string | number | boolean> = { ...additionalParams,
    prompt: confirmation.prompt }
  for (const [name, value] of Object.entries(params)) {
    const field = fields.find(item => item.name === name)
    if (!field || typeof value !== (field.type === 'integer' || field.type === 'number' ? 'number' : field.type)
      || field.type === 'integer' && !Number.isSafeInteger(value)
      || typeof value === 'string' && (field.minLength !== undefined && value.length < field.minLength
        || field.maxLength !== undefined && value.length > field.maxLength)
      || typeof value === 'number' && (field.minimum !== undefined && value < field.minimum
        || field.maximum !== undefined && value > field.maximum)
      || field.choices !== undefined && !field.choices.includes(value)) invalid()
  }
  if (!taskType.requiredParams.every(name => name === 'input_manifest' || Object.hasOwn(params, name))) invalid()
  return Object.freeze({ taskType: taskType.taskType, goal: confirmation.prompt,
    params: Object.freeze(params), files: Object.freeze([asset.file]),
    expectedVideoReview: confirmation.expectedVideoReview })
}
