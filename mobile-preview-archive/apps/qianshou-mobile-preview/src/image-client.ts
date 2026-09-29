/** Account-authenticated client for the published image gateway. */

export type ImageGenerationPhase = 'queued' | 'processing' | 'succeeded' | 'failed' | 'cancelled'

export interface ImageGenerationState {
  readonly phase: ImageGenerationPhase
  readonly message: string
  readonly elapsedMs?: number
}

export interface GeneratedImage {
  readonly dataUri: string
  readonly mimeType: string
  readonly revisedPrompt?: string
}

export interface ImageGenerationRequest {
  readonly model: string
  readonly prompt: string
  readonly size?: string
}

export interface ImageEditRequest extends ImageGenerationRequest {
  readonly image: string
}

export interface ImageGenerationResult {
  readonly model: string
  readonly images: readonly GeneratedImage[]
  readonly gateway?: {
    readonly requestId?: string
    readonly elapsedMs?: number
    readonly metering?: { readonly priced?: boolean; readonly note?: string }
  }
}

type ImageCall<T> = (request: T, signal: AbortSignal, onState?: (state: ImageGenerationState) => void) => Promise<ImageGenerationResult>

export class ImageGenerationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'ImageGenerationError'
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringOf(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }

/** Keep quota failures actionable even when a proxy omitted its message. */
function quotaFailureMessage(code: string, status: number): string | undefined {
  if (status === 402 || /^(?:no-credit|insufficient-balance|quota(?:-exceeded|_exceeded)?)$/u.test(code)) {
    return '当前可用额度不足，请打开账户中心的「额度与订阅」充值或续订后再试。'
  }
  return undefined
}

/** Cookie-gate refusals omit `message`; that is not "the pool failed". */
function generationFailure(payload: Record<string, unknown> | null, status: number): { code: string; message: string } {
  const errorBody = objectOf(payload?.error)
  const code = stringOf(errorBody?.code) ?? stringOf(payload?.code) ?? `http-${status}`
  const message = stringOf(errorBody?.message) ?? stringOf(payload?.message)
  if (message !== undefined) return { code, message }
  const quotaMessage = quotaFailureMessage(code, status)
  if (quotaMessage !== undefined) return { code, message: quotaMessage }
  if (code === 'AUTH_REQUIRED' || status === 401) {
    return { code: 'AUTH_REQUIRED', message: '出图通道没有认到这次登录，图还没交到号池。' }
  }
  return { code, message: '出图没有完成，请稍后重试。' }
}

/**
 * Build a client that exposes observable phases around the synchronous image
 * gateway. The gateway currently returns one final response; `queued` and
 * `processing` are honest UI phases while that request is in flight. No retry
 * is performed because one call may consume an upstream pool slot.
 */
export function createImageGenerationClient(options: {
  readonly fetch: typeof fetch
  readonly access: (signal: AbortSignal) => Promise<string | null>
  readonly accountId: () => string | null
  readonly endpoint?: string
  readonly editEndpoint?: string
  readonly timeoutMs?: number
}): {
  readonly generate: ImageCall<ImageGenerationRequest>
  readonly edit: ImageCall<ImageEditRequest>
} {
  const endpoint = options.endpoint ?? '/api/qianshou/ai/images/generations'
  const timeoutMs = options.timeoutMs ?? 200_000
  const execute: ImageCall<ImageGenerationRequest | ImageEditRequest> = async (request, signal, onState = () => {}) => {
    const editing = 'image' in request
    if (editing && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(request.image)) {
      throw new ImageGenerationError('invalid-image', '请上传 PNG、JPEG 或 WebP 原图后再修改。', 400)
    }
    const accountId = options.accountId()
    if (!accountId) throw new ImageGenerationError('auth_required', '请先登录后再出图。', 401)
    if (!request.prompt.trim()) throw new ImageGenerationError('invalid-request', '出图描述不能为空。', 400)
    const token = await options.access(signal)
    signal.throwIfAborted()
    if (!token || options.accountId() !== accountId) throw new ImageGenerationError('auth_required', '登录状态已失效，请重新登录。', 401)
    onState({ phase: 'queued', message: editing ? '正在提交原图与修改要求。' : '正在出图，请稍等。' })
    onState({ phase: 'processing', message: editing ? '正在修改图片，请稍等。' : '正在出图，请稍等。' })
    let response: Response
    try {
      response = await options.fetch(editing ? options.editEndpoint ?? '/api/qianshou/ai/images/edits' : endpoint, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: request.model, prompt: request.prompt, n: 1, response_format: 'b64_json',
          ...(editing ? { image: request.image } : {}), ...(request.size === undefined ? {} : { size: request.size }),
        }),
      })
    } catch (error) {
      if (signal.aborted) {
        onState({ phase: 'cancelled', message: '已取消出图。' })
        throw error
      }
      onState({ phase: 'failed', message: '这一张没画成，稍后再试一次。' })
      throw new ImageGenerationError('network-error', '这一张没画成，稍后再试一次。', 503)
    }
    const payload = objectOf(await response.json().catch(() => null))
    if (!response.ok) {
      const failure = generationFailure(payload, response.status)
      onState({ phase: 'failed', message: failure.message })
      throw new ImageGenerationError(failure.code, failure.message, response.status)
    }
    const rawImages = Array.isArray(payload?.data) ? payload.data : []
    const gateway = objectOf(payload?.qianshou_gateway)
    const diagnostic = objectOf(payload?.qianshou)
    const images = rawImages.flatMap((raw): GeneratedImage[] => {
      const item = objectOf(raw)
      const encoded = stringOf(item?.b64_json)
      if (!encoded) return []
      const mime = stringOf(diagnostic?.mime_type) ?? 'image/jpeg'
      const revisedPrompt = stringOf(item?.revised_prompt)
      const image: GeneratedImage = { dataUri: `data:${mime};base64,${encoded}`, mimeType: mime }
      return [revisedPrompt === undefined ? image : { ...image, revisedPrompt }]
    })
    if (images.length === 0) {
      onState({ phase: 'failed', message: '出图服务返回了空结果。' })
      throw new ImageGenerationError('empty_image', '出图服务返回了空结果。', 502)
    }
    const elapsedMs = typeof diagnostic?.elapsed_ms === 'number' ? diagnostic.elapsed_ms : undefined
    onState({ phase: 'succeeded', message: editing ? '图片已修改。' : '图片已生成。', ...(elapsedMs === undefined ? {} : { elapsedMs }) })
    const result: ImageGenerationResult = { model: stringOf(payload?.model) ?? request.model, images }
    if (gateway !== null || diagnostic !== null) {
      const metadata: { requestId?: string; elapsedMs?: number; metering?: { priced?: boolean; note?: string } } = {}
      const requestId = stringOf(diagnostic?.request_id)
      if (requestId !== undefined) metadata.requestId = requestId
      if (elapsedMs !== undefined) metadata.elapsedMs = elapsedMs
      const metering = objectOf(gateway?.metering)
      if (metering !== null) metadata.metering = metering
      return { ...result, gateway: metadata }
    }
    return result
  }
  return { generate: execute, edit: execute }
}
