import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComfyVideoAttemptLedger } from '@deepseek-ai/dsh-compute-core/src/comfy-video-attempt-ledger.ts'
import { COMFY_VIDEO_RUNNER_ABI, comfyVideoPublicContractDigest,
  parseComfyVideoPublicContract, summarizeComfyVideoApiGraph,
} from '@deepseek-ai/dsh-compute-core/src/comfy-video-public-contract.ts'
import { VideoWorkflowDraftStore } from '@deepseek-ai/dsh-compute-core/src/video-workflow-draft.ts'
import { ComputeCapabilityId, ComputeTaskId } from '@deepseek-ai/dsh-compute-core/protocol'
import type { ComputeResidentAttemptExecution, ResidentAttempt } from '@deepseek-ai/dsh-compute-core/resident'
import { ComputeTaskStore } from '@deepseek-ai/dsh-compute-core/task-store'
import { runResidentComfyVideoAttempt, type ComfyVideoRuntimeSelection, type ResidentComfyVideoBridgeInput,
  type ResidentComfyVideoBridgePorts,
  type ReviewedComfyVideoInstallation, type ReviewedComfyVideoPublication } from '../src/comfy-video-resident-bridge.ts'

const roots: string[] = []
const graph = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'private owner prompt' } },
  '2': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0], format: 'video/h264-mp4' } },
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42', 'ascii'), Buffer.alloc(48)])
const promptId = 'cfae9e4d-7443-4e8d-8d44-32f89ab478a2'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'comfy-video-bridge-'))
  roots.push(root)
  const drafts = new VideoWorkflowDraftStore(join(root, 'private', 'drafts.json'))
  const summary = await drafts.save({ displayName: '私人视频', template: 'text-to-video', graph,
    mapping: { prompt: { nodeId: '1', field: 'text' }, outputNodeId: '2' } })
  const publicContract = parseComfyVideoPublicContract({
    schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'owner_video_v1',
    capabilityId: 'video.render', graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(graph) },
    inputSlots: [{ name: 'prompt', kind: 'text', nodeId: '1', field: 'text', maxUtf8Bytes: 4096 }],
    outputs: [{ nodeId: '2', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
    runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'a'.repeat(64) },
    dependencyManifestSha256: 'b'.repeat(64),
    limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
      maxVramMiB: 16384, maxInputBytes: 4096, maxOutputBytes: 1024, timeoutSeconds: 30 },
  })
  const reviewed: ReviewedComfyVideoInstallation = { ownerAccountId: 167,
    publicationId: 'dc091b4a-426f-471c-be50-e859aed2e14c',
    artifactDigest: 'sha256:' + 'e'.repeat(64), contractSha256: 'sha256:' + 'f'.repeat(64),
    draftId: summary.id,
    graphSha256: summary.graphSha256, publicContract,
    approvedContractDigest: comfyVideoPublicContractDigest(publicContract), packageDigest: 'c'.repeat(64),
    dependencyManifestSha256: publicContract.dependencyManifestSha256,
    runnerSourceSha256: publicContract.runner.sourceSha256,
    allowedClassTypes: ['CLIPTextEncode', 'VHS_VideoCombine'], capabilityVersion: 'v1' }
  const store = new ComputeTaskStore({ path: join(root, 'private', 'tasks.json'), maxTasks: 10, maxBytes: 32 * 1024 })
  const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
  const attempt: ResidentAttempt = { taskId: 'video-task-1', attempt: 1, leaseId: 'lease-1',
    leaseExpiresAt, idempotencyKey: 'key-1', envelopeFingerprint: 'd'.repeat(64),
    capabilityId: 'video.render', capabilityVersion: 'v1', capabilityPluginDigest: reviewed.packageDigest }
  const now = new Date().toISOString()
  await store.putIfAbsent({ taskId: ComputeTaskId(attempt.taskId), attempt: 1,
    envelopeFingerprint: attempt.envelopeFingerprint, idempotencyKey: attempt.idempotencyKey,
    status: 'OFFERED', leaseExpiresAt: null, progress: 0, updatedAt: now })
  await store.transition(attempt.taskId, 1, { type: 'accept', leaseExpiresAt }, now)
  await store.transition(attempt.taskId, 1, { type: 'start' }, now)
  const execution: ComputeResidentAttemptExecution = { task: {
    version: 'qianshou.task.v1', taskId: ComputeTaskId(attempt.taskId),
    capabilityId: ComputeCapabilityId('video.render'), capabilityVersion: 'v1',
    parameters: { taskType: publicContract.taskType }, inputRefs: [], deadlineAt: leaseExpiresAt,
    maxOutputBytes: 1024, idempotencyKey: attempt.idempotencyKey,
  }, attempt, signal: new AbortController().signal,
  reportProgress: async () => {}, source: { open: async () => { throw Error('not used') } }, dataSource: null }
  const ledger = new ComfyVideoAttemptLedger(join(root, 'private', 'attempt.json'), store)
  const assertRuntimeCurrent = vi.fn(async () => {})
  const publication: ReviewedComfyVideoPublication = { publicationId: reviewed.publicationId,
    ownerAccountId: reviewed.ownerAccountId, taskType: publicContract.taskType,
    artifactDigest: reviewed.artifactDigest, contractSha256: reviewed.contractSha256,
    approvedContractDigest: reviewed.approvedContractDigest, status: 'approved' }
  const assertOrderPublication = vi.fn(async (_execution: ComputeResidentAttemptExecution,
    _publication: ReviewedComfyVideoPublication, _signal: AbortSignal) => {})
  const ports: ResidentComfyVideoBridgePorts = { drafts, ledger, readCurrentInstallation: async () => reviewed,
    readCurrentPublication: async () => publication, assertOrderPublication,
    assertOrderOwnership: async () => {}, assertTaskValues: async () => {}, assertRuntimeCurrent,
    withGpuReservation: async (_selection, _execution, operation) => operation() }
  return { root, reviewed, publication, execution, ports, ledger, assertRuntimeCurrent, assertOrderPublication }
}

function transport(routes: string[]): typeof fetch {
  let outputPrefix: string | undefined
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof URL ? input.href : input instanceof Request ? input.url : input).pathname
    routes.push(path)
    if (path === '/prompt') {
      if (typeof init?.body !== 'string') throw Error('missing prompt body')
      const body = JSON.parse(init.body) as { prompt: { '2': { inputs: { filename_prefix: string } } } }
      outputPrefix = body.prompt['2'].inputs.filename_prefix
      return Response.json({ prompt_id: promptId, node_errors: {} })
    }
    if (path === `/history/${promptId}`) return Response.json({ [promptId]: {
      status: { status_str: 'success' },
      outputs: { '2': { gifs: [{ filename: `${outputPrefix}_00001.mp4`, subfolder: '', type: 'output' }] } },
    } })
    if (path === '/view') return new Response(new Uint8Array(mp4), {
      headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
    })
    throw Error('unexpected local endpoint')
  })
}

describe('resident ComfyUI video bridge', () => {
  it.skipIf(process.platform !== 'win32')('does not submit on Windows before journal durability is proven', async () => {
    const { root, reviewed, execution, ports, ledger } = await fixture()
    const routes: string[] = []
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'scene' }, port: 8194, workspacePath: root,
      ffprobePath: process.execPath }, ports, { fetcher: transport(routes) }))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_DURABILITY_UNAVAILABLE')
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('runs only the reviewed private revision under a started lease and retains the server prompt ID', async () => {
    const { root, reviewed, execution, ports, ledger, assertRuntimeCurrent } = await fixture()
    const routes: string[] = []
    const result = await runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'a different scene' }, port: 8194, workspacePath: root,
      ffprobePath: process.execPath }, ports, { fetcher: transport(routes), pollIntervalMs: 50,
      program: vi.fn(async () => ({ stdout: JSON.stringify({ format: { duration: '5' },
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1344,
          height: 768, nb_read_frames: '120' }] }) })) })
    expect(result.sha256).toBe(createHash('sha256').update(mp4).digest('hex'))
    expect(routes).toEqual(['/prompt', `/history/${promptId}`, '/view'])
    expect(await ledger.latest()).toMatchObject({ state: 'local-verified', promptId,
      resultSha256: result.sha256 })
    expect(assertRuntimeCurrent).toHaveBeenCalledWith({ port: 8194, ffprobePath: process.execPath },
      expect.any(AbortSignal))
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'a different scene' }, port: 8194, workspacePath: root,
      ffprobePath: process.execPath }, ports, { fetcher: transport([]) }))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
  })

  it('refuses an unreviewed package digest before creating a reservation or opening ComfyUI', async () => {
    const { root, reviewed, execution, ports, ledger } = await fixture()
    const routes: string[] = []
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution,
      reviewed: { ...reviewed, packageDigest: 'e'.repeat(64) }, values: { prompt: 'scene' },
      port: 8194, workspacePath: root, ffprobePath: process.execPath }, ports,
    { fetcher: transport(routes) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_REVIEW_BINDING_INVALID')
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it('refuses a different publication before any GPU reservation or Comfy request', async () => {
    const { root, reviewed, execution, ports, ledger, publication } = await fixture()
    const routes: string[] = []
    let gpuReservations = 0
    const withGpuReservation: ResidentComfyVideoBridgePorts['withGpuReservation'] =
      async (selection, admittedExecution, operation) => {
        gpuReservations++
        return ports.withGpuReservation(selection, admittedExecution, operation)
      }
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'scene' }, port: 8194, workspacePath: root, ffprobePath: process.execPath },
    { ...ports, readCurrentPublication: async () => ({ ...publication,
      publicationId: 'f5b22817-890d-4f37-9821-37d6629b489b' }), withGpuReservation },
    { fetcher: transport(routes) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_REVIEW_BINDING_INVALID')
    expect(gpuReservations).toBe(0)
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it('refuses withdrawn approval or a changed artifact and contract before any Comfy request', async () => {
    const { root, reviewed, execution, ports, ledger, publication } = await fixture()
    const routes: string[] = []
    const changed: Array<ReviewedComfyVideoPublication | null> = [null,
      { ...publication, artifactDigest: 'sha256:' + '0'.repeat(64) },
      { ...publication, contractSha256: 'sha256:' + '1'.repeat(64) },
      { ...publication, approvedContractDigest: 'sha256:' + '2'.repeat(64) }]
    for (const current of changed) {
      await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
        values: { prompt: 'scene' }, port: 8194, workspacePath: root, ffprobePath: process.execPath },
      { ...ports, readCurrentPublication: async () => current }, { fetcher: transport(routes) }))
        .rejects.toThrow('COMPUTE_COMFY_VIDEO_REVIEW_BINDING_INVALID')
    }
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it('refuses an order whose signed publication does not match the current reviewed install', async () => {
    const { root, reviewed, execution, ports, ledger, assertOrderPublication } = await fixture()
    const routes: string[] = []
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'scene' }, port: 8194, workspacePath: root, ffprobePath: process.execPath },
    { ...ports, assertOrderPublication: async (_execution, publication) => {
      await assertOrderPublication(_execution, publication, execution.signal)
      throw Error('SIGNED_ORDER_PUBLICATION_MISMATCH')
    } }, { fetcher: transport(routes) })).rejects.toThrow('SIGNED_ORDER_PUBLICATION_MISMATCH')
    expect(assertOrderPublication).toHaveBeenCalledWith(execution,
      expect.objectContaining({ publicationId: reviewed.publicationId }), expect.any(AbortSignal))
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('rechecks approval at the last pre-POST boundary', async () => {
    const { root, reviewed, publication, execution, ports, ledger } = await fixture()
    const routes: string[] = []
    let reads = 0
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'scene' }, port: 8194, workspacePath: root, ffprobePath: process.execPath },
    { ...ports, readCurrentPublication: async () => ++reads < 3 ? publication : null },
    { fetcher: transport(routes) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_REVIEW_BINDING_INVALID')
    expect(reads).toBe(3)
    expect(routes).toEqual([])
    // The reservation is kept pending; release requires separate authoritative terminal proof.
    expect(await ledger.latest()).toMatchObject({ state: 'reserved', promptId: null })
  })

  it.skipIf(process.platform === 'win32')('retains an ambiguous /prompt as submitting and forbids retry', async () => {
    const { root, reviewed, execution, ports, ledger } = await fixture()
    const paths: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
      paths.push(new URL(url).pathname)
      throw Error('response lost after POST')
    }) as typeof fetch
    const input: ResidentComfyVideoBridgeInput = { ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'scene' }, port: 8194, workspacePath: root, ffprobePath: process.execPath }
    await expect(runResidentComfyVideoAttempt(input, ports, { fetcher }))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN')
    expect(paths).toEqual(['/prompt'])
    expect(await ledger.latest()).toMatchObject({ state: 'submitting', promptId: null })
    await expect(runResidentComfyVideoAttempt(input, ports, { fetcher }))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
    expect(paths).toEqual(['/prompt'])
  })

  it('refuses withdrawn current installation before reserving or submitting GPU work', async () => {
    const { root, reviewed, execution, ports, ledger } = await fixture()
    const routes: string[] = []
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'scene' }, port: 8194, workspacePath: root,
      ffprobePath: process.execPath }, { ...ports, readCurrentInstallation: async () => null },
    { fetcher: transport(routes) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_REVIEW_BINDING_INVALID')
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it('refuses task values that do not match the signed form before /prompt', async () => {
    const { root, reviewed, execution, ports, ledger } = await fixture()
    const routes: string[] = []
    const assertTaskValues = vi.fn(async (_task: ComputeResidentAttemptExecution,
      values: ResidentComfyVideoBridgeInput['values']) => {
      if (values.prompt !== 'authorized scene') throw Error('TASK_INPUT_DIGEST_MISMATCH')
    })
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'different scene' }, port: 8194, workspacePath: root,
      ffprobePath: process.execPath }, { ...ports, assertTaskValues },
    { fetcher: transport(routes) })).rejects.toThrow('TASK_INPUT_DIGEST_MISMATCH')
    expect(assertTaskValues).toHaveBeenCalledWith(execution, { prompt: 'different scene' }, expect.any(AbortSignal))
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it('refuses an unreviewed local service target before reserving or posting', async () => {
    const { root, reviewed, execution, ports, ledger } = await fixture()
    const routes: string[] = []
    const assertRuntimeCurrent = vi.fn(async (selection: ComfyVideoRuntimeSelection) => {
      if (selection.port !== 8194 || selection.ffprobePath !== process.execPath) {
        throw Error('RUNTIME_TARGET_MISMATCH')
      }
    })
    await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution, reviewed,
      values: { prompt: 'scene' }, port: 8188, workspacePath: root,
      ffprobePath: process.execPath }, { ...ports, assertRuntimeCurrent },
    { fetcher: transport(routes) })).rejects.toThrow('RUNTIME_TARGET_MISMATCH')
    expect(assertRuntimeCurrent).toHaveBeenCalledWith({ port: 8188, ffprobePath: process.execPath },
      expect.any(AbortSignal))
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })

  it('refuses a mixed task/attempt identity, expired deadline or lower signed output ceiling', async () => {
    const { root, reviewed, execution, ports, ledger } = await fixture()
    const routes: string[] = []
    const mismatch: ComputeResidentAttemptExecution[] = [
      { ...execution, task: { ...execution.task, taskId: ComputeTaskId('another-task') } },
      { ...execution, task: { ...execution.task, idempotencyKey: 'different-key' } },
      { ...execution, task: { ...execution.task, deadlineAt: new Date(Date.now() - 1_000).toISOString() } },
      { ...execution, attempt: { ...execution.attempt,
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() } },
      { ...execution, task: { ...execution.task, maxOutputBytes: 512 } },
    ]
    for (const changed of mismatch) {
      await expect(runResidentComfyVideoAttempt({ ownerAccountId: 167, execution: changed, reviewed,
        values: { prompt: 'scene' }, port: 8194, workspacePath: root,
        ffprobePath: process.execPath }, ports, { fetcher: transport(routes) }))
        .rejects.toThrow('COMPUTE_COMFY_VIDEO_REVIEW_BINDING_INVALID')
    }
    expect(routes).toEqual([])
    expect(await ledger.latest()).toBeNull()
  })
})
