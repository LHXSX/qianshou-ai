import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { COMFY_VIDEO_RUNNER_ABI, comfyVideoPublicContractDigest } from '../src/comfy-video-public-contract.ts'
import { parseReviewedVideoTaskInput } from '../src/reviewed-video-task-input.ts'
import {
  DEVELOPER_TASK_CREATE_PATH,
  DEVELOPER_TASK_TIMEOUT_S,
  developerTaskCreateBody,
  developerTaskIntentRequest,
  developerTaskResultPath,
  capabilityIdForTaskType,
  capabilityIdIfRegistered,
  landingTaskType,
  preferredLandingTaskType,
  publishableTaskTypes,
  yuanFromFen,
} from '../src/developer-task.ts'

const request = {
  capabilityId: ComputeCapabilityId('media.transcode'),
  goal: '清理这批图片并保持原图尺寸。',
  budgetMinor: 50,
  currency: 'CNY' as const,
  maxNodes: 2,
}

const taskType = {
  taskType: 'video_compress',
  acceptedInputKinds: ['inline', 'single_file'],
  defaultInputKind: 'inline',
}

describe('developer task create body', () => {
  it('pins observed DeveloperTaskCreateIn fields and integer fen as a yuan decimal string', () => {
    const fields = developerTaskIntentRequest(request, taskType)
    expect(fields).toEqual({
      task_type: 'video_compress',
      input_kind: 'inline',
      input_ref: '',
      input_refs: [],
      inline_input: request.goal,
      params: {},
      name: '',
      budget: '0.50',
      quote_token: null,
      timeout_s: DEVELOPER_TASK_TIMEOUT_S,
      max_shards: 2,
      auto_shard: true,
      callback_url: '',
      callback_secret: '',
    })
    expect(JSON.stringify(fields)).not.toContain('/api/v8/workloads')
    expect(developerTaskCreateBody(fields, 'a'.repeat(64)).idempotency_key).toHaveLength(64)
    expect(DEVELOPER_TASK_CREATE_PATH).toBe('/api/v8/developer/tasks')
    expect(developerTaskResultPath('workload-1')).toBe('/api/v8/developer/tasks/workload-1/result')
    expect(developerTaskResultPath('workload-1')).not.toContain('download')
    expect(developerTaskResultPath('../secret')).toBe('/api/v8/developer/tasks/..%2Fsecret/result')
  })

  it('uses one shard and disables auto-shard when concurrency is automatic', () => {
    expect(developerTaskIntentRequest({ ...request, maxNodes: null }, taskType)).toMatchObject({
      max_shards: 1, auto_shard: false, budget: '0.50',
    })
  })

  it('sends reviewed scalar parameters unchanged in the final task body', () => {
    const paramsSchema = { type: 'object' as const, additionalProperties: false as const,
      required: ['keyword'], properties: { keyword: { type: 'string' as const, minLength: 1 },
        top_n: { type: 'integer' as const, minimum: 1, maximum: 1000 } } }
    const fields = developerTaskIntentRequest({ ...request, capabilityId: ComputeCapabilityId('text.transform'),
      params: { keyword: '法律', top_n: 25 } }, {
      taskType: 'word_count', acceptedInputKinds: ['inline'], defaultInputKind: 'inline', requiredParams: ['keyword'],
      formSchemaVersion: 'qianshou.task-input-form.v1', formReady: true,
      inputSchema: { oneOf: [] }, paramsSchema,
    })
    expect(fields.params).toEqual({ keyword: '法律', top_n: 25 })
    expect(developerTaskCreateBody(fields, 'a'.repeat(64)).params).toEqual(fields.params)
  })

  it('binds a reviewed first-frame file revision and natural-language prompt to one video task', () => {
    const publicContract = {
      schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'owner_video_v1',
      capabilityId: 'video.render', graph: { format: 'comfyui-api', sha256: 'a'.repeat(64), nodeCount: 3 },
      inputSlots: [
        { name: 'prompt', kind: 'text', nodeId: '2', field: 'prompt', maxUtf8Bytes: 4096 },
        { name: 'first_frame', kind: 'artifact_ref', nodeId: '100', field: 'image',
          mimeType: 'image/png', maxBytes: 16 * 1024 * 1024 },
      ],
      outputs: [{ nodeId: '27', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
      runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'b'.repeat(64) },
      dependencyManifestSha256: 'c'.repeat(64),
      limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
        maxVramMiB: 16384, maxInputBytes: 17 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024,
        timeoutSeconds: 600 },
    }
    const reviewedVideoInput = parseReviewedVideoTaskInput({
      schema: 'qianshou.reviewed-video-task-input.v1', status: 'approved',
      publication_id: '11111111-2222-4333-8444-555555555555',
      approved_contract_digest: comfyVideoPublicContractDigest(publicContract),
      public_contract: publicContract, first_frame_slot: 'first_frame', prompt_slot: 'prompt',
      first_frame_source: { kind: 'uploaded_input_manifest', parameter: 'input_manifest', index: 0 },
      prompt_param: 'prompt',
    }, 'owner_video_v1')
    const reviewedPublication = { schema: 'qianshou.reviewed-publication-selection.v1' as const,
      publication_id: reviewedVideoInput.publicationId,
      artifact_digest: `sha256:${'d'.repeat(64)}`,
      contract_sha256: `sha256:${'e'.repeat(64)}` }
    const file = { objectKey: `v8/account-41/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
      filename: 'frame.png', bytes: 9, sha256: 'b'.repeat(64), contentType: 'image/png',
      objectVersionId: 'version-1' }
    const video = { ...request, capabilityId: ComputeCapabilityId('owner_video_v1'),
      goal: '海面上的小白猫奔跑', params: { prompt: '海面上的小白猫奔跑' },
      fileInput: { kind: 'multi_file' as const, files: [file] },
      expectedVideoReview: { publicationId: reviewedVideoInput.publicationId,
        approvedContractDigest: reviewedVideoInput.approvedContractDigest,
        artifactDigest: reviewedPublication.artifact_digest,
        contractSha256: reviewedPublication.contract_sha256 } }
    const form = { taskType: 'owner_video_v1', capabilityId: ComputeCapabilityId('video.render'),
      reviewedVideoInput, reviewedPublication,
      acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file',
      requiredParams: ['input_manifest', 'prompt'],
      formSchemaVersion: 'qianshou.task-input-form.v1', formReady: true,
      inputSchema: { oneOf: [] }, paramsSchema: { type: 'object' as const, additionalProperties: false as const,
        required: ['input_manifest', 'prompt'], properties: {
          input_manifest: { type: 'string' as const }, prompt: { type: 'string' as const },
        } },
    }
    expect(landingTaskType(ComputeCapabilityId('owner_video_v1'), [form])).toBe(form)
    const fields = developerTaskIntentRequest(video, form)
    expect(fields.input_kind).toBe('multi_file')
    expect(fields.inline_input).toBeNull()
    expect(fields.params.prompt).toBe(video.goal)
    expect(JSON.parse(String(fields.params.input_manifest))).toEqual({
      schema: 'qianshou.uploaded-inputs.v1', files: [file],
    })
    expect(fields.input_refs).toEqual([file.objectKey])
    expect(fields.timeout_s).toBe(publicContract.limits.timeoutSeconds)
    expect(fields.reviewed_publication).toEqual(reviewedPublication)
    const selectedProduct = { productId: '33333333-3333-4333-8333-333333333333',
      publicationId: reviewedVideoInput.publicationId, ownerId: 41, version: '1' }
    expect(developerTaskIntentRequest({ ...video, expectedProduct: selectedProduct }, form))
      .toMatchObject({ reviewed_publication: reviewedPublication, selected_product: {
        product_id: selectedProduct.productId, publication_id: selectedProduct.publicationId,
        owner_id: selectedProduct.ownerId, version: selectedProduct.version,
      } })
    const { fileInput: approvedFileInput, ...withoutFileInput } = video
    expect(approvedFileInput).toBeDefined()
    expect(() => developerTaskIntentRequest({ ...withoutFileInput,
      params: { prompt: video.goal, input_manifest: '{}' } }, {
      ...form, acceptedInputKinds: ['inline', 'multi_file'], defaultInputKind: 'inline',
    })).toThrow('COMPUTE_VIDEO_MIXED_INPUT_INVALID')
    const unversionedFile = { objectKey: file.objectKey, filename: file.filename,
      bytes: file.bytes, sha256: file.sha256, contentType: file.contentType }
    const { reviewedVideoInput: originalReviewedInput, ...withoutReviewedInput } = form
    const { reviewedPublication: originalPublication, ...withoutPublication } = form
    expect(originalReviewedInput).toBeDefined()
    expect(originalPublication).toBeDefined()
    for (const [candidate, contract] of [
      [{ ...video, goal: 'different' }, form],
      [{ ...video, params: {} }, form],
      [{ ...video, fileInput: { kind: 'multi_file' as const,
        files: [{ ...file, contentType: 'application/pdf' }] } }, form],
      [{ ...video, fileInput: { kind: 'multi_file' as const,
        files: [unversionedFile] } }, form],
      [{ ...video, fileInput: { kind: 'multi_file' as const, files: [{ ...file,
        objectKey: `v8/account-41/developer/${'a'.repeat(32)}/input/frame.png` }] } }, form],
      [{ ...video, fileInput: { kind: 'multi_file' as const, files: [{ ...file,
        objectKey: `v8/account-41/reviewed-video/input/${'a'.repeat(32)}/frame.jpg`,
        filename: 'frame.jpg' }] } }, form],
      [video, { ...form, requiredParams: ['input_manifest'] }],
      [video, withoutReviewedInput],
      [video, withoutPublication],
    ] as const) {
      expect(() => developerTaskIntentRequest(candidate, contract))
        .toThrow(/COMPUTE_VIDEO_(?:MIXED_INPUT_INVALID|REVIEW_CHANGED)/u)
    }
    const { expectedVideoReview: originalReview, ...withoutReview } = video
    expect(originalReview).toBeDefined()
    expect(() => developerTaskIntentRequest(withoutReview, form))
      .toThrow('COMPUTE_VIDEO_MIXED_INPUT_INVALID')
    for (const expectedVideoReview of [
      { ...video.expectedVideoReview, publicationId: '22222222-2222-4222-8222-222222222222' },
      { ...video.expectedVideoReview, approvedContractDigest: `sha256:${'0'.repeat(64)}` },
      { ...video.expectedVideoReview, artifactDigest: `sha256:${'0'.repeat(64)}` },
      { ...video.expectedVideoReview, contractSha256: `sha256:${'0'.repeat(64)}` }]) {
      expect(() => developerTaskIntentRequest({ ...video, expectedVideoReview }, form)).toThrow()
    }
    expect(() => developerTaskIntentRequest({ ...video,
      expectedProduct: { productId: '33333333-3333-4333-8333-333333333333',
        publicationId: '22222222-2222-4222-8222-222222222222', ownerId: 41, version: '1' },
    }, form)).toThrow('COMPUTE_VIDEO_REVIEW_CHANGED')
  })

  it('does not apply video first-frame admission to an unrelated image-capable skill', () => {
    const file = { objectKey: `v8/account-41/developer/${'a'.repeat(32)}/input/example.png`,
      filename: 'example.png', bytes: 9, sha256: 'b'.repeat(64), contentType: 'image/png',
      objectVersionId: 'version-1' }
    const body = developerTaskIntentRequest({ ...request, capabilityId: ComputeCapabilityId('text.transform'),
      params: { prompt: '给图片写说明' }, fileInput: { kind: 'multi_file', files: [file] } }, {
      taskType: 'word_count', acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file',
      requiredParams: ['input_manifest', 'prompt'],
      formSchemaVersion: 'qianshou.task-input-form.v1', formReady: true,
      inputSchema: { oneOf: [] }, paramsSchema: { type: 'object', additionalProperties: false,
        required: ['input_manifest', 'prompt'], properties: {
          input_manifest: { type: 'string' }, prompt: { type: 'string' },
        } },
    })
    expect(body.input_kind).toBe('multi_file')
    expect(body.params.prompt).toBe('给图片写说明')
    expect(() => developerTaskIntentRequest({ ...request,
      capabilityId: ComputeCapabilityId('text.transform'), params: { prompt: '给图片写说明' },
      fileInput: { kind: 'multi_file', files: [file] },
      expectedVideoReview: { publicationId: '11111111-2222-4333-8444-555555555555',
        approvedContractDigest: `sha256:${'a'.repeat(64)}`,
        artifactDigest: `sha256:${'b'.repeat(64)}`, contractSha256: `sha256:${'c'.repeat(64)}` } }, {
      taskType: 'word_count', acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file',
    })).toThrow('COMPUTE_VIDEO_REVIEW_UNEXPECTED')
  })

  it.each([0, 1, 100, 101, 199])('keeps exact fen as two decimal digits: %s', (budgetMinor) => {
    expect(yuanFromFen(budgetMinor)).toBe(`${Math.trunc(budgetMinor / 100)}.${String(budgetMinor % 100).padStart(2, '0')}`)
  })

  it('refuses a catalogue row that does not accept inline conversation input', () => {
    expect(() => developerTaskIntentRequest(request, {
      taskType: 'video_compress', acceptedInputKinds: ['single_file'], defaultInputKind: 'single_file',
    })).toThrow('COMPUTE_INPUT_KIND_UNSUPPORTED')
  })

  it('refuses a catalogue row whose task type does not match the local capability', () => {
    expect(() => developerTaskIntentRequest(request, {
      ...taskType, taskType: 'video.batch',
    })).toThrow('COMPUTE_CAPABILITY_UNAVAILABLE')
  })

  it('accepts a catalogue row listed as a registry legacy task type of the semantic capability', () => {
    const semantic = { ...request, capabilityId: ComputeCapabilityId('media.transcode') }
    expect(publishableTaskTypes(semantic.capabilityId)).toEqual(['media.transcode', 'video_compress', 'video_repurpose'])
    const fields = developerTaskIntentRequest(semantic, { ...taskType, taskType: 'video_compress' })
    // The platform registry has no contract ids (media.transcode → __default__).
    // The wire carries the catalogue landing the dispatcher actually filters on.
    expect(fields.task_type).toBe('video_compress')
  })

  it('prefers a catalogue legacy landing over the semantic id', () => {
    const semantic = ComputeCapabilityId('media.transcode')
    const catalogue = [
      { taskType: 'media.transcode', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' },
      { taskType: 'video_compress', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' },
    ]
    expect(landingTaskType(semantic, catalogue)?.taskType).toBe('video_compress')
    expect(landingTaskType(semantic, [{ taskType: 'video_compress', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' }])?.taskType).toBe('video_compress')
    expect(landingTaskType(semantic, [{ taskType: 'image_resize', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' }])).toBeUndefined()
    const text = ComputeCapabilityId('text.transform')
    expect(landingTaskType(text, [
      { taskType: 'base64_decode', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' },
      { taskType: 'word_count', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' },
    ])?.taskType).toBe('word_count')
  })

  it('names the semantic capability with no landing when the row is outside its registry mapping', () => {
    const semantic = { ...request, capabilityId: ComputeCapabilityId('media.transcode') }
    expect(() => developerTaskIntentRequest(semantic, { ...taskType, taskType: 'image_resize' }))
      .toThrow(/COMPUTE_CAPABILITY_UNAVAILABLE: capability "media\.transcode" has no task_type "image_resize"/u)
  })

  it('maps a platform task_type to its semantic capability and refuses unknown names', () => {
    expect(capabilityIdForTaskType('video_compress')).toBe('media.transcode')
    expect(capabilityIdForTaskType('media.transcode')).toBe('media.transcode')
    expect(capabilityIdForTaskType('image.generate')).toBe('image.generate')
    expect(capabilityIdForTaskType('word_count')).toBe('text.transform')
    expect(() => capabilityIdForTaskType('invented.capability')).toThrow('COMPUTE_CAPABILITY_UNAVAILABLE')
    expect(capabilityIdIfRegistered('video_compress')).toBe('media.transcode')
    expect(capabilityIdIfRegistered('word_count')).toBe('text.transform')
    expect(capabilityIdIfRegistered('qianshou_film_media')).toBe('media.compose')
    expect(capabilityIdIfRegistered('invented.capability')).toBeUndefined()
  })

  it('quotes the first registry landing and leaves unknown names verbatim', () => {
    expect(preferredLandingTaskType('media.transcode')).toBe('video_compress')
    expect(preferredLandingTaskType('video_compress')).toBe('video_compress')
    expect(preferredLandingTaskType('text.transform')).toBe('word_count')
    expect(preferredLandingTaskType('word_count')).toBe('word_count')
    expect(preferredLandingTaskType('accelerator.gpu')).toBe('accelerator.gpu')
    expect(preferredLandingTaskType('image.generate')).toBe('image.generate')
    expect(preferredLandingTaskType('media.compose')).toBe('qianshou_film_media')
    expect(preferredLandingTaskType('invented.capability')).toBe('invented.capability')
  })

  it('lets parsePlanRequest own landing admission and does not remap again in createPlan', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/service.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('async createPlan')
    const end = source.indexOf('async createChain')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    expect(body).toContain('parsePlanRequest')
    expect(body).not.toContain('capabilityIdForTaskType')
    expect(body).toContain('return this.store.create(request)')
  })

  it('maps a registered Edge offer taskType through the reverse map', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/transport/inline-edge-bridge.ts', import.meta.url)), 'utf8')
    expect(source).toContain('capabilityIdIfRegistered(offer.taskType)')
    expect(source).not.toContain('capabilityId: ComputeCapabilityId(offer.taskType)')
  })

  it('publishes the reverse map on the compute-core public face', async () => {
    const published = await import('../src/index.ts')
    expect(published.capabilityIdForTaskType('video_compress')).toBe('media.transcode')
    expect(published.capabilityIdIfRegistered('word_count')).toBe('text.transform')
    expect(published.capabilityIdIfRegistered('invented.capability')).toBeUndefined()
    expect(published.preferredLandingTaskType('media.transcode')).toBe('video_compress')
    expect(published.landingTaskType(ComputeCapabilityId('media.transcode'), [
      { taskType: 'video_compress', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' },
    ])?.taskType).toBe('video_compress')
    expect(published.publishableTaskTypes(ComputeCapabilityId('media.transcode'))).toEqual([
      'media.transcode', 'video_compress', 'video_repurpose',
    ])
    const index = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(index).toContain('export { capabilityIdForTaskType, capabilityIdIfRegistered, landingTaskType, preferredLandingTaskType, publishableTaskTypes } from \'./developer-task.ts\'')
    expect(index).toContain("export type { DeveloperTaskType } from './developer-task.ts'")
  })

  it('rejects unsafe or negative fen', () => {
    expect(() => yuanFromFen(-1)).toThrow('INVALID_COMPUTE_FIELD')
    expect(() => yuanFromFen(1.5)).toThrow('INVALID_COMPUTE_FIELD')
  })

  it.each(['', 'x'.repeat(129)])('rejects an idempotency key outside 1–128 characters: %s', (key) => {
    const fields = developerTaskIntentRequest(request, taskType)
    expect(() => developerTaskCreateBody(fields, key)).toThrow('COMPUTE_SUBMISSION_INTENT_INVALID')
  })
})
