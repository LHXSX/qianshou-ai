/** Buyer video planning data. A plan is not an upload, product, quote or order. */
export interface VideoAssetPlanRequest {
  readonly sourceGoal: string
  readonly answers?: Readonly<Partial<Record<'subject' | 'motion' | 'style' | 'purpose' | 'story'
    | 'storyboard' | 'sound' | 'camera' | 'avoid' | 'duration', string>>>
  /** Browser-computed metadata only; no image bytes or store version are implied. */
  readonly selectedFirstFrame?: {
    readonly mimeType: 'image/png' | 'image/jpeg'
    readonly bytes: number
    readonly sha256: string
  }
}

export interface VideoAssetPlan {
  readonly schema: 'qianshou.video-asset-plan.v1'
  readonly sourceGoal: string
  readonly prompt: string
  readonly assetGuidance: string
  readonly requiredAssets: readonly [{
    readonly slot: 'first_frame'
    readonly acceptedMimeTypes: readonly ['image/png', 'image/jpeg']
    readonly maxBytes: 16777216
  }]
  readonly selectedFirstFrame?: NonNullable<VideoAssetPlanRequest['selectedFirstFrame']>
  readonly durationSeconds: 5
  readonly frames: 120
  readonly fps: 24
  readonly modelReceipt: {
    readonly provider: string
    readonly model: string
    readonly sessionId: string
    readonly assistantEventSeq: number
    readonly turnEndEventSeq: number
  }
}
