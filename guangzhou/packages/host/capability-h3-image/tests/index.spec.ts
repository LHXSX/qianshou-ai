import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeExecutorRegistry, ComputeTaskId, type ComputeTaskEnvelope } from '@deepseek-ai/dsh-compute-core'
import { H3_IMAGE_REQUIRED_PERMISSIONS, buildH3Prompt, createH3ImageExecutor } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const task: ComputeTaskEnvelope = { version: 'qianshou.task.v1', taskId: ComputeTaskId('h3-task'), capabilityId: ComputeCapabilityId('image.generate'), capabilityVersion: '1.0.0', inputRefs: [], parameters: { prompt: 'a red kite over the sea', width: 128, height: 128, steps: 4 }, deadlineAt: '2026-09-20T00:00:00.000Z', maxOutputBytes: 1024, idempotencyKey: 'h3-1' }
const context = (workspacePath: string) => ({ signal: new AbortController().signal, workspacePath, inputs: [], interactionPolicy: 'autonomous' as const, reportProgress: vi.fn() })
const humanContext = (workspacePath: string) => ({ ...context(workspacePath), interactionPolicy: 'human' as const })

describe('H3 local capability plugin', () => {
  it('exposes a light prompt seam and exact registry version', async () => {
    expect(buildH3Prompt({ prompt: '  cat  ', negativePrompt: 'blur' })).toContain('Prompt: cat')
    const root = await mkdtemp(join(tmpdir(), 'h3-plugin-')); roots.push(root)
    const executor = createH3ImageExecutor({ grantedPermissions: H3_IMAGE_REQUIRED_PERMISSIONS, render: async (request) => { await writeFile(request.outputPath, 'image-bytes'); return { path: request.outputPath } } })
    const registry = new ComputeExecutorRegistry(); registry.register(executor)
    expect(registry.resolve(ComputeCapabilityId('image.generate'), '1.0.0')).toBe(executor)
    expect(() => registry.resolve(ComputeCapabilityId('image.generate'), '1.1.0')).toThrow('COMPUTE_EXECUTOR_UNAVAILABLE')
    const result = await registry.execute(task, context(root))
    expect(result.outputs[0]?.name).toBe('image')
    expect(result.outputs[0]?.bytes).toBe(11)
    expect(result.outputs[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(context(root).interactionPolicy).toBe('autonomous')
  })

  it('refuses missing permissions before any native call', () => {
    const render = vi.fn()
    expect(() => createH3ImageExecutor({ grantedPermissions: ['model.local'], render })).toThrow('COMPUTE_PLUGIN_PERMISSION_DENIED')
    expect(render).not.toHaveBeenCalled()
  })

  it('refuses human interaction and malformed parameters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h3-plugin-')); roots.push(root)
    const executor = createH3ImageExecutor({ grantedPermissions: H3_IMAGE_REQUIRED_PERMISSIONS, render: vi.fn() })
    const registry = new ComputeExecutorRegistry(); registry.register(executor)
    await expect(registry.execute(task, humanContext(root) as never)).rejects.toThrow('COMPUTE_HUMAN_INTERACTION_FORBIDDEN')
    await expect(registry.execute({ ...task, parameters: { prompt: '' } }, context(root))).rejects.toThrow('COMPUTE_INPUT_INVALID')
  })

  it('rejects a native output that escapes the controlled workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'h3-plugin-')); roots.push(root)
    const executor = createH3ImageExecutor({ grantedPermissions: H3_IMAGE_REQUIRED_PERMISSIONS, render: async () => ({ path: join(root, '..', 'outside') }) })
    const registry = new ComputeExecutorRegistry(); registry.register(executor)
    await expect(registry.execute(task, context(root))).rejects.toThrow('COMPUTE_OUTPUT_PATH_INVALID')
  })
})
