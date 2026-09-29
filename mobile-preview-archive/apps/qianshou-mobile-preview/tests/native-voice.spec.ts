// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeVoiceInput, type NativeVoiceBridge } from '../src/native-voice.ts'
import type { VoiceInputController } from '../src/voice.ts'
const voices: VoiceInputController[] = []
afterEach(() => { voices.splice(0).forEach((voice) => { voice.dispose() }); vi.useRealTimers() })
function setup() {
  const events = new Map<string, (event: { requestId: string; state?: string; text?: string; isFinal?: boolean; code?: string }) => void>()
  let id = ''
  const bridge: NativeVoiceBridge = {
    available: vi.fn(async () => ({ available: true, onDevice: false })),
    start: vi.fn(async (input: { requestId: string; language: string }) => { id = input.requestId; return { requestId: id } }),
    stop: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    addListener: async (name, callback) => { events.set(name, callback); return { remove: async () => { events.delete(name) } } },
  }
  const voice = createNativeVoiceInput(bridge); voices.push(voice)
  return { voice, bridge, events, send: (name: string, data: object) => { events.get(name)?.({ requestId: id, ...data }) } }
}
describe('native voice ownership', () => {
  it('finishes released speech as editable text without sending a conversation request', async () => {
    const { voice, bridge, send } = setup()
    await voice.start({ mode: 'native' }); send('voiceState', { state: 'listening' })
    send('voiceResult', { text: '一句', isFinal: false }); expect(voice.snapshot().interimText).toBe('一句')
    voice.stop(); expect(bridge.stop).toHaveBeenCalledOnce()
    send('voiceResult', { text: '一句完整的话', isFinal: true }); send('voiceState', { state: 'ended' })
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', finalText: '一句完整的话', interimText: '' })
  })
  it('discards another request and ignores old callback results after cancellation', async () => {
    const { voice, events, send } = setup(); await voice.start({ mode: 'native' })
    const late = events.get('voiceResult')!
    send('voiceResult', { requestId: 'other-request', text: '不得出现', isFinal: true })
    expect(voice.snapshot().finalText).toBe('')
    voice.cancel(); late({ requestId: 'other-request', text: '迟到', isFinal: true })
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', finalText: '' })
  })
  it('does not start if the finger was released during native availability or permission preparation', async () => {
    const { voice, bridge } = setup()
    let resolve!: (value: { available: boolean; onDevice: boolean }) => void
    vi.mocked(bridge.available).mockImplementation(() => new Promise((yes) => { resolve = yes }))
    const start = voice.start({ mode: 'native' }); voice.stop(); resolve({ available: true, onDevice: false })
    expect(await start).toBe(false); expect(bridge.start).not.toHaveBeenCalled()
  })
  it('releases a native recognizer when its final event never arrives', async () => {
    vi.useFakeTimers(); const { voice, bridge } = setup(); await voice.start({ mode: 'native' })
    voice.stop(); await vi.advanceTimersByTimeAsync(5000)
    expect(bridge.cancel).toHaveBeenCalledOnce(); expect(voice.snapshot().phase).toBe('error')
  })
  it('maps native permission errors without exposing diagnostic text', async () => {
    const { voice, send } = setup(); await voice.start({ mode: 'native' })
    send('voiceError', { code: 'PERMISSION_DENIED' })
    expect(voice.snapshot()).toMatchObject({ phase: 'error', error: 'permission-denied' })
  })
  it.each([
    ['PERMISSION_DENIED', 'permission-denied'],
    ['UNAVAILABLE', 'unsupported'],
    ['NETWORK', 'network'],
    ['vendor-private-diagnostic', 'recognition-failed'],
  ])('preserves safe %s when start rejects before its error event arrives', async (code, expected) => {
    const { voice, bridge, events } = setup()
    let late: (() => void) | undefined
    vi.mocked(bridge.start).mockImplementationOnce(async (input) => {
      const callback = events.get('voiceError')!
      late = () => { callback({ requestId: input.requestId, code: 'FAILED' }) }
      throw { code, message: 'private recognition service diagnostic' }
    })
    expect(await voice.start({ mode: 'native' })).toBe(false)
    expect(voice.snapshot()).toMatchObject({ phase: 'error', error: expected, finalText: '' })
    expect(events.size).toBe(0)
    late?.()
    expect(voice.snapshot().error).toBe(expected)
    expect(JSON.stringify(voice.snapshot())).not.toContain('private')
  })
})
