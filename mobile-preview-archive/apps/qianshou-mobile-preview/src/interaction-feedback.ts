/** Local interaction preferences and quiet procedural cues; never gate message delivery. */
export type InteractionPreference = 'sound' | 'voiceAutoSend'
const keys: Record<InteractionPreference, string> = {
  sound: 'qianshou.mobile.sound', voiceAutoSend: 'qianshou.mobile.voice-auto-send',
}
const volatilePreferences = new Map<InteractionPreference, boolean>()
export function interactionPreference(name: InteractionPreference): boolean {
  if (volatilePreferences.has(name)) return volatilePreferences.get(name)!
  try { const saved = localStorage.getItem(keys[name]); return saved === null ? name === 'sound' : saved === 'true' }
  catch { return name === 'sound' }
}
export function setInteractionPreference(name: InteractionPreference, value: boolean): void {
  try { localStorage.setItem(keys[name], String(value)); volatilePreferences.delete(name) }
  catch { volatilePreferences.set(name, value) }
}

export function createInteractionFeedback(): {
  unlock(): void
  play(cue: 'send' | 'receive' | 'record'): void
  close(): void
} {
  let audio: AudioContext | undefined
  let lastCueAt = 0
  let disposed = false
  const unlock = (): void => {
    if (disposed || !interactionPreference('sound')) return
    try {
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Constructor) return
      audio ??= new Constructor()
      if (audio.state === 'suspended') void audio.resume().catch(() => {})
    } catch { /* Unsupported audio must not affect conversation. */ }
  }
  return {
    unlock,
    play(cue) {
      if (disposed || !interactionPreference('sound') || document.visibilityState === 'hidden' || Date.now() - lastCueAt < 180) return
      unlock()
      if (!audio || audio.state !== 'running') return
      lastCueAt = Date.now()
      try {
        const at = audio.currentTime
        const oscillator = audio.createOscillator()
        const gain = audio.createGain()
        const start = cue === 'send' ? 680 : cue === 'receive' ? 960 : 440
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(start, at)
        oscillator.frequency.exponentialRampToValueAtTime(cue === 'send' ? 1020 : cue === 'receive' ? 720 : 600, at + .08)
        gain.gain.setValueAtTime(.0001, at)
        gain.gain.exponentialRampToValueAtTime(.035, at + .012)
        gain.gain.exponentialRampToValueAtTime(.0001, at + .13)
        oscillator.connect(gain); gain.connect(audio.destination)
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
        oscillator.start(at); oscillator.stop(at + .15)
      } catch { /* Optional sound cannot interrupt send or receive. */ }
    },
    close() { disposed = true; if (audio && audio.state !== 'closed') void audio.close().catch(() => {}); audio = undefined },
  }
}
