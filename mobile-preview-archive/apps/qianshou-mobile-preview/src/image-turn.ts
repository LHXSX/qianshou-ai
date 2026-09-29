/** One confirmed image request, one gateway call. Clarify stages never reach here. */
import { confirmImagePrompt, type ImageIntentPlan } from '@deepseek-ai/dsh-client-compute-trigger'
import { ImageGenerationError, type GeneratedImage, type ImageGenerationState } from './image-client.ts'

export const IMAGE_GATEWAY_MODEL = '千手·绘画'

export interface ImageTurnRecord {
  readonly id: string
  readonly prompt: string
  readonly images: readonly GeneratedImage[]
  readonly at: number
}

/**
 * @param options - Gateway generate function already bound to the signed-in account.
 * @returns A controller that refuses overlapping confirms instead of retrying.
 */
export function createImageTurnController(options: {
  readonly generate: (
    request: { readonly model: string; readonly prompt: string },
    signal: AbortSignal,
    onState?: (state: ImageGenerationState) => void,
  ) => Promise<{ readonly images: readonly GeneratedImage[] }>
  readonly edit?: (
    request: { readonly model: string; readonly prompt: string; readonly image: string },
    signal: AbortSignal,
    onState?: (state: ImageGenerationState) => void,
  ) => Promise<{ readonly images: readonly GeneratedImage[] }>
  readonly now?: () => number
  readonly id?: () => string
}): {
  readonly busy: () => boolean
  readonly confirm: (
    plan: ImageIntentPlan,
    onState?: (state: ImageGenerationState) => void,
    originalImage?: string,
  ) => Promise<ImageTurnRecord>
  readonly abort: () => void
} {
  let inFlight: AbortController | null = null
  return {
    busy: () => inFlight !== null,
    abort: () => { inFlight?.abort() },
    confirm: async (plan, onState, originalImage) => {
      if (plan.stage !== 'confirm') throw new ImageGenerationError('not-ready', '还需要补充出图要求。', 400)
      if (inFlight !== null) throw new ImageGenerationError('busy', '出图正在进行，请等待这一次完成。', 429)
      const prompt = confirmImagePrompt(plan)
      if (plan.kind === 'image.edit' && (options.edit === undefined || originalImage === undefined)) {
        throw new ImageGenerationError('missing-image', '请先上传要修改的原图。', 400)
      }
      const flight = new AbortController()
      inFlight = flight
      try {
        const result = plan.kind === 'image.edit' && options.edit !== undefined && originalImage !== undefined
          ? await options.edit({ model: IMAGE_GATEWAY_MODEL, prompt, image: originalImage }, flight.signal, onState)
          : await options.generate({ model: IMAGE_GATEWAY_MODEL, prompt }, flight.signal, onState)
        flight.signal.throwIfAborted()
        const at = options.now?.() ?? Date.now()
        return { id: options.id?.() ?? `image-${at}`, prompt, images: result.images, at }
      } finally {
        if (inFlight === flight) inFlight = null
      }
    },
  }
}
