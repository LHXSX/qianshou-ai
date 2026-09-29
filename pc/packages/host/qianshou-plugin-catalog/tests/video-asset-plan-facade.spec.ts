import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Catalog from '../src/index.ts'
import type { BuyerVideoAssetPlan, BuyerVideoAssetPlanRequest } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

async function catalog() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: '', publisherKeys: {} })
  return ctx
}

it('uses the product Remote to prepare assets without a market listing or a quote', async () => {
  const ctx = await catalog()
  const plan: BuyerVideoAssetPlan = { schema: 'qianshou.video-asset-plan.v1', sourceGoal: '小猫向前走',
    prompt: '小猫缓慢向前走', assetGuidance: '选择小猫的 PNG 首帧',
    requiredAssets: [{ slot: 'first_frame', acceptedMimeTypes: ['image/png', 'image/jpeg'], maxBytes: 16777216 }],
    durationSeconds: 5, frames: 120, fps: 24,
    modelReceipt: { provider: 'p', model: 'm', sessionId: 's', assistantEventSeq: 3, turnEndEventSeq: 5 } }
  const prepare = vi.fn(async (_request: BuyerVideoAssetPlanRequest, _signal: AbortSignal) => plan)
  ctx.provide('nodeContributor', { prepareVideoAssetPlan: prepare })
  const request = { sourceGoal: '小猫向前走' }
  await expect(ctx.qianshouPluginCatalog.prepareVideoAssetPlan(request)).resolves.toEqual(plan)
  expect(prepare).toHaveBeenCalledOnce()
  expect(prepare.mock.calls[0]?.[0]).toEqual(request)
  expect(prepare.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
})

it('fails closed when the local buyer planner is not mounted', async () => {
  const ctx = await catalog()
  await expect(ctx.qianshouPluginCatalog.prepareVideoAssetPlan({ sourceGoal: '小猫向前走' }))
    .rejects.toThrow('unavailable')
})
