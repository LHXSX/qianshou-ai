/**
 * 额度账本的契约测试。
 *
 * 这里每一条错了都会变成**账目错**（多收、少收、或用户在没拿到回答时被扣钱），
 * 而不是"功能没生效"。所以断言写到具体数字上。
 */
import { describe, expect, it } from 'vitest'
import { WINDOW_MS, createCreditLedger } from '../src/ledger.ts'

/** 可控时钟。 */
function clock(start = new Date('2026-09-16T10:00:00').getTime()): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => { current += ms } }
}

/** 一个新账户 + 已授予额度的账本。 */
function setup(monthlySp = 100): { ledger: ReturnType<typeof createCreditLedger>; time: ReturnType<typeof clock> } {
  const time = clock()
  const ledger = createCreditLedger({ now: time.now })
  ledger.grant('acct-1', 'basic', monthlySp)
  return { ledger, time }
}

describe('授予与重置', () => {
  it('授予之后可用额度就是授予量', () => {
    const { ledger } = setup(390)
    expect(ledger.creditOf('acct-1', 'basic').remainingMonthlySp).toBe(390)
  })

  it('跨月自动重置：上月的消费不再计入本月', () => {
    const { ledger, time } = setup(100)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 80 })
    ledger.settle({ callId: 'c1', sp: 80 })
    expect(ledger.creditOf('acct-1', 'basic').remainingMonthlySp).toBe(20)

    // 走到下个月并重新授予
    time.advance(31 * 24 * 60 * 60 * 1000)
    ledger.grant('acct-1', 'basic', 100)
    expect(ledger.creditOf('acct-1', 'basic').remainingMonthlySp).toBe(100)
  })

  it('同一周期内重复授予不叠加', () => {
    const { ledger } = setup(100)
    ledger.grant('acct-1', 'basic', 100)
    expect(ledger.creditOf('acct-1', 'basic').remainingMonthlySp).toBe(100)
  })
})

describe('预留与结算', () => {
  it('按实际用量结算，多预留的退回', () => {
    const { ledger } = setup(100)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 30 })
    const result = ledger.settle({ callId: 'c1', sp: 12 })
    expect(result.chargedSp).toBe(12)
    expect(result.releasedSp).toBe(18)
    expect(result.remainingSp).toBe(88)
  })

  it('实际用量超过预留时按实际扣（不留缺口）', () => {
    const { ledger } = setup(100)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 10 })
    const result = ledger.settle({ callId: 'c1', sp: 15 })
    expect(result.chargedSp).toBe(15)
    expect(result.releasedSp).toBe(0)
    expect(result.remainingSp).toBe(85)
  })

  it('**未结算的预留要占住额度**：否则并发请求会同时看到同一份余额', () => {
    const { ledger } = setup(100)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 60 })
    // 第二笔还没发生，但第一笔的钱已经被占住
    expect(ledger.creditOf('acct-1', 'basic').remainingMonthlySp).toBe(40)
  })

  it('调用失败不计费：用户没拿到回答就不该付钱', () => {
    const { ledger } = setup(100)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 25 })
    const result = ledger.release('c1')
    expect(result.chargedSp).toBe(0)
    expect(result.releasedSp).toBe(25)
    expect(result.remainingSp).toBe(100)
  })

  it('没有预留就结算会抛错，而不是静默记账', () => {
    const { ledger } = setup()
    expect(() => ledger.settle({ callId: '不存在', sp: 1 })).toThrow(/没有找到这笔预留/)
  })

  it('重复结算会抛错（同一笔钱不能被扣两次）', () => {
    const { ledger } = setup()
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 5 })
    ledger.settle({ callId: 'c1', sp: 5 })
    expect(() => ledger.settle({ callId: 'c1', sp: 5 })).toThrow(/没有找到这笔预留/)
  })
})

describe('五小时刹车：滚动窗口，不是固定整点', () => {
  it('窗口内的消费计入刹车', () => {
    const { ledger } = setup(1000)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 40 })
    ledger.settle({ callId: 'c1', sp: 40 })
    expect(ledger.creditOf('acct-1', 'basic').usedInWindowSp).toBe(40)
  })

  it('过了五小时，窗口内的消费清零（额度本身不受影响）', () => {
    const { ledger, time } = setup(1000)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 40 })
    ledger.settle({ callId: 'c1', sp: 40 })

    time.advance(WINDOW_MS + 1000)
    const credit = ledger.creditOf('acct-1', 'basic')
    expect(credit.usedInWindowSp).toBe(0)
    // 但月额度确实被花掉了 40
    expect(credit.remainingMonthlySp).toBe(960)
  })

  it('是滚动的：两小时后的一笔，四小时后仍在窗口内', () => {
    const { ledger, time } = setup(1000)
    time.advance(2 * 60 * 60 * 1000)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 10 })
    ledger.settle({ callId: 'c1', sp: 10 })

    time.advance(4 * 60 * 60 * 1000)
    // 距那笔 4 小时 < 5 小时，仍在窗口内
    expect(ledger.creditOf('acct-1', 'basic').usedInWindowSp).toBe(10)
    time.advance(2 * 60 * 60 * 1000)
    // 现在距那笔 6 小时，出窗了
    expect(ledger.creditOf('acct-1', 'basic').usedInWindowSp).toBe(0)
  })

  it('未结算的预留也计入刹车（否则可以靠并发绕过刹车）', () => {
    const { ledger } = setup(1000)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 55 })
    expect(ledger.creditOf('acct-1', 'basic').usedInWindowSp).toBe(55)
  })
})

describe('审计记录', () => {
  it('每笔结算都留下记录，且只记前台名、不记上游厂商', () => {
    const { ledger } = setup(1000)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 10 })
    ledger.settle({
      callId: 'c1',
      sp: 8,
      call: { tier: 'plus', publishedName: '千手·强力', backendKey: 'pro', inputTokens: 2000, outputTokens: 800 },
    })

    const records = ledger.recordsOf('acct-1')
    expect(records).toHaveLength(1)
    expect(records[0]?.publishedName).toBe('千手·强力')
    expect(records[0]?.inputTokens).toBe(2000)
    expect(records[0]?.outputTokens).toBe(800)
    expect(records[0]?.sp).toBe(8)
    // 账本是给用户看的：里面不该出现我们要隐藏的上游模型标识
    expect(JSON.stringify(records)).not.toContain('deepseek')
  })

  it('失败调用不留记录（没发生的事不进账）', () => {
    const { ledger } = setup(1000)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 10 })
    ledger.release('c1')
    expect(ledger.recordsOf('acct-1')).toHaveLength(0)
  })

  it('记录按时间倒序，并遵守条数上限', () => {
    const { ledger } = setup(1000)
    for (let index = 0; index < 5; index += 1) {
      ledger.reserve({ callId: `c${index}`, accountId: 'acct-1', sp: 1 })
      ledger.settle({ callId: `c${index}`, sp: 1 })
    }
    const records = ledger.recordsOf('acct-1', 3)
    expect(records).toHaveLength(3)
    expect(records.map(r => r.callId)).toEqual(['c4', 'c3', 'c2'])
  })

  it('只看得到自己的记录（多账户隔离）', () => {
    const { ledger } = setup(1000)
    ledger.grant('acct-2', 'basic', 100)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 1 })
    ledger.settle({ callId: 'c1', sp: 1 })
    expect(ledger.recordsOf('acct-2')).toHaveLength(0)
  })
})

describe('与 admit() 的衔接（额度状态就是它要的形状）', () => {
  it('creditOf 返回的正是 admit 需要的两个字段', () => {
    const { ledger } = setup(100)
    ledger.reserve({ callId: 'c1', accountId: 'acct-1', sp: 30 })
    ledger.settle({ callId: 'c1', sp: 30 })
    expect(ledger.creditOf('acct-1', 'basic')).toEqual({ remainingMonthlySp: 70, usedInWindowSp: 30 })
  })
})

describe('原子放行：堵住「两个并发请求同时通过检查」这个会花钱的竞态', () => {
  it('第一笔预留之后，第二笔基于**已占住**的余额判定（看不到同一份钱两次）', () => {
    const { ledger } = setup(100)
    // 第一笔：要 60，余额够
    const first = ledger.admitAndReserve({
      callId: 'c1',
      accountId: 'acct-1',
      tier: 'basic',
      plan: credit => ({ remaining: credit.remainingMonthlySp, take: 60 }),
      reservedSpOf: outcome => outcome.take,
    })
    expect(first.remaining).toBe(100)

    // 第二笔：此时余额只剩 40，要 60 就该被拒
    const second = ledger.admitAndReserve({
      callId: 'c2',
      accountId: 'acct-1',
      tier: 'basic',
      plan: credit => (credit.remainingMonthlySp < 60 ? { rejected: true, saw: credit.remainingMonthlySp } : { rejected: false, take: 60 }),
      reservedSpOf: outcome => ('rejected' in outcome ? null : (outcome as { take: number }).take),
    })
    expect(second).toEqual({ rejected: true, saw: 40 })
  })

  it('被拒时不产生预留（不留副作用）', () => {
    const { ledger } = setup(10)
    ledger.admitAndReserve({
      callId: 'c1',
      accountId: 'acct-1',
      tier: 'basic',
      plan: () => ({ ok: false }),
      reservedSpOf: () => null,
    })
    expect(ledger.creditOf('acct-1', 'basic').remainingMonthlySp).toBe(10)
    expect(() => ledger.settle({ callId: 'c1', sp: 1 })).toThrow(/没有找到这笔预留/)
  })

  it('放行时预留立即生效（同一账户的下一次判定能看到）', () => {
    const { ledger } = setup(100)
    ledger.admitAndReserve({
      callId: 'c1',
      accountId: 'acct-1',
      tier: 'basic',
      plan: () => ({ ok: true }),
      reservedSpOf: () => 30,
    })
    expect(ledger.creditOf('acct-1', 'basic').remainingMonthlySp).toBe(70)
  })
})

describe('账本精确性：SP 是钱，不能有浮点漂移', () => {
  /** 一次典型问答的花费：实测 120 输入 + 40 输出，按 deepseek-flash 计价 = 0.07 SP。 */
  const TYPICAL = 0.07

  it('连续扣减一千次后余额仍然精确（整数微 SP 的直接防线）', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 1000)
    for (let index = 0; index < 1000; index += 1) {
      const callId = `c-${index}`
      ledger.reserve({ callId, accountId: 'a', sp: TYPICAL })
      ledger.settle({ callId, sp: TYPICAL })
    }
    // 浮点累加会得到 930.0000000000349 之类；整数微 SP 必须给出**恰好** 930。
    expect(ledger.creditOf('a', 'basic').remainingMonthlySp).toBe(1000 - TYPICAL * 1000)
  })

  it('余额是有限小数，不会出现 0.30000000000000004 这种尾巴', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 1)
    for (let index = 0; index < 3; index += 1) {
      const callId = `c-${index}`
      ledger.reserve({ callId, accountId: 'a', sp: 0.1 })
      ledger.settle({ callId, sp: 0.1 })
    }
    // 0.1 在二进制浮点里没有精确表示，三次累加会漂移；整数记账不会。
    expect(ledger.creditOf('a', 'basic').remainingMonthlySp).toBe(0.7)
  })

  it('五小时窗口的累计值同样精确', () => {
    let clock = 1_700_000_000_000
    const ledger = createCreditLedger({ now: () => clock })
    ledger.grant('a', 'basic', 100)
    for (let index = 0; index < 10; index += 1) {
      const callId = `c-${index}`
      ledger.reserve({ callId, accountId: 'a', sp: 0.07 })
      ledger.settle({ callId, sp: 0.07 })
      clock += 1000
    }
    expect(ledger.creditOf('a', 'basic').usedInWindowSp).toBe(0.7)
  })

  it('预留与结算允许有微小差额，退回量精确', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 100)
    ledger.reserve({ callId: 'c', accountId: 'a', sp: 3.47 })
    const outcome = ledger.settle({ callId: 'c', sp: 0.07 })
    expect(outcome.releasedSp).toBe(3.4)
    expect(outcome.remainingSp).toBe(99.93)
  })
})

describe('中途断开的成本：不能全额退回（这是一处真实漏洞的防线）', () => {
  /**
   * 早先客户端中途断开走的是 `release()`——**全额退回且不留记录**。
   * 那是可被利用的：上游已经把发过去的输入 token 都算过费了，
   * 而我们一分不收、**这次调用还不进账本**，于是月度上限与五小时刹车同时看不到它。
   * "发个大请求、200 毫秒后断开"可以无限重复白用。
   * 修法是 `settlePartial`：只退没花掉的部分，且刻意不写完整调用记录。
   */
  it('部分结算：按已产生的成本扣，其余退回', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 100)
    ledger.reserve({ callId: 'c', accountId: 'a', sp: 10 })
    const outcome = ledger.settlePartial({ callId: 'c', sp: 0.07 })
    expect(outcome.chargedSp).toBe(0.07)
    expect(outcome.releasedSp).toBe(9.93)
    expect(outcome.remainingSp).toBe(99.93)
  })

  it('**部分结算不写完整调用记录**（未完成的调用不该出现在对账里）', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 100)
    ledger.reserve({ callId: 'c', accountId: 'a', sp: 10 })
    ledger.settlePartial({ callId: 'c', sp: 0.07 })
    // 关键：records 里没有它，但**额度确实被扣了**——这就是修复的要点。
    expect(ledger.recordsOf('a', 10).length).toBe(0)
    expect(ledger.creditOf('a', 'basic').remainingMonthlySp).toBe(99.93)
  })

  it('扣的钱会进五小时窗口（否则刹车照样被绕过）', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 100)
    ledger.reserve({ callId: 'c', accountId: 'a', sp: 10 })
    ledger.settlePartial({ callId: 'c', sp: 3.5 })
    // 早先全额退回时这里是 0——刹车因此形同虚设。
    expect(ledger.creditOf('a', 'basic').usedInWindowSp).toBe(3.5)
  })

  it('没有预留就部分结算会抛错（与 settle/release 同样的纪律）', () => {
    const ledger = createCreditLedger()
    expect(() => ledger.settlePartial({ callId: 'nope', sp: 1 })).toThrow()
  })

  it('部分结算的金额不会超过预留（多退少不补）', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 100)
    ledger.reserve({ callId: 'c', accountId: 'a', sp: 1 })
    // 传一个比预留大的数：按预留封顶，不能把余额扣成负数。
    const outcome = ledger.settlePartial({ callId: 'c', sp: 999 })
    expect(outcome.chargedSp).toBe(1)
    expect(outcome.releasedSp).toBe(0)
    expect(outcome.remainingSp).toBe(99)
  })

  it('重复部分结算会抛错（同一笔钱不能被扣两次）', () => {
    const ledger = createCreditLedger()
    ledger.grant('a', 'basic', 100)
    ledger.reserve({ callId: 'c', accountId: 'a', sp: 10 })
    ledger.settlePartial({ callId: 'c', sp: 1 })
    expect(() => ledger.settlePartial({ callId: 'c', sp: 1 })).toThrow()
  })
})
