// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeAvatarAudio, observeAvatarSpeech, type AvatarAudioFrame } from '../src/client/chat/voice/avatar-audio.ts'
import { startSpeechPlayback } from '../src/client/chat/voice/speech-playback.ts'

function pcm(frequency = 1200, amplitude = 0.1): AudioBuffer {
  const samples = Float32Array.from({ length: 16_000 }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / 16_000))
  return {
    sampleRate: 16_000, length: samples.length, duration: 1, numberOfChannels: 1,
    getChannelData: () => samples,
    copyFromChannel: (destination) => { destination.set(samples.subarray(0, destination.length)) },
    copyToChannel: (source) => { samples.set(source.subarray(0, samples.length)) },
  }
}

function player() {
  return { currentTime: 0.05, paused: false, ended: false, muted: false, volume: 1, readyState: 4 } as HTMLAudioElement
}

describe('audio-reactive mouth estimates', () => {
  it('keeps real silence, low energy and an exhausted playback buffer closed', () => {
    expect(analyzeAvatarAudio(pcm(450, 0), 0.2)).toEqual({ pose: 'closed', openness: 0 })
    expect(analyzeAvatarAudio(pcm(450, 0.001), 0.2).pose).toBe('closed')
    expect(analyzeAvatarAudio(pcm(), 2).pose).toBe('closed')
  })
  it('uses both energy and spectral content instead of a timer or the spoken text', () => {
    expect(analyzeAvatarAudio(pcm(450), 0.2).pose).toBe('o')
    expect(analyzeAvatarAudio(pcm(1200), 0.2).pose).toBe('a')
    expect(analyzeAvatarAudio(pcm(2600), 0.2).pose).toBe('e')
    expect(analyzeAvatarAudio(pcm(1200, 0.2), 0.2).openness).toBeGreaterThan(analyzeAvatarAudio(pcm(1200, 0.04), 0.2).openness)
  })
})

describe('portrait playback lifecycle', () => {
  const disposers: Array<() => void> = []
  const terminals: Array<ReturnType<typeof startSpeechPlayback>> = []
  let frames: Map<number, FrameRequestCallback>
  let sequence: number
  let decode: ReturnType<typeof vi.fn<(data: ArrayBuffer) => Promise<AudioBuffer>>>
  let seen: AvatarAudioFrame[]
  const start = (element = player()) => {
    const finish = startSpeechPlayback({ source: 'neural', element, wav: new ArrayBuffer(4) })
    terminals.push(finish)
    return { element, finish }
  }
  const observe = () => {
    const dispose = observeAvatarSpeech(frame => seen.push(frame))
    disposers.push(dispose)
    return dispose
  }
  const tick = (time: number) => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => { callback(time) })
  }
  beforeEach(() => {
    seen = []; frames = new Map(); sequence = 0
    decode = vi.fn().mockResolvedValue(pcm())
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  })
  afterEach(() => {
    disposers.splice(0).forEach((dispose) => { dispose() })
    terminals.splice(0).forEach((finish) => { finish('cancel') })
    vi.unstubAllGlobals()
  })
  it('reads the actual media time and immediately closes on silence, pause, mute and cancel', async () => {
    const audio = pcm()
    audio.getChannelData(0).fill(0, 8000)
    decode.mockResolvedValue(audio)
    observe()
    const { element, finish } = start()
    await Promise.resolve()
    tick(100)
    expect(seen.at(-1)).toMatchObject({ mode: 'audio', pose: 'a' })
    element.currentTime = 0.6
    tick(140)
    expect(seen.at(-1)?.pose).toBe('closed')
    element.currentTime = 0.1; Object.assign(element, { paused: true })
    tick(180)
    expect(seen.at(-1)?.pose).toBe('closed')
    Object.assign(element, { paused: false, muted: true })
    tick(220)
    expect(seen.at(-1)?.pose).toBe('closed')
    Object.assign(element, { muted: false })
    tick(260)
    finish('cancel')
    expect(seen.at(-1)).toEqual({ mode: 'idle', pose: 'closed', openness: 0 })
    expect(frames.size).toBe(0)
  })
  it('suppresses delayed decoding after cancellation and after a new playback replaces it', async () => {
    let resolve!: (audio: AudioBuffer) => void
    decode.mockImplementationOnce(() => new Promise((result) => { resolve = result }))
    observe()
    const first = start()
    first.finish('cancel')
    const second = start()
    await Promise.resolve()
    tick(100)
    expect(seen.at(-1)?.pose).toBe('a')
    resolve(pcm(450))
    await Promise.resolve()
    second.element.currentTime += 0.04
    tick(140)
    expect(seen.at(-1)?.pose).toBe('a')
    expect(frames.size).toBe(1)
  })
  it('replays a current neural chunk when the portrait mounts mid-playback', async () => {
    const { element } = start()
    element.currentTime = 0.3
    observe()
    expect(seen.at(-1)?.mode).toBe('loading')
    await Promise.resolve()
    tick(100)
    expect(seen.at(-1)?.pose).toBe('a')
  })
  it('does not let an older playback terminal close a newer speaking chunk', async () => {
    observe()
    const first = start()
    const second = start()
    await Promise.resolve()
    tick(100)
    first.finish('end')
    second.element.currentTime += 0.04
    tick(140)
    expect(seen.at(-1)).toMatchObject({ mode: 'audio', pose: 'a' })
    expect(frames.size).toBe(1)
  })
  it('keeps system voices and decode failures static without creating frames or touching playback', async () => {
    observe()
    const finishSystem = startSpeechPlayback({ source: 'system' })
    terminals.push(finishSystem)
    expect(seen.at(-1)).toEqual({ mode: 'system', pose: 'closed', openness: 0 })
    expect(decode).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    finishSystem('end')
    decode.mockRejectedValue(new Error('unsupported audio'))
    start()
    await Promise.resolve()
    expect(seen.at(-1)?.mode).toBe('unavailable')
    expect(frames.size).toBe(0)
  })
  it('closes a stalled media time and stops every frame on disposal, even if an old callback runs', async () => {
    const dispose = observe()
    start()
    await Promise.resolve()
    tick(100)
    tick(250)
    expect(seen.at(-1)?.pose).toBe('closed')
    const queued = [...frames.values()][0]!
    dispose()
    const length = seen.length
    queued(300)
    expect(seen).toHaveLength(length)
    expect(frames.size).toBe(0)
  })
})
