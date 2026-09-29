// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMicrophone } from '../src/client/chat/voice/audio.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function audioBrowser(echoCancellation: boolean | undefined = true) {
  const track = {
    enabled: true, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getSettings: (): { echoCancellation: boolean | undefined } => ({ echoCancellation }),
  }
  const processor = {
    connect: vi.fn(), disconnect: vi.fn(),
    onaudioprocess: null as null | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void),
  }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const close = vi.fn(async () => {}); const resume = vi.fn(async () => {})
  vi.stubGlobal('AudioContext', class {
    sampleRate = 16000
    destination = {}
    createMediaStreamSource() { return source }
    createScriptProcessor() { return processor }
    createGain() { return gain }
    close = close
    resume = resume
  })
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  return { track, processor, source, close, resume, getUserMedia }
}

describe('owned voice microphone', () => {
  it('mutes input tracks when paused and releases the owned graph on close', async () => {
    const { track, source, close } = audioBrowser()
    const capture = await openMicrophone(vi.fn(), vi.fn())
    capture.listen(true); expect(track.enabled).toBe(true)
    capture.listen(false); expect(track.enabled).toBe(false)
    capture.listen(true); expect(track.enabled).toBe(true)
    capture.close(); capture.close()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(source.disconnect).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    capture.listen(false)
    expect(track.enabled).toBe(true)
  })

  it('mutes recording while a completed utterance is transcribed', async () => {
    const { track, processor } = audioBrowser()
    const onSegment = vi.fn()
    const capture = await openMicrophone(onSegment, vi.fn())
    capture.listen(true)
    for (let i = 0; i < 8; i++) processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(.15) } })
    for (let i = 0; i < 14; i++) processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600) } })
    expect(onSegment).toHaveBeenCalledOnce()
    expect(track.enabled).toBe(false)
    capture.close()
  })

  it('stops the acquired microphone if the audio context cannot start', async () => {
    const { track, resume, close } = audioBrowser()
    resume.mockRejectedValueOnce(new Error('audio context denied'))
    await expect(openMicrophone(vi.fn(), vi.fn())).rejects.toThrow('audio context denied')
    expect(track.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  })

  it('keeps playback capture with confirmed AEC and preserves the first word through interruption', async () => {
    const { track, processor, getUserMedia } = audioBrowser()
    const onSegment = vi.fn(); const onBargeIn = vi.fn()
    const capture = await openMicrophone(onSegment, vi.fn(), onBargeIn)
    capture.listen(true); capture.monitorPlayback()
    expect(capture.bargeInAvailable).toBe(true)
    expect(track.enabled).toBe(true)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const frame = (amplitude: number) => Float32Array.from(
      { length: 1600 }, (_, index) => amplitude * Math.sin(2 * Math.PI * 220 * index / 16000),
    )
    const feed = (amplitude: number) => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(amplitude) } })
    for (let i = 0; i < 5; i++) feed(0)
    feed(0.06); feed(0.12)
    expect(onBargeIn).not.toHaveBeenCalled()
    feed(0.12)
    expect(onBargeIn).toHaveBeenCalledOnce()
    expect(onSegment).not.toHaveBeenCalled()
    for (let i = 0; i < 5; i++) feed(0.12)
    for (let i = 0; i < 14; i++) feed(0)
    expect(onSegment).toHaveBeenCalledOnce()
    expect(track.enabled).toBe(false)
    const wav = onSegment.mock.calls[0]![0] as Blob
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { resolve(reader.result as ArrayBuffer) }
      reader.onerror = () => { reject(reader.error ?? new Error('WAV read failed')) }
      reader.readAsArrayBuffer(wav)
    })
    const pcm = new Int16Array(bytes, 44)
    expect(pcm.find(sample => sample !== 0)).toBe(Math.trunc(Math.sin(2 * Math.PI * 220 / 16000) * 0.06 * 32767))
    capture.close()
  })

  it.each([false, undefined])('keeps automatic interruption off without confirmed AEC: %s', async (setting) => {
    const { track, processor } = audioBrowser(setting)
    // Explicit undefined must remain unavailable rather than using the fixture default.
    track.getSettings = () => ({ echoCancellation: setting })
    const onSegment = vi.fn(); const onBargeIn = vi.fn()
    const capture = await openMicrophone(onSegment, vi.fn(), onBargeIn)
    capture.monitorPlayback()
    expect(capture.bargeInAvailable).toBe(false)
    expect(track.enabled).toBe(false)
    for (let i = 0; i < 20; i++) processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(0.2) } })
    expect(onSegment).not.toHaveBeenCalled(); expect(onBargeIn).not.toHaveBeenCalled()
    capture.listen(true)
    expect(track.enabled).toBe(true)
    capture.listen(false)
    expect(track.enabled).toBe(false)
    capture.close()
    expect(track.stop).toHaveBeenCalledOnce()
  })
})
