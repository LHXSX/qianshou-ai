/**
 * 录音时的实时电平：把「麦克风现在有多响」变成界面能画的数字。
 *
 * 为什么需要它：用户按下麦克风之后，界面上如果只有一句"正在听…"，他能做的只有等——
 * 不知道自己有没有被听见、是不是离得太远、该不该再说一遍。大厂的语音输入都在这段
 * 等待里给实时反馈，靠的就是 `AnalyserNode` 拿到的那点时域样本。
 *
 * 这一层**只做取样**，不碰录音链路：既不决定什么时候停（那是 `voice-vad.ts` 的事），
 * 也不产生任何请求。它拿不到分析器时（老浏览器、Web Audio 被系统限制、jsdom 这类
 * 没有 Web Audio 的环境）返回 `null`，调用方退回纯文字状态——**反馈可以没有，
 * 录音不能因此坏掉**。
 *
 * 隐私：样本只在内存里算一个 RMS 就丢掉，不落盘、不上传。取样用的音频上下文由调用方
 * 负责关闭（见 `VoiceMeter.close`），不关的话麦克风的输入节点会一直挂在那里。
 */

/** 电平条画几段。理由见 `voice-note-view.tsx`：窄屏上再多就分不出起伏了。 */
export const METER_BARS = 5

/**
 * 一帧取多少个样本：`AnalyserNode.fftSize` 也设成这个值（模块内部用，不外传）。
 *
 * 1024 个样本在 48 kHz 下约 21 毫秒——够长到不会被单个采样点的抖动带偏，
 * 又短到能跟上说话的节奏。取 2048 以上会让电平条变"钝"，看不出停顿。
 */
const METER_SAMPLES = 1024

/**
 * 显示曲线的增益（模块内部用，不外传）。
 *
 * 说话时的 RMS 大约在 0.05~0.3，安静房间更低；**直接乘上去画，条子长期趴在底部**，
 * 看着像没在工作。乘 3 再开平方（见 `displayLevel`）把低声压抬起来。
 */
const DISPLAY_GAIN = 3

/** 一帧电平；两个值都来自同一批样本。 */
export interface MeterFrame {
  /**
   * 整帧的原始 RMS，0..1。
   *
   * **没经过显示曲线**——端点检测拿它跟阈值比，那边要的是真实响度，不是给眼睛调过的。
   */
  readonly level: number
  /**
   * 分成 `METER_BARS` 段的 RMS，0..1，**已经过显示曲线与衰减平滑**。
   * 界面直接拿它当每段的高度用。
   */
  readonly bars: readonly number[]
}

/**
 * 一段样本的响度（RMS）。
 *
 * 用 RMS 而不是峰值：峰值被一次咳嗽、一次碰麦就顶满，跟着它跳的条子会一惊一乍；
 * RMS 更接近"人耳听到的音量"。
 * @param samples - -1..1 的样本。
 * @param from - 起点（含）。
 * @param to - 终点（不含）；越界会被夹回样本范围内。
 * @returns 0..1 的响度；空段返回 0。
 */
export function rmsLevel(samples: Float32Array, from = 0, to: number = samples.length): number {
  const start = Math.max(0, Math.min(samples.length, Math.floor(from)))
  const end = Math.max(start, Math.min(samples.length, Math.floor(to)))
  if (end <= start) return 0
  let sum = 0
  for (let i = start; i < end; i++) {
    const value = samples[i] ?? 0
    sum += value * value
  }
  return Math.sqrt(sum / (end - start))
}

/**
 * 把原始 RMS 映射成给眼睛看的 0..1。
 *
 * 开平方而不是线性：人耳对响度的感受本来就更接近对数，平方根这一档正好把"小声说话"
 * 从贴着底部的几个像素抬到看得见的高度，同时满幅的喊声仍然收在 1 以内。
 * @param rms - 原始 RMS。
 * @returns 0..1；非正数一律给 0（不能让 `NaN` 漏进样式里）。
 */
export function displayLevel(rms: number): number {
  if (!(rms > 0)) return 0
  return Math.min(1, Math.sqrt(rms * DISPLAY_GAIN))
}

/**
 * 一帧样本 → 整帧响度 + 每段响度。
 *
 * 纯函数，不碰任何浏览器接口：`createVoiceMeter` 拿它把样本变成数字，测试拿它单独
 * 验算（见 `tests/voice-endpoint.spec.ts`）。
 * @param samples - -1..1 的时域样本。
 * @param barCount - 分几段。
 * @returns 未经过显示曲线的原始值。
 */
export function frameOf(samples: Float32Array, barCount: number = METER_BARS): MeterFrame {
  const count = Math.max(1, Math.floor(barCount))
  const bars: number[] = []
  for (let index = 0; index < count; index++) {
    bars.push(rmsLevel(samples, Math.floor(samples.length * index / count), Math.floor(samples.length * (index + 1) / count)))
  }
  return { level: rmsLevel(samples), bars }
}

/** 一次录音的实时电平表。 */
export interface VoiceMeter {
  /**
   * 读当前一帧。
   * @returns 电平；分析器已经关掉或读不出来时是 `null`（调用方这一帧就不判、不画）。
   */
  readonly read: () => MeterFrame | null
  /** 断开取样并关掉这个音频上下文。可以重复调用。 */
  readonly close: () => void
}

/**
 * 每帧的衰减系数：新值比上一帧低时，按这个比例往下走。
 *
 * 音频每 100 毫秒才取一帧，而每一帧都是那一瞬间的独立采样：不做平滑的话条子会在
 * 随机高度之间乱跳，看着像坏了。这里攻上去是即时的（听到就是听到），落下来留一点痕
 * ——和硬件的电平表一个路子。
 */
const RELEASE = 0.5

/**
 * 给一条活的麦克风流装一个电平表。
 *
 * 每一个可能失败的动作（建上下文、建分析器、连节点、读样本）都就地兜住并返回 `null`：
 * 实时反馈是**锦上添花**，它失败不能把录音带坏。这也是降级路径唯一需要做的事——
 * 调用方见到 `null` 就退回文字（见 `voice.ts` 的录音主体）。
 * @param stream - `getUserMedia` 拿到的流。
 * @param AudioCtor - 音频上下文构造器；没有就是拿不到（例如 jsdom）。
 * @param barCount - 分几段。
 * @returns 电平表；拿不到就是 `null`。
 */
export function createVoiceMeter(
  stream: MediaStream,
  AudioCtor: typeof AudioContext | undefined,
  barCount: number = METER_BARS,
): VoiceMeter | null {
  if (AudioCtor === undefined || AudioCtor === null) return null
  const samples = new Float32Array(METER_SAMPLES)
  const last = new Array<number>(Math.max(1, Math.floor(barCount))).fill(0)
  let audio: AudioContext | undefined
  let analyser: AnalyserNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  try {
    audio = new AudioCtor()
    analyser = audio.createAnalyser()
    analyser.fftSize = METER_SAMPLES
    source = audio.createMediaStreamSource(stream)
    source.connect(analyser)
  } catch {
    closeQuietly(audio, source, analyser)
    return null
  }
  const ready = { audio, analyser, source }
  let closed = false
  return {
    read(): MeterFrame | null {
      if (closed) return null
      try {
        ready.analyser.getFloatTimeDomainData(samples)
      } catch {
        // 分析器在录音途中坏掉（设备被拔掉、上下文被挂起）：这一帧没有数据，
        // 返回 null 让调用方跳过这一帧，而不是拿上一帧的值继续判。
        return null
      }
      const frame = frameOf(samples, barCount)
      const bars = frame.bars.map((value, index) => {
        const shown = Math.max(displayLevel(value), (last[index] ?? 0) * RELEASE)
        last[index] = shown
        return shown
      })
      return { level: frame.level, bars }
    },
    close(): void {
      if (closed) return
      closed = true
      closeQuietly(ready.audio, ready.source, ready.analyser)
    },
  }
}

/**
 * 关掉取样用的一切，**任何一步失败都不往外抛**。
 *
 * 收尾路径（用户按停、取消、组件卸载、麦克风被拔掉）都会走到这里，其中一条抛出异常
 * 就会让后面的 `stopTracks()` 轮不到执行——录音指示灯会一直亮着。
 * @param audio - 这次取样自己的音频上下文。
 * @param source - 麦克风输入节点。
 * @param analyser - 分析器节点。
 */
function closeQuietly(
  audio: AudioContext | undefined,
  source: MediaStreamAudioSourceNode | undefined,
  analyser: AnalyserNode | undefined,
): void {
  try { source?.disconnect() } catch { /* 没连上或已经断开 */ }
  try { analyser?.disconnect() } catch { /* 同上 */ }
  try { if (audio !== undefined) void audio.close().catch(() => { /* 关不掉不影响结果 */ }) } catch { /* 同上 */ }
}
