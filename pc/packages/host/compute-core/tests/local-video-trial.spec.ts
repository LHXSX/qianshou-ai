import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveFileStreamVerbatim, storedFilePath } from '../../../attachment/attachment-local/src/file-store.ts'
import { ComputeExecutorRegistry, type ComputeExecutor } from '../src/executor.ts'
import { issueLocalExecutionApproval } from '../src/local-execution-admission.ts'
import { ComputeLocalTaskRunner } from '../src/local-task-runner.ts'
import { macDrawnVideoHostPath, runAuthorizedMacDrawnVideoTrial } from '../src/local-video-trial.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { planRoute, type RouterNodeOffer } from '../src/router.ts'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const now = '2026-09-24T00:00:00.000Z'
const issuedAt = '2026-09-23T23:59:00.000Z'
const expiresAt = '2026-09-24T01:00:00.000Z'
const pluginDigest = 'c'.repeat(64)
const video = Buffer.alloc(200)
video.writeUInt32BE(24, 0)
video.write('ftypisom', 4, 'ascii')
const sha256 = createHash('sha256').update(video).digest('hex')

const task: ComputeTaskEnvelope = {
  version: 'qianshou.task.v1', taskId: ComputeTaskId('mac-video-task-1'),
  capabilityId: ComputeCapabilityId('video.drawn-mac-5s'), capabilityVersion: '0.1.0',
  inputRefs: [], parameters: { title: '海边骑车', subtitle: '五秒小视频' },
  deadlineAt: expiresAt, maxOutputBytes: 20 * 1024 * 1024,
  idempotencyKey: 'mac-video-task-1',
}

const offer: RouterNodeOffer = {
  offerId: 'mac-video-private-trial', nodeId: 'mac-local-owner',
  capabilityId: 'video.drawn-mac-5s', capabilityVersion: '0.1.0', pluginDigest,
  modelIds: [], platform: 'darwin-arm64', vramBytes: 0,
  dataScopes: ['task-inputs'], privacy: 'private', health: 'ok', available: true,
  ownerAuthorized: true, observedAt: issuedAt, expiresAt,
  runningTasks: 0, queueDepth: 0, maxConcurrency: 1, estimatedLatencyMs: 1000,
  priceMinor: 0, currency: 'CNY', successRate: 1,
}

function approval(ownerAuthorization: 'approved' | 'pending' = 'approved') {
  const plan = planRoute({ now: issuedAt,
    intent: { version: 'qianshou.intent.v1', intentId: 'mac-video-intent-1',
      capabilityId: 'video.drawn-mac-5s', requiredModelIds: [], dataScope: 'task-inputs',
      privacy: 'private', ownerAuthorization: 'approved', budgetMinor: 0, currency: 'CNY',
      deadlineAt: expiresAt, idempotencyKey: 'mac-video-task-1' }, offers: [offer] })
  return issueLocalExecutionApproval({ plan, ownerAuthorization,
    approvalId: 'mac-video-approval-1', executionId: 'mac-video-execution-1',
    taskId: 'mac-video-task-1', workflowId: 'mac-video-workflow-1',
    intentId: 'mac-video-intent-1', idempotencyKey: 'mac-video-task-1',
    issuedAt, expiresAt })
}

async function harness(execute?: ComputeExecutor['execute']) {
  const root = await mkdtemp(join(tmpdir(), 'mac-video-trial-')); roots.push(root)
  const workspaceRootPath = join(root, 'workspace')
  const attachmentRoot = join(root, 'home', 'attachments', 'v1')
  const registry = new ComputeExecutorRegistry()
  const runExecutor: ComputeExecutor['execute'] = execute ?? (async (_task, context) => {
    const path = join(context.workspacePath, 'drawn-video-5s.mp4')
    await writeFile(path, video)
    return { outputs: [{ name: 'drawn-video-5s.mp4', path, bytes: video.length, sha256 }],
      metadata: { mediaType: 'video/mp4', durationSeconds: '5', renderer: 'macos-appkit-drawing' } }
  })
  registry.register({ capabilityId: task.capabilityId, version: task.capabilityVersion, execute: runExecutor })
  const runner = new ComputeLocalTaskRunner(registry)
  const attachments = {
    saveFileStream: (input: { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }) => saveFileStreamVerbatim(attachmentRoot, input),
    fileHostPath: (ref: Awaited<ReturnType<typeof saveFileStreamVerbatim>>) => storedFilePath(attachmentRoot, ref),
  }
  return { runner, attachments, workspaceRootPath, attachmentRoot }
}

describe('owner-approved local video trial artifact', () => {
  it('streams the verified MP4 into durable attachments before workspace cleanup', async () => {
    const { runner, attachments, workspaceRootPath } = await harness()
    const receipt = await runAuthorizedMacDrawnVideoTrial({ runner, approval: approval(), task,
      workspaceRootPath, attachments, signal: new AbortController().signal,
      reportProgress: vi.fn(), now, localNodeId: 'mac-local-owner', pluginDigest })
    expect(receipt.status).toBe('completed')
    expect(receipt.result).toMatchObject({ kind: 'local-mac-drawn-video', mediaType: 'video/mp4',
      capabilityId: 'video.drawn-mac-5s', capabilityVersion: '0.1.0', sha256,
      attachment: { attachmentId: `sha256:${sha256}`, name: 'drawn-video-5s.mp4', bytes: video.length } })
    expect(await readdir(workspaceRootPath)).toEqual([])
    const savedPath = macDrawnVideoHostPath(receipt.result, attachments)
    expect(await readFile(savedPath)).toEqual(video)
    expect(JSON.stringify(receipt)).not.toContain(workspaceRootPath)
    await runner.close()
  })

  it('refuses absent owner approval or an altered plugin digest before the runner starts', async () => {
    const { runner, attachments, workspaceRootPath } = await harness(vi.fn(async () => { throw new Error('should not run') }))
    expect(() => approval('pending')).toThrow('COMPUTE_OWNER_AUTHORIZATION_REQUIRED')
    await expect(runAuthorizedMacDrawnVideoTrial({ runner, approval: approval(), task,
      workspaceRootPath, attachments, signal: new AbortController().signal,
      reportProgress: vi.fn(), now, localNodeId: 'mac-local-owner', pluginDigest: 'd'.repeat(64) }))
      .rejects.toThrow('COMPUTE_EXECUTION_NODE_MISMATCH')
    await expect(readdir(workspaceRootPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await runner.close()
  })

  it('rejects file masquerade and never issues a video receipt', async () => {
    const { runner, attachments, workspaceRootPath } = await harness(async (_task, context) => {
      const path = join(context.workspacePath, 'drawn-video-5s.mp4')
      const fake = Buffer.from('not an mp4')
      await writeFile(path, fake)
      return { outputs: [{ name: 'drawn-video-5s.mp4', path, bytes: fake.length,
        sha256: createHash('sha256').update(fake).digest('hex') }],
      metadata: { mediaType: 'video/mp4', durationSeconds: '5', renderer: 'macos-appkit-drawing' } }
    })
    await expect(runAuthorizedMacDrawnVideoTrial({ runner, approval: approval(), task,
      workspaceRootPath, attachments, signal: new AbortController().signal,
      reportProgress: vi.fn(), now, localNodeId: 'mac-local-owner', pluginDigest }))
      .rejects.toThrow('COMPUTE_LOCAL_VIDEO_TRIAL_FILE_INVALID')
    expect(await readdir(workspaceRootPath)).toEqual([])
    await runner.close()
  })

  it('rejects source input refs, larger budgets and forged stored references', async () => {
    const { runner, attachments, workspaceRootPath } = await harness()
    const base = { runner, approval: approval(), workspaceRootPath, attachments,
      signal: new AbortController().signal, reportProgress: vi.fn(), now,
      localNodeId: 'mac-local-owner', pluginDigest }
    expect(() => runAuthorizedMacDrawnVideoTrial({ ...base, task: { ...task, inputRefs: [{ name: 'x', bytes: 1, sha256: 'a'.repeat(64) }] } }))
      .toThrow('COMPUTE_LOCAL_VIDEO_TRIAL_TASK_INVALID')
    expect(() => runAuthorizedMacDrawnVideoTrial({ ...base, task: { ...task, maxOutputBytes: 21 * 1024 * 1024 } }))
      .toThrow('COMPUTE_LOCAL_VIDEO_TRIAL_TASK_INVALID')
    expect(() => macDrawnVideoHostPath({ kind: 'local-mac-drawn-video', mediaType: 'video/mp4',
      durationSeconds: 5, capabilityId: 'video.drawn-mac-5s', capabilityVersion: '0.1.0',
      sha256, attachment: { attachmentId: `sha256:${'f'.repeat(64)}`,
        name: 'drawn-video-5s.mp4', bytes: video.length } }, attachments))
      .toThrow('COMPUTE_LOCAL_VIDEO_TRIAL_REFERENCE_INVALID')
    await runner.close()
  })
})
