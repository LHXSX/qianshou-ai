/** U1「正在努力跑」的小猫动画：6 帧循环、每帧 90ms；减少动效下退成静态首帧。 */
import { useEffect, useState } from 'react'
import { CAT_FRAMES, CAT_FRAME_COUNT, CAT_FRAME_MS } from './cat-frames.ts'

/** 动画参数。 */
export interface RunningCatProps {
  /** 每帧毫秒数，默认素材自带的 90ms。 */
  readonly frameMs?: number
  /** 显示边长（px）；宽高同值，绝不拉伸变形。 */
  readonly size?: number
  /** 减少动效开关；不传就自己看 `prefers-reduced-motion: reduce`。 */
  readonly reducedMotion?: boolean
}

/**
 * 主人偏好：减少动效。
 * @returns 需要静态首帧时为 `true`。
 */
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/**
 * 跑步小猫。
 * @param props - 帧长、尺寸与减少动效开关。
 * @returns 一帧图像；减少动效时永远停在首帧。
 */
export function RunningCat({ frameMs = CAT_FRAME_MS, size = 18, reducedMotion }: RunningCatProps) {
  const reduced = reducedMotion ?? prefersReducedMotion()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (reduced) {
      setFrame(0)
      return undefined
    }
    const timer = setInterval(() => { setFrame(previous => (previous + 1) % CAT_FRAME_COUNT) }, frameMs)
    return () => { clearInterval(timer) }
  }, [frameMs, reduced])
  return (
    <span
      className="dsh-qianshou-cat"
      data-node-cat
      data-cat-frame={frame}
      data-cat-motion={reduced ? 'reduced' : 'full'}
      style={{ width: `${String(size)}px`, height: `${String(size)}px` }}
    >
      <img src={CAT_FRAMES[frame] ?? CAT_FRAMES[0]} width={size} height={size} alt="" aria-hidden="true" />
    </span>
  )
}
