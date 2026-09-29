import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationMarketCall } from '../src/client/conversation-market-store.ts'
import { createConversationMarketTimeline } from '../src/client/conversation-market-timeline.ts'

const first = 'first' as SessionId
const second = 'second' as SessionId
const call: ConversationMarketCall = {
  id: 'market-call-11111111-1111-4111-8111-111111111111', sessionId: first,
  createdAt: '2026-09-26T12:00:00.000Z', goal: '生成图片',
  capability: { taskType: 'image.generate', capabilityId: 'image.generate', name: '出图', category: 'image' },
  continuation: { planId: 'plan', workloadId: null, submission: 'idle' },
}

it('updates a result in place without moving its original timeline position', () => {
  const timeline = createConversationMarketTimeline()
  const positionChanged = vi.fn()
  timeline.provider.subscribe(positionChanged)
  timeline.publish(first, [call])
  const original = timeline.provider.read(first)
  timeline.publish(first, [{ ...call, continuation: { planId: 'plan', workloadId: 'task', submission: 'submitted' } }])
  expect(timeline.provider.read(first)).toBe(original)
  expect(positionChanged).toHaveBeenCalledExactlyOnceWith(first)
  timeline.dispose()
})

it('retires only the departing Session and can restore its committed history', () => {
  const timeline = createConversationMarketTimeline()
  timeline.publish(first, [call])
  const other = { ...call, sessionId: second }
  timeline.publish(second, [other])
  timeline.release(first)
  expect(timeline.provider.read(first)).toEqual([])
  expect(timeline.provider.read(second)).toHaveLength(1)
  timeline.publish(first, [call])
  expect(timeline.provider.read(first)[0]?.createdAt).toBe(Date.parse(call.createdAt))
  timeline.dispose()
})

it('keeps late publication and subscriptions inert after feature unload', () => {
  const timeline = createConversationMarketTimeline()
  timeline.publish(first, [call])
  timeline.dispose()
  const notify = vi.fn()
  timeline.provider.subscribe(notify)
  timeline.publish(first, [call])
  timeline.release(first)
  expect(timeline.provider.read(first)).toEqual([])
  expect(notify).not.toHaveBeenCalled()
})
