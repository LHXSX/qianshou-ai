/**
 * Guangzhou turn split for one signed-in PC.
 * Chat continues to the text model. A clarification is the whole reply.
 * A picture request goes to the image endpoint, whose account pool stays in Guangzhou.
 */
import type { ImageBlock, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Classification must finish well inside one text-model turn. */
export const INTENT_TIMEOUT_MS = 15_000
/** One picture can queue behind the Guangzhou image service's own limit. */
export const IMAGE_TIMEOUT_MS = 240_000
/** Sentence logged with a stored picture. It does not name an upstream. */
export const IMAGE_READY_TEXT = '好，这是按你的描述生成的。'
/** Streamed while the picture request is still open. The chat progress bar matches this sentence exactly. */
export const IMAGE_PROGRESS_TEXT = '正在出图'
/** Shown when classification cannot be read. The text model is not called. */
export const INTENT_UNAVAILABLE_TEXT = '没能分清这句话是对话还是出图，请再试一次。'
/** A local plan is informational only. A malformed or failed plan cannot start cloud work. */
export const LOCAL_PREVIEW_UNAVAILABLE_TEXT = '暂时不能确认这件事的处理方式，请稍后重试。'
/** Shown when the image endpoint returns no displayable bytes. */
export const IMAGE_MISSING_TEXT = '这次没有拿到图片，请再试一次。'
/** Shown when the bytes arrived but this PC could not store them. */
export const IMAGE_UNSTORED_TEXT = '图已经生成，但这台电脑没有把它放进会话。'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const VENDOR = /grok|deepseek|cursor|bearer|api[_-]?key/i

/** Clarification the next turn sends back so “随便” stays attached to the original request. */
export interface IntentPrevious {
  readonly capability: 'image.generate' | 'image.edit'
  readonly originalText: string
  readonly stage: 'clarify'
}

/** What this PC should do with one classified turn. */
export type CloudDecision =
  | { readonly kind: 'chat' }
  | { readonly kind: 'clarify'; readonly previous: IntentPrevious; readonly question: string }
  | { readonly kind: 'generate'; readonly prompt: string; readonly model: string }
  | { readonly kind: 'notice'; readonly text: string }

interface FactMessage {
  readonly role: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly source: { readonly kind: string }
}

/**
 * The newest human sentence, when this call is still that sentence's first model step.
 * Tool follow-ups and picture-only vision stay on the text route.
 * @param messages - derived request history.
 * @returns Text plus how many images or files rode with it, or undefined when this call is not that sentence.
 */
export function latestUserFacts(messages: readonly FactMessage[]): { text: string; attachmentCount: number } | undefined {
  let index = -1
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.source.kind === 'user') { index = cursor; break }
  }
  if (index < 0) return undefined
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    const later = messages[cursor]
    if (later?.role === 'assistant' || later?.content.some(block => block.type === 'tool-result')) return undefined
  }
  const message = messages[index]
  if (message === undefined) return undefined
  const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  if (text.trim() === '') return undefined
  return {
    text,
    attachmentCount: message.content.filter(block => block.type === 'image' || block.type === 'file').length,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Keep a gateway sentence that can be shown. Upstream names and tokens are replaced.
 * @param value - untrusted text from a JSON field.
 * @returns A short display sentence.
 */
export function publicText(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length === 0 || VENDOR.test(text)) return '这次没有完成，请再试一次。'
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/**
 * A compute-core preview may stop this first turn with advice, never with execution.
 * Chat and Guangzhou image candidates continue through the existing Guangzhou intent endpoint.
 */
export function localPreviewReply(value: unknown, originalText = '', localToolsAvailable = false): string | undefined {
  const row = record(value)
  if (row === undefined) return LOCAL_PREVIEW_UNAVAILABLE_TEXT
  if (row.executionAuthorized !== false || row.dispatchable !== false || row.quoteAmountMinor !== null) {
    return LOCAL_PREVIEW_UNAVAILABLE_TEXT
  }
  if (row.path === 'chat' || row.path === 'guangzhou') return undefined
  // Ordinary workspace tools enforce their own permission and dependency
  // checks. They do not require registration as a market compute executor.
  if (localToolsAvailable && ((row.capability === 'workspace.operation'
    && (row.path === 'local' || (row.path === 'unavailable' && row.reason === 'local-executor-missing')))
    || (row.path === 'clarify' && row.reason === 'missing-task'))) return undefined
  // Guangzhou already owns short picture prompts and image-edit clarification. A
  // generic local guess must not steal those routes without an explicit device destination.
  const explicitDevice = /(?:本机|本地|我的电脑|这台电脑|借用|借别人的|其他电脑|其他设备|共享算力)/u.test(originalText)
  const imageEdit = /(?:修改|编辑).{0,10}(?:图片|照片|这张图)/u.test(originalText)
  if (row.path === 'clarify' && !explicitDevice
    && (row.reason === 'missing-task' || (row.reason === 'unsupported-task' && imageEdit))) return undefined
  if (!['local', 'borrowed', 'clarify', 'unavailable', 'supply-review'].includes(String(row.path))
    || typeof row.message !== 'string' || row.message.trim() === '') return LOCAL_PREVIEW_UNAVAILABLE_TEXT
  return publicText(row.message)
}

/**
 * Read one intent response. Anything that is not a known decision becomes a notice.
 * @param payload - parsed JSON, which may be an error object.
 * @returns The next action for this turn.
 */
export function decisionOf(payload: unknown): CloudDecision {
  const body = record(payload)
  if (body?.ok === true && body.route === 'chat') return { kind: 'chat' }
  if (body?.ok === true && body.route === 'image' && body.stage === 'clarify') {
    const capability = body.capability
    const originalText = body.originalText
    const question = body.question
    if ((capability === 'image.generate' || capability === 'image.edit')
      && typeof originalText === 'string' && originalText.trim() !== ''
      && typeof question === 'string' && question.trim() !== '') {
      return {
        kind: 'clarify',
        previous: { capability, originalText, stage: 'clarify' },
        question: publicText(question),
      }
    }
  }
  if (body?.ok === true && body.route === 'image' && body.stage === 'generate') {
    const prompt = body.prompt
    const model = body.model
    if (typeof model === 'string' && VENDOR.test(model)) return { kind: 'notice', text: '这次没有完成，请再试一次。' }
    if (typeof prompt === 'string' && prompt.trim() !== ''
      && typeof model === 'string' && model.trim() !== '' && model.length <= 128) {
      return { kind: 'generate', prompt, model: model.trim() }
    }
  }
  const message = record(body?.error)?.message
  if (typeof message === 'string' && message.trim() !== '') return { kind: 'notice', text: publicText(message) }
  return { kind: 'notice', text: INTENT_UNAVAILABLE_TEXT }
}

/**
 * Read the first returned picture. Oversized or empty payloads are refused.
 * @param payload - image endpoint JSON.
 * @returns Decoded bytes, or undefined when the payload has no usable picture.
 */
export function imageBytesOf(payload: unknown): Uint8Array | undefined {
  const data = record(payload)?.data
  const row = Array.isArray(data) ? record(data[0]) : undefined
  const encoded = row?.b64_json
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_IMAGE_BYTES * 2) return undefined
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined
  return bytes
}

/**
 * Identify a picture from its leading bytes.
 * @param bytes - decoded image payload.
 * @returns A media type this PC can store, or undefined.
 */
export function mediaTypeOf(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

/**
 * Open the picture wait sentence without finishing the turn.
 * @returns The text block start and its first delta.
 */
export function imageProgressOpen(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: IMAGE_PROGRESS_TEXT },
  ]
}

/**
 * Replace the wait sentence and finish the turn.
 * @param text - final sentence stored on the text block.
 * @param image - stored picture, when one was saved.
 * @returns Chunks that close the open text block and finish the turn.
 */
export function imageProgressClose(text: string, image?: ImageBlock): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
  if (image !== undefined) {
    chunks.push(
      { type: 'block-start', index: 1, blockType: 'image' },
      { type: 'block-end', index: 1, block: image },
    )
  }
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

/**
 * One finished assistant reply, with an optional stored picture after the sentence.
 * @param text - visible sentence.
 * @param image - stored picture block, when this reply has one.
 * @returns Chunks the agent loop can log without calling the text model.
 */
export function textChunks(text: string, image?: ImageBlock): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ]
  if (image !== undefined) {
    chunks.push(
      { type: 'block-start', index: 1, blockType: 'image' },
      { type: 'block-end', index: 1, block: image },
    )
  }
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

/**
 * POST JSON with the account bearer. The caller supplies cancellation and a deadline.
 * @param fetcher - Host fetch.
 * @param url - Absolute gateway URL.
 * @param bearer - Account access token. It is not logged.
 * @param body - JSON request.
 * @param signal - Turn cancellation. Undefined waits only for the deadline.
 * @param timeoutMs - Deadline for this call.
 * @returns HTTP status and parsed JSON, or undefined when the body is not JSON.
 */
export async function postJson(
  fetcher: typeof fetch,
  url: string,
  bearer: string,
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ status: number; payload: unknown }> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetcher(url, {
    method: 'POST',
    redirect: 'error',
    credentials: 'omit',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  let payload: unknown
  try { payload = await response.json() } catch {
    // A non-JSON body is an unreadable payload. Transport failures throw before this read.
    payload = undefined
  }
  return { status: response.status, payload }
}
