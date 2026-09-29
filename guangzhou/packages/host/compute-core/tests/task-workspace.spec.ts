import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { prepareTaskWorkspace, type ComputeTaskInputSource } from '../src/task-workspace.ts'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function root() { const path = await mkdtemp(join(tmpdir(), 'compute-workspace-test-')); directories.push(path); return path }
function input(name: string, text: string) { return { name, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') } }
function task(inputs = [input('reference.png', 'hello')]): ComputeTaskEnvelope {
  return { version: 'qianshou.task.v1', taskId: ComputeTaskId('task'), capabilityId: ComputeCapabilityId('image'), capabilityVersion: '1.0',
    inputRefs: inputs, parameters: {}, deadlineAt: '2026-09-14T23:00:00.000Z', maxOutputBytes: 1024, idempotencyKey: 'task-1' }
}
function source(...chunks: string[]): ComputeTaskInputSource {
  return {
    open: async () => new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk))
        controller.close()
      },
    }),
  }
}
const signal = () => new AbortController().signal

describe('private task input staging', () => {
  it('verifies streamed input bytes and exposes only generated paths with private permissions', async () => {
    const path = await root()
    const workspace = await prepareTaskWorkspace({ rootPath: path, maxInputBytes: 5 }, task(), source('he', 'llo'), signal())
    expect(workspace.inputs).toHaveLength(1)
    expect(Object.isFrozen(workspace.inputs)).toBe(true)
    expect(await readFile(workspace.inputs[0]!.path, 'utf8')).toBe('hello')
    expect(workspace.inputs[0]!.path).toBe(join(workspace.path, 'input-0'))
    if (process.platform !== 'win32') {
      expect((await stat(workspace.path)).mode & 0o777).toBe(0o700)
      expect((await stat(workspace.inputs[0]!.path)).mode & 0o777).toBe(0o400)
    }
    const closing = workspace.close()
    expect(workspace.close()).toBe(closing)
    await closing
    expect(await readdir(path)).toEqual([])
  })

  it.each([
    ['short', ['hell'], 'COMPUTE_INPUT_SIZE_MISMATCH'],
    ['long', ['hello!'], 'COMPUTE_INPUT_SIZE_MISMATCH'],
    ['altered', ['jello'], 'COMPUTE_INPUT_DIGEST_MISMATCH'],
  ])('cleans up a %s input before any executor sees it', async (_name, chunks, code) => {
    const path = await root()
    await expect(prepareTaskWorkspace({ rootPath: path, maxInputBytes: 5 }, task(), source(...chunks), signal())).rejects.toThrow(code)
    expect(await readdir(path)).toEqual([])
  })

  it('rejects aggregate excess and duplicate logical names before opening a source', async () => {
    const path = await root()
    const open = vi.fn()
    await expect(prepareTaskWorkspace({ rootPath: path, maxInputBytes: 9 }, task([input('one', 'hello'), input('two', 'hello')]), { open }, signal())).rejects.toThrow('COMPUTE_INPUT_LIMIT_EXCEEDED')
    await expect(prepareTaskWorkspace({ rootPath: path, maxInputBytes: 10 }, task([input('one', 'hello'), input('one', 'hello')]), { open }, signal())).rejects.toThrow('COMPUTE_INPUT_NAME_DUPLICATE')
    expect(open).not.toHaveBeenCalled()
    expect(await readdir(path)).toEqual([])
  })

  it('cancels a stalled stream and removes partially staged inputs', async () => {
    const path = await root()
    const controller = new AbortController()
    const cancel = vi.fn()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const pending = prepareTaskWorkspace({ rootPath: path, maxInputBytes: 5 }, task(), {
      open: async () => new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('he')); started() }, cancel }),
    }, controller.signal)
    await ready
    controller.abort(new Error('task revoked'))
    await expect(pending).rejects.toThrow('task revoked')
    expect(cancel).toHaveBeenCalled()
    expect(await readdir(path)).toEqual([])
  })

  it('keeps input names opaque and never resolves them as paths', async () => {
    const path = await root()
    const workspace = await prepareTaskWorkspace({ rootPath: path, maxInputBytes: 0 }, task([input('..', '')]), source(''), signal())
    expect(workspace.inputs[0]!.name).toBe('..')
    expect(workspace.inputs[0]!.path).toBe(join(workspace.path, 'input-0'))
    await workspace.close()
  })

  it('unlinks a replaced workspace symlink without deleting its target', async () => {
    const path = await root()
    const elsewhere = await root()
    await writeFile(join(elsewhere, 'keep'), 'owner file')
    const workspace = await prepareTaskWorkspace({ rootPath: path, maxInputBytes: 0 }, task([]), source(), signal())
    await rename(workspace.path, workspace.path + '-moved')
    await symlink(elsewhere, workspace.path, 'junction')
    await workspace.close()
    expect(await readFile(join(elsewhere, 'keep'), 'utf8')).toBe('owner file')
  })
})
