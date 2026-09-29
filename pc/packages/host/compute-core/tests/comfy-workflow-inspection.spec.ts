import { describe, expect, it } from 'vitest'
import { inspectComfyApiWorkflow } from '../src/comfy-workflow-inspection.ts'

const graph = {
  '3': { class_type: 'KSampler', inputs: { seed: 7, model: ['4', 0], positive: ['6', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'owner-private-model.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt text', clip: ['4', 1] }, _meta: { title: 'private title' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'owner-private-dir' } },
}

describe('owner-provided ComfyUI API workflow inspection', () => {
  it('returns mappable fields without echoing private parameter values', () => {
    const inspected = inspectComfyApiWorkflow(graph)
    expect(inspected).toMatchObject({ format: 'comfyui-api-workflow', nodeCount: 4,
      textFields: [{ nodeId: '6', classType: 'CLIPTextEncode', field: 'text' }],
      seedFields: [{ nodeId: '3', classType: 'KSampler', field: 'seed' }],
      modelFields: [{ nodeId: '4', classType: 'CheckpointLoaderSimple', field: 'ckpt_name' }],
      imageOutputNodes: [{ nodeId: '9', classType: 'SaveImage' }],
      state: 'needs-owner-mapping', installable: false, dispatchable: false })
    const visible = JSON.stringify(inspected)
    for (const secret of ['private prompt text', 'owner-private-model', 'owner-private-dir', 'private title']) {
      expect(visible).not.toContain(secret)
    }
  })

  it('rejects editor UI JSON and oversized workflow before returning candidates', () => {
    expect(() => inspectComfyApiWorkflow({ nodes: [] })).toThrow('COMPUTE_COMFY_WORKFLOW_INVALID')
    expect(() => inspectComfyApiWorkflow({ '1': { class_type: 'SaveImage', inputs: { text: 'x'.repeat(256 * 1024) } } }))
      .toThrow('COMPUTE_COMFY_WORKFLOW_INVALID')
  })
})
