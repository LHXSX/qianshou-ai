import type { VideoCreativeAnswers } from './VideoCreativeBrief.tsx'
import type { VideoImageChoice } from './video-creative-handoff.ts'

const MAX_SOURCE_GOAL_BYTES = 4096
const MAX_ANSWER_BYTES = 1024
const ANSWER_FIELDS = ['subject', 'motion', 'style', 'purpose', 'story', 'storyboard',
  'sound', 'camera', 'avoid', 'duration'] as const

/** Match the Host planner's per-field UTF-8 limits before starting a model turn.
 * @param request - Buyer text and optional answers intended for the Host planner.
 * @returns The first over-limit field, or null when all fields fit.
 */
export function videoAssetPlanInputIssue(request: Parameters<PrepareVideoAssetPlan>[0]):
    { kind: 'goal' } | { kind: 'answer'; field: keyof VideoCreativeAnswers } | null {
  if (!request.sourceGoal.isWellFormed()
    || new TextEncoder().encode(request.sourceGoal).byteLength > MAX_SOURCE_GOAL_BYTES) return { kind: 'goal' }
  for (const field of ANSWER_FIELDS) {
    const answer = request.answers?.[field]
    if (answer !== undefined && (!answer.isWellFormed()
      || new TextEncoder().encode(answer).byteLength > MAX_ANSWER_BYTES)) return { kind: 'answer', field }
  }
  return null
}

/** A completed local AgentLoop response. It prepares buyer assets; it is never a quote or dispatch receipt. */
export interface VideoAssetPlan {
  schema: 'qianshou.video-asset-plan.v1'
  sourceGoal: string
  prompt: string
  assetGuidance: string
  requiredAssets: readonly [{
    slot: 'first_frame'
    acceptedMimeTypes: readonly ['image/png', 'image/jpeg']
    maxBytes: number
  }]
  selectedFirstFrame?: { mimeType: 'image/png' | 'image/jpeg'
    bytes: number
    sha256: string }
  durationSeconds: 5
  frames: 120
  fps: 24
  modelReceipt: { provider: string
    model: string
    sessionId: string
    assistantEventSeq: number
    turnEndEventSeq: number }
}

export interface PrepareVideoAssetPlan {
  (request: { sourceGoal: string
    answers?: VideoCreativeAnswers
    selectedFirstFrame?: Pick<VideoImageChoice, 'mimeType' | 'bytes' | 'sha256'> }): Promise<VideoAssetPlan>
}

export function createVideoAssetPlanPreparer(remote: {
  prepareVideoAssetPlan(request: Parameters<PrepareVideoAssetPlan>[0]): Promise<{
    ok: true
    value: VideoAssetPlan
  } | { ok: false
    error: unknown }>
}): PrepareVideoAssetPlan {
  return async (request) => {
    const issue = videoAssetPlanInputIssue(request)
    if (issue !== null) throw new Error(issue.kind === 'goal'
      ? 'VIDEO_ASSET_PLAN_GOAL_TOO_LONG' : 'VIDEO_ASSET_PLAN_ANSWER_TOO_LONG')
    const response = await remote.prepareVideoAssetPlan(request)
    if (!response.ok) throw new Error('VIDEO_ASSET_PLAN_UNAVAILABLE')
    return response.value
  }
}

/** Keep a stale or malformed Remote response out of the editable buyer plan. */
export function validVideoAssetPlan(value: unknown, sourceGoal: string,
  choice: VideoImageChoice | null): value is VideoAssetPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Partial<VideoAssetPlan>
  const assets = row.requiredAssets
  const receipt = row.modelReceipt
  const frame = row.selectedFirstFrame
  return row.schema === 'qianshou.video-asset-plan.v1' && row.sourceGoal === sourceGoal
    && typeof row.prompt === 'string' && row.prompt.trim().length > 0
    && new TextEncoder().encode(row.prompt).byteLength <= 8192
    && typeof row.assetGuidance === 'string' && row.assetGuidance.length <= 4000
    && Array.isArray(assets) && assets.length === 1 && assets[0]?.slot === 'first_frame'
    && assets[0].maxBytes === 16 * 1024 * 1024
    && JSON.stringify(assets[0].acceptedMimeTypes) === '["image/png","image/jpeg"]'
    && row.durationSeconds === 5 && row.frames === 120 && row.fps === 24
    && receipt !== undefined && receipt !== null
    && typeof receipt === 'object' && typeof receipt.provider === 'string' && receipt.provider.length > 0
    && typeof receipt.model === 'string' && receipt.model.length > 0
    && typeof receipt.sessionId === 'string' && receipt.sessionId.length > 0
    && Number.isSafeInteger(receipt.assistantEventSeq) && Number.isSafeInteger(receipt.turnEndEventSeq)
    && (choice === null ? frame === undefined : frame?.mimeType === choice.mimeType
      && frame.bytes === choice.bytes && frame.sha256 === choice.sha256)
}
