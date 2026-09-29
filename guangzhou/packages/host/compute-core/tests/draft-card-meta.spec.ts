import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId, ComputePlanId } from '../src/protocol.ts'
import { PLAN_DRAFT_CARD_META_PROTOCOL, planDraftCardMeta } from '../src/draft-card-meta.ts'

describe('plan draft card metadata', () => {
  it('projects replayable observations without inventing a quote or submission', () => {
    const meta = planDraftCardMeta({
      id: ComputePlanId('plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      request: {
        capabilityId: ComputeCapabilityId('image.batch'),
        goal: 'Batch ten product photos',
        budgetMinor: 150,
        currency: 'CNY',
        maxNodes: null,
      },
      status: 'draft',
      createdAt: '2026-09-16T12:00:00.000Z',
      quote: null,
      reason: '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。',
      authorization: 'pending',
      workloadId: null,
    })
    expect(meta).toEqual({
      protocol: PLAN_DRAFT_CARD_META_PROTOCOL,
      cardId: 'plan_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      title: 'Batch ten product photos',
      capabilityId: 'image.batch',
      budgetMinor: 150,
      currency: 'CNY',
      maxNodes: null,
      createdAt: '2026-09-16T12:00:00.000Z',
      reason: '方案草稿已保存，尚未报价、下单或扣费；节点数量是请求上限，不代表资源已预留。',
    })
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
  })
})
