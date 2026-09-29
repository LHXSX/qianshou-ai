// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketTaskCall, videoPlaybackAfterEvent, type MarketTaskContinuation } from '../src/client/MarketTaskCall.tsx'
import type { MarketTaskTransport, MarketTaskType } from '../src/client/market-task-transport.ts'
import type { PrepareVideoAssetPlan } from '../src/client/video-asset-plan.ts'
import type { OrderProductView } from '../src/client/order-products-controller.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps an oversized legacy market video sentence without starting AI planning', async () => {
  const prepareVideoAssetPlan = vi.fn<PrepareVideoAssetPlan>()
  render(<MarketTaskCall capability={videoCapability} transport={videoTransport()}
    initialGoal={'猫'.repeat(1366)} prepareVideoAssetPlan={prepareVideoAssetPlan} />)
  await screen.findByText(/视频需求最多 4096 字节/)
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)) })
  expect(prepareVideoAssetPlan).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox', { name: '视频需求' }) as HTMLTextAreaElement).value).toBe('猫'.repeat(1366))
})

it.each([
  ['COMPUTE_TASK_PRICING_UNAVAILABLE', '此能力尚未配置服务端执行价，暂不能报价。请等待提供方配置价目；当前未派单、未扣费。'],
  ['COMPUTE_TASK_PRICING_INVALID', '此能力的服务端价目无效，暂不能报价。请等待提供方修正价目；当前未派单、未扣费。'],
])('shows an exact tariff failure without a paid confirmation for %s', async (code, message) => {
  const remote = transport(true)
  vi.mocked(remote.quotePlan).mockRejectedValue(new Error(code))
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="虚构测试材料" />)
  fireEvent.click(await screen.findByRole('button', { name: '查看单次报价' }))
  await screen.findByText(message)
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('keeps a failed first-frame upload receipt uncertain without claiming no bytes were uploaded or requesting a quote', async () => {
  const form: MarketTaskType = { taskType: videoCapability.taskType, capabilityId: videoCapability.capabilityId,
    acceptedInputKinds: ['multi_file'], requiredParams: ['fps', 'frames', 'input_manifest', 'prompt'],
    canQuoteInline: false, canQuoteFiles: true, paramFields: [
      { name: 'prompt', title: '视频描述', type: 'string', required: true, minLength: 1, maxLength: 8000 },
      { name: 'frames', title: '生成帧数', type: 'integer', required: true, minimum: 120, maximum: 120 },
      { name: 'fps', title: '每秒帧数', type: 'integer', required: true, minimum: 24, maximum: 24 },
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
      artifactDigest: `sha256:${'b'.repeat(64)}`, contractSha256: `sha256:${'c'.repeat(64)}`,
    } }
  const remote = videoTransport()
  vi.mocked(remote.taskTypes).mockResolvedValue([form])
  const upload = vi.fn().mockRejectedValue(new Error('upload completion receipt timed out'))
  remote.uploadInputFile = upload
  const prepareVideoAssetPlan: PrepareVideoAssetPlan = async request => ({
    schema: 'qianshou.video-asset-plan.v1', sourceGoal: request.sourceGoal,
    prompt: request.sourceGoal, assetGuidance: '选一张清晰首帧',
    requiredAssets: [{ slot: 'first_frame', acceptedMimeTypes: ['image/png', 'image/jpeg'],
      maxBytes: 16 * 1024 * 1024 }],
    ...(request.selectedFirstFrame === undefined ? {} : { selectedFirstFrame: request.selectedFirstFrame }),
    durationSeconds: 5, frames: 120, fps: 24,
    modelReceipt: { provider: 'test-provider', model: 'test-model', sessionId: 'test-session',
      assistantEventSeq: 1, turnEndEventSeq: 2 },
  })
  const priorArrayBuffer = Object.getOwnPropertyDescriptor(File.prototype, 'arrayBuffer')
  const priorCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const priorRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  try {
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
    render(<MarketTaskCall capability={videoCapability} transport={remote}
      initialGoal="海边小狗奔跑" prepareVideoAssetPlan={prepareVideoAssetPlan}
      continuation={{ planId: null, workloadId: null, submission: 'idle',
        draft: { goal: '海边小狗奔跑', input: {}, params: {}, videoExpert: false } }} />)
    await screen.findByText('确认方案和首帧')
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])],
      '海边首帧.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('选择本机图片'), { target: { files: [file] } })
    const name = await screen.findByText('海边首帧.png')
    fireEvent.load(screen.getByRole('img', { name: '海边首帧.png' }))
    fireEvent.click(name.closest('button')!)
    const confirmPlan = await screen.findByRole('button', { name: '确认这份 AI 方案' })
    await waitFor(() => { expect(confirmPlan).toHaveProperty('disabled', false) })
    fireEvent.click(confirmPlan)
    fireEvent.click(screen.getByRole('button', { name: '这张图和描述可以，继续' }))
    await screen.findByText('首帧核对或上传回执失败；当前未报价、未派单。上传结果待核查，请重新选择图片确认。')
    expect(upload).toHaveBeenCalledTimes(1)
    expect(remote.createPlan).not.toHaveBeenCalled()
    expect(remote.quotePlan).not.toHaveBeenCalled()
    expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  } finally {
    cleanup(); vi.unstubAllGlobals()
    if (priorArrayBuffer) Object.defineProperty(File.prototype, 'arrayBuffer', priorArrayBuffer)
    else Reflect.deleteProperty(File.prototype, 'arrayBuffer')
    if (priorCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', priorCreateObjectURL)
    else Reflect.deleteProperty(URL, 'createObjectURL')
    if (priorRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', priorRevokeObjectURL)
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
  }
})

const product: OrderProductView = {
  id: '40dcfacc-57d9-43d2-a6ad-5b713029eac5',
  publicationId: '663125de-83c4-4c47-ade1-0d5d5298f267', ownerId: 1,
  taskType: 'legal_term_scan_v1', name: '法律术语扫描', description: '定位易混术语', category: 'legal',
  version: '1.0.0', artifactDigest: `sha256:${'a'.repeat(64)}`,
  reviewedSellerRuntimeDigest: `sha256:${'b'.repeat(64)}`, salePriceYuan: '20.00',
  currency: 'CNY', availableToPurchase: true, archiveDigest: null, archiveSizeBytes: null,
}
const videoCapability = { taskType: 'video_generate', capabilityId: 'video.render',
  name: '五秒视频生成', category: 'video' }

function transport(canQuoteInline: boolean): MarketTaskTransport {
  return {
    taskTypes: vi.fn().mockResolvedValue([{ taskType: product.taskType,
      acceptedInputKinds: canQuoteInline ? ['inline'] : ['single_file'], requiredParams: [], canQuoteInline }]),
    createPlan: vi.fn().mockResolvedValue('plan_123'),
    quotePlan: vi.fn().mockResolvedValue({ planId: 'plan_123', quoteId: 'quote_123',
      taskType: product.taskType, currency: 'CNY', amountYuan: '0.50', balanceEnough: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    confirmAndPublish: vi.fn().mockResolvedValue('workload_123'),
    findWorkload: vi.fn().mockResolvedValue(null),
    readWorkload: vi.fn().mockResolvedValue({ id: 'workload_123', status: 'DONE', resultAvailable: true }),
    readResult: vi.fn().mockResolvedValue({ id: 'workload_123', status: 'DONE',
      inlineOutput: '扫描发现 2 项', artifactRef: null }),
    readAcceptance: vi.fn().mockResolvedValue(null),
    decideAcceptance: vi.fn().mockRejectedValue(new Error('not pending')),
  }
}

function videoTransport(): MarketTaskTransport {
  const remote = transport(true)
  vi.mocked(remote.taskTypes).mockResolvedValue([{ taskType: videoCapability.taskType,
    capabilityId: videoCapability.capabilityId, acceptedInputKinds: ['inline'],
    requiredParams: [], canQuoteInline: true }])
  return remote
}

it('carries an exact selected product into the plan and refuses a quote without a platform pin', async () => {
  const remote = transport(true)
  vi.mocked(remote.createPlan).mockRejectedValue(new Error('COMPUTE_PRODUCT_SELECTION_UNSUPPORTED'))
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="扫描这份文件"
    selectedProduct={{ productId: product.id, publicationId: product.publicationId,
      ownerId: product.ownerId, version: product.version }} />)
  await screen.findByText(/已保留你选择的具体商品/)
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText(/平台暂未确认这件商品的精确版本/)
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(product.taskType, '扫描这份文件',
    expect.any(AbortSignal), {}, undefined, undefined, {
      productId: product.id, publicationId: product.publicationId,
      ownerId: product.ownerId, version: product.version,
    })
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('keeps a plain-text task within its declared prompt limit before requesting a quote', async () => {
  const remote = transport(true)
  vi.mocked(remote.taskTypes).mockResolvedValue([{ taskType: product.taskType,
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true,
    inlineForm: { title: '视频描述', mediaType: 'text/plain', maxLength: 3 } }])
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="超过三字" />)
  const quote = await screen.findByRole('button', { name: '查看单次报价' })
  expect(quote).toHaveProperty('disabled', true)
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: '视频描述' }), { target: { value: '海边🙂' } })
  expect(quote).toHaveProperty('disabled', false)
  fireEvent.click(quote)
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(product.taskType, '海边🙂',
    expect.any(AbortSignal), {})
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('quotes an arbitrary legacy JSON contract without inventing fields or dispatching before confirmation', async () => {
  const remote = transport(true)
  vi.mocked(remote).taskTypes.mockResolvedValue([{ taskType: product.taskType,
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true,
    inlineForm: { title: '输入 JSON', mediaType: 'application/json', minLength: 1, maxLength: 16384 } }])
  render(<MarketTaskCall capability={product} transport={remote} />)
  const input = await screen.findByRole('textbox', { name: '输入 JSON' })
  expect(screen.queryByText('此技能正在补充使用表单，暂不能直接调用。')).toBeNull()
  expect(screen.getByRole('button', { name: '查看单次报价' })).toHaveProperty('disabled', true)
  const raw = '{"arbitrary":{"memo":"🙂"},"enabled":true}'
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  expect(vi.mocked(remote).createPlan.mock.calls).toEqual([[product.taskType, raw, expect.any(AbortSignal), {}]])
  expect(vi.mocked(remote).confirmAndPublish.mock.calls).toHaveLength(0)
})

it.each(['not JSON', '{}', '[]', 'null', '{"n":1e999}', '{"s":"\\ud800"}', '{"text":"' + '中'.repeat(5500) + '"}'])
('rejects invalid or oversized legacy JSON before requesting a quote: %s', async (raw) => {
  const remote = transport(true)
  vi.mocked(remote).taskTypes.mockResolvedValue([{ taskType: product.taskType,
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true,
    inlineForm: { title: '输入 JSON', mediaType: 'application/json', maxLength: 16384 } }])
  render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '输入 JSON' }), { target: { value: raw } })
  expect(screen.getByRole('button', { name: '查看单次报价' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('alert').textContent).toContain('有效的非空 JSON 对象')
  expect(vi.mocked(remote).createPlan.mock.calls).toHaveLength(0)
  expect(vi.mocked(remote).confirmAndPublish.mock.calls).toHaveLength(0)
})

it('preserves an unsupported declared schema instead of downgrading it to legacy JSON', async () => {
  const remote = transport(true)
  vi.mocked(remote).taskTypes.mockResolvedValue([{ taskType: product.taskType,
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true,
    inlineForm: { title: '输入 JSON', mediaType: 'application/json', structuredDeclared: true } }])
  render(<MarketTaskCall capability={product} transport={remote} initialGoal='{"text":"example"}' />)
  await screen.findByText('此技能正在补充使用表单，暂不能直接调用。')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(vi.mocked(remote).createPlan.mock.calls).toHaveLength(0)
  expect(vi.mocked(remote).confirmAndPublish.mock.calls).toHaveLength(0)
})

it('restores an uncertain Session submission by receipt lookup without quoting or dispatching again', async () => {
  const remote = transport(true)
  const remembered = vi.fn()
  vi.mocked(remote.findWorkload).mockResolvedValue('workload_123')
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="检查这段文字"
    continuation={{ planId: 'plan_123', workloadId: null, submission: 'uncertain', amountYuan: '0.50' }}
    onContinuation={remembered} />)
  fireEvent.click(await screen.findByRole('button', { name: '核查任务回执' }))
  await screen.findByText('扫描发现 2 项')
  expect(remote.findWorkload).toHaveBeenCalledExactlyOnceWith('plan_123', expect.any(AbortSignal))
  expect(remembered).toHaveBeenCalledWith(expect.objectContaining({ workloadId: 'workload_123', submission: 'submitted' }))
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('restores a submitted Session workload and reads its result without another paid submission', async () => {
  const remote = transport(true)
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="检查这段文字"
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('扫描发现 2 项')
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it.each([
  ['waiting', '等待设备接手'], ['executing', '正在执行'], ['checking', '正在核验结果'],
  [undefined, '已受理，正在核查执行状态'],
] as const)('keeps accepted tasks distinct from actual executor progress %s', async (executionStage, label) => {
  const remote = transport(true)
  vi.mocked(remote.readWorkload).mockResolvedValue({ id: 'workload_123', status: 'RUNNING', resultAvailable: false,
    ...(executionStage === undefined ? {} : { executionStage }) })
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="检查这段文字"
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText(`任务状态：${label}`)
  expect(screen.queryByText('任务状态：RUNNING')).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('restores bounded controls and parameters into a fresh plan, and invalidates its price when either changes', async () => {
  const remote = transport(true)
  const remembered = vi.fn()
  vi.mocked(remote.taskTypes).mockResolvedValue([{ taskType: product.taskType,
    acceptedInputKinds: ['inline'], requiredParams: ['keyword'], canQuoteInline: true,
    paramFields: [{ name: 'keyword', title: '关键词', type: 'string', required: true }],
    inlineForm: { title: '文本', mediaType: 'application/json', structured: {
      type: 'object', required: ['text'], properties: {
        text: { type: 'string', title: '要处理的文字', minLength: 1, maxLength: 200 },
      },
    } },
  }])
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="最初的请求"
    continuation={{ planId: 'old_plan', workloadId: null, submission: 'idle', amountYuan: '9.99',
      draft: { goal: '最初的请求', input: { text: '恢复后的文字' }, params: { keyword: '恢复的参数' } } }}
    onContinuation={remembered} />)
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(product.taskType, '{"text":"恢复后的文字"}',
    expect.any(AbortSignal), { keyword: '恢复的参数' })
  expect(remote.quotePlan).toHaveBeenCalledExactlyOnceWith('plan_123', expect.any(AbortSignal), product.taskType)
  fireEvent.change(screen.getByRole('textbox', { name: '要处理的文字' }), { target: { value: '新输入' } })
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(remembered).toHaveBeenLastCalledWith(expect.objectContaining({ planId: null, amountYuan: undefined,
    draft: { goal: '最初的请求', input: { text: '新输入' }, params: { keyword: '恢复的参数' } } }))
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  fireEvent.change(screen.getByRole('textbox', { name: '关键词' }), { target: { value: '新参数' } })
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  expect(remembered).toHaveBeenLastCalledWith(expect.objectContaining({ planId: null,
    draft: { goal: '最初的请求', input: { text: '新输入' }, params: { keyword: '新参数' } } }))
})

it('accepts a real catalog landing only when the quote binds its exact plan and originally requested capability', async () => {
  const remote = transport(true)
  vi.mocked(remote.taskTypes).mockResolvedValue([{ taskType: 'video_compress', capabilityId: 'media.transcode',
    acceptedInputKinds: ['inline'], requiredParams: [], canQuoteInline: true }])
  vi.mocked(remote.quotePlan).mockResolvedValue({ planId: 'plan_123', capabilityId: 'media.transcode',
    quoteId: 'quote_123', taskType: 'video_compress', currency: 'CNY', amountYuan: '0.50',
    balanceEnough: true, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  render(<MarketTaskCall capability={{ taskType: 'media.transcode', name: '转码', category: 'video' }}
    transport={remote} initialGoal="压缩视频" />)
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.quotePlan).toHaveBeenCalledExactlyOnceWith('plan_123', expect.any(AbortSignal), 'media.transcode')
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it.each([
  { planId: 'other_plan' }, { capabilityId: 'other_capability' },
  { taskType: 'unrelated_landing' }, { missingCapability: true, taskType: 'unrelated_landing' },
])('rejects a mismatched quote before showing a paid confirmation: %j', async (change) => {
  const remote = transport(true)
  const quote = await remote.quotePlan('plan_123', new AbortController().signal)
  const { capabilityId: _capabilityId, ...withoutCapability } = quote
  const response = change.missingCapability === true
    ? { ...withoutCapability, taskType: change.taskType }
    : { ...quote, capabilityId: product.taskType, ...change }
  vi.mocked(remote.quotePlan).mockClear().mockResolvedValue(response)
  render(<MarketTaskCall capability={product} transport={remote} initialGoal="检查文字" />)
  await screen.findByText('任务回执与此能力不一致，请重新核对。')
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('shows a generic structurally checked result and waits for buyer confirmation before settlement', async () => {
  const remote = transport(true)
  const held = { workloadId: 'workload_123', status: 'pending_buyer' as const,
    workloadStatus: 'QUARANTINED', currency: 'CNY' as const, heldAmount: '0.50',
    inlineOutput: { report: '待确认' }, contentSha256: 'a'.repeat(64),
    outputKind: 'inline_json' as const, shardId: 'shard_123' }
  vi.mocked(remote.readWorkload).mockResolvedValue({ id: 'workload_123', status: 'QUARANTINED', resultAvailable: false })
  vi.mocked(remote.readAcceptance).mockResolvedValue(held)
  vi.mocked(remote.decideAcceptance).mockResolvedValue({ ...held, status: 'accepted' })
  render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '描述要完成的事' }),
    { target: { value: '检查这段文字' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByText(/托管金额 ¥0.50/)
  expect(remote.readResult).not.toHaveBeenCalled()
  expect(remote.decideAcceptance).not.toHaveBeenCalled()
  const scheduled = vi.spyOn(window, 'setTimeout')
  fireEvent.click(screen.getByRole('button', { name: '确认结果并结算' }))
  await waitFor(() =>{  expect(remote.decideAcceptance).toHaveBeenCalledWith(
    'workload_123', 'accept', expect.stringMatching(/^[0-9a-f-]{36}$/u), expect.any(AbortSignal)) })
  await screen.findByText('已确认结果，等待中央服务器完成结算。')
  await waitFor(() =>{  expect(scheduled).toHaveBeenCalledWith(expect.any(Function), 5_000) })
  expect(screen.queryByText('扫描发现 2 项')).toBeNull()
})

it('withholds buyer decisions for a pending acceptance whose workload status disagrees, then recovers', async () => {
  const remote = transport(true)
  const held = { workloadId: 'workload_123', status: 'pending_buyer' as const,
    workloadStatus: 'QUARANTINED', currency: 'CNY' as const, heldAmount: '0.50',
    inlineOutput: { report: '待确认' }, contentSha256: 'a'.repeat(64),
    outputKind: 'inline_json' as const, shardId: 'shard_123' }
  vi.mocked(remote.readWorkload).mockResolvedValue({ id: 'workload_123', status: 'QUARANTINED', resultAvailable: false })
  vi.mocked(remote.readAcceptance).mockResolvedValueOnce({ ...held, workloadStatus: 'DONE' })
    .mockResolvedValue(held)
  render(<MarketTaskCall capability={product} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('暂时无法核查验收状态，请稍后重试。')
  expect(screen.queryByRole('button', { name: '确认结果并结算' })).toBeNull()
  expect(screen.queryByRole('button', { name: '拒绝结果并退款' })).toBeNull()
  expect(remote.decideAcceptance).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '刷新验收状态' }))
  await screen.findByRole('button', { name: '确认结果并结算' })
  expect(screen.queryByText('暂时无法核查验收状态，请稍后重试。')).toBeNull()
  expect(remote.decideAcceptance).not.toHaveBeenCalled()
})

it('does not let an inline buyer acceptance settle a video without a viewable MP4, but allows rejection', async () => {
  const remote = videoTransport()
  const held = { workloadId: 'workload_123', status: 'pending_buyer' as const,
    workloadStatus: 'QUARANTINED', currency: 'CNY' as const, heldAmount: '0.50',
    inlineOutput: { report: '视频待验收' }, contentSha256: 'a'.repeat(64),
    outputKind: 'inline_json' as const, shardId: 'shard_123' }
  vi.mocked(remote.readWorkload).mockResolvedValue({ id: 'workload_123', status: 'QUARANTINED', resultAvailable: false })
  vi.mocked(remote.readAcceptance).mockResolvedValue(held)
  vi.mocked(remote.decideAcceptance).mockResolvedValue({ ...held, status: 'rejected' })
  const { container } = render(<MarketTaskCall capability={{ ...videoCapability,
    taskType: 'owner_video_v1', category: 'creative' }} transport={remote}
  continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('当前验收回执没有可核验的成片，暂不能确认视频结果并结算；可拒绝结果并退款。')
  expect(container.querySelector('video')).toBeNull()
  expect(screen.queryByRole('button', { name: '确认结果并结算' })).toBeNull()
  expect(remote.decideAcceptance).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '拒绝结果并退款' }))
  await waitFor(() => { expect(remote.decideAcceptance).toHaveBeenCalledWith('workload_123', 'reject',
    expect.stringMatching(/^[0-9a-f-]{36}$/u), expect.any(AbortSignal)) })
  expect(remote.decideAcceptance).toHaveBeenCalledTimes(1)
})

it('never offers buyer confirmation for a generic quarantined task without an acceptance record', async () => {
  const remote = transport(true)
  vi.mocked(remote.readWorkload).mockResolvedValue({ id: 'workload_123', status: 'QUARANTINED', resultAvailable: false })
  render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '描述要完成的事' }),
    { target: { value: '检查这段文字' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByText(/正在等待独立验收/)
  expect(screen.queryByRole('button', { name: '确认结果并结算' })).toBeNull()
  expect(remote.decideAcceptance).not.toHaveBeenCalled()
})

it('shows the central server price before any paid dispatch and requires a separate confirmation', async () => {
  const remote = transport(true)
  render(<MarketTaskCall capability={product} transport={remote} />)
  const goal = await screen.findByRole('textbox', { name: '描述要完成的事' })
  fireEvent.change(goal, { target: { value: '扫描这段文字的法律术语' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  expect(remote.createPlan).toHaveBeenCalledWith(product.taskType, '扫描这段文字的法律术语', expect.any(AbortSignal), {})
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByText('扫描发现 2 项')
  expect(screen.getByText('已完成，结果在下面。')).toBeTruthy()
  expect(screen.queryByText('已提交，中央服务器正在安排执行。')).toBeNull()
  expect(remote.confirmAndPublish).toHaveBeenCalledExactlyOnceWith('plan_123', 'quote_123', expect.any(AbortSignal))
  expect(remote.readResult).toHaveBeenCalledExactlyOnceWith('workload_123', expect.any(AbortSignal))
})

it('shows generic image and video artifacts through the authenticated local media route', async () => {
  for (const extension of ['png', 'mp4', 'webm', 'mov'] as const) {
    const remote = transport(true)
    const asset = 'a'.repeat(64)
    vi.mocked(remote.readResult).mockResolvedValueOnce({ id: 'workload_123', status: 'DONE',
      inlineOutput: null, artifactRef: `qianshou-media://task/workload_123/${asset}.${extension}` })
    const mounted = render(<MarketTaskCall capability={product} transport={remote} />)
    fireEvent.change(await screen.findByRole('textbox', { name: '描述要完成的事' }),
      { target: { value: '生成结果' } })
    fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
    await screen.findByText('本次执行价 ¥0.50')
    fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
    await waitFor(() => { expect(mounted.container.querySelector(extension === 'png' ? 'img' : 'video')).not.toBeNull() })
    const element = mounted.container.querySelector(extension === 'png' ? 'img' : 'video')
    const src = new URL(element?.getAttribute('src') ?? '')
    expect(src.pathname).toBe('/api/qianshou/result-media')
    expect(src.searchParams.get('task_id')).toBe('workload_123')
    expect(src.searchParams.get('asset_id')).toBe(asset)
    expect(src.searchParams.get('type')).toBe(extension)
    if (element instanceof HTMLVideoElement) {
      expect(element.controls && !element.autoplay && element.preload === 'metadata').toBe(true)
      expect(screen.getByText('平台报告完成；点击播放核验视频是否可读取。')).toBeTruthy()
      expect(screen.queryByText('视频预览已可播放，完整成片以平台验收回执及用户播放确认为准。')).toBeNull()
      const download = screen.getByRole('link', { name: '下载文件' }) as HTMLAnchorElement
      expect(download.href).toBe(element.src)
      expect(download.download).toBe(`${asset}.${extension}`)
      fireEvent.canPlay(element)
      expect(screen.getByText('视频预览已可播放，完整成片以平台验收回执及用户播放确认为准。')).toBeTruthy()
    }
    mounted.unmount()
  }
})

it('reports a video playback error and retries the same result without another dispatch', async () => {
  const remote = transport(true)
  vi.mocked(remote.readResult).mockResolvedValue({ id: 'workload_123', status: 'DONE',
    inlineOutput: null, artifactRef: `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4` })
  const { container } = render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '描述要完成的事' }),
    { target: { value: '生成结果' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByText('平台报告完成；点击播放核验视频是否可读取。')
  const failedVideo = container.querySelector('video')
  if (failedVideo === null) throw new Error('expected a video preview')
  fireEvent.error(failedVideo)
  expect(screen.getByText('平台报告完成，但视频暂时无法读取；请重试查看，不会重新派单。')).toBeTruthy()
  const retry = screen.getByRole('button', { name: '重新读取视频' })
  retry.focus()
  fireEvent.click(retry)
  const retriedVideo = container.querySelector('video')
  expect(retriedVideo).not.toBe(failedVideo)
  expect(retriedVideo?.src).toBe(failedVideo?.src)
  expect(screen.getByText('平台报告完成；点击播放核验视频是否可读取。')).toBeTruthy()
  expect(document.activeElement).toBe(retry)
  expect(screen.getByRole('button', { name: '重新读取视频' })).toBe(retry)
  if (retriedVideo === null) throw new Error('expected a retried video preview')
  fireEvent.canPlay(retriedVideo)
  expect(screen.getByText('视频预览已可播放，完整成片以平台验收回执及用户播放确认为准。')).toBeTruthy()
  fireEvent.error(failedVideo)
  expect(screen.getByText('视频预览已可播放，完整成片以平台验收回执及用户播放确认为准。')).toBeTruthy()
  expect(remote.confirmAndPublish).toHaveBeenCalledTimes(1)
  expect(remote.readResult).toHaveBeenCalledTimes(1)
})

it('retains a newer playable preview when an older media attempt reports a late error', () => {
  const current = { workloadId: 'workload_123', reference: `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4`,
    attempt: 1, status: 'ready' as const }
  expect(videoPlaybackAfterEvent(1, 0, current, { workloadId: current.workloadId,
    reference: current.reference, status: 'failed' })).toBe(current)
  expect(videoPlaybackAfterEvent(1, 1, null, { workloadId: current.workloadId,
    reference: current.reference, status: 'ready' })).toEqual(current)
})

it('keeps a playback failure until the buyer starts a new read attempt', () => {
  const event = { workloadId: 'workload_123', reference: `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4` }
  const failed = videoPlaybackAfterEvent(1, 1, null, { ...event, status: 'failed' })
  expect(videoPlaybackAfterEvent(1, 1, failed, { ...event, status: 'ready' })).toBe(failed)
  expect(videoPlaybackAfterEvent(2, 2, failed, { ...event, status: 'ready' })).toEqual({
    ...event, attempt: 2, status: 'ready',
  })
})

it('rechecks playback after rereading the same completed video result', async () => {
  const remote = videoTransport()
  const reference = `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4`
  vi.mocked(remote.readResult).mockResolvedValue({ id: 'workload_123', status: 'DONE',
    inlineOutput: null, artifactRef: reference })
  const continuation: MarketTaskContinuation = { planId: 'plan_123', workloadId: 'workload_123',
    submission: 'submitted' }
  const capability = videoCapability
  const { container, rerender } = render(<MarketTaskCall capability={capability} transport={remote}
    continuation={continuation} />)
  await screen.findByText('平台报告完成；点击播放核验视频是否可读取。')
  const firstVideo = container.querySelector('video')
  if (firstVideo === null) throw new Error('expected first preview')
  fireEvent.canPlay(firstVideo)
  expect(screen.getByText('视频预览已可播放，完整成片以平台验收回执及用户播放确认为准。')).toBeTruthy()
  rerender(<MarketTaskCall capability={capability} transport={{ ...remote }} continuation={continuation} />)
  await screen.findByText('平台报告完成；点击播放核验视频是否可读取。')
  const rereadVideo = container.querySelector('video')
  expect(rereadVideo).not.toBeNull()
  expect(rereadVideo).not.toBe(firstVideo)
  if (rereadVideo === null) throw new Error('expected reread preview')
  fireEvent.canPlay(firstVideo)
  expect(screen.getByText('平台报告完成；点击播放核验视频是否可读取。')).toBeTruthy()
  fireEvent.canPlay(rereadVideo)
  expect(screen.getByText('视频预览已可播放，完整成片以平台验收回执及用户播放确认为准。')).toBeTruthy()
  expect(remote.readResult).toHaveBeenCalledTimes(2)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('keeps a non-DONE result from a DONE workload out of video and download, then rereads without dispatch', async () => {
  const remote = videoTransport()
  const artifactRef = `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4`
  vi.mocked(remote.readResult)
    .mockResolvedValueOnce({ id: 'workload_123', status: 'RUNNING', inlineOutput: null, artifactRef })
    .mockResolvedValueOnce({ id: 'workload_123', status: 'DONE', inlineOutput: null, artifactRef })
  const { container } = render(<MarketTaskCall capability={videoCapability} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  const retry = await screen.findByRole('button', { name: '重新读取结果' })
  expect(screen.getByText('任务已完成，成果读取暂时失败。')).toBeTruthy()
  expect(container.querySelector('video, img')).toBeNull()
  expect(screen.queryByRole('link', { name: '下载文件' })).toBeNull()
  expect(screen.queryByText('视频预览已可播放，完整成片以平台验收回执及用户播放确认为准。')).toBeNull()
  fireEvent.click(retry)
  await waitFor(() => { expect(container.querySelector('video')).not.toBeNull() })
  expect(screen.getByText('平台报告完成；点击播放核验视频是否可读取。')).toBeTruthy()
  expect(remote.readResult).toHaveBeenCalledTimes(2)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it.each([
  ['text', 'render failed', null],
  ['image', null, `qianshou-media://task/workload_123/${'b'.repeat(64)}.png`],
  ['empty', null, null],
  ['webm', null, `qianshou-media://task/workload_123/${'b'.repeat(64)}.webm`],
  ['mov', null, `qianshou-media://task/workload_123/${'b'.repeat(64)}.mov`],
])('does not present a DONE video task with %s output as a finished video', async (_kind, inlineOutput, artifactRef) => {
  const remote = videoTransport()
  vi.mocked(remote.readResult)
    .mockResolvedValueOnce({ id: 'workload_123', status: 'DONE', inlineOutput, artifactRef })
    .mockResolvedValueOnce({ id: 'workload_123', status: 'DONE', inlineOutput: null,
      artifactRef: `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4` })
  const { container } = render(<MarketTaskCall capability={videoCapability} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('平台报告完成，但尚未提供可播放的视频；请重新读取结果并核查平台回执。')
  expect(screen.queryByText('已完成，结果在下面。')).toBeNull()
  expect(screen.queryByText('图片已生成。')).toBeNull()
  expect(container.querySelector('video, img')).toBeNull()
  expect(container.querySelector('pre')).toBeNull()
  expect(screen.queryByRole('link', { name: '下载文件' })).toBeNull()
  expect(screen.queryByRole('button', { name: '重新读取视频' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新读取结果' }))
  await waitFor(() => { expect(container.querySelector('video')).not.toBeNull() })
  expect(screen.getByText('平台报告完成；点击播放核验视频是否可读取。')).toBeTruthy()
  expect(remote.readResult).toHaveBeenCalledTimes(2)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('does not turn an unverified or foreign artifact reference into media', async () => {
  const remote = transport(true)
  vi.mocked(remote.readResult).mockResolvedValueOnce({ id: 'workload_123', status: 'DONE',
    inlineOutput: null, artifactRef: 'https://example.invalid/clip.mp4' })
  const { container } = render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '描述要完成的事' }),
    { target: { value: '生成结果' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByText('成果暂时无法读取，请稍后重试。')
  expect(container.querySelector('video, img')).toBeNull()
})

it('does not play or download a media reference for another workload', async () => {
  const remote = transport(true)
  vi.mocked(remote.readResult).mockResolvedValueOnce({ id: 'workload_123', status: 'DONE',
    inlineOutput: null, artifactRef: `qianshou-media://task/another-workload/${'a'.repeat(64)}.mp4` })
  const { container } = render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '描述要完成的事' }),
    { target: { value: '生成结果' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByText('成果暂时无法读取，请稍后重试。')
  expect(container.querySelector('video, img')).toBeNull()
  expect(screen.queryByRole('link', { name: '下载文件' })).toBeNull()
})

it('prefills and quotes a prompt from @ while leaving the paid dispatch for confirmation', async () => {
  const remote = transport(true)
  vi.mocked(remote.taskTypes).mockResolvedValue([{ taskType: product.taskType,
    acceptedInputKinds: ['inline'], requiredParams: ['output_format'], canQuoteInline: true,
    paramFields: [{ name: 'output_format', title: '输出格式', type: 'string',
      required: true, choices: ['png'] }],
    inlineForm: { title: '出图文字与尺寸', mediaType: 'application/json',
      template: { field: 'prompt', title: '想画什么？', minLength: 1, maxLength: 8000,
        constants: { model: 'grok-4.6', size: '1280x720' } } } }])
  const image = { taskType: product.taskType, name: '官方出图', category: 'image' }
  render(<MarketTaskCall capability={image} initialGoal="画一只橘猫" transport={remote} />)
  expect(await screen.findByRole('textbox', { name: '想画什么？' })).toHaveProperty('value', '画一只橘猫')
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(product.taskType,
    JSON.stringify({ model: 'grok-4.6', size: '1280x720', prompt: '画一只橘猫' }),
    expect.any(AbortSignal), { output_format: 'png' })
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('does not offer a fake inline order for a file-only market contract', async () => {
  const remote = transport(false)
  render(<MarketTaskCall capability={product} transport={remote} />)
  await screen.findByText(/此能力需要single_file输入/)
  expect(screen.queryByRole('button', { name: '查看单次报价' })).toBeNull()
  expect(remote.createPlan).not.toHaveBeenCalled()
})

it('uses schema fields for a new required parameter before asking central server for a quote', async () => {
  const remote = transport(true)
  vi.mocked(remote.taskTypes).mockResolvedValueOnce([{ taskType: product.taskType,
    acceptedInputKinds: ['inline'], requiredParams: ['keyword'], canQuoteInline: true,
    paramFields: [{ name: 'keyword', title: '关键词', type: 'string', required: true,
      minLength: 1, maxLength: 120 }] }])
  render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox', { name: '描述要完成的事' }),
    { target: { value: '扫描文本' } })
  expect(screen.getByRole('button', { name: '查看单次报价' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByRole('textbox', { name: '关键词' }),
    { target: { value: '合同' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(product.taskType, '扫描文本',
    expect.any(AbortSignal), { keyword: '合同' })
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('checks an uncertain submit receipt instead of silently creating a second order', async () => {
  const remote = transport(true)
  vi.mocked(remote.confirmAndPublish).mockRejectedValueOnce(new Error('COMPUTE_SUBMISSION_UNKNOWN'))
  render(<MarketTaskCall capability={product} transport={remote} />)
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '扫描合同' } })
  fireEvent.click(screen.getByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
  fireEvent.click(screen.getByRole('button', { name: '确认价格并派单' }))
  await screen.findByRole('button', { name: '核查任务回执' })
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '核查任务回执' }))
  await waitFor(() =>{  expect(remote.findWorkload).toHaveBeenCalledOnce() })
  expect(remote.confirmAndPublish).toHaveBeenCalledOnce()
})


it('reconnects progress reads without quoting or dispatching a second task', async () => {
  const remote = transport(true)
  vi.mocked(remote.readWorkload).mockRejectedValueOnce(new Error('temporary disconnect'))
    .mockResolvedValue({ id: 'workload_123', status: 'RUNNING', resultAvailable: false, progress: 0.4, executionStage: 'executing' })
  const scheduled = vi.spyOn(window, 'setTimeout')
  render(<MarketTaskCall capability={product} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByRole('button', { name: '刷新任务进度' })
  const retry = scheduled.mock.calls.find(([fn, delay]) => typeof fn === 'function' && delay === 5_000)?.[0]
  expect(typeof retry).toBe('function')
  await act(async () => { if (typeof retry === 'function') retry() })
  await screen.findByText('40%')
  expect(screen.queryByRole('button', { name: '刷新任务进度' })).toBeNull()
  expect(remote.createPlan).not.toHaveBeenCalled(); expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled(); expect(remote.readResult).not.toHaveBeenCalled()
})

it('waits for a completed video result to become available without submitting again', async () => {
  const remote = videoTransport()
  const calls = vi.mocked(remote)
  const reference = `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4`
  calls.readWorkload
    .mockResolvedValueOnce({ id: 'workload_123', status: 'DONE', resultAvailable: false })
    .mockResolvedValue({ id: 'workload_123', status: 'DONE', resultAvailable: true })
  calls.readResult.mockResolvedValue({ id: 'workload_123', status: 'DONE',
    inlineOutput: null, artifactRef: reference })
  const scheduled = vi.spyOn(window, 'setTimeout')
  const view = render(<MarketTaskCall capability={videoCapability} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('任务已完成，正在读取成果。')
  await waitFor(() => { expect(calls.readWorkload.mock.calls).toHaveLength(1) })
  const retry = scheduled.mock.calls.find(([fn, delay]) => typeof fn === 'function' && delay === 5_000)?.[0]
  expect(typeof retry).toBe('function')
  expect(calls.readResult.mock.calls).toHaveLength(0)
  expect(view.container.querySelector('video')).toBeNull()
  await act(async () => { if (typeof retry === 'function') retry() })
  await screen.findByText('平台报告完成；点击播放核验视频是否可读取。')
  expect(view.container.querySelector('video')).not.toBeNull()
  expect(calls.readResult.mock.calls).toEqual([['workload_123', expect.any(AbortSignal)]])
  expect(calls.createPlan.mock.calls).toHaveLength(0); expect(calls.quotePlan.mock.calls).toHaveLength(0)
  expect(calls.confirmAndPublish.mock.calls).toHaveLength(0)
  view.unmount()
  await act(async () => { if (typeof retry === 'function') retry() })
  expect(calls.readWorkload.mock.calls).toHaveLength(2)
})

it('automatically retries a failed completed video result read for the same task without dispatch', async () => {
  const remote = videoTransport()
  const reference = `qianshou-media://task/workload_123/${'a'.repeat(64)}.mp4`
  vi.mocked(remote.readResult).mockRejectedValueOnce(new Error('result temporarily unavailable'))
    .mockResolvedValue({ id: 'workload_123', status: 'DONE', inlineOutput: null, artifactRef: reference })
  const scheduled = vi.spyOn(window, 'setTimeout')
  const cleared = vi.spyOn(window, 'clearTimeout')
  const view = render(<MarketTaskCall capability={videoCapability} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('任务已完成，成果读取暂时失败。')
  expect(screen.getByRole('button', { name: '重新读取结果' })).toBeTruthy()
  const retryIndex = scheduled.mock.calls.findIndex(([, delay]) => delay === 5_000)
  const retry = scheduled.mock.calls[retryIndex]?.[0]
  expect(typeof retry).toBe('function')
  expect(remote.readResult).toHaveBeenCalledTimes(1)
  await act(async () => { if (typeof retry === 'function') retry() })
  await screen.findByText('平台报告完成；点击播放核验视频是否可读取。')
  expect(view.container.querySelector('video')).not.toBeNull()
  expect(remote.readResult).toHaveBeenCalledTimes(2)
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  view.unmount()
  expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[retryIndex]?.value)
  await act(async () => { if (typeof retry === 'function') retry() })
  expect(remote.readResult).toHaveBeenCalledTimes(2)
})

it('limits automatic completed-result retries while leaving manual recovery available', async () => {
  const remote = videoTransport()
  vi.mocked(remote.readResult).mockRejectedValue(new Error('result unavailable'))
  const scheduled = vi.spyOn(window, 'setTimeout')
  render(<MarketTaskCall capability={videoCapability} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('任务已完成，成果读取暂时失败。')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retries = scheduled.mock.calls.filter(([, delay]) => delay === 5_000)
    expect(retries).toHaveLength(attempt + 1)
    const retry = retries[attempt]?.[0]
    await act(async () => { if (typeof retry === 'function') retry() })
    await waitFor(() => { expect(remote.readResult).toHaveBeenCalledTimes(attempt + 2) })
  }
  expect(scheduled.mock.calls.filter(([, delay]) => delay === 5_000)).toHaveLength(3)
  expect(screen.getByRole('button', { name: '重新读取结果' })).toBeTruthy()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('separates failed result reads from a successfully observed completion', async () => {
  const remote = transport(true)
  vi.mocked(remote.readResult).mockRejectedValueOnce(new Error('result unavailable'))
  render(<MarketTaskCall capability={product} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted', amountYuan: '0.50' }} />)
  await screen.findByRole('button', { name: '重新读取结果' })
  expect(screen.getByText('任务已完成，成果读取暂时失败。')).toBeTruthy()
  expect(screen.queryByText('已完成，结果在下面。')).toBeNull()
  expect(screen.queryByRole('button', { name: '刷新任务进度' })).toBeNull()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByText('先看本次人民币报价，确认后由中央服务器调度。若需单独购买能力，市场会提前说明。')).toBeNull()
  const diagnostics = screen.getByText('排查信息').closest('details')
  expect(diagnostics?.hasAttribute('open')).toBe(false)
  expect(diagnostics?.querySelector('code')?.textContent).toBe('workload_123')
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('stops polling a canceled task without retrying execution', async () => {
  const remote = transport(true)
  vi.mocked(remote.readWorkload).mockResolvedValue({ id: 'workload_123', status: 'CANCELED', resultAvailable: false })
  const scheduled = vi.spyOn(window, 'setTimeout')
  render(<MarketTaskCall capability={product} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('任务未完成，请在任务记录中查看平台回执。')
  expect(scheduled.mock.calls.filter(([,delay]) => delay === 5_000)).toEqual([])
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('offers a manual file request only for the current workload, without preview or automatic download', async () => {
  const remote = transport(true)
  const id = 'c045d506-1db5-491c-95c6-b06ad9431baa'
  const sha = 'a'.repeat(64)
  vi.mocked(remote.readWorkload).mockResolvedValue({ id, status: 'DONE', resultAvailable: true })
  vi.mocked(remote.readResult).mockResolvedValue({ id, status: 'DONE', inlineOutput: null,
    artifactRef: `qianshou-file://task/${id}/${sha}` })
  const { container } = render(<MarketTaskCall capability={product} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: id, submission: 'submitted' }} />)
  const download = await screen.findByRole('link', { name: '下载文件' })
  expect(download.getAttribute('href')).toBe(`${window.location.origin}/api/qianshou/result-file?task_id=${id}&asset_id=${sha}`)
  expect(download.hasAttribute('download')).toBe(true)
  expect(container.querySelector('img, video, iframe, object')).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('does not offer a file download for a result addressed to another workload', async () => {
  const remote = transport(true)
  vi.mocked(remote.readResult).mockResolvedValue({ id: 'workload_123', status: 'DONE', inlineOutput: null,
    artifactRef: `qianshou-file://task/c045d506-1db5-491c-95c6-b06ad9431baa/${'a'.repeat(64)}` })
  const { container } = render(<MarketTaskCall capability={product} transport={remote}
    continuation={{ planId: 'plan_123', workloadId: 'workload_123', submission: 'submitted' }} />)
  await screen.findByText('成果暂时无法读取，请稍后重试。')
  expect(screen.queryByRole('link', { name: '下载文件' })).toBeNull()
  expect(container.querySelector('img, video, iframe, object')).toBeNull()
})


it('keeps a quoted draft visible while catalog refresh pauses new paid submissions', async () => {
  const remote = transport(true)
  const view = render(<MarketTaskCall capability={product} transport={remote} initialGoal="保留输入" />)
  await screen.findByText('本次执行价 ¥0.50')
  view.rerender(<MarketTaskCall capability={product} transport={remote} initialGoal="保留输入" catalogReady={false} />)
  expect(screen.getByRole('textbox')).toHaveProperty('value', '保留输入')
  expect(screen.getByRole('button', { name: '确认价格并派单' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: '重新报价' })).toHaveProperty('disabled', true)
  expect(screen.getByText('目录正在更新，输入已保留；完成后可继续。')).toBeTruthy()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  view.rerender(<MarketTaskCall capability={product} transport={remote} initialGoal="保留输入" />)
  expect(screen.getByRole('button', { name: '确认价格并派单' })).toHaveProperty('disabled', false)
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('waits for a fresh catalog before automatically quoting the preserved initial request', async () => {
  const remote = transport(true)
  const view = render(<MarketTaskCall capability={product} transport={remote} initialGoal="稍后询价" catalogReady={false} />)
  await screen.findByRole('textbox')
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  view.rerender(<MarketTaskCall capability={product} transport={remote} initialGoal="稍后询价" />)
  await screen.findByText('本次执行价 ¥0.50')
  expect(remote.quotePlan).toHaveBeenCalledTimes(1)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})


it('does not start pricing after catalog invalidation overtakes a pending plan creation', async () => {
  const remote = transport(true)
  let finishPlan!: (id: string) => void
  vi.mocked(remote.createPlan).mockImplementation(() => new Promise((resolve) => { finishPlan = resolve }))
  const view = render(<MarketTaskCall capability={product} transport={remote} initialGoal="等待计划" />)
  await waitFor(() => expect(remote.createPlan).toHaveBeenCalledTimes(1))
  view.rerender(<MarketTaskCall capability={product} transport={remote} initialGoal="等待计划" catalogReady={false} />)
  await act(async () => { finishPlan('late_plan'); await Promise.resolve() })
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveProperty('value', '等待计划')
  expect(screen.getByRole('button', { name: '查看单次报价' })).toHaveProperty('disabled', true)
})

it('discards a late quote even if the catalog has become ready again in the meantime', async () => {
  const remote = transport(true)
  let finishQuote!: (quote: Awaited<ReturnType<MarketTaskTransport['quotePlan']>>) => void
  vi.mocked(remote.quotePlan).mockImplementation(() => new Promise((resolve) => { finishQuote = resolve }))
  const view = render(<MarketTaskCall capability={product} transport={remote} initialGoal="等待报价" />)
  await waitFor(() => expect(remote.quotePlan).toHaveBeenCalledTimes(1))
  view.rerender(<MarketTaskCall capability={product} transport={remote} initialGoal="等待报价" catalogReady={false} />)
  view.rerender(<MarketTaskCall capability={product} transport={remote} initialGoal="等待报价" />)
  await act(async () => { finishQuote({ planId: 'plan_123', quoteId: 'quote_123', taskType: product.taskType,
    currency: 'CNY', amountYuan: '0.50', balanceEnough: true,
    expiresAt: new Date(Date.now() + 60000).toISOString() }); await Promise.resolve() })
  expect(screen.queryByText('本次执行价 ¥0.50')).toBeNull()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveProperty('value', '等待报价')
})
