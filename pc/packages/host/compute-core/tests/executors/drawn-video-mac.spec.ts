import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMacDrawnVideoExecutor } from '../../src/executors/drawn-video-mac.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../../src/protocol.ts'

const capabilityId = ComputeCapabilityId('video.drawn-mac-5s')
const config = { capabilityId, version: '0.1.0', swiftPath: '/usr/bin/swift',
  ffmpegPath: '/opt/homebrew/bin/ffmpeg', ffprobePath: '/opt/homebrew/bin/ffprobe', maxRuntimeMs: 120_000 }

function task(parameters: unknown): ComputeTaskEnvelope {
  return { version: 'qianshou.task.v1', taskId: ComputeTaskId('drawn-test'), capabilityId,
    capabilityVersion: '0.1.0', inputRefs: [], parameters,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(), maxOutputBytes: 20 * 1024 * 1024,
    idempotencyKey: 'drawn-test-once' }
}

describe('Mac drawn video task admission', () => {
  it('requires explicit local tools and a finite runtime budget', () => {
    expect(() => createMacDrawnVideoExecutor({ ...config, ffmpegPath: 'ffmpeg' }))
      .toThrow('COMPUTE_DRAWN_VIDEO_CONFIG_INVALID')
    expect(() => createMacDrawnVideoExecutor({ ...config, maxRuntimeMs: 0 }))
      .toThrow('COMPUTE_DRAWN_VIDEO_CONFIG_INVALID')
    expect(() => createMacDrawnVideoExecutor({ ...config, capabilityId: ComputeCapabilityId('video.generate') }))
      .toThrow('COMPUTE_DRAWN_VIDEO_CONFIG_INVALID')
    expect(() => createMacDrawnVideoExecutor({ ...config, version: '1.0.0' }))
      .toThrow('COMPUTE_DRAWN_VIDEO_CONFIG_INVALID')
  })

  it('refuses command-like extra parameters before writing files', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'drawn-video-spec-'))
    try {
      const executor = createMacDrawnVideoExecutor(config)
      await expect(executor.execute(task({ title: '海边骑车', subtitle: '沿着海岸出发', command: 'curl example.com' }), {
        signal: new AbortController().signal, workspacePath, inputs: [], interactionPolicy: 'autonomous',
        reportProgress: () => undefined,
      })).rejects.toMatchObject({ code: 'COMPUTE_DRAWN_VIDEO_PARAMETERS_INVALID' })
      expect(await readdir(workspacePath)).toEqual([])
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('refuses line breaks and oversized rendered text', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'drawn-video-spec-'))
    try {
      const executor = createMacDrawnVideoExecutor(config)
      const context = { signal: new AbortController().signal, workspacePath,
        inputs: [], interactionPolicy: 'autonomous' as const, reportProgress: () => undefined }
      await expect(executor.execute(task({ title: '骑车\n下一行', subtitle: '海边' }), context))
        .rejects.toMatchObject({ code: 'COMPUTE_DRAWN_VIDEO_PARAMETERS_INVALID' })
      await expect(executor.execute(task({ title: '海'.repeat(17), subtitle: '海边' }), context))
        .rejects.toMatchObject({ code: 'COMPUTE_DRAWN_VIDEO_PARAMETERS_INVALID' })
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it('never accepts file input references or human interaction', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'drawn-video-spec-'))
    try {
      const executor = createMacDrawnVideoExecutor(config)
      const context = { signal: new AbortController().signal, workspacePath,
        inputs: [], interactionPolicy: 'autonomous' as const, reportProgress: () => undefined }
      await expect(executor.execute({ ...task({ title: '海边骑车', subtitle: '沿着海岸出发' }),
        inputRefs: [{ name: 'source', bytes: 0, sha256: 'a'.repeat(64) }] }, context))
        .rejects.toMatchObject({ code: 'COMPUTE_DRAWN_VIDEO_INPUT_REFS_FORBIDDEN' })
      await expect(executor.execute(task({ title: '海边骑车', subtitle: '沿着海岸出发' }),
        { ...context, interactionPolicy: 'ask' as never })).rejects.toMatchObject({ code: 'COMPUTE_HUMAN_INTERACTION_FORBIDDEN' })
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'darwin')('does not turn a missing renderer into a placeholder result', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'drawn-video-spec-'))
    try {
      const executor = createMacDrawnVideoExecutor({ ...config, swiftPath: '/missing/swift' })
      await expect(executor.execute(task({ title: '海边骑车', subtitle: '沿着海岸出发' }), {
        signal: new AbortController().signal, workspacePath, inputs: [], interactionPolicy: 'autonomous',
        reportProgress: () => undefined,
      })).rejects.toMatchObject({ code: 'COMPUTE_DRAWN_VIDEO_PROCESS_FAILED' })
      expect(await readdir(workspacePath)).toEqual([])
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'darwin')('stops the rendering process and removes partial files on cancellation', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'drawn-video-spec-'))
    const staller = join(workspacePath, 'stall.sh')
    await writeFile(staller, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 })
    await chmod(staller, 0o700)
    try {
      const controller = new AbortController()
      const executor = createMacDrawnVideoExecutor({ ...config, swiftPath: staller })
      const execution = executor.execute(task({ title: '海边骑车', subtitle: '沿着海岸出发' }), {
        signal: controller.signal, workspacePath, inputs: [], interactionPolicy: 'autonomous',
        reportProgress: () => undefined,
      })
      setTimeout(() => { controller.abort() }, 150)
      await expect(execution).rejects.toMatchObject({ code: 'COMPUTE_DRAWN_VIDEO_ABORTED' })
      expect(await readdir(workspacePath)).toEqual(['stall.sh'])
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'darwin')('expires the process budget and removes partial files', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'drawn-video-spec-'))
    const staller = join(workspacePath, 'stall.sh')
    await writeFile(staller, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 })
    await chmod(staller, 0o700)
    try {
      const executor = createMacDrawnVideoExecutor({ ...config, swiftPath: staller, maxRuntimeMs: 200 })
      await expect(executor.execute(task({ title: '海边骑车', subtitle: '沿着海岸出发' }), {
        signal: new AbortController().signal, workspacePath, inputs: [], interactionPolicy: 'autonomous',
        reportProgress: () => undefined,
      })).rejects.toMatchObject({ code: 'COMPUTE_DRAWN_VIDEO_TIMEOUT' })
      expect(await readdir(workspacePath)).toEqual(['stall.sh'])
    } finally { await rm(workspacePath, { recursive: true, force: true }) }
  })
})
