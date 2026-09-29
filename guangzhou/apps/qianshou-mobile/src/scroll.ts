/**
 * 对话滚动管理：决定"什么时候该自动跟到底，什么时候必须让用户安静地读"。
 *
 * ## 为什么不能简单地每次都滚到底
 * 流式回复期间内容在不断变高。如果无条件滚到底，用户往上看历史时会被**反复拽回**
 * 底部——比不动更烦人。反过来，如果只在发送时滚一次，回复变长后新内容就跑到屏幕外，
 * 用户得手动滑轮（这正是本次要修的 bug）。
 *
 * 所以判据是**用户意图**：
 * - 用户本来就在底部附近 → 内容增长时跟着走
 * - 用户主动往上滑 → 停止跟随，直到他自己滑回底部
 * - 用户刚发出消息 → 无条件跳到底（这是他明确的意图）
 *
 * 判定用"距底部阈值"而不是"是否恰好等于底部"：手机上惯性滚动的收尾位置很少严丝合缝，
 * 用等号判定会导致大多数情况下都判定为"用户在看历史"，跟随就永远不生效。
 */

/** 距底部多少像素以内仍算"在底部"。取一屏内约一行半的高度，容得下惯性滚动误差。 */
export const FOLLOW_THRESHOLD_PX = 48

/** 一个可滚动的容器需要暴露的最小能力；便于测试与复用。 */
export interface ScrollMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** 距底部的像素数；内容不足一屏时为 0。 */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

/** 当前是否在底部附近（应当跟随）。 */
export function isNearBottom(metrics: ScrollMetrics, threshold: number = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold
}

/**
 * 滚动跟随状态机。
 *
 * 与 DOM 解耦：调用方把度量喂进来、把动作取出去，因此可以在没有浏览器的环境里
 * 把"用户滑上去就不再跟随"这类行为完整测到。
 */
export class ScrollFollower {
  private following = true
  /** 程序性滚动进行中：此时收到的 scroll 事件不算"用户意图"。 */
  private programmatic = false

  /** 当前是否处于跟随状态。 */
  isFollowing(): boolean {
    return this.following
  }

  /**
   * 处理一次滚动事件。
   *
   * 只有**用户自己**的滚动才改变跟随状态；程序性滚动不能把自己关掉，
   * 否则第一次自动滚动之后跟随就永久失效了。
   * @param metrics - 容器当前的滚动度量。
   * @param threshold - 判定"在底部附近"的像素阈值。
   * @returns 是否处于跟随状态。
   */
  onScroll(metrics: ScrollMetrics, threshold: number = FOLLOW_THRESHOLD_PX): boolean {
    if (this.programmatic) return this.following
    this.following = isNearBottom(metrics, threshold)
    return this.following
  }

  /**
   * 内容增长后是否需要滚到底。
   * @returns 需要滚动时为 true。
   */
  shouldFollow(): boolean {
    return this.following
  }

  /**
   * 用户刚发出消息：无条件恢复跟随。
   *
   * 这是唯一"不经用户滚动就重置跟随"的入口——发送是他明确的意图。
   */
  jumpToBottom(): void {
    this.following = true
  }

  /** 标记即将执行一次程序性滚动；紧随其后的那次 `onScroll` 不计入用户意图。 */
  beginProgrammatic(): void {
    this.programmatic = true
  }

  /** 程序性滚动结束（或该次滚动未触发事件时）复位标记。 */
  endProgrammatic(): void {
    this.programmatic = false
  }
}

/** 把元素滚到底；没有可滚动空间时是安全的空操作。 */
export function scrollToBottom(element: { scrollTop: number; scrollHeight: number }): void {
  element.scrollTop = element.scrollHeight
}

/**
 * 一个"是否显示回到底部按钮"的判据。
 * @param metrics - 容器度量。
 * @param threshold - 与跟随判定保持一致的阈值。
 * @returns 内容已滚出一屏以上且用户不在底部时，建议显示按钮。
 */
export function shouldOfferJumpToBottom(metrics: ScrollMetrics, threshold: number = FOLLOW_THRESHOLD_PX): boolean {
  return !isNearBottom(metrics, threshold) && distanceFromBottom(metrics) > metrics.clientHeight
}
