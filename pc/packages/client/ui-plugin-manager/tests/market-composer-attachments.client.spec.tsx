// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createMarketMentionSource } from '../src/client/market-mention-source.ts'
import { MarketCapabilitiesController } from '../src/client/market-capabilities-controller.ts'
import { createMarketTaskTransport } from '../src/client/market-task-transport.ts'
import type { MarketTaskTransport } from '../src/client/market-task-transport.ts'
import { MarketTaskCall } from '../src/client/MarketTaskCall.tsx'
import type { MarketTaskContinuation } from '../src/client/MarketTaskCall.tsx'
import { isMarketTaskDraft } from '../src/client/market-task-draft.ts'

afterEach(() => { cleanup() })
const capability = {
  taskType: 'new_file_reader', capabilityId: 'new_file_reader', name: '材料分析', description: '分析指定材料',
  category: 'doc', categoryLabelZh: '文档', acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file',
  requiredParams: [], outputKind: 'file', contractVersion: 'task-registry.v1', publisherKind: 'user' as const,
  publisherKinds: ['user' as const], executionMode: 'device' as const, availability: 'contract_ready' as const,
  formReady: true, requiresQuote: true as const, executionQuotePath: '/api/v8/developer/tasks/estimate' as const,
  currency: 'CNY' as const, products: [],
}
const file = { objectKey: `v8/account-167/developer/${'a'.repeat(32)}/input/案卷.pptx`,
  objectVersionId: 'actual-version', filename: '案卷.pptx', bytes: 3, sha256: 'b'.repeat(64),
  contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }

it('accepts a file-only @ skill, imports the existing Session receipt and keeps payment outside submit', async () => {
  const controller = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [capability] },
  }) })
  const call = vi.fn().mockReturnValue(true)
  const prepare = vi.fn().mockResolvedValue([file])
  const source = createMarketMentionSource({ capabilities: controller, callCapability: call, prepareAttachments: prepare })
  const session = { sessionId: 'materials-session' as SessionId }
  const picked = await source.matchEnter?.(session, '@材料分析 检查这份PPT', new AbortController().signal, { attachments: 1 })
  if (!picked || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected file claim')
  expect(picked.claim.attachments).toBe(true)
  const attachments = [{ type: 'file' as const, receiptId: 'owned-staged-receipt' }]
  expect(await picked.claim.submit('检查这份PPT', {} as never, attachments)).toEqual({ kind: 'success' })
  expect(prepare).toHaveBeenCalledExactlyOnceWith(session, attachments)
  expect(call).toHaveBeenCalledExactlyOnceWith(session, capability, '检查这份PPT', [file])
  prepare.mockRejectedValueOnce(new Error('upload unavailable')); call.mockClear()
  const failed = await picked.claim.submit('检查这份PPT', {} as never, attachments)
  expect(failed.kind).toBe('error')
  if (failed.kind !== 'error') throw new Error('expected upload error')
  expect(failed.text).toContain('草稿已保留')
  expect(call).not.toHaveBeenCalled()
  controller.dispose()
})

it('addresses the existing composer Session and persists only verified storage metadata', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([file]))
  const transport = createMarketTaskTransport(fetcher, 'http://127.0.0.1:3180/')
  expect(await transport.importComposerFiles?.({ sessionId: 'materials-session' as SessionId },
    [{ type: 'file', receiptId: 'owned-staged-receipt' }], new AbortController().signal)).toEqual([file])
  expect(fetcher).toHaveBeenCalledOnce()
  const request = fetcher.mock.calls[0]
  if (request === undefined || typeof request[0] !== 'string' || typeof request[1]?.body !== 'string') {
    throw new Error('expected a same-origin URL and serialized body')
  }
  expect(new URL(request[0]).pathname).toBe('/api/qianshou/compute/files/from-composer')
  expect(JSON.parse(request[1].body)).toEqual({ sessionId: 'materials-session',
    attachments: [{ type: 'file', receiptId: 'owned-staged-receipt' }] })
  expect(isMarketTaskDraft({ goal: '检查', input: {}, params: {}, files: [file] })).toBe(true)
  expect(isMarketTaskDraft({ goal: '检查', input: {}, params: {}, files: [{ ...file, objectKey: '/private/local/file' }] })).toBe(false)
})

it('restores a file request, gets a price with exact references and never dispatches automatically', async () => {
  const createPlan = vi.fn<MarketTaskTransport['createPlan']>().mockResolvedValue('plan_123')
  const confirmAndPublish = vi.fn<MarketTaskTransport['confirmAndPublish']>()
  const remote: MarketTaskTransport = {
    taskTypes: vi.fn().mockResolvedValue([{ taskType: capability.taskType, acceptedInputKinds: ['multi_file'],
      requiredParams: [], canQuoteInline: false, canQuoteFiles: true, paramFields: [] }]),
    createPlan,
    quotePlan: vi.fn().mockResolvedValue({ planId: 'plan_123', quoteId: 'quote_123', taskType: capability.taskType,
      currency: 'CNY', amountYuan: '0.50', balanceEnough: true, expiresAt: new Date(Date.now() + 60000).toISOString() }),
    confirmAndPublish, findWorkload: vi.fn(), readWorkload: vi.fn(), readResult: vi.fn(),
    readAcceptance: vi.fn(), decideAcceptance: vi.fn(),
  }
  const remember = vi.fn<(next: MarketTaskContinuation) => void>()
  render(<MarketTaskCall capability={capability} initialGoal="检查这份PPT" transport={remote}
    continuation={{ planId: null, workloadId: null, submission: 'idle', draft: { goal: '检查这份PPT', input: {}, params: {}, files: [file] } }}
    onContinuation={remember} />)
  await screen.findByText('本次执行价 ¥0.50')
  expect(screen.getByText('案卷.pptx')).toBeTruthy()
  expect(createPlan).toHaveBeenCalledExactlyOnceWith(capability.taskType, '检查这份PPT', expect.any(AbortSignal), {}, [file])
  await waitFor(() => { expect(remember.mock.calls.at(-1)?.[0].draft?.files).toEqual([file]) })
  expect(confirmAndPublish).not.toHaveBeenCalled()
})
