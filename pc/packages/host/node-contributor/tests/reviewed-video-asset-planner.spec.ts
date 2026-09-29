import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { prepareVideoAssetPlan, type VideoAssetPlanRequest } from '../src/reviewed-video-asset-planner.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

class SelectedModel extends Service {
  constructor(ctx: Context, private readonly provider: string) { super(ctx, 'agentDefaultModel') }
  currentSelection() { return { provider: this.provider, model: 'buyer-model' } }
}

async function host(adapter: MockAdapter, provider = 'buyer-model-provider', personaSuffix = '') {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaSuffix } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SelectedModel, provider)
  ctx.llm.registerAdapter([provider], adapter)
  return ctx
}

const request: VideoAssetPlanRequest = { sourceGoal: '让小猫向镜头走来', answers: { style: '写实' },
  selectedFirstFrame: { mimeType: 'image/png', bytes: 4096, sha256: 'a'.repeat(64) } }

function reasonedResponse(...texts: string[]): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '整理用户目标' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '整理用户目标' } },
  ]
  for (const [offset, text] of texts.entries()) {
    const index = offset + 1
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 50 } },
    { type: 'finish', reason: { kind: 'stop' } },
  )
  return chunks
}

describe('buyer video asset planning on the real AgentLoop', () => {
  it('returns only model-backed text and a fixed local asset checklist', async () => {
    const adapter = new MockAdapter([textResponse(JSON.stringify({
      prompt: '写实小猫从首帧位置缓慢走向镜头，单镜头连续运动。',
      assetGuidance: '请选择小猫主体清晰的 PNG 首帧。',
    }))])
    const ctx = await host(adapter)
    const result = await prepareVideoAssetPlan(ctx, request, new AbortController().signal)
    expect(result).toMatchObject({ schema: 'qianshou.video-asset-plan.v1', sourceGoal: request.sourceGoal,
      prompt: '写实小猫从首帧位置缓慢走向镜头，单镜头连续运动。',
      selectedFirstFrame: request.selectedFirstFrame, durationSeconds: 5, frames: 120, fps: 24,
      requiredAssets: [{ slot: 'first_frame', maxBytes: 16777216 }],
      modelReceipt: { provider: 'buyer-model-provider', model: 'buyer-model' } })
    expect(result.modelReceipt.sessionId).toMatch(/^qianshou\.video-plan\./u)
    expect(result.modelReceipt.turnEndEventSeq).toBeGreaterThan(result.modelReceipt.assistantEventSeq)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools ?? []).toHaveLength(0)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('让小猫向镜头走来')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('五秒单镜视频资产规划助手')
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('plans before any image is chosen and does not invent image or upload evidence', async () => {
    const ctx = await host(new MockAdapter([textResponse(JSON.stringify({
      prompt: '小猫缓慢走向镜头，保持一个连续镜头。', assetGuidance: '请先选一张主体清楚的 PNG 或 JPEG 首帧。',
    }))]))
    const result = await prepareVideoAssetPlan(ctx, { sourceGoal: '小猫走向镜头' }, new AbortController().signal)
    expect(result.requiredAssets[0].slot).toBe('first_frame')
    expect(result).not.toHaveProperty('selectedFirstFrame')
    expect(JSON.stringify(result)).not.toContain('objectVersionId')
    expect(result.modelReceipt.assistantEventSeq).toBeGreaterThan(0)
  })

  it('shadows a deployment suffix requiring cwd in the workspace-free planning session', async () => {
    const adapter = new MockAdapter([textResponse(JSON.stringify({
      prompt: '橘猫在雨中打伞，单镜头连续运动。', assetGuidance: '请选择橘猫与雨伞清晰可见的首帧。',
    }))])
    const ctx = await host(adapter, 'buyer-model-provider', 'UNWANTED_GLOBAL_SUFFIX {{cwd}}')
    const result = await prepareVideoAssetPlan(ctx,
      { sourceGoal: '一只橘猫在雨中打伞，五秒单镜' }, new AbortController().signal)
    expect(result.prompt).toContain('橘猫在雨中打伞')
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('UNWANTED_GLOBAL_SUFFIX')
    expect(adapter.requests[0]?.tools ?? []).toHaveLength(0)
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('accepts one strict JSON answer after a private reasoning block', async () => {
    const ctx = await host(new MockAdapter([reasonedResponse(JSON.stringify({
      prompt: '橘猫在雨中打伞，单镜头连续运动。', assetGuidance: '请选择橘猫与雨伞清晰可见的首帧。',
    }))]))
    const result = await prepareVideoAssetPlan(ctx,
      { sourceGoal: '一只橘猫在雨中打伞，五秒单镜' }, new AbortController().signal)
    expect(result.prompt).toBe('橘猫在雨中打伞，单镜头连续运动。')
    expect(result.modelReceipt.assistantEventSeq).toBeGreaterThan(0)
    expect(result.modelReceipt.turnEndEventSeq).toBeGreaterThan(result.modelReceipt.assistantEventSeq)
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it.each([
    ['plain answer', textResponse('可以的，我会出视频。')],
    ['max tokens', maxTokensResponse('{"prompt":"ok"')],
    ['fabricated object receipt', textResponse(JSON.stringify({ prompt: '小猫运动', assetGuidance: '选首帧', objectVersionId: 'v1' }))],
    ['multiple visible answers', reasonedResponse(
      JSON.stringify({ prompt: '小猫运动', assetGuidance: '选首帧' }),
      JSON.stringify({ prompt: '另一方案', assetGuidance: '选首帧' }))],
    ['reasoning without visible answer', reasonedResponse()],
  ])('rejects %s without an AI plan receipt', async (_label, response) => {
    const ctx = await host(new MockAdapter([response]))
    await expect(prepareVideoAssetPlan(ctx, request, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VIDEO_ASSET_PLAN_MODEL_INCOMPLETE' })
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('requires the account intent bypass port for the qianshou-cloud route', async () => {
    const ctx = await host(new MockAdapter([textResponse('{}')]), 'qianshou-cloud')
    await expect(prepareVideoAssetPlan(ctx, request, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VIDEO_ASSET_PLAN_MODEL_UNAVAILABLE' })
    expect(ctx.agents.list()).toHaveLength(0)
  })

  it('rejects unverified image summaries before starting a model call', async () => {
    const adapter = new MockAdapter([textResponse('{}')])
    const ctx = await host(adapter)
    await expect(prepareVideoAssetPlan(ctx, { ...request,
      selectedFirstFrame: { ...request.selectedFirstFrame!, sha256: 'not-a-digest' },
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_ASSET_PLAN_INVALID' })
    expect(adapter.requests).toHaveLength(0)
  })
})
