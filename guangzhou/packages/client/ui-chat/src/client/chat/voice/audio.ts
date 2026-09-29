/** Browser-local speech segmentation. No audio leaves the page until a segment is complete. */
import { PlaybackSpeechGate } from './barge-in.ts'

export class SpeechSegmenter {
  private frames: Float32Array[] = []
  private preRoll: Float32Array[] = []
  private elapsed = 0
  private quiet = 0
  private voiced = 0
  private started = false
  private noise = 0.003

  /** Whether speech is currently buffered, used to avoid talking over the user. */
  get speaking(): boolean { return this.started }

  /** Clear all buffered audio between user turns, playback, and cancellation. */
  reset(): void {
    this.frames = []; this.preRoll = []; this.elapsed = 0; this.quiet = 0; this.voiced = 0; this.started = false
  }

  /**
   * Buffer sustained speech until a 1.1 second pause or the segment duration limit.
   * @param frame - The next mono audio frame.
   * @param sampleRate - Source audio samples per second.
   * @returns One completed utterance, or null while buffering or discarding noise.
   */
  push(frame: Float32Array, sampleRate: number): Float32Array | null {
    const seconds = frame.length / sampleRate
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length)
    const speech = rms > Math.max(0.012, this.noise * 3)
    if (!this.started) {
      if (!speech) this.noise = this.noise * 0.98 + Math.min(rms, 0.01) * 0.02
      this.preRoll.push(frame.slice())
      while (this.preRoll.length > Math.ceil(0.25 / seconds)) this.preRoll.shift()
      if (!speech) return null
      this.started = true
      this.frames = this.preRoll
      this.preRoll = []
    } else this.frames.push(frame.slice())
    this.elapsed += seconds
    if (speech) { this.voiced += seconds; this.quiet = 0 } else this.quiet += seconds
    if (this.quiet < 1.1 && this.elapsed < 115) return null
    if (this.voiced < 0.25) { this.reset(); return null }
    const result = new Float32Array(this.frames.reduce((sum, item) => sum + item.length, 0))
    let offset = 0
    for (const item of this.frames) { result.set(item, offset); offset += item.length }
    this.reset()
    return result
  }
}

/**
 * Encode mono samples as 16 kHz PCM16 WAV using box-filter downsampling.
 * @param samples - Source mono floating-point audio samples.
 * @param inputRate - Source samples per second.
 * @returns A WAV blob suitable for the local transcription endpoint.
 */
export function encodeWav(samples: Float32Array, inputRate: number): Blob {
  const rate = 16000
  const length = Math.floor(samples.length * rate / inputRate)
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const write = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * inputRate / rate)
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * inputRate / rate)))
    let sum = 0
    for (let j = start; j < end; j++) sum += samples[j] ?? 0
    const value = Math.max(-1, Math.min(1, sum / (end - start)))
    view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Owned microphone capture and local segmentation controls. */
export interface Microphone {
  /** Whether the acquired track confirms browser echo cancellation. */
  readonly bargeInAvailable: boolean
  /** Enable ordinary capture, or mute and discard buffered samples. */
  listen(enabled: boolean): void
  /** Monitor speech during playback only with confirmed echo cancellation; otherwise mute. */
  monitorPlayback(): void
  /** Whether a user utterance is being captured. */
  isVoicing(): boolean
  /** Release the stream, audio graph, and all buffers. */
  close(): void
}

/**
 * Open capture after an explicit user gesture; callers close it on stop or navigation.
 * @param onSegment - Receives a completed WAV segment with capture paused.
 * @param onLost - Reports the browser ending an owned input track.
 * @param onBargeIn - Stops owned playback after speech onset; capture continues with preserved pre-roll.
 * @returns Capture controls; permission or audio-graph failures reject after cleanup.
 */
export async function openMicrophone(
  onSegment: (audio: Blob) => void, onLost: () => void, onBargeIn: () => void = () => {},
): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let context: AudioContext | undefined
  try {
    const audioContext = new AudioContext()
    context = audioContext
    const source = audioContext.createMediaStreamSource(stream)
    // ScriptProcessor is retained as the broadly supported local PCM capture path,
    // including embedded WebViews. A zero-gain destination keeps the graph live without monitoring audio.
    const processor = context.createScriptProcessor(2048, 1, 1)
    const gain = context.createGain()
    gain.gain.value = 0
    const segmenter = new SpeechSegmenter()
    const onset = new PlaybackSpeechGate()
    const bargeInAvailable = stream.getAudioTracks().some(track => track.getSettings().echoCancellation === true)
    let listening = false
    let playback = false
    let barging = false
    let closed = false
    let playbackUntil = 0
    const canCapture = () => listening && !closed
    processor.onaudioprocess = (event) => {
      if (!canCapture()) return
      const frame = event.inputBuffer.getChannelData(0)
      if (playback) {
        const buffered = onset.push(frame, audioContext.sampleRate)
        if (buffered === null) return
        playback = false; barging = true
        onBargeIn()
        if (!canCapture()) return
        for (const item of buffered) segmenter.push(item, audioContext.sampleRate)
        return
      }
      // Manual reply playback can also occur while voice mode is listening.
      // Discard it and its short speaker tail rather than transcribing ourselves.
      if (!barging && typeof window !== 'undefined' && window.speechSynthesis?.speaking) {
        playbackUntil = performance.now() + 500; segmenter.reset(); return
      }
      if (performance.now() < playbackUntil) return
      const complete = segmenter.push(frame, audioContext.sampleRate)
      if (complete === null) return
      listening = false
      for (const track of stream.getAudioTracks()) track.enabled = false
      onSegment(encodeWav(complete, audioContext.sampleRate))
    }
    const lost = () => { if (!closed) onLost() }
    for (const track of stream.getTracks()) track.addEventListener('ended', lost)
    source.connect(processor); processor.connect(gain); gain.connect(context.destination)
    await context.resume()
    return {
      bargeInAvailable,
      listen(enabled) {
        if (closed) return
        listening = enabled; playback = false; barging = false; segmenter.reset(); onset.reset()
        for (const track of stream.getAudioTracks()) track.enabled = enabled
      },
      monitorPlayback() {
        if (closed) return
        listening = bargeInAvailable; playback = bargeInAvailable; barging = false
        segmenter.reset(); onset.reset(); playbackUntil = 0
        for (const track of stream.getAudioTracks()) track.enabled = listening
      },
      isVoicing() { return listening && segmenter.speaking },
      close() {
        if (closed) return
        closed = true; listening = false; playback = false; segmenter.reset(); onset.reset(); processor.onaudioprocess = null
        source.disconnect(); processor.disconnect(); gain.disconnect()
        for (const track of stream.getTracks()) { track.removeEventListener('ended', lost); track.stop() }
        void audioContext.close()
      },
    }
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    if (context !== undefined) void context.close()
    throw error
  }
}
