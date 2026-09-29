/**
 * 路由控制台的契约测试。
 *
 * 这里断言的是**可解释性**：某个名字在某一天意味着哪个后端、换绑之后用户会不会被惊动、
 * 灰度的人与不在灰度的人分别落到谁。错了不会崩，只会让某天的账单说不清。
 */
import { describe, expect, it } from 'vitest'
import { bucketOf, createRoutingConsole, type PublishedNameRecord } from '../src/routing.ts'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-09-01T00:00:00Z').getTime()

/** 一个前台名字的记录。 */
function record(overrides: Partial<PublishedNameRecord> = {}): PublishedNameRecord {
  return {
    publishedName: '千手·强力',
    label: '千手·强力',
    tiers: ['plus', 'max'],
    maxOutputTokens: 16384,
    order: 1,
    upgradeRule: 'on-expiry',
    lifecycleStage: 'ga',
    shutdownDate: null,
    migrationTarget: null,
    ...overrides,
  }
}

describe('版本化绑定：某一时刻由谁作答', () => {
  it('绑定生效前没有后端可用', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0 + DAY, reason: '首发', operator: 'ceo' })
    const result = console_.resolve('千手·强力', T0, 'req-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no-binding')
  })

  it('生效后按绑定的后端作答', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro', 'flash'], effectiveFrom: T0, reason: '首发', operator: 'ceo' })
    const result = console_.resolve('千手·强力', T0 + DAY, 'req-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.backendKeys).toEqual(['pro', 'flash'])
  })

  it('**同一天永远得到同一个答案**：换绑之后回看历史，仍然是旧后端', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0, reason: '首发', operator: 'ceo' })
    const switchDay = T0 + 30 * DAY
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro-v2'], effectiveFrom: switchDay, reason: '上游换版本', operator: 'ceo' })

    // 换绑前的那一天，答案没被改写
    const before = console_.resolve('千手·强力', T0 + 10 * DAY, 'req-1')
    expect(before.ok).toBe(true)
    if (before.ok) expect(before.backendKeys).toEqual(['pro'])
    // 换绑当天起用新的
    const after = console_.resolve('千手·强力', switchDay, 'req-1')
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.backendKeys).toEqual(['pro-v2'])
  })

  it('上一条的失效时刻由下一条的生效时刻决定，**不留重叠也不留空档**', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0, reason: '首发', operator: 'ceo' })
    const switchDay = T0 + 10 * DAY
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro-v2'], effectiveFrom: switchDay, reason: '换版本', operator: 'ceo' })

    const history = console_.historyOf('千手·强力')
    expect(history).toHaveLength(2)
    expect(history[0]?.effectiveTo).toBe(switchDay)
    expect(history[1]?.effectiveFrom).toBe(switchDay)
    // 交接点前后都有人作答
    const justBefore = console_.resolve('千手·强力', switchDay - 1, 'req')
    const at = console_.resolve('千手·强力', switchDay, 'req')
    expect(justBefore.ok && at.ok).toBe(true)
  })

  it('**只允许往后追加**：生效时刻不比上一条晚就报错（否则历史不可解释）', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    const switchDay = T0 + 10 * DAY
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: switchDay, reason: '首发', operator: 'ceo' })
    expect(() => console_.bind({
      publishedName: '千手·强力',
      backendKeys: ['pro-v2'],
      effectiveFrom: switchDay - DAY,
      reason: '想改历史',
      operator: 'ceo',
    })).toThrow(/必须晚于上一条绑定/)
  })

  it('一条绑定至少要有一个后端', () => {
    const console_ = createRoutingConsole()
    expect(() => console_.bind({ publishedName: 'x', backendKeys: [], effectiveFrom: T0, reason: '空', operator: 'ceo' }))
      .toThrow(/至少要有一个后端/)
  })

  it('每条绑定都留下原因与操作者（对账的人要知道为什么改的）', () => {
    const console_ = createRoutingConsole()
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0, reason: '上游发布新版本', operator: 'ceo' })
    const binding = console_.historyOf('千手·强力')[0]
    expect(binding?.reason).toBe('上游发布新版本')
    expect(binding?.operator).toBe('ceo')
  })
})

describe('下线：过了 shutdownDate 就不作答，并给迁移建议', () => {
  it('下线后拒绝，并说明建议迁到哪个名字', () => {
    const console_ = createRoutingConsole()
    console_.publish(record({ shutdownDate: T0 + 60 * DAY, migrationTarget: '千手·强力二代' }))
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0, reason: '首发', operator: 'ceo' })

    const alive = console_.resolve('千手·强力', T0 + 59 * DAY, 'req')
    expect(alive.ok).toBe(true)

    const dead = console_.resolve('千手·强力', T0 + 60 * DAY, 'req')
    expect(dead.ok).toBe(false)
    if (!dead.ok) {
      expect(dead.reason).toBe('retired')
      expect(dead.message).toContain('千手·强力二代')
    }
  })

  it('没有迁移目标时只说下线，不编一个建议', () => {
    const console_ = createRoutingConsole()
    console_.publish(record({ shutdownDate: T0, migrationTarget: null }))
    const dead = console_.resolve('千手·强力', T0, 'req')
    expect(dead.ok).toBe(false)
    if (!dead.ok) expect(dead.message).not.toContain('建议改用')
  })
})

describe('灰度：确定性分流，不用随机数', () => {
  it('同一个请求标识永远落在同一个桶', () => {
    expect(bucketOf('acct-1:req-9')).toBe(bucketOf('acct-1:req-9'))
    expect(bucketOf('acct-1:req-9')).toBeGreaterThanOrEqual(0)
    expect(bucketOf('acct-1:req-9')).toBeLessThan(100)
  })

  it('灰度内的请求走新后端，标记 canary', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0, reason: '旧', operator: 'ceo' })
    // 100% 灰度等价于全量；这里先验全量路径
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro-v2'], effectiveFrom: T0 + DAY, reason: '新', operator: 'ceo', rolloutPercent: 100 })
    const result = console_.resolve('千手·强力', T0 + 2 * DAY, 'req-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.backendKeys).toEqual(['pro-v2'])
      expect(result.rollout).toBe('full')
    }
  })

  it('**不在灰度内的请求回落到换绑前的后端**，而不是"没有后端可用"', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0, reason: '旧', operator: 'ceo' })
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro-v2'], effectiveFrom: T0 + DAY, reason: '新', operator: 'ceo', rolloutPercent: 0 })

    // 0% 灰度 = 谁都不在新版上 → 全部回落
    const result = console_.resolve('千手·强力', T0 + 2 * DAY, 'req-1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.backendKeys).toEqual(['pro'])
  })

  it('灰度按请求标识分流：同一个名字下既有走新的也有走旧的', () => {
    const console_ = createRoutingConsole()
    console_.publish(record())
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro'], effectiveFrom: T0, reason: '旧', operator: 'ceo' })
    console_.bind({ publishedName: '千手·强力', backendKeys: ['pro-v2'], effectiveFrom: T0 + DAY, reason: '新', operator: 'ceo', rolloutPercent: 50 })

    const keys = Array.from({ length: 200 }, (_, index) => `acct-${index}`)
    const outcomes = keys.map((key) => {
      const result = console_.resolve('千手·强力', T0 + 2 * DAY, key)
      return result.ok ? result.backendKeys[0] : 'none'
    })
    // 两边的都有：既不是全在新版，也不是全在旧版
    expect(outcomes).toContain('pro-v2')
    expect(outcomes).toContain('pro')
  })

  it('灰度百分比会被夹在 0–100', () => {
    const console_ = createRoutingConsole()
    const binding = console_.bind({ publishedName: 'x', backendKeys: ['a'], effectiveFrom: T0, reason: 't', operator: 'o', rolloutPercent: 999 })
    expect(binding[0]?.rolloutPercent).toBe(100)
  })
})

describe('名字清单', () => {
  it('按 order 排序，给控制台列表用', () => {
    const console_ = createRoutingConsole()
    console_.publish(record({ publishedName: 'B', order: 2 }))
    console_.publish(record({ publishedName: 'A', order: 1 }))
    expect(console_.names().map(item => item.publishedName)).toEqual(['A', 'B'])
  })
})
