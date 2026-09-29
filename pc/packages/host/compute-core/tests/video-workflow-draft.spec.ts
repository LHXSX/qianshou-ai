import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VideoWorkflowDraftStore } from '../src/video-workflow-draft.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const graph = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'owner private prompt' } },
  '2': { class_type: 'VHS_VideoCombine', inputs: { format: 'video/h264-mp4', frame_rate: 24, images: ['1', 0] } },
}
const draft = { displayName: '我的本地视频工作流', template: 'text-to-video', graph,
  mapping: { prompt: { nodeId: '1', field: 'text' }, outputNodeId: '2' } }

describe('owner-private video workflow drafts', () => {
  it('stores graph privately and lists only non-dispatchable summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-video-workflow-'))
    roots.push(root)
    const path = join(root, 'private', 'video.json')
    const store = new VideoWorkflowDraftStore(path)
    const saved = await store.save(draft)
    expect(saved).toMatchObject({ displayName: draft.displayName, state: 'private-draft',
      installable: false, dispatchable: false, nodeCount: 2 })
    expect(saved.graphSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect((await store.list())).toEqual([saved])
    expect(JSON.stringify(await store.list())).not.toContain('owner private prompt')
    const privateDraft = await store.readPrivate(saved.id, saved.graphSha256)
    expect(privateDraft.graphJson).toContain('owner private prompt')
    expect(privateDraft.summary).toEqual(saved)
    await expect(store.readPrivate(saved.id, 'f'.repeat(64))).rejects.toThrow('COMPUTE_VIDEO_WORKFLOW_DRAFT_CHANGED')
    expect(await readFile(path, 'utf8')).toContain('owner private prompt')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('rejects invalid output or mapping before saving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-video-workflow-'))
    roots.push(root)
    const store = new VideoWorkflowDraftStore(join(root, 'private', 'video.json'))
    await expect(store.save({ ...draft, mapping: { ...draft.mapping, outputNodeId: '1' } })).rejects.toThrow()
    await expect(store.save({ ...draft, template: 'image-to-video' })).rejects.toThrow()
    await expect(store.save({ ...draft, graph: { ...graph,
      '3': { class_type: 'LoadImage', inputs: { image: 'private-first-frame.png' } } } })).rejects.toThrow()
    await expect(store.save({ ...draft, template: 'image-to-video', graph: { ...graph,
      '3': { class_type: 'LoadImage', inputs: { image: 'private-first-frame.png' } } },
    mapping: { ...draft.mapping, referenceImage: { nodeId: '3', field: 'image' } } })).resolves.toMatchObject({ state: 'private-draft' })
    await expect(store.save({ ...draft, graph: { ...graph,
      '3': { class_type: 'SaveVideo', inputs: { format: 'mp4' } } } })).rejects.toThrow()
    expect(await store.list()).toHaveLength(1)
  })

  it('keeps an H3-shaped MP4 graph private despite custom cleanup, frame PNGs and a nested reference path', async () => {
    // Structural regression fixture, not the Windows machine's exported 22-node graph.
    const h3Graph = {
      '2': { class_type: 'MiniMaxH3ImageToVideo', inputs: {
        prompt: 'owner private H3 prompt', length: 124, first_frame: ['100', 0] } },
      '13': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
      '27': { class_type: 'VHS_VideoCombine', inputs: {
        format: 'video/h264-mp4', frame_rate: 24, images: ['2', 0] } },
      '30': { class_type: 'LayerUtility: PurgeVRAM V2', inputs: { signal: ['2', 0] } },
      '100': { class_type: 'LoadImage', inputs: { image: 'first_frames/owner/reference.png' } },
      '101': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
      '102': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
      '103': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
      '200': { class_type: 'ImageFromBatch', inputs: { image: ['2', 0], batch_index: 119, length: 1 } },
    }
    const root = await mkdtemp(join(tmpdir(), 'qianshou-video-workflow-'))
    roots.push(root)
    const store = new VideoWorkflowDraftStore(join(root, 'private', 'video.json'))
    const mapping = { prompt: { nodeId: '2', field: 'prompt' },
      referenceImage: { nodeId: '100', field: 'image' },
      frames: { nodeId: '2', field: 'length' }, outputNodeId: '27' }
    const saved = await store.save({ ...draft, template: 'image-to-video', graph: h3Graph, mapping })
    expect(saved).toMatchObject({ nodeCount: 9, installable: false, dispatchable: false })
    const readback = await store.readPrivate(saved.id, saved.graphSha256)
    expect(readback.mapping).toEqual(mapping)
    expect(JSON.parse(readback.graphJson)).toEqual(h3Graph)
    expect(JSON.stringify(await store.list())).not.toContain('owner private H3 prompt')
    await expect(store.save({ ...draft, template: 'image-to-video', graph: h3Graph,
      mapping: { ...mapping, frames: { nodeId: '200', field: 'length' } } }))
      .rejects.toThrow('COMPUTE_VIDEO_WORKFLOW_DRAFT_INVALID')
    await expect(store.save({ ...draft, template: 'image-to-video',
      graph: { ...h3Graph, '104': { class_type: 'SaveVideo', inputs: { format: 'mp4' } } }, mapping }))
      .rejects.toThrow('COMPUTE_VIDEO_WORKFLOW_DRAFT_INVALID')
  })

  it('requires the exact prior revision to replace an existing graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-video-workflow-'))
    roots.push(root)
    const store = new VideoWorkflowDraftStore(join(root, 'private', 'video.json'))
    const saved = await store.save(draft)
    await expect(store.save({ ...draft, id: saved.id, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }))
      .rejects.toThrow('COMPUTE_VIDEO_WORKFLOW_DRAFT_CHANGED')
    expect(await store.list()).toEqual([saved])
  })
})
