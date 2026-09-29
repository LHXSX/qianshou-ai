/**
 * 对话滚动管理的测试。
 *
 * 这些用例锁的是**用户体验契约**，不是实现细节：
 * 用户往上读历史时不能被拽回底部；用户发出消息时必须给到底；
 * 流式增长时要在跟随与不打扰之间切换正确。
 */
import { describe, expect, it } from 'vitest'
import {
  FOLLOW_THRESHOLD_PX, ScrollFollower, distanceFromBottom, isNearBottom,
  scrollToBottom, shouldOfferJumpToBottom, type ScrollMetrics,
} from '../src/scroll.ts'

/** 造一个度量：内容高度、视口高度、当前滚动位置。 */
function metrics(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollMetrics {
  return { scrollTop, scrollHeight, clientHeight }
}

/** 已经停在底部的容器。 */
const atBottom = (): ScrollMetrics => metrics(900, 1500, 600)

describe('距底部判定', () => {
  it('恰好在底部时距离为 0', () => {
    expect(distanceFromBottom(atBottom())).toBe(0)
  })

  it('内容不足一屏时距离为 0，不出现负数', () => {
    expect(distanceFromBottom(metrics(0, 300, 600))).toBe(0)
  })

  it('阈值内算作"在底部附近"', () => {
    expect(isNearBottom(metrics(860, 1500, 600))).toBe(true)   // 距底 40
    expect(isNearBottom(metrics(860, 1500, 600), FOLLOW_THRESHOLD_PX)).toBe(true)
  })

  it('超出阈值算作"在看历史"', () => {
    expect(isNearBottom(metrics(400, 1500, 600))).toBe(false)  // 距底 500
  })

  it('阈值用"附近"而不是等号——手机上惯性滚动很少正好停在底部', () => {
    // 差 30px 时应当仍算在底部，否则跟随几乎永远不生效
    expect(isNearBottom(metrics(870, 1500, 600))).toBe(true)
  })
})

describe('跟随状态机', () => {
  it('初始跟随，内容增长时应当滚到底', () => {
    const follower = new ScrollFollower()
    expect(follower.isFollowing()).toBe(true)
    expect(follower.shouldFollow()).toBe(true)
  })

  it('用户往上滑之后停止跟随（这是最关键的一条：不打扰阅读）', () => {
    const follower = new ScrollFollower()
    follower.onScroll(metrics(200, 1500, 600))
    expect(follower.isFollowing()).toBe(false)
    expect(follower.shouldFollow()).toBe(false)
  })

  it('用户滑回底部后恢复跟随', () => {
    const follower = new ScrollFollower()
    follower.onScroll(metrics(200, 1500, 600))
    follower.onScroll(atBottom())
    expect(follower.isFollowing()).toBe(true)
  })

  it('发出消息时无条件恢复跟随（唯一不经滚动的重置入口）', () => {
    const follower = new ScrollFollower()
    follower.onScroll(metrics(200, 1500, 600))
    expect(follower.isFollowing()).toBe(false)
    follower.jumpToBottom()
    expect(follower.isFollowing()).toBe(true)
  })

  it('程序性滚动不会把自己关掉', () => {
    const follower = new ScrollFollower()
    follower.beginProgrammatic()
    // 自动滚动途中浏览器报告的中间位置看起来像"用户滑上去"，不能据此停止跟随
    follower.onScroll(metrics(300, 1500, 600))
    expect(follower.isFollowing()).toBe(true)
    follower.endProgrammatic()
  })

  it('程序性滚动结束后，用户的真实滚动重新生效', () => {
    const follower = new ScrollFollower()
    follower.beginProgrammatic()
    follower.onScroll(metrics(300, 1500, 600))
    follower.endProgrammatic()
    follower.onScroll(metrics(200, 1500, 600))
    expect(follower.isFollowing()).toBe(false)
  })

  it('流式增长期间保持跟随，除非用户干预', () => {
    const follower = new ScrollFollower()
    // 模拟流式：内容不断变高，每次都滚到底
    for (let grow = 1500; grow <= 1800; grow += 100) {
      const current = metrics(grow - 600, grow, 600)
      follower.onScroll(current)
      expect(follower.shouldFollow()).toBe(true)
    }
    // 用户上滑一次，从此不再跟随
    follower.onScroll(metrics(300, 1800, 600))
    expect(follower.shouldFollow()).toBe(false)
  })
})

describe('滚动动作', () => {
  it('滚到底把 scrollTop 设为内容高度', () => {
    const element = { scrollTop: 100, scrollHeight: 1500 }
    scrollToBottom(element)
    expect(element.scrollTop).toBe(1500)
  })

  it('没有可滚动空间时也是安全的空操作', () => {
    const element = { scrollTop: 0, scrollHeight: 0 }
    expect(() => scrollToBottom(element)).not.toThrow()
    expect(element.scrollTop).toBe(0)
  })
})

describe('回到底部按钮的显示判据', () => {
  it('已滚出一屏以上且不在底部时建议显示', () => {
    expect(shouldOfferJumpToBottom(metrics(100, 3000, 600))).toBe(true)
  })

  it('在底部附近时不显示，避免遮挡内容', () => {
    expect(shouldOfferJumpToBottom(atBottom())).toBe(false)
  })

  it('内容只滚出一点时也不显示', () => {
    // 距底 500 但只超出一屏 100，说明内容本身不长，不需要按钮
    expect(shouldOfferJumpToBottom(metrics(0, 1100, 600))).toBe(false)
  })
})
