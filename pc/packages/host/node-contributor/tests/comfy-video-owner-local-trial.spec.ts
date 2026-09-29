import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMFY_VIDEO_RUNNER_ABI, canonicalComfyVideoApiGraphJson,
  parseComfyVideoPublicContract, summarizeComfyVideoApiGraph,
} from '@deepseek-ai/dsh-compute-core/src/comfy-video-public-contract.ts'
import type { ComfyVideoLocalTrialBinding,
  ComfyVideoLocalTrialRecord } from '@deepseek-ai/dsh-compute-core/src/comfy-video-local-trial-ledger.ts'
import { runOwnerPrivateComfyVideoTrial, type OwnerLocalComfyVideoApprovalRequest,
  type OwnerLocalComfyVideoTrialPorts, type OwnerLocalComfyVideoRuntimeWitness,
  type OwnerReviewedComfyVideoGraph } from '../src/comfy-video-owner-local-trial.ts'

const roots: string[] = []
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const promptId = 'cfae9e4d-7443-4e8d-8d44-32f89ab478a2'
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42', 'ascii'), Buffer.alloc(48)])
const graph = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'reviewed original' } },
  '2': { class_type: 'KSampler', inputs: { seed: 7, positive: ['1', 0] } },
  '3': { class_type: 'VHS_VideoCombine', inputs: { images: ['2', 0], format: 'video/h264-mp4' } },
}
const publicContract = parseComfyVideoPublicContract({
  schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'owner_video_v1',
  capabilityId: 'video.render', graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(graph) },
  inputSlots: [
    { name: 'prompt', kind: 'text', nodeId: '1', field: 'text', maxUtf8Bytes: 4096 },
    { name: 'seed', kind: 'integer', nodeId: '2', field: 'seed', min: 0, max: 2_147_483_647 },
  ],
  outputs: [{ nodeId: '3', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
  runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'a'.repeat(64) },
  dependencyManifestSha256: 'b'.repeat(64),
  limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
    maxVramMiB: 16384, maxInputBytes: 4096, maxOutputBytes: 1024, timeoutSeconds: 30 },
})
const reviewed: OwnerReviewedComfyVideoGraph = {
  schema: 'qianshou.comfy-video-owner-review.v1', ownerId: 'owner-222222',
  profileId: 'profile-222222', reviewEvidenceSha256: 'c'.repeat(64),
  privateGraphJson: canonicalComfyVideoApiGraphJson(graph), publicContract,
  allowedClassTypes: ['CLIPTextEncode', 'KSampler', 'VHS_VideoCombine'],
}
const witness: OwnerLocalComfyVideoRuntimeWitness = {
  schema: 'qianshou.comfy-video-owner-runtime.v1', hostPid: process.pid,
  hostStartedAt: new Date(Date.now() - 5_000).toISOString(), comfyPid: process.pid + 100,
  comfyStartedAt: new Date(Date.now() - 5_000).toISOString(),
  dependencyManifestSha256: 'b'.repeat(64), runnerSourceSha256: 'a'.repeat(64),
  classOriginsSha256: 'd'.repeat(64), modelFilesSha256: 'e'.repeat(64),
  loadedModelGenerationSha256: 'f'.repeat(64), ffmpegSha256: '1'.repeat(64),
  ffprobeSha256: '2'.repeat(64),
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}
function transport(paths: string[], attemptId: () => string | undefined = () => undefined): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof URL ? input.href : input instanceof Request ? input.url : input)
    paths.push(url.pathname)
    if (url.pathname === '/prompt') throw Error('direct Comfy /prompt is forbidden')
    if (url.pathname === `/history/${promptId}`) return json({ [promptId]: {
      status: { status_str: 'success' }, outputs: { '3': { gifs: [
        { filename: `qs_${attemptId()?.replaceAll('-', '')}_00001.mp4`, subfolder: '', type: 'output' },
      ] } },
    } })
    if (url.pathname === '/view') return new Response(new Uint8Array(mp4), {
      headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
    })
    throw Error('unexpected local route')
  })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'comfy-owner-local-trial-'))
  roots.push(root)
  let current: ComfyVideoLocalTrialRecord | null = null
  let recovered = false
  const trace: string[] = []
  const ledger = {
    recoverAtStartup: vi.fn(async () => {
      recovered = true
      return { state: current?.state === 'submitting' || current?.state === 'submitted'
        ? 'unknown' as const : current?.state === 'reserved' ? 'unspent' as const
          : current?.state ?? 'none' as const, record: current }
    }),
    reserve: vi.fn(async (binding: ComfyVideoLocalTrialBinding) => {
      if (!recovered || current && !['local-verified', 'abandoned'].includes(current.state)) {
        throw Error('local attempt unresolved')
      }
      current = { ...binding, schema: 'qianshou.comfy-video-local-trial.v1',
        attemptId: randomUUID(), promptId: null, resultSha256: null, state: 'reserved' }
      trace.push('reserve')
      return current
    }),
    assertReserved: vi.fn(async (reserved: ComfyVideoLocalTrialRecord) => {
      if (!current || current.attemptId !== reserved.attemptId) throw Error('wrong reservation')
    }),
    beforePromptSubmit: vi.fn(async (reserved: ComfyVideoLocalTrialRecord) => {
      if (current?.attemptId !== reserved.attemptId || current.state !== 'reserved') {
        throw Error('already spent')
      }
      current = { ...current, state: 'submitting' }
      trace.push('spend')
    }),
    recordPromptId: vi.fn(async (reserved: ComfyVideoLocalTrialRecord, id: string) => {
      if (current?.attemptId !== reserved.attemptId || current.state !== 'submitting') {
        throw Error('prompt unknown')
      }
      current = { ...current, state: 'submitted', promptId: id }
      trace.push('prompt')
      return current
    }),
    recordLocalResult: vi.fn(async (reserved: ComfyVideoLocalTrialRecord, resultSha256: string) => {
      if (current?.attemptId !== reserved.attemptId || current.state !== 'submitted') {
        throw Error('not submitted')
      }
      current = { ...current, state: 'local-verified', resultSha256 }
      trace.push('local-verified')
      return current
    }),
    latest: vi.fn(async () => current),
    abandonReserved: vi.fn(async (reserved: ComfyVideoLocalTrialRecord) => {
      if (current?.attemptId !== reserved.attemptId || current.state !== 'reserved') {
        throw Error('reservation already spent')
      }
      current = { ...current, state: 'abandoned' }
      trace.push('abandoned')
      return current
    }),
  }
  const ports: OwnerLocalComfyVideoTrialPorts = {
    ledger,
    readAuthenticatedOwner: vi.fn(async () => ({ ownerId: reviewed.ownerId, profileId: reviewed.profileId })),
    readCurrentReview: vi.fn(async () => reviewed),
    selectRuntime: vi.fn(async () => ({ port: 8194, ffprobePath: process.execPath,
      workspacePath: root })),
    readActualRuntimeWitness: vi.fn(async () => witness),
    assertSharedH3Admission: vi.fn(async () => { trace.push('h3-guard') }),
    consumeOneTimeOwnerApproval: vi.fn(async (request: OwnerLocalComfyVideoApprovalRequest) => {
      trace.push('approval')
      return { ...request, schema: 'qianshou.comfy-video-owner-approval.v1' as const,
        approvalSha256: sha(Buffer.from(request.trialKey)),
        expiresAt: new Date(Date.now() + 60_000).toISOString() }
    }),
    assertConsumedApprovalCurrent: vi.fn(async () => {}),
    submitPromptWithExpectedWitness: vi.fn(async request => {
      trace.push('atomic-submit')
      const body = JSON.parse(request.body) as { prompt: typeof graph; client_id: string }
      expect(body.prompt['1'].inputs.text).toBe('fresh owner prompt')
      expect(body.prompt['2'].inputs.seed).toBe(17)
      expect(body.client_id).toBe(request.attemptId)
      return { response: json({ prompt_id: promptId, node_errors: {} }),
        actualRuntimeWitnessSha256: request.expectedRuntimeWitnessSha256,
        actualComfyPid: request.expectedComfyPid,
        actualLoadedModelGenerationSha256: request.expectedLoadedModelGenerationSha256 }
    }),
    withSharedH3GpuReservation: vi.fn(async <T>(_runtime: unknown, _signal: AbortSignal,
      operation: () => Promise<T>): Promise<T> => {
      trace.push('gpu-claim')
      return operation()
    }) as unknown as OwnerLocalComfyVideoTrialPorts['withSharedH3GpuReservation'],
  }
  return { ports, ledger, trace, root, latest: () => current }
}

const trial = (signal = new AbortController().signal) => ({ trialKey: 'new-owner-trial-1',
  values: { prompt: 'fresh owner prompt', seed: 17 }, signal })
const probe = { pollIntervalMs: 50,
  program: vi.fn(async () => ({ stdout: JSON.stringify({ format: { duration: '5' },
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1344, height: 768,
      nb_read_frames: '120' }] }) })) }

describe('owner-private local Comfy video trial bridge', () => {
  it('consumes one current owner approval, spends one local POST intent and returns only a local result', async () => {
    const f = await fixture()
    const paths: string[] = []
    const result = await runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher: transport(paths, () => f.latest()?.attemptId) })
    expect(result).toMatchObject({ schema: 'qianshou.comfy-video-owner-local-result.v1',
      platformReady: false, privateResult: { promptId, sha256: sha(mp4), bytes: mp4.length,
        durationSeconds: 5, frames: 120 } })
    expect(f.latest()?.state).toBe('local-verified')
    expect(f.trace.indexOf('approval')).toBeLessThan(f.trace.indexOf('gpu-claim'))
    expect(f.trace.indexOf('gpu-claim')).toBeLessThan(f.trace.indexOf('reserve'))
    expect(f.trace.indexOf('reserve')).toBeLessThan(f.trace.indexOf('spend'))
    expect(paths).toEqual([`/history/${promptId}`, '/view'])
    expect(f.ports.submitPromptWithExpectedWitness).toHaveBeenCalledTimes(1)
    const atomicRequest = vi.mocked(f.ports.submitPromptWithExpectedWitness).mock.calls[0]?.[0]
    expect(atomicRequest?.expectedRuntimeWitnessSha256).toBe(result.runtimeWitnessSha256)
    expect(atomicRequest?.expectedComfyPid).toBe(witness.comfyPid)
    expect(atomicRequest?.expectedLoadedModelGenerationSha256).toBe(witness.loadedModelGenerationSha256)
    expect(f.trace.indexOf('spend')).toBeLessThan(f.trace.indexOf('atomic-submit'))
    expect(f.ledger.beforePromptSubmit).toHaveBeenCalledTimes(1)
    expect(f.ledger.recordPromptId).toHaveBeenCalledTimes(1)
    expect(f.ports.assertSharedH3Admission).toHaveBeenCalledTimes(7)
  })

  it('does not claim the GPU or reserve when owner approval is unavailable', async () => {
    const f = await fixture()
    vi.mocked(f.ports.consumeOneTimeOwnerApproval).mockResolvedValue(null)
    const paths: string[] = []
    await expect(runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher: transport(paths) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_LOCAL_APPROVAL_REQUIRED')
    expect(f.ledger.reserve).not.toHaveBeenCalled()
    expect(f.ports.withSharedH3GpuReservation).not.toHaveBeenCalled()
    expect(paths).toEqual([])
  })

  it('honors the existing H3 unknown-work guard before consuming approval', async () => {
    const f = await fixture()
    vi.mocked(f.ports.assertSharedH3Admission).mockRejectedValue(Error('H3 work outcome unknown'))
    const paths: string[] = []
    await expect(runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher: transport(paths) })).rejects.toThrow('H3 work outcome unknown')
    expect(f.ports.consumeOneTimeOwnerApproval).not.toHaveBeenCalled()
    expect(f.ledger.reserve).not.toHaveBeenCalled()
    expect(paths).toEqual([])
  })

  it('leaves a recovered unknown POST blocked without consuming another approval', async () => {
    const f = await fixture()
    f.ledger.recoverAtStartup.mockResolvedValue({ state: 'unknown', record: null })
    const paths: string[] = []
    await expect(runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher: transport(paths) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_LOCAL_PREVIOUS_ATTEMPT_UNRESOLVED')
    expect(f.ports.consumeOneTimeOwnerApproval).not.toHaveBeenCalled()
    expect(f.ledger.reserve).not.toHaveBeenCalled()
    expect(paths).toEqual([])
  })

  it('rejects a changed loaded Comfy model generation inside the shared GPU claim', async () => {
    const f = await fixture()
    let reads = 0
    vi.mocked(f.ports.readActualRuntimeWitness).mockImplementation(async () => {
      reads += 1
      return reads === 1 ? witness : { ...witness, loadedModelGenerationSha256: '3'.repeat(64) }
    })
    const paths: string[] = []
    await expect(runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher: transport(paths) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_LOCAL_RUNTIME_CHANGED')
    expect(f.ledger.reserve).not.toHaveBeenCalled()
    expect(paths).toEqual([])
  })

  it('abandons a pre-POST reservation and allows a newly approved distinct trial', async () => {
    const f = await fixture()
    let checks = 0
    vi.mocked(f.ports.assertConsumedApprovalCurrent).mockImplementation(async () => {
      checks += 1
      if (checks === 4) throw Error('owner revoked the trial')
    })
    const paths: string[] = []
    await expect(runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher: transport(paths) })).rejects.toThrow('owner revoked the trial')
    expect(f.latest()?.state).toBe('abandoned')
    expect(f.ledger.abandonReserved).toHaveBeenCalledTimes(1)
    expect(f.ledger.beforePromptSubmit).not.toHaveBeenCalled()
    expect(paths).toEqual([])
    const next = await runOwnerPrivateComfyVideoTrial({ ...trial(), trialKey: 'new-owner-trial-2' },
      f.ports, { ...probe, fetcher: transport(paths, () => f.latest()?.attemptId) })
    expect(next.platformReady).toBe(false)
    expect(f.latest()?.state).toBe('local-verified')
    expect(paths).toEqual([`/history/${promptId}`, '/view'])
  })

  it('keeps an unknown POST spent and refuses a fresh trial after recovery', async () => {
    const f = await fixture()
    const paths: string[] = []
    const fetcher = transport(paths)
    vi.mocked(f.ports.submitPromptWithExpectedWitness).mockRejectedValue(Error('Comfy response lost'))
    await expect(runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher })).rejects.toThrow('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN')
    expect(f.latest()?.state).toBe('submitting')
    await expect(runOwnerPrivateComfyVideoTrial({ ...trial(), trialKey: 'new-owner-trial-2' },
      f.ports, { ...probe, fetcher })).rejects.toThrow('COMPUTE_COMFY_VIDEO_LOCAL_PREVIOUS_ATTEMPT_UNRESOLVED')
    expect(paths).toEqual([])
    expect(f.ports.consumeOneTimeOwnerApproval).toHaveBeenCalledTimes(1)
    expect(f.ledger.beforePromptSubmit).toHaveBeenCalledTimes(1)
    expect(f.ledger.abandonReserved).not.toHaveBeenCalled()
    expect(f.ports.submitPromptWithExpectedWitness).toHaveBeenCalledTimes(1)
  })

  it('rejects an atomic-submit witness mismatch with no direct POST or retry', async () => {
    const f = await fixture()
    const paths: string[] = []
    vi.mocked(f.ports.submitPromptWithExpectedWitness).mockImplementation(async request => ({
      response: json({ prompt_id: promptId, node_errors: {} }),
      actualRuntimeWitnessSha256: '0'.repeat(64), actualComfyPid: request.expectedComfyPid,
      actualLoadedModelGenerationSha256: request.expectedLoadedModelGenerationSha256,
    }))
    await expect(runOwnerPrivateComfyVideoTrial(trial(), f.ports,
      { ...probe, fetcher: transport(paths) })).rejects.toThrow('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN')
    expect(f.latest()?.state).toBe('submitting')
    expect(paths).toEqual([])
    expect(f.ports.submitPromptWithExpectedWitness).toHaveBeenCalledTimes(1)
    expect(f.ledger.abandonReserved).not.toHaveBeenCalled()
  })

  it('copies prompt values before an asynchronous approval callback can change them', async () => {
    const f = await fixture()
    const request = trial()
    vi.mocked(f.ports.consumeOneTimeOwnerApproval).mockImplementation(async approval => {
      ;(request.values as { prompt: string }).prompt = 'mutated after approval request'
      return { ...approval, schema: 'qianshou.comfy-video-owner-approval.v1',
        approvalSha256: sha(Buffer.from(approval.trialKey)),
        expiresAt: new Date(Date.now() + 60_000).toISOString() }
    })
    const paths: string[] = []
    await runOwnerPrivateComfyVideoTrial(request, f.ports,
      { ...probe, fetcher: transport(paths, () => f.latest()?.attemptId) })
    expect(f.ports.submitPromptWithExpectedWitness).toHaveBeenCalledTimes(1)
    expect(paths).not.toContain('/prompt')
  })
})
