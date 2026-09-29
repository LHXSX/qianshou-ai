/**
 * 并发上限执行器的契约测试。
 *
 * 这个模块存在的理由：档位表里的 `concurrency`（普通 5 / 高级 20 / Max 60）
 * 早就有值，但此前**只被显示、从未被执行**——判定链里没有任何一行用它。
 * 于是"五条并行"和"六十条并行"在网关侧完全一样，一个人就能把整档容量占住。
 */
import { describe, expect, it } from 'vitest'
import { createConcurrencyGuard } from '../src/concurrency.ts'

describe('并发上限执行器', () => {
  it('未达上限时放行', () => {
    const guard = createConcurrencyGuard()
    const slot = guard.acquire('a', 2)
    expect(slot.ok).toBe(true)
    expect(guard.inFlightOf('a')).toBe(1)
  })

  it('达到上限时拒绝，并说明具体数字', () => {
    const guard = createConcurrencyGuard()
    expect(guard.acquire('a', 2).ok).toBe(true)
    expect(guard.acquire('a', 2).ok).toBe(true)
    const third = guard.acquire('a', 2)
    expect(third.ok).toBe(false)
    if (!third.ok) {
      expect(third.message).toContain('2')
      // 拒绝理由必须说明这是**刹车**而不是故障，否则用户会以为产品坏了。
      expect(third.message).toContain('刹车')
    }
  })

  it('释放后可以再次放行（不会越用越紧）', () => {
    const guard = createConcurrencyGuard()
    const first = guard.acquire('a', 1)
    expect(first.ok).toBe(true)
    expect(guard.acquire('a', 1).ok).toBe(false)
    if (first.ok) first.release()
    expect(guard.inFlightOf('a')).toBe(0)
    expect(guard.acquire('a', 1).ok).toBe(true)
  })

  it('重复释放不会把计数减成负数', () => {
    const guard = createConcurrencyGuard()
    const slot = guard.acquire('a', 2)
    expect(slot.ok).toBe(true)
    if (slot.ok) {
      slot.release()
      slot.release()
      slot.release()
    }
    expect(guard.inFlightOf('a')).toBe(0)
    // 计数没被减成负值，所以两个位置仍然都在。
    expect(guard.acquire('a', 2).ok).toBe(true)
    expect(guard.acquire('a', 2).ok).toBe(true)
    expect(guard.acquire('a', 2).ok).toBe(false)
  })

  it('账户之间互不影响（一个人占满不牵连别人）', () => {
    const guard = createConcurrencyGuard()
    expect(guard.acquire('a', 1).ok).toBe(true)
    expect(guard.acquire('a', 1).ok).toBe(false)
    expect(guard.acquire('b', 1).ok).toBe(true)
    expect(guard.inFlightOf('a')).toBe(1)
    expect(guard.inFlightOf('b')).toBe(1)
    expect(guard.inFlightOf('c')).toBe(0)
  })

  it('多个并发位各自独立归还', () => {
    const guard = createConcurrencyGuard()
    const slots = [guard.acquire('a', 3), guard.acquire('a', 3), guard.acquire('a', 3)]
    expect(guard.inFlightOf('a')).toBe(3)
    expect(guard.acquire('a', 3).ok).toBe(false)
    const middle = slots[1]
    if (middle !== undefined && middle.ok) middle.release()
    expect(guard.inFlightOf('a')).toBe(2)
    expect(guard.acquire('a', 3).ok).toBe(true)
  })
})

describe('后端容量与进程总闸：保护的是我们自己的可用性', () => {
  it('后端容量满了以后拒绝，并说明"不是你的额度问题"', () => {
    const guard = createConcurrencyGuard()
    expect(guard.acquireBackend('flash', 2).ok).toBe(true)
    expect(guard.acquireBackend('flash', 2).ok).toBe(true)
    const third = guard.acquireBackend('flash', 2)
    expect(third.ok).toBe(false)
    if (!third.ok) {
      // 措辞很重要：用户不该以为是自己被限流了，这是我们保护上游连接。
      expect(third.message).toContain('不是你的额度问题')
    }
  })

  it('不同后端各自计数（一个后端满了不影响另一个）', () => {
    const guard = createConcurrencyGuard()
    expect(guard.acquireBackend('flash', 1).ok).toBe(true)
    expect(guard.acquireBackend('flash', 1).ok).toBe(false)
    expect(guard.acquireBackend('pro', 1).ok).toBe(true)
    expect(guard.backendInFlightOf('flash')).toBe(1)
    expect(guard.backendInFlightOf('pro')).toBe(1)
  })

  it('后端计数与账户计数互不干扰（键空间分开）', () => {
    const guard = createConcurrencyGuard()
    guard.acquire('acc-1', 5)
    guard.acquireBackend('flash', 5)
    // 账户位不该被算成后端位，否则一个账户就能吃掉后端容量。
    expect(guard.inFlightOf('acc-1')).toBe(1)
    expect(guard.backendInFlightOf('flash')).toBe(1)
    expect(guard.backendInFlightOf('acc-1')).toBe(0)
  })

  it('后端位归还后可以再占（不会越用越紧）', () => {
    const guard = createConcurrencyGuard()
    const first = guard.acquireBackend('flash', 1)
    expect(first.ok).toBe(true)
    expect(guard.acquireBackend('flash', 1).ok).toBe(false)
    if (first.ok) first.release()
    expect(guard.backendInFlightOf('flash')).toBe(0)
    expect(guard.acquireBackend('flash', 1).ok).toBe(true)
  })

  it('进程总闸跨账户生效（否则多账户能一起把上游打爆）', () => {
    const guard = createConcurrencyGuard()
    expect(guard.acquireGlobal(2).ok).toBe(true)
    expect(guard.acquireGlobal(2).ok).toBe(true)
    const third = guard.acquireGlobal(2)
    expect(third.ok).toBe(false)
    expect(guard.totalInFlight()).toBe(2)
  })

  it('总闸与账户/后端位是三个独立键空间', () => {
    const guard = createConcurrencyGuard()
    guard.acquire('a', 10)
    guard.acquireBackend('flash', 10)
    guard.acquireGlobal(10)
    expect(guard.inFlightOf('a')).toBe(1)
    expect(guard.backendInFlightOf('flash')).toBe(1)
    expect(guard.totalInFlight()).toBe(1)
  })

  it('重复释放后端位与总闸位也不会变负', () => {
    const guard = createConcurrencyGuard()
    const backend = guard.acquireBackend('flash', 2)
    const global = guard.acquireGlobal(2)
    if (backend.ok) { backend.release(); backend.release() }
    if (global.ok) { global.release(); global.release() }
    expect(guard.backendInFlightOf('flash')).toBe(0)
    expect(guard.totalInFlight()).toBe(0)
    expect(guard.acquireBackend('flash', 2).ok).toBe(true)
    expect(guard.acquireGlobal(2).ok).toBe(true)
  })

  it('默认后端容量远低于上游公布的账号级容量（不做尖峰放大器）', async () => {
    const { DEFAULT_BACKEND_STREAM_CAP } = await import('../src/concurrency.ts')
    const { BACKENDS } = await import('../src/tiers.ts')
    // 拍脑袋写死一个接近 2500 的值，等于把上游连接数在尖峰时瞬间拉满。
    expect(DEFAULT_BACKEND_STREAM_CAP).toBeLessThan(BACKENDS['flash']!.concurrency / 10)
    expect(DEFAULT_BACKEND_STREAM_CAP).toBeGreaterThan(0)
  })
})
