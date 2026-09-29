import { describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId } from '../src/protocol.ts'
import { ComputeExecutorRegistry } from '../src/executor.ts'
import { createLocalCapabilityPluginRuntime } from '../src/local-plugin-runtime.ts'

const manifest = {
  manifestVersion: 1,
  pluginId: 'qianshou.local-image',
  version: '1.0.0',
  displayName: 'Local image',
  hostRange: '*',
  pluginDigest: 'a'.repeat(64),
  capabilities: [{
    id: ComputeCapabilityId('image.generate'),
    version: '1.0.0',
    inputKinds: ['prompt'],
    outputKinds: ['image'],
    permissions: ['model.local'],
    dataScope: 'task-inputs',
  }],
} as const

const task = {
  version: 'qianshou.task.v1' as const,
  taskId: ComputeTaskId('local-plugin-task'),
  capabilityId: ComputeCapabilityId('image.generate'),
  capabilityVersion: '1.0.0',
  inputRefs: [],
  parameters: { prompt: 'a test image' },
  deadlineAt: '2026-09-20T12:00:00.000Z',
  maxOutputBytes: 1024,
  idempotencyKey: 'local-plugin-idempotency',
}

const context = () => ({
  signal: new AbortController().signal,
  workspacePath: '/tmp/qianshou-local-plugin',
  inputs: [],
  interactionPolicy: 'autonomous' as const,
  reportProgress: vi.fn(),
})

describe('local capability plugin runtime', () => {
  it('preflights an exact active executor and executes through the shared registry', async () => {
    const registry = new ComputeExecutorRegistry()
    const execute = vi.fn(async () => ({ outputs: [] }))
    const dispose = registry.register({ capabilityId: ComputeCapabilityId('image.generate'), version: '1.0.0', execute })
    const runtime = createLocalCapabilityPluginRuntime({ manifest, executors: registry })

    expect(runtime.preflight()).toMatchObject({
      pluginId: 'qianshou.local-image', state: 'ready',
      capabilities: [{ capabilityId: 'image.generate', version: '1.0.0', executorRegistered: true }],
      reasons: [],
    })
    await expect(runtime.execute(task, context())).resolves.toEqual({ outputs: [] })
    expect(execute).toHaveBeenCalledOnce()

    dispose()
    expect(runtime.preflight()).toMatchObject({ state: 'quarantined', reasons: ['COMPUTE_PLUGIN_EXECUTOR_MISMATCH'] })
    await expect(runtime.execute(task, context())).rejects.toMatchObject({ code: 'COMPUTE_PLUGIN_PREFLIGHT_FAILED' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('quarantines a manifest that is only executable remotely', () => {
    const registry = new ComputeExecutorRegistry()
    registry.register({ capabilityId: ComputeCapabilityId('image.generate'), version: '1.0.0', execute: async () => ({ outputs: [] }) })
    const remoteManifest = {
      ...manifest,
      contract: {
        contractVersion: 1 as const,
        runtime: 'remote' as const,
        entryId: 'image-generate',
        tools: [],
        dependencies: [],
        assets: [],
        budget: { maxBundleBytes: 0, maxDependencies: 0, maxAssets: 0, maxTools: 1 },
      },
    }
    const runtime = createLocalCapabilityPluginRuntime({ manifest: remoteManifest, executors: registry })
    expect(runtime.preflight()).toMatchObject({ state: 'quarantined', reasons: ['COMPUTE_LOCAL_PLUGIN_REMOTE_RUNTIME'] })
  })

  it('rejects malformed metadata before a runtime can be created', () => {
    expect(() => createLocalCapabilityPluginRuntime({
      manifest: { ...manifest, pluginDigest: 'bad' },
      executors: new ComputeExecutorRegistry(),
    })).toThrow('COMPUTE_PLUGIN_MANIFEST_INVALID')
  })
})
