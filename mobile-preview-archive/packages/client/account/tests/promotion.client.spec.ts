import { describe, expect, it } from 'vitest'
import { parsePromotionSnapshot } from '../src/promotion.ts'

describe('promotion projection', () => {
  it('parses only server-owned invite and reward facts', () => {
    expect(parsePromotionSnapshot({ ok: true, accountId: '7', promotion: { status: 'ready', invite_url: 'https://example.test/i/7', invited_count: 2, pending_points: 10, settled_points: 4 } }, '7')).toEqual({ inviteUrl: 'https://example.test/i/7', invitedCount: 2, pendingPoints: 10, settledPoints: 4, status: 'ready', message: null })
  })
  it('rejects cross-account and malformed responses instead of showing rewards', () => {
    expect(() => parsePromotionSnapshot({ ok: true, accountId: '8', status: 'ready' }, '7')).toThrow('ACCOUNT_CHANGED')
    expect(() => parsePromotionSnapshot({ ok: true, status: 'ready', pending_points: -1 }, '7')).toThrow('PROMOTION_RESPONSE_INVALID')
  })
})
