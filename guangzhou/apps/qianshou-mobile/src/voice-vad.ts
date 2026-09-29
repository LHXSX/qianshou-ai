/**
 * 端点检测（VAD）：**替用户按下那个"停"**。
 *
 * 手机上每一次触摸都很贵。上一轮做的是「按一下开始录 → 再按一下结束」，用户得记住再点
 * 一次，还得自己判断"我说完了没有"。大厂的语音输入是说完自己收尾——少一个动作就顺一截。
 *
 * 但"自己收尾"是替用户做决定，而做错有两个方向，代价完全不一样：
 *
 * - **收早了**（把半句话切掉）：用户说的话丢了，必须重说一遍，还可能以为功能坏了；
 * - **收晚了**（多等两三百毫秒）：无感。
 *
 * 所以整条策略都往"晚"偏：阈值取 1.5~2 秒里的上半区、说话期间计时不断被重置、
 * 收尾前先给可见倒计时（用户一出声就能把它取消），并且**随时可以手动按停**。
 *
 * 判定只看一件事：**最近一次"听到任何声音"到现在过了多久**。计时从按下按钮那一刻起
 * 就开始——所以"一句话都没说"会在同一个阈值上收尾；那种情况不该发转写请求，
 * 由 `voice.ts` 负责区别处置。
 *
 * 这一层是纯逻辑：不碰计时器、不碰麦克风、不碰界面，`tick(level, now)` 由外面按时喂。
 * 这样"为什么在这个时刻收尾"可以被单独算清楚、单独测。
 */

/** 端点判定的参数；全部可注入，全部有默认值。 */
export interface VadConfig {
  /**
   * 静默多久算"说完了"（毫秒）。
   *
   * 默认 1800：落在 1.5~2 秒这个区间的**上半区**，因为误切的代价比多等的代价大得多。
   * 这个值也是"什么都没说就收尾"的等待时长（见文件头：两者是同一把尺子）。
   */
  readonly silenceMs: number
  /**
   * 收尾前先提示多久（毫秒）。
   *
   * 默认 700：够用户看见倒计时并**出声把收尾取消**（一出声计时立刻重置），
   * 短于 500 就只剩"闪一下"，用户会觉得被抢话。
   */
  readonly warningMs: number
  /**
   * 多响才算"有人声"（原始 RMS，0..1）。
   *
   * 默认 0.03：说话通常在 0.05 以上，安静房间的底噪在 0.01 以下；0.03 卡在中间。
   * 真机上的底噪差别很大（手机的自动增益会把底噪一起抬起来），所以这个值必须可调——
   * 但它**不是**自适应噪声门，代码里没做那件事。
   */
  readonly speechLevel: number
  /**
   * 累计多久的有效人声才算"真的说了话"（毫秒）。
   *
   * 默认 200：挡住一声咳嗽、一次碰麦被当成"说过话了"（那会白跑一次转写）。
   * 偏小是有意的——偏差方向选"宁可多发一次空转写，也不丢掉用户真说的话"：
   * 前者的代价是宿主回一个 `no-speech`，后者是用户要重说一遍。
   */
  readonly minSpeechMs: number
  /**
   * 多久取一帧电平（毫秒）。
   *
   * 默认 100：10 Hz 对"看着它跳"足够，也更省电。这个值也决定了倒计时的刷新密度。
   */
  readonly tickMs: number
}

/** 出厂参数；改这些数字之前先读上面每条的理由。 */
export const VAD_DEFAULTS: VadConfig = Object.freeze({
  silenceMs: 1_800,
  warningMs: 700,
  speechLevel: 0.03,
  minSpeechMs: 200,
  tickMs: 100,
})

/**
 * 合并用户给的参数与默认值，并把几个会互相打架的值夹回合理范围。
 *
 * 夹的道理：
 * - `warningMs` 不能长过 `silenceMs`（否则一静下来就在提示"要收尾了"，等于一直举着刀）；
 * - `minSpeechMs` 同样不能长过 `silenceMs`（否则永远够不到"说过话"的门槛）；
 * - `tickMs` 给 10 毫秒下限，避免有人传 0 造出一个转不停的循环。
 * @param overrides - 只想改的那几项。
 * @returns 一份可以直接用的完整参数。
 */
export function vadConfigOf(overrides: Partial<VadConfig> = {}): VadConfig {
  const silenceMs = positive(overrides.silenceMs, VAD_DEFAULTS.silenceMs)
  return {
    silenceMs,
    warningMs: Math.min(positive(overrides.warningMs, VAD_DEFAULTS.warningMs), silenceMs),
    speechLevel: positive(overrides.speechLevel, VAD_DEFAULTS.speechLevel),
    minSpeechMs: Math.min(positive(overrides.minSpeechMs, VAD_DEFAULTS.minSpeechMs), silenceMs),
    tickMs: Math.max(10, positive(overrides.tickMs, VAD_DEFAULTS.tickMs)),
  }
}

/**
 * 一个值是不是可用的正数。
 * @param value - 用户传进来的值。
 * @param fallback - 不可用时用默认值兜住。
 * @returns 可用的正数。
 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 端点判定现在到了哪一档；界面按它决定显示什么。 */
export type VadPhase =
  /** 还没听到人声，还在等用户开口。 */
  | 'waiting'
  /** 听到过人声了，正在等下一句。 */
  | 'listening'
  /** 静默到点了，正在收尾倒计时——**这一档必须让用户看见**。 */
  | 'closing'

/** 一次判定的结果，会原样喂给界面。 */
export interface VadReading {
  /** 现在在哪一档。 */
  readonly phase: VadPhase
  /** 这次录音里到底有没有人声。收尾时靠它决定"发转写"还是"直接回空闲"。 */
  readonly heard: boolean
  /** 最近一次听到人声之后，静了多久（毫秒）。 */
  readonly silencedMs: number
  /** 距离收尾还剩多久（毫秒）；`closing` 之外也照实给，界面可以提前用它。 */
  readonly remainingMs: number
}

/** 喂一帧的结果。 */
export interface VadStep {
  /** 这一帧的判定，原样给界面。 */
  readonly reading: VadReading
  /** 该收尾了吗；一次录音里只会有一帧是 `true`。 */
  readonly end: boolean
}

/**
 * 端点判定器：喂电平，回答「该不该收尾了」。
 *
 * 有状态但**不自己看时钟**：`now` 由外面传进来，所以测试可以拿一串虚构的时间走完
 * 整条判定，不需要等真实的时间流逝。
 */
export class VoiceEndpointer {
  private readonly config: VadConfig
  private lastVoiceAt: number
  private lastTickAt: number
  private voicedMs = 0
  private heard = false
  private ended = false

  /**
   * @param config - 合并好的参数（用 `vadConfigOf`）。
   * @param startedAt - 开始录音的时刻；静默从这一刻起算。
   */
  constructor(config: VadConfig, startedAt: number) {
    this.config = config
    this.lastVoiceAt = startedAt
    this.lastTickAt = startedAt
  }

  /**
   * 喂一帧电平。
   * @param level - 这一帧的原始 RMS（0..1），来自 `voice-meter.ts`。
   * @param now - 当前时刻（毫秒，单调）。
   * @returns 这一帧的判定与是否该收尾。
   */
  tick(level: number, now: number): VadStep {
    const delta = Math.max(0, now - this.lastTickAt)
    this.lastTickAt = now
    if (!this.ended && level >= this.config.speechLevel) {
      // 只要有任何一帧够响，"最近说过话"就往现在挪——说话中间的换气、想词都算在这里，
      // 所以正常人停顿不会被误切；只有真的静下来才继续累计。
      this.lastVoiceAt = now
      this.voicedMs += delta
      if (this.voicedMs >= this.config.minSpeechMs) this.heard = true
    }
    const silencedMs = Math.max(0, now - this.lastVoiceAt)
    const remainingMs = Math.max(0, this.config.silenceMs - silencedMs)
    const closing = silencedMs >= this.config.silenceMs - this.config.warningMs
    const end = !this.ended && silencedMs >= this.config.silenceMs
    if (end) this.ended = true
    return {
      reading: {
        phase: closing ? 'closing' : this.heard ? 'listening' : 'waiting',
        heard: this.heard,
        silencedMs,
        remainingMs,
      },
      end,
    }
  }
}

/**
 * 把判定结果翻成界面上那一句话；不该有提示时返回 `null`。
 *
 * 为什么非要有这句话：自动收尾是**替用户做的决定**，一声不响地断掉，用户的感觉是
 * "它把我打断了"。先说一句"好像说完了…"，再给一个还在往下走的秒数，同一个动作就从
 * "被抢话"变成"它在等我"。而且这段时间里用户只要重新出声，倒计时就取消了。
 * @param reading - 这一帧的判定。
 * @returns 直接展示的一句话；不需要提示时是 `null`。
 */
export function vadHint(reading: VadReading): string | null {
  if (reading.phase !== 'closing') return null
  const seconds = (Math.max(0, reading.remainingMs) / 1_000).toFixed(1)
  return reading.heard
    ? `好像说完了… ${seconds}s 后自动结束`
    : `还没听到声音… ${seconds}s 后停下`
}
