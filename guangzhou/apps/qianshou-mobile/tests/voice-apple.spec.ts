// @vitest-environment jsdom
/**
 * 手机端「苹果自带语音识别」的验收测试。
 *
 * 这一份盯的是**用户能看见的行为**，不是"函数被调用了"：
 *
 * 1. **边说边出字**：`isFinal === false` 的中间结果立刻出现，而且是**整段替换**
 *    （同一句话在长出来），不是一截截往后接成"你好你好世界"；
 * 2. **说完进输入框、不发送**：最终文字落到真实 `<input>` 上，一个请求都没发生；
 * 3. **每种失败各有各的话**：`onerror` 的各码处置不同，文案就不能共用一句；
 * 4. **没有 Web Speech 就回退**：这条路不存在时真的走宿主那条（断言真的 POST 了）；
 * 5. **取消是硬的**：取消之后不再接收结果、不发请求、输入框不动；
 * 6. **宿主 503 说的是"模型没装"**，不是让用户去查网络（这条是本轮的显式要求）。
 *
 * 替身的关键：`FakeSpeechRecognition` **是有行为的**——`speak()` 模拟"同一句话在变长"
 * （results 只有一条，内容被替换），`finish()` 模拟定稿，`fail(code)` 模拟真实现的行为
 * （错误之后必跟一个 `end`）。它还会**记下生产代码设了哪些属性**（`lang`/`continuous`/
 * `interimResults`），于是"语言是中文""单句模式"这些取舍是被断言的，不是靠注释自称。
 *
 * 用 `.spec.ts`（不是 `.tsx`）：根 vitest 配置里手机端只收 `.spec.ts`，所以这里用
 * `createElement` 写元素。
 */
import { act, createElement, useState, type FC, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, type AppProps } from '../src/App.tsx'
import { useVoiceInput, voiceNoteOf } from '../src/voice-input.ts'
import { VoiceNoteRow } from '../src/voice-note-view.tsx'
import {
  appleSpeechSupport,
  speechRecognitionCtor,
  startAppleSpeech,
  voiceRouteOf,
  type SpeechEnvironment,
  type SpeechRecognitionCtor,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultLike,
  type SpeechRecognitionResultListLike,
} from '../src/voice-apple.ts'
import {
  TRANSCRIBE_PATH,
  VOICE_COPY,
  VoiceError,
  transcribeWav,
  voiceSupport,
  type VoiceEnvironment,
  type VoiceFailureKind,
  type VoicePhase,
  type VoiceSession,
} from '../src/voice.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ─────────────────────── 替身：真的会"说话"的 SpeechRecognition ───────────────────────

/** 按真实的结果形状拼一份 `results`：数组样（`length` + 数字下标）。 */
function resultsOf(entries: readonly { readonly transcript: string; readonly isFinal: boolean }[]): SpeechRecognitionResultListLike {
  const list: Record<number, SpeechRecognitionResultLike> & { length: number } = { length: entries.length }
  entries.forEach((entry, index) => {
    list[index] = { isFinal: entry.isFinal, length: 1, 0: { transcript: entry.transcript, confidence: 0.9 } }
  })
  return list as unknown as SpeechRecognitionResultListLike
}

/**
 * `SpeechRecognition` 的替身。
 *
 * 它模拟的是**真实实现会做的事**，不是"调用即通过"的空壳：
 * - `start()` 会触发 `onstart`；已经在跑时再 `start()` 抛（真实现抛 `InvalidStateError`）；
 * - `speak()` 给一条还在变的中间结果（iOS 上就是这一种：results 只有一条，内容被替换）；
 * - `emitSegments()` 给 Chrome 那种"结果一条条往后加、`resultIndex` 指向新的那条"的形状；
 * - `finish()` 给定稿结果；`fail(code)` 先给错误、再给 `end`（真实现就是这么收尾的）；
 * - `abort()` 触发 `onend`，且**之后不再给结果**（真实现里 abort 就是丢弃）。
 */
class FakeSpeechRecognition implements SpeechRecognitionLike {
  static instances: FakeSpeechRecognition[] = []
  /** 置真时 `start()` 直接抛：用来覆盖"上一句还没结束/设备不允许"那条路。 */
  static refuseStart = false

  lang = ''
  continuous = true
  interimResults = false
  maxAlternatives = 0
  onstart: (() => void) | null = null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null
  onend: (() => void) | null = null

  starts = 0
  stops = 0
  aborts = 0
  /** abort 之后一律闭嘴：这是替身对"取消即断开"的模拟。 */
  private dead = false

  constructor() {
    FakeSpeechRecognition.instances.push(this)
  }

  start(): void {
    if (FakeSpeechRecognition.refuseStart) throw new Error('InvalidStateError: recognition has already started')
    this.starts += 1
    this.onstart?.()
  }

  stop(): void {
    this.stops += 1
  }

  abort(): void {
    this.aborts += 1
    this.dead = true
    this.onend?.()
  }

  /** 一句还在变的中间结果（`isFinal === false`）。 */
  speak(text: string): void {
    if (this.dead) return
    this.onresult?.({ resultIndex: 0, results: resultsOf([{ transcript: text, isFinal: false }]) })
  }

  /** 定稿（`isFinal === true`）——真实现里说完一句就是这样。 */
  finish(text: string): void {
    if (this.dead) return
    this.onresult?.({ resultIndex: 0, results: resultsOf([{ transcript: text, isFinal: true }]) })
  }

  /** `resultIndex` 指向新增的那一条，之前的是已经报过的（Chrome 的形状）。 */
  emitSegments(entries: readonly { readonly transcript: string; readonly isFinal: boolean }[]): void {
    this.emit(entries, Math.max(0, entries.length - 1))
  }

  /**
   * 指定 `resultIndex` 的一次结果。
   *
   * 两种形状都要能模拟，因为它们对应真实引擎的两种时刻：
   * - `resultIndex` 指向**新加的那条**（Chrome 常见的追加形状）；
   * - `resultIndex === 0` 且一次给两条（引擎把前半句定稿、后半句还在变的那种时刻）。
   * @param entries - 这次事件里的全部结果。
   * @param resultIndex - 从哪一条起算增量。
   */
  emit(entries: readonly { readonly transcript: string; readonly isFinal: boolean }[], resultIndex: number): void {
    if (this.dead) return
    this.onresult?.({ resultIndex, results: resultsOf(entries) })
  }

  /** 报错并按真实行为收尾（错误之后必有 `end`）。 */
  fail(code: string): void {
    if (this.dead) return
    this.onerror?.({ error: code, message: `fake: ${code}` })
    this.onend?.()
  }

  /** 只给 `end`，不给结果：说完了但一个字都没认出来。 */
  end(): void {
    if (this.dead) return
    this.onend?.()
  }
}

/**
 * 两条路各自"齐全"的环境：用例只改自己关心的那一项。
 *
 * 宿主那条路要求 `mediaDevices` + `MediaRecorder` 都在；苹果那条路只要构造器在。
 */
const APPLE_ENV: SpeechEnvironment = {
  isSecureContext: true,
  workbenchServed: true,
  speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor,
}

/** 宿主那条路齐全的环境片段（`voiceSupport()` 会用到的两样东西）。 */
const HOST_ENV: VoiceEnvironment = {
  mediaDevices: { getUserMedia: async () => ({} as MediaStream) },
  mediaRecorder: fakeRecorder(),
}

/** 最近一个替身实例。 */
function lastFake(): FakeSpeechRecognition {
  const fake = FakeSpeechRecognition.instances.at(-1)
  if (fake === undefined) throw new Error('这次会话没有建出 SpeechRecognition 替身')
  return fake
}

afterEach(() => {
  FakeSpeechRecognition.instances = []
  FakeSpeechRecognition.refuseStart = false
  for (const session of openSessions.splice(0)) session.cancel()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// ─────────────────────── 界面：真实 hook + 真实提示行 + 真实输入框 ───────────────────────

/** 还没收尾的会话，`afterEach` 统一取消，免得计时器跨用例乱跑。 */
const openSessions: VoiceSession[] = []

/** 让异步链路（`getUserMedia`、一次渲染）跑干净。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  })
}

/**
 * 等到某个条件成立再往下走。
 *
 * 不用假计时器：这条链路里 `Blob.arrayBuffer()` 要跨真实的事件循环才结算，
 * 把假计时器塞进来测到的时序就不等于真机上的时序（这条教训写在 voice-endpoint.spec.ts 里）。
 * @param predicate - 条件。
 * @param what - 等的是什么，超时时报出来。
 * @param timeoutMs - 上限。
 */
async function until(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await settle()
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms，${what} 仍然没发生`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
}

/** 一次录音界面要断言的东西。 */
interface View {
  readonly container: HTMLElement
  readonly draft: { value: string }
  readonly held: { session: VoiceSession | null }
  /** 卸载并摘掉容器（`renderVoiceView` 挂完之后才填上）。 */
  unmount: () => void
}

/**
 * 挂一个最小界面：真实 `useVoiceInput` + 真实 `VoiceNoteRow` + 真实 `<input>`。
 *
 * `VoiceNoteRow` 与 `voiceNoteOf` 都是**生产代码本身**（`App.tsx` 里用的是同一对），
 * 所以这里断言到的文案与结构就是用户看到的那一份；`<input>` 绑的也是同一个 `onDraft`，
 * 所以"文字真的进了输入框"这句话在这里是可验证的，而不是靠内部状态自称。
 * @param environment - 注入的环境（含替身构造器）。
 * @param draft - 初始草稿，用来验证"接在用户已经打的字后面"。
 * @returns 容器、草稿、会话句柄与卸载函数。
 */
function renderVoiceView(environment: SpeechEnvironment, draft = ''): View {
  const container = document.createElement('div')
  document.body.append(container)
  const handle: View = { container, draft: { value: draft }, held: { session: null }, unmount: () => { /* 下面赋值 */ } }
  const support = voiceSupport(environment)
  let root: Root
  function Harness(): ReactElement {
    const [value, setValue] = useState(draft)
    const voice = useVoiceInput({
      draft: value,
      onDraft: (next) => { handle.draft.value = next; setValue(next) },
      support,
      environment,
      onSession: (session) => {
        handle.held.session = session
        if (session !== null) openSessions.push(session)
      },
    })
    return createElement('div', null,
      createElement(VoiceNoteRow, {
        note: voiceNoteOf(voice),
        bars: voice.meter,
        recording: voice.phase === 'recording',
        closing: voice.hint !== null,
        interim: voice.interim,
      }),
      createElement('button', {
        className: 'mic',
        disabled: !voice.available || voice.phase === 'transcribing',
        onClick: voice.toggle,
        'aria-label': '语音输入',
      }),
      createElement('input', { value, readOnly: true, 'aria-label': 'draft' }))
  }
  act(() => { root = createRoot(container); root.render(createElement(Harness)) })
  handle.unmount = () => { act(() => root.unmount()); container.remove() }
  return handle
}

/** 点一下麦克风。 */
function clickMic(container: HTMLElement): void {
  const button = container.querySelector('button.mic') as HTMLButtonElement
  act(() => { button.click() })
}

/** 输入框里现在的文字。 */
function inputValue(container: HTMLElement): string {
  return container.querySelector('input')?.value ?? ''
}

/** 提示行上正在长出来的那句话（没有就是 `null`）。 */
function interimText(container: HTMLElement): string | null {
  return container.querySelector('.voice-interim')?.textContent ?? null
}

/** 提示行上的那一句话。 */
function noteText(container: HTMLElement): string {
  return container.querySelector('.voice-note')?.textContent ?? ''
}

// ─────────────────────── 苹果那条路：主流程 ───────────────────────

describe('苹果自带语音识别：边说边出字', () => {
  it('中间结果立刻出现，而且是整段替换——不会接成"你好你好世界"', () => {
    const view = renderVoiceView(APPLE_ENV)
    try {
      clickMic(view.container)
      const fake = lastFake()
      // 生产代码必须把这个接口按中文、单句、要中间结果来配——这三条是产品取舍，不是默认值。
      expect(fake.lang).toBe('zh-CN')
      expect(fake.interimResults).toBe(true)
      expect(fake.continuous).toBe(false)
      expect(noteText(view.container)).toContain('说完自己会停')

      act(() => { fake.speak('你好') })
      expect(interimText(view.container)).toBe('你好')
      act(() => { fake.speak('你好世界') })
      expect(interimText(view.container)).toBe('你好世界')
      // 关键的一条：中间结果**只占一段**。追加式写法这里会变成"你好 你好世界"。
      expect(view.container.querySelectorAll('.voice-interim')).toHaveLength(1)
      expect(interimText(view.container)).not.toContain('你好你好')
      // 还在听的时候，输入框里一个字节都没有：输入框只放确定的东西。
      expect(inputValue(view.container)).toBe('')
      expect(noteText(view.container)).toContain('正在听')
    } finally {
      view.unmount()
    }
  })

  it('`resultIndex` 之前的旧结果不再算一遍：只说新那一条', () => {
    const view = renderVoiceView(APPLE_ENV)
    try {
      clickMic(view.container)
      const fake = lastFake()
      // Chrome 的形状：结果一条条往后加，`resultIndex` 指向新的那条。
      act(() => { fake.emitSegments([{ transcript: '你好', isFinal: true }, { transcript: '世界', isFinal: false }]) })
      // 第 0 条（"你好"）已经报过，不能再算：显示的就该只有这一轮的增量。
      expect(interimText(view.container)).toBe('世界')
    } finally {
      view.unmount()
    }
  })

  it('同一次事件里前半句定稿、后半句还在变：先不收尾（别把正在说的半句切掉）', () => {
    const view = renderVoiceView(APPLE_ENV)
    try {
      clickMic(view.container)
      const fake = lastFake()
      // 引擎把前半句定稿、后半句还在变（一次事件里两条，从第 0 条起算）：
      // 这时收尾就是替用户截断他正在说的话。
      act(() => {
        fake.emit([
          { transcript: '帮我看看', isFinal: true },
          { transcript: '这个报错', isFinal: false },
        ], 0)
      })
      expect(inputValue(view.container)).toBe('')
      // 但整句必须已经在显示（定稿那一半 + 还在变的那半）。
      expect(interimText(view.container)).toBe('帮我看看这个报错')
      // 真的说完了再落地，两截都在。
      act(() => { fake.end() })
      expect(inputValue(view.container)).toBe('帮我看看这个报错')
    } finally {
      view.unmount()
    }
  })

  it('说完：最终文字进输入框（接在原有草稿后面），一个请求都没发', () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const view = renderVoiceView({
      isSecureContext: true,
      workbenchServed: true,
      speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor,
      fetch: fetchImpl,
    }, '帮我')
    try {
      clickMic(view.container)
      const fake = lastFake()
      act(() => { fake.speak('看看这个') })
      act(() => { fake.finish('看看这个报错') })
      expect(inputValue(view.container)).toBe('帮我 看看这个报错')
      // 中间结果让位给最终结果，不留残影；说完了提示行也收掉，不占位。
      expect(interimText(view.container)).toBeNull()
      expect(noteText(view.container)).toBe('')
      // **不自动发送**：这条路从头到尾不碰宿主，所以一个请求都不该有。
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })

  it('只给 end、不给最终结果：手上认出来的字照样落地，不丢', () => {
    const view = renderVoiceView(APPLE_ENV)
    try {
      clickMic(view.container)
      const fake = lastFake()
      act(() => { fake.speak('今天天气不') })
      // 真机上 iOS 不一定给 `isFinal`（WebKit 288963）：到点了也得把字交出来。
      act(() => { fake.end() })
      expect(inputValue(view.container)).toBe('今天天气不')
    } finally {
      view.unmount()
    }
  })

  it('取消：不发请求、不再接收结果、输入框一动不动', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const view = renderVoiceView({
      isSecureContext: true,
      workbenchServed: true,
      speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor,
      fetch: fetchImpl,
    })
    try {
      clickMic(view.container)
      const fake = lastFake()
      act(() => { fake.speak('不要这句') })
      expect(interimText(view.container)).toBe('不要这句')
      act(() => { view.held.session?.cancel() })
      expect(fake.aborts).toBe(1)
      // 取消之后，UA 再送什么来都不该进逻辑：结果、错误、收尾都不算数。
      act(() => { fake.finish('不要这句') })
      act(() => { fake.fail('network') })
      act(() => { fake.end() })
      await settle()
      expect(inputValue(view.container)).toBe('')
      expect(interimText(view.container)).toBeNull()
      expect(noteText(view.container)).toBe('')
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })

  it('卡住的会话到点自己收尾：麦克风不会一直开着', async () => {
    const failures: string[] = []
    const texts: string[] = []
    const phases: VoicePhase[] = []
    const session = startAppleSpeech({
      environment: { speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor },
      maxMs: 30,
      onPhase: (phase) => { phases.push(phase) },
      onText: (text) => { texts.push(text) },
      onFailure: (error) => { failures.push(error.kind) },
    })
    lastFake().speak('说到一半就卡住了')
    await settle()
    await new Promise<void>((resolve) => { setTimeout(resolve, 60) })
    await settle()
    expect(lastFake().stops).toBe(1)
    expect(texts).toEqual(['说到一半就卡住了'])
    expect(failures).toEqual([])
    expect(phases.at(-1)).toBe('idle')
    session.cancel()
  })
})

// ─────────────────────── 每种失败各有各的话 ───────────────────────

describe('苹果那条路的失败：每个码说自己的处置', () => {
  /** 走一次"报这个码"，把失败类别与文案收下来。 */
  function failureOf(code: string): { readonly kind: VoiceFailureKind; readonly message: string } {
    const failures: { kind: VoiceFailureKind; message: string }[] = []
    const session = startAppleSpeech({
      environment: { speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor },
      onText: () => { /* 这条用例不该出现文字 */ },
      onFailure: (error) => { failures.push({ kind: error.kind, message: error.message }) },
    })
    lastFake().fail(code)
    session.cancel()
    const first = failures[0]
    if (first === undefined) throw new Error(`${code} 没有落成一个失败`)
    return first
  }

  it('六个码六种处置，两两不同，每一句都能照着做', () => {
    const cases = [
      { code: 'not-allowed', kind: 'speech-denied', action: '系统设置' },
      { code: 'service-not-allowed', kind: 'speech-service', action: 'Siri 与听写' },
      { code: 'network', kind: 'speech-network', action: '手机网络' },
      { code: 'audio-capture', kind: 'speech-audio', action: '麦克风权限' },
      { code: 'language-not-supported', kind: 'speech-language', action: '中文' },
      { code: 'no-speech', kind: 'no-speech', action: '靠近麦克风' },
    ] as const
    const seen = cases.map((entry) => {
      const failure = failureOf(entry.code)
      expect(failure.kind, entry.code).toBe(entry.kind)
      expect(failure.message, entry.code).toContain('🎤')
      // 每一句都要说出**去哪儿动手**：笼统一句"识别失败"等于让用户自己猜。
      expect(failure.message, entry.code).toContain(entry.action)
      return failure.message
    })
    expect(new Set(seen).size).toBe(cases.length)
  })

  it('认不出的码与 `phrases-not-supported` 落进同一句兜底话，不含糊其辞', () => {
    const unknown = failureOf('something-new')
    expect(unknown.kind).toBe('speech-failed')
    expect(unknown.message).toContain('再说一次')
    expect(failureOf('phrases-not-supported').kind).toBe('speech-failed')
  })

  it('`aborted` 不是失败：有字就把字落地，没字就安静回空闲（不编一句"没听清"）', () => {
    const failures: string[] = []
    const texts: string[] = []
    const phases: VoicePhase[] = []
    const session = startAppleSpeech({
      environment: { speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor },
      onPhase: (phase) => { phases.push(phase) },
      onText: (text) => { texts.push(text) },
      onFailure: (error) => { failures.push(error.kind) },
    })
    const fake = lastFake()
    fake.speak('被中止之前说的')
    fake.fail('aborted')
    expect(texts).toEqual(['被中止之前说的'])
    expect(failures).toEqual([])
    session.cancel()

    // 一个字都没有的那种：不报错，回空闲。
    const silentFailures: string[] = []
    const silent = startAppleSpeech({
      environment: { speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor },
      onText: () => { /* 不该有文字 */ },
      onFailure: (error) => { silentFailures.push(error.kind) },
    })
    lastFake().fail('aborted')
    silent.cancel()
    expect(silentFailures).toEqual([])
  })

  it('`start()` 直接抛：说的是"没能启动、再点一次"，不是笼统的失败', () => {
    FakeSpeechRecognition.refuseStart = true
    const failures: VoiceError[] = []
    const session = startAppleSpeech({
      environment: { speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor },
      onText: () => { /* 不该有文字 */ },
      onFailure: (error) => { failures.push(error) },
    })
    session.cancel()
    expect(failures.map(error => error.kind)).toEqual(['speech-start'])
    expect(failures[0]?.message).toContain('再点一次')
  })
})

// ─────────────────────── 路的先后顺序 ───────────────────────

describe('两条路的先后：能走苹果就走苹果，没有才回退宿主', () => {
  const env: SpeechEnvironment = { isSecureContext: true, workbenchServed: true }

  it('两条都能走时走苹果：它更快、还能流式出字', () => {
    const apple = appleSpeechSupport({ ...env, speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor })
    const host = voiceSupport({ ...env, ...HOST_ENV })
    expect(voiceRouteOf(apple, host)).toEqual({ route: 'apple', blocked: null })
  })

  it('没有 Web Speech 时走宿主那条：不因为加了新路就把老的判没了', () => {
    const apple = appleSpeechSupport(env)
    const host = voiceSupport({ ...env, ...HOST_ENV })
    expect(host.ok).toBe(true)
    expect(voiceRouteOf(apple, host)).toEqual({ route: 'host', blocked: null })
  })

  it('遥控/配对形态：宿主那条打不通，但苹果那条照走（它不用电脑）', () => {
    const remote: SpeechEnvironment = { isSecureContext: true, workbenchServed: false }
    const apple = appleSpeechSupport({ ...remote, speechRecognition: FakeSpeechRecognition as unknown as SpeechRecognitionCtor })
    const host = voiceSupport(remote)
    expect(host).toEqual({ ok: false, reason: 'remote-host' })
    expect(voiceRouteOf(apple, host)).toEqual({ route: 'apple', blocked: null })
  })

  it('两条都不通时说哪一句：安全上下文优先，其次是遥控形态', () => {
    const insecure = voiceRouteOf({ ok: false, reason: 'unsupported' }, { ok: false, reason: 'insecure-context' })
    expect(insecure.route).toBe('none')
    expect(insecure.blocked).toBe(VOICE_COPY['insecure-context'])
    const remote = voiceRouteOf({ ok: false, reason: 'unsupported' }, { ok: false, reason: 'remote-host' })
    expect(remote.blocked).toBe(VOICE_COPY['remote-host'])
    const none = voiceRouteOf({ ok: false, reason: 'unsupported' }, { ok: false, reason: 'unsupported' })
    expect(none.blocked).toBe(VOICE_COPY.unsupported)
  })

  it('安全上下文用的是宿主那条路的判定，不是另写一套', () => {
    // 同一个环境喂给两条路：不安全时两条都必须先报 insecure-context（而不是"不支持"）。
    expect(appleSpeechSupport({ isSecureContext: false })).toEqual({ ok: false, reason: 'insecure-context' })
  })

  it('全局没这两个名字时，`speechRecognitionCtor` 就是 null', () => {
    expect(speechRecognitionCtor({})).toBeNull()
    expect(speechRecognitionCtor({ speechRecognition: null })).toBeNull()
  })
})

// ─────────────────────── 回退真的走了宿主那条（含请求断言） ───────────────────────

/** 一个 `MediaStream` 的最小替身（jsdom 没有 `MediaStream`）。 */
function fakeStream(): MediaStream {
  return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream
}

/** `MediaRecorder` 的最小替身：先给数据、再 `onstop`（真实顺序）。 */
function fakeRecorder(): typeof MediaRecorder {
  class Fake {
    readonly mimeType = 'audio/webm'
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    static isTypeSupported(): boolean { return true }
    start(): void { /* 用例按停时才给数据 */ }
    stop(): void {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: 'audio/webm' }) })
      this.onstop?.()
    }
  }
  return Fake as unknown as typeof MediaRecorder
}

/** `AudioContext` 的最小替身：解码成 1 秒 16 kHz 单声道。 */
function fakeAudioContext(): typeof AudioContext {
  const data = new Float32Array(16_000).fill(0.2)
  class Fake {
    decodeAudioData(): Promise<AudioBuffer> {
      return Promise.resolve({
        sampleRate: 16_000,
        length: data.length,
        duration: 1,
        numberOfChannels: 1,
        getChannelData: () => data,
      } as unknown as AudioBuffer)
    }
    close(): Promise<void> { return Promise.resolve() }
  }
  return Fake as unknown as typeof AudioContext
}

describe('没有苹果那条路时，回退到宿主 whisper（这条不能被新路顶掉）', () => {
  it('这台设备没有 Web Speech：点下去真的 POST 了转写接口，文字进输入框', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ text: '宿主认出来的话' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const environment: VoiceEnvironment = {
      isSecureContext: true,
      workbenchServed: true,
      mediaDevices: { getUserMedia: async () => fakeStream() },
      mediaRecorder: fakeRecorder(),
      audioContext: fakeAudioContext(),
      fetch: fetchImpl,
    }
    // 注意：**不含** `speechRecognition`，全局也没有（jsdom 没有这个接口）。
    const view = renderVoiceView(environment)
    try {
      expect(speechRecognitionCtor({})).toBeNull()
      clickMic(view.container)
      await until(() => view.held.session !== null, '会话建出来')
      // 走的是宿主那条：录音 → 编码 WAV → POST。这一步是"回退"最硬的一条证据。
      act(() => { view.held.session?.stop() })
      await until(() => calls.length === 1, '发出一条转写请求')
      await until(() => inputValue(view.container).length > 0, '文字进了输入框')
      expect(calls).toEqual([TRANSCRIBE_PATH])
      expect(inputValue(view.container)).toBe('宿主认出来的话')
    } finally {
      view.unmount()
    }
  })
})

// ─────────────────────── 宿主 503：说的是"模型没装" ───────────────────────

describe('宿主没装模型（503）：文案说的是"模型没装"，不是"网络问题"', () => {
  const wav = new Blob([new Uint8Array(1)])

  it('503 VOICE_UNAVAILABLE：指出要装模型，且不把用户支去查网络', async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ error: 'VOICE_UNAVAILABLE' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const error = await transcribeWav(wav, new AbortController().signal, { fetch: impl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VoiceError)
    expect((error as VoiceError).kind).toBe('no-model')
    expect((error as VoiceError).status).toBe(503)
    // 这一条是重点：不能说"连不上电脑的语音服务"——那是让用户白查网络。
    expect((error as VoiceError).message).toContain('模型')
    expect((error as VoiceError).message).toContain('不是网络问题')
    expect((error as VoiceError).message).not.toContain('连不上电脑')
    // 真因是"电脑上没装模型"，也不该让用户去查网络。
    expect(VOICE_COPY['no-model']).not.toBe(VOICE_COPY.network)
    expect(VOICE_COPY['no-model']).not.toContain('连不上电脑')
  })

  it('503 但读不出错误码（代理换了响应体）：问一次宿主状态，答"没装"就照实说没装', async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === TRANSCRIBE_PATH) {
        return new Response('<html>503 Service Unavailable</html>', { status: 503, headers: { 'content-type': 'text/html' } })
      }
      return new Response(JSON.stringify({ available: false, engine: 'whisper.cpp' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const error = await transcribeWav(wav, new AbortController().signal, { fetch: impl }).catch((e: unknown) => e)
    expect((error as VoiceError).kind).toBe('no-model')
    // 两跳：转写一次 + 状态问一次。不多不少。
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('503 且状态接口也说不上话：那才是真的连不上，保持"网络"判定', async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === TRANSCRIBE_PATH) return new Response('<html>503</html>', { status: 503 })
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const error = await transcribeWav(wav, new AbortController().signal, { fetch: impl }).catch((e: unknown) => e)
    expect((error as VoiceError).kind).toBe('network')
  })

  it('状态接口说模型在（available: true）：不硬说"没装模型"', async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === TRANSCRIBE_PATH) return new Response('', { status: 503 })
      return new Response(JSON.stringify({ available: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const error = await transcribeWav(wav, new AbortController().signal, { fetch: impl }).catch((e: unknown) => e)
    expect((error as VoiceError).kind).toBe('network')
  })

  it('别的状态码不受影响：代理回 HTML 的 502 仍然是"网络"（原来那条不能被改坏）', async () => {
    const impl = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch
    const error = await transcribeWav(wav, new AbortController().signal, { fetch: impl }).catch((e: unknown) => e)
    expect((error as VoiceError).kind).toBe('network')
    expect((error as VoiceError).status).toBe(502)
    expect(impl).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────── 真实 App：门到底放开了没有 ───────────────────────

describe('真实 App：遥控形态下苹果那条路能点吗', () => {
  const AppElement: FC<AppProps> = App

  /** 挂真实的 App，返回容器与"有没有发出转写请求"的探针。 */
  async function mountApp(): Promise<{ readonly container: HTMLElement; readonly transcribes: string[]; readonly root: Root }> {
    const transcribes: string[] = []
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/forge/voice/transcribe')) {
        transcribes.push(url)
        return new Response(JSON.stringify({ text: '不该走到这里' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // App 还会打账号、版本这些接口；这一条用例不关心它们。
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', impl)
    vi.stubGlobal('isSecureContext', true)
    // 页面**不是**工作台提供的（`BASE_URL` 没有 `/mobile/` 前缀）——手机今天在看的预览
    // 形态就是这样。这正是"遥控/配对形态"那道门。
    vi.stubEnv('BASE_URL', '/')
    vi.stubGlobal('webkitSpeechRecognition', FakeSpeechRecognition)
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: async () => fakeStream() },
      configurable: true,
    })
    vi.stubGlobal('MediaRecorder', fakeRecorder())
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(createElement(AppElement, {})) })
    return { container, transcribes, root }
  }

  it('宿主那条被页面形态挡着，但苹果那条能用：按钮可点，文字进真实输入框且不发请求', async () => {
    const { container, transcribes, root } = await mountApp()
    try {
      // 先把"门确实关着"这件事钉住：宿主那条在这个形态下就是走不了。
      expect(voiceSupport().ok).toBe(false)
      expect(voiceSupport().reason).toBe('remote-host')

      const button = container.querySelector('[aria-label="语音输入"]') as HTMLButtonElement | null
      expect(button).not.toBeNull()
      // 门是为苹果那条路开的：它不经过电脑，所以页面形态拦不住它。
      expect(button?.disabled).toBe(false)
      act(() => { button?.click() })
      const fake = lastFake()
      act(() => { fake.speak('只用手机也能说话') })
      expect(container.querySelector('.voice-interim')?.textContent).toBe('只用手机也能说话')
      act(() => { fake.finish('只用手机也能说话') })
      // 真实输入框（输入框那一行里的那个）里就是这句话。
      const input = container.querySelector<HTMLInputElement>('.composer-row input')
      expect(input?.value).toBe('只用手机也能说话')
      // 全程一个转写请求都没有：这就是"不依赖宿主"的证据。
      expect(transcribes).toEqual([])
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })
})
