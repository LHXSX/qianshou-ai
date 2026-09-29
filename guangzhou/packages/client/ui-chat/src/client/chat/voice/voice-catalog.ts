import { claimSpeechOutput } from './speech-ownership.ts'
import { startSpeechPlayback } from './speech-playback.ts'
import { readSpeechBytes } from './speech-bytes.ts'

/**
 * Voice catalog for the local neural speech endpoint: read the host's real
 * speaker list, reuse a previously chosen speaker, and keep the choice in
 * localStorage. The host accepts only bundled CustomVoice speakers, so a
 * selection that the host refuses stays selected with a visible error; only
 * the user can choose another identity.
 */

/** Speaker identifiers the bundled local worker can actually render. */
export const KNOWN_VOICES = ['Vivian', 'Serena'] as const

/** One selectable speaker as validated against the host contract. */
export type VoiceId = (typeof KNOWN_VOICES)[number]

/** localStorage key for the user's chosen speaker. */
export const VOICE_STORAGE_KEY = 'qianshou.dsh.voice.speaker'

/** Window-local last audible neural identity; a preview never changes it. */
export const PLAYBACK_VOICE_STORAGE_KEY = 'qianshou.dsh.voice.played-speaker'

/**
 * Resolve explicit preference before the last neural identity heard in this window.
 * @returns A supported speaker, or undefined before neural playback has selected one.
 */
export function loadPlaybackSpeaker(): VoiceId | undefined {
  const preferred = loadPreferredSpeaker()
  if (preferred !== undefined) return preferred
  try { return toVoiceId(sessionStorage.getItem(PLAYBACK_VOICE_STORAGE_KEY)) }
  catch { return undefined }
}

/**
 * Keep automatic replies and manual read-aloud on the same already-audible identity.
 * @param speaker - Validated speaker whose reply audio actually started playing.
 */
export function rememberPlaybackSpeaker(speaker: VoiceId): void {
  try { sessionStorage.setItem(PLAYBACK_VOICE_STORAGE_KEY, speaker) }
  catch { /* Playback remains valid when window storage is blocked. */ }
}

/** Short utterance used by the preview button; well inside the host character limit. */
export const VOICE_PREVIEW_TEXT = '你好，我是千手小管家，这是现在的声线。'

/** Request deadline for one preview synthesis, including a cold model load. */
const SYNTHESIS_TIMEOUT_MS = 60_000

/** Partial status payload confirmed by `packages/host/voice-local/src/tts-engine.ts`. */
export interface VoiceStatus {
  readonly available: boolean
  readonly ready?: boolean | undefined
  readonly engine?: string | undefined
  readonly speakers: readonly string[]
  readonly defaultSpeaker: string
}

/** Resolved catalog for the picker; `speakers` is always the host-reported list. */
export interface VoiceCatalog {
  /** False when neural synthesis is not installed, disabled, unauthenticated, or unreachable. */
  readonly available: boolean
  /** Host-reported speakers, in host order; empty when the status read failed. */
  readonly speakers: readonly VoiceId[]
  /** Speaker currently used for replies and previews. */
  readonly selected: VoiceId
  /** True when the selected identity is absent from the available host list. */
  readonly selectionUnavailable: boolean
}

/** A catalog plus the reason the host status could not be used, for visible reporting. */
export interface VoiceCatalogLoad {
  readonly catalog: VoiceCatalog
  readonly statusError: boolean
}

/**
 * Narrow one untrusted value to a supported speaker.
 * @param value - Candidate from storage, status, or a DOM event.
 * @returns the speaker id, or undefined when the host could not render it.
 */
export function toVoiceId(value: unknown): VoiceId | undefined {
  return typeof value === 'string' && (KNOWN_VOICES as readonly string[]).includes(value)
    ? value as VoiceId
    : undefined
}

/**
 * Read the stored speaker without letting storage failures break the picker.
 * @param storage - Storage to read; defaults to the browser localStorage.
 * @returns the stored speaker, or undefined when absent, invalid, or unavailable.
 */
export function loadPreferredSpeaker(storage?: Pick<Storage, 'getItem'>): VoiceId | undefined {
  try {
    const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    if (source === undefined) return undefined
    return toVoiceId(source.getItem(VOICE_STORAGE_KEY))
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen speaker; a blocked or full storage is reported, never thrown.
 * @param speaker - Speaker to remember for later sessions.
 * @param storage - Storage to write; defaults to the browser localStorage.
 * @returns true when the value was actually written.
 */
export function savePreferredSpeaker(speaker: VoiceId, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    if (target === undefined) return false
    target.setItem(VOICE_STORAGE_KEY, speaker)
    return true
  } catch {
    return false
  }
}

/**
 * Pick the speaker this catalog should use, honoring the user over the host default.
 * @param speakers - Host-reported speakers, already validated.
 * @param preferred - Speaker previously chosen by the user or heard in this window.
 * @param fallback - Host default used only before any identity has been selected.
 * @returns the preserved identity and whether the host currently lacks it.
 */
export function resolveVoice(
  speakers: readonly VoiceId[],
  preferred: VoiceId | undefined,
  fallback: VoiceId,
): { speaker: VoiceId; selectionUnavailable: boolean } {
  if (preferred !== undefined) return { speaker: preferred, selectionUnavailable: !speakers.includes(preferred) }
  return { speaker: speakers.includes(fallback) ? fallback : speakers[0] ?? fallback, selectionUnavailable: false }
}

/** Untrusted shape check for the authenticated status payload. */
function readVoiceStatus(value: unknown): VoiceStatus | undefined {
  if (!value || typeof value !== 'object') return undefined
  const status = value as Record<string, unknown>
  if (typeof status.available !== 'boolean') return undefined
  if (typeof status.defaultSpeaker !== 'string') return undefined
  if (!Array.isArray(status.speakers) || status.speakers.some(speaker => typeof speaker !== 'string')) return undefined
  return {
    available: status.available,
    ready: typeof status.ready === 'boolean' ? status.ready : undefined,
    engine: typeof status.engine === 'string' ? status.engine : undefined,
    speakers: status.speakers as string[],
    defaultSpeaker: status.defaultSpeaker,
  }
}

/**
 * Read the host status and fold it into a usable catalog.
 * A 404 means neural speech is not installed in this deployment and is treated
 * as plain unavailability; any other non-OK answer is an observable failure.
 * @param signal - Cancels the status read when the panel closes.
 * @param storage - Storage override for tests.
 * @returns the catalog plus whether the host status itself failed.
 */
export async function loadVoiceCatalog(
  signal?: AbortSignal,
  storage?: Pick<Storage, 'getItem'>,
): Promise<VoiceCatalogLoad> {
  const currentPreference = () => storage === undefined ? loadPlaybackSpeaker() : loadPreferredSpeaker(storage)
  // A failed status read has no speaker list to fall back into, so it never
  // claims a preference was rejected; `selectionUnavailable` stays reserved for a real
  // rejection by the host-reported list.
  const unavailable = (statusError: boolean): VoiceCatalogLoad => ({
    catalog: { available: false, speakers: [], selected: currentPreference() ?? 'Vivian', selectionUnavailable: false }, statusError,
  })
  try {
    const response = await fetch('/api/forge/voice/tts/status', {
      credentials: 'same-origin', ...(signal === undefined ? {} : { signal }),
    })
    if (response.status === 404) return unavailable(false)
    if (!response.ok) return unavailable(true)
    const status = readVoiceStatus(await response.json())
    if (status === undefined) return unavailable(true)
    const speakers = status.speakers.map(speaker => toVoiceId(speaker)).filter((id): id is VoiceId => id !== undefined)
    const fallback = toVoiceId(status.defaultSpeaker) ?? 'Vivian'
    if (!status.available || speakers.length === 0) return unavailable(false)
    const resolved = resolveVoice(speakers, currentPreference(), fallback)
    return {
      catalog: { available: true, speakers, selected: resolved.speaker, selectionUnavailable: resolved.selectionUnavailable },
      statusError: false,
    }
  } catch {
    return unavailable(true)
  }
}

/**
 * Synthesize and play one short sample so the user can hear a speaker before
 * committing to it. Failures are surfaced through `onError`, never swallowed.
 * @param text - Short utterance to synthesize.
 * @param speaker - Speaker the host must render; rejected values fail visibly.
 * @param onError - Called for a rejected request, invalid WAV, or playback failure.
 * @param onEnded - Called once when the sample finished playing normally.
 * @param onPlaying - Called once after the media element actually begins playback.
 * @param onSuperseded - Called when another audio output cancels this preview; never success or failure.
 * @returns Idempotent cancellation that stops playback and releases the object URL.
 */
export function playVoiceSample(
  text: string,
  speaker: VoiceId,
  onError: () => void,
  onEnded: () => void = () => {},
  onPlaying: () => void = () => {},
  onSuperseded: () => void = () => {},
): () => void {
  let settled = false
  let releaseOwnership = () => {}
  const isSettled = () => settled
  let url: string | undefined
  let player: HTMLAudioElement | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  let finishPlayback: ReturnType<typeof startSpeechPlayback> | undefined
  const endPlayback = (type: 'end' | 'cancel' | 'error') => {
    finishPlayback?.(type); finishPlayback = undefined
  }
  const release = () => {
    releaseOwnership(); clearTimeout(timer)
    if (player !== undefined) {
      player.onplaying = null; player.onended = null; player.onerror = null
      try { player.pause(); player.removeAttribute('src'); player.load() } catch { /* Detached media may already be closed. */ }
      player = undefined
    }
    if (url !== undefined) { URL.revokeObjectURL(url); url = undefined }
  }
  const fail = () => {
    if (isSettled()) return
    settled = true; endPlayback('error'); controller.abort(); release(); onError()
  }
  const finish = () => {
    if (isSettled()) return
    settled = true; endPlayback('end'); release(); onEnded()
  }
  const start = async (): Promise<void> => {
    timer = setTimeout(fail, SYNTHESIS_TIMEOUT_MS)
    try {
      const response = await fetch('/api/forge/voice/synthesize', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, speaker }), signal: controller.signal,
      })
      if (isSettled()) return
      if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'audio/wav') throw new Error('SYNTHESIS_FAILED')
      const bytes = await readSpeechBytes(response, controller.signal)
      if (isSettled()) return
      clearTimeout(timer)
      url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      const element = new Audio(url)
      player = element
      element.onplaying = () => {
        if (isSettled() || player !== element || finishPlayback !== undefined) return
        finishPlayback = startSpeechPlayback({ source: 'neural', element, wav: bytes.slice().buffer })
        onPlaying()
      }
      timer = setTimeout(fail, 180_000)
      element.onended = finish
      element.onerror = fail
      await element.play()
    } catch { fail() }
  }
  const stop = () => {
    if (isSettled()) return
    settled = true; endPlayback('cancel'); controller.abort(); release()
  }
  releaseOwnership = claimSpeechOutput(() => { stop(); onSuperseded() })
  if (!isSettled()) void start()
  return stop
}
