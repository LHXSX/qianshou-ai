// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketTaskCall, type MarketTaskContinuation } from '../src/client/MarketTaskCall.tsx'
import type { MarketInputFile, MarketTaskTransport, MarketTaskType } from '../src/client/market-task-transport.ts'
import { isMarketTaskDraft } from '../src/client/market-task-draft.ts'
import { zh } from '../src/client/market-task-progress-locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const capability = { taskType: 'generic_text_and_files_v1', name: '材料分析', category: 'text' }
const file: MarketInputFile = { objectKey: `v8/account-167/developer/${'a'.repeat(32)}/input/evidence.txt`, filename: '材料.txt', bytes: 12,
  sha256: 'a'.repeat(64), contentType: 'text/plain' }
function transport(change: Partial<MarketTaskType> = {}) {
  let plans = 0
  return {
    taskTypes: vi.fn<MarketTaskTransport['taskTypes']>().mockResolvedValue([{ taskType: capability.taskType, acceptedInputKinds: ['inline', 'multi_file'],
      requiredParams: [], canQuoteInline: true, canQuoteFiles: true,
      inlineForm: { title: '要处理的文字', mediaType: 'text/plain', minLength: 1, maxLength: 8000 }, ...change }]),
    createPlan: vi.fn<MarketTaskTransport['createPlan']>().mockImplementation(async () => `plan_${++plans}`),
    quotePlan: vi.fn<MarketTaskTransport['quotePlan']>().mockImplementation(async (planId: string) => ({ planId, quoteId: `quote_${planId}`,
      taskType: capability.taskType, currency: 'CNY', amountYuan: '0.50', balanceEnough: true,
      expiresAt: new Date(Date.now() + 60000).toISOString() })),
    confirmAndPublish: vi.fn<MarketTaskTransport['confirmAndPublish']>().mockResolvedValue('workload_1'),
    findWorkload: vi.fn<MarketTaskTransport['findWorkload']>().mockResolvedValue(null),
    readWorkload: vi.fn<MarketTaskTransport['readWorkload']>().mockResolvedValue({ id: 'workload_1', status: 'RUNNING', resultAvailable: false }),
    readResult: vi.fn<MarketTaskTransport['readResult']>(), readAcceptance: vi.fn<MarketTaskTransport['readAcceptance']>(), decideAcceptance: vi.fn<MarketTaskTransport['decideAcceptance']>(),
  } satisfies MarketTaskTransport
}
async function quote(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: '查看单次报价' }))
  await screen.findByText('本次执行价 ¥0.50')
}

it('quotes text by default for a dual contract without requiring or silently sending files', async () => {
  const remote = transport()
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="检查这段文字" />)
  await screen.findByText('本次执行价 ¥0.50')
  expect(screen.getByRole('button', { name: zh.taskInputModeText }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByLabelText(zh.taskInputAttachments)).toBeNull()
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(capability.taskType, '检查这段文字', expect.any(AbortSignal), {})
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('prefers existing composer attachments when restoring a legacy dual-input draft with no mode', async () => {
  const remote = transport()
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="检查材料"
    continuation={{ planId: null, workloadId: null, submission: 'idle',
      draft: { goal: '检查材料', input: {}, params: {}, files: [file] } }} />)
  await screen.findByText('本次执行价 ¥0.50')
  expect(screen.getByRole('button', { name: zh.taskInputModeFiles }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText(file.filename)).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '要处理的文字' })).toBeNull()
  expect(remote.createPlan).toHaveBeenCalledExactlyOnceWith(capability.taskType, '检查材料', expect.any(AbortSignal), {}, [file])
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.taskInputRemove }))
  expect(screen.getByRole('button', { name: zh.taskInputModeFiles }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '查看单次报价' }).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
})

it('restores explicit text mode with retained files and invalidates each quote while preserving both drafts', async () => {
  const remote = transport(), remember = vi.fn<(next: MarketTaskContinuation) => void>()
  render(<MarketTaskCall capability={capability} transport={remote} onContinuation={remember}
    continuation={{ planId: 'old_plan', workloadId: null, submission: 'idle', amountYuan: '8.00',
      draft: { goal: '保留原文', input: {}, params: {}, files: [file], inputMode: 'inline' } }} />)
  await quote()
  expect(vi.mocked(remote.createPlan).mock.calls[0]).toEqual([capability.taskType, '保留原文', expect.any(AbortSignal), {}])
  fireEvent.click(screen.getByRole('button', { name: zh.taskInputModeFiles }))
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(remember).toHaveBeenLastCalledWith(expect.objectContaining({ planId: null, amountYuan: undefined,
    draft: { goal: '保留原文', input: {}, params: {}, files: [file], inputMode: 'files' } }))
  await quote()
  expect(vi.mocked(remote.createPlan).mock.calls[1]).toEqual([capability.taskType, '保留原文', expect.any(AbortSignal), {}, [file]])
  fireEvent.click(screen.getByRole('button', { name: zh.taskInputModeText }))
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '要处理的文字' }).value).toBe('保留原文')
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  await quote()
  expect(vi.mocked(remote.createPlan).mock.calls[2]).toEqual([capability.taskType, '保留原文', expect.any(AbortSignal), {}])
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('aborts a pending quote on mode change and ignores its late price response', async () => {
  const remote = transport()
  const priced = await remote.quotePlan('plan_1', new AbortController().signal)
  let resolve!: (value: typeof priced) => void
  const pending = new Promise<typeof priced>((done) => { resolve = done })
  vi.mocked(remote.quotePlan).mockClear().mockReturnValueOnce(pending)
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="检查原文" />)
  await waitFor(() => { expect(remote.quotePlan).toHaveBeenCalledTimes(1) })
  const signal = remote.quotePlan.mock.calls[0]![1]
  fireEvent.click(screen.getByRole('button', { name: zh.taskInputModeFiles }))
  expect(signal.aborted).toBe(true)
  await act(async () => { resolve(priced) })
  expect(screen.queryByText('本次执行价 ¥0.50')).toBeNull()
  expect(screen.queryByRole('button', { name: '确认价格并派单' })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '查看单次报价' }).disabled).toBe(true)
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})

it('keeps a file-only contract file-only and accepts bounded old drafts while rejecting unknown mode values', async () => {
  const remote = transport({ canQuoteInline: false, acceptedInputKinds: ['multi_file'] })
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="文字不能代替材料" />)
  await screen.findByLabelText(zh.taskInputAttachments)
  expect(screen.queryByRole('group', { name: zh.taskInputMode })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '查看单次报价' }).disabled).toBe(true)
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(isMarketTaskDraft({ goal: '检查', input: {}, params: {}, files: [file] })).toBe(true)
  expect(isMarketTaskDraft({ goal: '检查', input: {}, params: {}, inputMode: 'inline' })).toBe(true)
  expect(isMarketTaskDraft({ goal: '检查', input: {}, params: {}, inputMode: 'files' })).toBe(true)
  expect(isMarketTaskDraft({ goal: '检查', input: {}, params: {}, inputMode: 'other' })).toBe(false)
})

it('does not let mode switches reset an uncertain paid submission or replay submitted work', async () => {
  const remote = transport(), remember = vi.fn<(next: MarketTaskContinuation) => void>()
  const mounted = render(<MarketTaskCall capability={capability} transport={remote} initialGoal="检查原文"
    onContinuation={remember} continuation={{ planId: 'paid_plan', workloadId: null, submission: 'uncertain', amountYuan: '0.50',
      draft: { goal: '检查原文', input: {}, params: {}, files: [file], inputMode: 'inline' } }} />)
  const files = await screen.findByRole<HTMLButtonElement>('button', { name: zh.taskInputModeFiles })
  expect(files.disabled).toBe(true)
  fireEvent.click(files)
  expect(remember).not.toHaveBeenCalled()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
  mounted.unmount()
  render(<MarketTaskCall capability={capability} transport={remote} initialGoal="检查原文"
    continuation={{ planId: 'paid_plan', workloadId: 'workload_1', submission: 'submitted',
      draft: { goal: '检查原文', input: {}, params: {}, files: [file], inputMode: 'files' } }} />)
  await waitFor(() => { expect(remote.readWorkload).toHaveBeenCalled() })
  expect(screen.queryByRole('group', { name: zh.taskInputMode })).toBeNull()
  expect(remote.createPlan).not.toHaveBeenCalled()
  expect(remote.quotePlan).not.toHaveBeenCalled()
  expect(remote.confirmAndPublish).not.toHaveBeenCalled()
})
