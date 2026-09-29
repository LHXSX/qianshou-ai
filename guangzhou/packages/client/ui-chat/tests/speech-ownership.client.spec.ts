import { describe, expect, it, vi } from 'vitest'
import { claimSpeechOutput, subscribeSpeechClaims } from '../src/client/chat/voice/speech-ownership.ts'

describe('exclusive audible output ownership', () => {
  it('contains stale UI failures while replacing an output, and stale release cannot revoke the new one', () => {
    const releaseOld = claimSpeechOutput(() => { throw new Error('disposed view') })
    const stopped = vi.fn(); const guard = vi.fn()
    const unsubscribe = subscribeSpeechClaims(guard)
    const owner = Symbol('capture')
    const releaseNew = claimSpeechOutput(stopped, owner)
    expect(guard).toHaveBeenLastCalledWith(owner)
    releaseOld()
    claimSpeechOutput(() => {})()
    expect(stopped).toHaveBeenCalledOnce()
    releaseNew(); unsubscribe()
  })
})
