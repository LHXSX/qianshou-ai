/** One buyer-owned model turn that prepares text and an asset checklist for a five-second video.
 * No model output is an image, an installed skill, an upload receipt, a quote, or dispatch consent.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { VideoAssetPlan, VideoAssetPlanRequest } from './reviewed-video-asset-plan-types.ts'
export type { VideoAssetPlan, VideoAssetPlanRequest } from './reviewed-video-asset-plan-types.ts'

const MAX_GOAL_BYTES = 4096
const MAX_ANSWER_BYTES = 1024
const MAX_PROMPT_BYTES = 8192
const MAX_MODEL_BYTES = 16384
const MAX_FRAME_BYTES = 16777216 as const
const ANSWER_KEYS = ['subject', 'motion', 'style', 'purpose', 'story', 'storyboard', 'sound', 'camera', 'avoid', 'duration'] as const

export class VideoAssetPlanFailure extends Error {
  constructor(readonly code: 'VIDEO_ASSET_PLAN_INVALID' | 'VIDEO_ASSET_PLAN_MODEL_UNAVAILABLE'
    | 'VIDEO_ASSET_PLAN_MODEL_INCOMPLETE' | 'VIDEO_ASSET_PLAN_ABORTED') {
    super(code)
    this.name = 'VideoAssetPlanFailure'
  }
}

function invalid(): never { throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_INVALID') }
function textWithin(value: unknown, maxBytes: number, required = true): value is string {
  return typeof value === 'string' && value.isWellFormed()
    && (!required || value.trim().length > 0)
    && new TextEncoder().encode(value).byteLength <= maxBytes
}

function validated(input: VideoAssetPlanRequest): VideoAssetPlanRequest {
  if (input === null || typeof input !== 'object' || !textWithin(input.sourceGoal, MAX_GOAL_BYTES)) invalid()
  const answers = input.answers
  if (answers !== undefined && (answers === null || typeof answers !== 'object' || Array.isArray(answers))) invalid()
  const safeAnswers: Record<string, string> = {}
  if (answers !== undefined) for (const [key, value] of Object.entries(answers)) {
    if (!ANSWER_KEYS.includes(key as (typeof ANSWER_KEYS)[number]) || !textWithin(value, MAX_ANSWER_BYTES, false)) invalid()
    if (value.trim()) safeAnswers[key] = value.trim()
  }
  const frame = input.selectedFirstFrame
  if (frame !== undefined && (frame === null || typeof frame !== 'object'
    || (frame.mimeType !== 'image/png' && frame.mimeType !== 'image/jpeg')
    || !Number.isSafeInteger(frame.bytes) || frame.bytes < 8 || frame.bytes > MAX_FRAME_BYTES
    || !/^[a-f0-9]{64}$/u.test(frame.sha256))) invalid()
  return {
    sourceGoal: input.sourceGoal.trim(),
    ...(Object.keys(safeAnswers).length ? { answers: safeAnswers } : {}),
    ...(frame === undefined ? {} : { selectedFirstFrame: { mimeType: frame.mimeType,
      bytes: frame.bytes, sha256: frame.sha256 } }),
  }
}

const PERSONA = [
  '你是千手买家的五秒单镜视频资产规划助手。只返回一个 JSON 对象，恰好包含 prompt 和 assetGuidance 两个字符串字段。',
  'prompt 是给受审视频技能的中文单镜动作描述，保留用户真实目标与限制；assetGuidance 是给买家的首帧图片准备建议。',
  '只整理文字。你没有看见图片像素；哈希和 MIME 不能证明图片内容。不得声称已上传、已安装、已报价、已付款、已派单、已生成视频或已验片。',
  '固定交付为 5 秒、120 帧、24 fps。用户若要求其他时长或多镜头，不能将其描述为已支持；请在 assetGuidance 明确首轮需缩为一个五秒镜头。',
  '不要输出 Markdown、代码块、除 prompt 和 assetGuidance 之外的对象字段、存储版本、路径、URL 或任何可执行指令。',
].join('\n')

interface ModelSelectionPort { currentSelection(): { provider: string; model: string } }
interface AccountPlanPort { registerVideoAssetPlanSession(sessionId: string): () => void }
interface ScopedPromptPort {
  section(input: { name: string; order: number; text: string }): unknown
  getSectionOrder(name: 'DEPLOYMENT_PERSONA_PREFIX' | 'DEPLOYMENT_PERSONA_SUFFIX'): number
}
interface ScopedToolsPort { restrict(input: { allow: readonly string[] }): unknown }

/** Drive a real, isolated AgentLoop turn on the owner's currently selected model. */
export async function prepareVideoAssetPlan(ctx: Context, request: VideoAssetPlanRequest,
  signal: AbortSignal): Promise<VideoAssetPlan> {
  const input = validated(request)
  if (signal.aborted) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_ABORTED')
  const agents = ctx.get('agents')
  const selection = (ctx.get('agentDefaultModel') as ModelSelectionPort | undefined)?.currentSelection()
  if (agents === undefined || !selection || !selection.provider || !selection.model) {
    throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_UNAVAILABLE')
  }
  const sessionId = SessionId(`qianshou.video-plan.${randomUUID()}`)
  const account = ctx.get('qianshouAccount') as AccountPlanPort | undefined
  if (selection.provider === 'qianshou-cloud' && typeof account?.registerVideoAssetPlanSession !== 'function') {
    throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_UNAVAILABLE')
  }
  let releaseAccountSession: (() => void) | undefined
  let handle: AgentHandle | undefined
  const onAbort = (): void => { handle?.agent.cancel({ kind: 'parent' }) }
  try {
    if (selection.provider === 'qianshou-cloud') {
      if (account === undefined) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_UNAVAILABLE')
      releaseAccountSession = account.registerVideoAssetPlanSession(sessionId)
    }
    handle = await agents.create({
      sessionId,
      agentOptions: { provider: selection.provider, model: selection.model, maxTokens: 2048 },
      signal,
      setup: (agentCtx) => {
        const prompt = agentCtx.get('systemPrompt') as ScopedPromptPort | undefined
        const tools = agentCtx.get('tools') as ScopedToolsPort | undefined
        if (!prompt || !tools) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_UNAVAILABLE')
        prompt.section({ name: 'deployment:persona-prefix',
          order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: PERSONA })
        // This isolated planning Session has no workspace. Shadow the deployment
        // suffix so a global {{cwd}} persona cannot abort the model turn.
        prompt.section({ name: 'deployment:persona-suffix',
          order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: '' })
        // No preset is mounted; this also masks every globally published tool.
        tools.restrict({ allow: [] })
      },
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_ABORTED')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(input) }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    if (signal.aborted) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_ABORTED')
    return parsedPlan(handle.agent.session.snapshotEvents(SessionLogOffset(0)), input, sessionId)
  } catch (error) {
    if (error instanceof VideoAssetPlanFailure) throw error
    throw new VideoAssetPlanFailure(signal.aborted ? 'VIDEO_ASSET_PLAN_ABORTED' : 'VIDEO_ASSET_PLAN_MODEL_UNAVAILABLE')
  } finally {
    signal.removeEventListener('abort', onAbort)
    try { await handle?.dispose() }
    finally { releaseAccountSession?.() }
  }
}

function parsedPlan(events: readonly SessionEvent[], input: VideoAssetPlanRequest, sessionId: string): VideoAssetPlan {
  const ended = events.findLast(event => event.type === 'turn/end')
  const replies = events.filter(event => event.type === 'assistant/message')
  if (ended?.type !== 'turn/end' || ended.data.reason.kind !== 'completed'
    || replies.length !== 1 || events.some(event => event.type === 'tool/result'
      || event.type === 'tool/call')) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE')
  const reply = replies[0]
  if (reply?.type !== 'assistant/message' || reply.data.interrupted
    || reply.data.message.source.kind !== 'model') {
    throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE')
  }
  const content = reply.data.message.content
  const textBlocks = content.filter(block => block.type === 'text')
  // Reasoning models include private reasoning before their visible answer.
  // Accept exactly one visible text block and no other output block types.
  if (textBlocks.length !== 1 || content.some(block => block.type !== 'reasoning' && block.type !== 'text')) {
    throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE')
  }
  const visible = textBlocks[0]
  if (visible === undefined) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE')
  const raw = visible.text.trim()
  if (!textWithin(raw, MAX_MODEL_BYTES)) throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE')
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'assetGuidance,prompt') {
    throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE')
  }
  const plan = value as { prompt?: unknown; assetGuidance?: unknown }
  if (!textWithin(plan.prompt, MAX_PROMPT_BYTES) || !textWithin(plan.assetGuidance, 2048)) {
    throw new VideoAssetPlanFailure('VIDEO_ASSET_PLAN_MODEL_INCOMPLETE')
  }
  return {
    schema: 'qianshou.video-asset-plan.v1',
    sourceGoal: input.sourceGoal,
    prompt: plan.prompt.trim(),
    assetGuidance: plan.assetGuidance.trim(),
    requiredAssets: [{ slot: 'first_frame', acceptedMimeTypes: ['image/png', 'image/jpeg'], maxBytes: MAX_FRAME_BYTES }],
    ...(input.selectedFirstFrame === undefined ? {} : { selectedFirstFrame: input.selectedFirstFrame }),
    durationSeconds: 5, frames: 120, fps: 24,
    modelReceipt: { provider: reply.data.message.source.provider, model: reply.data.message.source.model,
      sessionId, assistantEventSeq: Number(reply.seq), turnEndEventSeq: Number(ended.seq) },
  }
}
