import { describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { createInjectedLocalModelAdapter, type LocalModelDescriptor, type LocalModelObservation } from '../src/model-adapter.ts'

const descriptor: LocalModelDescriptor = {
  modelId: 'z-ming', modelVersion: '1.0.0', capabilityId: ComputeCapabilityId('image.generate'),
  displayName: 'z-ming local image', runtime: 'injected', localOnly: true,
  supportsStreaming: true, supportsCancellation: true,
}

const ready: LocalModelObservation = {
  state: 'ready', available: true, checks: [{ id: 'weights', status: 'pass' }, { id: 'probe', status: 'pass' }],
  reasonCodes: [], observedAt: '2026-09-20T00:00:00.000Z',
}

describe('injected local model adapter', () => {
  it('rejects descriptors without a stable capability identity', () => {
    try {
      createInjectedLocalModelAdapter({
        descriptor: { ...descriptor, capabilityId: '' as typeof descriptor.capabilityId },
        invoke: async () => 'unused',
      })
      throw new Error('expected descriptor rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'COMPUTE_MODEL_DESCRIPTOR_INVALID' })
    }
  })

  it('does not claim a model is available without an executable preflight', async () => {
    const invoke = vi.fn(async () => 'model-output')
    const adapter = createInjectedLocalModelAdapter({ descriptor, invoke, stream: async function* () {}, cancel: vi.fn() })
    await expect(adapter.preflight()).resolves.toMatchObject({ state: 'unavailable', available: false })
    await expect(adapter.invoke('request', { executionId: 'one', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'COMPUTE_MODEL_UNAVAILABLE' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('requires passing checks before invoke and passes only the guarded signal to the runner', async () => {
    const signals: AbortSignal[] = []
    const invoke = vi.fn(async (_request: string, context: { signal: AbortSignal }) => { signals.push(context.signal); return 'ok' })
    const adapter = createInjectedLocalModelAdapter({ descriptor, preflight: async () => ready, invoke, stream: async function* () {} , cancel: vi.fn() })
    await expect(adapter.invoke('request', { executionId: 'one', signal: new AbortController().signal })).resolves.toBe('ok')
    expect(invoke).toHaveBeenCalledOnce()
    expect(signals[0]).not.toBeUndefined()
    expect(signals[0]).not.toBe(({} as { signal?: AbortSignal }).signal)
  })

  it('quarantines contradictory or failed observations instead of advertising ready', async () => {
    const adapter = createInjectedLocalModelAdapter({
      descriptor,
      preflight: async () => ({ ...ready, checks: [{ id: 'weights', status: 'fail' }], state: 'ready', available: true }),
      invoke: async () => 'should-not-run',
      stream: async function* () {}, cancel: vi.fn(),
    })
    const report = await adapter.preflight()
    expect(report).toMatchObject({ state: 'unavailable', available: false })
    expect(report.reasonCodes).toContain('COMPUTE_MODEL_CHECK_FAILED')
  })

  it('cancels an active stream and forwards cancellation to the injected runner', async () => {
    const cancelled = vi.fn()
    const stream = async function* (_request: string, context: { signal: AbortSignal }) {
      yield 'first'
      await new Promise<void>(resolve => { context.signal.addEventListener('abort', () => resolve(), { once: true }) })
    }
    const adapter = createInjectedLocalModelAdapter({ descriptor, preflight: async () => ready, invoke: async () => 'unused', stream, cancel: cancelled })
    const iterator = adapter.stream('request', { executionId: 'stream-1', signal: new AbortController().signal })[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: 'first', done: false })
    const pending = iterator.next()
    await expect(adapter.cancel('stream-1')).resolves.toEqual({ cancelled: true })
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(cancelled).toHaveBeenCalledWith('stream-1')
    await expect(adapter.cancel('unknown')).resolves.toEqual({ cancelled: false })
  })

  it('recovery always performs a fresh preflight and keeps unavailable state honest', async () => {
    const recover = vi.fn()
    const adapter = createInjectedLocalModelAdapter({ descriptor, preflight: async () => ({ ...ready, available: false, state: 'unavailable', reasonCodes: ['NO_WEIGHTS'] }), invoke: async () => 'unused', stream: async function* () {}, cancel: vi.fn(), recover })
    await expect(adapter.recover()).resolves.toMatchObject({ outcome: 'still-unavailable', health: { available: false } })
    expect(recover).toHaveBeenCalledOnce()
  })

  it('cleans an execution reservation when its caller aborts during preflight', async () => {
    let release: (() => void) | undefined
    const preflight = () => new Promise<LocalModelObservation>(resolve => { release = () => resolve(ready) })
    const adapter = createInjectedLocalModelAdapter({ descriptor, preflight, invoke: async () => 'ok', stream: async function* () {}, cancel: vi.fn() })
    const controller = new AbortController()
    const pending = adapter.invoke('request', { executionId: 'aborted-preflight', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    release?.()
    await expect(adapter.invoke('request', { executionId: 'aborted-preflight', signal: new AbortController().signal })).resolves.toBe('ok')
  })
})
