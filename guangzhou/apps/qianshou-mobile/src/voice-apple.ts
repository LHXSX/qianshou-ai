/**
 * 苹果自带语音识别：**浏览器侧的 Web Speech API**（`SpeechRecognition` /
 * `webkitSpeechRecognition`）。Safari 上它背后是苹果自己的语音服务（Safari 桌面版
 * ≥16 的 Web Speech 由 Siri 提供，见下面"依据"）。
 *
 * 为什么手机端要**新增**这条路，而不是继续用宿主那条：
 *
 * 1. 宿主那条路（录音 → 自己编码 WAV → POST 给宿主跑 whisper.cpp）**现在跑不通**：
 *    宿主没装模型时 `/api/forge/voice/transcribe` 回 `503 VOICE_UNAVAILABLE`
 *    （实测响应体就是 `{"error":"VOICE_UNAVAILABLE"}`，`content-type: application/json`），
 *    而模型下载被墙。这条路留着当备选，但今天它不是能用的那条。
 * 2. 这条路**顺带把"丝滑"做出来了**：Web Speech 天生是流式的——`onresult` 会在
 *    一句话说完之前就一次次给出 `isFinal === false` 的中间结果。不用等整段录完，
 *    也不用等宿主跑完一次推理。
 * 3. 它**不依赖宿主**：识别在浏览器/系统这一侧跑，页面只是调一个浏览器接口，
 *    没有向我们的电脑发任何请求（见 `voiceRouteOf` 里对遥控形态的处理）。
 *
 * 事实边界（不猜；查不到的就写明不确定）：
 *
 * - 错误码按规范里 `SpeechRecognitionErrorCode` 的取值写，取值表与本仓
 *   `node_modules/typescript/lib/lib.dom.d.ts`（6.0.3，`:44456`）逐字一致：
 *   `aborted`、`audio-capture`、`language-not-supported`、`network`、`no-speech`、
 *   `not-allowed`、`phrases-not-supported`、`service-not-allowed`。
 * - `continuous = false` 的语义（规范/MDN）：只返回**一次**最终结果，UA 说完一句
 *   自己收尾。我们要的就是这个——"说完自己停"不用我们自己判静音；手机上也正是
 *   这一档被支持得最稳。所以**默认单句**，一句话说完就落地，用户想接着说就再点一次。
 * - **中间结果在 iOS Safari 上不保证**（WebKit bug 288963 问的就是这件事：
 *   https://bugs.webkit.org/show_bug.cgi?id=288963 ）。所以这里把中间结果当**锦上添花**：
 *   一条中间结果都没收到时，最终结果照样要正确落地（`onend` 那条兜底路）。
 * - Safari 的听写服务不可用时会回 `service-not-allowed`（WebKit bug 225298）。
 *   这一条正好是"系统没开 Siri 与听写"这种用户能自己修的情形，所以必须有自己的文案。
 * - **没能核实**：中文（`zh-CN`）在各机型上的识别质量、苹果服务在某些地区的可用性、
 *   以及 `start()` 究竟在哪几个版本上要求用户手势。这几件事只能在真机上试，
 *   代码里不做假设；能做的只是把每一种失败都翻成一句能行动的话（`appleFailureOf`）。
 */

import {
  VOICE_COPY,
  VoiceError,
  voiceSupport,
  type VoiceEnvironment,
  type VoiceFailureKind,
  type VoicePhase,
  type VoiceSession,
  type VoiceSupport,
} from './voice.ts'

/** 识别语言：中文。写死而不是读浏览器语言——用户要的是中文输入，不是界面语言。 */
export const SPEECH_LANG = 'zh-CN'

/**
 * 一次会话的最长时间（毫秒）。
 *
 * 为什么要有这个上限：这条路正常情况下由 UA 在说完一句后自己结束，但它**也会卡住**
 * （识别服务不响应时 `onend` 可能一直不来）。那时麦克风就一直开着——那是隐私问题，
 * 不是体验问题。60 秒是"一句话"与"麦克风开着"之间的取舍：到了就收尾，
 * 已经认出来的字照样落地，不丢。
 */
export const SPEECH_MAX_MS = 60_000

/**
 * 我们真正用到的那部分 `SpeechRecognition`。
 *
 * 为什么不直接用 `lib.dom.d.ts` 的类型：TypeScript 6.0.3 里有 `SpeechRecognitionEvent`、
 * `SpeechRecognitionErrorEvent` 和 `SpeechRecognitionErrorCode`，**却没有 `SpeechRecognition`
 * 本身**（这个接口至今只在 WICG 的 speech-api 规范里，没进 WHATWG 的 DOM 标准）。
 * 所以这里按规范声明我们用到的那几个成员：界面代码有类型，测试里也能塞一个**有行为**的
 * 替身，而不用往全局写桩（`vi.stubGlobal` 是按 worker 生效的，会漏给下一个文件）。
 */
export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string
  readonly confidence?: number
}

/** 一条识别结果：可能还在变（`isFinal === false`），也可能已经定稿。 */
export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined
}

/** 一次 `onresult` 里的全部结果；`resultIndex` 起才是这一轮的增量。 */
export interface SpeechRecognitionResultListLike {
  readonly length: number
  readonly [index: number]: SpeechRecognitionResultLike | undefined
}

/** `onresult` 的事件形状。 */
export interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultListLike
}

/** `onerror` 的事件形状；`error` 就是上面那张码表里的一个。 */
export interface SpeechRecognitionErrorEventLike {
  readonly error: string
  readonly message?: string
}

/** 一次识别会话；`stop()` 请求收尾（还会给最终结果），`abort()` 立刻丢掉。 */
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
}

/** `SpeechRecognition` 的构造器形状。 */
export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike
}

/** 这条路的环境：在宿主那条路的环境上多一个可注入的 `SpeechRecognition` 构造器。 */
export interface SpeechEnvironment extends VoiceEnvironment {
  /** 注入的构造器；不传就按 `SpeechRecognition` → `webkitSpeechRecognition` 在全局找。 */
  readonly speechRecognition?: SpeechRecognitionCtor | null
}

/**
 * 找到这台设备上的 `SpeechRecognition` 构造器。
 *
 * 两个名字都要试：Safari 一直只给带前缀的 `webkitSpeechRecognition`；`SpeechRecognition`
 * 这个名字在部分版本上才存在。不判断具体浏览器型号——按"接口在不在"决定，比猜型号可靠。
 * @param environment - 可注入的环境。
 * @returns 构造器；没有就是 `null`。
 */
export function speechRecognitionCtor(environment: SpeechEnvironment = {}): SpeechRecognitionCtor | null {
  if (environment.speechRecognition !== undefined) return environment.speechRecognition ?? null
  const scope = globalThis as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition
  return typeof ctor === 'function' ? ctor : null
}

/**
 * 这台设备现在能不能用浏览器自带的语音识别。
 *
 * **安全上下文复用宿主那条路的判定**：`voiceSupport()` 的第一道就是 `isSecureContext`，
 * 这里只把它的结论拿过来用（`insecure-context` 原样返回），不另写一套判断——
 * 同一件事有两份实现，迟早会有一份写歪，而用户看到的两条路会给出不同的解释。
 * @param environment - 可注入的环境。
 * @returns 能用返回 `ok: true`；不能用给出原因。
 */
export function appleSpeechSupport(environment: SpeechEnvironment = {}): VoiceSupport {
  const host = voiceSupport(environment)
  if (host.reason === 'insecure-context') return host
  return speechRecognitionCtor(environment) === null
    ? { ok: false, reason: 'unsupported' }
    : { ok: true, reason: null }
}

/**
 * 把一个 `onerror` 的错误码翻成可行动的失败。
 *
 * 每个码一句自己的话：这些码的**处置完全不同**（去开权限 / 去开 Siri / 去查手机网络 /
 * 去关掉占用麦克风的应用），笼统报一句"识别失败"等于让用户自己猜。
 *
 * `aborted` 故意不在这里：它表示"这次会话被中止"，我们自己 `cancel()` 时也会收到它，
 * 那不是失败（调用方在拿到它之前就判掉了，见 `startAppleSpeech`）。
 * `phrases-not-supported` 落进兜底那一档：我们从不设 `phrases`，这个码不可能由我们引起，
 * 给它单写一句只是编一个用户永远见不到的文案。
 * @param code - 事件里的 `error`。
 * @returns 对应的失败对象。
 */
export function appleFailureOf(code: string | undefined): VoiceError {
  const kind: VoiceFailureKind = code === 'not-allowed' ? 'speech-denied'
    : code === 'service-not-allowed' ? 'speech-service'
      : code === 'audio-capture' ? 'speech-audio'
        : code === 'network' ? 'speech-network'
          : code === 'language-not-supported' ? 'speech-language'
            : code === 'no-speech' ? 'no-speech'
              : 'speech-failed'
  return new VoiceError(kind)
}

/** 一次浏览器语音识别要用到的回调。 */
export interface AppleSpeechOptions {
  /** 可注入的环境（含替身构造器）。 */
  readonly environment?: SpeechEnvironment
  /** 阶段变化。识别不上传、不推理，所以不会出现 `transcribing`。 */
  readonly onPhase?: (phase: VoicePhase) => void
  /** 已经听了多久（毫秒）。 */
  readonly onElapsed?: (ms: number) => void
  /**
   * 中间结果：**当前这句话的最新全貌**（不是增量）。
   *
   * 界面拿它整段替换着显示，所以在界面上是一次次"同一段文字在变"，不会堆出一串重复。
   */
  readonly onPartial?: (text: string) => void
  /** 认出文字了：**交给调用方填进输入框**，这里不发送。 */
  readonly onText: (text: string) => void
  /** 失败；`error.message` 可直接展示。 */
  readonly onFailure: (error: VoiceError) => void
  /** 收尾（成功、失败、取消都会走到）。 */
  readonly onDone?: () => void
  /** 一次会话的最长时间；默认 `SPEECH_MAX_MS`。测试用它把 60 秒压到几十毫秒。 */
  readonly maxMs?: number
}

/** 没开始成功的会话：形状与真会话一致，调用方不用判空。 */
function inertSession(): VoiceSession {
  return { stop: () => { /* 没开始就没有要停的 */ }, cancel: () => { /* 同上 */ } }
}

/**
 * 开始一次浏览器自带的语音识别。
 *
 * 生命周期只有一条线：`start()` → （中间结果若干）→ 最终结果 / `onend` → 收尾。
 * 三个刻意的选择：
 *
 * 1. **拿到最终结果就地收尾**（不等 `onend`）：`continuous = false` 时最终结果就代表
 *    "这句说完了"，此时把文字落地并摘掉所有回调，后面的 `onend`/`aborted` 都不会再
 *    影响界面。
 * 2. **`onend` 也兜底**：一台机器可能只给中间结果、不给 `isFinal`（iOS 上这不确定，
 *    见文件头）。到点了就把手上已有的文字落地——用户确实说了话，把字丢掉比填进去更糟。
 * 3. **取消是硬的**：先摘回调再 `abort()`，之后再有事件也进不来，一个字都不落地、
 *    一个失败都不报（"取消"就是当没说过）。
 * @param options - 回调、环境与时限。
 * @returns 可停止/取消的会话；这台设备没有接口时返回一个空会话。
 */
export function startAppleSpeech(options: AppleSpeechOptions): VoiceSession {
  const environment = options.environment ?? {}
  const Ctor = speechRecognitionCtor(environment)
  if (Ctor === null) {
    options.onFailure(new VoiceError('speech-failed'))
    return inertSession()
  }
  let recognition: SpeechRecognitionLike
  try {
    recognition = new Ctor()
  } catch {
    options.onFailure(new VoiceError('speech-failed'))
    return inertSession()
  }
  recognition.lang = SPEECH_LANG
  // 单句模式：说完一句 UA 自己收尾（规范里 `continuous = false` 就是这个意思）。
  // 手机上连续模式的表现各家不一（有的说完一句照样挂着会话），而我们要的本来就是
  // "说完自己停、文字落地"，单句模式正好是它，也是被支持得最稳的那一档。
  recognition.continuous = false
  // 中间结果：界面"边说边出字"靠它。**只是加分项**，收不到也不影响最终结果落地。
  recognition.interimResults = true
  // 我们只用第一条候选（`result[0]`），多要几条只是让引擎白算。
  recognition.maxAlternatives = 1

  const startedAt = Date.now()
  const maxMs = options.maxMs ?? SPEECH_MAX_MS
  let timer: ReturnType<typeof setInterval> | undefined
  let capTimer: ReturnType<typeof setTimeout> | undefined
  /** 已经落地（成功/失败）或已被取消：之后来的事件一律不进逻辑。 */
  let settled = false
  let cancelled = false
  /** 已经定稿的那部分文字，会一段段累加。 */
  let finalText = ''
  /** 当前还没定稿的那部分文字，每次都被新的替换掉（不是往后接）。 */
  let interimText = ''

  /** 手上的全部文字：定稿 + 还没定稿的。 */
  const gathered = (): string => `${finalText}${interimText}`

  const stopTimers = (): void => {
    if (timer !== undefined) clearInterval(timer)
    if (capTimer !== undefined) clearTimeout(capTimer)
    timer = undefined
    capTimer = undefined
  }

  /**
   * 摘掉全部回调。
   *
   * 收尾和取消都要走这一步：`abort()` 之后 UA 仍可能把已经排队的任务跑完
   * （`onend`、甚至一次迟到的 `onresult`），先摘掉才谈得上"取消之后不再接收结果"。
   */
  const detach = (): void => {
    recognition.onstart = null
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
  }

  const finish = (): void => { stopTimers(); detach(); options.onPhase?.('idle'); options.onDone?.() }

  /**
   * 一句话的去向：有字就填进输入框，一个字都没有才说"没听清"。只走一次。
   * @param text - 这一次认到的全部文字。
   */
  const settle = (text: string): void => {
    if (settled || cancelled) return
    settled = true
    finish()
    const trimmed = text.trim()
    if (trimmed.length > 0) options.onText(trimmed)
    else options.onFailure(new VoiceError('no-speech'))
  }

  /** 让 UA 结束这次会话；它已经不在跑（或已经结束时）什么都不做。 */
  const requestStop = (): void => {
    try {
      recognition.stop()
    } catch {
      // 规范里 `stop()` 在不活跃时是空操作，但实现有差异；抛了说明它已经不在跑，
      // 收尾由 `onend` / 上面的落地逻辑负责，不需要在这里补一刀。
    }
  }

  recognition.onstart = () => { options.onPhase?.('recording') }
  recognition.onresult = (event) => {
    if (settled || cancelled) return
    // 从 `resultIndex` 起才是这次的增量：之前的每一条上一轮已经报过，再算一遍会重复。
    let fresh = ''
    let pending = ''
    for (let i = event.resultIndex ?? 0; i < event.results.length; i++) {
      const result = event.results[i]
      if (result === undefined) continue
      const text = result[0]?.transcript ?? ''
      if (result.isFinal) fresh += text
      else pending += text
    }
    if (fresh.length > 0) finalText += fresh
    interimText = pending
    // 有还没定稿的部分就显示出来：整段替换，不往界面上堆重复（定稿那一半也算在里面，
    // 因为用户看到的是这一句的**全貌**，不是半截）。
    if (pending.length > 0) options.onPartial?.(gathered())
    // 定稿了就落地：这正是"说完自己会停"，不用用户再点一次。
    //
    // **但同一个事件里还有没定稿的那截时先不落地**：那说明用户还在说（引擎把前半句
    // 定稿、后半句还在变）。这时候收尾就是把人正在说的半句切掉，而且切掉的那截还会
    // 被当成最终文字填进输入框。等下一个事件或 `onend` 再落，一个字都不会丢。
    if (fresh.length > 0 && pending.length === 0) settle(gathered())
  }
  recognition.onerror = (event) => {
    if (settled || cancelled) return
    // `aborted`：会话被中止，**不是失败**。可能是系统自己收尾（例如识别服务重启），
    // 也可能是浏览器内部的正常路径。手上已经有字就落地；一个字都没有就安静地回空闲——
    // 这时候报一句"没听清"是在替用户编一个他没做过的事（他可能根本没开口，
    // 也可能引擎自己中止了）。我们自己按取消时更早就返回了，走不到这里。
    if (event.error === 'aborted') {
      if (gathered().trim().length > 0) settle(gathered())
      else { settled = true; finish() }
      return
    }
    settled = true
    finish()
    options.onFailure(appleFailureOf(event.error))
  }
  recognition.onend = () => {
    // 说完了，或者 UA 自己收了尾：手上有什么就落什么（见文件头：iOS 上不一定给 isFinal）。
    settle(gathered())
  }

  try {
    recognition.start()
  } catch {
    // `start()` 会同步抛：已经有别的识别在跑（`InvalidStateError`）、或者这台设备
    // 直接不允许（权限/策略）。两种情况对用户来说出路是同一个：再点一次。
    settled = true
    finish()
    options.onFailure(new VoiceError('speech-start'))
    return inertSession()
  }
  // 有些实现不给 `onstart`；先自己报"在听了"，界面才不会停在"没反应"上。
  options.onPhase?.('recording')
  timer = setInterval(() => options.onElapsed?.(Date.now() - startedAt), 250)
  capTimer = setTimeout(() => {
    // 到点收尾：已经认出来的字照样落地。麦克风长时间开着是隐私问题，不能靠运气。
    if (settled || cancelled) return
    settle(gathered())
    requestStop()
  }, maxMs)

  return {
    stop(): void {
      if (settled || cancelled) return
      // 请求收尾：规范里 `stop()` 会尽量把已经说出的部分作为最终结果交回来。
      requestStop()
    },
    cancel(): void {
      if (cancelled) return
      cancelled = true
      settled = true
      // 先摘回调、再 abort：之后再来的任何事件都不进我们的逻辑，一个字都不落地。
      stopTimers()
      detach()
      try {
        recognition.abort()
      } catch {
        // 已经不在跑：没有要中止的东西。
      }
      options.onPhase?.('idle')
      options.onDone?.()
    },
  }
}

/** 一次语音输入走哪条路。 */
export type VoiceRoute = 'apple' | 'host' | 'none'

/** 两条路的判决合成一个决定。 */
export interface VoiceRouteDecision {
  /** 这次会走哪条；两条都不行时是 `'none'`。 */
  readonly route: VoiceRoute
  /** 走不了时展示的那句话；能走时是 `null`。 */
  readonly blocked: string | null
}

/**
 * 决定一次语音输入走哪条路。
 *
 * **顺序：苹果自带（Web Speech）优先，宿主 whisper 兜底。** 理由逐条：
 *
 * 1. **今天只有苹果那条能用**：宿主没装模型，实测回 `503 VOICE_UNAVAILABLE`，
 *    而模型下载被墙。把能用的放在后面，等于让用户先去撞一次墙。
 * 2. **它更快、更早出字**：流式中间结果在路上就把字显示出来，不用等整段录完 +
 *    编码 + 上传 + 宿主推理。
 * 3. **少三跳**：不用 `getUserMedia`、不用编 WAV、不用上传，也就少掉这三处各自的失败面。
 * 4. **它不依赖宿主**，所以在"页面不是工作台提供的"（遥控/配对）形态下照样能用——
 *    而宿主那条路在那种形态下必然失败。
 *
 * 反过来，**没有 Web Speech 的环境（部分浏览器、WebView、老系统）必须还能用**，
 * 所以宿主那条一条都不删：它的接口在（`voiceSupport()` 通过）就轮到它。
 * 这也让"宿主哪天装好模型"这件事自动生效，不需要再改这里的判定。
 *
 * 两条都不通时给哪句话：见 `blockedCopyOf`。
 * @param apple - 苹果那条路的判决（`appleSpeechSupport()`）。
 * @param host - 宿主那条路的判决（`voiceSupport()`）。
 * @returns 走哪条，以及走不了时该显示什么。
 */
export function voiceRouteOf(apple: VoiceSupport, host: VoiceSupport): VoiceRouteDecision {
  if (apple.ok) return { route: 'apple', blocked: null }
  if (host.ok) return { route: 'host', blocked: null }
  return { route: 'none', blocked: blockedCopyOf(apple, host) }
}

/**
 * 两条路都不通时该说哪一句。
 *
 * 顺序是**处置的优先级**，不是能力检查的顺序：
 * 1. 安全上下文：两条路共同的前提，处置也只有一个（换成 https 打开）；
 * 2. 遥控形态：它解释了"为什么现在不行"以及"怎么才能行"（用工作台打开），
 *    比一句"这个浏览器不支持语音识别"有用得多——后者会让用户去换浏览器，白折腾；
 * 3. 剩下的照苹果那条路的原因说（它就是用户接下来最可能问到的"为什么"）。
 * @param apple - 苹果那条路的判决。
 * @param host - 宿主那条路的判决。
 * @returns 可直接展示的一句话。
 */
function blockedCopyOf(apple: VoiceSupport, host: VoiceSupport): string {
  if (apple.reason === 'insecure-context' || host.reason === 'insecure-context') return VOICE_COPY['insecure-context']
  if (host.reason === 'remote-host') return VOICE_COPY['remote-host']
  return VOICE_COPY[apple.reason ?? host.reason ?? 'unsupported']
}
