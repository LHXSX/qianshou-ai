// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarketTaskCall as RawMarketTaskCall } from '../src/client/MarketTaskCall.tsx'
import type { MarketInputFile, MarketTaskTransport, MarketTaskType } from '../src/client/market-task-transport.ts'
import type { MarketTaskContinuation } from '../src/client/MarketTaskCall.tsx'
import { createVideoAssetPlanPreparer, type PrepareVideoAssetPlan, type VideoAssetPlan } from '../src/client/video-asset-plan.ts'
import { videoCreativePrompt } from '../src/client/VideoCreativeBrief.tsx'
import { zh } from '../src/client/market-task-progress-locales.ts'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
const sha256 = createHash('sha256').update(png).digest('hex')
const capability = { taskType: 'video_generate', capabilityId: 'video.render',
  name: '五秒视频生成', category: 'video' }
const oldForm: MarketTaskType = { taskType: 'video_generate', capabilityId: 'video.render',
  acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true }
const mixedForm: MarketTaskType = { taskType: 'video_generate', capabilityId: 'video.render',
  acceptedInputKinds: ['multi_file'], requiredParams: ['input_manifest', 'prompt'],
  canQuoteInline: false, canQuoteFiles: true, paramFields: [
    { name: 'prompt', title: '视频描述', type: 'string', required: true, minLength: 1, maxLength: 8000 },
  ], reviewedVideoInput: {
    schema: 'qianshou.reviewed-video-task-input.v1',
    publicationId: '663125de-83c4-4c47-ade1-0d5d5298f267',
    approvedContractDigest: `sha256:${'a'.repeat(64)}`,
    firstFrameSlot: 'first_frame', promptSlot: 'prompt',
    firstFrameManifestParam: 'input_manifest', firstFrameManifestIndex: 0,
    promptParam: 'prompt', mimeType: 'image/png',
    maxBytes: 16 * 1024 * 1024, maxPromptUtf8Bytes: 8192,
  }, reviewedPublication: {
    schema: 'qianshou.reviewed-publication-selection.v1',
    publicationId: '663125de-83c4-4c47-ade1-0d5d5298f267',
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    contractSha256: `sha256:${'d'.repeat(64)}`,
  } }
const fixedFiveForm: MarketTaskType = { ...mixedForm,
  requiredParams: ['fps', 'frames', 'input_manifest', 'prompt'],
  paramFields: [...mixedForm.paramFields!,
    { name: 'frames', title: '生成帧数', type: 'integer', required: true, minimum: 120, maximum: 120 },
    { name: 'fps', title: '每秒帧数', type: 'integer', required: true, minimum: 24, maximum: 24 }],
}
const changedReview: MarketTaskType = { ...fixedFiveForm, reviewedVideoInput: {
  ...fixedFiveForm.reviewedVideoInput!, approvedContractDigest: `sha256:${'b'.repeat(64)}`,
} }

function transport(form: MarketTaskType): MarketTaskTransport {
  return { taskTypes: vi.fn().mockResolvedValue([form]),
    uploadInputFile: vi.fn(async file => ({
      objectKey: `v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
      filename: 'frame.png', bytes: file.size, sha256, contentType: file.type, objectVersionId: 'version-1',
    })),
    createPlan: vi.fn().mockResolvedValue('plan_123'),
    quotePlan: vi.fn().mockResolvedValue({ planId: 'plan_123', quoteId: 'quote_123',
      taskType: form.taskType, currency: 'CNY', amountYuan: '2.00', balanceEnough: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    confirmAndPublish: vi.fn().mockResolvedValue('workload_123'),
    findWorkload: vi.fn().mockResolvedValue(null),
    readWorkload: vi.fn().mockResolvedValue({ id: 'workload_123', status: 'WAITING_FOR_WORKERS',
      resultAvailable: false }),
    readResult: vi.fn().mockRejectedValue(new Error('pending')),
    readAcceptance: vi.fn().mockResolvedValue(null),
    decideAcceptance: vi.fn().mockRejectedValue(new Error('not pending')) }
}

let priorArrayBuffer: PropertyDescriptor | undefined
let priorObjectUrl: PropertyDescriptor | undefined
let priorRevokeUrl: PropertyDescriptor | undefined

beforeEach(() => {
  priorArrayBuffer = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer')
  priorObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  priorRevokeUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(File.prototype, 'arrayBuffer', { configurable: true, value: function (this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { resolve(reader.result as ArrayBuffer) }
      reader.onerror = () => { reject(reader.error) }
      reader.readAsArrayBuffer(this)
    })
  } })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:video-frame') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.stubGlobal('crypto', webcrypto)
})

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (priorArrayBuffer) Object.defineProperty(File.prototype, 'arrayBuffer', priorArrayBuffer)
  else Reflect.deleteProperty(File.prototype, 'arrayBuffer')
  if (priorObjectUrl) Object.defineProperty(URL, 'createObjectURL', priorObjectUrl)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (priorRevokeUrl) Object.defineProperty(URL, 'revokeObjectURL', priorRevokeUrl)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

async function selectFirstFrame(): Promise<void> {
  finishQuestions()
  const file = new File([png], '海边首帧.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
  const name = await screen.findByText('海边首帧.png')
  fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
  fireEvent.click(name.closest('button')!)
  await confirmCurrentFramePlan()
  fireEvent.click(screen.getByRole('button', { name: '这张图和描述可以，继续' }))
}

async function confirmCurrentFramePlan(): Promise<void> {
  await screen.findByRole('button', { name: '确认这份 AI 方案' })
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '确认这份 AI 方案' })).toHaveProperty('disabled', false)
  })
  fireEvent.click(screen.getByRole('button', { name: '确认这份 AI 方案' }))
}

function finishQuestions(): void {
  for (let index = 0; index < 12 && screen.queryByText('这次准备这样拍') === null; index += 1) {
    const next = screen.queryByRole('button', { name: '先跳过' })
      ?? screen.queryByRole('button', { name: '继续' })
    if (next === null) break
    fireEvent.click(next)
  }
  expect(screen.getByText('这次准备这样拍')).toBeTruthy()
}

function modelPlan(sourceGoal: string, includeFrame = true): VideoAssetPlan {
  return { schema: 'qianshou.video-asset-plan.v1', sourceGoal,
    prompt: '海边小狗奔跑，写实自然光，镜头缓慢跟随', assetGuidance: '选一张清晰的海边小狗照片',
    requiredAssets: [{ slot: 'first_frame', acceptedMimeTypes: ['image/png', 'image/jpeg'], maxBytes: 16 * 1024 * 1024 }],
    ...(includeFrame ? { selectedFirstFrame: { mimeType: 'image/png' as const, bytes: png.length, sha256 } } : {}),
    durationSeconds: 5, frames: 120, fps: 24,
    modelReceipt: { provider: 'test-provider', model: 'test-model', sessionId: 'test-session',
      assistantEventSeq: 1, turnEndEventSeq: 2 } }
}

const emptyAnswers = { subject: '', motion: '', style: '' }

async function defaultPrepareVideoAssetPlan(request: Parameters<PrepareVideoAssetPlan>[0]): Promise<VideoAssetPlan> {
  return { ...modelPlan(request.sourceGoal, request.selectedFirstFrame !== undefined),
    prompt: videoCreativePrompt(request.sourceGoal, request.answers ?? emptyAnswers, zh),
    ...(request.selectedFirstFrame === undefined ? {} : { selectedFirstFrame: request.selectedFirstFrame }) }
}

function MarketTaskCall(props: ComponentProps<typeof RawMarketTaskCall>) {
  // These existing cases exercise preexisting creative drafts. The new direct entry has
  // dedicated tests below; old drafts used videoExpert without videoMode.
  const continuation = props.continuation ?? { planId: null, workloadId: null, submission: 'idle' as const,
    draft: { goal: props.initialGoal ?? '', input: {}, params: {},
      videoAnswers: emptyAnswers, videoExpert: false } }
  return <RawMarketTaskCall {...props} continuation={continuation}
    prepareVideoAssetPlan={props.prepareVideoAssetPlan ?? defaultPrepareVideoAssetPlan} />
}

it('keeps a direct video request in dialogue without forms or an AI planning call', async () => {
  const goal = '一只小狗在海边奔跑，竖屏，清晰，8 秒。\n保持我写的镜头和剧情，不扩写。'
  const remote = transport(fixedFiveForm)
  const planner = vi.fn(defaultPrepareVideoAssetPlan)
  render(<RawMarketTaskCall capability={capability} directVideoEntry transport={remote} initialGoal={goal}
    prepareVideoAssetPlan={planner} />)
  expect(screen.getByRole('status').textContent).toBe(zh.videoConversationUnavailable)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('region', { name: '创作方式' })).toBeNull()
  await act(async () => { await Promise.resolve() })
  expect(planner).not.toHaveBeenCalled()
  expect(remote.taskTypes).not.toHaveBeenCalled()
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it.each(['simple', 'expert'] as const)('restores a former %s video draft without launching an agent', async (videoMode) => {
  const remote = transport(fixedFiveForm)
  const planner = vi.fn().mockRejectedValue(new Error('MODEL_UNAVAILABLE'))
  const continuation: MarketTaskContinuation = { planId: null, workloadId: null, submission: 'idle',
    draft: { goal: '用户修改过的完整原文', input: {}, params: {}, videoMode,
      videoExpert: videoMode === 'expert', videoAnswers: emptyAnswers } }
  const onContinuation = vi.fn()
  const props = { capability, directVideoEntry: true, transport: remote, initialGoal: '最初的请求',
    continuation, prepareVideoAssetPlan: planner, onContinuation }
  const first = render(<RawMarketTaskCall {...props} />)
  expect(screen.getByText('用户修改过的完整原文')).toBeTruthy()
  first.unmount()
  render(<RawMarketTaskCall {...props} />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('status').textContent).toBe(zh.videoConversationUnavailable)
  expect(planner).not.toHaveBeenCalled()
  expect(onContinuation).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('keeps an unavailable video request closed when the catalog later becomes callable', async () => {
  const remote = transport(fixedFiveForm)
  const props = { capability, draftOnly: true, initialGoal: '按原文出视频', transport: remote }
  const { rerender } = render(<RawMarketTaskCall {...props} catalogReady={false} />)
  rerender(<RawMarketTaskCall {...props} catalogReady />)
  expect(screen.getByRole('status').textContent).toBe(zh.videoConversationUnavailable)
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('continues reading a submitted direct video job instead of replacing it with the unavailable notice', async () => {
  const remote = transport(fixedFiveForm)
  const planner = vi.fn(defaultPrepareVideoAssetPlan)
  render(<RawMarketTaskCall capability={capability} directVideoEntry transport={remote}
    initialGoal="原来已派单的任务" prepareVideoAssetPlan={planner}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await waitFor(() => { expect(remote.readWorkload).toHaveBeenCalledWith('workload_123', expect.any(AbortSignal)) })
  expect(screen.queryByText(zh.videoConversationUnavailable)).toBeNull()
  expect(planner).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('starts from one natural-language sentence, asks AI for first-frame guidance, then binds the chosen file', async () => {
  const goal = '做一个海边小狗的五秒短片'
  const remote = transport(fixedFiveForm)
  const prepareVideoAssetPlan = vi.fn().mockImplementation(async (request: { selectedFirstFrame?: unknown }) =>
    modelPlan(goal, request.selectedFirstFrame !== undefined))
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal={goal}
    catalogReady={false} catalogStatus="not-callable" prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  await screen.findByText('确认方案和首帧')
  expect(screen.queryByText('2. 补充几个关键点')).toBeNull()
  expect(screen.getByLabelText('选择本机图片')).toBeTruthy()
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenCalledWith({ sourceGoal: goal,
    answers: emptyAnswers }) })
  await screen.findByText(/选一张清晰的海边小狗照片/)
  const file = new File([png], '海边首帧.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
  const name = await screen.findByText('海边首帧.png')
  fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
  fireEvent.click(name.closest('button')!)
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenLastCalledWith({ sourceGoal: goal,
    answers: emptyAnswers,
    selectedFirstFrame: { mimeType: 'image/png', bytes: png.length, sha256 } }) })
  await screen.findByText(/AI 智能体已完成本次整理/)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('keeps an overlong Chinese request editable and starts AI planning only after it fits the Host byte limit', async () => {
  const prepareVideoAssetPlan = vi.fn(defaultPrepareVideoAssetPlan)
  render(<MarketTaskCall capability={capability} transport={transport(fixedFiveForm)}
    prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  fireEvent.change(screen.getByRole('textbox', { name: '视频需求' }),
    { target: { value: '猫'.repeat(1366) } })
  expect(screen.getByText(/视频需求最多 4096 字节/)).toBeTruthy()
  fireEvent.click(screen.getByText('修改这句话'))
  expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveProperty('value', '猫'.repeat(1366))
  expect(screen.getByRole('button', { name: '重新整理方案' })).toHaveProperty('disabled', true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
  expect(prepareVideoAssetPlan).not.toHaveBeenCalled()

  fireEvent.change(screen.getByRole('textbox', { name: '视频需求' }),
    { target: { value: '猫'.repeat(1365) } })
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenCalledWith({
    sourceGoal: '猫'.repeat(1365), answers: emptyAnswers,
  }) })
  expect(screen.queryByText(/视频需求最多 4096 字节/)).toBeNull()
})

it('blocks one overlong optional answer without losing it, then resumes AI planning after editing', async () => {
  const prepareVideoAssetPlan = vi.fn(defaultPrepareVideoAssetPlan)
  render(<MarketTaskCall capability={capability} transport={transport(fixedFiveForm)}
    prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  fireEvent.change(screen.getByRole('textbox', { name: '视频需求' }),
    { target: { value: '海边小狗奔跑' } })
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenCalledTimes(1) })
  fireEvent.click(screen.getByText('补充细节（选填）'))
  const story = screen.getByRole('textbox', { name: zh.videoCreativeStory })
  fireEvent.change(story, { target: { value: '猫'.repeat(342) } })
  expect(screen.getByText(/最多 1024 字节/)).toBeTruthy()
  expect(story).toHaveProperty('value', '猫'.repeat(342))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
  expect(prepareVideoAssetPlan).toHaveBeenCalledTimes(1)

  fireEvent.change(story, { target: { value: '猫'.repeat(341) } })
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenLastCalledWith({
    sourceGoal: '海边小狗奔跑', answers: { ...emptyAnswers, story: '猫'.repeat(341) },
  }) })
  expect(screen.queryByText(/最多 1024 字节/)).toBeNull()
})

it('rejects oversized input before the real remote planner receives it', async () => {
  const remote = { prepareVideoAssetPlan: vi.fn().mockResolvedValue({ ok: true,
    value: modelPlan('猫'.repeat(1365), false) }) }
  const prepare = createVideoAssetPlanPreparer(remote)
  await expect(prepare({ sourceGoal: '猫'.repeat(1366) }))
    .rejects.toThrow('VIDEO_ASSET_PLAN_GOAL_TOO_LONG')
  await expect(prepare({ sourceGoal: '海边小狗', answers: { ...emptyAnswers,
    story: '猫'.repeat(342) } }))
    .rejects.toThrow('VIDEO_ASSET_PLAN_ANSWER_TOO_LONG')
  expect(remote.prepareVideoAssetPlan.mock.calls).toHaveLength(0)
  await expect(prepare({ sourceGoal: '猫'.repeat(1365) })).resolves.toMatchObject({
    sourceGoal: '猫'.repeat(1365),
  })
  expect(remote.prepareVideoAssetPlan.mock.calls).toHaveLength(1)
})

it('leaves an unavailable draft in chat even when the legacy planner is installed', async () => {
  const remote = transport(fixedFiveForm)
  const prepareVideoAssetPlan = vi.fn(defaultPrepareVideoAssetPlan)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边小狗奔跑"
    draftOnly catalogReady prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  expect(screen.getByRole('status').textContent).toBe(zh.videoConversationUnavailable)
  await act(async () => { await Promise.resolve() })
  expect(prepareVideoAssetPlan).not.toHaveBeenCalled()
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('reconciles an uncertain direct video attempt without restoring a form or starting AI', async () => {
  const remote = transport(fixedFiveForm)
  const planner = vi.fn(defaultPrepareVideoAssetPlan)
  render(<RawMarketTaskCall capability={capability} directVideoEntry transport={remote}
    initialGoal="原任务" prepareVideoAssetPlan={planner}
    continuation={{ planId: 'plan_123', workloadId: null, submission: 'uncertain' }} />)
  fireEvent.click(await screen.findByRole('button', { name: '核查任务回执' }))
  await waitFor(() => { expect(remote.findWorkload).toHaveBeenCalledWith('plan_123', expect.any(AbortSignal)) })
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(planner).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('keeps text and the chosen first frame after a model failure and rejects a stale plan', async () => {
  const goal = '一只小狗在海边奔跑，镜头缓慢跟随，写实自然光'
  const remote = transport(fixedFiveForm)
  const prepareVideoAssetPlan = vi.fn().mockRejectedValue(new Error('MODEL_UNAVAILABLE'))
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal={goal}
    prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  await screen.findByText('这次准备这样拍')
  const file = new File([png], '海边首帧.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
  const name = await screen.findByText('海边首帧.png')
  fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
  fireEvent.click(name.closest('button')!)
  await screen.findByText(/AI 整理失败/)
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenCalledWith(expect.objectContaining({
    selectedFirstFrame: { mimeType: 'image/png', bytes: png.length, sha256 },
  })) })
  fireEvent.click(screen.getByText('修改这句话'))
  expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveProperty('value', goal)
  expect(screen.getByText('本次首帧：海边首帧.png')).toBeTruthy()
  expect(screen.getByRole('button', { name: '这张图和描述可以，继续' })).toHaveProperty('disabled', true)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('discards a late AI receipt after the buyer changes the natural-language request', async () => {
  const goal = '一只小狗在海边奔跑，镜头缓慢跟随，写实自然光'
  let completeOld!: (plan: VideoAssetPlan) => void
  const prepareVideoAssetPlan = vi.fn()
    .mockImplementationOnce(() => new Promise<VideoAssetPlan>((resolve) => { completeOld = resolve }))
    .mockImplementation(async (request: Parameters<PrepareVideoAssetPlan>[0]) => ({
      ...modelPlan(request.sourceGoal, false), prompt: '森林小猫奔跑',
    }))
  const remote = transport(fixedFiveForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal={goal}
    prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  await screen.findByText('这次准备这样拍')
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenCalledTimes(1) })
  fireEvent.click(screen.getByText('修改这句话'))
  fireEvent.change(screen.getByRole('textbox', { name: '视频需求' }),
    { target: { value: '一只小猫在森林里奔跑' } })
  await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenCalledTimes(2) })
  await act(async () => { completeOld(modelPlan(goal, false)) })
  await waitFor(() => { expect(screen.getByText('这次准备这样拍').parentElement?.textContent)
    .toContain('森林小猫奔跑') })
  expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveProperty('value', '一只小猫在森林里奔跑')
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('uses the submitted sentence without mandatory questions and keeps expert details available', async () => {
  const goal = '一只小狗在海边奔跑，镜头缓慢跟随，写实自然光'
  render(<MarketTaskCall capability={capability} transport={transport(mixedForm)} initialGoal={goal} />)
  await screen.findByText('确认方案和首帧')
  expect(screen.queryByText('2. 补充几个关键点')).toBeNull()
  expect(screen.getByText('这次准备这样拍')).toBeTruthy()
  await screen.findByText(/AI 智能体已完成本次整理/)
  fireEvent.click(screen.getByRole('button', { name: '专业出片' }))
  expect(screen.getByText('2. 补充几个关键点')).toBeTruthy()
})

it('asks missing details one at a time and does not invent a plot before the user confirms the plan', async () => {
  const remote = transport(mixedForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="我想做一个视频" />)
  await screen.findByText('确认方案和首帧')
  fireEvent.click(screen.getByRole('button', { name: '专业出片' }))
  expect(screen.getByRole('textbox', { name: '主要拍谁、在哪里？' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '它做什么，镜头怎么动？' })).toBeNull()
  expect(screen.queryByLabelText('选择本机图片')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '主要拍谁、在哪里？' }),
    { target: { value: '一只小狗在海边' } })
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  expect(screen.getByRole('textbox', { name: '它做什么，镜头怎么动？' })).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '主要拍谁、在哪里？' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '先跳过' }))
  fireEvent.change(screen.getByRole('textbox', { name: '希望是什么画面风格？' }),
    { target: { value: '手绘' } })
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  finishQuestions()
  const plan = screen.getByText('这次准备这样拍').parentElement!
  expect(plan.textContent).toContain('主体与场景：一只小狗在海边')
  expect(plan.textContent).toContain('画面风格：手绘')
  expect(plan.textContent).not.toContain('剧情发展：')
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('does not sell a one-minute request through an unverified short-video contract', async () => {
  const remote = transport(mixedForm)
  render(<MarketTaskCall capability={capability} transport={remote}
    initialGoal="一只小狗在海边奔跑，写实风格，做一个 1 分钟的视频" />)
  await screen.findByText('这次准备这样拍')
  expect(screen.getByRole('alert').textContent).toContain('五秒单镜需要审核合同固定 120 帧和 24 FPS')
  const file = new File([png], '海边首帧.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
  const name = await screen.findByText('海边首帧.png')
  fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
  fireEvent.click(name.closest('button')!)
  expect(screen.getByRole('button', { name: '这张图和描述可以，继续' })).toHaveProperty('disabled', true)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('accepts an explicit five-second brief only with fixed reviewed frames and fps', async () => {
  const remote = transport(fixedFiveForm)
  render(<MarketTaskCall capability={capability} transport={remote}
    initialGoal="一只小狗在海边奔跑，写实风格，做 5 秒视频" />)
  await screen.findByText('这次准备这样拍')
  expect(screen.queryByText(/五秒单镜需要审核合同固定 120 帧和 24 FPS/)).toBeNull()
  expect(screen.getByRole('spinbutton', { name: '生成帧数' })).toHaveProperty('value', '120')
  expect(screen.getByRole('spinbutton', { name: '每秒帧数' })).toHaveProperty('value', '24')
  expect(screen.getByRole('spinbutton', { name: '生成帧数' })).toHaveProperty('disabled', true)
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.createPlan).toHaveBeenCalledWith('video_generate',
    '一只小狗在海边奔跑，写实风格，做 5 秒视频', expect.any(AbortSignal),
    { prompt: '一只小狗在海边奔跑，写实风格，做 5 秒视频', frames: 120, fps: 24 },
    expect.any(Array), expect.any(Object))
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('blocks a one-minute edit to the final AI description before image upload or quote', async () => {
  const remote = transport(fixedFiveForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('确认方案和首帧')
  const file = new File([png], '海边首帧.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
  const name = await screen.findByText('海边首帧.png')
  fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
  fireEvent.click(name.closest('button')!)
  await screen.findByRole('button', { name: '确认这份 AI 方案' })
  fireEvent.click(screen.getByText('修改 AI 整理的描述'))
  fireEvent.change(screen.getByRole('textbox', { name: 'AI 整理的最终描述（可编辑）' }),
    { target: { value: '海边的小狗奔跑，做一个 1 分钟的视频' } })
  expect(screen.getByRole('alert').textContent).toContain('最终描述要求其他时长，因此不能报价')
  expect(screen.getByRole('button', { name: '确认这份 AI 方案' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '这张图和描述可以，继续' })).toHaveProperty('disabled', true)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('retries a failed AI plan once without a selected frame', async () => {
  const remote = transport(fixedFiveForm)
  const prepareVideoAssetPlan = vi.fn()
    .mockRejectedValueOnce(new Error('MODEL_UNAVAILABLE'))
    .mockImplementation(defaultPrepareVideoAssetPlan)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑"
    prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  await screen.findByText(/AI 整理失败/)
  expect(prepareVideoAssetPlan).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '重新整理方案' }))
  await screen.findByText(/AI 智能体已完成本次整理/)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
  expect(prepareVideoAssetPlan).toHaveBeenCalledTimes(2)
  expect(prepareVideoAssetPlan).toHaveBeenLastCalledWith({ sourceGoal: '海边的小狗奔跑',
    answers: emptyAnswers })
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('blocks another explicit length and a five-second claim without fixed signed fields', async () => {
  const remote = transport(fixedFiveForm)
  const first = render(<MarketTaskCall capability={capability} transport={remote}
    initialGoal="一只小狗在海边奔跑，写实风格，做 15 秒视频" />)
  await screen.findByText('这次准备这样拍')
  expect(screen.getByRole('alert').textContent).toContain('五秒单镜需要审核合同固定 120 帧和 24 FPS')
  expect(screen.getByRole('button', { name: '这张图和描述可以，继续' })).toHaveProperty('disabled', true)
  first.unmount()
  render(<MarketTaskCall capability={capability} transport={transport(mixedForm)}
    initialGoal="一只小狗在海边奔跑，写实风格，做五秒视频" />)
  await screen.findByText('这次准备这样拍')
  expect(screen.getByRole('alert').textContent).toContain('五秒单镜需要审核合同固定 120 帧和 24 FPS')
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it.each(['拍1分5秒短片', '做一个 1:00 视频'])(
  'keeps the original %s request out of a five-second quote even when AI rewrites the prompt', async (goal) => {
    const remote = transport(fixedFiveForm)
    const prepareVideoAssetPlan = vi.fn(async (request: Parameters<PrepareVideoAssetPlan>[0]) => ({
      ...modelPlan(request.sourceGoal, request.selectedFirstFrame !== undefined),
      prompt: '海边小狗奔跑，五秒单镜头',
      ...(request.selectedFirstFrame === undefined ? {} : { selectedFirstFrame: request.selectedFirstFrame }),
    }))
    render(<MarketTaskCall capability={capability} transport={remote} initialGoal={goal}
      prepareVideoAssetPlan={prepareVideoAssetPlan} />)
    await screen.findByText('确认方案和首帧')
    const file = new File([png], '海边首帧.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
    const name = await screen.findByText('海边首帧.png')
    fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
    fireEvent.click(name.closest('button')!)
    await waitFor(() => { expect(prepareVideoAssetPlan).toHaveBeenCalledWith({ sourceGoal: goal,
      answers: emptyAnswers, selectedFirstFrame: { mimeType: 'image/png', bytes: png.length, sha256 } }) })
    const approvePlan = await screen.findByRole('button', { name: '确认这份 AI 方案' })
    expect(approvePlan).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '这张图和描述可以，继续' }))
      .toHaveProperty('disabled', true)
    expect(screen.getAllByRole('alert').some(item => item.textContent
      ?.includes('五秒单镜需要审核合同固定 120 帧和 24 FPS'))).toBe(true)
    expect(remote.uploadInputFile).not.toHaveBeenCalled()
    expect(remote.createPlan).not.toHaveBeenCalled()
    expect(remote.quotePlan).not.toHaveBeenCalled()
  },
)

it('keeps 9:16 framing eligible for a reviewed five-second quote', async () => {
  const remote = transport(fixedFiveForm)
  render(<MarketTaskCall capability={capability} transport={remote}
    initialGoal="做一个 9:16 竖屏五秒视频" />)
  await screen.findByText('确认方案和首帧')
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.createPlan).toHaveBeenCalledTimes(1)
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('rejects a signed five-second ratio when its frames and fps differ from the AI plan', async () => {
  const otherFiveSecondForm: MarketTaskType = { ...fixedFiveForm,
    paramFields: fixedFiveForm.paramFields!.map(field => field.name === 'frames'
      ? { ...field, minimum: 150, maximum: 150 }
      : field.name === 'fps' ? { ...field, minimum: 30, maximum: 30 } : field) }
  const remote = transport(otherFiveSecondForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('这次准备这样拍')
  expect(screen.getByRole('alert').textContent).toContain('五秒单镜需要审核合同固定 120 帧和 24 FPS')
  expect(screen.getByRole('button', { name: '这张图和描述可以，继续' })).toHaveProperty('disabled', true)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('keeps the ordinary route short and confirms optional creative preferences without a paid action', async () => {
  const remote = transport(fixedFiveForm)
  render(<MarketTaskCall capability={capability} transport={remote}
    initialGoal="一只小狗在海边奔跑，镜头缓慢跟随，写实自然光" />)
  await screen.findByText('确认方案和首帧')
  expect(screen.getByRole('button', { name: '轻松出片' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByText('2. 补充几个关键点')).toBeNull()
  fireEvent.click(screen.getByText('补充细节（选填）'))
  fireEvent.change(screen.getByRole('textbox', { name: '这段视频给谁看、用在什么地方？' }),
    { target: { value: '给朋友看' } })
  fireEvent.change(screen.getByRole('textbox', { name: '希望听到什么？' }),
    { target: { value: '自然海浪声' } })
  await selectFirstFrame()
  expect(screen.getByText('本次首帧：海边首帧.png')).toBeTruthy()
  expect(screen.getByText('本次素材清单（本机预览）')).toBeTruthy()
  expect(screen.getAllByText(sha256).length).toBeGreaterThan(0)
  expect(screen.getByText(/你再次确认价格才会派单/)).toBeTruthy()
  expect(screen.getByText(/当前不保证已有设备可接单/)).toBeTruthy()
  await screen.findByText('本次执行价 ¥2.00')
  fireEvent.click(screen.getByText('已核验的上传回执'))
  expect(screen.getByText(/首帧已直传对象存储并取得版本：version-1/)).toBeTruthy()
  expect(screen.getByText(`v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.png`)).toBeTruthy()
  expect(remote.createPlan).toHaveBeenCalledWith('video_generate',
    '一只小狗在海边奔跑，镜头缓慢跟随，写实自然光\n用途与观众：给朋友看\n声音偏好：自然海浪声',
    expect.any(AbortSignal),
    { prompt: '一只小狗在海边奔跑，镜头缓慢跟随，写实自然光\n用途与观众：给朋友看\n声音偏好：自然海浪声',
      frames: 120, fps: 24 },
    expect.any(Array), expect.any(Object))
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('shows only public reviewed technical fields in expert mode and restores their defaults in simple mode', async () => {
  const reviewedForm: MarketTaskType = { ...fixedFiveForm, paramFields: [
    ...fixedFiveForm.paramFields!,
    { name: 'frame_count', title: '工作流帧数', type: 'integer', required: true,
      minimum: 1, maximum: 124, defaultValue: 124 },
    { name: 'noise_seed', title: '随机种子', type: 'integer', required: false,
      minimum: 0, maximum: 4294967295, defaultValue: 0 },
  ], requiredParams: [...fixedFiveForm.requiredParams, 'frame_count'] }
  const remote = transport(reviewedForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('确认方案和首帧')
  expect(screen.getByRole('spinbutton', { name: '生成帧数' })).toBeTruthy()
  expect(screen.queryByRole('spinbutton', { name: '随机种子' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '专业出片' }))
  fireEvent.click(screen.getByRole('button', { name: '先跳过' })) // style
  fireEvent.click(screen.getByRole('button', { name: '先跳过' })) // purpose
  fireEvent.change(screen.getByRole('textbox', { name: '如果有剧情，按开始、变化、结束说一说' }),
    { target: { value: '从晨光跑到海边' } })
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  fireEvent.change(screen.getByRole('textbox', { name: '每个分镜分别拍什么？' }),
    { target: { value: '海边远景，狗跑向镜头' } })
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  fireEvent.click(screen.getByRole('button', { name: '先跳过' })) // camera
  fireEvent.click(screen.getByRole('button', { name: '先跳过' })) // sound
  fireEvent.change(screen.getByRole('textbox', { name: '希望画面避开什么？' }),
    { target: { value: '不要字幕' } })
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  fireEvent.click(screen.getByRole('button', { name: '先跳过' })) // duration
  fireEvent.change(screen.getByRole('spinbutton', { name: '随机种子' }),
    { target: { value: '42' } })
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.createPlan).toHaveBeenCalledWith('video_generate', expect.stringContaining('剧情发展：从晨光跑到海边'),
    expect.any(AbortSignal), expect.objectContaining({ frames: 120, fps: 24,
      frame_count: 124, noise_seed: 42,
      prompt: expect.stringContaining('希望避开：不要字幕') }), expect.any(Array), expect.any(Object))
  expect(vi.mocked(remote.createPlan).mock.calls[0]?.[3]).toMatchObject({
    prompt: expect.stringContaining('分镜意图：海边远景，狗跑向镜头'),
  })
  expect(vi.mocked(remote.createPlan).mock.calls[0]?.[3]).not.toHaveProperty('negative_prompt')
  fireEvent.click(screen.getByRole('button', { name: '轻松出片' }))
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(screen.queryByRole('spinbutton', { name: '随机种子' })).toBeNull()
  finishQuestions()
  await confirmCurrentFramePlan()
  fireEvent.click(screen.getByRole('button', { name: '这张图和描述可以，继续' }))
  await screen.findByText('本次执行价 ¥2.00')
  expect(vi.mocked(remote.createPlan).mock.calls.at(-1)?.[3]).toMatchObject({ noise_seed: 0 })
})

it('saves and restores expert answers including a long storyboard and requested duration', async () => {
  const goal = '一只小狗在海边奔跑，镜头缓慢跟随，写实自然光'
  const story = '相遇后追逐。'.repeat(55)
  const storyboard = '全景转跟拍。'.repeat(55)
  const onContinuation = vi.fn<(next: MarketTaskContinuation) => void>()
  const first = render(<MarketTaskCall capability={capability} transport={transport(mixedForm)}
    initialGoal={goal} onContinuation={onContinuation} />)
  await screen.findByText('确认方案和首帧')
  fireEvent.click(screen.getByRole('button', { name: '专业出片' }))
  fireEvent.click(screen.getByRole('button', { name: '先跳过' })) // purpose
  fireEvent.change(screen.getByRole('textbox', { name: '如果有剧情，按开始、变化、结束说一说' }),
    { target: { value: story } })
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  fireEvent.change(screen.getByRole('textbox', { name: '每个分镜分别拍什么？' }),
    { target: { value: storyboard } })
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  for (let index = 0; index < 3; index += 1) fireEvent.click(screen.getByRole('button', { name: '先跳过' }))
  fireEvent.change(screen.getByRole('textbox', { name: '期望成片多长？' }),
    { target: { value: '1 分钟' } })
  const saved = onContinuation.mock.calls.at(-1)?.[0]
  expect(saved?.draft).toMatchObject({ videoExpert: true,
    videoAnswers: { story, storyboard, duration: '1 分钟' } })
  if (saved === undefined) throw new Error('expected saved video draft')
  first.unmount()
  render(<MarketTaskCall capability={capability} transport={transport(mixedForm)}
    initialGoal={goal} continuation={saved} />)
  await screen.findByText('2. 补充几个关键点')
  expect(screen.getByRole('button', { name: '专业出片' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveProperty('value', goal)
})

it('lets a restored expert card switch from its question to one-sentence planning without dispatch', async () => {
  const goal = '测试'
  const story = '一只橘猫在雨中打伞'
  const remote = transport(fixedFiveForm)
  const onContinuation = vi.fn<(next: MarketTaskContinuation) => void>()
  const continuation: MarketTaskContinuation = { planId: null, workloadId: null, submission: 'idle',
    draft: { goal, input: {}, params: {}, videoExpert: true,
      videoAnswers: { ...emptyAnswers, story } } }
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="不应覆盖的旧请求"
    continuation={continuation} onContinuation={onContinuation} />)
  const questions = (await screen.findByText('2. 补充几个关键点')).closest('fieldset')
  expect(questions).not.toBeNull()
  expect(screen.getByRole('textbox', { name: '主要拍谁、在哪里？' })).toBeTruthy()
  fireEvent.click(within(questions!).getByRole('button', { name: '轻松出片' }))
  expect(screen.queryByText('2. 补充几个关键点')).toBeNull()
  expect(within(screen.getByRole('group', { name: '创作方式' }))
    .getByRole('button', { name: '轻松出片' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getAllByText(goal).some(element => element.tagName === 'P')).toBe(true)
  fireEvent.click(screen.getByText('补充细节（选填）'))
  expect(screen.getByRole('textbox', { name: '如果有剧情，按开始、变化、结束说一说' }))
    .toHaveProperty('value', story)
  expect(onContinuation.mock.calls.at(-1)?.[0].draft).toMatchObject({ goal, videoExpert: false,
    videoAnswers: { story } })
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('recommends actual files from a chosen folder and keeps bytes local until creative approval', async () => {
  const remote = transport(fixedFiveForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('确认方案和首帧')
  finishQuestions()
  const unrelated = new File([png], '办公室.png', { type: 'image/png' })
  const matched = new File([png], '海边小狗.png', { type: 'image/png' })
  Object.defineProperty(unrelated, 'webkitRelativePath', { value: '素材/办公室.png' })
  Object.defineProperty(matched, 'webkitRelativePath', { value: '素材/海边小狗.png' })
  const folderInput = screen.getByLabelText('根据本机素材推荐候选图')
  expect(folderInput.getAttribute('webkitdirectory')).toBe('')
  fireEvent.change(folderInput, { target: { files: [unrelated, matched] } })
  expect(await screen.findByText('海边小狗.png')).toBeTruthy()
  expect(screen.getByText(/名称匹配：海边/)).toBeTruthy()
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('补充细节（选填）'))
  fireEvent.change(screen.getByRole('textbox', { name: '希望是什么画面风格？' }),
    { target: { value: '写实电影感' } })
  expect(screen.getByText('描述已改变，请按新内容重新推荐候选图。')).toBeTruthy()
  expect(screen.getByRole('button', { name: '这张图和描述可以，继续' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: '重新推荐' }))
  await waitFor(() => { expect(screen.queryByText('描述已改变，请按新内容重新推荐候选图。')).toBeNull() })
  await screen.findByText('海边小狗.png')
  fireEvent.load(screen.getByRole('img', { name: '海边小狗.png' }))
  fireEvent.click(screen.getByText('海边小狗.png').closest('button')!)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  await screen.findByRole('button', { name: '确认这份 AI 方案' })
  await waitFor(() => { expect(screen.getByRole('button', { name: '确认这份 AI 方案' }))
    .toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('button', { name: '确认这份 AI 方案' }))
  fireEvent.click(screen.getByRole('button', { name: '这张图和描述可以，继续' }))
  await waitFor(() => { expect(remote.uploadInputFile).toHaveBeenCalledTimes(1) })
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.createPlan).toHaveBeenCalledTimes(1)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('asks for a brief and real images, but blocks the old fixed-frame video contract', async () => {
  const remote = transport(oldForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('确认方案和首帧')
  finishQuestions()
  fireEvent.click(screen.getByText('修改这句话'))
  expect(screen.getByRole('textbox', { name: '视频需求' })).toHaveProperty('value', '海边的小狗奔跑')
  expect(screen.getByText('目前没有可核对的首帧素材。请先从本机选择图片。')).toBeTruthy()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(screen.getByText('当前缺少可核验的五秒图文出片合同，不能报价或派单。')).toBeTruthy()
  const file = new File([png], '海边首帧.png', { type: 'image/png' })
  fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
  const name = await screen.findByText('海边首帧.png')
  fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
  fireEvent.click(name.closest('button')!)
  expect(screen.getByRole('button', { name: '这张图和描述可以，继续' })).toHaveProperty('disabled', true)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '改用旧版文字出片（固定首帧）' }))
  expect(screen.getByText(/设备使用自身固定首帧/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.createPlan).toHaveBeenCalledWith('video_generate', '海边的小狗奔跑',
    expect.any(AbortSignal), {})
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('does not show a video creative form for the legacy SVG chart mapped to video.render', async () => {
  const chart = { taskType: 'bar_chart_svg_v1', capabilityId: 'video.render',
    name: '柱状图', category: 'data' }
  const chartForm: MarketTaskType = { taskType: chart.taskType, capabilityId: chart.capabilityId,
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true }
  render(<MarketTaskCall capability={chart} transport={transport(chartForm)} />)
  await waitFor(() => { expect(screen.queryByText('正在核对任务合同…')).toBeNull() })
  expect(screen.queryByText('2. 补充几个关键点')).toBeNull()
  expect(screen.queryByLabelText('选择本机图片')).toBeNull()
})

it('guides and quotes a new reviewed video task selected by @出视频', async () => {
  const current = { ...capability, taskType: 'comfy_video_graph_v1', name: '已审核视频生成' }
  const remote = transport({ ...fixedFiveForm, taskType: current.taskType })
  render(<MarketTaskCall capability={current} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('确认方案和首帧')
  expect(remote.createPlan).not.toHaveBeenCalled()
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.createPlan).toHaveBeenCalledWith(current.taskType,
    expect.stringContaining('海边的小狗奔跑'), expect.any(AbortSignal),
    expect.any(Object), expect.any(Array), expect.any(Object))
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it.each([
  ['a selected video product', capability, { productId: 'product-video', publicationId: 'publication-video',
    ownerId: 7, version: '1.0.0' }],
  ['an ordinary video capability', { ...capability, taskType: 'comfy_video_graph_v1' }, undefined],
])('keeps the reviewed first-frame quote and dispatch for %s', async (_label, selectedCapability, selectedProduct) => {
  const remote = transport({ ...fixedFiveForm, taskType: selectedCapability.taskType })
  render(<RawMarketTaskCall capability={selectedCapability} transport={remote} initialGoal="海边的小狗奔跑"
    {...(selectedProduct === undefined ? {} : { selectedProduct })}
    prepareVideoAssetPlan={defaultPrepareVideoAssetPlan} />)
  expect(screen.queryByRole('region', { name: '创作方式' })).toBeNull()
  await screen.findByText('确认方案和首帧')
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  const plan = vi.mocked(remote.createPlan).mock.calls[0]
  expect(plan?.[0]).toBe(selectedCapability.taskType)
  expect(plan?.[4]).toEqual([expect.objectContaining({ contentType: 'image/png' })])
  expect(plan?.[6]).toEqual(selectedProduct)
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await waitFor(() => { expect(remote.confirmAndPublish).toHaveBeenCalledTimes(1) })
})

it('automatically quotes only the approved frame under a signed five-second contract, before explicit dispatch', async () => {
  const remote = transport(fixedFiveForm)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('确认方案和首帧')
  fireEvent.click(screen.getByText('补充细节（选填）'))
  fireEvent.change(screen.getByRole('textbox', { name: '希望是什么画面风格？' }),
    { target: { value: '写实电影感' } })
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.uploadInputFile).toHaveBeenCalledTimes(1)
  expect(remote.createPlan).toHaveBeenCalledTimes(1)
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  expect(remote.createPlan).toHaveBeenCalledWith('video_generate',
    '海边的小狗奔跑\n画面风格：写实电影感', expect.any(AbortSignal),
    { prompt: '海边的小狗奔跑\n画面风格：写实电影感', frames: 120, fps: 24 },
    [expect.objectContaining({ sha256, objectVersionId: 'version-1', contentType: 'image/png' })],
    { publicationId: fixedFiveForm.reviewedVideoInput!.publicationId,
      approvedContractDigest: fixedFiveForm.reviewedVideoInput!.approvedContractDigest,
      artifactDigest: fixedFiveForm.reviewedPublication!.artifactDigest,
      contractSha256: fixedFiveForm.reviewedPublication!.contractSha256 })
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重新报价' }))
  await waitFor(() => { expect(remote.createPlan).toHaveBeenCalledTimes(2) })
  await screen.findByText('本次执行价 ¥2.00')
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: '希望是什么画面风格？' }),
    { target: { value: '手绘' } }) })
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('waits for the approved file upload before its one automatic free quote', async () => {
  const remote = transport(fixedFiveForm)
  let finishUpload: (() => void) | undefined
  vi.mocked(remote.uploadInputFile!).mockImplementationOnce(async (file) => {
    await new Promise<void>((resolve) => { finishUpload = resolve })
    return { objectKey: `v8/account-1/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
      filename: 'frame.png', bytes: file.size, sha256, contentType: file.type,
      objectVersionId: 'version-1' } satisfies MarketInputFile
  })
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await screen.findByText('确认方案和首帧')
  await selectFirstFrame()
  await waitFor(() => { expect(remote.uploadInputFile).toHaveBeenCalledTimes(1) })
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  await act(async () => { finishUpload?.() })
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.createPlan).toHaveBeenCalledTimes(1)
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('does not automatically retry a failed quote after catalog refresh, but lets the user retry', async () => {
  const remote = transport(fixedFiveForm)
  vi.mocked(remote.quotePlan).mockRejectedValueOnce(new Error('temporarily unavailable'))
  const props = { capability, transport: remote, initialGoal: '海边的小狗奔跑' }
  const { rerender } = render(<MarketTaskCall {...props} />)
  await screen.findByText('确认方案和首帧')
  await selectFirstFrame()
  await screen.findByText('暂时无法完成，请检查连接后重试。')
  expect(remote.createPlan).toHaveBeenCalledTimes(1)
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  await act(async () => { rerender(<MarketTaskCall {...props} catalogReady={false} />) })
  await act(async () => { rerender(<MarketTaskCall {...props} catalogReady />) })
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.quotePlan).toHaveBeenCalledTimes(2)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('discards a quote from an older catalog and waits for a manual retry', async () => {
  const remote = transport(fixedFiveForm)
  let finishQuote: (() => void) | undefined
  vi.mocked(remote.quotePlan).mockImplementationOnce(async (id) => {
    await new Promise<void>((resolve) => { finishQuote = resolve })
    return { planId: id, quoteId: 'stale_quote', taskType: 'video_generate',
      currency: 'CNY', amountYuan: '2.00', balanceEnough: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }
  })
  const props = { capability, transport: remote, initialGoal: '海边的小狗奔跑' }
  const { rerender } = render(<MarketTaskCall {...props} />)
  await screen.findByText('确认方案和首帧')
  await selectFirstFrame()
  await waitFor(() => { expect(remote.quotePlan).toHaveBeenCalledTimes(1) })
  rerender(<MarketTaskCall {...props} catalogReady={false} />)
  rerender(<MarketTaskCall {...props} catalogReady />)
  await act(async () => { finishQuote?.() })
  expect(screen.queryByText('本次执行价 ¥2.00')).toBeNull()
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥2.00')
  expect(remote.quotePlan).toHaveBeenCalledTimes(2)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('does not repeat a free quote or paid dispatch when the view remounts', async () => {
  const remote = transport(fixedFiveForm)
  let saved: MarketTaskContinuation | undefined
  const onContinuation = (next: MarketTaskContinuation): void => { saved = next }
  const props = { capability, transport: remote, initialGoal: '海边的小狗奔跑', onContinuation }
  const { unmount } = render(<MarketTaskCall {...props} />)
  await screen.findByText('确认方案和首帧')
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  expect(saved?.submission).toBe('idle')
  unmount()
  if (saved === undefined) throw new Error('Expected persisted video continuation')
  render(<MarketTaskCall {...props} continuation={saved} />)
  await waitFor(() => { expect(screen.queryByText('正在核对任务合同…')).toBeNull() })
  expect(remote.createPlan).toHaveBeenCalledTimes(1)
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('rechecks the live reviewed form before any image upload', async () => {
  const remote = transport(fixedFiveForm)
  vi.mocked(remote.taskTypes).mockResolvedValueOnce([fixedFiveForm]).mockResolvedValueOnce([changedReview])
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await waitFor(() => { expect(screen.queryByText('正在核对任务合同…')).toBeNull() })
  await selectFirstFrame()
  await screen.findByText('首帧图片或视频合同已变化，当前未派单。请重新核对并确认；已上传素材不会自动用于新订单。')
  expect(remote.taskTypes).toHaveBeenCalledTimes(2)
  expect(remote.uploadInputFile).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('rechecks the reviewed form again before creating a plan or quote', async () => {
  const remote = transport(fixedFiveForm)
  vi.mocked(remote.taskTypes).mockResolvedValueOnce([fixedFiveForm])
    .mockResolvedValueOnce([fixedFiveForm]).mockResolvedValueOnce([changedReview])
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑" />)
  await waitFor(() => { expect(screen.queryByText('正在核对任务合同…')).toBeNull() })
  await selectFirstFrame()
  await waitFor(() => { expect(screen.getByRole('button', { name: '查看单次报价' })).toHaveProperty('disabled', false) })
  await screen.findAllByText('首帧图片或视频合同已变化，当前未派单。请重新核对并确认；已上传素材不会自动用于新订单。')
  expect(remote.taskTypes).toHaveBeenCalledTimes(3)
  expect(remote.uploadInputFile).toHaveBeenCalledTimes(1)
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('returns a pre-submit review change to creative confirmation instead of an uncertain paid order', async () => {
  const remote = transport(fixedFiveForm)
  vi.mocked(remote.confirmAndPublish).mockRejectedValueOnce(new Error('COMPUTE_VIDEO_REVIEW_CHANGED'))
  const onContinuation = vi.fn()
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="海边的小狗奔跑"
    onContinuation={onContinuation} />)
  await screen.findByText('确认方案和首帧')
  await selectFirstFrame()
  await screen.findByText('本次执行价 ¥2.00')
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByText('首帧图片或视频合同已变化，当前未派单。请重新核对并确认；已上传素材不会自动用于新订单。')
  expect(screen.queryByRole('button', { name: '核查任务回执' })).toBeNull()
  expect(remote.confirmAndPublish).toHaveBeenCalledOnce()
  expect(remote.findWorkload).not.toHaveBeenCalled()
  expect(onContinuation).toHaveBeenLastCalledWith(expect.objectContaining({ planId: null, submission: 'idle' }))
})
