/** Fast conversation routing shares the gateway planner; execution still authenticates server-side. */
import {
  decideTrigger, planImageIntent, planImageEditIntent, readyImagePlan, resolveImageFollowUp,
  resolveImageClarification, type ImageIntentPlan, type ImageSourceRef,
} from '@deepseek-ai/dsh-client-compute-trigger'

export type ConversationIntent =
  | { readonly route: 'unavailable'; readonly capability: 'video'; readonly message: string }
  | { readonly route: 'chat'; readonly clearImageContext: boolean }
  | { readonly route: 'cancel-image' }
  | { readonly route: 'image'; readonly plan: ImageIntentPlan }

/** Explicit cancellation also dismisses a selected, unsent original. */
export function isImageCancellation(text: string): boolean {
  return /^(?:取消|停止|停下|算了|不画了|别画了|不改了|别改了)(?:这次|这张|当前|本次)?(?:出图|画图|修图|改图|修改|图片|生成|任务|了)?[。！!\s]*$/u.test(text.trim())
}

/**
 * Classify without a network round trip. Only an unresolved question in this
 * Session can consume a clarification reply; a running/failed job cannot.
 * This decision conveys neither subscription rights nor execution permission.
 */
export function resolveConversationIntent(text: string, context: {
  readonly pending?: ImageIntentPlan
  readonly lastImage?: ImageIntentPlan
  readonly userTurnsSinceImage?: number
  readonly attachmentCount?: number
  readonly imageInFlight?: boolean
  readonly imageElapsedMs?: number
  readonly attachments?: readonly ImageSourceRef[]
  readonly lastImageSource?: ImageSourceRef
} = {}): ConversationIntent {
  const requested = decideTrigger(text)
  if (requested.kind === 'trigger' && requested.draft.output === 'video') {
    return { route: 'unavailable', capability: 'video', message: '视频生成暂未接入，现在还不能直接生成视频。可以先帮你写脚本、分镜或制作封面；也可以继续聊其他内容。' }
  }
  if (context.imageInFlight === true && isImageCancellation(text)) {
    return { route: 'cancel-image' }
  }
  const facts = context.attachmentCount === undefined ? {} : { attachmentCount: context.attachmentCount }
  const editContext = {
    ...facts,
    ...(context.attachments === undefined ? {} : { attachments: context.attachments }),
    ...(context.lastImageSource === undefined ? {} : { lastImage: context.lastImageSource }),
    userTurnsSinceImage: context.userTurnsSinceImage ?? 0,
    elapsedMs: context.imageElapsedMs ?? Number.POSITIVE_INFINITY,
  }
  if (context.pending?.kind === 'image.edit') {
    const plan = resolveImageClarification(context.pending, text, editContext)
    return plan === null ? { route: 'chat', clearImageContext: true } : { route: 'image', plan }
  }
  const edit = planImageEditIntent(text, editContext)
  if (edit !== null) return { route: 'image', plan: edit }
  const followUp = context.pending === undefined ? resolveImageFollowUp(context.lastImage ?? null, text, {
    ...facts, userTurnsSinceImage: context.userTurnsSinceImage ?? 0, elapsedMs: context.imageElapsedMs ?? Number.POSITIVE_INFINITY,
  }) : null
  if (followUp?.kind === 'image') return { route: 'image', plan: followUp.plan }
  if (followUp?.kind === 'chat' && followUp.reason !== 'no-context' && followUp.reason !== 'unmatched') {
    return { route: 'chat', clearImageContext: followUp.context === 'invalidate' }
  }
  const plan = context.pending === undefined
    ? planImageIntent(text, facts)
    : resolveImageClarification(context.pending, text, facts)
  if (plan !== null) return { route: 'image', plan: plan.stage === 'confirm' ? readyImagePlan(plan) : plan }
  return { route: 'chat', clearImageContext: context.pending !== undefined || followUp?.context === 'invalidate' }
}
