import { describe, expect, it } from 'vitest'
import { COMFY_VIDEO_RUNNER_ABI, canonicalComfyVideoApiGraphJson, comfyVideoPublicContractDigest,
  parseComfyVideoPublicContract, summarizeComfyVideoApiGraph,
  verifyComfyVideoPublicGraph } from '../src/comfy-video-public-contract.ts'

const graph = {
  '7': { class_type: 'VHS_VideoCombine', inputs: { images: ['5', 0], format: 'video/h264-mp4' } },
  '5': { class_type: 'KSampler', inputs: { seed: 7, positive: ['2', 0] } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'owner-only prompt', clip: ['1', 0] } },
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'owner-only-model.safetensors' } },
}

function valid() {
  return {
    schema: 'qianshou.comfy-video-public-contract.v1',
    taskType: 'owner_video_workflow_v1', capabilityId: 'video.render',
    graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(graph) },
    inputSlots: [
      { name: 'prompt', kind: 'text', nodeId: '2', field: 'text', maxUtf8Bytes: 4096 },
      { name: 'seed', kind: 'integer', nodeId: '5', field: 'seed', min: 0, max: 1_000_000 },
    ],
    outputs: [{ nodeId: '7', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
    runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'a'.repeat(64) },
    dependencyManifestSha256: 'b'.repeat(64),
    limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
      maxVramMiB: 16384, maxInputBytes: 8192, maxOutputBytes: 64 * 1024 * 1024,
      timeoutSeconds: 600 },
  }
}

describe('ComfyUI video public contract v1', () => {
  it('hashes an API graph independent of JSON key insertion order, without publishing graph bytes', () => {
    const reversed = {
      '1': { inputs: { ckpt_name: 'owner-only-model.safetensors' }, class_type: 'CheckpointLoaderSimple' },
      '2': { inputs: { clip: ['1', 0], text: 'owner-only prompt' }, class_type: 'CLIPTextEncode' },
      '5': { inputs: { positive: ['2', 0], seed: 7 }, class_type: 'KSampler' },
      '7': { inputs: { format: 'video/h264-mp4', images: ['5', 0] }, class_type: 'VHS_VideoCombine' },
    }
    expect(summarizeComfyVideoApiGraph(reversed)).toEqual(summarizeComfyVideoApiGraph(graph))
    const result = verifyComfyVideoPublicGraph(valid(), graph)
    expect(result).toEqual(parseComfyVideoPublicContract(valid()))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.inputSlots[0])).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/owner-only|127\.0\.0\.1|safetensors/u)
  })

  it('keeps the exact canonical JSON bytes stable for reordered floating-point graph inputs', () => {
    const first = { '1': { class_type: 'KSampler', inputs: { cfg: 7.125, denoise: 0.75 } } }
    const reordered = { '1': { inputs: { denoise: 0.75, cfg: 7.125 }, class_type: 'KSampler' } }
    expect(canonicalComfyVideoApiGraphJson(first))
      .toBe('{"1":{"class_type":"KSampler","inputs":{"cfg":7.125,"denoise":0.75}}}')
    expect(canonicalComfyVideoApiGraphJson(reordered)).toBe(canonicalComfyVideoApiGraphJson(first))
    expect(summarizeComfyVideoApiGraph(reordered)).toEqual(summarizeComfyVideoApiGraph(first))
  })

  it('accepts the 5080 H3 node spelling and length slot without treating node syntax as approval', () => {
    const h3Graph = {
      '2': { class_type: 'MiniMaxH3ImageToVideo', inputs: {
        prompt: 'owner-only scene', width: 1344, height: 768, length: 124 } },
      '13': { class_type: 'RandomNoise', inputs: { noise_seed: 2_000_000_000 } },
      '30': { class_type: 'LayerUtility: PurgeVRAM V2', inputs: {
        anything: ['2', 0], purge_cache: true, purge_models: true } },
      '27': { class_type: 'VHS_VideoCombine', inputs: {
        images: ['30', 0], format: 'video/h264-mp4' } },
    }
    const base = valid()
    const h3 = { ...base, graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(h3Graph) },
      limits: { ...base.limits, maxFrames: 124 },
      inputSlots: [
        { name: 'prompt', kind: 'text', nodeId: '2', field: 'prompt', maxUtf8Bytes: 4096 },
        { name: 'length', kind: 'integer', nodeId: '2', field: 'length', min: 1, max: 124 },
        { name: 'seed', kind: 'integer', nodeId: '13', field: 'noise_seed', min: 0,
          max: 2_000_000_000 },
      ],
      outputs: [{ nodeId: '27', classType: 'VHS_VideoCombine', kind: 'artifact_ref',
        mimeType: 'video/mp4' }] }
    expect(verifyComfyVideoPublicGraph(h3, h3Graph).outputs[0].nodeId).toBe('27')
    expect(() => parseComfyVideoPublicContract({ ...h3, inputSlots: [h3.inputSlots[0],
      { ...h3.inputSlots[1], max: 125 }, h3.inputSlots[2]] }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => summarizeComfyVideoApiGraph({ '1': { class_type: 'C:\\local\\node', inputs: {} } }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
  })

  it('pins a deterministic sorted-key UTF-8 digest separate from fixed H3 and private graph digests', () => {
    const first = valid()
    const reordered = { limits: { timeoutSeconds: 600, maxOutputBytes: 64 * 1024 * 1024,
      maxInputBytes: 8192, maxVramMiB: 16384, maxHeight: 768, maxWidth: 1344,
      maxFrames: 120, maxDurationSeconds: 5 },
    dependencyManifestSha256: first.dependencyManifestSha256, runner: { sourceSha256: 'a'.repeat(64),
      abi: COMFY_VIDEO_RUNNER_ABI }, outputs: first.outputs, inputSlots: [...first.inputSlots].reverse(),
    graph: { nodeCount: 4, sha256: first.graph.sha256, format: 'comfyui-api' },
    capabilityId: 'video.render', taskType: first.taskType, schema: first.schema }
    expect(comfyVideoPublicContractDigest(reordered)).toBe(comfyVideoPublicContractDigest(first))
    expect(comfyVideoPublicContractDigest(first)).toMatch(/^sha256:[a-f0-9]{64}$/u)
    const changed = valid()
    changed.dependencyManifestSha256 = 'c'.repeat(64)
    expect(comfyVideoPublicContractDigest(changed)).not.toBe(comfyVideoPublicContractDigest(first))
  })

  it('declares bounded image inputs without publishing a local image filename or path', () => {
    const privateGraph = { ...graph, '8': { class_type: 'LoadImage',
      inputs: { image: 'C:\\Users\\owner\\private-input.png' } } }
    const base = valid()
    const candidate = { ...base, graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(privateGraph) },
      inputSlots: [...base.inputSlots, { name: 'source_image', kind: 'artifact_ref', nodeId: '8',
        field: 'image', mimeType: 'image/png', maxBytes: 8 * 1024 * 1024 }],
      limits: { ...base.limits, maxInputBytes: 8 * 1024 * 1024 + 4096 } }
    const parsed = verifyComfyVideoPublicGraph(candidate, privateGraph)
    expect(parsed.inputSlots).toHaveLength(3)
    expect(JSON.stringify(parsed)).not.toContain('private-input.png')
    expect(() => verifyComfyVideoPublicGraph({ ...candidate, inputSlots: base.inputSlots }, privateGraph))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => verifyComfyVideoPublicGraph({ ...candidate,
      graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph({ ...privateGraph,
        '9': { class_type: 'LoadImage', inputs: { image: 'owner-unmapped.png' } } }) } },
    { ...privateGraph, '9': { class_type: 'LoadImage', inputs: { image: 'owner-unmapped.png' } } }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    const hiddenVideo = { ...privateGraph,
      '9': { class_type: 'VHS_LoadVideo', inputs: { video: 'owner-local.mp4' } } }
    expect(() => verifyComfyVideoPublicGraph({ ...candidate,
      graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(hiddenVideo) } }, hiddenVideo))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...candidate, limits: { ...candidate.limits,
      maxInputBytes: 1024 } })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...candidate, inputSlots: [...base.inputSlots,
      { name: 'source_image', kind: 'artifact_ref', nodeId: '8', field: 'image',
        mimeType: 'video/mp4', maxBytes: 1024 }] })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...candidate, inputSlots: [...base.inputSlots,
      { name: 'source_video', kind: 'artifact_ref', nodeId: '8', field: 'video',
        mimeType: 'video/mp4', maxBytes: 1024 }] })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
  })

  it('rejects private paths, ports, unknown fields, extra outputs, unsupported input mappings and limits', () => {
    const base = valid()
    expect(() => parseComfyVideoPublicContract({ ...base, port: 8194 })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, graph: { ...base.graph,
      path: 'C:\\models\\private' } })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, taskType: 'C:\\workflows\\owner' }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, outputs: [...base.outputs, ...base.outputs] }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, outputs: [{ ...base.outputs[0],
      mimeType: 'image/png' }] })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, inputSlots: [{ ...base.inputSlots[0],
      field: 'api_key' }] })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, inputSlots: [...base.inputSlots,
      { ...base.inputSlots[1], name: 'duplicate', nodeId: '2', field: 'text' }] }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, limits: { ...base.limits,
      maxFrames: 601 } })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, inputSlots: [...base.inputSlots,
      { name: 'width', kind: 'integer', nodeId: '5', field: 'width', min: 64, max: 2048 }] }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, limits: { ...base.limits,
      maxInputBytes: 1024 } })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => parseComfyVideoPublicContract({ ...base, dependencyManifestSha256: 'B'.repeat(64) }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
  })

  it('rejects a changed private graph or mismatched input and output references', () => {
    const base = valid()
    expect(() => verifyComfyVideoPublicGraph(base, { ...graph, '2': {
      class_type: 'CLIPTextEncode', inputs: { text: 'new prompt', clip: ['1', 0] } } }))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => verifyComfyVideoPublicGraph({ ...base, inputSlots: [{ name: 'prompt', kind: 'text',
      nodeId: '5', field: 'text', maxUtf8Bytes: 4096 }] }, graph))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => verifyComfyVideoPublicGraph({ ...base, outputs: [{ ...base.outputs[0],
      classType: 'SaveVideo' }] }, graph)).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    const secondOutput = { ...graph, '10': { class_type: 'SaveVideo', inputs: {} } }
    expect(() => verifyComfyVideoPublicGraph({ ...base, graph: { format: 'comfyui-api',
      ...summarizeComfyVideoApiGraph(secondOutput) } }, secondOutput))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    const gifGraph = { ...graph, '7': { class_type: 'VHS_VideoCombine',
      inputs: { images: ['5', 0], format: 'image/gif' } } }
    expect(() => verifyComfyVideoPublicGraph({ ...base, graph: { format: 'comfyui-api',
      ...summarizeComfyVideoApiGraph(gifGraph) } }, gifGraph))
      .toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    const missingFormat = { ...graph, '7': { class_type: 'SaveVideo', inputs: { images: ['5', 0] } } }
    expect(() => verifyComfyVideoPublicGraph({ ...base, graph: { format: 'comfyui-api',
      ...summarizeComfyVideoApiGraph(missingFormat) }, outputs: [{ ...base.outputs[0],
      classType: 'SaveVideo' }] }, missingFormat)).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
  })

  it('rejects malformed or oversized API graphs before producing public hashes', () => {
    expect(() => summarizeComfyVideoApiGraph({ nodes: [] })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => summarizeComfyVideoApiGraph({ '1': { class_type: 'SaveVideo', inputs: {
      text: 'x'.repeat(256 * 1024) } } })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => summarizeComfyVideoApiGraph({ '1': { class_type: 'SaveVideo', inputs: {
      text: Number.NaN } } })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
    expect(() => summarizeComfyVideoApiGraph({ '1': { class_type: 'SaveVideo', inputs: {
      text: '\uD800' } } })).toThrow('COMPUTE_COMFY_VIDEO_CONTRACT_INVALID')
  })
})
