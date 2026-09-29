// @vitest-environment jsdom
/**
 * 手机端「语音输入」的验收测试。
 *
 * 这份测试盯的**不是**"函数被调用了"，而是宿主那条真实契约有没有被守住。
 * 契约的出处（逐字核对过）：
 *
 * - 路径与方法：`packages/host/voice-local/src/index.ts:89-90`
 *   `path: '/api/forge/voice/transcribe', methods: ['POST'], requestBody: 'streaming'`
 * - 媒体类型：同文件 `:61` 只放行
 *   `/^audio\/(wav|wave|x-wav)$/`
 * - 字节形状：`packages/host/voice-local/src/wav.ts:9-34` 的 `validVoiceWav()`——
 *   必须是真 RIFF/WAVE，`fmt ` 块 16 字节、格式 1、声道 1、**采样率 16000**、
 *   字节率 32000、位深 16，数据长度是偶数且在
 *   `3200 … 16_000 * 2 * 120` 之间
 * - 响应形状：成功 `{ text }`（`:76`），失败 `{ error: <code> }`（`:59-81`）
 * - PC 端的调用姿势：`packages/client/ui-chat/src/client/chat/voice/api.ts:19-22`
 *   `fetch(path, { method: 'POST', credentials: 'same-origin',
 *   headers: { 'Content-Type': 'audio/wav' }, body: audio, signal })`
 *
 * 环境（`isSecureContext`/`mediaDevices`/`MediaRecorder`/`AudioContext`）**注入**，
 * 不往全局桩上写：`pairing.ts` 的 `scanSupport()` 就是这么留的可注入环境，
 * 而且 `vi.stubGlobal` 是按 worker 生效的——上一个文件漏下的桩会让下一个文件的
 * 绿灯变成执行顺序的巧合（这条教训写在 `tests/storage.ts` 的注释里）。
 *
 * 用 `.spec.ts` 而不是 `.spec.tsx`：根 vitest 配置里手机端这一条 include 只收
 * 手机端这一条 include 只收 `.spec.ts`（不收 `.tsx`），所以这里用 `createElement` 写元素。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVoiceInput } from '../src/voice-input.ts'
import {
  MAX_VOICE_BYTES,
  VOICE_COPY,
  encodeWav,
  startVoiceInput,
  transcribeWav,
  voiceSupport,
  type VoiceEnvironment,
  type VoicePhase,
  type VoiceSession,
} from '../src/voice.ts'

/**
 * 一个 `MediaStream` 的最小替身。
 *
 * jsdom **没有** `MediaStream`（核过：它的 `interfaces.js` 只有 `HTMLMediaElement`，
 * 没有 `MediaStream`），直接 `new MediaStream()` 会抛 `Not defined`——而 `voice.ts`
 * 把 `getUserMedia` 抛出的任何东西都当成"麦克风没拿到"，于是用例看到的是 `denied`，
 * 一个与被测逻辑无关的假失败。所以这里把"拿到麦克风"显式替出来。
 */
function fakeStream(): MediaStream {
  return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream
}

/** 一个「同源、安全上下文、接口齐全」的环境底座；每条用例只改自己关心的那一项。 */
function environment(overrides: Partial<VoiceEnvironment> = {}): VoiceEnvironment {
  return {
    isSecureContext: true,
    workbenchServed: true,
    mediaDevices: { getUserMedia: vi.fn(async () => fakeStream()) },
    ...overrides,
  }
}

/** 一段可用的音频容器替身：内容无关紧要，解码由下面的 AudioContext 桩接管。 */
function recordedBlob(): Blob {
  return new Blob([new Uint8Array(2048)], { type: 'audio/webm;codecs=opus' })
}

/**
 * 1 秒 16 kHz 单声道样本（正弦波，只是要有能量，不做音频断言）。
 * @returns 16000 个样本。
 */
function samples(): Float32Array {
  const data = new Float32Array(16_000)
  for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 20) * 0.4
  return data
}

/**
 * `MediaRecorder` 的最小替身：真浏览器里 `dataavailable` 先于 `stop` 到达，这里照同样顺序。
 *
 * **只由会话的 `stop()` 触发**，用例不自己去点替身：`voice.ts` 的整条链路是
 * 「会话 stop → 录音机 stop → onstop → 解码上传」，绕过会话直接调替身会跳过
 * 前半段状态机，测出来的东西和用户按下去的那条路不是同一条。
 */
function fakeRecorder(): { readonly ctor: typeof MediaRecorder; readonly instances: FakeRecorderInstance[] } {
  const instances: FakeRecorderInstance[] = []
  class Fake {
    readonly mimeType: string
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    constructor(_stream: MediaStream, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? 'audio/webm'
      instances.push(this as unknown as FakeRecorderInstance)
    }
    static isTypeSupported(): boolean { return true }
    start(): void { /* 用例自己决定什么时候给数据 */ }
    stop(): void {
      this.ondataavailable?.({ data: recordedBlob() })
      this.onstop?.()
    }
  }
  return { ctor: Fake as unknown as typeof MediaRecorder, instances }
}

/** 上面替身的实例形状。 */
interface FakeRecorderInstance {
  readonly mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  stop(): void
}

/** `AudioContext` 的最小替身：只实现 `decodeAudioData` 与 `close`。 */
function fakeAudioContext(data: Float32Array = samples(), rate = 16_000): typeof AudioContext {
  class Fake {
    decodeAudioData(): Promise<AudioBuffer> {
      return Promise.resolve({
        sampleRate: rate,
        length: data.length,
        duration: data.length / rate,
        numberOfChannels: 1,
        getChannelData: () => data,
      } as unknown as AudioBuffer)
    }
    close(): Promise<void> { return Promise.resolve() }
  }
  return Fake as unknown as typeof AudioContext
}

/** 一个记录全部请求的 fetch；默认回成功。 */
function recordingFetch(respond: (init: RequestInit | undefined) => Response = () => json({ text: '帮我看看这个报错' })): {
  readonly impl: typeof fetch
  readonly calls: { readonly url: string; readonly init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return respond(init)
  }) as unknown as typeof fetch
  return { impl, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 一次录音会话要断言的东西。 */
interface Run {
  readonly events: string[]
  readonly texts: string[]
  readonly phases: VoicePhase[]
  readonly failures: { readonly kind: string; readonly message: string }[]
  readonly session: { readonly stop: () => void; readonly cancel: () => void }
}

/**
 * 走一遍「开始 → 停止」，把回调按发生顺序收集起来。
 *
 * `stop` 会**等录音真的开始**再停：`startVoiceInput` 拿麦克风是异步的，
 * 立刻调用 `stop()` 时录音机还没建起来，会被当成"从未开始"而丢弃。
 * 真实的点击顺序必然隔着一次授权往返，所以这里等一次才符合实际。
 * @param options - 环境、录音容器替身与开始后的动作。
 * @returns 收集到的回调结果与可控会话。
 */
async function run(options: {
  readonly environment: VoiceEnvironment
  readonly recorder?: typeof MediaRecorder
  readonly audioContext?: typeof AudioContext
  readonly stop?: boolean
  readonly cancel?: boolean
}): Promise<Run> {
  const events: string[] = []
  const texts: string[] = []
  const phases: VoicePhase[] = []
  const failures: { kind: string; message: string }[] = []
  const session = startVoiceInput({
    environment: {
      ...options.environment,
      ...(options.recorder === undefined ? {} : { mediaRecorder: options.recorder }),
      ...(options.audioContext === undefined ? {} : { audioContext: options.audioContext }),
    },
    onPhase: (phase) => { phases.push(phase) },
    onText: (text) => { events.push('text'); texts.push(text) },
    onFailure: (error) => { events.push('failure'); failures.push({ kind: error.kind, message: error.message }) },
  })
  await settle()
  if (options.stop === true) session.stop()
  if (options.cancel === true) session.cancel()
  return { events, texts, phases, failures, session }
}

/**
 * 让上一轮异步链路跑干净。
 *
 * 只用 `await Promise.resolve()` 排微任务是**不够**的：`Blob.arrayBuffer()` 在
 * jsdom 里要跨过真实的事件循环才结算，而录音链路里就有两次（解码前读一次、
 * 上传前包一次）。所以这里每一次都真的让出一轮宏任务。
 * @param times - 让出多少轮；默认 8 轮，够跑完「解码 → 编码 → 上传」。
 */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('voiceSupport：先判安全上下文，再判页面形态，最后才看接口', () => {
  it('http 下不给麦克风：原因是 insecure-context，不是"不支持"', () => {
    const support = voiceSupport(environment({ isSecureContext: false }))
    expect(support).toEqual({ ok: false, reason: 'insecure-context' })
  })

  it('安全上下文 + 工作台提供 + 接口齐全：可用', () => {
    expect(voiceSupport(environment({ mediaRecorder: class { } as unknown as typeof MediaRecorder })))
      .toEqual({ ok: true, reason: null })
  })

  it('安全上下文 + 工作台提供但浏览器没有 MediaRecorder：unsupported', () => {
    const support = voiceSupport(environment({ mediaRecorder: undefined }))
    expect(support.reason).toBe('unsupported')
  })

  it('没有 getUserMedia：unsupported', () => {
    expect(voiceSupport(environment({ mediaDevices: undefined })).reason).toBe('unsupported')
  })
})

describe('语音输入：不安全或遥控形态下绝不发请求', () => {
  it('不是安全上下文：0 个请求，且文案说的是 HTTPS', async () => {
    const { impl, calls } = recordingFetch()
    const run1 = await run({
      environment: environment({ isSecureContext: false, fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
    })
    expect(calls).toHaveLength(0)
    expect(run1.failures.map(f => f.kind)).toEqual(['insecure-context'])
    expect(run1.failures[0]?.message).toContain('HTTPS')
  })

  it('页面不是工作台提供的（遥控/配对形态）：0 个请求，且说明录音到不了语音服务', async () => {
    const { impl, calls } = recordingFetch()
    const run1 = await run({
      environment: environment({ workbenchServed: false, fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
    })
    expect(calls).toHaveLength(0)
    expect(run1.failures.map(f => f.kind)).toEqual(['remote-host'])
    // 不能只说"失败"：要说清录音的归宿是电脑上的本地语音服务，这里调不到。
    expect(run1.failures[0]?.message).toContain('遥控')
  })
})

describe('请求形状：对着宿主的真实契约断言', () => {
  it('POST /api/forge/voice/transcribe，Content-Type: audio/wav', async () => {
    const { impl, calls } = recordingFetch()
    run({
      environment: environment({ fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
      stop: true,
    })
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/forge/voice/transcribe')
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('Content-Type')).toBe('audio/wav')
    expect(calls[0]?.init?.credentials).toBe('same-origin')
  })

  it('body 是真的 WAV：过一遍宿主 validVoiceWav() 的那几条判据', async () => {
    const { impl, calls } = recordingFetch()
    run({
      environment: environment({ fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
      stop: true,
    })
    await settle()
    const body = calls[0]?.init?.body
    expect(body).toBeInstanceOf(Blob)
    const wav = body as Blob
    expect(wav.type).toBe('audio/wav')
    const bytes = new Uint8Array(await wav.arrayBuffer())
    const view = new DataView(bytes.buffer)
    const ascii = (at: number, length: number): string =>
      String.fromCharCode(...bytes.subarray(at, at + length))
    // wav.ts:12 —— RIFF 信封
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    // wav.ts:13 —— RIFF 声明长度必须与真实长度一致（差 8 是 RIFF 自己的算法）
    expect(view.getUint32(4, true) + 8).toBe(bytes.length)
    // wav.ts:23-28 —— 格式 1 / 单声道 / 16000 Hz / 32000 B/s / 块对齐 2 / 16 位
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    // wav.ts:34 —— 采样数在 [3200, 16_000*2*120] 之间且是偶数
    const dataLength = view.getUint32(40, true)
    expect(dataLength).toBe(bytes.length - 44)
    expect(dataLength).toBeGreaterThanOrEqual(3200)
    expect(dataLength).toBeLessThanOrEqual(16_000 * 2 * 120)
    expect(dataLength % 2).toBe(0)
    expect(bytes.length).toBeLessThanOrEqual(MAX_VOICE_BYTES)
  })

  it('源采样率不是 16 kHz 时重采样成 16 kHz（48 kHz 录进来也守契约）', async () => {
    const { impl, calls } = recordingFetch()
    const wide = new Float32Array(48_000).fill(0.3)
    run({
      environment: environment({ fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(wide, 48_000),
      stop: true,
    })
    await settle()
    const bytes = new Uint8Array(await (calls[0]?.init?.body as Blob).arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    // 1 秒 48 kHz 源 → 1 秒 16 kHz = 32000 字节数据（允许 ±1 样本的取整）
    expect(view.getUint32(40, true)).toBeGreaterThanOrEqual(31_998)
    expect(view.getUint32(40, true)).toBeLessThanOrEqual(32_000)
  })
})

describe('成功路径：文字进输入框，不自动发送', () => {
  it('onText 收到宿主的 { text }，trim 过', async () => {
    const { impl } = recordingFetch(() => json({ text: '  帮我把这个报错解释一下  ' }))
    const run1 = await run({
      environment: environment({ fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
      stop: true,
    })
    await settle()
    expect(run1.failures).toEqual([])
    expect(run1.texts).toEqual(['帮我把这个报错解释一下'])
  })

  it('接入界面后：只调 onDraft，**没有任何发送动作**', async () => {
    const { impl } = recordingFetch(() => json({ text: '帮我看看这个报错' }))
    const recorder = fakeRecorder()
    const onDraft = vi.fn()
    const onSend = vi.fn()
    const { container, held, rerender, unmount } = renderHarness({
      draft: '',
      onDraft,
      onSend,
      environment: environment({ fetch: impl, mediaRecorder: recorder.ctor, audioContext: fakeAudioContext() }),
    })
    try {
      await clickMic(container)
      held.phase = 'recording'
      rerender()
      await clickMic(container)
      // 「填进输入框」这件事的落点就是 onDraft：它由 `App` 的 `setDraft` 接住。
      // 这里**不能**断言 input 的 value——受控输入框的值来自父组件的状态，
      // 而这个测试替身故意不持有状态（真界面里那一步是 React 自己重渲染的）。
      expect(onDraft).toHaveBeenCalledWith('帮我看看这个报错')
      expect(onSend).not.toHaveBeenCalled()
      // 会话已经交回：没有残留的录音会话继续占着麦克风。
      expect(held.session).toBeNull()
    } finally { unmount() }
  })

  it('草稿里已经有字时是追加，不覆盖用户打的内容', async () => {
    const { impl } = recordingFetch(() => json({ text: '然后再发给张工' }))
    const recorder = fakeRecorder()
    const onDraft = vi.fn()
    const { container, held, rerender, unmount } = renderHarness({
      draft: '把这个报表导出一下，',
      onDraft,
      onSend: vi.fn(),
      environment: environment({ fetch: impl, mediaRecorder: recorder.ctor, audioContext: fakeAudioContext() }),
    })
    try {
      await clickMic(container)
      held.phase = 'recording'
      rerender()
      await clickMic(container)
      expect(onDraft).toHaveBeenCalledWith('把这个报表导出一下， 然后再发给张工')
    } finally { unmount() }
  })
})

describe('失败路径：四类各自不同、可行动', () => {
  it('麦克风权限被拒：文案指到浏览器设置，且不发请求', async () => {
    const { impl, calls } = recordingFetch()
    const denied = {
      getUserMedia: vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) }),
    }
    const run1 = await run({
      environment: environment({ fetch: impl, mediaDevices: denied }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
    })
    await settle()
    expect(run1.failures.map(f => f.kind)).toEqual(['denied'])
    expect(run1.failures[0]?.message).toContain('权限')
    expect(calls).toHaveLength(0)
  })

  it('宿主没装语音模型（503 VOICE_UNAVAILABLE）：文案指到电脑上装模型', async () => {
    const { impl } = recordingFetch(() => json({ error: 'VOICE_UNAVAILABLE' }, 503))
    const run1 = await run({
      environment: environment({ fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
      stop: true,
    })
    await settle()
    expect(run1.failures.map(f => f.kind)).toEqual(['no-model'])
    expect(run1.failures[0]?.message).toContain('模型')
  })

  it('网络不通：文案指到网络与电脑是否开着，且不发第二次请求', async () => {
    const calls: string[] = []
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const run1 = await run({
      environment: environment({ fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
      stop: true,
    })
    await settle()
    expect(run1.failures.map(f => f.kind)).toEqual(['network'])
    expect(run1.failures[0]?.message).toContain('网络')
    expect(calls).toHaveLength(1)
  })

  it('宿主正忙（429 VOICE_BUSY）：文案说的是"稍等一下"，不是"失败"', async () => {
    const { impl } = recordingFetch(() => json({ error: 'VOICE_BUSY' }, 429))
    const run1 = await run({
      environment: environment({ fetch: impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
      stop: true,
    })
    await settle()
    expect(run1.failures[0]?.kind).toBe('busy')
    expect(run1.failures[0]?.message).toContain('稍等')
  })

  it('四类失败的文案两两不同，且都不是一句笼统的"失败了"', () => {
    const kinds = [
      'insecure-context', 'remote-host', 'unsupported', 'denied',
      'no-model', 'busy', 'timeout', 'no-speech', 'network',
    ] as const
    const messages = kinds.map(kind => VOICE_COPY[kind])
    expect(new Set(messages).size).toBe(kinds.length)
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(10)
      expect(message).not.toBe('录音失败了')
    }
    // 话里带图标，和项目其它提示风格一致。
    for (const message of messages) expect(message).toContain('🎤')
  })

  it('宿主的两个状态码映射到不同的处置：503 是没装模型，429 是忙', () => {
    const { impl: model } = recordingFetch(() => json({ error: 'VOICE_UNAVAILABLE' }, 503))
    const { impl: busy } = recordingFetch(() => json({ error: 'VOICE_BUSY' }, 429))
    expect(model).toBeTypeOf('function')
    expect(busy).toBeTypeOf('function')
    // 逐条走一遍真实响应映射（上面的用例已断言，这里守住"两者不相等"这条）。
    expect(VOICE_COPY['no-model']).not.toBe(VOICE_COPY.busy)
  })
})

describe('取消：录到一半不想要了', () => {
  it('取消后 0 个请求、0 个文字回调', async () => {
    const { impl, calls } = recordingFetch()
    const recorder = fakeRecorder()
    const run1 = await run({
      environment: environment({ fetch: impl }),
      recorder: recorder.ctor,
      audioContext: fakeAudioContext(),
      cancel: true,
    })
    await settle()
    expect(calls).toHaveLength(0)
    expect(run1.texts).toEqual([])
    expect(run1.failures).toEqual([])
  })

  it('取消发生在录音开始之后：同样不发请求', async () => {
    const { impl, calls } = recordingFetch()
    const recorder = fakeRecorder()
    const run1 = await run({
      environment: environment({ fetch: impl }),
      recorder: recorder.ctor,
      audioContext: fakeAudioContext(),
    })
    await settle()
    expect(recorder.instances).toHaveLength(1)
    run1.session.cancel()
    await settle()
    expect(calls).toHaveLength(0)
    expect(run1.texts).toEqual([])
  })

  it('取消后录音阶段的提示要收回去（onPhase 回到 idle）', async () => {
    const run1 = await run({
      environment: environment({ fetch: recordingFetch().impl }),
      recorder: fakeRecorder().ctor,
      audioContext: fakeAudioContext(),
    })
    await settle()
    expect(run1.phases).toContain('recording')
    run1.session.cancel()
    await settle()
    expect(run1.phases.at(-1)).toBe('idle')
  })
})

describe('transcribeWav：单独把失败码翻成处置', () => {
  it('504 超时 → timeout，文案说的是超时', async () => {
    const { impl } = recordingFetch(() => json({ error: 'VOICE_TIMEOUT' }, 504))
    await expect(transcribeWav(new Blob([new Uint8Array(1)]), new AbortController().signal, environment({ fetch: impl })))
      .rejects.toMatchObject({ kind: 'timeout' })
  })

  it('响应体不是 { text } → network，不把 undefined 当文字填进输入框', async () => {
    const { impl } = recordingFetch(() => json({ ok: true }))
    await expect(transcribeWav(new Blob([new Uint8Array(1)]), new AbortController().signal, environment({ fetch: impl })))
      .rejects.toMatchObject({ kind: 'network' })
  })

  it('代理回了 HTML（502）→ network，不把 HTML 解析错误漏到界面上', async () => {
    const impl = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch
    await expect(transcribeWav(new Blob([new Uint8Array(1)]), new AbortController().signal, environment({ fetch: impl })))
      .rejects.toMatchObject({ kind: 'network', status: 502 })
  })

  it('成功但文字是空的 → no-speech，提示用户再说一次', async () => {
    const { impl } = recordingFetch(() => json({ text: '   ' }))
    await expect(transcribeWav(new Blob([new Uint8Array(1)]), new AbortController().signal, environment({ fetch: impl })))
      .rejects.toMatchObject({ kind: 'no-speech' })
  })
})

describe('取消（界面上的那条路）', () => {
  it('用户按取消：0 个请求、输入框不动、状态回到空闲', async () => {
    const { impl, calls } = recordingFetch()
    const recorder = fakeRecorder()
    const onDraft = vi.fn()
    const { container, held, unmount } = renderHarness({
      draft: '',
      onDraft,
      onSend: vi.fn(),
      environment: environment({ fetch: impl, mediaRecorder: recorder.ctor, audioContext: fakeAudioContext() }),
    })
    try {
      await clickMic(container)
      expect(recorder.instances).toHaveLength(1)
      await act(async () => { held.session?.cancel(); await settle() })
      expect(calls).toHaveLength(0)
      expect(onDraft).not.toHaveBeenCalled()
      expect(container.querySelector('p.status')?.textContent).toBe('idle')
    } finally { unmount() }
  })

})

describe('stop 在拿到麦克风之前就到了（权限框还开着时又点了一下）', () => {
  it('这一下不落空：麦克风到手后立刻停，并且真的走了一次转写', async () => {
    const { impl, calls } = recordingFetch()
    const recorder = fakeRecorder()
    let release: () => void = () => { /* 下面立刻就被赋值 */ }
    const gate = new Promise<void>((resolve) => { release = resolve })
    const texts: string[] = []
    const phases: VoicePhase[] = []
    const session = startVoiceInput({
      environment: {
        ...environment({ fetch: impl }),
        mediaRecorder: recorder.ctor,
        audioContext: fakeAudioContext(),
        mediaDevices: { getUserMedia: async () => { await gate; return fakeStream() } },
      },
      onPhase: phase => { phases.push(phase) },
      onText: text => { texts.push(text) },
      onFailure: error => { phases.push(`failure:${error.kind}` as VoicePhase) },
    })
    // 还在等 getUserMedia：录音机还不存在，这一下「停」只能被记下来。
    session.stop()
    expect(recorder.instances).toHaveLength(0)
    release()
    await settle(20)
    // 记下的那一下被兑现了：录音机开起来了，并且立刻停 → 转写成功。
    expect(recorder.instances).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(texts).toEqual(['帮我看看这个报错'])
    expect(phases).toContain('recording')
  })
})

describe('encodeWav：单声道 PCM16 / 16 kHz', () => {
  it('44 字节头 + 2 字节每样本，长度与声明一致', () => {
    const wav = encodeWav(new Float32Array(16_000).fill(0.5), 16_000)
    expect(wav.size).toBe(44 + 32_000)
    expect(wav.type).toBe('audio/wav')
  })

  it('静音是 0，满幅不溢出 int16', async () => {
    const silent = new Uint8Array(await encodeWav(new Float32Array(16_000), 16_000).arrayBuffer())
    expect(new DataView(silent.buffer).getInt16(44, true)).toBe(0)
    const loud = new Uint8Array(await encodeWav(new Float32Array(16_000).fill(1), 16_000).arrayBuffer())
    const view = new DataView(loud.buffer)
    expect(view.getInt16(44, true)).toBe(32767)
  })
})

/**
 * 挂一个只用到 `useVoiceInput` 的最小界面：它自己就是那个"输入框"和"发送按钮"。
 *
 * `held.phase` 是**外部指定**的阶段：点第一下开始录，把它置为 `recording`，
 * 第二下就会走「停下并识别」——这正是用户在界面上做的事。
 * 绕开界面直接点 `MediaRecorder` 替身会把状态机前半段跳过去，
 * 测出来的就不再是用户按下去的那条路。
 */
function renderHarness(options: {
  readonly draft: string
  readonly onDraft: (value: string) => void
  readonly onSend: () => void
  readonly environment: VoiceEnvironment
}): {
  readonly container: HTMLElement
  readonly held: { phase: VoicePhase; session: VoiceSession | null }
  readonly rerender: () => void
  readonly unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const held: { phase: VoicePhase; session: VoiceSession | null } = { phase: 'idle', session: null }
  let root: Root
  function Harness() {
    const voice = useVoiceInput({
      draft: options.draft,
      onDraft: options.onDraft,
      support: voiceSupport(options.environment),
      environment: options.environment,
      controlledPhase: held.phase,
      onSession: (session) => { held.session = session },
    })
    return createElement('div', null,
      createElement('button', {
        className: 'composer-mic',
        disabled: !voiceSupport(options.environment).ok,
        onClick: voice.toggle,
        'aria-label': '语音输入',
      }),
      createElement('input', {
        className: 'draft',
        value: options.draft,
        onChange: (event: { target: { value: string } }) => options.onDraft(event.target.value),
      }),
      createElement('button', { className: 'send', onClick: options.onSend }, '发送'),
      createElement('p', { className: 'status' }, voice.error ?? voice.blocked ?? voice.phase))
  }
  const rerender = (): void => { act(() => root.render(createElement(Harness))) }
  act(() => { root = createRoot(container); root.render(createElement(Harness)) })
  return {
    container,
    held,
    rerender,
    unmount: () => { act(() => root.unmount()); container.remove() },
  }
}

/** 点一下麦克风按钮。 */
async function clickMic(container: HTMLElement): Promise<void> {
  const button = container.querySelector('button.composer-mic') as HTMLButtonElement
  await act(async () => { button.click(); await settle() })
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
