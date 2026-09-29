/** System speech protocol tests use a silent fake engine, not real audio output. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SystemSpeech, spokenText } from '../src/client/speech.ts'

afterEach(() => vi.useRealTimers())
const owner = { sessionId: 'one' as SessionId, messageId: 'answer-one' }
const voice = (localService = true): SpeechSynthesisVoice => ({ name: 'Fixture', lang: 'zh-CN', localService }) as SpeechSynthesisVoice
function setup(voices: SpeechSynthesisVoice[] = []) {
  const events = new EventTarget()
  const current = { voices }
  const utterances: SpeechSynthesisUtterance[] = []
  const engine = { getVoices: () => current.voices, speak: vi.fn(), cancel: vi.fn(),
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) }
  const speech = new SystemSpeech(engine as unknown as SpeechSynthesis, (text) => {
    const utterance = { text, onstart: null, onend: null, onerror: null } as unknown as SpeechSynthesisUtterance
    utterances.push(utterance); return utterance
  })
  return { speech, engine, utterances, load: (next: SpeechSynthesisVoice[]) => { current.voices = next; events.dispatchEvent(new Event('voiceschanged')) } }
}
describe('local system narration', () => {
  it('waits for asynchronous voices and never selects a remote-only or absent voice', () => {
    vi.useFakeTimers(); const b = setup()
    expect(b.speech.store.getSnapshot().loading).toBe(true); expect(b.speech.available('zh-CN')).toBe(false)
    b.load([voice(false)]); expect(b.speech.speak(owner, '你好', 'zh-CN')).toBe(false); expect(b.engine.speak).not.toHaveBeenCalled()
    b.load([voice()]); expect(b.speech.available('zh-CN')).toBe(true)
    expect(b.speech.speak(owner, '你好', 'zh-CN')).toBe(true)
    expect(b.utterances[0]?.voice?.localService).toBe(true); b.speech.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it('only claims playing after onstart, and stop prevents late completion from advancing', () => {
    vi.useFakeTimers(); const b = setup([voice()]); b.speech.speak(owner, 'a'.repeat(400), 'zh-CN')
    expect(b.speech.store.getSnapshot().active?.phase).toBe('starting')
    const utterance = b.utterances[0]!; const late = utterance.onend
    utterance.onstart?.call(utterance, {} as SpeechSynthesisEvent)
    expect(b.speech.store.getSnapshot().active?.phase).toBe('playing')
    b.speech.stop(); late?.call(utterance, {} as SpeechSynthesisEvent)
    expect(b.engine.speak).toHaveBeenCalledOnce(); expect(b.speech.store.getSnapshot().active).toBeNull()
    b.speech.dispose(); expect(vi.getTimerCount()).toBe(0)
  })
  it('supersedes old output without allowing the old view release to cancel its successor', () => {
    vi.useFakeTimers(); const b = setup([voice()]); b.speech.speak(owner, '第一条', 'zh-CN')
    const next = { sessionId: 'two' as SessionId, messageId: 'answer-two' }
    b.speech.speak(next, '第二条', 'zh-CN'); b.speech.release(owner)
    expect(b.speech.store.getSnapshot().active).toMatchObject(next); expect(b.engine.cancel).toHaveBeenCalledOnce()
    b.speech.release(next); expect(b.engine.cancel).toHaveBeenCalledTimes(2); b.speech.dispose()
  })
  it('ends a stalled utterance and reports an error rather than a completed playback', () => {
    vi.useFakeTimers(); const b = setup([voice()]); b.speech.speak(owner, '你好', 'zh-CN')
    vi.advanceTimersByTime(8000)
    expect(b.speech.store.getSnapshot()).toMatchObject({ active: null, failed: owner })
    expect(b.engine.cancel).toHaveBeenCalledOnce(); b.speech.dispose()
  })
  it('removes code fences and image URLs from narration', () => {
    expect(spokenText('# 回答\n```js\nsecret()\n```\n[正文](https://example.com) ![图](image.png)')).toBe('回答\n\n正文')
  })
})
