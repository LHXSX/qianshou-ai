import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostPluginSampleWorkbench } from '../src/private-plugin-sample-workbench.ts'
import { parsePluginDraftSpec, type LocalPluginDraft } from '../src/plugin-draft.ts'
import { pluginDraftPlanManifest } from '../src/plugin-draft-preview.ts'

afterEach(() => vi.useRealTimers())

function setup(run: (input: unknown, signal: AbortSignal) => Promise<unknown> | unknown) {
  const spec = parsePluginDraftSpec({ pluginId: 'creator.sample-boundary', version: '1.0.0',
    displayName: 'Sample boundary', operations: [{ id: 'tool.echo', title: 'Echo',
      description: 'Host-owned sample operation.', binding: { kind: 'tool', ref: 'host:echo' },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } },
        required: ['value'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } },
        required: ['value'], additionalProperties: false },
      permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
      resources: { platforms: [process.platform], architectures: [process.arch],
        minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 4096,
        maxOutputBytes: 4096, maxRunMs: 1000 } }] })
  const draft: LocalPluginDraft = { id: 'plugin_draft_00000000-0000-0000-0000-000000000333',
    createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString(),
    state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
  const plan = pluginDraftPlanManifest(draft).operations[0]!
  const workbench = new HostPluginSampleWorkbench({ platform: process.platform, architecture: process.arch })
  const dispose = workbench.register({ contract: { adapterId: 'host.echo', adapterVersion: '1.0.0',
    operationId: 'tool.echo', bindingKind: 'tool', bindingRef: 'host:echo',
    inputSchemaSha256: plan.inputSchemaSha256, outputSchemaSha256: plan.outputSchemaSha256,
    permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
    resources: spec.operations[0]!.resources, assets: [], validUntilMs: Date.now() + 60_000 }, run })
  return { workbench, draft, dispose }
}

describe('Host sample cancellation and partial-claim cleanup', () => {
  it('keeps different operations of one adapter generation from overlapping', async () => {
    let finish!: (value: unknown) => void
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const { workbench, draft, dispose } = setup(input => {
      if ((input as { value: string }).value !== 'hold') return input
      started()
      return new Promise(resolve => { finish = resolve })
    })
    const first = draft.spec.operations[0]!
    const second = { ...first, id: 'tool.second', title: 'Second', binding: { kind: 'tool', ref: 'host:second' } }
    const multi = { ...draft, spec: parsePluginDraftSpec({ ...draft.spec, operations: [first, second] }) }
    const plan = pluginDraftPlanManifest(multi).operations.find(item => item.id === second.id)!
    const unload = workbench.register({ contract: { adapterId: 'host.echo', adapterVersion: '1.0.0',
      operationId: second.id, bindingKind: 'tool', bindingRef: 'host:second',
      inputSchemaSha256: plan.inputSchemaSha256, outputSchemaSha256: plan.outputSchemaSha256,
      permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
      resources: second.resources, assets: [], validUntilMs: Date.now() + 60_000 }, run: input => input })
    const sampled = await workbench.runPrivateSamples(multi, [
      { operationId: first.id, input: { value: 'sample' } },
      { operationId: second.id, input: { value: 'second-sample' } },
    ], new AbortController().signal)
    const signal = new AbortController().signal
    const running = workbench.runPrivateOperation(multi, sampled.candidate,
      first.id, { value: 'hold' }, signal)
    await began
    await expect(workbench.runPrivateOperation(multi, sampled.candidate,
      second.id, { value: 'other' }, signal))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_PLUGIN_ADAPTER_BUSY' })
    finish({ value: 'hold' })
    await expect(running).resolves.toEqual({ value: 'hold' })
    unload()
    dispose()
  })

  it('waits for callback cleanup on timeout so no work continues after rejection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-24T09:00:00.000Z'))
    let cleanupFinished = false
    const { workbench, draft, dispose } = setup((_input, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => setTimeout(() => {
        cleanupFinished = true
        resolve({ value: 'late' })
      }, 25), { once: true })
    }))
    const attempt = workbench.runPrivateSamples(draft, [{ operationId: 'tool.echo', input: { value: 'hello' } }],
      new AbortController().signal)
    let returned = false
    void attempt.finally(() => { returned = true }).catch(() => {})
    await vi.advanceTimersByTimeAsync(1000)
    expect(cleanupFinished).toBe(false)
    expect(returned).toBe(false)
    await vi.advanceTimersByTimeAsync(25)
    await expect(attempt).rejects.toThrow('COMPUTE_PLUGIN_SAMPLE_TIMEOUT')
    expect(cleanupFinished).toBe(true)
    expect(returned).toBe(true)
    dispose()
  })

  it('waits for callback cleanup after the owner aborts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-24T09:00:00.000Z'))
    let cleanupFinished = false
    const { workbench, draft, dispose } = setup((_input, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => setTimeout(() => {
        cleanupFinished = true
        resolve({ value: 'late' })
      }, 25), { once: true })
    }))
    const controller = new AbortController()
    const attempt = workbench.runPrivateSamples(draft, [{ operationId: 'tool.echo', input: { value: 'hello' } }],
      controller.signal)
    let returned = false
    void attempt.finally(() => { returned = true }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(returned).toBe(false)
    await vi.advanceTimersByTimeAsync(25)
    await expect(attempt).rejects.toThrow('COMPUTE_PLUGIN_SAMPLE_ABORTED')
    expect(cleanupFinished).toBe(true)
    expect(returned).toBe(true)
    dispose()
  })

  it('validates every input schema before invoking any adapter', async () => {
    let calls = 0
    const { workbench, draft, dispose } = setup(input => { calls += 1; return input })
    const first = draft.spec.operations[0]!
    const second = { ...first, id: 'tool.second', title: 'Second', binding: { kind: 'tool', ref: 'host:second' } }
    const spec = parsePluginDraftSpec({ ...draft.spec, operations: [first, second] })
    const multi = { ...draft, spec }
    const planned = pluginDraftPlanManifest(multi).operations.find(item => item.id === second.id)!
    const unload = workbench.register({ contract: { adapterId: 'host.second', adapterVersion: '1.0.0',
      operationId: second.id, bindingKind: 'tool', bindingRef: 'host:second',
      inputSchemaSha256: planned.inputSchemaSha256, outputSchemaSha256: planned.outputSchemaSha256,
      permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
      resources: second.resources, assets: [], validUntilMs: Date.now() + 60_000 },
    run: input => { calls += 1; return input } })
    await expect(workbench.runPrivateSamples(multi, [
      { operationId: first.id, input: { value: 'valid' } },
      { operationId: second.id, input: { value: 42 } },
    ], new AbortController().signal)).rejects.toThrow('COMPUTE_PLUGIN_SAMPLE_INPUT_SCHEMA_INVALID')
    expect(calls).toBe(0)
    unload()
    dispose()
  })

  it('rejects an invalid adapter output before recording any digest claim', async () => {
    let calls = 0
    const { workbench, draft, dispose } = setup(() => { calls += 1; return { unexpected: 'wrong output' } })
    await expect(workbench.runPrivateSamples(draft,
      [{ operationId: 'tool.echo', input: { value: 'hello' } }], new AbortController().signal))
      .rejects.toThrow('COMPUTE_PLUGIN_SAMPLE_OUTPUT_SCHEMA_INVALID')
    expect(calls).toBe(1)
    dispose()
  })

  it('revokes the first operation claim when a later Host adapter fails', async () => {
    const { workbench, draft, dispose } = setup(input => input)
    const first = draft.spec.operations[0]!
    const second = { ...first, id: 'tool.fail', title: 'Fail', binding: { kind: 'tool', ref: 'host:fail' } }
    const spec = parsePluginDraftSpec({ ...draft.spec, operations: [first, second] })
    const multi = { ...draft, spec }
    const planned = pluginDraftPlanManifest(multi).operations.find(item => item.id === second.id)!
    const unload = workbench.register({ contract: { adapterId: 'host.fail', adapterVersion: '1.0.0',
      operationId: second.id, bindingKind: 'tool', bindingRef: 'host:fail',
      inputSchemaSha256: planned.inputSchemaSha256, outputSchemaSha256: planned.outputSchemaSha256,
      permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
      resources: second.resources, assets: [], validUntilMs: Date.now() + 60_000 },
    run: () => { throw new Error('HOST_SAMPLE_FAIL') } })
    for (let index = 0; index < 513; index += 1) {
      await expect(workbench.runPrivateSamples(multi, [
        { operationId: first.id, input: { value: 'hello' } },
        { operationId: second.id, input: { value: 'hello' } },
      ], new AbortController().signal)).rejects.toThrow('HOST_SAMPLE_FAIL')
    }
    unload()
    dispose()
  })
})
