// @vitest-environment jsdom
/**
 * 手机端语音输入「丝滑化」的验收测试：**录音时的实时反馈** + **说完自己收尾（VAD）**。
 *
 * 这一份盯的是两件事，都不是"函数被调用了"：
 *
 * 1. **等待被藏进说话的时间里**——用户开口之后，界面在动（电平条），说完了它自己收尾，
 *    全程不需要第二次触摸。断言落在"真的发了转写请求"和"界面真的出现了倒计时提示"上。
 * 2. **替用户做决定的那条线不许越界**——测不到声音的时候不许猜（不装端点检测）、
 *    一句话都没说的时候不许发空录音（宿主会回 `INVALID_AUDIO`，那是一次白活的往返）、
 *    用户随时按停随时算数。
 *
 * 为什么这里用**真计时器 + 真事件循环**，而不是 `vi.useFakeTimers()`：
 * 录音链路里 `Blob.arrayBuffer()` 要跨真实的事件循环才结算（上一轮的注释里写明了这一点），
 * 假计时器会把那条路和端点计时搅在一起，测出来的时序不再等于真机上的时序。
 * 所以阈值全部通过 `vad` 选项调小（这本来就是产品要求的可配置项），用例跑几十到几百毫秒。
 * 纯判定逻辑另有 `VoiceEndpointer` 的用例，那边用虚构的时间戳把每一档都算清楚。
 *
 * 替身的关键：**假 AnalyserNode 是有行为的**——`getFloatTimeDomainData(target)` 把
 * "此刻麦克风的样本"写进调用方给的数组。于是 `mic.amplitude = 0.3` 就是一句真话：
 * 现在麦克风收到的响度是 0.3（常量填满 ⇒ 它的 RMS 恰好是 0.3）。用例靠改这个值来
 * 模拟"用户说话 / 停下来"，而不是靠"调用即通过"的空壳。
 */
import { act, createElement, type FC } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, type AppProps } from '../src/App.tsx'
import { useVoiceInput, voiceNoteOf } from '../src/voice-input.ts'
import { METER_BARS, createVoiceMeter, displayLevel, frameOf, rmsLevel, type MeterFrame } from '../src/voice-meter.ts'
import { VoiceNoteRow } from '../src/voice-note-view.tsx'
import { VAD_DEFAULTS, VoiceEndpointer, vadConfigOf, vadHint, type VadConfig, type VadReading } from '../src/voice-vad.ts'
import {
  startVoiceInput,
  voiceSupport,
  type VoiceEnvironment,
  type VoicePhase,
  type VoiceSession,
} from '../src/voice.ts'

/**
 * 这一份里有真渲染的用例，React 需要这个标志才会把 `act()` 当成"排空更新"的作用域
 * （`app.spec.ts` 也是这么开的）。不开的话 `act` 只是一句警告，界面上什么都没刷新。
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 用例用的端点参数：把 1.8 秒的阈值压到 200 毫秒，好让每条用例跑几百毫秒而不是几秒。
 *
 * **这不是在测另一套逻辑**——`vadConfigOf` 就是把用户传的值当值用（只夹了会互相打架的
 * 那几项），所以这里跑的就是真机上那条判定，只是时间尺度小了。
 */
const FAST: Partial<VadConfig> = {
  silenceMs: 200,
  warningMs: 80,
  tickMs: 10,
  minSpeechMs: 40,
  speechLevel: 0.03,
}

/** 说话的音量：远高于 `speechLevel`（0.03）。 */
const SPEAKING = 0.3

// ─────────────────────────────── 替身 ───────────────────────────────

/**
 * 一台"音量可指定"的假麦克风。
 *
 * `amplitude` 就是此刻麦克风收到的响度；`closes` 数的是取样用的音频上下文被关掉几次
 * ——"关掉麦克风"是隐私边界，只靠肉眼看不出来，得有个能数的东西。
 */
interface Mic {
  amplitude: number
  readonly closes: { count: number }
}

/**
 * 造一台假麦克风。
 * @param amplitude - 初始音量。
 * @returns 可以被用例随时改音量的麦克风。
 */
function microphone(amplitude = 0): Mic {
  return { amplitude, closes: { count: 0 } }
}

/** 1 秒 16 kHz 的样本；只要求"有能量"，不做音频断言。 */
function speech(): Float32Array {
  const data = new Float32Array(16_000)
  for (let index = 0; index < data.length; index++) data[index] = Math.sin(index / 20) * 0.4
  return data
}

/** 一个 `AudioBuffer` 的替身；解码那条路只用到这几项。 */
function bufferOf(samples: Float32Array, rate = 16_000): AudioBuffer {
  return {
    sampleRate: rate,
    length: samples.length,
    duration: samples.length / rate,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer
}

/**
 * 同时充当「分析器载体」和「解码器」的假 `AudioContext`。
 *
 * 一个类身兼两职是刻意的：生产代码里这两处用的是**同一个构造器**（`voice.ts` 里
 * 一个 `AudioCtor`），替身分成两个类就测不出"浏览器只有一半能力"这种真实情况。
 * `analyser: false` 就是那一半——`createAnalyser` 根本不存在（等价于上一轮那份只实现
 * 解码的替身，也等价于真机上 Web Audio 受限的样子）。
 * @param mic - 音量来源。
 * @param options - `analyser: false` 表示这份实现没有分析器；`samples` 是解码结果。
 * @returns 可直接当 `AudioContext` 用的构造器。
 */
function fakeWebAudio(mic: Mic, options: { readonly analyser?: boolean; readonly samples?: Float32Array } = {}): typeof AudioContext {
  const decoded = options.samples ?? speech()
  class FakeSource {
    connect(): void { /* 不需要真的连 */ }
    disconnect(): void { /* 同上 */ }
  }
  class FakeAnalyser {
    fftSize = 1024
    connect(): void { /* 同上 */ }
    disconnect(): void { /* 同上 */ }
    /**
     * 真行为：把**此刻**的时域样本写进调用方给的数组。
     * 这里按当前音量填满——常量波形没有交流分量，RMS 就等于 amplitude 本身。
     */
    getFloatTimeDomainData(target: Float32Array): void {
      target.fill(mic.amplitude)
    }
  }
  class FakeContext {
    createAnalyser(): FakeAnalyser { return new FakeAnalyser() }
    createMediaStreamSource(): FakeSource { return new FakeSource() }
    decodeAudioData(): Promise<AudioBuffer> { return Promise.resolve(bufferOf(decoded)) }
    close(): Promise<void> { mic.closes.count += 1; return Promise.resolve() }
  }
  if (options.analyser === false) {
    // 「这台机器没有分析器」：连方法都不在，调用它会抛——和真实世界里能力缺失时
    // 调用方会撞上的东西一样，不是返回一个假值。
    delete (FakeContext.prototype as unknown as Record<string, unknown>).createAnalyser
  }
  return FakeContext as unknown as typeof AudioContext
}

/** jsdom 没有 `MediaStream`（上一轮的用例注释里核过），只替出被用到的那两个方法。 */
function fakeStream(): MediaStream {
  return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream
}

/** 一个录音机实例要断言的东西。 */
interface FakeRecorderInstance {
  readonly mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  stop(): void
  readonly stops: number
}

/**
 * `MediaRecorder` 的替身：真浏览器里 `dataavailable` 先于 `stop` 到达，这里照同样顺序。
 *
 * 只由会话的 `stop()` 触发——用例不自己去点替身，否则就绕过了状态机的前半段。
 * @returns 构造器与它造出来的实例列表。
 */
function fakeRecorder(): { readonly ctor: typeof MediaRecorder; readonly instances: FakeRecorderInstance[] } {
  const instances: FakeRecorderInstance[] = []
  class Fake {
    readonly mimeType: string
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    stops = 0
    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? 'audio/webm'
      instances.push(this as unknown as FakeRecorderInstance)
    }
    static isTypeSupported(): boolean { return true }
    start(): void { /* 用例靠改音量说话，不靠这里 */ }
    stop(): void {
      this.stops += 1
      this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: 'audio/webm;codecs=opus' }) })
      this.onstop?.()
    }
  }
  return { ctor: Fake as unknown as typeof MediaRecorder, instances }
}

/** 一个记录全部请求的 fetch；默认回成功。 */
function recordingFetch(): {
  readonly impl: typeof fetch
  readonly calls: { readonly url: string; readonly init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ text: '帮我看看这个报错' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

// ─────────────────────────────── 工具 ───────────────────────────────

/**
 * 让出一段时间（真实时间）。
 * @param ms - 毫秒。
 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等到条件成立；超时就把条件本身写进错误里，而不是丢一句 `undefined`。
 *
 * 用在**不依赖界面重渲染**的等待上（请求、回调、会话状态）。
 * @param predicate - 条件。
 * @param what - 条件的说明，用于失败信息。
 * @param timeoutMs - 上限。
 */
async function until(predicate: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`等了 ${timeoutMs}ms，"${what}"仍然没成立`)
}

/**
 * 等界面上的条件成立。
 *
 * 和 `until` 的区别是它每一轮都先 `await act(...)` 让出时间——**读 DOM 必须在 `act` 作用域
 * 之外**：`act` 里的更新要等作用域结束才排空，把断言写在 `act` 里面会自己把自己锁死
 * （第一版就是这么写的，界面用例全部超时）。这一版每条界面用例都靠它。
 * @param predicate - 读 DOM 的条件。
 * @param what - 条件的说明。
 * @param timeoutMs - 上限。
 */
async function renderedUntil(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await act(async () => { await sleep(5) })
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms，界面上的"${what}"仍然没出现`)
  }
}

/**
 * 让用户"说一会儿"再停。
 *
 * 必须有这一下：`minSpeechMs`（默认 200，用例里 40）要求**累计**够久的人声才算"说过话"，
 * 一声"啪"紧接着静音会被正确地判成"没听到声音"——那是端点该做的事，不是用例该绕过的。
 * 这里等的是阈值的数倍，判定那一侧不受这几毫秒影响。
 * @param ms - 说多久（麦克风的音量由调用方在这之前设好）。
 */
async function speakFor(ms: number): Promise<void> {
  await sleep(ms)
}

/** 一次录音会话收集到的全部回调，按发生顺序分开存。 */
interface Run {
  readonly session: VoiceSession
  readonly recorder: FakeRecorderInstance[]
  readonly phases: VoicePhase[]
  readonly frames: MeterFrame[]
  readonly readings: VadReading[]
  readonly texts: string[]
  readonly failures: string[]
  readonly messages: string[]
}

/** 用例开出来还没结束的会话，`afterEach` 统一收掉，免得计时器跨用例乱跑。 */
const openSessions: VoiceSession[] = []

/**
 * 起一次录音，把每条回调都收进数组。
 * @param options - 麦克风、参数、替身开关与请求实现。
 * @returns 会话与收集到的回调。
 */
function startRun(options: {
  readonly mic: Mic
  readonly fetch: typeof fetch
  readonly config?: Partial<VadConfig>
  readonly analyser?: boolean
  readonly onReading?: (reading: VadReading) => void
}): Run {
  const recorder = fakeRecorder()
  const phases: VoicePhase[] = []
  const frames: MeterFrame[] = []
  const readings: VadReading[] = []
  const texts: string[] = []
  const failures: string[] = []
  const messages: string[] = []
  const environment: VoiceEnvironment = {
    isSecureContext: true,
    workbenchServed: true,
    mediaDevices: { getUserMedia: async () => fakeStream() },
    mediaRecorder: recorder.ctor,
    audioContext: fakeWebAudio(options.mic, { analyser: options.analyser !== false }),
    fetch: options.fetch,
  }
  const session = startVoiceInput({
    environment,
    ...(options.config === undefined ? {} : { vad: options.config }),
    onPhase: (phase) => { phases.push(phase) },
    onMeter: (frame) => { frames.push(frame) },
    onVad: (reading) => { readings.push(reading); options.onReading?.(reading) },
    onText: (text) => { texts.push(text) },
    onFailure: (error) => { failures.push(error.kind); messages.push(error.message) },
  })
  openSessions.push(session)
  return { session, recorder: recorder.instances, phases, frames, readings, texts, failures, messages }
}

/**
 * 等这次录音真的开始（`getUserMedia` 是异步的）。
 * @param run - 一次录音。
 */
async function running(run: Run): Promise<void> {
  await until(() => run.phases.includes('recording'), '录音真的开始了')
  expect(run.recorder).toHaveLength(1)
}

/** 把请求体读成字节，用来核对它仍然是宿主认的那一种 WAV。 */
async function wavBytes(init: RequestInit | undefined): Promise<{ bytes: Uint8Array; view: DataView }> {
  const body = init?.body
  expect(body).toBeInstanceOf(Blob)
  const bytes = new Uint8Array(await (body as Blob).arrayBuffer())
  return { bytes, view: new DataView(bytes.buffer) }
}

// ─────────────────────── 纯函数：电平 ───────────────────────

describe('电平：把样本算成能画的东西', () => {
  it('RMS 就是响度：常量样本的 RMS 等于它的幅值', () => {
    expect(rmsLevel(new Float32Array(512).fill(0.5))).toBeCloseTo(0.5, 5)
    expect(rmsLevel(new Float32Array(512))).toBe(0)
    // 正负相抵的交流信号不会算成 0：RMS 先平方再平均，符号被消掉。
    const wave = new Float32Array([0.5, -0.5, 0.5, -0.5])
    expect(rmsLevel(wave)).toBeCloseTo(0.5, 5)
  })

  it('空段与越界取不到负数：不能把 NaN 漏进样式', () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0)
    expect(rmsLevel(new Float32Array(10).fill(1), 5, 5)).toBe(0)
    expect(rmsLevel(new Float32Array(10).fill(1), 20, 30)).toBe(0)
  })

  it('一帧分 5 段：段数对得上，整帧值是原始 RMS', () => {
    const frame = frameOf(new Float32Array(500).fill(0.4), METER_BARS)
    expect(frame.bars).toHaveLength(METER_BARS)
    for (const bar of frame.bars) expect(bar).toBeCloseTo(0.4, 5)
    expect(frame.level).toBeCloseTo(0.4, 5)
  })

  it('显示曲线：静音是 0，越响越高，满幅不超 1，脏数据归 0', () => {
    expect(displayLevel(0)).toBe(0)
    expect(displayLevel(-1)).toBe(0)
    expect(displayLevel(Number.NaN)).toBe(0)
    expect(displayLevel(1)).toBe(1)
    // 单调：更响的一定不更矮。
    expect(displayLevel(0.2)).toBeGreaterThan(displayLevel(0.05))
    expect(displayLevel(0.6)).toBeGreaterThan(displayLevel(0.2))
    // 说话那一段（0.05~0.3）必须抬离底部，否则条子在手机上就是几个像素的抖动。
    expect(displayLevel(0.05)).toBeGreaterThan(0.3)
    expect(displayLevel(0.3)).toBeGreaterThan(0.9)
  })

  it('拿不到 AudioContext：返回 null，不抛', () => {
    const mic = microphone()
    expect(createVoiceMeter(fakeStream(), undefined)).toBeNull()
    expect(createVoiceMeter(fakeStream(), fakeWebAudio(mic, { analyser: false }))).toBeNull()
  })

  it('拿得到：读一帧就是当前音量，关掉之后再读就是 null', () => {
    const mic = microphone(0.25)
    const meter = createVoiceMeter(fakeStream(), fakeWebAudio(mic))
    expect(meter).not.toBeNull()
    const first = meter?.read() ?? null
    expect(first?.level).toBeCloseTo(0.25, 5)
    mic.amplitude = 0.5
    expect((meter?.read() ?? null)?.level).toBeCloseTo(0.5, 5)
    meter?.close()
    expect(meter?.read()).toBeNull()
    expect(mic.closes.count).toBe(1)
    meter?.close()
    expect(mic.closes.count).toBe(1)
  })
})

// ─────────────────────── 纯函数：端点判定 ───────────────────────

describe('端点判定：什么时候替用户收尾', () => {
  const config = vadConfigOf({ silenceMs: 1_800, warningMs: 700, tickMs: 100, minSpeechMs: 200 })

  it('一直在说话：喂多久都不收尾（计时被每一帧重置）', () => {
    const vad = new VoiceEndpointer(config, 0)
    let end = false
    for (let at = 100; at <= 10_000; at += 100) end = vad.tick(0.2, at).end || end
    expect(end).toBe(false)
  })

  it('说过话再静默：静默满 1.8 秒才收尾，并且知道"说过话"', () => {
    const vad = new VoiceEndpointer(config, 0)
    let step = vad.tick(0.2, 100)
    step = vad.tick(0.2, 200)
    step = vad.tick(0.2, 300)
    expect(step.reading.heard).toBe(true)
    // 静默 1.7 秒：还在等（并且已经在提示里）
    step = vad.tick(0, 2_000)
    expect(step.end).toBe(false)
    expect(step.reading.phase).toBe('closing')
    expect(step.reading.remainingMs).toBe(100)
    // 静默满 1.8 秒：收尾
    step = vad.tick(0, 2_100)
    expect(step.end).toBe(true)
    expect(step.reading.heard).toBe(true)
  })

  it('一个字都没说：同样在 1.8 秒收尾，但 heard 是 false（这条决定要不要发请求）', () => {
    const vad = new VoiceEndpointer(config, 0)
    // 还没到点：已经在提示"还没听到声音"，但还没收
    const early = vad.tick(0, 1_700)
    expect(early.end).toBe(false)
    expect(early.reading.phase).toBe('closing')
    expect(early.reading.heard).toBe(false)
    // 到点：收尾，而且明确知道"没人说过话"
    const late = vad.tick(0, 1_800)
    expect(late.end).toBe(true)
    expect(late.reading.heard).toBe(false)
  })

  it('收尾只会来一次', () => {
    const vad = new VoiceEndpointer(config, 0)
    expect(vad.tick(0, 1_900).end).toBe(true)
    expect(vad.tick(0, 2_000).end).toBe(false)
    expect(vad.tick(0.5, 2_100).end).toBe(false)
  })

  it('倒计时里再出声：回到"在听"，收尾不再来', () => {
    const vad = new VoiceEndpointer(config, 0)
    vad.tick(0.2, 100)
    vad.tick(0.2, 200)
    // 静默 1.5 秒：正在倒计时（还剩 300 毫秒），但**还没**替用户做决定
    const warning = vad.tick(0, 1_500)
    expect(warning.reading.phase).toBe('closing')
    expect(warning.end).toBe(false)
    // 用户接着说了：计时归零，倒计时作废
    const again = vad.tick(0.2, 1_600)
    expect(again.end).toBe(false)
    expect(again.reading.phase).toBe('listening')
    expect(again.reading.silencedMs).toBe(0)
    // 之后一直说下去也不会被切
    expect(vad.tick(0.2, 9_000).end).toBe(false)
  })

  it('一声咳嗽（不到 minSpeechMs）不算"说过话"', () => {
    const vad = new VoiceEndpointer(config, 0)
    expect(vad.tick(0.2, 100).reading.heard).toBe(false)
    expect(vad.tick(0, 2_000).reading.heard).toBe(false)
  })

  it('提示文案：两档分开写，不是一句笼统的"要停了"', () => {
    expect(vadHint({ phase: 'listening', heard: true, silencedMs: 0, remainingMs: 1_800 })).toBeNull()
    expect(vadHint({ phase: 'waiting', heard: false, silencedMs: 0, remainingMs: 1_800 })).toBeNull()
    const spoken = vadHint({ phase: 'closing', heard: true, silencedMs: 1_500, remainingMs: 300 })
    const quiet = vadHint({ phase: 'closing', heard: false, silencedMs: 1_500, remainingMs: 300 })
    expect(spoken).toContain('好像说完了')
    expect(spoken).toContain('0.3s')
    expect(quiet).toContain('还没听到声音')
    expect(spoken).not.toBe(quiet)
  })
})

describe('端点参数：有默认值，也能被选项改掉', () => {
  it('默认阈值落在 1.5~2 秒，并且有可见提示的窗口', () => {
    expect(VAD_DEFAULTS.silenceMs).toBeGreaterThanOrEqual(1_500)
    expect(VAD_DEFAULTS.silenceMs).toBeLessThanOrEqual(2_000)
    expect(VAD_DEFAULTS.warningMs).toBeGreaterThanOrEqual(500)
    expect(VAD_DEFAULTS.warningMs).toBeLessThan(VAD_DEFAULTS.silenceMs)
    expect(vadConfigOf()).toEqual(VAD_DEFAULTS)
  })

  it('只改想改的那一项，其余照默认', () => {
    const config = vadConfigOf({ silenceMs: 2_500 })
    expect(config.silenceMs).toBe(2_500)
    expect(config.warningMs).toBe(VAD_DEFAULTS.warningMs)
    expect(config.speechLevel).toBe(VAD_DEFAULTS.speechLevel)
  })

  it('会互相打架的值被夹回合理范围，脏值一律退回默认', () => {
    expect(vadConfigOf({ silenceMs: 500, warningMs: 5_000 }).warningMs).toBe(500)
    expect(vadConfigOf({ silenceMs: 500, minSpeechMs: 5_000 }).minSpeechMs).toBe(500)
    // 太小（但合法）的取帧间隔被抬到下限，免得转成一个停不下来的循环
    expect(vadConfigOf({ tickMs: 5 }).tickMs).toBe(10)
    // 不合法的值（0、负数、NaN）整体退回默认
    expect(vadConfigOf({ tickMs: 0 }).tickMs).toBe(VAD_DEFAULTS.tickMs)
    expect(vadConfigOf({ silenceMs: Number.NaN }).silenceMs).toBe(VAD_DEFAULTS.silenceMs)
    expect(vadConfigOf({ speechLevel: -1 }).speechLevel).toBe(VAD_DEFAULTS.speechLevel)
  })
})

// ─────────────────── 会话：说完自己停（真计时器） ───────────────────

describe('录音会话：说完自己收尾', () => {
  it('说完静默超过阈值：自动停止，**真的发了**转写请求，文字回得来', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)
    await until(() => run1.readings.some(reading => reading.heard), '判定到"用户说过话"')

    // 用户不说话了；也没有任何人按停。
    mic.amplitude = 0
    await until(() => calls.length === 1, '自动收尾发出了转写请求')

    expect(calls[0]?.url).toBe('/api/forge/voice/transcribe')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('audio/wav')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
    // 自动收尾走的是**同一条**转写路径：请求体仍然是宿主认的那种 WAV。
    const { bytes, view } = await wavBytes(calls[0]?.init)
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(40, true)).toBeGreaterThanOrEqual(3_200)

    await until(() => run1.texts.length === 1, '文字回到调用方')
    expect(run1.texts).toEqual(['帮我看看这个报错'])
    expect(run1.failures).toEqual([])
    expect(run1.phases.at(-1)).toBe('idle')
  })

  it('一直在说话：过了好几个阈值也不收尾，静下来才收', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)

    // 一直说着，跑过 4 个阈值那么久。判定要是没有"被声音重置"，这里早就停了。
    await sleep((FAST.silenceMs ?? 200) * 4)
    expect(calls).toHaveLength(0)
    expect(run1.failures).toEqual([])
    expect(run1.phases).toContain('recording')
    // 更不能出现"好像说完了"——那等于在人家说话中间举刀。
    expect(run1.readings.filter(reading => reading.phase === 'closing')).toEqual([])

    // 真正停下来之后才收尾（同时证明端点确实装着，只是没到点）。
    mic.amplitude = 0
    await until(() => calls.length === 1, '静下来之后收尾')
  })

  it('一句话都没说就静默到点：回空闲、**一个请求都不发**、并且说清是没听到声音', async () => {
    const mic = microphone(0)
    const { impl, calls } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)

    await until(() => run1.failures.length === 1, '本地收尾并给出说明')
    expect(calls).toHaveLength(0)
    expect(run1.failures).toEqual(['silent'])
    expect(run1.messages[0]).toContain('没听到')
    expect(run1.texts).toEqual([])
    expect(run1.phases.at(-1)).toBe('idle')
    // 静音录音一个字节都没出去：录音机被停掉，但 onstop 那条上传路已被摘掉。
    expect(run1.recorder[0]?.stops).toBe(1)
    expect(run1.readings.at(-1)?.heard).toBe(false)
  })

  it('自动收尾前先给可见提示：提示出现时请求**还没发**，倒计时走完才收', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    // 提示出现那一刻的现场：这会儿已经发了几个请求？还剩多少毫秒？
    const atHint: { calls: number; remainingMs: number; text: string | null }[] = []
    const run1 = startRun({
      mic,
      fetch: impl,
      config: FAST,
      onReading: (reading) => {
        if (reading.phase === 'closing') {
          atHint.push({ calls: calls.length, remainingMs: reading.remainingMs, text: vadHint(reading) })
        }
      },
    })
    await running(run1)
    await until(() => run1.readings.some(reading => reading.heard), '判定到"用户说过话"')
    mic.amplitude = 0
    await until(() => atHint.length > 0, '出现收尾提示')

    expect(atHint[0]?.calls).toBe(0)
    expect(atHint[0]?.remainingMs).toBeGreaterThan(0)
    expect(atHint[0]?.text).toContain('好像说完了')
    // 提示是**接着往下走**的：秒数在减少，不是一句话挂在那里。
    await until(() => atHint.length > 2, '提示连续刷新')
    expect(atHint.at(-1)?.remainingMs).toBeLessThan(atHint[0]?.remainingMs ?? 0)

    await until(() => calls.length === 1, '倒计时走完才收尾')
  })

  it('倒计时里用户又接着说：收尾被取消，不会被误切', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)
    await until(() => run1.readings.some(reading => reading.heard), '判定到"用户说过话"')

    mic.amplitude = 0
    await until(() => run1.readings.some(reading => reading.phase === 'closing'), '进入收尾倒计时')
    mic.amplitude = SPEAKING
    await sleep((FAST.silenceMs ?? 200) * 2)

    expect(calls).toHaveLength(0)
    expect(run1.readings.at(-1)?.phase).toBe('listening')
    expect(run1.phases).toContain('recording')
  })

  it('手动按停仍然立即生效：话说到一半也能停，不等阈值', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)
    await sleep(40) // 远没到 200ms 的阈值
    expect(calls).toHaveLength(0)

    run1.session.stop()
    await until(() => calls.length === 1, '按停之后立刻转写')
    // 停的时候用户还在说话（音量没变过），说明这一次不是端点替他做的决定。
    expect(mic.amplitude).toBe(SPEAKING)
    expect(run1.readings.filter(reading => reading.phase === 'closing')).toEqual([])
  })

  it('倒计时里用户按停：立刻转写，不陪着倒计时等完', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)
    await until(() => run1.readings.some(reading => reading.heard), '判定到"用户说过话"')
    mic.amplitude = 0
    await until(() => run1.readings.some(reading => reading.phase === 'closing'), '进入收尾倒计时')

    run1.session.stop()
    await until(() => calls.length === 1, '按停之后立刻转写')
  })

  it('端点收尾也会把麦克风松开（取样上下文被关闭）', async () => {
    const mic = microphone(SPEAKING)
    const { impl } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)
    mic.amplitude = 0
    await until(() => run1.failures.length + run1.texts.length > 0 || run1.phases.at(-1) === 'idle', '这次录音结束')
    await sleep(20)
    expect(mic.closes.count).toBe(1)
  })
})

describe('降级：拿不到实时电平就不替用户做决定', () => {
  it('没有分析器：不装端点检测——一直录到用户自己按停，绝不猜"他是不是说完了"', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST, analyser: false })
    await running(run1)

    // 跑过阈值好几倍：既没有请求，也没有"没听到声音"。
    // 测不到的静默 ≠ 用户没说话，没有证据就不能收尾。
    await sleep((FAST.silenceMs ?? 200) * 3)
    expect(calls).toHaveLength(0)
    expect(run1.failures).toEqual([])
    expect(run1.phases).toContain('recording')
    // 界面拿不到电平条，只能显示文字（这是唯一的降级动作）。
    expect(run1.frames).toEqual([])
    expect(run1.readings).toEqual([])

    run1.session.stop()
    await until(() => calls.length === 1, '手动按停照样能用')
  })

  it('实时电平是"活着"的：说话时条子比静音时高', async () => {
    const mic = microphone(0)
    const { impl } = recordingFetch()
    const run1 = startRun({ mic, fetch: impl, config: FAST })
    await running(run1)
    await until(() => run1.frames.length > 1, '电平帧')
    const quiet = run1.frames.at(-1)?.bars ?? []

    mic.amplitude = SPEAKING
    await until(() => (run1.frames.at(-1)?.bars ?? []).some(value => value > 0.5), '条子跟着声音跳上去')
    const loud = run1.frames.at(-1)?.bars ?? []
    expect(loud).toHaveLength(METER_BARS)
    expect(Math.max(...loud)).toBeGreaterThan(Math.max(...quiet))
  })
})

// ─────────────────────── 界面（真实渲染） ───────────────────────

/**
 * 挂一个用真实 hook + 真实提示行组件的最小界面。
 *
 * `voiceNoteOf` 和 `VoiceNoteRow` 都是**生产代码本身**（`App.tsx` 里调的是同一个函数、
 * 同一个组件），所以这里断言到的文案与结构就是用户看到的那一份；差异只在外面套的壳。
 */
function renderMic(options: {
  readonly mic: Mic
  readonly analyser?: boolean
  readonly config?: Partial<VadConfig>
  readonly fetch: typeof fetch
}): {
  readonly container: HTMLElement
  readonly draft: { value: string }
  readonly unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const environment: VoiceEnvironment = {
    isSecureContext: true,
    workbenchServed: true,
    mediaDevices: { getUserMedia: async () => fakeStream() },
    mediaRecorder: fakeRecorder().ctor,
    audioContext: fakeWebAudio(options.mic, { analyser: options.analyser !== false }),
    fetch: options.fetch,
  }
  const draft = { value: '' }
  const support = voiceSupport(environment)
  let root: Root
  function Harness() {
    const voice = useVoiceInput({
      draft: draft.value,
      onDraft: (value) => { draft.value = value },
      support,
      environment,
      ...(options.config === undefined ? {} : { vad: options.config }),
    })
    return createElement('div', null,
      createElement('button', {
        className: 'composer-mic',
        disabled: !support.ok,
        onClick: voice.toggle,
        'aria-label': '语音输入',
      }),
      createElement(VoiceNoteRow, {
        note: voiceNoteOf(voice),
        bars: voice.meter,
        recording: voice.phase === 'recording',
        closing: voice.hint !== null,
      }))
  }
  act(() => { root = createRoot(container); root.render(createElement(Harness)) })
  return { container, draft, unmount: () => { act(() => root.unmount()); container.remove() } }
}

/** 点一下麦克风；点击留在 `act` 里，好让它带出来的那次渲染当场排空。 */
function clickMic(container: HTMLElement): void {
  const button = container.querySelector('button.composer-mic') as HTMLButtonElement
  act(() => { button.click() })
}

/** 读出电平条现在的高度（`voice-note-view.tsx` 把高度写在内联样式里）。 */
function barHeights(container: HTMLElement): number[] {
  return [...container.querySelectorAll('.voice-meter i')].map(
    node => Number.parseFloat((node as HTMLElement).style.height) || 0,
  )
}

/** 提示行上的那一句话。 */
function noteText(container: HTMLElement): string {
  return container.querySelector('.voice-note')?.textContent ?? ''
}

describe('界面：跟着声音跳的电平条 + 看得见的收尾提示', () => {
  it('录音时出现电平条，随声音变高，不是干等一个转圈', async () => {
    const mic = microphone(0)
    const { impl } = recordingFetch()
    const view = renderMic({ mic, config: FAST, fetch: impl })
    try {
      clickMic(view.container)
      await renderedUntil(() => barHeights(view.container).length > 0, '电平条出现')
      expect(barHeights(view.container)).toHaveLength(METER_BARS)
      expect(noteText(view.container)).toContain('正在听')
      // 静音时是留底的矮条（不是 0），这样用户知道"这里本来就该有东西"。
      const quiet = Math.max(...barHeights(view.container))
      expect(quiet).toBeLessThanOrEqual(4)

      mic.amplitude = SPEAKING
      await renderedUntil(() => Math.max(...barHeights(view.container)) > quiet + 4, '条子跟着声音跳上去')
      expect(Math.max(...barHeights(view.container))).toBeGreaterThan(quiet)
      // 电平条不给屏幕阅读器读：每秒变十次的东西读出来只是噪声。
      expect(view.container.querySelector('.voice-meter')?.getAttribute('aria-hidden')).toBe('true')
    } finally { view.unmount() }
  }, 15_000)

  it('自动收尾前提示出现在界面上，并且换了颜色档', async () => {
    const mic = microphone(SPEAKING)
    const { impl } = recordingFetch()
    const view = renderMic({ mic, config: FAST, fetch: impl })
    try {
      clickMic(view.container)
      await renderedUntil(() => barHeights(view.container).length > 0, '电平条出现')
      await speakFor(150)
      mic.amplitude = 0
      await renderedUntil(() => noteText(view.container).includes('好像说完了'), '收尾提示出现在界面上')
      expect(view.container.querySelector('.voice-note')?.className).toContain('closing')
      expect(noteText(view.container)).toMatch(/好像说完了… \d\.\ds 后自动结束/)
    } finally { view.unmount() }
  }, 15_000)

  it('说话 → 自动收尾 → 文字进输入框：整条路没有人按第二次', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    const view = renderMic({ mic, config: FAST, fetch: impl })
    try {
      clickMic(view.container)
      await renderedUntil(() => barHeights(view.container).length > 0, '电平条出现')
      await speakFor(150)
      mic.amplitude = 0
      // 没有人按第二次：收尾、转写、文字进输入框，全靠端点自己走到头。
      await renderedUntil(() => view.draft.value.length > 0, '文字进了输入框')
      expect(calls).toHaveLength(1)
      expect(view.draft.value).toBe('帮我看看这个报错')
      // 收尾之后提示行收回去，界面回到"没事发生"的样子。
      await renderedUntil(() => noteText(view.container) === '', '提示行收回去')
    } finally { view.unmount() }
  }, 15_000)

  it('降级：拿不到分析器时只显示文字，界面不崩、也不承诺"说完自己停"', async () => {
    const mic = microphone(SPEAKING)
    const { impl } = recordingFetch()
    const view = renderMic({ mic, analyser: false, config: FAST, fetch: impl })
    try {
      clickMic(view.container)
      await act(async () => { await sleep(60) })
      expect(view.container.querySelector('.voice-meter')).toBeNull()
      expect(noteText(view.container)).toContain('说完再按一下结束')
      expect(noteText(view.container)).not.toContain('自己会停')
      expect(view.container.querySelector('.composer-mic')).not.toBeNull()
    } finally { view.unmount() }
  })

  it('拿不到麦克风权限：说的是权限，界面不白屏', async () => {
    const mic = microphone(0)
    const { impl } = recordingFetch()
    const container = document.createElement('div')
    document.body.append(container)
    const environment: VoiceEnvironment = {
      isSecureContext: true,
      workbenchServed: true,
      mediaDevices: { getUserMedia: async () => { throw new Error('denied') } },
      mediaRecorder: fakeRecorder().ctor,
      audioContext: fakeWebAudio(mic),
      fetch: impl,
    }
    const support = voiceSupport(environment)
    let root: Root
    function Harness() {
      const voice = useVoiceInput({ draft: '', onDraft: () => { /* 不关心 */ }, support, environment })
      return createElement('div', null,
        createElement('button', { className: 'composer-mic', onClick: voice.toggle }),
        createElement(VoiceNoteRow, {
          note: voiceNoteOf(voice),
          bars: voice.meter,
          recording: voice.phase === 'recording',
          closing: voice.hint !== null,
        }))
    }
    act(() => { root = createRoot(container); root.render(createElement(Harness)) })
    try {
      clickMic(container)
      await renderedUntil(() => noteText(container).includes('权限'), '说明权限问题')
      // 失败之后按钮还在、还能再点一次；没有电平条（这一次根本没开始录）。
      expect(container.querySelector('button.composer-mic')).not.toBeNull()
      expect(container.querySelector('.voice-meter')).toBeNull()
    } finally { act(() => root.unmount()); container.remove() }
  }, 15_000)
})

describe('视图：提示行长什么样', () => {
  it('没有话要说就整行不渲染（上一轮的行为，不留空行）', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(VoiceNoteRow, { note: null, bars: [], recording: false, closing: false }))
    })
    expect(container.querySelector('.voice-note')).toBeNull()
    act(() => root.unmount())
    container.remove()
  })

  it('电平条的段数与高度跟着数据走，越界值被夹住', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(VoiceNoteRow, {
        note: '正在听 1s… 说完自己会停',
        bars: [0, 0.5, 1, 2, Number.NaN],
        recording: true,
        closing: false,
      }))
    })
    const heights = barHeights(container)
    expect(heights).toHaveLength(METER_BARS)
    // 静音也有底（3px），满幅封顶 16px，脏值当静音——都不能漏进样式里。
    expect(heights[0]).toBe(3)
    expect(heights[2]).toBe(16)
    expect(heights[3]).toBe(16)
    expect(heights[4]).toBe(3)
    expect(heights[1]).toBeGreaterThan(heights[0])
    expect(container.querySelector('.voice-note')?.className).toContain('listening')
    act(() => root.unmount())
    container.remove()
  })
})

// ─────────────── 真实的 App：这条线确实接在界面上 ───────────────

/**
 * 手机端语音有两个开关不看注入、只看运行时环境：`isSecureContext` 与
 * `import.meta.env.BASE_URL`（`workbenchServed()` 用它判断"这个页面是不是工作台提供的"）。
 * 这个文件的其余用例走注入，只有「真实 App」这一组必须把它们摆成真机的样子——
 * 摆的是**值**，不是被测逻辑：`voiceSupport()` 本身一个字都没改。
 */
function stubPhoneRuntime(mic: Mic, fetchImpl: typeof fetch): void {
  vi.stubEnv('BASE_URL', '/mobile/')
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('MediaRecorder', fakeRecorder().ctor)
  vi.stubGlobal('AudioContext', fakeWebAudio(mic))
  vi.stubGlobal('fetch', fetchImpl)
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia: async () => fakeStream() },
    configurable: true,
  })
}

describe('真实的 App：语音行确实接在界面上', () => {
  const AppElement: FC<AppProps> = App

  it('点麦克风 → 电平条出现在真实界面上 → 自动收尾 → 文字真的进了输入框', async () => {
    const mic = microphone(SPEAKING)
    const { impl, calls } = recordingFetch()
    // App 自己还会打别的接口（账号、版本）；这里只关心语音那一条，别的给个空的 JSON。
    const routed = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/forge/voice/transcribe')) return impl(input, init)
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    stubPhoneRuntime(mic, routed)

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(createElement(AppElement, {})) })
    try {
      const button = container.querySelector('[aria-label="语音输入"]') as HTMLButtonElement | null
      expect(button).not.toBeNull()
      // 门禁的判定一个字都没改：这个页面被当成"工作台自己提供的 + 安全上下文"，按钮才可点。
      expect(button?.disabled).toBe(false)
      act(() => { button?.click() })

      await renderedUntil(() => barHeights(container).length > 0, '真实界面上的电平条')
      expect(barHeights(container)).toHaveLength(METER_BARS)
      expect(container.querySelector('.voice-note')?.textContent).toContain('说完自己会停')

      // 这里**不传** `vad`：走的就是产品默认的 1.8 秒阈值，真界面上的行为。
      await speakFor(500)
      mic.amplitude = 0
      await renderedUntil(() => calls.length === 1, '自动收尾发出转写请求')
      await renderedUntil(() => (container.querySelector('input')?.value ?? '').length > 0, '文字进了输入框')
      expect(container.querySelector('input')?.value).toBe('帮我看看这个报错')
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  }, 20_000)
})

afterEach(() => {
  for (const session of openSessions.splice(0)) session.cancel()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
