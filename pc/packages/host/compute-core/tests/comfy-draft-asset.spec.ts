import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { preparePrivateComfyDraftAsset } from '../src/comfy-draft-asset.ts'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const schema = { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false }
function spec() {
  return { pluginId: 'owner.comfy', version: '1.0.0', displayName: '私有图像流程', operations: [
    { id: 'owner.comfy.render', title: '出图', description: '机主选定的本地图',
      binding: { kind: 'workflow', ref: 'comfy:private-render' }, inputSchema: schema, outputSchema: schema,
      permissions: ['network.declared', 'gpu'], dataScope: 'task-inputs', networkOrigins: ['http://127.0.0.1:8188/'],
      dependencies: [], resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 1024,
        maxOutputBytes: 1024, maxRunMs: 1000 } },
  ] }
}
function graph() {
  return {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'private-model.gguf' }, _meta: { title: 'private title' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt', clip: ['1', 0] } },
    '3': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    '4': { class_type: 'KSampler', inputs: { seed: 42, latent_image: ['3', 0] } },
    '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'Qianshou' } },
  }
}
const mapping = { prompt: { nodeId: '2', field: 'text' }, seed: { nodeId: '4', field: 'seed' },
  width: { nodeId: '3', field: 'width' }, height: { nodeId: '3', field: 'height' }, outputNodeId: '5' }

describe('private ComfyUI draft assets', () => {
  it('normalizes owner graph metadata and refuses path, secret, link and mapping escapes', () => {
    const asset = preparePrivateComfyDraftAsset({ operationId: 'owner.comfy.render', workflow: graph(), mapping })
    expect(asset.graph['1']).not.toHaveProperty('_meta')
    expect(asset.graphSha256).toBe(createHash('sha256').update(JSON.stringify(asset.graph)).digest('hex'))
    expect(asset.nodeCount).toBe(5)
    const withLocalFileName = { ...graph(),
      '6': { class_type: 'LoadImage', inputs: { image: 'owner_input.png' } } }
    expect(preparePrivateComfyDraftAsset({ operationId: 'owner.comfy.render',
      workflow: withLocalFileName, mapping }).nodeCount).toBe(6)
    for (const workflow of [
      { ...graph(), '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'C:\\models\\secret.gguf' } } },
      { ...graph(), '1': { class_type: 'UnetLoaderGGUF', inputs: { api_key: 'secret' } } },
      { ...graph(), '2': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt', clip: ['99', 0] } } },
      { ...graph(), '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: '../escape' } } },
      { ...graph(), '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], extra: { command: 'run' } } } },
      { ...withLocalFileName, '6': { class_type: 'LoadImage', inputs: { image: '../secret.png' } } },
    ]) expect(() => preparePrivateComfyDraftAsset({ operationId: 'owner.comfy.render', workflow, mapping })).toThrow()
    expect(() => preparePrivateComfyDraftAsset({ operationId: 'owner.comfy.render', workflow: graph(),
      mapping: { ...mapping, prompt: { nodeId: '1', field: 'unet_name' } } })).toThrow()
    expect(() => preparePrivateComfyDraftAsset({ operationId: 'owner.comfy.render', workflow: graph(),
      mapping: { ...mapping, outputNodeId: '4' } })).toThrow()
  })

  it('keeps a version-1 draft readable, stores graph privately, and reads back only through the Host store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-comfy-asset-'))
    roots.push(root)
    const path = join(root, 'private', 'drafts.json')
    const store = new LocalPluginDraftStore({ path, maxDrafts: 2, maxBytes: 1_000_000 })
    const draft = await store.save({ spec: spec() })
    expect(await store.comfyAssetSummaries(draft.id)).toEqual([])
    const before = await readFile(path, 'utf8')
    expect(before).not.toContain('comfyAssets')
    const summary = await store.bindComfyAsset({ id: draft.id, expectedUpdatedAt: draft.updatedAt,
      operationId: 'owner.comfy.render', workflow: graph(), mapping })
    expect(summary).toMatchObject({ state: 'stored-needs-trial', runnable: false, installable: false,
      dispatchable: false, nodeCount: 5 })
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('private prompt')
    expect(raw).not.toContain('private title')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await store.list())[0]).not.toHaveProperty('comfyAssets')
    expect((await store.export(draft.id)).contents).not.toContain('private prompt')
    expect((await store.export(draft.id)).contents).not.toContain('private-model.gguf')
    const preview = await store.preview(draft.id)
    expect(preview).toMatchObject({ state: 'pending', manifest: { installable: false, dispatchable: false },
      checks: [{ binding: 'unverified', bindingAsset: 'stored-needs-trial' }] })
    expect(preview.manifest.operations[0]).toMatchObject({ workflowGraphSha256: summary.graphSha256 })
    expect(preview.contents).not.toContain('private prompt')
    expect(preview.contents).not.toContain('private-model.gguf')
    const readback = await store.readComfyAsset(draft.id, 'owner.comfy.render')
    expect(readback.graph['2']?.inputs.text).toBe('private prompt')
    expect(readback.graphSha256).toBe(summary.graphSha256)
    const updated = await store.save({ id: draft.id, spec: { ...spec(), displayName: '新名称' } })
    expect(await store.comfyAssetSummaries(updated.id)).toHaveLength(1)
    const changed = spec()
    changed.operations[0]!.description = '修改了执行合同'
    await store.save({ id: draft.id, spec: changed })
    expect(await store.comfyAssetSummaries(draft.id)).toEqual([])
    await store.close()
    const reopened = new LocalPluginDraftStore({ path, maxDrafts: 2, maxBytes: 1_000_000 })
    expect(await reopened.list()).toHaveLength(1)
    await reopened.close()
  })

  it('rejects stale consent target and disk tampering without replacing the saved graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-comfy-asset-'))
    roots.push(root)
    const path = join(root, 'drafts.json')
    const store = new LocalPluginDraftStore({ path, maxDrafts: 2, maxBytes: 1_000_000 })
    const draft = await store.save({ spec: spec() })
    await expect(store.bindComfyAsset({ id: draft.id, expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      operationId: 'owner.comfy.render', workflow: graph(), mapping })).rejects.toThrow('COMPUTE_PLUGIN_DRAFT_CHANGED')
    expect(await store.comfyAssetSummaries(draft.id)).toEqual([])
    await store.bindComfyAsset({ id: draft.id, expectedUpdatedAt: draft.updatedAt,
      operationId: 'owner.comfy.render', workflow: graph(), mapping })
    const document = JSON.parse(await readFile(path, 'utf8')) as { drafts: Array<{ comfyAssets: Array<{ graphSha256: string }> }> }
    document.drafts[0]!.comfyAssets[0]!.graphSha256 = '0'.repeat(64)
    const tampered = JSON.stringify(document)
    await writeFile(path, tampered)
    await expect(store.list()).rejects.toThrow('COMPUTE_PLUGIN_DRAFT_STORE_INVALID')
    await expect(store.bindComfyAsset({ id: draft.id, expectedUpdatedAt: draft.updatedAt,
      operationId: 'owner.comfy.render', workflow: graph(), mapping })).rejects.toThrow('COMPUTE_PLUGIN_DRAFT_STORE_INVALID')
    expect(await readFile(path, 'utf8')).toBe(tampered)
    await store.close()
  })
})
