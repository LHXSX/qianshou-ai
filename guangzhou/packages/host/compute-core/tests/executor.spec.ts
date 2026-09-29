import { describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { ComputeExecutorRegistry, type ComputeExecutionContext } from '../src/executor.ts'

const task = {
  version: 'qianshou.task.v1' as const, taskId: 'task-1' as never, capabilityId: ComputeCapabilityId('image.batch'), capabilityVersion: '1.0.0',
  inputRefs: [], parameters: {}, deadlineAt: '2026-09-14T12:00:00.000Z', maxOutputBytes: 1024, idempotencyKey: 'idem-1',
}

describe('local executor registry', () => {
  it('selects an exact plugin version, reports monotonic progress, and disposes independently', async () => {
    const registry = new ComputeExecutorRegistry()
    const report = vi.fn()
    const execute = vi.fn(async (_task: never, context: ComputeExecutionContext) => {
      await context.reportProgress(0.5, 'render')
      await context.reportProgress(1, 'done')
      return { outputs: [{ name: 'out.png', path: 'out.png', bytes: 1, sha256: 'b'.repeat(64) }] }
    })
    const dispose = registry.register({ capabilityId: ComputeCapabilityId('image.batch'), version: '1.0.0', execute })
    await expect(registry.execute(task, { signal: new AbortController().signal, workspacePath: '/tmp/task-1', inputs: [], interactionPolicy: 'autonomous', reportProgress: report })).resolves.toMatchObject({ outputs: [{ name: 'out.png' }] })
    expect(report).toHaveBeenNthCalledWith(1, 0.5, 'render')
    expect(report).toHaveBeenNthCalledWith(2, 1, 'done')
    dispose()
    expect(() => registry.resolve(ComputeCapabilityId('image.batch'), '1.0.0')).toThrow('COMPUTE_EXECUTOR_UNAVAILABLE')
  })

  it('rejects duplicate versions and non-monotonic progress', async () => {
    const registry = new ComputeExecutorRegistry()
    const executor = { capabilityId: ComputeCapabilityId('h3'), version: '1.0.0', execute: async (_task: never, context: { reportProgress: (progress: number, phase: string) => void | Promise<void> }) => {
      await context.reportProgress(0.8, 'run'); await context.reportProgress(0.2, 'run'); return { outputs: [] }
    } }
    registry.register(executor)
    expect(() => registry.register(executor)).toThrow('COMPUTE_EXECUTOR_DUPLICATE')
    await expect(registry.execute({ ...task, capabilityId: ComputeCapabilityId('h3') }, { signal: new AbortController().signal, workspacePath: '/tmp/task-1', inputs: [], interactionPolicy: 'autonomous', reportProgress: () => {} })).rejects.toThrow('COMPUTE_PROGRESS_INVALID')
  })

  it('requires the autonomous worker policy before invoking a plugin', async () => {
    const registry = new ComputeExecutorRegistry()
    const execute = vi.fn(async () => ({ outputs: [] }))
    registry.register({ capabilityId: ComputeCapabilityId('image.batch'), version: '1.0.0', execute })
    await expect(registry.execute(task, { signal: new AbortController().signal, workspacePath: '/tmp/task-1', inputs: [], interactionPolicy: 'blocked' as never, reportProgress: () => {} })).rejects.toThrow('COMPUTE_HUMAN_INTERACTION_FORBIDDEN')
    expect(execute).not.toHaveBeenCalled()
  })
})
