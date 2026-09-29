/** Dictation only: adapters publish text; the composer owns editing and explicit sending. */
export type VoiceMode = 'local' | 'browser-service' | 'native'
export type VoiceError = 'unsupported' | 'local-unavailable' | 'language-unavailable'
  | 'permission-denied' | 'no-device' | 'network' | 'no-speech' | 'aborted'
  | 'recognition-failed' | 'consent-required'
export interface VoiceInputState {
  readonly phase: 'idle' | 'checking' | 'starting' | 'listening' | 'stopping' | 'error'
  /** API support only; local language availability is checked separately on start. */
  readonly capabilities: Readonly<{ local: boolean; browserService: boolean; native?: boolean }>
  readonly mode: VoiceMode | null
  readonly language: string
  readonly finalText: string
  readonly interimText: string
  readonly error: VoiceError | null
}
export type VoiceStart = { mode: 'local' } | { mode: 'browser-service'; consent: true } | { mode: 'native' }
/** Native iOS/Android/Harmony adapters can implement the same composer-facing lifecycle. */
export interface VoiceInputController {
  snapshot(): VoiceInputState
  subscribe(listener: (state: VoiceInputState) => void): () => void
  /** Call only from an explicit gesture, after explaining the selected provider mode. */
  start(options: VoiceStart): Promise<boolean>
  /** Finish this utterance; final results may still arrive before the end event. */
  stop(): void
  /** Discard recognition and invalidate callbacks on identity/session changes. */
  cancel(): void
  dispose(): void
}

interface RecognitionResult {
  readonly isFinal: boolean
  readonly 0: { readonly transcript: string }
}
interface RecognitionResultEvent { readonly results: ArrayLike<RecognitionResult> }
interface RecognitionErrorEvent { readonly error: string }
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  processLocally?: boolean
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onresult: ((event: RecognitionResultEvent) => void) | null
  onspeechstart?: (() => void) | null
  onspeechend?: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
interface RecognitionConstructor {
  new(): Recognition
  available?(options: { langs: string[]; processLocally: true }): Promise<string>
}
interface SpeechWindow { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }

function errorCode(error: unknown): VoiceError {
  const value = typeof error === 'string' ? error
    : typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : ''
  switch (value) {
    case 'not-allowed': case 'service-not-allowed': case 'NotAllowedError': case 'SecurityError': return 'permission-denied'
    case 'audio-capture': case 'NotFoundError': case 'NotReadableError': return 'no-device'
    case 'network': case 'NetworkError': return 'network'
    case 'no-speech': return 'no-speech'
    case 'aborted': case 'AbortError': return 'aborted'
    case 'language-not-supported': return 'language-unavailable'
    default: return 'recognition-failed'
  }
}

function parseStart(value: unknown): VoiceStart | VoiceError {
  if (typeof value !== 'object' || value === null || !('mode' in value)) return 'unsupported'
  if (value.mode === 'local') return { mode: 'local' }
  if (value.mode !== 'browser-service') return 'unsupported'
  if (!('consent' in value) || value.consent !== true) return 'consent-required'
  return { mode: 'browser-service', consent: true }
}

/**
 * Uses the browser's existing Web Speech implementation; no backend, audio upload or model fallback is added.
 * Local mode requires processLocally AND a positive installed-language check. Service mode may be processed
 * by the browser's provider and therefore requires explicit caller consent; microphone permission is separate.
 * Creating a controller never starts recording, downloads language packs, or requests microphone permission.
 */
export function createBrowserVoiceInput(options: { language?: string; silenceMs?: number; autoStopOnSilence?: boolean } = {}): VoiceInputController {
  const browser = typeof window === 'undefined' ? undefined : window as unknown as SpeechWindow
  const Constructor = browser?.SpeechRecognition ?? browser?.webkitSpeechRecognition
  let first: Recognition | undefined
  try { if (Constructor) first = new Constructor() } catch { /* Constructor unavailable in this document. */ }
  const capabilities = Object.freeze({
    local: first !== undefined && typeof first.processLocally === 'boolean' && typeof Constructor?.available === 'function',
    browserService: first !== undefined,
  })
  let state: VoiceInputState = Object.freeze({
    phase: 'idle', capabilities, mode: null, language: options.language ?? 'zh-CN',
    finalText: '', interimText: '', error: null,
  })
  const listeners = new Set<(state: VoiceInputState) => void>()
  let generation = 0
  let active: Recognition | undefined
  let started = false
  let disposed = false
  const silenceMs = Math.max(700, Math.min(5000, options.silenceMs ?? 1400))
  let silenceTimer: ReturnType<typeof setTimeout> | undefined
  let endTimer: ReturnType<typeof setTimeout> | undefined
  const clearSilence = (): void => { clearTimeout(silenceTimer); silenceTimer = undefined }
  const publish = (patch: Partial<VoiceInputState>): void => {
    state = Object.freeze({ ...state, ...patch })
    for (const listener of listeners) listener(state)
  }
  const detach = (recognition: Recognition): void => {
    recognition.onstart = null; recognition.onend = null
    recognition.onerror = null; recognition.onresult = null
    recognition.onspeechstart = null; recognition.onspeechend = null
  }
  const release = (abort: boolean): void => {
    clearSilence(); clearTimeout(endTimer); endTimer = undefined
    const recognition = active
    active = undefined
    if (recognition) {
      detach(recognition)
      // Aborting an inactive recognizer may throw in some implementations; owned callbacks are already gone.
      if (abort && started) { try { recognition.abort() } catch { /* Already ended. */ } }
    }
    started = false
  }
  const cancel = (): void => {
    generation++
    release(true)
    publish({ phase: 'idle', mode: null, finalText: '', interimText: '', error: null })
  }
  const fail = (error: VoiceError): false => {
    release(true)
    publish({ phase: 'error', error, interimText: '' })
    return false
  }
  const stop = (): void => {
    if (disposed || !active || state.phase === 'stopping') return
    if (!started) { cancel(); return }
    clearSilence()
    const recognition = active
    publish({ phase: 'stopping' })
    if (active !== recognition) return
    // Some engines omit onend after stop; release the microphone without inventing final words.
    endTimer = setTimeout(() => {
      if (active !== recognition) return
      release(true)
      publish({ phase: 'idle', interimText: '' })
    }, 2500)
    try { recognition.stop() } catch (error) { fail(errorCode(error)) }
  }
  const afterSilence = (): void => {
    if (options.autoStopOnSilence === false) return
    clearSilence()
    silenceTimer = setTimeout(() => { if (state.phase === 'listening') stop() }, silenceMs)
  }
  return {
    snapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async start(request) {
      if (disposed || active) return false
      const current = ++generation
      const selected = parseStart(request)
      publish({ mode: typeof selected === 'string' ? null : selected.mode, finalText: '', interimText: '', error: null })
      if (generation !== current) return false
      if (typeof selected === 'string') return fail(selected)
      if (!Constructor || !capabilities.browserService) return fail('unsupported')
      if (selected.mode === 'local' && !capabilities.local) return fail('local-unavailable')
      let recognition: Recognition
      try { recognition = first ?? new Constructor(); first = undefined } catch (error) { return fail(errorCode(error)) }
      active = recognition
      const owns = (): boolean => !disposed && generation === current && active === recognition
      let acousticEvents = false
      let speaking = false
      try {
        recognition.lang = state.language
        recognition.continuous = true
        recognition.interimResults = true
        recognition.maxAlternatives = 1
        if (selected.mode === 'local') {
          if (!Constructor.available) return fail('local-unavailable')
          recognition.processLocally = true
          publish({ phase: 'checking' })
          const availability = await Constructor.available({ langs: [state.language], processLocally: true })
          if (!owns()) return false
          if (availability !== 'available') return fail('language-unavailable')
        } else if (typeof recognition.processLocally === 'boolean') recognition.processLocally = false
        recognition.onstart = () => { if (owns() && state.phase === 'starting') publish({ phase: 'listening' }) }
        recognition.onspeechstart = () => {
          if (!owns() || state.phase === 'stopping') return
          acousticEvents = true; speaking = true; clearSilence()
        }
        recognition.onspeechend = () => {
          if (!owns() || state.phase !== 'listening') return
          acousticEvents = true; speaking = false; afterSilence()
        }
        recognition.onresult = (event) => {
          if (!owns()) return
          // Native results are a full snapshot. Rebuilding avoids duplicating corrected interim/final words.
          const final: string[] = []; const interim: string[] = []
          for (let index = 0; index < event.results.length; index++) {
            const result = event.results[index]
            if (result) (result.isFinal ? final : interim).push(result[0].transcript)
          }
          publish({ finalText: final.join('').trim(), interimText: interim.join('').trim() })
          if (!owns() || state.phase !== 'listening') return
          // A delayed interim result cannot undo an acoustic pause. A finalized segment
          // also cannot stop a speaker who is still talking. Results are a fallback only
          // for engines that have not published any speech-start/end events.
          if (acousticEvents) {
            if (!speaking && silenceTimer === undefined) afterSilence()
          } else {
            clearSilence()
            if (interim.length === 0 && final.length > 0) afterSilence()
          }
        }
        recognition.onerror = (event) => { if (owns()) fail(errorCode(event.error)) }
        recognition.onend = () => {
          if (!owns()) return
          release(false)
          publish({ phase: 'idle', interimText: '' })
        }
        publish({ phase: 'starting' })
        // A subscriber may cancel on identity loss during publication; never acquire the mic afterwards.
        if (!owns()) return false
        started = true
        recognition.start()
        return owns()
      } catch (error) { return owns() ? fail(errorCode(error)) : false }
    },
    stop,
    cancel() { if (!disposed) cancel() },
    dispose() {
      if (disposed) return
      disposed = true
      cancel()
      first = undefined
      listeners.clear()
    },
  }
}
