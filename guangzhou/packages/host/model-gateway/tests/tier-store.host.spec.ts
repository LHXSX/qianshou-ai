/**
 * 订阅档位存储的契约测试。
 *
 * 守的核心是一件事：**档位是花钱买到的权益，不是平台角色**。
 * 在此之前两者是一回事（`personal→basic`、`pro→plus`、`enterprise→max`），
 * 后果是用户付了高级版的钱但角色没变，他拿到的仍是普通版额度；
 * 而管理员想给他开通，只能去改平台角色——那是改权限，不是卖订阅。
 */
import { describe, expect, it } from 'vitest'
import { createTierStore, TIER_STORE_FILENAME } from '../src/tier-store.ts'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-09-01T00:00:00Z').getTime()

/** 一条订阅。 */
function subscription(overrides: Partial<Parameters<ReturnType<typeof createTierStore>['grant']>[0]> = {}) {
  return {
    accountId: 'a',
    tier: 'plus' as const,
    from: T0,
    to: T0 + 30 * DAY,
    grantedBy: 'admin',
    reason: '订单 QS-1',
    ...overrides,
  }
}

describe('订阅档位：花钱买到的权利', () => {
  it('没有记录时返回 null（由调用方决定兜底成什么）', () => {
    const store = createTierStore()
    expect(store.tierOf('nobody', T0)).toBeNull()
  })

  it('有效期内返回买到的档位', () => {
    const store = createTierStore()
    store.grant(subscription())
    expect(store.tierOf('a', T0 + DAY)).toBe('plus')
  })

  it('生效前不算（不能提前用）', () => {
    const store = createTierStore()
    store.grant(subscription({ from: T0 + 10 * DAY }))
    expect(store.tierOf('a', T0)).toBeNull()
  })

  it('**过期就是过期**，不自动宽限', () => {
    const store = createTierStore()
    store.grant(subscription({ to: T0 + 30 * DAY }))
    expect(store.tierOf('a', T0 + 30 * DAY)).toBeNull()
    expect(store.tierOf('a', T0 + 30 * DAY - 1)).toBe('plus')
  })

  it('to=null 表示不自动到期（内部账号用），但这不是默认', () => {
    const store = createTierStore()
    store.grant(subscription({ to: null }))
    expect(store.tierOf('a', T0 + 3650 * DAY)).toBe('plus')
  })

  it('续费：新记录接上，档位连续', () => {
    const store = createTierStore()
    store.grant(subscription({ to: T0 + 30 * DAY }))
    store.grant(subscription({ from: T0 + 30 * DAY, to: T0 + 60 * DAY, reason: '续费 QS-2' }))
    expect(store.tierOf('a', T0 + 15 * DAY)).toBe('plus')
    expect(store.tierOf('a', T0 + 45 * DAY)).toBe('plus')
  })

  it('升级：取此刻有效记录里**生效时刻最晚**的那条', () => {
    const store = createTierStore()
    store.grant(subscription({ tier: 'basic', to: T0 + 30 * DAY }))
    // 同一天升级到 max：两条都在有效期内，用户最近一次的真实权益是最新的那条。
    store.grant(subscription({ tier: 'max', from: T0 + DAY, to: T0 + 31 * DAY, reason: '升级' }))
    expect(store.tierOf('a', T0 + 2 * DAY)).toBe('max')
    // 升级生效前仍然是旧档位。
    expect(store.tierOf('a', T0 + DAY - 1)).toBe('basic')
  })

  it('已经是 max 之后再"升级"到 plus：以最新那条为准（这是降级，也是一次真实变更）', () => {
    const store = createTierStore()
    store.grant(subscription({ tier: 'max', to: T0 + 30 * DAY }))
    store.grant(subscription({ tier: 'plus', from: T0 + DAY, to: T0 + 30 * DAY, reason: '改档' }))
    expect(store.tierOf('a', T0 + 2 * DAY)).toBe('plus')
  })

  it('记录是追加式的：历史保留，改档不改历史', () => {
    const store = createTierStore()
    store.grant(subscription({ tier: 'basic' }))
    store.grant(subscription({ tier: 'max', from: T0 + DAY }))
    const history = store.historyOf('a')
    expect(history.length).toBe(2)
    expect(history[0]?.tier).toBe('max')
    expect(history[1]?.tier).toBe('basic')
    // 留痕字段必须在：对账时靠它解释"为什么给这一档"。
    expect(history[0]?.grantedBy).toBe('admin')
    expect(history[0]?.reason).toBe('订单 QS-1')
  })

  it('账号之间互不影响', () => {
    const store = createTierStore()
    store.grant(subscription({ accountId: 'a', tier: 'plus' }))
    store.grant(subscription({ accountId: 'b', tier: 'max' }))
    expect(store.tierOf('a', T0 + DAY)).toBe('plus')
    expect(store.tierOf('b', T0 + DAY)).toBe('max')
    expect(store.accounts()).toEqual(['a', 'b'])
  })

  it('落盘快照能装回同样的档位（重启不丢订阅）', () => {
    const first = createTierStore()
    first.grant(subscription({ accountId: 'a', tier: 'plus' }))
    first.grant(subscription({ accountId: 'b', tier: 'max', from: T0 + DAY }))
    const snapshot = first.snapshotOf()

    const second = createTierStore()
    second.restore(snapshot)
    expect(second.tierOf('a', T0 + DAY)).toBe('plus')
    expect(second.tierOf('b', T0 + 2 * DAY)).toBe('max')
    expect(second.historyOf('a').length).toBe(1)
  })

  it('版本号不认识时拒绝恢复（避免按错的结构授权）', () => {
    const store = createTierStore()
    store.restore({ version: 99, savedAt: 0, subscriptions: [subscription()] })
    expect(store.tierOf('a', T0 + DAY)).toBeNull()
  })

  it('变更会通知持久化层（否则订阅只活在内存里）', () => {
    let notified = 0
    const store = createTierStore({ onChange: () => { notified += 1 } })
    store.grant(subscription())
    expect(notified).toBe(1)
  })

  it('恢复本身不算变更（冷启动不该立刻重写文件）', () => {
    let notified = 0
    const store = createTierStore({ onChange: () => { notified += 1 } })
    store.restore({ version: 1, savedAt: 0, subscriptions: [subscription()] })
    expect(notified).toBe(0)
  })

  it('文件名是一份固定契约（部署方按它找文件）', () => {
    expect(TIER_STORE_FILENAME).toBe('.qianshou-subscriptions.json')
  })
})
