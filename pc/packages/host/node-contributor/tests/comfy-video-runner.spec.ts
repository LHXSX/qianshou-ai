import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMFY_VIDEO_RUNNER_ABI, canonicalComfyVideoApiGraphJson,
  comfyVideoPublicContractDigest, summarizeComfyVideoApiGraph,
} from '@deepseek-ai/dsh-compute-core/src/comfy-video-public-contract.ts'
import { runComfyVideoLocally, type ComfyVideoRunAdmission } from '../src/comfy-video-runner.ts'

const graph = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 7, positive: ['1', 0] } },
  '3': { class_type: 'VHS_VideoCombine', inputs: { images: ['2', 0], format: 'video/h264-mp4',
    filename_prefix: '../../outside-owner-workspace', save_metadata: true } },
}
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42', 'ascii'), Buffer.alloc(48)])
const serverPromptId = 'cfae9e4d-7443-4e8d-8d44-32f89ab478a2'
const sha = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const directories: string[] = []

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function fixture(privateGraph: Record<string, unknown> = graph, image = false) {
  const contract = {
    schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'owner_workflow_v1',
    capabilityId: 'video.render', graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(privateGraph) },
    inputSlots: [
      { name: 'prompt', kind: 'text', nodeId: '1', field: 'text', maxUtf8Bytes: 4096 },
      { name: 'seed', kind: 'integer', nodeId: '2', field: 'seed', min: 0, max: 2_147_483_647 },
      ...image ? [{ name: 'source', kind: 'artifact_ref', nodeId: '4', field: 'image',
        mimeType: 'image/png', maxBytes: 1024 }] : [],
    ],
    outputs: [{ nodeId: '3', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
    runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'a'.repeat(64) },
    dependencyManifestSha256: 'b'.repeat(64),
    limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
      maxVramMiB: 16384, maxInputBytes: image ? 5120 : 4096, maxOutputBytes: 1024,
      timeoutSeconds: 30 },
  }
  const admission: ComfyVideoRunAdmission = { publicContract: contract,
    privateGraphJson: canonicalComfyVideoApiGraphJson(privateGraph),
    approvedContractDigest: comfyVideoPublicContractDigest(contract),
    approvedDependencyManifestSha256: 'b'.repeat(64), approvedRunnerSourceSha256: 'a'.repeat(64),
    allowedClassTypes: [...new Set(Object.values(privateGraph).map(raw => (raw as typeof graph['1']).class_type))],
    attemptId: randomUUID(), assertReserved: vi.fn(async () => {}), beforePromptSubmit: vi.fn(async () => {}),
    assertCurrent: vi.fn(async () => {}),
    recordPromptId: vi.fn(async () => {}) }
  return admission
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function transport(promptId: string, inspect?: (url: string, init?: RequestInit) => void,
  historyMedia?: { filename: string; subfolder: string }): typeof fetch {
  let outputPrefix: string | undefined
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
    inspect?.(url, init)
    if (url.endsWith('/prompt')) {
      if (typeof init?.body !== 'string') throw Error('missing prompt body')
      const body = JSON.parse(init.body) as { prompt: { '3': { inputs: { filename_prefix: string } } } }
      outputPrefix = body.prompt['3'].inputs.filename_prefix
      return json({ prompt_id: promptId, node_errors: {} })
    }
    if (url.endsWith(`/history/${promptId}`)) return json({ [promptId]: { status: { status_str: 'success' },
      outputs: { '3': { gifs: [{ filename: historyMedia?.filename ?? `${outputPrefix}_00001.mp4`,
        subfolder: historyMedia?.subfolder ?? '', type: 'output' }] } } } })
    if (url.includes('/view?')) return new Response(new Uint8Array(mp4), {
      headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
    })
    if (url.endsWith('/upload/image')) {
      const form = init?.body as FormData
      const file = form.get('image') as File
      return json({ name: file.name, subfolder: '', type: 'input' })
    }
    throw Error('unexpected local route')
  })
}

async function run(admission: ComfyVideoRunAdmission, fetcher: typeof fetch,
  values: Record<string, unknown> = { prompt: 'a new scene', seed: 17 },
  probe = { duration: '5', frames: '120', width: 1344, height: 768 }) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'comfy-video-runner-'))
  directories.push(workspacePath)
  return runComfyVideoLocally({ admission,
    values: values as Parameters<typeof runComfyVideoLocally>[0]['values'], port: 8194,
    workspacePath, ffprobePath: process.execPath, signal: new AbortController().signal }, {
    fetcher, pollIntervalMs: 50,
    program: vi.fn(async () => ({ stdout: JSON.stringify({ format: { duration: probe.duration },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: probe.width,
        height: probe.height, nb_read_frames: probe.frames }] }) })),
  })
}

describe('owner-private ComfyUI video runner', () => {
  it('submits a reviewed graph once, polls only its prompt, and checks streamed MP4 plus ffprobe output', async () => {
    const admission = fixture()
    const routes: string[] = []
    const fetcher = transport(serverPromptId, (url, init) => {
      routes.push(new URL(url).pathname)
      if (url.endsWith('/prompt')) {
        if (typeof init?.body !== 'string') throw Error('missing prompt body')
        const body = JSON.parse(init.body) as { prompt: typeof graph; client_id: string; prompt_id?: string }
        expect(body.prompt_id).toBeUndefined()
        expect(body.client_id).toBe(admission.attemptId)
        expect(body.prompt['1'].inputs.text).toBe('a new scene')
        expect(body.prompt['2'].inputs.seed).toBe(17)
        expect(body.prompt['3'].inputs.filename_prefix).toMatch(/^qs_[a-f0-9]{32}$/u)
        expect(body.prompt['3'].inputs.save_metadata).toBe(false)
        expect(JSON.stringify(admission.publicContract)).not.toContain('private prompt')
      }
    })
    const result = await run(admission, fetcher)
    expect(result).toMatchObject({ filename: 'result.mp4', contentType: 'video/mp4',
      bytes: mp4.length, sha256: sha(mp4), frames: 120, durationSeconds: 5 })
    expect(routes).toEqual(['/prompt', `/history/${serverPromptId}`, '/view'])
    expect(result.promptId).toBe(serverPromptId)
    expect(admission.recordPromptId).toHaveBeenCalledWith(serverPromptId, expect.any(AbortSignal))
    expect(admission.beforePromptSubmit).toHaveBeenCalledTimes(1)
    expect(admission.assertReserved).toHaveBeenCalledTimes(3)
    expect(admission.assertCurrent).toHaveBeenCalledTimes(3)
  })

  it('uploads a hashed private image under a generated name before submitting the graph', async () => {
    const privateGraph = { ...graph, '4': { class_type: 'LoadImage', inputs: { image: 'owner-only.png' } } }
    const admission = fixture(privateGraph, true)
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)])
    const routes: string[] = []
    const fetcher = transport(serverPromptId, (url, init) => {
      routes.push(new URL(url).pathname)
      if (url.endsWith('/prompt')) {
        if (typeof init?.body !== 'string') throw Error('missing prompt body')
        const body = JSON.parse(init.body) as { prompt: { '4': { inputs: { image: string } } } }
        expect(body.prompt['4'].inputs.image).toMatch(/^qs_[a-f0-9]{32}\.png$/u)
        expect(body.prompt['4'].inputs.image).not.toBe('owner-only.png')
      }
    })
    await run(admission, fetcher, { prompt: 'scene', seed: 7,
      source: { mimeType: 'image/png', bytes: png, sha256: sha(png) } })
    expect(routes).toEqual(['/upload/image', '/prompt', `/history/${serverPromptId}`, '/view'])
  })

  it('rebases H3-style auxiliary PNG prefixes to the reserved attempt', async () => {
    const privateGraph = { ...graph,
      '201': { class_type: 'SaveImage', inputs: { images: ['2', 0],
        filename_prefix: '../../outside/first' } },
      '203': { class_type: 'SaveImage', inputs: { images: ['2', 0],
        filename_prefix: 'MiniMax_H3/old-run/last' } },
    }
    const admission = fixture(privateGraph)
    const fetcher = transport(serverPromptId, (url, init) => {
      if (!url.endsWith('/prompt') || typeof init?.body !== 'string') return
      const body = JSON.parse(init.body) as { prompt: Record<string, { inputs: Record<string, unknown> }> }
      const prefix = `qs_${admission.attemptId.replaceAll('-', '')}`
      expect(body.prompt['3']?.inputs.filename_prefix).toBe(prefix)
      expect(body.prompt['201']?.inputs.filename_prefix).toBe(`${prefix}_frame_201`)
      expect(body.prompt['203']?.inputs.filename_prefix).toBe(`${prefix}_frame_203`)
      expect(init.body).not.toContain('../../outside')
    })
    await run(admission, fetcher)
  })

  it('refuses an older MP4 or another output directory even under this prompt ID', async () => {
    const admission = fixture()
    const prefix = `qs_${admission.attemptId.replaceAll('-', '')}`
    for (const historyMedia of [
      { filename: 'result_00001.mp4', subfolder: '' },
      { filename: `${prefix}_frame_201_00001.mp4`, subfolder: '' },
      { filename: `${prefix}_00001.mp4`, subfolder: 'prior-run' },
    ]) {
      const routes: string[] = []
      const fetcher = transport(serverPromptId, (url) => { routes.push(new URL(url).pathname) }, historyMedia)
      await expect(run(admission, fetcher)).rejects.toThrow('COMPUTE_COMFY_VIDEO_RESPONSE_INVALID')
      expect(routes).toEqual(['/prompt', `/history/${serverPromptId}`])
    }
  })

  it('rejects changed graph and review digests before local network activity', async () => {
    const admission = fixture()
    const fetcher = transport(serverPromptId)
    await expect(run({ ...admission, approvedRunnerSourceSha256: 'c'.repeat(64) }, fetcher))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ADMISSION_INVALID')
    await expect(run({ ...admission, privateGraphJson: admission.privateGraphJson.replace('private prompt', 'changed') }, fetcher))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never repeats an ambiguous prompt submission', async () => {
    const admission = fixture()
    const routes: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      routes.push(input instanceof URL ? input.href : input instanceof Request ? input.url : input)
      throw Error('connection reset after POST')
    }) as typeof fetch
    await expect(run(admission, fetcher)).rejects.toThrow('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toContain('/prompt')
  })

  it('permits only one /prompt when two runner calls reuse one reservation', async () => {
    const admission = fixture()
    let spent = false
    const beforePromptSubmit = vi.fn(async () => {
      if (spent) throw Error('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID')
      spent = true
    })
    const paths: string[] = []
    const fetcher = transport(serverPromptId, (url) => { paths.push(new URL(url).pathname) })
    const results = await Promise.allSettled([
      run({ ...admission, beforePromptSubmit }, fetcher),
      run({ ...admission, beforePromptSubmit }, fetcher),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(beforePromptSubmit).toHaveBeenCalledTimes(2)
    expect(paths.filter(path => path === '/prompt')).toHaveLength(1)
  })

  it('treats a failed durable server-ID binding as an unknown submission without polling or retry', async () => {
    const admission = fixture()
    const routes: string[] = []
    const fetcher = transport(serverPromptId, (url) => { routes.push(new URL(url).pathname) })
    await expect(run({ ...admission, recordPromptId: vi.fn(async () => { throw Error('disk unavailable') }) }, fetcher))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_SUBMISSION_UNKNOWN')
    expect(routes).toEqual(['/prompt'])
  })

  it('refuses a changed private image before upload and does not submit after an ambiguous upload response', async () => {
    const privateGraph = { ...graph, '4': { class_type: 'LoadImage', inputs: { image: 'owner-only.png' } } }
    const admission = fixture(privateGraph, true)
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)])
    const routes: string[] = []
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      routes.push(input instanceof URL ? input.href : input instanceof Request ? input.url : input)
      return json({ invalid: true })
    }) as typeof fetch
    await expect(run(admission, fetcher, { prompt: 'scene', seed: 7,
      source: { mimeType: 'image/png', bytes: png, sha256: '0'.repeat(64) } }))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_INPUT_INVALID')
    expect(routes).toEqual([])
    await expect(run(admission, fetcher, { prompt: 'scene', seed: 7,
      source: { mimeType: 'image/png', bytes: png, sha256: sha(png) } }))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_UPLOAD_UNKNOWN')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toContain('/upload/image')
  })

  it('rejects a media byte limit and a video that exceeds declared duration', async () => {
    const admission = fixture()
    const ordinary = transport(serverPromptId)
    const oversized = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
      if (url.includes('/view?')) return new Response(new Uint8Array(Buffer.alloc(2048)), {
        headers: { 'content-type': 'video/mp4' },
      })
      return ordinary(input, init)
    }) as typeof fetch
    await expect(run(admission, oversized)).rejects.toThrow('COMPUTE_COMFY_VIDEO_OUTPUT_LIMIT')
    await expect(run(admission, transport(serverPromptId), undefined, { duration: '5.5',
      frames: '120', width: 1344, height: 768 })).rejects.toThrow('COMPUTE_COMFY_VIDEO_OUTPUT_INVALID')
  })
})
