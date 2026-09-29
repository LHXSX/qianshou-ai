import { expect, it } from 'vitest'
import { isMarketTaskDraft } from '../src/client/market-task-draft.ts'

it('restores the complete bounded expert video brief instead of discarding its storyboard and duration', () => {
  const draft = { goal: '海边的小狗奔跑', input: {}, params: {}, videoExpert: true,
    videoAnswers: { subject: '小狗', motion: '追逐', style: '写实',
      story: '先相遇再追逐'.repeat(35), storyboard: '全景、特写、跟拍'.repeat(50),
      camera: '低机位', sound: '海浪', duration: '1 分钟' } }
  expect(isMarketTaskDraft(draft)).toBe(true)
  expect(isMarketTaskDraft({ ...draft, videoAnswers: { ...draft.videoAnswers,
    storyboard: '分镜'.repeat(301) } })).toBe(false)
  expect(isMarketTaskDraft({ ...draft, videoExpert: 'true' })).toBe(false)
})

it('rejects contradictory saved video modes while keeping older videoExpert-only drafts', () => {
  const draft = { goal: '海边小狗奔跑', input: {}, params: {}, videoAnswers: {
    subject: '', motion: '', style: '',
  } }
  expect(isMarketTaskDraft({ ...draft, videoExpert: true })).toBe(true)
  expect(isMarketTaskDraft({ ...draft, videoExpert: false })).toBe(true)
  expect(isMarketTaskDraft({ ...draft, videoMode: 'expert', videoExpert: true })).toBe(true)
  expect(isMarketTaskDraft({ ...draft, videoMode: 'simple', videoExpert: false })).toBe(true)
  expect(isMarketTaskDraft({ ...draft, videoMode: 'expert', videoExpert: false })).toBe(false)
  expect(isMarketTaskDraft({ ...draft, videoMode: 'simple', videoExpert: true })).toBe(false)
})
