/** Playback-only observations for visual consumers; never opens or samples a microphone. */
export type SpeechPlaybackEvent =
  | { readonly type: 'start'; readonly playbackId: number; readonly source: 'neural'; readonly element: HTMLAudioElement; readonly wav: ArrayBuffer }
  | { readonly type: 'start'; readonly playbackId: number; readonly source: 'system' }
  | { readonly type: 'end' | 'cancel' | 'error'; readonly playbackId: number }

type PlaybackSource =
  | { readonly source: 'neural'; readonly element: HTMLAudioElement; readonly wav: ArrayBuffer }
  | { readonly source: 'system' }
type PlaybackEnd = 'end' | 'cancel' | 'error'
const listeners = new Set<(event: SpeechPlaybackEvent) => void>()
let playbackId = 0
let current: Extract<SpeechPlaybackEvent, { type: 'start' }> | undefined

/**
 * Observe actual playback and synchronously replay its latest active start, without taking ownership.
 * @param listener - Presentation-only consumer; errors cannot interrupt speech.
 * @returns Idempotent unsubscription, with no audio or task side effects.
 */
export function subscribeSpeechPlayback(listener: (event: SpeechPlaybackEvent) => void): () => void {
  listeners.add(listener)
  if (current !== undefined) {
    try { listener(current) } catch { /* Initial visual state is optional, like subsequent observations. */ }
  }
  return () => { listeners.delete(listener) }
}

function publish(event: SpeechPlaybackEvent): void {
  for (const listener of listeners) {
    try { listener(event) } catch { /* Optional visualization must never break owned audio cleanup. */ }
  }
}

/**
 * Announce an actual media playing or system utterance start event.
 * @param source - Player and an independent WAV copy, or the system-voice marker.
 * @returns A once-only terminal event publisher for this playback identity.
 */
export function startSpeechPlayback(source: PlaybackSource): (type: PlaybackEnd) => void {
  const id = ++playbackId
  let ended = false
  current = { type: 'start', playbackId: id, ...source }
  publish(current)
  return (type) => {
    if (ended) return
    ended = true
    if (current?.playbackId === id) current = undefined
    publish({ type, playbackId: id })
  }
}
