// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { ReadAloud } from '../src/client/chat/voice/ReadAloud.tsx'
import { claimSpeechOutput } from '../src/client/chat/voice/speech-ownership.ts'
import { speechChunks } from '../src/client/chat/voice/speech-chunks.ts'
import { VOICE_STORAGE_KEY, PLAYBACK_VOICE_STORAGE_KEY } from '../src/client/chat/voice/voice-catalog.ts'
import { speakReply } from '../src/client/chat/voice/speech.ts'
import { startSpeechPlayback, subscribeSpeechPlayback, type SpeechPlaybackEvent } from '../src/client/chat/voice/speech-playback.ts'

const FIRST = '这是第一段完整的答复。'
const SECOND = '这是第二段完整的答复。'
const TEST_VOICE = { name: 'Tingting', lang: 'zh-CN', voiceURI: 'tingting', localService: true, default: true }
const spoken: SpeechSynthesisUtterance[] = []
const cancel = vi.fn()
const request = vi.fn<typeof fetch>()
const media: TestAudio[] = []
const revoke = vi.fn()
class TestAudio {
  onplaying: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  pause = vi.fn()
  load = vi.fn()
  removeAttribute = vi.fn()
  play = vi.fn(async () => {})
  constructor(readonly src: string) { media.push(this) }
}
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear(); spoken.length = 0; media.length = 0; cancel.mockClear(); revoke.mockClear(); vi.useFakeTimers()
  request.mockReset().mockImplementation(async () => Response.json({ available: false }))
  vi.stubGlobal('fetch', request)
  vi.stubGlobal('Audio', TestAudio)
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:local-speech')
    static override revokeObjectURL = revoke
  })
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} })
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance), cancel, getVoices: () => [TEST_VOICE] } })
})
afterEach(() => { cleanup(); claimSpeechOutput(() => {})(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('bounded speech passages', () => {
  it('keeps a useful first sentence short and merges later sentences without changing text or Unicode', () => {
    const text = FIRST + '后续小句。'.repeat(32) + '🙂'.repeat(160)
    const chunks = speechChunks(text)
    expect(chunks[0]).toBe(FIRST)
    expect(chunks.join('')).toBe(text)
    expect(Array.from(chunks[0]!).length).toBeLessThanOrEqual(48)
    for (const chunk of chunks.slice(1)) expect(Array.from(chunk).length).toBeLessThanOrEqual(120)
    expect(chunks.length).toBeLessThan(10)
    expect(speechChunks('好。可以。现在就开始。')[0]).toBe('好。可以。现在就开始。')
  })
})

describe('assistant speech playback', () => {
  it('reports a synchronous speech engine failure without throwing or queuing later chunks', async () => {
    const done = vi.fn(); const fail = vi.fn()
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel, speak: () => { throw new Error('speech engine unavailable') },
    } })
    const stop = speakReply('这是一段回复。'.repeat(50), 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(fail).toHaveBeenCalledOnce() })
    expect(done).not.toHaveBeenCalled()
    expect(() => { stop(); vi.runAllTimers() }).not.toThrow()
    expect(fail).toHaveBeenCalledOnce()
  })
  it('chunks long answers, completes once, and never queues another chunk after cancel', async () => {
    const done = vi.fn(); const fail = vi.fn()
    const stop = speakReply('中文内容。'.repeat(80), 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(spoken).toHaveLength(1) })
    expect(spoken[0]?.text.length).toBeLessThanOrEqual(151)
    spoken[0]?.onend?.({} as SpeechSynthesisEvent)
    stop(); vi.runAllTimers()
    expect(spoken).toHaveLength(1)
    expect(done).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })
  it('detaches system speech callbacks and ignores saved events after interruption', async () => {
    const done = vi.fn(); const fail = vi.fn()
    const stop = speakReply('第一段回复。'.repeat(60), 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(spoken).toHaveLength(1) })
    const utterance = spoken[0]!
    const ended = utterance.onend; const failed = utterance.onerror; const started = utterance.onstart
    stop()
    expect(utterance.onstart).toBeNull(); expect(utterance.onend).toBeNull(); expect(utterance.onerror).toBeNull()
    started?.call(utterance, {} as SpeechSynthesisEvent)
    ended?.call(utterance, {} as SpeechSynthesisEvent)
    failed?.call(utterance, {} as SpeechSynthesisErrorEvent)
    vi.runAllTimers()
    expect(spoken).toHaveLength(1)
    expect(done).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalled()
  })
  it('pins one system voice even if the browser voice inventory changes between sentences', async () => {
    const initial = { ...TEST_VOICE, name: 'Initial Chinese', voiceURI: 'initial' }
    const getVoices = vi.fn().mockReturnValueOnce([initial]).mockReturnValue([TEST_VOICE])
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance), cancel, getVoices,
    } })
    speakReply(FIRST + SECOND, 'zh-CN', vi.fn(), vi.fn())
    await vi.waitFor(() => { expect(spoken).toHaveLength(1) })
    spoken[0]?.onend?.({} as SpeechSynthesisEvent)
    await vi.advanceTimersByTimeAsync(80)
    expect(spoken).toHaveLength(2)
    expect(spoken.map(value => value.voice)).toEqual([initial, initial])
    expect(getVoices).toHaveBeenCalledOnce()
  })

  it('waits briefly for a delayed system inventory and fixes the announced voice before playback', async () => {
    let ready = false
    const target = new EventTarget()
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance), cancel,
      getVoices: () => ready ? [TEST_VOICE] : [],
      addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target),
    } })
    speakReply(FIRST + SECOND, 'zh-CN', vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(200)
    expect(spoken).toHaveLength(0)
    ready = true; target.dispatchEvent(new Event('voiceschanged'))
    await vi.advanceTimersByTimeAsync(0)
    expect(spoken[0]?.voice).toBe(TEST_VOICE)
  })

  it('uses one system utterance if no explicit voice arrives within the bounded wait', async () => {
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance), cancel, getVoices: () => [],
      addEventListener() {}, removeEventListener() {},
    } })
    const done = vi.fn()
    speakReply(FIRST.repeat(12), 'zh-CN', done, vi.fn())
    await vi.advanceTimersByTimeAsync(700)
    expect(spoken).toHaveLength(1); expect(spoken[0]?.text).toBe(FIRST.repeat(12))
    spoken[0]?.onend?.({} as SpeechSynthesisEvent)
    await vi.advanceTimersByTimeAsync(80)
    expect(spoken).toHaveLength(1); expect(done).toHaveBeenCalledOnce()
  })

  it('lets the user start and stop a finalized reply and cancels on unmount', async () => {
    const view = render(<ReadAloud text="已完成测试。" t={makeTranslate(zh, commonZh)} />)
    expect(spoken).toHaveLength(0)
    fireEvent.click(view.getByRole('button', { name: '朗读回复' }))
    await act(async () => { await vi.waitFor(() => { expect(spoken[0]?.text).toBe('已完成测试。') }) })
    expect(view.getByRole('button', { name: '停止朗读' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '停止朗读' }))
    expect(view.getByRole('button', { name: '朗读回复' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '朗读回复' }))
    await act(async () => { await vi.waitFor(() => { expect(spoken).toHaveLength(2) }) })
    act(() => { spoken.at(-1)?.onerror?.({} as SpeechSynthesisErrorEvent) })
    expect(view.getByRole('button', { name: zh['voice.speechFailed'] })).toBeTruthy()
    view.unmount()
    expect(cancel).toHaveBeenCalled()
  })
})

const available = () => Response.json({ available: true, engine: 'qwen3-tts', defaultSpeaker: 'Vivian' })
function wavResponse() {
  const bytes = new Uint8Array(2444)
  const writer = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('RIFF'), 0); writer.setUint32(4, bytes.length - 8, true)
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8); writer.setUint32(16, 16, true)
  writer.setUint16(20, 1, true); writer.setUint16(22, 1, true); writer.setUint32(24, 24000, true)
  writer.setUint32(28, 48000, true); writer.setUint16(32, 2, true); writer.setUint16(34, 16, true)
  bytes.set(new TextEncoder().encode('data'), 36); writer.setUint32(40, bytes.length - 44, true)
  return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } })
}

describe('local neural reply playback', () => {
  it('uses actual WAV responses in sequence and releases every object URL', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const done = vi.fn(); const fail = vi.fn()
    speakReply(FIRST + SECOND, 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(media).toHaveLength(1) })
    expect(request).toHaveBeenCalledTimes(2)
    const body = request.mock.calls[1]?.[1]?.body
    expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({ text: FIRST, speaker: 'Vivian' })
    expect(request.mock.calls[1]?.[1]?.credentials).toBe('same-origin')
    expect(spoken).toHaveLength(0)
    media[0]?.onended?.()
    await vi.waitFor(() => { expect(media).toHaveLength(2) })
    expect(revoke).toHaveBeenCalledTimes(1)
    media[1]?.onended?.()
    expect(done).toHaveBeenCalledOnce()
    expect(fail).not.toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  it('prepares at most one successor while the current audio is playing', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const stop = speakReply(FIRST + '甲'.repeat(100) + '。' + '乙'.repeat(100) + '。', 'zh-CN', vi.fn(), vi.fn(), 'Serena')
    await vi.waitFor(() => { expect(media).toHaveLength(1) })
    expect(request).toHaveBeenCalledTimes(2)
    media[0]?.onplaying?.()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    await vi.advanceTimersByTimeAsync(0)
    expect(media).toHaveLength(1)
    media[0]?.onended?.()
    await vi.waitFor(() => { expect(media).toHaveLength(2) })
    expect(request).toHaveBeenCalledTimes(3)
    media[1]?.onplaying?.()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(4) })
    const bodies = request.mock.calls.slice(1).map(([, options]) => options?.body)
    expect(bodies.every(body => typeof body === 'string' && body.includes('\"speaker\":\"Serena\"'))).toBe(true)
    stop()
  })

  it('aborts a prefetched successor and cannot play it after a late response or saved end event', async () => {
    let resolveNext!: (response: Response) => void
    request.mockResolvedValueOnce(available()).mockResolvedValueOnce(wavResponse())
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveNext = resolve }))
    const done = vi.fn(); const failed = vi.fn()
    const stop = speakReply(FIRST + SECOND, 'zh-CN', done, failed)
    await vi.waitFor(() => { expect(media).toHaveLength(1) })
    media[0]?.onplaying?.()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    const ended = media[0]?.onended
    stop(); expect(request.mock.calls[2]?.[1]?.signal?.aborted).toBe(true)
    resolveNext(wavResponse()); ended?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(media).toHaveLength(1); expect(done).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled()
  })

  it('gives a new read-aloud exclusive audio and returns the previous button to idle', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const view = render(<><ReadAloud text={FIRST} t={makeTranslate(zh, commonZh)} />
      <ReadAloud text={SECOND} t={makeTranslate(zh, commonZh)} /></>)
    fireEvent.click(view.getAllByRole('button', { name: '朗读回复' })[0]!)
    await act(async () => { await vi.waitFor(() => { expect(media).toHaveLength(1) }) })
    fireEvent.click(view.getByRole('button', { name: '朗读回复' }))
    await act(async () => { await vi.waitFor(() => { expect(media).toHaveLength(2) }) })
    expect(media[0]?.pause).toHaveBeenCalledOnce()
    expect(view.getAllByRole('button', { name: '停止朗读' })).toHaveLength(1)
    expect(view.getAllByRole('button', { name: '朗读回复' })).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: '停止朗读' }))
    expect(media[1]?.pause).toHaveBeenCalledOnce()
    expect(view.getAllByRole('button', { name: '朗读回复' })).toHaveLength(2)
  })

  it('notifies a replaced automatic reply without completing or replaying its pending queue', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const done = vi.fn(); const failed = vi.fn(); const replaced = vi.fn()
    speakReply(FIRST + SECOND, 'zh-CN', done, failed, 'Vivian', replaced)
    await vi.waitFor(() => { expect(media).toHaveLength(1) })
    media[0]?.onplaying?.()
    const stopNew = speakReply('由另一入口朗读。', 'zh-CN', vi.fn(), vi.fn(), 'Serena')
    await vi.waitFor(() => { expect(media).toHaveLength(2) })
    expect(replaced).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled()
    expect(media[0]?.pause).toHaveBeenCalledOnce()
    stopNew()
  })

  it('uses the remembered speaker for manual read-aloud as well as automatic replies', async () => {
    localStorage.setItem(VOICE_STORAGE_KEY, 'Serena')
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const view = render(<ReadAloud text={FIRST} t={makeTranslate(zh, commonZh)} />)
    fireEvent.click(view.getByRole('button', { name: '朗读回复' }))
    await act(async () => { await vi.waitFor(() => { expect(media).toHaveLength(1) }) })
    expect(request.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ text: FIRST, speaker: 'Serena' }))
  })

  it('keeps the first audible neural identity across read-aloud entries and a later status outage', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status'
      ? Response.json({ available: true, defaultSpeaker: 'Serena' }) : wavResponse())
    speakReply(FIRST, 'zh-CN', vi.fn(), vi.fn())
    await vi.waitFor(() => { expect(media).toHaveLength(1) })
    expect(sessionStorage.getItem(PLAYBACK_VOICE_STORAGE_KEY)).toBeNull()
    media[0]?.onplaying?.(); media[0]?.onended?.()
    expect(sessionStorage.getItem(PLAYBACK_VOICE_STORAGE_KEY)).toBe('Serena')
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const view = render(<ReadAloud text={SECOND} t={makeTranslate(zh, commonZh)} />)
    fireEvent.click(view.getByRole('button', { name: '朗读回复' }))
    await act(async () => { await vi.waitFor(() => { expect(media).toHaveLength(2) }) })
    expect(request.mock.calls.at(-1)?.[1]?.body).toBe(JSON.stringify({ text: SECOND, speaker: 'Serena' }))
    act(() => { media[1]?.onended?.() })
    request.mockResolvedValue(Response.json({ available: false }))
    const failed = vi.fn()
    speakReply('不会换成另一种声音。', 'zh-CN', vi.fn(), failed)
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    expect(spoken).toHaveLength(0)
  })

  it('does not remember a prepared voice cancelled before audible playback', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const stop = speakReply(FIRST, 'zh-CN', vi.fn(), vi.fn(), 'Serena')
    await vi.waitFor(() => { expect(media).toHaveLength(1) })
    const latePlaying = media[0]?.onplaying
    stop(); latePlaying?.()
    expect(sessionStorage.getItem(PLAYBACK_VOICE_STORAGE_KEY)).toBeNull()
  })

  it.each([false, 404])('uses a system voice only for explicit unavailability: %s', async (unavailable) => {
    request.mockResolvedValue(unavailable === 404 ? new Response(null, { status: 404 }) : Response.json({ available: false }))
    const done = vi.fn(); const fail = vi.fn()
    speakReply('你好。', 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(spoken).toHaveLength(1) })
    expect(request).toHaveBeenCalledOnce()
    expect(media).toHaveLength(0)
  })

  it.each([false, 404])('keeps an explicitly selected neural identity when its engine is unavailable: %s', async (unavailable) => {
    request.mockResolvedValue(unavailable === 404 ? new Response(null, { status: 404 }) : Response.json({ available: false }))
    const failed = vi.fn()
    speakReply('保持同一个人说话。', 'zh-CN', vi.fn(), failed, 'Serena')
    await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    expect(spoken).toHaveLength(0)
    expect(media).toHaveLength(0)
  })

  it.each([401, 403, 500])('reports authentication and status errors without fallback: %s', async (status) => {
    request.mockResolvedValue(new Response(null, { status }))
    const fail = vi.fn()
    speakReply('你好。', 'zh-CN', vi.fn(), fail)
    await vi.waitFor(() => { expect(fail).toHaveBeenCalledOnce() })
    expect(spoken).toHaveLength(0)
    expect(media).toHaveLength(0)
  })

  it('reports an actual neural failure instead of playing a system voice', async () => {
    request.mockResolvedValueOnce(available()).mockResolvedValueOnce(Response.json({ error: 'SYNTHESIS_FAILED' }, { status: 500 }))
    const fail = vi.fn()
    speakReply('你好。', 'zh-CN', vi.fn(), fail)
    await vi.waitFor(() => { expect(fail).toHaveBeenCalledOnce() })
    expect(spoken).toHaveLength(0)
    expect(media).toHaveLength(0)
  })

  it('does not synthesize or play after cancellation during the status request', async () => {
    let resolve!: (response: Response) => void
    request.mockReturnValue(new Promise<Response>((done) => { resolve = done }))
    const done = vi.fn(); const fail = vi.fn()
    const stop = speakReply('你好。', 'zh-CN', done, fail)
    stop(); resolve(available())
    await Promise.resolve(); await Promise.resolve()
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(request).toHaveBeenCalledOnce()
    expect(media).toHaveLength(0)
    expect(done).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled()
  })

  it('aborts in-flight synthesis and ignores a late successful WAV', async () => {
    let resolve!: (response: Response) => void
    request.mockResolvedValueOnce(available()).mockReturnValueOnce(new Promise<Response>((done) => { resolve = done }))
    const done = vi.fn(); const fail = vi.fn()
    const stop = speakReply('你好。', 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    stop(); resolve(wavResponse())
    await Promise.resolve(); await Promise.resolve()
    expect(request.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
    expect(media).toHaveLength(0)
    expect(done).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled()
  })

  it('stops active playback and prevents stale ended events from playing another sentence', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const done = vi.fn(); const fail = vi.fn()
    const stop = speakReply(FIRST + SECOND, 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(media).toHaveLength(1) })
    const ended = media[0]?.onended
    stop(); stop(); ended?.()
    expect(media[0]?.pause).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
    expect(done).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled()
  })

  it('rejects an invalid audio response without creating a media player', async () => {
    request.mockResolvedValueOnce(available()).mockResolvedValueOnce(new Response('not a WAV', { headers: { 'Content-Type': 'audio/wav' } }))
    const fail = vi.fn()
    speakReply('你好。', 'zh-CN', vi.fn(), fail)
    await vi.waitFor(() => { expect(fail).toHaveBeenCalledOnce() })
    expect(media).toHaveLength(0)
    expect(spoken).toHaveLength(0)
  })

  it('times out a stuck status request and cancels its transport', async () => {
    request.mockReturnValue(new Promise<Response>(() => {}))
    const fail = vi.fn()
    speakReply('你好。', 'zh-CN', vi.fn(), fail)
    vi.advanceTimersByTime(30_000)
    expect(fail).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(spoken).toHaveLength(0)
  })

  it('prefers Chinese Tingting when the local neural model is unavailable', async () => {
    const voices = [
      { name: 'Other Chinese', lang: 'zh-CN', voiceURI: 'other', localService: true, default: true },
      { name: 'Tingting', lang: 'zh-CN', voiceURI: 'tingting', localService: true, default: false },
    ]
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance), cancel, getVoices: () => voices,
    } })
    speakReply('你好。', 'zh-CN', vi.fn(), vi.fn())
    await vi.waitFor(() => { expect(spoken).toHaveLength(1) })
    expect(spoken[0]?.voice?.name).toBe('Tingting')
  })

  it('cancels a stalled WAV body without waiting for its carrier cancellation callback', async () => {
    const cancelBody = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>({ cancel: cancelBody })
    request.mockResolvedValueOnce(available()).mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'audio/wav' } }))
    const done = vi.fn(); const fail = vi.fn()
    const stop = speakReply('你好。', 'zh-CN', done, fail)
    await vi.waitFor(() => { expect(body.locked).toBe(true) })
    stop()
    await vi.waitFor(() => { expect(cancelBody).toHaveBeenCalledOnce() })
    expect(media).toHaveLength(0)
    expect(done).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled()
  })

  it('reports rejected media playback and releases its URL without system fallback', async () => {
    vi.stubGlobal('Audio', class extends TestAudio {
      override play = vi.fn(async () => { throw new Error('autoplay rejected') })
    })
    request.mockResolvedValueOnce(available()).mockResolvedValueOnce(wavResponse())
    const fail = vi.fn()
    speakReply('你好。', 'zh-CN', vi.fn(), fail)
    await vi.waitFor(() => { expect(fail).toHaveBeenCalledOnce() })
    expect(revoke).toHaveBeenCalledOnce()
    expect(media[0]?.pause).toHaveBeenCalledOnce()
    expect(spoken).toHaveLength(0)
  })
})


describe('read-only speech playback observations', () => {
  it('emits actual neural playback with WAV data, and cannot restart from stale playing or ended callbacks', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/tts/status' ? available() : wavResponse())
    const events: SpeechPlaybackEvent[] = []
    const unsubscribe = subscribeSpeechPlayback((event) => { events.push(event) })
    try {
      const stop = speakReply(FIRST + SECOND, 'zh-CN', vi.fn(), vi.fn())
      await vi.waitFor(() => { expect(media).toHaveLength(1) })
      expect(events).toEqual([])
      const playing = media[0]!.onplaying; const ended = media[0]!.onended
      playing?.(); playing?.()
      expect(events).toHaveLength(1)
      const start = events[0]!
      expect(start.type).toBe('start')
      if (start.type !== 'start' || start.source !== 'neural') throw new Error('expected neural start')
      expect(start.element).toBe(media[0]); expect(start.wav.byteLength).toBe(2444)
      expect(new TextDecoder().decode(new Uint8Array(start.wav, 0, 4))).toBe('RIFF')
      ended?.()
      await vi.waitFor(() => { expect(media).toHaveLength(2) })
      media[1]!.onplaying?.()
      const second = events[2]!
      expect(second.type).toBe('start'); expect(second.playbackId).not.toBe(start.playbackId)
      stop(); stop(); playing?.(); ended?.()
      expect(events.map(event => event.type)).toEqual(['start', 'end', 'start', 'cancel'])
      expect(events[1]!.playbackId).toBe(start.playbackId)
      expect(events[3]!.playbackId).toBe(second.playbackId)
      expect(media[1]!.onplaying).toBeNull()
    } finally { unsubscribe() }
  })

  it('replays the latest active start to a newly mounted visual, and ignores older terminal identities', () => {
    const firstEnd = startSpeechPlayback({ source: 'system' })
    const secondEnd = startSpeechPlayback({ source: 'system' })
    firstEnd('cancel')
    const events: SpeechPlaybackEvent[] = []
    const unsubscribe = subscribeSpeechPlayback((event) => { events.push(event) })
    expect(events.map(event => event.type)).toEqual(['start'])
    const currentId = events[0]!.playbackId
    secondEnd('end')
    expect(events[1]).toEqual({ type: 'end', playbackId: currentId })
    unsubscribe(); unsubscribe()
    const afterEnd: SpeechPlaybackEvent[] = []
    const stop = subscribeSpeechPlayback((event) => { afterEnd.push(event) })
    expect(afterEnd).toEqual([])
    stop()
  })

  it('reports actual system utterance starts without fabricated audio and isolates observer failure', async () => {
    const events: SpeechPlaybackEvent[] = []
    const broken = subscribeSpeechPlayback(() => { throw new Error('optional visual failed') })
    const unsubscribe = subscribeSpeechPlayback((event) => { events.push(event) })
    try {
      const fail = vi.fn()
      speakReply('当前回答。', 'zh-CN', vi.fn(), fail)
      await vi.waitFor(() => { expect(spoken).toHaveLength(1) })
      expect(events).toEqual([])
      const utterance = spoken[0]!
      utterance.onstart?.({} as SpeechSynthesisEvent)
      expect(events[0]?.type).toBe('start')
      expect(events[0]).toHaveProperty('source', 'system')
      expect(typeof events[0]?.playbackId).toBe('number')
      expect(events[0]).not.toHaveProperty('wav')
      utterance.onerror?.({} as SpeechSynthesisErrorEvent)
      expect(events[1]).toEqual({ type: 'error', playbackId: events[0]!.playbackId })
      expect(fail).toHaveBeenCalledOnce()
    } finally { broken(); unsubscribe() }
  })
})
