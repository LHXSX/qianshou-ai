/** Execute the shipped, fixed worklet source against a port boundary; no audio hardware. */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from '../src/client/capture-worklet.ts'

interface Worklet {
  process(inputs: Float32Array[][]): boolean
  port: { onmessage?: (event: { data: unknown }) => void }
}
function worklet(maximum: number) {
  const postMessage = vi.fn((_message: unknown, _transfer?: Transferable[]) => {})
  let registered: (new (options: { processorOptions: { maximum: number } }) => Worklet) | undefined
  class AudioWorkletProcessor { port = { postMessage, onmessage: undefined } }
  runInNewContext(CAPTURE_WORKLET_SOURCE, {
    AudioWorkletProcessor, Float32Array,
    registerProcessor(name: string, implementation: typeof registered) {
      expect(name).toBe(CAPTURE_PROCESSOR); registered = implementation
    },
  })
  if (registered === undefined) throw new Error('Worklet did not register')
  return { processor: new registered({ processorOptions: { maximum } }), postMessage }
}

describe('shipped audio worklet', () => {
  it('batches samples, flushes the partial tail once, and acknowledges only after its frames', () => {
    const b = worklet(48000)
    b.processor.process([[new Float32Array(2100).fill(0.25)]])
    expect(b.postMessage).toHaveBeenCalledTimes(1)
    expect(b.postMessage.mock.calls[0]?.[0]).toEqual(new Float32Array(2048).fill(0.25))
    b.processor.port.onmessage?.({ data: 'finish' })
    expect(b.postMessage.mock.calls[1]?.[0]).toEqual(new Float32Array(52).fill(0.25))
    expect(b.postMessage.mock.calls[2]?.[0]).toBe('done')
    b.processor.port.onmessage?.({ data: 'finish' }); expect(b.postMessage).toHaveBeenCalledTimes(3)
    expect(b.processor.process([[new Float32Array(128)]])).toBe(false)
  })

  it('bounds transfer bytes on the audio thread and signals the limit once', () => {
    const b = worklet(200)
    b.processor.process([[new Float32Array(400).fill(0.1)]])
    expect(b.postMessage.mock.calls[0]?.[0]).toEqual(new Float32Array(200).fill(0.1))
    expect(b.postMessage.mock.calls[1]?.[0]).toBe('limit')
    b.processor.process([[new Float32Array(400)]]); b.processor.process([])
    expect(b.postMessage).toHaveBeenCalledTimes(2)
    b.processor.port.onmessage?.({ data: 'finish' }); expect(b.postMessage.mock.calls[2]?.[0]).toBe('done')
  })
})
