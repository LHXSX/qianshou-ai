import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { saveFileStreamVerbatim, storedFilePath } from '../../../attachment/attachment-local/src/file-store.ts'
import { ComputeExecutorRegistry } from '../src/executor.ts'
import { ComputeLocalTaskRunner } from '../src/local-task-runner.ts'
import { runPrivateMacVideoTrial } from '../src/private-mac-video-tool.ts'
import * as PrivateMacVideoTool from '../src/private-mac-video-tool.ts'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { reviewedMacVideoPackageBytes } from '../src/reviewed-mac-video-package.ts'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const video = Buffer.alloc(240)
video.writeUInt32BE(24, 0)
video.write('ftypisom', 4, 'ascii')
const digest = createHash('sha256').update(video).digest('hex')

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-private-video-tool-')); roots.push(root)
  const dist = join(root, 'dist')
  await mkdir(dist)
  const reviewed = reviewedMacVideoPackageBytes()
  await Promise.all([
    writeFile(join(dist, 'qianshou-mac-drawn-video-0.1.0.tgz'), reviewed.archive),
    writeFile(join(dist, 'qianshou-mac-drawn-video-0.1.0.receipt.json'), reviewed.receipt),
    writeFile(join(dist, 'qianshou-mac-drawn-video-0.1.0.manifest.json'), reviewed.manifest),
  ])
  const archive = join(dist, 'qianshou-mac-drawn-video-0.1.0.tgz')
  const unpack = join(root, 'unpack')
  await mkdir(unpack)
  await run('/usr/bin/tar', ['-xzf', archive, '-C', unpack], { timeout: 10_000 })
  const profileDir = join(root, 'profile')
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {
    'qianshou-mac-drawn-video': `file:${archive}`,
  } }))
  await symlink(join(unpack, 'package'), join(profileDir, 'node_modules', 'qianshou-mac-drawn-video'))
  const executors = new ComputeExecutorRegistry()
  const execute = vi.fn(async (_task: unknown, context: { workspacePath: string }) => {
    const path = join(context.workspacePath, 'drawn-video-5s.mp4')
    await writeFile(path, video)
    return { outputs: [{ name: 'drawn-video-5s.mp4', path, bytes: video.length, sha256: digest }],
      metadata: { mediaType: 'video/mp4', durationSeconds: '5', renderer: 'macos-appkit-drawing' } }
  })
  executors.register({ capabilityId: ComputeCapabilityId('video.drawn-mac-5s'), version: '0.1.0', execute })
  const runner = new ComputeLocalTaskRunner(executors)
  const attachmentRoot = join(root, 'home', 'attachments', 'v1')
  const attachments = {
    saveFileStream: (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }) => saveFileStreamVerbatim(attachmentRoot, input),
    fileHostPath: (ref: Awaited<ReturnType<typeof saveFileStreamVerbatim>>) => storedFilePath(attachmentRoot, ref),
  }
  const context = { profileDir, home: root,
    manager: { listBundles: async () => [{ name: 'qianshou-mac-drawn-video', version: '0.1.0',
      enabled: true, installed: true }],
    checkBundle: async () => ({ state: 'active', selected: true, version: '0.1.0',
      rows: [{ moduleName: 'qianshou-mac-drawn-video', phase: 'active' }] }) },
    executors, factory: { available: true }, runner, attachments }
  const invocation = { userText: '请在本机做一个五秒海边骑车视频', sessionId: 'session-1',
    callId: `call-${randomUUID()}`, title: '海边骑车', subtitle: '沿着海岸出发',
    signal: new AbortController().signal }
  return { context, invocation, execute, root, runner, attachments }
}

describe.skipIf(process.platform !== 'darwin')('private Mac video conversation tool', () => {
  it('uses the current user turn and a real one-shot owner decision without a phrase classifier', async () => {
    const { context, invocation, execute, runner } = await harness()
    const approve = vi.fn(async () => 'allowed-once')
    await expect(runPrivateMacVideoTrial(context, { ...invocation, userText: ' ', approve }))
      .rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_REQUEST_INVALID')
    expect(approve).not.toHaveBeenCalled()
    await expect(runPrivateMacVideoTrial(context, { ...invocation, userText: '就用刚才说的那个', approve: async () => 'rejected' }))
      .rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_OWNER_APPROVAL_REQUIRED')
    await expect(runPrivateMacVideoTrial(context, { ...invocation, approve }))
      .rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_CALL_REPEATED')
    expect(execute).not.toHaveBeenCalled()
    await runner.close()
  }, 45_000)

  it('returns a durable content-addressed playable link only after verified local completion', async () => {
    const { context, invocation, execute, root, runner, attachments } = await harness()
    let reason = ''
    const result = await runPrivateMacVideoTrial(context, { ...invocation, approve: async text => {
      reason = text
      return 'allowed-once'
    } })
    expect(reason).toContain('本机')
    expect(reason).toContain('不收费')
    expect(reason).not.toContain('已上架')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: 'completed', scope: 'private-local-trial',
      marketInstalled: false, dispatchable: false, charged: false,
      durationSeconds: 5, attachmentId: `sha256:${digest}`, bytes: video.length })
    const path = attachments.fileHostPath({ attachmentId: AttachmentId(result.attachmentId),
      name: 'drawn-video-5s.mp4', bytes: result.bytes })
    expect(result.mediaMarkdown).toBe(`[播放视频](${encodeURIComponent(path)})`)
    expect(await readFile(path)).toEqual(video)
    expect(result.mediaMarkdown).not.toContain(join(root, 'qianshou', 'private-video-trials'))
    await runner.close()
  }, 45_000)

  it('puts the private path only in UI metadata, never in model-facing tool content', async () => {
    const { context, invocation, runner } = await harness()
    const ctx = new Context()
    const prompt = await ctx.plugin(SystemPrompt)
    const runtime = await ctx.plugin(ToolRuntime)
    ctx.provide('computeCore', { executors: context.executors,
      executeTask: (task: unknown, request: unknown) => context.runner.run(task as never, request as never) } as never)
    ctx.provide('profileContext' as never, { dir: context.profileDir, home: context.home } as never)
    ctx.provide('pluginManager' as never, context.manager as never)
    ctx.provide('macDrawnVideoFactory', context.factory as never)
    ctx.provide('attachments' as never, context.attachments as never)
    let approved = 0
    ctx.provide('approval' as never, { request: async () => { approved += 1; return 'allowed-once' } } as never)
    const plugin = await ctx.plugin(PrivateMacVideoTool)
    try {
      const result = await ctx.tools.execute({ signal: invocation.signal,
        callId: ToolCallId(`runtime-${randomUUID()}`), name: 'plugin_drawn_video_try_local',
        arguments: { title: invocation.title, subtitle: invocation.subtitle },
        agent: { id: 'session-test', session: { deriveMessages: () => [{ role: 'user',
          source: { kind: 'user' }, content: [{ type: 'text', text: invocation.userText }] }] } } as never })
      expect(result.isError).not.toBe(true)
      expect(approved).toBe(1)
      const modelText = result.content.find(part => part.type === 'text')
      expect(modelText?.type === 'text' ? modelText.text : '').toContain('"status":"completed"')
      expect(JSON.stringify(result.content)).not.toContain('attachments/v1')
      expect(JSON.stringify(result.content)).not.toContain('mediaMarkdown')
      expect(JSON.stringify(result.meta)).toContain('mediaMarkdown')
      expect(JSON.stringify(result.meta)).toContain('attachments%2Fv1')
    } finally {
      await plugin.dispose()
      await runtime.dispose()
      await prompt.dispose()
      await runner.close()
    }
  }, 45_000)
})
