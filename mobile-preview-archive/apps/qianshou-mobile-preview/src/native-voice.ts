/** Native recognition bridge. Request ownership prevents late words entering another account or Session. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { VoiceError, VoiceInputController, VoiceInputState } from './voice.ts'

interface NativeEvent { requestId: string; text?: string; isFinal?: boolean; state?: string; code?: string }
export interface NativeVoiceBridge {
  available(this: void): Promise<{ available: boolean; onDevice: boolean }>
  start(this: void, input: { requestId: string; language: string }): Promise<{ requestId: string }>
  stop(this: void, input: { requestId: string }): Promise<unknown>
  cancel(this: void, input: { requestId: string }): Promise<unknown>
  addListener(this: void, name: 'voiceResult' | 'voiceState' | 'voiceError', callback: (event: NativeEvent) => void): Promise<{ remove(): Promise<void> }>
}
/** Native globals are injected by the reviewed Android/Harmony top-level container. */
export function nativeVoiceBridge(): NativeVoiceBridge | undefined {
  const host = window as unknown as {
    QianshouVoice?: NativeVoiceBridge
    Capacitor?: {
      isNativePlatform?: () => boolean
      Plugins?: { QianshouVoice?: NativeVoiceBridge }
      registerPlugin?: (name: string) => NativeVoiceBridge
    }
  }
  if (host.QianshouVoice) return host.QianshouVoice
  if (!host.Capacitor?.isNativePlatform?.()) return undefined
  return host.Capacitor.Plugins?.QianshouVoice ?? host.Capacitor.registerPlugin?.('QianshouVoice')
}
const nativeError = (code?: string): VoiceError => {
  switch (code) {
    case 'PERMISSION_DENIED': return 'permission-denied'
    case 'UNAVAILABLE': return 'unsupported'
    case 'NO_SPEECH': return 'no-speech'
    case 'NETWORK': return 'network'
    case 'ABORTED': return 'aborted'
    default: return 'recognition-failed'
  }
}
export function createNativeVoiceInput(bridge: NativeVoiceBridge): VoiceInputController {
  let state: VoiceInputState = { phase: 'idle', capabilities: { local: false, browserService: false, native: true }, mode: null, language: 'zh-CN', finalText: '', interimText: '', error: null }
  const listeners = new Set<(state: VoiceInputState) => void>()
  const nativeListeners: { remove(): Promise<void> }[] = []
  let requestId: string | null = null
  let started = false
  let released = false
  let disposed = false
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  const emit = (patch: Partial<VoiceInputState>): void => {
    state = Object.freeze({ ...state, ...patch })
    for (const listener of listeners) listener(state)
  }
  const remove = (): void => { for (const listener of nativeListeners.splice(0)) void listener.remove().catch(() => {}) }
  const finish = (error?: VoiceError): void => {
    requestId = null; started = false; released = false; clearTimeout(releaseTimer); remove()
    emit({ phase: error ? 'error' : 'idle', interimText: '', error: error ?? null })
  }
  const cancel = (): void => {
    const id = requestId
    requestId = null; started = false; released = false; clearTimeout(releaseTimer); remove()
    if (id) void bridge.cancel({ requestId: id }).catch(() => {})
    emit({ phase: 'idle', mode: null, finalText: '', interimText: '', error: null })
  }
  const stop = (): void => {
    if (!requestId || released) return
    released = true
    if (!started) { cancel(); return }
    const id = requestId
    emit({ phase: 'stopping' })
    releaseTimer = setTimeout(() => {
      if (requestId !== id) return
      void bridge.cancel({ requestId: id }).catch(() => {})
      finish(state.finalText ? undefined : 'recognition-failed')
    }, 5000)
    void bridge.stop({ requestId: id }).catch(() => { if (requestId === id) finish('recognition-failed') })
  }
  return {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async start() {
      if (disposed || requestId) return false
      const id = randomUUID(); requestId = id; started = false; released = false
      emit({ phase: 'checking', mode: 'native', finalText: '', interimText: '', error: null })
      const owns = (): boolean => requestId === id && !disposed
      try {
        const capability = await bridge.available()
        if (!owns()) return false
        if (!capability.available) { finish('unsupported'); return false }
        const onEvent = (event: NativeEvent): void => {
          if (!owns() || event.requestId !== id) return
          if (typeof event.code === 'string') { finish(nativeError(event.code)); return }
          if (typeof event.text === 'string') emit(event.isFinal ? { finalText: event.text, interimText: '' } : { interimText: event.text })
          if (!owns()) return
          if (event.state === 'ended') finish()
          else if (event.state === 'cancelled') cancel()
          else if (event.state === 'processing') emit({ phase: 'stopping' })
          else if (event.state === 'listening') { started = true; emit({ phase: 'listening' }) }
        }
        for (const name of ['voiceResult', 'voiceState', 'voiceError'] as const) {
          const listener = await bridge.addListener(name, onEvent)
          if (!owns()) { await listener.remove(); return false }
          nativeListeners.push(listener)
        }
        emit({ phase: 'starting' })
        if (!owns()) return false
        const reply = await bridge.start({ requestId: id, language: state.language })
        if (!owns()) { await bridge.cancel({ requestId: id }); return false }
        if (reply.requestId !== id) { await bridge.cancel({ requestId: id }); finish('recognition-failed'); return false }
        started = true
        return true
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code : undefined
        if (owns()) finish(nativeError(code))
        return false
      }
    },
    stop, cancel,
    dispose() { if (disposed) return; cancel(); disposed = true; listeners.clear() },
  }
}
