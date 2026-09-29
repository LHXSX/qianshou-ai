import { describe, expect, it, vi } from 'vitest'
import { planImageIntent, readyImagePlan } from '@deepseek-ai/dsh-client-compute-trigger'
import { ImageGenerationError } from '../src/image-client.ts'
import { createImageTurnController, IMAGE_GATEWAY_MODEL } from '../src/image-turn.ts'

describe('confirmed image turns', () => {
  it('rejects a late image result after cancellation even if a transport ignores abort', async () => {
    let release: (() => void) | undefined
    const hold = new Promise<void>((resolve) => { release = resolve })
    const turns = createImageTurnController({ generate: async () => {
      await hold
      return { images: [{ dataUri: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg' }] }
    } })
    const plan = planImageIntent('生成一张橘猫图片')
    if (plan === null) throw new Error('TEST_PLAN_MISSING')
    const result = turns.confirm(plan)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    turns.abort()
    release?.()
    await rejected
    expect(turns.busy()).toBe(false)
  })
  it('sends one Guangzhou gateway request only after confirm, never on clarify', async () => {
    const generate = vi.fn<Parameters<typeof createImageTurnController>[0]['generate']>(async () => ({ images: [{ dataUri: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg' }] }))
    const turns = createImageTurnController({ generate, now: () => 1, id: () => 'img-1' })
    const clarify = planImageIntent('给我出图')
    expect(clarify?.stage).toBe('clarify')
    await expect(turns.confirm(clarify!)).rejects.toMatchObject({ code: 'not-ready' })
    expect(generate).not.toHaveBeenCalled()
    const plan = planImageIntent('生成一张雨夜赛博城市海报，16:9，不要文字')
    expect(plan?.stage).toBe('confirm')
    const record = await turns.confirm(plan!)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0]).toEqual({ model: IMAGE_GATEWAY_MODEL, prompt: plan!.prompt })
    expect(record.images).toHaveLength(1)
  })

  it('turns a clarified subject into one gateway request', async () => {
    const generate = vi.fn<Parameters<typeof createImageTurnController>[0]['generate']>(async () => ({ images: [{ dataUri: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg' }] }))
    const turns = createImageTurnController({ generate, now: () => 1, id: () => 'img-1' })
    const prepared = readyImagePlan(planImageIntent('给我出图')!, '一只橘猫')
    expect(prepared.stage).toBe('confirm')
    await turns.confirm(prepared)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0]).toEqual({ model: IMAGE_GATEWAY_MODEL, prompt: prepared.prompt })
  })

  it('refuses a second confirm while the first request is in flight instead of retrying', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const generate = vi.fn(async (_request, flight: AbortSignal) => {
      await hold
      flight.throwIfAborted()
      return { images: [{ dataUri: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg' }] }
    })
    const turns = createImageTurnController({ generate })
    const plan = planImageIntent('生成一张雨夜赛博城市海报')!
    const first = turns.confirm(plan)
    await expect(turns.confirm(plan)).rejects.toBeInstanceOf(ImageGenerationError)
    expect(generate).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
