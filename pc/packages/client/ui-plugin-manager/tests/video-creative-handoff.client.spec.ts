import { describe, expect, it, vi } from 'vitest'
import { asksForSpecificVideoDuration, asksForUnverifiedVideoDuration,
  confirmVideoImageChoice, prepareVideoImageChoices, stageConfirmedVideoChoice,
  supportsVideoFirstFrameTask,
  videoMarketTaskRequest } from '../src/client/video-creative-handoff.ts'
import { createMarketTaskTransport, type MarketTaskType } from '../src/client/market-task-transport.ts'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
const jpeg = new Uint8Array([255, 216, 1, 2, 255, 217, 255, 217])
const videoReview = { schema: 'qianshou.reviewed-video-task-input.v1' as const,
  publicationId: '11111111-2222-4333-8444-555555555555',
  approvedContractDigest: `sha256:${'a'.repeat(64)}`,
  firstFrameSlot: 'first_frame', promptSlot: 'prompt',
  firstFrameManifestParam: 'input_manifest' as const, firstFrameManifestIndex: 0 as const,
  promptParam: 'prompt' as const,
  mimeType: 'image/jpeg' as const, maxBytes: 16 * 1024 * 1024, maxPromptUtf8Bytes: 8192 }
const reviewedPublication = { schema: 'qianshou.reviewed-publication-selection.v1' as const,
  publicationId: videoReview.publicationId, artifactDigest: `sha256:${'b'.repeat(64)}`,
  contractSha256: `sha256:${'c'.repeat(64)}` }
const videoType: MarketTaskType = {
  taskType: 'owner_video_v1', capabilityId: 'video.render',
  acceptedInputKinds: ['multi_file'], requiredParams: ['input_manifest', 'prompt'],
  canQuoteInline: false, canQuoteFiles: true,
  reviewedVideoInput: videoReview, reviewedPublication,
  paramFields: [{ name: 'prompt', title: '画面描述', type: 'string', required: true,
    minLength: 1, maxLength: 8000 }],
}
const pngType: MarketTaskType = { ...videoType, reviewedVideoInput: { ...videoReview,
  mimeType: 'image/png' } }

function upload(version = 'v1') {
  return vi.fn(async (file: File, _signal: AbortSignal, _purpose?: 'reviewed-video-first-frame') => ({ objectKey: `v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.${file.type === 'image/png' ? 'png' : 'jpg'}`,
    filename: file.type === 'image/png' ? 'frame.png' : 'frame.jpg', bytes: file.size,
    sha256: '0'.repeat(64), contentType: file.type,
    objectVersionId: version }))
}

describe('video creative handoff', () => {
  it('treats written minute-second lengths and video clocks as explicit duration requirements', () => {
    for (const brief of ['做 1m 视频', '时长 1m', '时长 00:30', '01:00 的短片',
      '时长 1:30', '做一个 1:00 视频', '生成1:30视频', '拍1分5秒短片',
      '做1分05秒视频', '生成 2分5秒视频', '1m5s 视频', '五秒半',
      '5s 后改成 1m', '1h 视频']) {
      expect(asksForSpecificVideoDuration(brief), brief).toBe(true)
      expect(asksForUnverifiedVideoDuration(brief, 5), brief).toBe(true)
    }
    for (const brief of ['做 5s 视频', '拍五秒', '时长 00:05', '0:05', '0m5s 视频',
      '0分5秒视频', '镜头推进 1m，做 5s 视频']) {
      expect(asksForSpecificVideoDuration(brief), brief).toBe(true)
      expect(asksForUnverifiedVideoDuration(brief, 5), brief).toBe(false)
      expect(asksForUnverifiedVideoDuration(brief, null), brief).toBe(true)
    }
    for (const brief of ['9:16 竖屏构图', '做一个 9:16 视频']) {
      expect(asksForSpecificVideoDuration(brief), brief).toBe(false)
      expect(asksForUnverifiedVideoDuration(brief, 5), brief).toBe(false)
    }
  })

  it('sends the selected frame through the dedicated local upload purpose', async () => {
    const frame = new File([png], 'first.png', { type: 'image/png' })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      objectKey: `v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
      filename: 'frame.png', bytes: frame.size, sha256: 'a'.repeat(64),
      contentType: 'image/png', objectVersionId: 'version-1',
    }))
    const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    const receipt = await transport.uploadInputFile!(frame, new AbortController().signal,
      'reviewed-video-first-frame')
    expect(receipt.filename).toBe('frame.png')
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-qianshou-upload-purpose')).toBe('reviewed-video-first-frame')
  })

  it('prepares real local image snapshots and uploads only the selected image after approval', async () => {
    const choices = await prepareVideoImageChoices([
      new File([png], 'one.png', { type: 'image/png' }),
      new File([jpeg], 'two.jpg', { type: 'image/jpeg' }),
    ])
    const send = upload()
    expect(send).not.toHaveBeenCalled()
    expect(choices).toHaveLength(2)
    const confirmation = confirmVideoImageChoice(choices, choices[1]!.id, '晴天海面，镜头缓缓推进', videoType)
    send.mockImplementationOnce(async file => ({ objectKey: `v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.jpg`,
      filename: 'frame.jpg', bytes: file.size, sha256: confirmation.approvedSha256,
      contentType: file.type, objectVersionId: 'version-2' }))
    const asset = await stageConfirmedVideoChoice(confirmation, send, new AbortController().signal)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0].type).toBe('image/jpeg')
    expect(send.mock.calls[0]?.[2]).toBe('reviewed-video-first-frame')
    expect(asset.file.objectVersionId).toBe('version-2')
    expect(Object.isFrozen(asset.file)).toBe(true)
    expect(videoMarketTaskRequest(videoType, confirmation, asset)).toEqual({
      taskType: 'owner_video_v1', goal: '晴天海面，镜头缓缓推进',
      params: { prompt: '晴天海面，镜头缓缓推进' }, files: [asset.file],
      expectedVideoReview: { publicationId: videoReview.publicationId,
        approvedContractDigest: videoReview.approvedContractDigest,
        artifactDigest: reviewedPublication.artifactDigest,
        contractSha256: reviewedPublication.contractSha256 },
    })
  })

  it('keeps a valid large contract limit in the catalog while bounding local uploads to 16 MiB', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([
      { taskType: 'owner_video_v1', capabilityId: 'video.render',
        acceptedInputKinds: ['multi_file'], requiredParams: ['input_manifest', 'prompt'],
        canQuoteInline: false, canQuoteFiles: true, formReady: true,
        reviewedVideoInput: { ...videoReview, maxBytes: 256 * 1024 * 1024 },
        reviewedPublication,
        paramsSchema: { type: 'object', additionalProperties: false,
          required: ['input_manifest', 'prompt'], properties: {
            input_manifest: { type: 'string' }, prompt: { type: 'string' },
          } } },
      { taskType: 'text_skill', acceptedInputKinds: ['inline'], requiredParams: [],
        canQuoteInline: true, formReady: true },
    ]))
    const types = await createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
      .taskTypes(new AbortController().signal)
    expect(types).toHaveLength(2)
    expect(types[0]?.reviewedVideoInput?.maxBytes).toBe(256 * 1024 * 1024)
    expect(supportsVideoFirstFrameTask(types[0]!)).toBe(true)
    await expect(prepareVideoImageChoices([new File([new Uint8Array(16 * 1024 * 1024 + 1)],
      'large.png', { type: 'image/png' })])).rejects.toThrow('VIDEO_CREATIVE_INPUT_INVALID')
  })

  it('rejects fake image formats and unconfirmed upload requests', async () => {
    await expect(prepareVideoImageChoices([new File([png], 'fake.jpg', { type: 'image/jpeg' })]))
      .rejects.toThrow('VIDEO_CREATIVE_INPUT_INVALID')
    const send = upload()
    await expect(stageConfirmedVideoChoice({ choice: {} as never, prompt: 'x', approvedSha256: '0',
      expectedVideoReview: null },
    send, new AbortController().signal)).rejects.toThrow('VIDEO_CREATIVE_INPUT_INVALID')
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects mismatched or unversioned upload receipts', async () => {
    const choices = await prepareVideoImageChoices([new File([png], 'image.png', { type: 'image/png' })])
    const confirmation = confirmVideoImageChoice(choices, choices[0]!.id, '生成海面视频', pngType)
    const send = upload()
    await expect(stageConfirmedVideoChoice(confirmation, send, new AbortController().signal))
      .rejects.toThrow('VIDEO_IMAGE_UPLOAD_MISMATCH')
    const unversioned = vi.fn(async (file: File) => ({ objectKey: `v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
      filename: 'frame.png', bytes: file.size, sha256: confirmation.approvedSha256, contentType: file.type }))
    await expect(stageConfirmedVideoChoice(confirmation, unversioned, new AbortController().signal))
      .rejects.toThrow('VIDEO_IMAGE_UPLOAD_MISMATCH')
  })

  it('keeps old file-only and unsigned video forms away from a mixed image-and-text plan', async () => {
    const choices = await prepareVideoImageChoices([new File([png], 'image.png', { type: 'image/png' })])
    const confirmation = confirmVideoImageChoice(choices, choices[0]!.id, '生成海面视频', pngType)
    const send = upload()
    send.mockImplementationOnce(async file => ({ objectKey: `v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
      filename: 'frame.png', bytes: file.size, sha256: confirmation.approvedSha256,
      contentType: file.type, objectVersionId: 'version-1' }))
    const asset = await stageConfirmedVideoChoice(confirmation, send, new AbortController().signal)
    expect(supportsVideoFirstFrameTask(pngType)).toBe(true)
    const { reviewedPublication: _ignoredPublication, ...unsignedType } = pngType
    expect(supportsVideoFirstFrameTask(unsignedType)).toBe(false)
    expect(supportsVideoFirstFrameTask({ ...videoType, capabilityId: 'video_generate' })).toBe(false)
    expect(() => videoMarketTaskRequest({ ...pngType, capabilityId: 'video_generate' }, confirmation, asset))
      .toThrow('VIDEO_CREATIVE_INPUT_INVALID')
    expect(() => videoMarketTaskRequest({ ...pngType, requiredParams: ['input_manifest'],
      paramFields: [] }, confirmation, asset)).toThrow('VIDEO_CREATIVE_INPUT_INVALID')
    expect(() => videoMarketTaskRequest({ ...pngType, requiredParams: ['prompt'] }, confirmation, asset))
      .toThrow('VIDEO_CREATIVE_INPUT_INVALID')
    expect(() => videoMarketTaskRequest({ ...pngType, reviewedVideoInput: { ...pngType.reviewedVideoInput!,
      approvedContractDigest: `sha256:${'b'.repeat(64)}` } }, confirmation, asset))
      .toThrow('VIDEO_CREATIVE_INPUT_INVALID')
    expect(() => videoMarketTaskRequest({ ...pngType, reviewedPublication: {
      ...reviewedPublication, artifactDigest: `sha256:${'0'.repeat(64)}` } }, confirmation, asset))
      .toThrow('VIDEO_CREATIVE_INPUT_INVALID')
  })

  it('cannot stage a creative approved without a reviewed contract at the confirmation click', async () => {
    const choices = await prepareVideoImageChoices([new File([png], 'one.png', { type: 'image/png' })])
    const confirmation = confirmVideoImageChoice(choices, choices[0]!.id, '生成海面视频')
    const send = upload()
    await expect(stageConfirmedVideoChoice(confirmation, send, new AbortController().signal))
      .rejects.toThrow('VIDEO_CREATIVE_INPUT_INVALID')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the confirmed review identity only as a local plan expectation', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'plan_123' }))
      .mockResolvedValueOnce(Response.json({ id: 'plan_123', authorization: 'approved', workloadId: null }))
    const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
    await transport.createPlan('owner_video_v1', '海面小猫奔跑', new AbortController().signal,
      { prompt: '海面小猫奔跑' }, [], { publicationId: videoReview.publicationId,
        approvedContractDigest: videoReview.approvedContractDigest,
        artifactDigest: reviewedPublication.artifactDigest,
        contractSha256: reviewedPublication.contractSha256 })
    const body = fetcher.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe('string')
    const posted = JSON.parse(body as string) as Record<string, unknown>
    expect(posted.expectedVideoReview).toEqual({ publicationId: videoReview.publicationId,
      approvedContractDigest: videoReview.approvedContractDigest,
      artifactDigest: reviewedPublication.artifactDigest,
      contractSha256: reviewedPublication.contractSha256 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
