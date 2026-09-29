// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { TaskCardRow } from '../src/client/TaskCardRow.tsx'
import type { ComputeState } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'
import type { ComputePlanDraft } from '@deepseek-ai/dsh-compute-core/protocol'

afterEach(cleanup)

const cardId = 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const result = {
  kind: 'tool-result',
  seq: 1,
  time: 0,
  callId: 'call-1',
  call: { name: 'compute_plan_draft', argsRaw: '{}' },
  callTime: 0,
  content: [],
  isError: false,
  meta: {
    protocol: 'qianshou.task-card.v1',
    cardId,
    title: '处理五张图片',
    capabilityId: 'image.batch',
    budgetMinor: 150,
    currency: 'CNY',
    maxNodes: null,
    createdAt: '2026-09-16T12:00:00.000Z',
    reason: '方案草稿已保存',
  },
  subCalls: [],
} as ToolCallViewProps['block']

function t(key: keyof typeof zh, values?: Record<string, string>): string {
  return Object.entries(values ?? {})
    .reduce<string>((text, [name, value]) => text.replace(`{${name}}`, value), zh[key])
}

function stored(authorization: ComputePlanDraft['authorization']): ComputePlanDraft {
  return {
    id: cardId as ComputePlanDraft['id'],
    request: { capabilityId: 'image.batch' as ComputePlanDraft['request']['capabilityId'], goal: '处理五张图片', budgetMinor: 150, currency: 'CNY', maxNodes: null },
    status: 'draft', createdAt: '2026-09-16T12:00:00.000Z', quote: null, authorization, workloadId: null,
    reason: '方案草稿已保存',
  }
}

function row(block: ToolCallViewProps['block'], drafts: ComputePlanDraft[] = []) {
  const state: ComputeState = {
    connection: null, capabilities: [], drafts, loading: false, saving: false, error: null,
  }
  const actions = {
    refresh: vi.fn(async () => {}),
    ensureLoaded: vi.fn(async () => {}),
    saveDraft: vi.fn(async () => true),
    confirmDraft: vi.fn(async () => true),
    publishDraft: vi.fn(async () => true),
  }
  const props = {
    callId: 'call-1', toolName: 'compute_plan_draft', block, openFile: () => {}, loadImage: async () => '',
    t, useCompute: <S,>(select: (snapshot: ComputeState) => S) => select(state), ...actions,
  }
  const view = render(<TaskCardRow {...props as never} />)
  return {
    actions,
    setDrafts(next: ComputePlanDraft[]) {
      state.drafts = next
      view.rerender(<TaskCardRow {...props as never} />)
    },
  }
}

describe('compute plan draft conversation card', () => {
  it('projects a local draft into an awaiting-confirmation card with local confirm controls', async () => {
    const { actions } = row(result)
    expect(screen.getByText(zh.cardAwaiting)).toBeTruthy()
    expect(screen.getByText('处理五张图片')).toBeTruthy()
    expect(screen.getByText('image.batch')).toBeTruthy()
    expect(screen.getByText(t('amount', { amount: '1.50' }))).toBeTruthy()
    expect(screen.getByText(zh.cardDraftHint)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /执行|付款|提交/ })).toBeNull()
    expect(screen.queryByRole('button', { name: zh.cardPublish })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.cardConfirm })) })
    expect(actions.confirmDraft).toHaveBeenCalledWith(cardId, 'approved')
    expect(actions.ensureLoaded).toHaveBeenCalled()
  })

  it('persists decline locally and hides controls after the stored decision arrives', async () => {
    const { actions, setDrafts } = row(result, [stored('pending')])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.cardDecline })) })
    expect(actions.confirmDraft).toHaveBeenCalledWith(cardId, 'declined')
    act(() => { setDrafts([stored('declined')]) })
    expect(screen.getByText(zh.cardDeclined)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.cardConfirm })).toBeNull()
    expect(screen.queryByRole('button', { name: zh.cardDecline })).toBeNull()
  })

  it('shows a locally approved card with a publish control and no quote', async () => {
    const { actions } = row(result, [stored('approved')])
    expect(screen.getByText(zh.cardApproved)).toBeTruthy()
    expect(screen.getByText(zh.cardPublishHint)).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.cardConfirm })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.cardPublish })) })
    expect(actions.publishDraft).toHaveBeenCalledWith(cardId)
  })

  it('shows a published card with the core workload identity and no publish control', () => {
    row(result, [{ ...stored('approved'), workloadId: 'workload-fixture-1' as ComputePlanDraft['workloadId'] }])
    expect(screen.getByText(zh.cardPublished)).toBeTruthy()
    expect(screen.getByText('workload-fixture-1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.cardPublish })).toBeNull()
  })

  it('shows a pending card until the tool result is available', () => {
    row({ kind: 'tool-call', seq: 1, time: 0, callId: 'call-1', call: { name: 'compute_plan_draft', argsRaw: '{}' } } as ToolCallViewProps['block'])
    expect(screen.getByText(zh.cardPending)).toBeTruthy()
  })

  it('does not invent a card from an error result or missing metadata', () => {
    row({
      kind: 'tool-result',
      seq: 1,
      time: 0,
      callId: 'call-1',
      call: { name: 'compute_plan_draft', argsRaw: '{}' },
      callTime: 0,
      content: [],
      isError: true,
      subCalls: [],
    })
    expect(screen.getByText(zh.cardUnavailable)).toBeTruthy()
    expect(screen.queryByText(zh.cardAwaiting)).toBeNull()
    row({ ...result, meta: { protocol: 'qianshou.task-card.v1' } } as ToolCallViewProps['block'])
    expect(screen.getAllByText(zh.cardUnavailable).length).toBeGreaterThan(0)
    row({ ...result, meta: { ...result.meta as object, budgetMinor: -1 } } as ToolCallViewProps['block'])
    expect(screen.getAllByText(zh.cardUnavailable).length).toBeGreaterThan(0)
  })
})
