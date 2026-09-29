import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeExecutorRegistry, type ComputeExecutor } from '../src/executor.ts'
import { ComputeLocalTaskRunner, type ComputeLocalTaskRequest } from '../src/local-task-runner.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const task: ComputeTaskEnvelope = { version: 'qianshou.task.v1', taskId: ComputeTaskId('task'), capabilityId: ComputeCapabilityId('test.copy'), capabilityVersion: '1.0',
  inputRefs: [{ name: 'input', bytes: 5, sha256: digest('hello') }], parameters: {}, deadlineAt: '2026-09-14T23:00:00.000Z', maxOutputBytes: 5, idempotencyKey: 'copy-1' }
async function setup(execute: ComputeExecutor['execute']) {
  const rootPath = await mkdtemp(join(tmpdir(), 'compute-local-runner-')); roots.push(rootPath)
  const registry = new ComputeExecutorRegistry()
  registry.register({ capabilityId: task.capabilityId, version: task.capabilityVersion, execute })
  const runner = new ComputeLocalTaskRunner(registry)
  const request: ComputeLocalTaskRequest<string> = {
    workspace: { rootPath, maxInputBytes: 5 }, signal: new AbortController().signal, reportProgress: vi.fn(),
    source: { open: async () => new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('hello')); controller.close() } }) },
    consumeResult: async result => readFile(result.outputs[0]!.path, 'utf8'),
  }
  return { runner, request, rootPath }
}

describe('owned local task execution', () => {
  it('stages input, executes the native contribution, verifies files and cleans after consumption', async () => {
    const { runner, request, rootPath } = await setup(async (_task, context) => {
      expect(context.interactionPolicy).toBe('autonomous')
      const value = await readFile(context.inputs[0]!.path, 'utf8')
      const path = join(context.workspacePath, 'result.txt')
      await writeFile(path, value)
      await context.reportProgress(1, 'done')
      return { outputs: [{ name: 'result', path, bytes: 5, sha256: digest(value) }] }
    })
    expect(await runner.run(task, request)).toBe('hello')
    expect(await readdir(rootPath)).toEqual([])
    expect(request.reportProgress).toHaveBeenCalledWith(1, 'done')
    await runner.close()
  })

  it('removes staged inputs on executor failure without invoking the result consumer', async () => {
    const { runner, request, rootPath } = await setup(async () => { throw new Error('model failed') })
    const consumeResult = vi.fn()
    await expect(runner.run(task, { ...request, consumeResult })).rejects.toThrow('model failed')
    expect(consumeResult).not.toHaveBeenCalled()
    expect(await readdir(rootPath)).toEqual([])
    await runner.close()
  })

  it('rejects an aggregate output overspend before any upload', async () => {
    const { runner, request, rootPath } = await setup(async () => ({ outputs: [{ name: 'too-big', path: 'missing', bytes: 6, sha256: digest('hello!') }] }))
    const consumeResult = vi.fn()
    await expect(runner.run(task, { ...request, consumeResult })).rejects.toThrow('COMPUTE_OUTPUT_LIMIT_EXCEEDED')
    expect(consumeResult).not.toHaveBeenCalled()
    expect(await readdir(rootPath)).toEqual([])
    await runner.close()
  })

  it('cleans verified files when the result transfer fails', async () => {
    const { runner, request, rootPath } = await setup(async (_task, context) => {
      const path = join(context.workspacePath, 'result')
      await writeFile(path, 'hello')
      return { outputs: [{ name: 'result', path, bytes: 5, sha256: digest('hello') }] }
    })
    await expect(runner.run(task, { ...request, consumeResult: async () => { throw new Error('upload failed') } })).rejects.toThrow('upload failed')
    expect(await readdir(rootPath)).toEqual([])
    await runner.close()
  })

  it('keeps files until the result consumer stops, then cancels and drains on close', async () => {
    const { runner, request, rootPath } = await setup(async (_task, context) => {
      const path = join(context.workspacePath, 'result')
      await writeFile(path, 'hello')
      return { outputs: [{ name: 'result', path, bytes: 5, sha256: digest('hello') }] }
    })
    let entered!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    let finish!: () => void
    const finishing = new Promise<void>((resolve) => { finish = resolve })
    let transferSignal: AbortSignal | undefined
    const pending = runner.run(task, { ...request, consumeResult: async (_result, signal) => { transferSignal = signal; entered(); await finishing; return 'receipt' } })
    const rejected = expect(pending).rejects.toThrow('COMPUTE_CLOSED')
    await ready
    expect((await readdir(rootPath)).length).toBe(1)
    let closed = false
    const closing = runner.close().then(() => { closed = true })
    expect(transferSignal?.aborted).toBe(true)
    expect(closed).toBe(false)
    await expect(runner.run(task, request)).rejects.toThrow('COMPUTE_CLOSED')
    finish()
    await rejected
    await closing
    expect(await readdir(rootPath)).toEqual([])
  })
})
