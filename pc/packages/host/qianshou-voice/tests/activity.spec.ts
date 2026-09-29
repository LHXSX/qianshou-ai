import { describe, expect, it } from 'vitest'
import { VoiceActivityProjection } from '../src/activity.ts'

describe('voice activity projection', () => {
  it('counts simultaneous requests and releases each slot only once', () => {
    const activity = new VoiceActivityProjection()
    expect(activity.active()).toBe(false)
    const releaseAsr = activity.hold()
    const releaseTts = activity.hold()
    expect(activity.active()).toBe(true)
    expect(activity.inFlightCount()).toBe(2)
    releaseAsr()
    releaseAsr()
    expect(activity.inFlightCount()).toBe(1)
    releaseTts()
    expect(activity.active()).toBe(false)
    expect(activity.inFlightCount()).toBe(0)
  })

  it('notifies only idle/busy transitions and stops notifying after unsubscribe', () => {
    const activity = new VoiceActivityProjection()
    const seen: boolean[] = []
    const unsubscribe = activity.subscribe(active => seen.push(active))
    const releaseAsr = activity.hold()
    const releaseTts = activity.hold()
    releaseAsr()
    expect(seen).toEqual([true])
    releaseTts()
    expect(seen).toEqual([true, false])
    unsubscribe()
    activity.hold()()
    expect(seen).toEqual([true, false])
  })
})
