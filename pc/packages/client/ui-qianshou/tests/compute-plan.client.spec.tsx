// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputePlanRow, planIdFromToolResult } from '../src/client/ComputePlanRow.tsx'
import { createComputePlanTransport, type ComputePlanTransport, type ComputePlanView, type ComputeQuoteView } from '../src/client/compute-plan-transport.ts'
import { zh } from '../src/client/locales.ts'

const id = 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const goal = '将这段公开文字整理成一页摘要。'
const pending: ComputePlanView = {
  id, createdAt: '2026-09-24T00:00:00.000Z', authorization: 'pending', workloadId: null,
  request: { capabilityId: 'text.transform', goal, budgetMinor: 50, currency: 'CNY', maxNodes: 2 },
}
const approved: ComputePlanView = { ...pending, authorization: 'approved' }
const declined: ComputePlanView = { ...pending, authorization: 'declined' }
const submitted: ComputePlanView = { ...approved, workloadId: 'workload-fixture-1' }
const quoted: ComputeQuoteView = {
  quoteId: 'a'.repeat(32), taskType: 'text.transform', name: '一页摘要', goal, inputKind: 'inline',
  timeoutSeconds: 60, maxShards: 2, autoShard: true, currency: 'CNY', requestedBudget: '0.50',
  recommendedBudget: '0.75', expiresAt: Math.floor(Date.now() / 1000) + 120,
  balanceEnough: true, priceBasis: '中央服务器当前计价表', settingsVersion: 'fixture-v1', billingMode: 'server_price',
}
const block = {
  kind: 'tool-result', isError: false, meta: { protocol: 'qianshou.task-card.v1', cardId: id },
}
function t(key: keyof typeof zh, args?: Record<string, unknown>): string {
  return zh[key].replace(/\{(\w+)\}/gu, (_, name: string) => String(args?.[name] ?? `{${name}}`))
}
function view(transport: ComputePlanTransport) {
  return render(<ComputePlanRow block={block as never} transport={transport} t={t as never} />)
}
function fakeTransport(overrides: Partial<ComputePlanTransport> = {}): ComputePlanTransport {
  return {
    read: vi.fn(async () => pending),
    decide: vi.fn(async (_id, decision) => decision === 'approved' ? approved : declined),
    quote: vi.fn(async () => quoted),
    submit: vi.fn(async () => submitted),
    ...overrides,
  }
}

afterEach(() => { cleanup() })

describe('owner distributed-task card', () => {
  it('rejects forged or unfinished tool metadata before enabling any action', () => {
    expect(planIdFromToolResult({ ...block, meta: { protocol: 'other', cardId: id } } as never)).toBeNull()
    expect(planIdFromToolResult({ ...block, isError: true } as never)).toBeNull()
    expect(planIdFromToolResult({ ...block, meta: { protocol: 'qianshou.task-card.v1', cardId: '../wrong' } } as never)).toBeNull()
  })

  it('requires two owner decisions and displays the actual central server amount and full input before submit', async () => {
    const transport = fakeTransport()
    const screen = view(transport)
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.computePlanApprove })).toBeTruthy() })
    expect(transport.quote).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.computePlanApprove }))
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.computePlanGetQuote })).toBeTruthy() })
    expect(transport.decide).toHaveBeenCalledWith(id, 'approved')
    expect(transport.submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.computePlanGetQuote }))
    await waitFor(() => { expect(screen.getByText('¥0.75')).toBeTruthy() })
    expect(screen.getByText(goal)).toBeTruthy()
    expect(screen.getByText('中央服务器当前计价表')).toBeTruthy()
    expect(transport.submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认预算 ¥0.75 并提交' }))
    await waitFor(() => { expect(screen.getByText('workload-fixture-1')).toBeTruthy() })
    expect(transport.submit).toHaveBeenCalledExactlyOnceWith(id, quoted)
  })

  it('cancels without a quote or submission', async () => {
    const transport = fakeTransport()
    const screen = view(transport)
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.computePlanCancel })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.computePlanCancel }))
    await waitFor(() => { expect(screen.getByText(zh.computePlanDeclined)).toBeTruthy() })
    expect(transport.decide).toHaveBeenCalledWith(id, 'declined')
    expect(transport.quote).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
  })

  it('does not retry an uncertain submission, even when a read shows no local workload yet', async () => {
    const transport = fakeTransport({ read: vi.fn(async () => approved), submit: vi.fn(async () => { throw new Error('CORE_REQUEST_TIMEOUT') }) })
    const screen = view(transport)
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.computePlanGetQuote })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.computePlanGetQuote }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '确认预算 ¥0.75 并提交' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '确认预算 ¥0.75 并提交' }))
    await waitFor(() => { expect(screen.getByText(zh.computePlanUnknown)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.computePlanRefresh }))
    await waitFor(() => { expect(transport.read).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('button', { name: '确认预算 ¥0.75 并提交' })).toBeNull()
    expect(transport.submit).toHaveBeenCalledTimes(1)
  })

  it('blocks expired or insufficient quotes before any paid POST', async () => {
    const transport = fakeTransport({ read: vi.fn(async () => approved), quote: vi.fn(async () => ({ ...quoted, expiresAt: 1, balanceEnough: false })) })
    const screen = view(transport)
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.computePlanGetQuote })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh.computePlanGetQuote }))
    await waitFor(() => { expect(screen.getByText(zh.computePlanQuoteExpired)).toBeTruthy() })
    expect(screen.queryByRole('button', { name: '确认预算 ¥0.75 并提交' })).toBeNull()
    expect(transport.submit).not.toHaveBeenCalled()
  })
})

describe('authenticated plan transport', () => {
  it('sends only the displayed amount and opaque quote id in the final POST', async () => {
    const requests: { path: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(String(url)).pathname
      requests.push({ path, init })
      const body = path.endsWith('confirm-quoted') ? submitted : path.endsWith('quote') ? quoted
        : path.endsWith('confirm') ? approved : [pending]
      return Response.json(body)
    }) as unknown as typeof fetch
    const transport = createComputePlanTransport({ fetchImpl, baseUri: 'http://127.0.0.1:4211/' })
    expect(await transport.read(id)).toEqual(pending)
    expect(await transport.decide(id, 'approved')).toEqual(approved)
    expect(await transport.quote(id)).toEqual(quoted)
    expect(await transport.submit(id, quoted)).toEqual(submitted)
    expect(requests.map(item => item.path)).toEqual([
      '/api/qianshou/compute/plans', '/api/qianshou/compute/plans/confirm',
      '/api/qianshou/compute/plans/quote', '/api/qianshou/compute/plans/confirm-quoted',
    ])
    expect(requests[3]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'manual',
      body: JSON.stringify({ id, quoteId: quoted.quoteId, amount: '0.75' }) })
  })
})
