/**
 * 语音提示行：麦克风图标 + **跟着声音跳的电平条** + 一句话。
 *
 * 为什么单独一个文件：这一行是语音输入唯一的"看得见的部分"，把它从 3000 行的
 * `App.tsx` 里拿出来，才好在测试里拿真实数据渲染它（见 `tests/voice-endpoint.spec.ts`
 * 的界面用例），而不是只测 hook 里的数字。
 *
 * 电平条为什么是这个形状（手机窄屏上的取舍）：
 *
 * - **竖条 5 段，不是一整条波形**：这一段只有一行提示的高度（约 16px），横着挤在
 *   输入框上面。整条波形在 46px 宽里会糊成一片；5 段是"还能看出起伏"的下限，
 *   再多就只剩一团抖动的噪声。
 * - **不用 canvas**：canvas 在 jsdom 里没有上下文，等于这一块没法验收；而且每 100
 *   毫秒画一次 canvas，在这点面积上并不比改几个 `style.height` 省。用元素画还能被
 *   DOM 断言真的在动。
 * - **不给屏幕阅读器读**：它每秒变十次，读出来只会是噪声。整行真正的意思由文字承担，
 *   所以电平条是 `aria-hidden`。
 * - **不做动画**：手机上闪动的红点更像在报错；"在响"这件事由条子的高度自己说。这也是
 *   上一轮给 `.composer-mic.rec` 定下的调子（见 styles.css）。
 */
import type { ReactElement } from 'react'
import * as I from './icons.tsx'

/** 静音时条子的高度：留一点底，用户才知道"这里本来有东西，只是现在没声"。 */
const BAR_BASE = 3
/** 条子的行程：满幅 16px 总高，正好和这一行文字的行高对齐，不撑高整行。 */
const BAR_TRAVEL = 13

/** 提示行要画的东西。 */
export interface VoiceNoteRowProps {
  /** 那一行字；`null` 时整行不渲染（和上一轮的行为一致，不留空行）。 */
  readonly note: string | null
  /** 实时电平，每段 0..1；**空数组就只显示文字**（拿不到实时反馈时的降级）。 */
  readonly bars: readonly number[]
  /** 录音中：整行变蓝，"麦克风开着"在余光里也看得见。 */
  readonly recording: boolean
  /** 正在自动收尾倒计时：整行换成提醒色，让"它马上要停了"看得见。 */
  readonly closing: boolean
  /**
   * 苹果那条路的中间结果（`isFinal === false`）：**当前这句话的最新全貌**。
   *
   * 每次都是整段替换，所以它单独占一行、跟着换字——看起来是一句话在长出来。
   * 空白或没传就整块不渲染，排版和这一行原来一模一样。
   */
  readonly interim?: string | null
}

/**
 * 渲染语音提示行。
 * @param props - 文案、电平、当前是什么状态、以及正在长出来的那句话。
 * @returns 整行元素；没有话要说时是 `null`。
 */
export function VoiceNoteRow({ note, bars, recording, closing, interim }: VoiceNoteRowProps): ReactElement | null {
  if (note === null) return null
  const partial = interim === undefined || interim === null || interim.trim().length === 0 ? null : interim
  const className = `voice-note${recording ? ' listening' : ''}${closing ? ' closing' : ''}${partial === null ? '' : ' interim'}`
  return (
    <p className={className} role="status">
      <I.IcoMic />
      {bars.length > 0 && (
        <span className="voice-meter" aria-hidden="true">
          {bars.map((value, index) => (
            <i key={index} style={{ height: `${Math.round(BAR_BASE + clamp01(value) * BAR_TRAVEL)}px` }} />
          ))}
        </span>
      )}
      <span>{note}</span>
      {partial !== null && <span className="voice-interim">{partial}</span>}
    </p>
  )
}

/**
 * 把电平夹进 0..1。
 *
 * 电平来自浏览器接口，不是我们能担保的输入：`NaN` 或越界值漏进样式里，条子会变成
 * 一片空白或撑破这一行，而且看不出是我们算错了。
 * @param value - 一段电平。
 * @returns 0..1 之间的数。
 */
function clamp01(value: number): number {
  if (!(value > 0)) return 0
  return value > 1 ? 1 : value
}
