import { describe, expect, it } from 'vitest'
import { planImageIntent, readyImagePlan } from '@deepseek-ai/dsh-client-compute-trigger'
import { resolveConversationIntent } from '../src/conversation-intent.ts'

const previous = readyImagePlan(planImageIntent('画一只猫，水彩，16:9')!)
const context = { lastImage: previous, userTurnsSinceImage: 1, imageElapsedMs: 20_000 }
describe('composer conversation intent', () => {
  it('declines unavailable video work without trapping the next text or confusing a video cover with video output', () => {
    expect(resolveConversationIntent('给我生成一个小狗视频', context)).toMatchObject({ route: 'unavailable', capability: 'video' })
    expect(resolveConversationIntent('你好').route).toBe('chat')
    expect(resolveConversationIntent('如何制作视频？').route).toBe('chat')
    expect(resolveConversationIntent('做一张视频封面，小狗主题').route).toBe('image')
  })
  it.each(['取消修图', '不改了', '停止修改'])('cancels an active edit explicitly: %s', (text) => {
    expect(resolveConversationIntent(text, { imageInFlight: true })).toEqual({ route: 'cancel-image' })
  })
  it('keeps praise as chat then makes a new subject without copying the old one', () => {
    expect(resolveConversationIntent('真好看', context)).toEqual({ route: 'chat', clearImageContext: false })
    const follow = resolveConversationIntent('我还想要一个小狗的', context)
    expect(follow.route).toBe('image')
    if (follow.route === 'image') {
      expect(follow.plan.kind).toBe('image.generate')
      expect(follow.plan.prompt).toContain('小狗')
      expect(follow.plan.prompt).toContain('水彩')
      expect(follow.plan.prompt).not.toContain('一只猫')
    }
  })
  it.each(['再来一张', '再要一张', '再生成一张', '换一张', '还想再要一张', '还想再来一张', '真好看，还想再要一张'])('keeps a bare redraw on the image gateway after praise instead of falling through to chat: %s', (text) => {
    const follow = resolveConversationIntent(text, context)
    expect(follow).toMatchObject({ route: 'image', plan: { kind: 'image.generate', stage: 'confirm', prompt: previous.prompt } })
  })
  it.each([
    { ...context, userTurnsSinceImage: 5 },
    { ...context, imageElapsedMs: 600_000 },
    {},
  ])('does not infer an image after the session window has ended: %o', (facts) => {
    expect(resolveConversationIntent('我还想要一个小狗的', facts).route).toBe('chat')
  })
  it('keeps a selected original through the short edit clarification', () => {
    const source = { kind: 'attachment' as const, id: 'original-1' }
    const pending = resolveConversationIntent('修改这张图片', { attachments: [source], attachmentCount: 1 })
    expect(pending.route).toBe('image')
    if (pending.route !== 'image') throw new Error('Expected edit question')
    expect(pending.plan).toMatchObject({ kind: 'image.edit', stage: 'clarify', source })
    const edit = resolveConversationIntent('背景改成蓝色', { pending: pending.plan })
    expect(edit.route).toBe('image')
    if (edit.route === 'image') expect(edit.plan).toMatchObject({ kind: 'image.edit', stage: 'confirm', source })
  })
  it('does not spend an edit call for a visual question', () => {
    expect(resolveConversationIntent('这张图是什么？', { attachments: [{ kind: 'attachment', id: 'original-1' }], attachmentCount: 1 }).route).toBe('chat')
  })
})
