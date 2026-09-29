/**
 * 手机端语音输入：**按住说话 → 转写成文字 → 填进输入框**。
 *
 * 为什么不是"录完直接把录音发走"：宿主的转写接口只认**一种**音频——单声道
 * PCM16、16 kHz、带 RIFF/WAVE 头的 WAV。这不是我们的口味，是
 * `packages/host/voice-local/src/wav.ts` 里 `validVoiceWav()` 逐字节校验出来的
 * 硬契约（`buffer.readUInt32LE(offset + 12) === 16_000`、
 * `readUInt16LE(offset + 22) === 16`、采样数必须 `% 2 === 0`）。
 *
 * 而 `MediaRecorder` 在手机上**只会吐** WebM/Opus 或 MP4/AAC 这类**压缩容器**，
 * 没有哪个浏览器给它 `audio/wav`。所以正确的链路是三步，不是两步：
 *
 * 1. `MediaRecorder` 录 → 拿到压缩容器（手机上唯一到处都有的录音 API）；
 * 2. `decodeAudioData` 解成裸声道样本 → `encodeWav` 压成宿主认的那一种 WAV；
 * 3. POST 给 `/api/forge/voice/transcribe`。
 *
 * 第 2 步不能省：省了就是拿一个 WebM 去撞 `validVoiceWav()`，宿主必然回
 * `INVALID_AUDIO`，而用户只会看到"识别失败"——那是我们自己造出来的失败。
 * 参考实现见 PC 端 `packages/client/ui-chat/src/client/chat/voice/audio.ts` 的
 * `encodeWav()`（同一套盒子滤波降采样，本文件重写一份，因为手机端不引 client 包）。
 *
 * 隐私边界：转写**在宿主那台电脑上本地跑**（whisper.cpp），语音数据不出那台电脑。
 * 但"宿主"是谁取决于这个页面由谁提供——见下面 `voiceSupport()` 的 `remote-host`。
 */

import { createVoiceMeter, type MeterFrame, type VoiceMeter } from './voice-meter.ts'
import { VoiceEndpointer, vadConfigOf, type VadConfig, type VadReading } from './voice-vad.ts'

/** 语音输入失败的原因；每一种对应不同的处置，**不做二次翻译**。 */
export type VoiceFailureKind =
  /** 不是安全上下文：浏览器根本不给麦克风。手机端最容易撞上的一个。 */
  | 'insecure-context'
  /** 这个页面不是工作台提供的（配对/遥控形态）：录音发出去也到不了工作台的语音服务。 */
  | 'remote-host'
  /** 浏览器没有 `MediaRecorder` 或录音能力。 */
  | 'unsupported'
  /** 用户（或系统）拒绝了麦克风权限。 */
  | 'denied'
  /** 宿主没装语音模型，或转写引擎起不来。 */
  | 'no-model'
  /** 宿主正忙：一次只跑一个转写。 */
  | 'busy'
  /** 转写超时（默认上限 90 秒）。 */
  | 'timeout'
  /** 录到的音频不合契约，或说话太短、没有有效语音。 */
  | 'no-speech'
  /**
   * 一句话都没说就静默到点了：**本地收尾，没有发过请求**。
   *
   * 和 `no-speech` 分开是有意的：那个是"宿主听了但没听懂"（要用户说清楚点），
   * 这个是"麦克风什么都没收到"（可能是没开口、离得太远、选错了输入设备）。
   * 处置不一样，文案就不能共用一句。
   */
  | 'silent'
  /** 网络不通，或宿主回了一个认不出的错误。 */
  | 'network'
  /**
   * 下面这几个来自**浏览器自带那条路**（`voice-apple.ts` 的 Web Speech API）：
   * 识别跑在系统和浏览器这一侧，失败的原因与宿主那条路不重合，所以处置也不重合。
   * 码表取自规范的 `SpeechRecognitionErrorCode`（见 voice-apple.ts 文件头）。
   */
  /** `not-allowed`：这个页面没有麦克风权限。 */
  | 'speech-denied'
  /** `service-not-allowed`：这台设备不允许网页做语音识别（多半是没开 Siri 与听写）。 */
  | 'speech-service'
  /** `network`：苹果那边（手机系统）的语音识别服务连不上。 */
  | 'speech-network'
  /** `audio-capture`：没拿到麦克风，或被别的应用占着。 */
  | 'speech-audio'
  /** `language-not-supported`：这台设备没有中文（zh-CN）的识别能力。 */
  | 'speech-language'
  /** `start()` 直接抛：识别没能开始（上一句还没结束、或设备直接不允许）。 */
  | 'speech-start'
  /** 其它码（含 `phrases-not-supported`）与认不出的码：没能继续，重来一次。 */
  | 'speech-failed'

/**
 * 面向用户的说明；直接展示。
 *
 * 手机端**不能**只报"录音失败了"：麦克风被拒要去浏览器设置里开、http 下要去换
 * https、宿主没装模型要去电脑上装——三件事的处置完全不同，文案必须分开。
 *
 * 同理，**`no-model` 那句里不许出现"网络"**：503 是服务器回给我们的状态码，
 * 它本身就证明"电脑是通的"。实测宿主没装模型时回的正是
 * `503 {"error":"VOICE_UNAVAILABLE"}`（2026-09-16 用会话 cookie 打真机工作台的
 * `/api/forge/voice/transcribe` 得到，响应头 `content-type: application/json`）。
 * 把"模型没装"说成"连不上电脑"，用户就会去查网络、重启工作台——真因不在那儿，
 * 白折腾一轮之后还是不能用。
 */
export const VOICE_COPY: Readonly<Record<VoiceFailureKind, string>> = {
  'insecure-context': '🎤 浏览器只在 HTTPS 下给麦克风。'
    + '请用 https:// 打开这个页面，或在电脑本机用 localhost。',
  'remote-host': '🎤 这个页面不是工作台提供的（当前是遥控/配对形态）。'
    + '语音转写在电脑的本地语音服务上跑，这里调不到它。'
    + '请在电脑上用工作台，或改用 https://<电脑>:<端口>/mobile/ 打开。',
  unsupported: '🎤 这个浏览器不支持录音（MediaRecorder）。请换 Safari 或 Chrome 的新版本。',
  denied: '🎤 没有麦克风权限。请在浏览器设置里允许本站使用麦克风，然后重试。',
  'no-model': '🎤 电脑上还没装语音识别模型，转写服务起不来（工作台是通的，不是网络问题）。'
    + '请在电脑上装好 whisper.cpp 的模型再试。',
  busy: '🎤 电脑正在识别上一段语音，稍等一下再说。',
  timeout: '🎤 识别超时了。说话短一点，或检查电脑上的语音服务是否还在跑。',
  'no-speech': '🎤 没听清。说完整一句再试，靠近麦克风一点。',
  silent: '🎤 一句话都没听到，已经停下了。离麦克风近一点再说一次。',
  network: '🎤 连不上电脑的语音服务。检查网络，或确认电脑上的工作台还开着。',
  'speech-denied': '🎤 本页没有麦克风权限。请到系统设置里允许这个浏览器（或本应用）'
    + '使用麦克风，然后重试。',
  'speech-service': '🎤 这台设备不允许网页做语音识别。请到系统设置里打开「Siri 与听写」，'
    + '或用电脑上的工作台语音。',
  'speech-network': '🎤 手机上的语音识别服务连不上（是系统自带那个服务，跟电脑无关）。'
    + '检查手机网络，并确认系统设置里的「Siri 与听写」是开着的。',
  'speech-audio': '🎤 语音识别没拿到麦克风。检查本页的麦克风权限，'
    + '并确认没有别的应用正在占用麦克风。',
  'speech-language': '🎤 这台设备认不了中文（zh-CN）。请把系统的听写语言设为中文，'
    + '或用电脑上的工作台语音。',
  'speech-start': '🎤 语音识别没能启动。请再点一次麦克风；还是不行就改用键盘输入。',
  'speech-failed': '🎤 语音识别出错了，没能继续。请再说一次；一直这样就把浏览器关掉重开。',
}

/** 一次语音输入失败；`message` 就是可以直接展示的那句话。 */
export class VoiceError extends Error {
  readonly kind: VoiceFailureKind
  /** 宿主返回的 HTTP 状态码；本地判据没有就是 `undefined`。 */
  readonly status: number | undefined

  /**
   * @param kind - 失败类别，决定展示哪一句文案。
   * @param status - 宿主返回的状态码，便于排查。
   */
  constructor(kind: VoiceFailureKind, status?: number) {
    super(VOICE_COPY[kind])
    this.name = 'VoiceError'
    this.kind = kind
    this.status = status
  }
}

/** 宿主转写接口的路径；与 `packages/client/ui-chat/src/client/chat/voice/api.ts` 一致。 */
export const TRANSCRIBE_PATH = '/api/forge/voice/transcribe'

/** 宿主状态接口的路径。 */
export const VOICE_STATUS_PATH = '/api/forge/voice/status'

/**
 * 宿主的硬上限，逐条对应 `wav.ts`：
 * `MAX_AUDIO_BYTES = 16_000 * 2 * 120 + 4096`，采样数下限 `3200`。
 */
export const MAX_VOICE_BYTES = 16_000 * 2 * 120 + 4096
/** 最短有效语音：3200 字节 = 1600 个样本 = 0.1 秒。 */
export const MIN_VOICE_BYTES = 3200
/** 录到这么久就自动停止：宿主上限是 120 秒，留 5 秒余量，别让它来拒我们。 */
export const MAX_VOICE_MS = 115_000

/** 录音时可选的一个 `MediaRecorder` mime；第一个被浏览器认下来的胜出。 */
const RECORDER_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'] as const

/** 判断能力用的环境；每一项都可注入，便于测试。 */
export interface VoiceEnvironment {
  readonly isSecureContext?: boolean
  readonly mediaDevices?: { readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> } | undefined
  readonly mediaRecorder?: typeof MediaRecorder | undefined
  readonly audioContext?: typeof AudioContext | undefined
  /** 这个页面是不是工作台自己提供的（同源部署）。见 `voiceSupport`。 */
  readonly workbenchServed?: boolean
  /** 发请求用的实现；默认取全局 `fetch`。 */
  readonly fetch?: typeof fetch
}

/** 环境是否具备语音输入条件。 */
export interface VoiceSupport {
  readonly ok: boolean
  readonly reason: VoiceFailureKind | null
}

/**
 * 这个页面**是不是由工作台自己提供的**。
 *
 * 用构建时的资源前缀当判据，而不是运行时探测或猜地址：与
 * `apps/qianshou-mobile/src/App.tsx` 里账号同源探测用的是同一个信号
 * （`import.meta.env.BASE_URL.startsWith('/mobile/')`，见 vite.config.ts 的 `base`），
 * 那个注释里写得很清楚——「`/mobile/` 前缀就是挂在工作台下面这个事实的确定信号」。
 *
 * 为什么语音必须区分这件事：宿主的两条语音路由注册在**工作台进程的**
 * Connection 上（`packages/host/voice-local/src/index.ts:89-97`）。手机页面如果
 * 是由手机上的预览服务（或别的电脑）提供的，那么相对路径
 * `/api/forge/voice/transcribe` 打的是**那个源**，录音的归宿不是我们这台工作台。
 * 与其"默默发出去"，不如在按钮上就说清楚。
 * @returns 由工作台提供返回 `true`。
 */
export function workbenchServed(): boolean {
  try {
    return import.meta.env.BASE_URL.startsWith('/mobile/')
  } catch {
    // 没有构建信息（例如被非 Vite 环境直接 import）时，按"不是工作台提供的"处理：
    // 宁可少一个入口，也不把用户的录音发到一个说不清是谁的地址上。
    return false
  }
}

/**
 * 判断这台设备现在能不能语音输入。
 *
 * **顺序是有意义的**：先看安全上下文，再看页面形态，最后才看接口。
 * http 下即使 `mediaDevices` 和 `MediaRecorder` 都在，`getUserMedia` 也会直接失败，
 * 那时报"不支持录音"是误导——真实原因是协议不对，处置也不同（去换 https）。
 * 这个顺序照 `apps/qianshou-mobile/src/pairing.ts` 的 `scanSupport()` 抄的。
 * @param environment - 可注入的环境，便于测试。
 * @returns 支持与否及原因。
 */
export function voiceSupport(environment: VoiceEnvironment = {}): VoiceSupport {
  const secure = environment.isSecureContext
    ?? (typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : false)
  if (!secure) return { ok: false, reason: 'insecure-context' }
  const served = environment.workbenchServed ?? workbenchServed()
  if (!served) return { ok: false, reason: 'remote-host' }
  const devices = environment.mediaDevices
    ?? (globalThis.navigator as { mediaDevices?: VoiceEnvironment['mediaDevices'] } | undefined)?.mediaDevices
  if (devices === undefined || devices === null || typeof devices.getUserMedia !== 'function') {
    return { ok: false, reason: 'unsupported' }
  }
  const recorder = environment.mediaRecorder
    ?? (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
  if (typeof recorder !== 'function') return { ok: false, reason: 'unsupported' }
  return { ok: true, reason: null }
}

/**
 * 把任意采样率的单声道样本压成宿主认的那一种 WAV：单声道 PCM16、16 kHz。
 *
 * 逐条对应 `wav.ts` 的校验：`fmt ` 块长度 16、格式 1、声道 1、采样率 16000、
 * 字节率 32000、块对齐 2、位深 16，数据块长度是偶数。
 * @param samples - 源单声道浮点样本。
 * @param inputRate - 源采样率。
 * @returns 44 字节 RIFF 头 + PCM16 数据的 WAV。
 */
export function encodeWav(samples: Float32Array, inputRate: number): Blob {
  const rate = 16_000
  const length = Math.max(0, Math.floor(samples.length * rate / inputRate))
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const write = (at: number, text: string): void => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * inputRate / rate)
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * inputRate / rate)))
    let sum = 0
    for (let j = start; j < end; j++) sum += samples[j] ?? 0
    const value = Math.max(-1, Math.min(1, sum / (end - start)))
    view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** 录音阶段；界面按它显示状态，别让用户干等。 */
export type VoicePhase = 'idle' | 'recording' | 'transcribing'

/**
 * 把宿主返回的错误码翻成可行动的失败。
 *
 * 码表来自 `packages/host/voice-local/src/index.ts` 的 `recognize()`：415/413
 * `INVALID_AUDIO`、503 `VOICE_UNAVAILABLE`、429 `VOICE_BUSY`、400 `INVALID_AUDIO`、
 * 504 `VOICE_TIMEOUT`、500 `TRANSCRIPTION_FAILED`、499 `REQUEST_ABORTED`。
 *
 * 认不出的码（含 `undefined`）落成 `network`——**唯一例外**是"503 且读不出码"：
 * 那一种先问一次宿主的语音状态接口再判，理由写在 `transcribeWav` 里（不能让用户去查网络）。
 * @param code - 响应体里的 `error` 字段。
 * @param status - HTTP 状态码。
 * @returns 对应的失败对象。
 */
export function voiceFailureOf(code: string | undefined, status: number): VoiceError {
  const kind: VoiceFailureKind = code === 'VOICE_UNAVAILABLE' ? 'no-model'
    : code === 'VOICE_BUSY' ? 'busy'
      : code === 'VOICE_TIMEOUT' ? 'timeout'
        : code === 'INVALID_AUDIO' ? 'no-speech'
          : 'network'
  return new VoiceError(kind, status)
}

/**
 * 把一段 WAV 交给宿主的本地转写服务。
 *
 * 请求形状逐条照契约：`POST`、`Content-Type: audio/wav`、body 是**原始 WAV 字节**
 * （不是 multipart、不是 base64、不是 JSON），`credentials: 'same-origin'`——
 * 最后一项照 PC 端 `api.ts` 的 `transcribeVoice()`。
 * @param wav - 已编码好的 WAV。
 * @param signal - 取消这次上传。
 * @param environment - 可注入的 fetch。
 * @returns 去掉首尾空白的识别文字。
 */
export async function transcribeWav(wav: Blob, signal: AbortSignal, environment: VoiceEnvironment = {}): Promise<string> {
  const fetchImpl = environment.fetch ?? globalThis.fetch.bind(globalThis)
  let response: Response
  try {
    response = await fetchImpl(TRANSCRIBE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw new VoiceError('network')
    throw error instanceof VoiceError ? error : new VoiceError('network')
  }
  // 读响应体也会失败：中间有代理/网关时，502 回来的是 HTML 而不是 JSON，`json()` 会抛。
  // 那必须落成一个 `VoiceError`——否则界面上会跳出一句 `Unexpected token '<'`，
  // 用户看到的是我们内部的东西。
  //
  // 但**不能一读不出体就说"连不上"**（下面那一段 503 的处理就是为此）：状态码本身也是证据。
  let body: unknown = null
  let bodyReadable = true
  try {
    body = await response.json()
  } catch {
    bodyReadable = false
  }
  if (!response.ok) {
    const code = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error : undefined
    // 503 且读不出错误码：状态码说"服务器暂时不能转写"，但读不到它想说的原因。
    // 这时候**问一次宿主的语音状态接口**，拿它的回答来定处置，而不是猜：
    // 宿主自己在 `voice-local/src/index.ts:71` 只为一个原因回 503——模型没装
    // （`VOICE_UNAVAILABLE`）。问出来 `available: false` 就照实说"模型没装"；
    // 问不通（真的连不上）或它说模型在，就保持原来的"网络"判定，一个字都不改。
    if (code === undefined && response.status === 503
      && await voiceServiceAvailable(environment, signal) === false) {
      throw new VoiceError('no-model', response.status)
    }
    throw voiceFailureOf(code, response.status)
  }
  if (!bodyReadable) throw new VoiceError('network', response.status)
  if (typeof body !== 'object' || body === null || !('text' in body) || typeof body.text !== 'string') {
    throw new VoiceError('network', response.status)
  }
  const text = body.text.trim()
  if (text.length === 0) throw new VoiceError('no-speech', response.status)
  return text
}

/**
 * 问一次宿主：「语音转写现在能不能用」。
 *
 * 只在**拿到了 503、又读不出错误码**时才用（正常那条 503 带
 * `{"error":"VOICE_UNAVAILABLE"}`，直接就能判，不用多这一趟）。
 *
 * 为什么宁可多问一次也不直接说"网络"：503 是**服务器回给我们的状态码**，它本身就说明
 * "电脑是通的"。把这种情况说成"连不上电脑的语音服务"，用户会去查网络、重启工作台，
 * 而真因（模型没装）根本不在那儿。
 *
 * 结论以宿主的回答为准，不猜：
 * - `false` ⇒ 模型没装；
 * - `true` ⇒ 模型在，那这个 503 是别的原因，交给原来的判定；
 * - 问不通 / 不是 JSON / 没有 `available` ⇒ 那就真是连不上，交给原来的判定。
 * @param environment - 可注入的 fetch。
 * @param signal - 取消这次探测。
 * @returns 宿主的回答；问不出来时是 `null`。
 */
export async function voiceServiceAvailable(
  environment: VoiceEnvironment = {},
  signal?: AbortSignal,
): Promise<boolean | null> {
  const fetchImpl = environment.fetch ?? globalThis.fetch.bind(globalThis)
  try {
    const response = await fetchImpl(VOICE_STATUS_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('available' in body)) return null
    return typeof body.available === 'boolean' ? body.available : null
  } catch {
    // 探测本身失败**不影响**用户看到的结论（顶多回到"网络"那句），所以这里不抛。
    return null
  }
}

/**
 * 释放一条媒体流上的所有轨道。
 *
 * 抽成函数只有一件事要说清：**关掉麦克风是隐私边界**，不是随手一写的收尾。
 * 三条路径（正常结束、用户取消、组件卸载）都必须走到这里，漏一条录音指示灯就亮着。
 * @param stream - 要释放的流；可能还没有（麦克风没拿到）。
 */
function stopTracks(stream: MediaStream | undefined): void {
  if (stream === undefined) return
  for (const track of stream.getTracks()) track.stop()
}

/** 一次进行中的录音会话。 */
export interface VoiceSession {
  /** 停止录音并开始转写。 */
  readonly stop: () => void
  /** 丢弃这次录音：不发请求、不写输入框。 */
  readonly cancel: () => void
}

/** 一次语音输入要用到的回调。 */
export interface VoiceRecordOptions {
  /** 可注入的环境。 */
  readonly environment?: VoiceEnvironment
  /**
   * 端点检测的参数；只填想改的那几项，其余走 `VAD_DEFAULTS`（见 `voice-vad.ts`）。
   *
   * 拿不到实时电平时**整个端点检测都不装**（下面的 `onMeter` 不会回调）：测不到声音的
   * 静默和"用户没说话"是两件事，没有证据就替用户收尾，会把他正在说的半句话切掉。
   * 那时退回按一下才停的老路子。
   */
  readonly vad?: Partial<VadConfig>
  /** 阶段变化；`transcribing` 表示已经在等宿主了。 */
  readonly onPhase?: (phase: VoicePhase) => void
  /** 已经录了多久（毫秒）；界面可以用来说话时长。 */
  readonly onElapsed?: (ms: number) => void
  /**
   * 实时电平。**只有拿到分析器时才会被调用**，且第一帧在录音开始的同一刻就到
   * （界面不用等一个 tick 才知道"这次有实时反馈"）。
   */
  readonly onMeter?: (frame: MeterFrame) => void
  /** 端点判定的最新结果；界面靠它显示"好像说完了…"的倒计时。 */
  readonly onVad?: (reading: VadReading) => void
  /** 识别成功；文字**交给调用方填进输入框**，不在这里发送。 */
  readonly onText: (text: string) => void
  /** 失败；`error.message` 可直接展示。 */
  readonly onFailure: (error: VoiceError) => void
  /** 取消、或者环境本来就不支持时的收尾（不是失败）。 */
  readonly onDone?: () => void
}

/**
 * 开始一次语音输入。
 *
 * 先判环境再碰麦克风：安全上下文不过、或页面不是工作台提供的，直接回调失败，
 * **一个请求都不发**（`remote-host` 尤其重要——不能把录音发到说不清的源上）。
 * @param options - 回调与环境注入。
 * @returns 可停止/取消的会话；环境不支持时返回一个空会话。
 */
export function startVoiceInput(options: VoiceRecordOptions): VoiceSession {
  const environment = options.environment ?? {}
  const support = voiceSupport(environment)
  if (!support.ok) {
    options.onFailure(new VoiceError(support.reason ?? 'unsupported'))
    return { stop: () => { /* 没开始就没有要停的 */ }, cancel: () => { /* 同上 */ } }
  }
  const devices = (environment.mediaDevices
    ?? (globalThis.navigator as { mediaDevices?: VoiceEnvironment['mediaDevices'] }).mediaDevices
  ) as NonNullable<VoiceEnvironment['mediaDevices']>
  const Recorder = (environment.mediaRecorder
    ?? (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder) as typeof MediaRecorder
  // 实时电平与解码共用同一个构造器：`AudioCtx` 是非空断言的老写法（解码那条路一直
  // 靠它），而 `AudioCtor` 留成可空——电平表要能判断"这台机器到底有没有 Web Audio"。
  const AudioCtor = environment.audioContext
    ?? (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
  const AudioCtx = AudioCtor as typeof AudioContext
  const vad = vadConfigOf(options.vad)

  const abort = new AbortController()
  let cancelled = false
  let stopped = false
  /**
   * 「停」的意图可能在拿到麦克风**之前**就到了。
   *
   * 这不是假想：第一次用会弹权限框，用户很容易在这段时间里再点一下同一个按钮。
   * 那一刻录音机还没建起来，如果直接把这一下当成"重来"，用户看到的就是
   * 「点了没反应」——一个我们自己造出来的坏体验。所以记下这个意图：
   * 麦克风一到手就开始录音，好让这一下真的被兑现。
   */
  let stopRequested = false
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let meter: VoiceMeter | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let capTimer: ReturnType<typeof setTimeout> | undefined
  const startedAt = Date.now()

  const cleanup = (): void => {
    if (timer !== undefined) clearInterval(timer)
    if (capTimer !== undefined) clearTimeout(capTimer)
    timer = undefined; capTimer = undefined
    // 电平表排在 `stopTracks` 前面关：它自己的音频上下文也是一条挂着的输入路径，
    // 留在那里等于麦克风还没松手。四类收尾（按停、取消、卸载、设备被拔）都经过这里。
    meter?.close()
    meter = null
    stopTracks(stream)
    stream = undefined
  }
  const finish = (): void => { cleanup(); options.onPhase?.('idle'); options.onDone?.() }

  /**
   * 停止录音，走的是**用户按停**那一条路。
   *
   * 手动按停和端点自动收尾共用它：两条路必须以同样的方式落地，否则"说完自己停"和
   * "我按停"就会有两种行为（其中一种迟早会和宿主契约走散）。
   */
  const requestStop = (): void => {
    if (stopped || cancelled) return
    if (recorder === undefined) {
      // 还在等麦克风（多半是权限框开着）：记下意图，等录音机建起来就立刻停。
      stopRequested = true
      return
    }
    stopped = true
    try { recorder.stop() } catch { finish(); options.onFailure(new VoiceError('unsupported')) }
  }

  /**
   * 端点判定替用户收尾。
   *
   * 听过人声才走转写；**一句话都没说过就直接回空闲**：那段录音发给宿主，它必然回一次
   * `INVALID_AUDIO`——一次白活的往返，还会把"没说话"报成"识别失败"，用户按提示重来
   * 一遍仍然是静音。这里就地收尾，并且说清是"没听到声音"。
   * @param heard - 这次录音里有没有人声（`VadReading.heard`）。
   */
  const autoFinish = (heard: boolean): void => {
    if (stopped || cancelled) return
    if (heard) { requestStop(); return }
    stopped = true
    if (recorder !== undefined) {
      // 先摘掉 onstop，再停：录到的这点静音一个字节都不出去（和 cancel 同一手段）。
      recorder.onstop = null
      try { recorder.stop() } catch { /* 没开始录也没关系 */ }
    }
    finish()
    options.onFailure(new VoiceError('silent'))
  }

  /** 一次录音的最终去向：要么转写，要么丢弃。只走一次。 */
  const settle = (chunks: readonly Blob[], mimeType: string): void => {
    if (cancelled) { finish(); return }
    options.onPhase?.('transcribing')
    void transcribe(chunks, mimeType, environment, abort.signal, AudioCtx)
      .then((text) => {
        if (cancelled || abort.signal.aborted) return
        finish()
        options.onText(text)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        finish()
        options.onFailure(error instanceof VoiceError ? error : new VoiceError('network'))
      })
  }

  void (async () => {
    try {
      const acquired = await devices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (cancelled) { stopTracks(acquired); return }
      stream = acquired
    } catch {
      finish()
      // 麦克风没拿到一律算权限问题：`NotAllowedError`（用户拒了）、`NotFoundError`
      // （这台设备没有麦克风）、`NotReadableError`（被别的程序占用）对用户来说出路是同一个
      // ——去浏览器设置里看权限、确认设备。分成几个码只会让人多点一次「重试」。
      options.onFailure(new VoiceError('denied'))
      return
    }
    if (cancelled) { finish(); return }
    try {
      // 挑一个浏览器认的容器：手机上到处都有的是 WebM/Opus 或 MP4/AAC，不是 WAV。
      // 挑不到就交给浏览器定默认格式——后面统一解码重采样，容器是什么不影响宿主。
      // （宿主那一侧只认 WAV，见 wav.ts。）
      const mimeType = RECORDER_MIMES.find(candidate => Recorder.isTypeSupported?.(candidate) === true)
      recorder = mimeType === undefined ? new Recorder(stream as MediaStream) : new Recorder(stream as MediaStream, { mimeType })
    } catch {
      finish()
      options.onFailure(new VoiceError('unsupported'))
      return
    }
    const chunks: Blob[] = []
    const active = recorder
    active.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
    active.onstop = () => { if (stopped) settle(chunks, active.mimeType ?? '') }
    // 麦克风在录的过程中被拔掉/被别的程序抢走：不能假装还在录。
    for (const track of stream?.getTracks() ?? []) {
      track.addEventListener('ended', () => {
        if (stopped || cancelled) return
        stopped = true
        options.onFailure(new VoiceError('denied'))
        try { active.stop() } catch { /* 已经在停的路上了 */ }
        finish()
      })
    }
    try {
      active.start()
    } catch {
      finish()
      options.onFailure(new VoiceError('unsupported'))
      return
    }
    // 实时反馈 + 端点检测：两件都依赖同一件事——**能不能测到声音**。
    // 先读一帧再报"在录了"：界面第一帧就有电平条，而且立刻知道这次有没有实时反馈
    // （文案要说"说完自己会停"还是"说完再按一下"就靠它，见 VoiceInputState.meter）。
    meter = createVoiceMeter(stream as MediaStream, AudioCtor)
    const first = meter?.read() ?? null
    if (meter !== null && first !== null) options.onMeter?.(first)
    options.onPhase?.('recording')
    if (meter === null || first === null) {
      // 拿不到电平：**不装端点检测**，退回按一下才停的老路子。
      // 理由是测不到的静默 ≠ 用户没说话（可能是分析器没起来、设备被占），
      // 没有证据就替用户收尾，代价是把人正在说的半句话切掉。反馈可以少，决定不能瞎做。
      meter?.close()
      meter = null
      timer = setInterval(() => options.onElapsed?.(Date.now() - startedAt), 250)
    } else {
      const endpointer = new VoiceEndpointer(vad, startedAt)
      const live = meter
      timer = setInterval(() => {
        const now = Date.now()
        options.onElapsed?.(now - startedAt)
        const frame = live.read()
        // 分析器中途坏了（上下文被挂起、设备被抢走）：这一帧没有数据就不下结论，
        // 宁可让用户自己按停，也不拿上一帧的旧值判"他已经不说话了"。
        if (frame === null) return
        options.onMeter?.(frame)
        const step = endpointer.tick(frame.level, now)
        options.onVad?.(step.reading)
        if (step.end) autoFinish(step.reading.heard)
      }, vad.tickMs)
    }
    capTimer = setTimeout(() => {
      // 到上限自动停：让宿主来拒我们（413）比这里自己停更难解释。
      if (!stopped && !cancelled) { stopped = true; try { active.stop() } catch { finish() } }
    }, MAX_VOICE_MS)
    // 麦克风是在用户那一下「停」之后才到手的：现在补上，别让那一下落空。
    if (stopRequested && !stopped && !cancelled) { stopped = true; try { active.stop() } catch { finish() } }
  })()

  return {
    stop(): void { requestStop() },
    cancel(): void {
      if (cancelled) return
      cancelled = true
      abort.abort()
      if (stopped) { finish(); return }
      stopped = true
      if (recorder !== undefined) {
        // 先摘掉 onstop，再停：录音数据一个字节都不出去。
        recorder.onstop = null
        try { recorder.stop() } catch { /* 没开始录也没关系 */ }
      }
      finish()
    },
  }
}

/**
 * 解容器 → 重采样 → 编码成宿主认的 WAV → 上传。
 *
 * `MediaRecorder` 给的是压缩容器，必须先解码；`decodeAudioData` 之后我们拿到的
 * 才是可以重采样的裸样本。
 * @param chunks - `MediaRecorder` 攒下的数据块。
 * @param mimeType - 录音容器类型（解码失败时用于说明）。
 * @param environment - 可注入的 fetch。
 * @param signal - 取消上传。
 * @param AudioCtx - 音频上下文构造器。
 * @returns 识别文字。
 */
async function transcribe(
  chunks: readonly Blob[],
  mimeType: string,
  environment: VoiceEnvironment,
  signal: AbortSignal,
  AudioCtx: typeof AudioContext,
): Promise<string> {
  const recorded = new Blob([...chunks], { type: mimeType })
  // 太短的录音连宿主的下限（0.1 秒）都不到，本地就判掉，省一次注定失败的往返。
  if (recorded.size < 64) throw new VoiceError('no-speech')
  const decoded = await decode(recorded, AudioCtx).catch(() => { throw new VoiceError('no-speech') })
  const wav = encodeWav(decoded.getChannelData(0), decoded.sampleRate)
  if (wav.size < 44 + MIN_VOICE_BYTES) throw new VoiceError('no-speech')
  if (wav.size > MAX_VOICE_BYTES) throw new VoiceError('no-speech')
  return await transcribeWav(wav, signal, environment)
}

/**
 * 把压缩容器解成裸声道样本。
 * @param recorded - `MediaRecorder` 录出来的容器。
 * @param AudioCtx - 音频上下文构造器。
 * @returns 解码后的音频缓冲。
 */
async function decode(recorded: Blob, AudioCtx: typeof AudioContext): Promise<AudioBuffer> {
  const audio = new AudioCtx()
  try {
    // `slice(0)`：`decodeAudioData` 会**吞掉**传进去的 ArrayBuffer。
    return await audio.decodeAudioData(await recorded.slice(0).arrayBuffer())
  } finally {
    void audio.close().catch(() => { /* 关不掉不影响结果 */ })
  }
}
