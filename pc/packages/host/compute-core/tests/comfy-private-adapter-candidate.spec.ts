import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'
import { planPrivateComfyAdapterCandidate, PRIVATE_COMFY_EXECUTOR_CAPABILITY,
  PRIVATE_COMFY_EXECUTOR_VERSION } from '../src/comfy-private-adapter-candidate.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const workflow = {
  '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'private.gguf' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt', model: ['1', 0] } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'qianshou' } },
}
const mapping = { prompt: { nodeId: '2', field: 'text' }, outputNodeId: '3' }
const operationId = 'owner.comfy.image'
const spec = { pluginId: 'owner.comfy', version: '1.0.0', displayName: '本机出图', operations: [
  { id: operationId, title: '生成图片', description: '主人的本地图',
    binding: { kind: 'workflow', ref: 'comfy:private-image' },
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } },
      required: ['prompt'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { image: { type: 'string' } },
      required: ['image'], additionalProperties: false },
    permissions: ['gpu', 'network.declared'], dataScope: 'task-inputs',
    networkOrigins: ['http://127.0.0.1:8188/'], dependencies: [],
    resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 1024,
      maxOutputBytes: 16 * 1024 * 1024, maxRunMs: 600_000 } },
] }

async function setup(bound = true) {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-comfy-candidate-'))
  roots.push(root)
  const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 4, maxBytes: 1_000_000 })
  const first = await drafts.save({ spec })
  const summary = bound ? await drafts.bindComfyAsset({ id: first.id, expectedUpdatedAt: first.updatedAt,
    operationId, workflow, mapping }) : undefined
  const draft = (await drafts.list())[0]!
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const name = url.split('/').at(-1)
    if (name === 'UnetLoaderGGUF') return new Response(JSON.stringify({ [name]: { input: {
      required: { unet_name: [['private.gguf']] },
    } } }), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ [name!]: { input: { required: {} } } }),
      { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const input = { ownerId: 'owner-4060', draftId: draft.id, operationId,
    expectedDraftUpdatedAt: draft.updatedAt,
    expectedGraphSha256: summary?.graphSha256 ?? 'a'.repeat(64), port: 8188,
    executor: { capabilityId: PRIVATE_COMFY_EXECUTOR_CAPABILITY, version: PRIVATE_COMFY_EXECUTOR_VERSION },
    signal: new AbortController().signal }
  return { drafts, fetcher, input, summary }
}

describe('private Comfy adapter candidate', () => {
  it('pins a stored owner graph, exact model selectors, nodes and Host executor without admitting use', async () => {
    const { drafts, fetcher, input, summary } = await setup()
    const candidate = await planPrivateComfyAdapterCandidate(input, { drafts, fetcher })
    expect(candidate).toMatchObject({ ownerId: 'owner-4060', graphSha256: summary?.graphSha256,
      nodeCount: 3, executor: { capabilityId: 'comfy.private.sample', version: '1.0.0' },
      state: 'needs-owner-runtime-review', runnable: false, installable: false, dispatchable: false })
    expect(candidate.candidateSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(candidate.nodeContractSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(candidate.modelSelectorSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.stringify(candidate)).not.toMatch(/private\.gguf|private prompt|filename_prefix/u)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(vi.mocked(fetcher).mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:8188/object_info/'))).toBe(true)
    await drafts.close()
  })

  it('refuses an unbound owner draft before network access', async () => {
    const { drafts, fetcher, input } = await setup(false)
    await expect(planPrivateComfyAdapterCandidate(input, { drafts, fetcher }))
      .rejects.toThrow('COMPUTE_COMFY_ADAPTER_OWNER_BINDING_REQUIRED')
    expect(fetcher).not.toHaveBeenCalled()
    await drafts.close()
  })

  it('refuses changed graph, stale draft and wrong executor version before network access', async () => {
    const { drafts, fetcher, input } = await setup()
    for (const [change, code] of [
      [{ expectedGraphSha256: '0'.repeat(64) }, 'COMPUTE_COMFY_ADAPTER_GRAPH_CHANGED'],
      [{ expectedDraftUpdatedAt: '2000-01-01T00:00:00.000Z' }, 'COMPUTE_COMFY_ADAPTER_DRAFT_CHANGED'],
      [{ executor: { capabilityId: PRIVATE_COMFY_EXECUTOR_CAPABILITY, version: '2.0.0' } },
        'COMPUTE_COMFY_ADAPTER_EXECUTOR_MISMATCH'],
    ] as const) {
      await expect(planPrivateComfyAdapterCandidate({ ...input, ...change }, { drafts, fetcher }))
        .rejects.toThrow(code)
    }
    expect(fetcher).not.toHaveBeenCalled()
    await drafts.close()
  })

  it('refuses missing or unreadable current model choices and unknown nodes', async () => {
    const { drafts, input } = await setup()
    for (const response of [
      { UnetLoaderGGUF: { input: { required: { unet_name: [['other.gguf']] } } } },
      { UnetLoaderGGUF: { input: { required: { unet_name: ['STRING'] } } } },
      {},
    ]) {
      const fetcher = vi.fn(async (request: RequestInfo | URL) => {
        const url = String(request)
        const name = url.split('/').at(-1)
        return new Response(JSON.stringify(name === 'UnetLoaderGGUF' ? response
          : { [name!]: { input: { required: {} } } }),
        { headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      await expect(planPrivateComfyAdapterCandidate(input, { drafts, fetcher }))
        .rejects.toThrow('COMPUTE_COMFY_ADAPTER_PREFLIGHT_FAILED')
      expect(fetcher).toHaveBeenCalledTimes(3)
    }
    await drafts.close()
  })
})
