/** Synthetic PCM verifies encoding and device cleanup; no hardware capture occurs. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeWav } from '../src/client/wav.ts'
import { openCapture, type CaptureOptions } from '../src/client/capture.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function microphone() {
  const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const stream = { getTracks: () => [track] }
  const port = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    close: vi.fn(), postMessage: vi.fn((_data: string) => { port.onmessage?.({ data: 'done' } as MessageEvent<unknown>) }) }
  const processor = { connect: vi.fn(), disconnect: vi.fn(), port, onprocessorerror: null as (() => void) | null }
  const addModule = vi.fn(async (_url: string) => {})
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const close = vi.fn(async () => {})
  class FakeContext {
    sampleRate = 48000
    state = 'running'
    destination = {}
    createMediaStreamSource = () => source
    audioWorklet = { addModule }
    createGain = () => gain
    resume = async () => {}
    close = close
  }
  const getUserMedia = vi.fn(async () => stream)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } }); vi.stubGlobal('AudioContext', FakeContext)
  function FakeWorkletNode() { return processor }
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  const createObjectURL = vi.fn(() => 'blob:worklet-module'); const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = createObjectURL; static override revokeObjectURL = revokeObjectURL })
  const feed = (samples: Float32Array): void => { port.onmessage?.({ data: samples } as MessageEvent<unknown>) }
  const abort = new AbortController()
  const options: CaptureOptions = { signal: abort.signal, maxDurationSeconds: 1, minDurationSeconds: 0.1,
    onLimit: vi.fn(), onLost: vi.fn() }
  return { track, stream, processor, port, source, gain, close, getUserMedia, feed, abort, options,
    addModule, createObjectURL, revokeObjectURL }
}

describe('PCM16 capture', () => {
  it('encodes the actual RIFF format, clipping and 48 kHz to 16 kHz duration', async () => {
    const wav = encodeWav(new Float32Array([2, 2, 2, -2, -2, -2]), 48000)
    const bytes = await wav.arrayBuffer(); const view = new DataView(bytes)
    expect(bytes.byteLength).toBe(48); expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(16000); expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16); expect(view.getUint32(40, true)).toBe(4)
    expect(view.getInt16(44, true)).toBe(32767); expect(view.getInt16(46, true)).toBe(-32768)
  })

  it('flushes on release once and stops every owned resource before returning WAV', async () => {
    const b = microphone(); const capture = await openCapture(b.options)
    b.feed(new Float32Array(4800).fill(0.2))
    const wav = await capture.finish()
    expect(wav?.size).toBe(3244); expect(await capture.finish()).toBeNull()
    expect(b.track.stop).toHaveBeenCalledOnce(); expect(b.close).toHaveBeenCalledOnce()
    expect(b.source.disconnect).toHaveBeenCalledOnce(); expect(b.port.onmessage).toBeNull()
    expect(b.port.close).toHaveBeenCalledOnce(); expect(b.port.postMessage).toHaveBeenCalledWith('finish')
    expect(b.addModule).toHaveBeenCalledWith('blob:worklet-module'); expect(b.revokeObjectURL).toHaveBeenCalledOnce()
    await capture.cancel(); expect(b.track.stop).toHaveBeenCalledOnce()
  })

  it('discards short recordings and cancelled buffers', async () => {
    const b = microphone(); const capture = await openCapture(b.options)
    b.feed(new Float32Array(10)); expect(await capture.finish()).toBeNull()
    const second = await openCapture(b.options); b.feed(new Float32Array(4800)); await second.cancel()
    expect(await second.finish()).toBeNull(); expect(b.track.stop).toHaveBeenCalledTimes(2)
  })

  it('stops late permissions without constructing an AudioContext', async () => {
    const b = microphone(); const permission = Promise.withResolvers<typeof b.stream>()
    b.getUserMedia.mockReturnValueOnce(permission.promise)
    const acquiring = openCapture(b.options); b.abort.abort(); permission.resolve(b.stream)
    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' })
    expect(b.track.stop).toHaveBeenCalledOnce(); expect(b.close).not.toHaveBeenCalled()
  })

  it('enforces sample and elapsed duration bounds, and abort releases live tracks', async () => {
    vi.useFakeTimers(); const b = microphone(); const capture = await openCapture(b.options)
    b.feed(new Float32Array(49000).fill(0.2)); expect(b.options.onLimit).toHaveBeenCalledOnce()
    const wav = await capture.finish(); expect(wav?.size).toBe(32044)
    expect(vi.getTimerCount()).toBe(0)
    const next = await openCapture(b.options); b.abort.abort(); await next.cancel()
    expect(b.port.onmessage).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  })

  it('does not send entirely zero or nonfinite PCM to recognition', async () => {
    const b = microphone(); const silent = await openCapture(b.options)
    b.feed(new Float32Array(4800)); await expect(silent.finish()).rejects.toThrow('NO_AUDIO')
    const invalid = await openCapture(b.options); b.feed(new Float32Array(4800).fill(Number.NaN))
    await expect(invalid.finish()).rejects.toThrow('INVALID_CAPTURE')
    expect(b.track.stop).toHaveBeenCalledTimes(2)
  })

  it('releases tracks, context and module URL when cancelled during worklet loading', async () => {
    const b = microphone(); const loading = Promise.withResolvers<undefined>()
    b.addModule.mockReturnValueOnce(loading.promise)
    const acquiring = openCapture(b.options); await Promise.resolve()
    b.abort.abort(); expect(b.track.stop).toHaveBeenCalledOnce()
    expect(b.revokeObjectURL).toHaveBeenCalledOnce()
    loading.resolve(undefined); await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' })
    expect(b.close).toHaveBeenCalledOnce(); expect(b.source.connect).not.toHaveBeenCalled()
  })

  it('flushes a final partial frame before returning, and cancellation interrupts a pending flush', async () => {
    const b = microphone(); const capture = await openCapture(b.options)
    b.feed(new Float32Array(4096).fill(0.2))
    b.port.postMessage.mockImplementationOnce(() => {})
    const finishing = capture.finish(); expect(await capture.finish()).toBeNull()
    b.feed(new Float32Array(704).fill(0.2)); b.port.onmessage?.({ data: 'done' } as MessageEvent<unknown>)
    expect((await finishing)?.size).toBe(3244)
    const next = await openCapture(b.options); b.port.postMessage.mockImplementationOnce(() => {})
    const pending = next.finish(); await next.cancel(); expect(await pending).toBeNull()
    expect(b.track.stop).toHaveBeenCalledTimes(2)
  })

  it('fails a missing flush acknowledgement instead of accepting incomplete audio', async () => {
    vi.useFakeTimers(); const b = microphone(); const capture = await openCapture(b.options)
    b.feed(new Float32Array(4800).fill(0.2)); b.port.postMessage.mockImplementationOnce(() => {})
    const pending = capture.finish(); const rejected = expect(pending).rejects.toThrow('INVALID_CAPTURE')
    await vi.advanceTimersByTimeAsync(1500); await rejected
    expect(b.track.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })

})
