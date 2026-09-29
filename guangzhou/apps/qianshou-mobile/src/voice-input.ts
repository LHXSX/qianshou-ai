/**
 * 输入框里的语音输入：**按一下开始听，再按一下停下**，识别结果填进输入框。
 *
 * 三个刻意的选择：
 *
 * 1. **识别结果只填进输入框，绝不自动发送。** 识别错一个字就发出去，比多按一下
 *    发送按钮的代价大得多——手机上本来就要确认一眼。
 * 2. **按一下开始、再按一下停下**，不用"按住不放"。长按在手机上会和页面滚动、
 *    系统手势抢事件，是不可靠的交互。
 * 3. **按钮一直在**，不能用的时候（http 下、遥控形态下）按钮变灰并说明原因。
 *    直接藏掉的话，用户只会以为这个功能从来没做过——而真正的原因（协议不对、
 *    页面不是工作台提供的）本来是可以修的。
 *
 * 至于**走哪条路**：由 `voice-apple.ts` 的 `voiceRouteOf` 决定——苹果自带那条
 * （浏览器 Web Speech API，能流式出字、不依赖电脑）优先，宿主 whisper 那条兜底。
 * 取舍的每一条理由都写在那个函数上，这一层只管按决定调对应的会话。
 *
 * 录音发到哪台电脑：**只有宿主那条路**会把音频发出去，发的是**工作台自己那台电脑**
 * （转写在它本地跑）。这个页面如果不是工作台自己提供的（遥控/配对形态），
 * `voiceSupport()` 就返回 `remote-host`；但苹果那条路不依赖宿主，所以那种形态下
 * 它照样能用（见 `voiceRouteOf` 的说明）。
 */
import { useEffect, useRef, useState } from 'react'
import { startVoiceInput, type VoicePhase, type VoiceSession, type VoiceSupport } from './voice.ts'
import {
  appleSpeechSupport,
  startAppleSpeech,
  voiceRouteOf,
  type SpeechEnvironment,
  type VoiceRoute,
} from './voice-apple.ts'
import { vadHint, type VadConfig } from './voice-vad.ts'

/** 语音输入的界面状态。 */
export interface VoiceInputState {
  /** 现在处在哪一段：空闲 / 正在听 / 正在识别。 */
  readonly phase: VoicePhase
  /** 已经听了多少毫秒；界面用来说话时长。 */
  readonly elapsed: number
  /** 上一次失败要展示的那句话；没有就是 `null`。 */
  readonly error: string | null
  /** 能力不足时要说明的原因（http 下、遥控形态下）；能用时是 `null`。 */
  readonly blocked: string | null
  /**
   * 实时电平：每段一个 0..1，随声音跳动；界面拿它画电平条。
   *
   * **空数组 = 这次没有实时电平**（拿不到 `AudioContext`/分析器，或者走的是苹果那条路：
   * 那条路连麦克风都不由我们拿，也就没有我们自己的电平表）。空数组同时也是
   * "端点检测没装"的信号：那种情况下录音只能手动按停（苹果那条路是例外，它自己会停）。
   */
  readonly meter: readonly number[]
  /**
   * 自动收尾前的可见提示（"好像说完了… 0.4s 后自动结束"）；没有就是 `null`。
   *
   * 存在它就意味着**再不动手，下一秒就停了**——界面得让它看得见，否则用户会觉得被抢话。
   */
  readonly hint: string | null
  /**
   * 中间结果（`isFinal === false`）：**当前这句话的最新全貌**，没有就是 `null`。
   *
   * 界面拿它整段替换着显示（见 `voice-note-view.tsx`），所以看起来是一句话在长出来，
   * 而不是一截截往后接。**只有苹果那条路会给**：宿主那条是整段录完再上传，没有中间态。
   */
  readonly interim: string | null
  /** 这次会走哪条路；两条都不行时是 `'none'`。 */
  readonly route: VoiceRoute
  /** 这一次到底能不能语音输入（两条路任意一条通就算通）。按钮的可用性看它。 */
  readonly available: boolean
  /** 按一下：开始听，或停下并开始识别。 */
  readonly toggle: () => void
}

/** 语音输入要用到的东西。 */
export interface VoiceInputOptions {
  /** 当前草稿；识别结果追加在它后面，不覆盖用户已经打的字。 */
  readonly draft: string
  /** 把新草稿写回输入框。**只有这一步，没有"顺便发送"**。 */
  readonly onDraft: (value: string) => void
  /** 这台设备上**宿主那条路**（录音 → 上传给工作台）能不能用；见 `voice.ts`。 */
  readonly support: VoiceSupport
  /**
   * 苹果自带那条路的判决（`appleSpeechSupport()`）；不传就按环境自己算一次。
   *
   * 两种传法的差别只有一个：`App.tsx` 要拿它决定按钮的灰不灰（两条路任意一条通就该能点），
   * 所以那边算好传进来；测试只要注入一个替身构造器，让这一层自己算，走的就是生产判定。
   */
  readonly apple?: VoiceSupport
  /** 可注入的环境，便于测试；生产不传，走全局浏览器 API。 */
  readonly environment?: SpeechEnvironment
  /**
   * 端点检测的参数（静默阈值、提示时长等）；不传就用 `VAD_DEFAULTS`。
   * 见 `voice-vad.ts` 里每个默认值的理由。
   */
  readonly vad?: Partial<VadConfig>
  /**
   * 外部指定当前阶段，用来驱动「已经在录了」这一半的路径（例如点一下结束录音）。
   * 不传时阶段由 hook 自己管。生产不传：界面上真实的阶段只有一个来源。
   */
  readonly controlledPhase?: VoicePhase
  /**
   * 把本次会话交出去，让调用方也能停/取消；会话结束时回调 `null`。
   * 测试用来说明"用户按了取消"这条路径；生产不传。
   */
  readonly onSession?: (session: VoiceSession | null) => void
}

/**
 * 把「按一下说话」接成界面状态。
 *
 * 单独抽成 hook 而不是塞进 `Composer`：录音的生命周期（拿麦克风、超时、取消、
 * 卸载时释放）和输入框的渲染没有关系，混在一起两边都难测。
 * @param options - 草稿、回写函数、能力判定与环境注入。
 * @returns 阶段、时长、说明与切换函数。
 */
export function useVoiceInput(options: VoiceInputOptions): VoiceInputState {
  const { draft, onDraft, support, apple, environment, vad, controlledPhase, onSession } = options
  const [ownPhase, setOwnPhase] = useState<VoicePhase>('idle')
  const phase = controlledPhase ?? ownPhase
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [meter, setMeter] = useState<readonly number[]>([])
  const [hint, setHint] = useState<string | null>(null)
  const [interim, setInterim] = useState<string | null>(null)
  const session = useRef<VoiceSession | null>(null)
  const setPhase = setOwnPhase

  // 走哪条路：苹果自带那条优先，宿主 whisper 兜底（理由全在 `voiceRouteOf` 上）。
  // 这一步每次渲染都算一遍，因为它是一个纯函数，且能力只取决于环境——
  // 缓存反而会让"用户刚去系统设置里打开了 Siri"这种改动看不见。
  const route = voiceRouteOf(apple ?? appleSpeechSupport(environment ?? {}), support)
  const available = route.route !== 'none'

  /** 一次录音的界面状态全部收回：电平条、倒计时、中间结果、阶段是一件事的几个面，不能只清一个。 */
  const quiet = (): void => { setMeter([]); setHint(null); setInterim(null) }

  // 录音途中组件被卸载（切标签、返回）：必须把麦克风停掉，否则录音指示灯一直亮着。
  useEffect(() => () => { session.current?.cancel(); session.current = null }, [])

  const toggle = (): void => {
    if (phase === 'recording') {
      session.current?.stop()
      session.current = null
      // 苹果那条路是**本地**识别：说完了就地出字，没有"上传中"这一段，
      // 所以停完直接回空闲，让用户看到的不是一段不存在的等待。
      setPhase(route.route === 'apple' ? 'idle' : 'transcribing')
      return
    }
    if (phase === 'transcribing') return
    setError(null)
    setElapsed(0)
    quiet()
    // 一次会话期间输入框**只由这次会话写**，所以这里把起点钉下来：后面无论来多少中间结果、
    // 最后落到几个字，都是"`base` + 这次认出来的全部文字"。这样中间结果一次次重画也不会
    // 把同一句话接上好几遍（每次都用起点重算，不是在上一版后面接）。
    const base = draft.trimEnd()
    const join = (text: string): string => (base.length > 0 ? `${base} ${text}` : text)
    /** 两条路共用的落点：认得字就填进输入框（**不发送**），失败就说明白了。 */
    const land = {
      onElapsed: setElapsed,
      onText: (text: string) => {
        session.current = null
        onSession?.(null)
        setInterim(null)
        onDraft(join(text))
      },
      onFailure: (failure: { readonly message: string }) => {
        session.current = null
        onSession?.(null)
        quiet()
        setError(failure.message)
      },
    }
    const started = route.route === 'apple'
      ? startAppleSpeech({
        ...(environment === undefined ? {} : { environment }),
        onPhase: (next) => { setPhase(next); if (next !== 'recording') quiet() },
        // 中间结果**只用来显示**：整段替换着画在提示行上，不写进输入框。
        // 道理是"输入框里只放确定的东西"：用户按了取消或识别失败时，输入框应该
        // 还是他原来那几个字，而不是半截认出来的话（那看起来就像他已经打好的内容）。
        onPartial: text => setInterim(text.trim().length > 0 ? text : null),
        ...land,
      })
      : startVoiceInput({
        ...(environment === undefined ? {} : { environment }),
        ...(vad === undefined ? {} : { vad }),
        onPhase: (next) => { setPhase(next); if (next !== 'recording') quiet() },
        // 电平条是这次录音独有的：拿到第一帧就说明这次有实时反馈（也有端点检测），
        // 界面的文案据此说"说完自己会停"还是"说完再按一下"。
        onMeter: frame => setMeter(frame.bars),
        onVad: reading => setHint(vadHint(reading)),
        ...land,
      })
    session.current = started
    onSession?.(started)
    setPhase('recording')
  }

  // 失败优先于能力说明：用户刚操作完，最该看到的是"这次怎么了"。
  return { phase, elapsed, error, blocked: route.blocked, meter, hint, interim, route: route.route, available, toggle }
}

/**
 * 提示行上该显示哪句话；没有话要说时是 `null`。
 *
 * 抽成函数是因为这一处全是**产品判断**（谁优先、哪句话什么时候才敢说），放在几千行的
 * `App.tsx` 里既不好单测，也容易在下次改动里被写反。界面和测试调的是同一个函数，
 * 所以不存在"测试里一套文案、界面上另一套"。
 *
 * 顺序：
 * 1. `error` —— 用户刚操作完，最该知道"这次怎么了"；
 * 2. `blocked` —— 不能用时的原因（http 下、遥控形态下）；
 * 3. `hint` —— 自动收尾倒计时。它排在常规状态前面，因为这是唯一一条
 *    「再不动手就要错过」的话，被别的字盖住就等于没提示；
 * 4. 常规状态。
 *
 * 录音中的那句分三种，判据是**这次到底会不会自己收尾**：
 * - 苹果那条路：`continuous = false`，说完一句 UA 自己结束（见 `voice-apple.ts`），
 *   所以敢说"说完自己会停"；
 * - 宿主那条拿到实时电平：装了端点检测，也敢这么说；
 * - 宿主那条拿不到电平：端点检测没装，只能等用户再按一下——那种情况下承诺自动收尾
 *   就是骗人（端点的理由见 `voice-vad.ts`）。
 *
 * 字段是可选的：老调用方（不关心路的）传原来那几项就行，缺的按"宿主那条、没中间结果"解释。
 */
export interface VoiceNoteInput {
  readonly phase: VoicePhase
  readonly elapsed: number
  readonly error: string | null
  readonly blocked: string | null
  readonly hint: string | null
  readonly meter: readonly number[]
  /** 这次走的是哪条路；不传按宿主那条解释。 */
  readonly route?: VoiceRoute
}

/**
 * 提示行上该显示哪句话。
 * @param state - 语音输入的当前状态。
 * @returns 可直接展示的一句话。
 */
export function voiceNoteOf(state: VoiceNoteInput): string | null {
  const seconds = Math.floor(state.elapsed / 1_000)
  return state.error ?? state.blocked ?? state.hint
    ?? (state.phase === 'recording'
      ? (state.route === 'apple' || state.meter.length > 0
        ? `正在听 ${seconds}s… 说完自己会停`
        : `正在听 ${seconds}s… 说完再按一下结束`)
      : state.phase === 'transcribing' ? '正在识别…' : null)
}
