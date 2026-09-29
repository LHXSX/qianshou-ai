/** One message may speak at a time, including before the browser's delayed start event. */
export type MessageSpeechState = 'playing' | 'stopped' | 'complete' | 'error' | 'unavailable' | 'idle'
type Paint = (state: MessageSpeechState) => void
const MESSAGE_SPEECH_STORAGE_KEY = 'qianshou.mobile.message-speech'
const DEFAULT_MESSAGE_SPEECH_PREFERENCES = Object.freeze({ voiceURI: null, rate: 0.96, pitch: 1 })

export interface MessageSpeechPreferences {
  readonly voiceURI: string | null
  readonly rate: number
  readonly pitch: number
}

/**
 * The browser owns the actual voice catalogue. We only remember a URI that it
 * has exposed, so a missing or changed device voice always falls back safely.
 */
export function messageSpeechPreferences(storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage === 'undefined' ? null : localStorage): MessageSpeechPreferences {
  if (!storage) return DEFAULT_MESSAGE_SPEECH_PREFERENCES
  try {
    const raw = storage.getItem(MESSAGE_SPEECH_STORAGE_KEY)
    if (!raw) return DEFAULT_MESSAGE_SPEECH_PREFERENCES
    const value = JSON.parse(raw) as { voiceURI?: unknown; rate?: unknown; pitch?: unknown }
    const rate = typeof value.rate === 'number' && Number.isFinite(value.rate) ? Math.min(1.25, Math.max(0.75, value.rate)) : DEFAULT_MESSAGE_SPEECH_PREFERENCES.rate
    const pitch = typeof value.pitch === 'number' && Number.isFinite(value.pitch) ? Math.min(1.25, Math.max(0.75, value.pitch)) : DEFAULT_MESSAGE_SPEECH_PREFERENCES.pitch
    return Object.freeze({ voiceURI: typeof value.voiceURI === 'string' && value.voiceURI ? value.voiceURI : null, rate, pitch })
  } catch {
    return DEFAULT_MESSAGE_SPEECH_PREFERENCES
  }
}

export function setMessageSpeechPreferences(
  patch: Partial<MessageSpeechPreferences>,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage === 'undefined' ? null : localStorage,
): MessageSpeechPreferences {
  const current = messageSpeechPreferences(storage as Pick<Storage, 'getItem'> | null | undefined)
  const next = Object.freeze({
    voiceURI: patch.voiceURI === undefined ? current.voiceURI : patch.voiceURI,
    rate: typeof patch.rate === 'number' && Number.isFinite(patch.rate) ? Math.min(1.25, Math.max(0.75, patch.rate)) : current.rate,
    pitch: typeof patch.pitch === 'number' && Number.isFinite(patch.pitch) ? Math.min(1.25, Math.max(0.75, patch.pitch)) : current.pitch,
  })
  try { storage?.setItem(MESSAGE_SPEECH_STORAGE_KEY, JSON.stringify(next)) } catch { /* Private browsing may deny preferences; playback still works. */ }
  return next
}

export function availableMessageSpeechVoices(
  synthesis: { readonly getVoices?: () => readonly SpeechSynthesisVoice[] } | null | undefined = typeof window === 'undefined' ? null : window.speechSynthesis,
): readonly SpeechSynthesisVoice[] {
  try { return synthesis?.getVoices?.() ?? [] } catch { return [] }
}

function voiceScore(voice: SpeechSynthesisVoice): number {
  const lang = voice.lang.toLowerCase()
  const chinese = lang === 'zh-cn' ? 0 : lang.startsWith('zh-') ? 1 : lang === 'zh' ? 2 : 10
  // Prefer a voice supplied by this device before a remote browser voice. The
  // name is deliberately not guessed: availability is the browser's truth.
  return chinese * 10 + (voice.localService ? 0 : 1) + (voice.default ? 0 : 0.25)
}

export function chooseMessageSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferences: MessageSpeechPreferences = messageSpeechPreferences(),
): SpeechSynthesisVoice | undefined {
  if (preferences.voiceURI) {
    const selected = voices.find(voice => voice.voiceURI === preferences.voiceURI)
    if (selected) return selected
  }
  const chinese = voices.filter(voice => /^zh(?:-|$)/i.test(voice.lang))
  return [...(chinese.length ? chinese : voices)].sort((a, b) => voiceScore(a) - voiceScore(b))[0]
}

export const messageSpeechStorageKey = MESSAGE_SPEECH_STORAGE_KEY

interface SpeechSynthesisPort {
  readonly speak: (utterance: SpeechSynthesisUtterance) => void
  readonly cancel: () => void
  readonly getVoices?: () => readonly SpeechSynthesisVoice[]
}
export interface SpeechPort {
  readonly synthesis: SpeechSynthesisPort
  readonly utterance: (text: string) => SpeechSynthesisUtterance
}

export function createMessageSpeechPlayer(port: () => SpeechPort | null): {
  bind: (key: string, paint: Paint) => void
  toggle: (key: string, text: string, paint: Paint) => void
  stop: () => void
} {
  let current: { key: string; paint: Paint; port: SpeechPort } | null = null
  const stop = (): void => {
    const previous = current
    if (!previous) return
    // Cancel can synchronously emit an error/end event. Invalidate the old run first.
    current = null
    previous.port.synthesis.cancel()
    previous.paint('stopped')
  }
  return {
    stop,
    bind(key, paint) {
      if (current?.key === key) { current.paint = paint; paint('playing') }
      else paint('idle')
    },
    toggle(key, text, paint) {
      if (current?.key === key) { current.paint = paint; stop(); return }
      stop()
      const backend = port()
      if (!backend) { paint('unavailable'); return }
      const run = { key, paint, port: backend }
      current = run
      const finish = (state: MessageSpeechState): void => {
        if (current !== run) return
        current = null; run.paint(state)
      }
      try {
        const utterance = backend.utterance(text)
        const preferences = messageSpeechPreferences()
        const selectedVoice = chooseMessageSpeechVoice(availableMessageSpeechVoices(backend.synthesis), preferences)
        utterance.lang = selectedVoice?.lang || 'zh-CN'
        utterance.rate = preferences.rate
        utterance.pitch = preferences.pitch
        if (selectedVoice) utterance.voice = selectedVoice
        utterance.onstart = () => { if (current === run) run.paint('playing') }
        utterance.onend = () => { finish('complete') }
        utterance.onerror = () => { finish('error') }
        run.paint('playing')
        backend.synthesis.speak(utterance)
      } catch { finish('error') }
    },
  }
}

export const messageSpeech = createMessageSpeechPlayer(() => {
  if (typeof window === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return null
  const synthesis = (window as { readonly speechSynthesis?: SpeechSynthesis }).speechSynthesis
  return synthesis ? { synthesis, utterance: text => new SpeechSynthesisUtterance(text) } : null
})
