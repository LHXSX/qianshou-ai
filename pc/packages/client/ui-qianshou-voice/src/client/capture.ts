/** Explicitly owned, bounded, single-utterance browser capture. */
import { encodeWav } from './wav.ts'
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from './capture-worklet.ts'

/** Capture finishes exactly once; cancellation never returns buffered audio. */
export interface VoiceCapture {
  finish(): Promise<Blob | null>
  cancel(): Promise<void>
}

/** Limits supplied by the actual Host status response. */
export interface CaptureOptions {
  readonly signal: AbortSignal
  readonly maxDurationSeconds: number
  readonly minDurationSeconds: number
  readonly onLimit: () => void
  readonly onLost: () => void
}

/**
 * Acquire the microphone only for an explicit live user gesture.
 * @param options - Cancellation, duration bounds, and device/limit callbacks.
 * @returns A single-use capture; late permission results are stopped before use.
 */
export async function openCapture(options: CaptureOptions): Promise<VoiceCapture> {
  options.signal.throwIfAborted()
  const devices = (navigator as { mediaDevices?: { getUserMedia?: MediaDevices['getUserMedia'] } }).mediaDevices
  if (devices?.getUserMedia === undefined || typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
    throw new Error('CAPTURE_UNAVAILABLE')
  }
  const stream = await devices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } })
  if (options.signal.aborted) {
    for (const track of stream.getTracks()) track.stop()
    options.signal.throwIfAborted()
  }
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: AudioWorkletNode | undefined
  let gain: GainNode | undefined
  let frames: Float32Array[] = []
  let count = 0
  let nonzero = false
  let invalid = false
  let closed = false
  let finishing = false
  let limited = false
  let closePromise: Promise<void> | undefined
  let moduleUrl: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let settleFlush: ((done: boolean) => void) | undefined
  const isClosed = (): boolean => closed
  const lost = (): void => { if (!closed) options.onLost() }
  const revokeModule = (): void => {
    if (moduleUrl === undefined) return
    URL.revokeObjectURL(moduleUrl); moduleUrl = undefined
  }
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    settleFlush?.(false); settleFlush = undefined
    options.signal.removeEventListener('abort', abort)
    if (processor !== undefined) {
      processor.port.onmessage = null; processor.port.close(); processor.onprocessorerror = null
    }
    source?.disconnect(); processor?.disconnect(); gain?.disconnect()
    revokeModule()
    for (const track of stream.getTracks()) { track.removeEventListener('ended', lost); track.stop() }
    frames = []
    const closingContext = context
    closePromise = closingContext === undefined || closingContext.state === 'closed'
      ? Promise.resolve() : Promise.resolve().then(() => closingContext.close())
    return closePromise
  }
  const abort = (): void => {
    void close().catch(() => { /* Tracks are stopped; their context may have closed with the document. */ })
  }
  const limit = (): void => {
    if (closed || limited) return
    limited = true; options.onLimit()
  }
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    context = new AudioContext()
    const rate = context.sampleRate
    const maximum = Math.floor(rate * options.maxDurationSeconds)
    moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }))
    await context.audioWorklet.addModule(moduleUrl)
    revokeModule()
    options.signal.throwIfAborted()
    source = context.createMediaStreamSource(stream)
    processor = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { maximum },
    })
    gain = context.createGain(); gain.gain.value = 0
    processor.port.onmessage = (event: MessageEvent<unknown>) => {
      if (closed) return
      if (event.data === 'done') { settleFlush?.(true); return }
      if (event.data === 'limit') { limit(); return }
      if (!(event.data instanceof Float32Array)) { lost(); return }
      const available = Math.min(event.data.length, maximum - count)
      if (available > 0) {
        const frame = event.data.subarray(0, available)
        for (const sample of frame) { if (!Number.isFinite(sample)) invalid = true; if (sample !== 0) nonzero = true }
        frames.push(frame); count += available
      }
      if (count >= maximum) limit()
    }
    const activeProcessor = processor
    processor.onprocessorerror = lost
    for (const track of stream.getTracks()) track.addEventListener('ended', lost)
    source.connect(processor); processor.connect(gain); gain.connect(context.destination)
    await context.resume()
    options.signal.throwIfAborted()
    timer = setTimeout(limit, options.maxDurationSeconds * 1000)
    return {
      async finish() {
        if (closed || finishing) return null
        finishing = true
        const flushed = new Promise<boolean>((resolve) => { settleFlush = resolve })
        flushTimer = setTimeout(() => { settleFlush?.(false) }, 1500)
        activeProcessor.port.postMessage('finish')
        const done = await flushed
        if (isClosed()) { await close(); return null }
        const captured = frames
        const length = count
        await close()
        if (!done) {
          if (options.signal.aborted) return null
          throw new Error('INVALID_CAPTURE')
        }
        if (length < Math.ceil(rate * options.minDurationSeconds)) return null
        if (invalid) throw new Error('INVALID_CAPTURE')
        if (!nonzero) throw new Error('NO_AUDIO')
        const samples = new Float32Array(length)
        let offset = 0
        for (const frame of captured) { samples.set(frame, offset); offset += frame.length }
        return encodeWav(samples, rate)
      },
      cancel: close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
