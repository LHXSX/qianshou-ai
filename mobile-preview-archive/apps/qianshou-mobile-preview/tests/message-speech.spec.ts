// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseMessageSpeechVoice, createMessageSpeechPlayer, messageSpeech, messageSpeechPreferences, setMessageSpeechPreferences } from '../src/message-speech.ts'
import { decorateMessages } from '../src/components/message-view.ts'

class Utterance {
  lang = ''
  rate = 1
  pitch = 1
  voice: SpeechSynthesisVoice | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly text: string) {}
}
function fixture() {
  const runs: Utterance[] = []
  const synthesis: { speak: (utterance: SpeechSynthesisUtterance) => void; cancel: () => void; getVoices?: () => SpeechSynthesisVoice[] } = { speak: vi.fn(), cancel: vi.fn() }
  const player = createMessageSpeechPlayer(() => ({ synthesis, utterance: (text) => {
    const utterance = new Utterance(text); runs.push(utterance)
    return utterance as unknown as SpeechSynthesisUtterance
  } }))
  return { player, runs, synthesis }
}
afterEach(() => { messageSpeech.stop(); vi.unstubAllGlobals(); document.body.replaceChildren() })
describe('message speech toggle', () => {
  it('selects an available local Chinese voice and uses a calmer default rate', () => {
    const { player, runs, synthesis } = fixture()
    const voices = [
      { voiceURI: 'remote-en', lang: 'en-US', localService: false, default: true, name: 'English' },
      { voiceURI: 'remote-zh', lang: 'zh-TW', localService: false, default: true, name: '中文远端' },
      { voiceURI: 'local-zh', lang: 'zh-CN', localService: true, default: false, name: '中文本机' },
    ] as SpeechSynthesisVoice[]
    synthesis.getVoices = vi.fn(() => voices)
    const paint = vi.fn()
    player.toggle('voice', '请自然一点', paint)
    expect(runs[0]).toMatchObject({ lang: 'zh-CN', rate: 0.96, pitch: 1, voice: voices[2] })
  })

  it('keeps the system fallback when a remembered voice is no longer available', () => {
    const storage = { getItem: vi.fn(() => JSON.stringify({ voiceURI: 'removed', rate: 3, pitch: 0 })) }
    expect(messageSpeechPreferences(storage)).toEqual({ voiceURI: 'removed', rate: 1.25, pitch: 0.75 })
    const voices = [{ voiceURI: 'local-zh', lang: 'zh-CN', localService: true, default: true, name: '中文本机' }] as SpeechSynthesisVoice[]
    expect(chooseMessageSpeechVoice(voices, messageSpeechPreferences(storage))).toBe(voices[0])
    const setStorage = { getItem: storage.getItem, setItem: vi.fn() }
    expect(setMessageSpeechPreferences({ voiceURI: null }, setStorage)).toMatchObject({ voiceURI: null })
    expect(setStorage.setItem).toHaveBeenCalledOnce()
  })

  it('stops on the second tap even before the browser starts playback', () => {
    const { player, runs, synthesis } = fixture(); const paint = vi.fn()
    player.toggle('one', '你好', paint); player.toggle('one', '你好', paint)
    expect(synthesis.speak).toHaveBeenCalledTimes(1)
    expect(synthesis.cancel).toHaveBeenCalledTimes(1)
    expect(paint).toHaveBeenLastCalledWith('stopped')
    runs[0]?.onstart?.(); runs[0]?.onerror?.()
    expect(paint).toHaveBeenLastCalledWith('stopped')
  })
  it('stops the previous message and ignores its late completion', () => {
    const { player, runs, synthesis } = fixture(); const old = vi.fn(); const next = vi.fn()
    player.toggle('one', '第一条', old); player.toggle('two', '第二条', next)
    expect(old).toHaveBeenLastCalledWith('stopped'); expect(synthesis.cancel).toHaveBeenCalledTimes(1)
    runs[0]?.onend?.(); expect(next).toHaveBeenLastCalledWith('playing')
    runs[1]?.onend?.(); expect(next).toHaveBeenLastCalledWith('complete')
    player.toggle('two', '第二条', next); expect(synthesis.speak).toHaveBeenCalledTimes(3)
  })
  it('updates the current control after transcript rerender without restarting audio', () => {
    const { player, runs, synthesis } = fixture(); const old = vi.fn(); const replacement = vi.fn()
    player.toggle('one', '正文', old); player.bind('one', replacement)
    expect(replacement).toHaveBeenCalledWith('playing'); expect(synthesis.speak).toHaveBeenCalledTimes(1)
    runs[0]?.onend?.(); expect(replacement).toHaveBeenLastCalledWith('complete')
    expect(old).toHaveBeenCalledTimes(1)
  })
  it('renders a stop control and makes its second click cancel rather than replay', () => {
    const synthesis = { speak: vi.fn(), cancel: vi.fn() }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis })
    const root = document.createElement('section')
    root.innerHTML = '<article data-testid="mobile-turn-speech-one"></article>'
    const turns = [{ id: 'speech-one', at: 1000, role: 'assistant' as const, text: '这是一条回答。' }]
    decorateMessages(root, turns); document.body.append(root)
    root.querySelector<HTMLButtonElement>('.message-speak')!.click()
    expect(root.querySelector('[aria-label="停止播报"]')).not.toBeNull()
    decorateMessages(root, turns)
    root.querySelector<HTMLButtonElement>('[aria-label="停止播报"]')!.click()
    expect(synthesis.cancel).toHaveBeenCalledTimes(1); expect(synthesis.speak).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[aria-label="语音播报"]')).not.toBeNull()
    expect(root.textContent).toContain('已停止播报')
  })
})
