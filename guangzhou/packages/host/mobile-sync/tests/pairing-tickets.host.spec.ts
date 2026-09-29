/**
 * 配对票据的契约测试。
 *
 * 这里断言的每一条都是**安全性质**，不是实现细节：一次性、过期、限次、常数时间。
 * 任何一条失守都不会有报错，只会安静地多一个入口——所以必须由测试盯住。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TICKET_TTL_MS, createPairingTickets } from '../src/gateway/pairing.ts'

/** 可控时钟。 */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => { current += ms } }
}

describe('配票据：四条安全性质', () => {
  it('签发出来的票据够长且不可预测（同一时刻两次签发不同）', () => {
    const tickets = createPairingTickets()
    const first = tickets.issue()
    const second = tickets.issue()
    expect(first.length).toBeGreaterThanOrEqual(20)
    expect(first).not.toBe(second)
  })

  it('**一次性**：用掉之后同一张票再也换不了', () => {
    const tickets = createPairingTickets()
    const value = tickets.issue()
    expect(tickets.redeem(value, 'phone-1')).toEqual({ ok: true })
    expect(tickets.redeem(value, 'phone-1')).toEqual({ ok: false, reason: 'expired' })
    expect(tickets.pending()).toBe(false)
  })

  it('**短时**：过了有效期就不能用', () => {
    const time = clock()
    const tickets = createPairingTickets({ now: time.now })
    const value = tickets.issue()
    time.advance(DEFAULT_TICKET_TTL_MS - 1)
    expect(tickets.pending()).toBe(true)
    time.advance(2)
    expect(tickets.redeem(value, 'phone-1')).toEqual({ ok: false, reason: 'expired' })
  })

  it('**限次**：同一来源连续试错到阈值后拒绝，而不是让它继续撞', () => {
    const tickets = createPairingTickets({ maxAttempts: 3 })
    tickets.issue()
    const wrong = 'not-the-ticket'
    expect(tickets.redeem(wrong, 'attacker')).toEqual({ ok: false, reason: 'unknown' })
    expect(tickets.redeem(wrong, 'attacker')).toEqual({ ok: false, reason: 'unknown' })
    expect(tickets.redeem(wrong, 'attacker')).toEqual({ ok: false, reason: 'unknown' })
    expect(tickets.redeem(wrong, 'attacker')).toEqual({ ok: false, reason: 'too-many-attempts' })
    // 换一个来源仍可尝试：记账按来源，不是全局熔断（否则等于给了 DoS 手段）
    expect(tickets.redeem(wrong, 'other')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('限次按来源记账，不误伤别的设备', () => {
    const tickets = createPairingTickets({ maxAttempts: 3 })
    const value = tickets.issue()
    // 攻击者先把自己的配额撞完
    for (let i = 0; i < 3; i += 1) tickets.redeem('wrong', 'attacker')
    expect(tickets.redeem('wrong', 'attacker')).toEqual({ ok: false, reason: 'too-many-attempts' })
    // 真正的手机一次都没错过，照常能兑换——限次不该变成全局限流，
    // 否则谁都能拿它把别人的配对卡死。
    expect(tickets.redeem(value, 'phone-1')).toEqual({ ok: true })
  })

  it('重新签发会作废上一张：屏幕上不会同时存在两个有效二维码', () => {
    const tickets = createPairingTickets()
    const first = tickets.issue()
    const second = tickets.issue()
    expect(tickets.redeem(first, 'phone-1')).toEqual({ ok: false, reason: 'unknown' })
    expect(tickets.redeem(second, 'phone-1')).toEqual({ ok: true })
  })

  it('长度不同的输入直接判负，不抛（常数时间比较的前置判断）', () => {
    const tickets = createPairingTickets()
    const value = tickets.issue()
    expect(tickets.redeem(`${value}尾巴`, 'phone-1')).toEqual({ ok: false, reason: 'unknown' })
    expect(tickets.redeem('', 'phone-1')).toEqual({ ok: false, reason: 'unknown' })
    expect(tickets.redeem(value, 'phone-1')).toEqual({ ok: true })
  })

  it('没有票据时兑换失败，而不是抛', () => {
    const tickets = createPairingTickets()
    expect(tickets.redeem('anything', 'phone-1')).toEqual({ ok: false, reason: 'expired' })
    expect(tickets.pending()).toBe(false)
    expect(tickets.expiresAt()).toBeNull()
  })

  it('expiresAt 报告的是当前票据的过期时刻', () => {
    const time = clock()
    const tickets = createPairingTickets({ now: time.now, ttlMs: 60_000 })
    expect(tickets.expiresAt()).toBeNull()
    tickets.issue()
    expect(tickets.expiresAt()).toBe(time.now() + 60_000)
  })
})
