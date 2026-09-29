/** Local system speech with explicit voice selection and cancellable output ownership. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One final assistant action owns one audible output. */
export interface SpeechOwner { readonly sessionId: SessionId; readonly messageId: string }
/** Browser voice discovery is separate from audible playback progress. */
export interface SpeechState {
  readonly languages: readonly string[]
  readonly loading: boolean
  readonly active: (SpeechOwner & { readonly phase: 'starting' | 'playing' }) | null
  readonly failed: SpeechOwner | null
}

/**
 * Remove non-prose Markdown before system narration.
 * @param text - Final assistant prose supplied by the Chat owner.
 * @returns Narratable text; code fences and image destinations are excluded.
 */
export function spokenText(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, '').replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/^\s{0,3}[#>]+\s*/gmu, '')
    .replace(/[*_`~]/gu, '').replace(/\n{3,}/gu, '\n\n').trim()
}

/** One page's system speech queue; disposal cancels timers, callbacks, and output. */
export class SystemSpeech {
  /** Observable discovery and playback state; voice objects remain adapter-owned. */
  readonly store = createSnapshotStore<SpeechState>({ languages: [], loading: true, active: null, failed: null })
  private voices: SpeechSynthesisVoice[] = []
  private revision = 0
  private utterance: SpeechSynthesisUtterance | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private discovery: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly engine: SpeechSynthesis | undefined = typeof window === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined' ? undefined : window.speechSynthesis,
    private readonly createUtterance: (text: string) => SpeechSynthesisUtterance = text => new SpeechSynthesisUtterance(text),
  ) {
    this.engine?.addEventListener('voiceschanged', this.refresh)
    this.refresh()
    if (this.engine !== undefined && this.voices.length === 0) {
      this.discovery = setTimeout(() => {
        this.refresh()
        this.store.set({ ...this.store.getSnapshot(), loading: false })
      }, 2000)
    }
  }

  private refresh = (): void => {
    if (this.disposed) return
    this.voices = this.engine?.getVoices().filter(voice => voice.localService) ?? []
    this.store.set({ ...this.store.getSnapshot(), languages: [...new Set(this.voices.map(voice => voice.lang.toLowerCase()))],
      loading: this.engine !== undefined && this.voices.length === 0 && this.discovery === undefined })
  }

  /**
   * Check for an actually enumerated local voice in the requested language.
   * @param language - UI-selected language, such as zh-CN.
   * @returns whether this page can select an explicit local voice.
   */
  available(language: string): boolean {
    return this.voices.some(voice => voice.lang.toLowerCase().split('-')[0] === language.toLowerCase().split('-')[0])
  }

  /**
   * Start one explicitly requested final response; another output is cancelled first.
   * @param owner - Session and durable assistant identity.
   * @param text - Final response text.
   * @param language - Preferred system voice language.
   * @returns whether a bounded playback was started with a real local voice.
   */
  speak(owner: SpeechOwner, text: string, language: string): boolean {
    this.stop()
    if (this.disposed || this.engine === undefined) return false
    this.refresh()
    const clean = spokenText(text)
    const voice = this.voices.find(item => item.lang.toLowerCase() === language.toLowerCase())
      ?? this.voices.find(item => item.lang.toLowerCase().split('-')[0] === language.toLowerCase().split('-')[0])
    if (voice === undefined || clean === '' || clean.length > 20000) {
      this.store.set({ ...this.store.getSnapshot(), failed: owner })
      return false
    }
    const revision = this.revision
    const chunks = clean.match(/[\s\S]{1,240}(?:[。！？.!?\n]|$)|[\s\S]{1,240}/gu) ?? []
    let next = 0
    const fail = (): void => {
      if (revision !== this.revision) return
      this.stop()
      this.store.set({ ...this.store.getSnapshot(), failed: owner })
    }
    const advance = (): void => {
      if (revision !== this.revision || this.disposed) return
      if (this.timer !== undefined) clearTimeout(this.timer)
      if (next >= chunks.length) { this.stop(); return }
      let utterance: SpeechSynthesisUtterance
      try { utterance = this.createUtterance(chunks[next++] ?? '') } catch (error) { void error; fail(); return }
      this.utterance = utterance; utterance.voice = voice; utterance.lang = voice.lang
      utterance.onstart = () => {
        if (revision !== this.revision || this.utterance !== utterance) return
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.store.set({ ...this.store.getSnapshot(), active: { ...owner, phase: 'playing' } })
        this.timer = setTimeout(fail, 120000)
      }
      utterance.onerror = () => { if (this.utterance === utterance) fail() }
      utterance.onend = () => {
        if (this.utterance !== utterance) return
        utterance.onstart = null; utterance.onend = null; utterance.onerror = null
        this.utterance = undefined
        advance()
      }
      this.store.set({ ...this.store.getSnapshot(), active: { ...owner, phase: 'starting' }, failed: null })
      this.timer = setTimeout(fail, 8000)
      try { this.engine?.speak(utterance) } catch (error) { void error; fail() }
    }
    advance()
    return true
  }

  /** Stop owned playback immediately; late utterance events cannot restart it. */
  stop(): void {
    this.revision += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const utterance = this.utterance
    this.utterance = undefined
    if (utterance !== undefined) {
      utterance.onstart = null; utterance.onend = null; utterance.onerror = null
      this.engine?.cancel()
    }
    this.store.set({ ...this.store.getSnapshot(), active: null })
  }

  /**
   * Stop only a departing view's playback, preserving a newer owner's output.
   * @param owner - View or assistant action being removed.
   */
  release(owner: SpeechOwner): void {
    const current = this.store.getSnapshot().active
    if (current?.sessionId === owner.sessionId && current.messageId === owner.messageId) this.stop()
  }

  /** Remove voice discovery and cancel all owned speech. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.discovery !== undefined) clearTimeout(this.discovery)
    this.engine?.removeEventListener('voiceschanged', this.refresh)
    this.stop()
  }
}
