// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserVoiceInput, type VoiceInputController, type VoiceStart } from '../src/voice.ts'
import { bindHoldToTalk } from '../src/hold-to-talk.ts'

/** Only the browser engine is replaced. The exported controller and its cancellation/result logic stay real. */
class Engine {
  static instances: Engine[] = []
  static available = vi.fn(async () => 'available')
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  processLocally = false
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onspeechstart: (() => void) | null = null
  onspeechend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onresult: ((event: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null
  start = vi.fn(() => {})
  stop = vi.fn(() => {})
  abort = vi.fn(() => {})
  constructor() { Engine.instances.push(this) }
  result(...parts: [string, boolean][]): void {
    this.onresult?.({ results: parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) })
  }
}
const controllers: VoiceInputController[] = []
function controller(language?: string): VoiceInputController {
  const value = createBrowserVoiceInput(language === undefined ? {} : { language }); controllers.push(value); return value
}
const service = { mode: 'browser-service', consent: true } as const
beforeEach(() => {
  Engine.instances = []; Engine.available.mockReset().mockResolvedValue('available')
  vi.stubGlobal('SpeechRecognition', Engine)
  vi.stubGlobal('webkitSpeechRecognition', undefined)
})
afterEach(() => { for (const value of controllers.splice(0)) value.dispose(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('browser voice dictation', () => {
  it('does not request microphone access on construction or subscribe, and reports API support separately', () => {
    const voice = controller(); const listener = vi.fn(); const off = voice.subscribe(listener)
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', capabilities: { local: true, browserService: true }, mode: null, language: 'zh-CN' })
    expect(Engine.available).not.toHaveBeenCalled()
    expect(Engine.instances[0]!.start).not.toHaveBeenCalled()
    off(); voice.cancel(); expect(listener).not.toHaveBeenCalled()
    expect(Object.isFrozen(voice.snapshot())).toBe(true)
  })
  it('keeps an unsupported browser honest without inventing a transcription', async () => {
    vi.stubGlobal('SpeechRecognition', undefined)
    const voice = controller()
    expect(await voice.start(service)).toBe(false)
    expect(voice.snapshot()).toMatchObject({ phase: 'error', error: 'unsupported', finalText: '', capabilities: { local: false, browserService: false } })
  })
  it('requires explicit service consent and supports prefixed engines without calling them local', async () => {
    class Legacy extends Engine { constructor() { super(); Reflect.deleteProperty(this, 'processLocally') } }
    vi.stubGlobal('SpeechRecognition', undefined); vi.stubGlobal('webkitSpeechRecognition', Legacy)
    const voice = controller()
    expect(voice.snapshot().capabilities).toEqual({ local: false, browserService: true })
    expect(await voice.start({ mode: 'browser-service' } as VoiceStart)).toBe(false)
    expect(voice.snapshot().error).toBe('consent-required')
    expect(Engine.instances[0]!.start).not.toHaveBeenCalled()
    expect(await voice.start({ mode: 'local' })).toBe(false)
    expect(voice.snapshot().error).toBe('local-unavailable')
    expect(await voice.start(service)).toBe(true)
    expect(Engine.instances[0]!.start).toHaveBeenCalledTimes(1)
    expect(Engine.available).not.toHaveBeenCalled()
  })
  it('checks installed Chinese local recognition and sets processLocally before acquiring the microphone', async () => {
    const voice = controller()
    expect(await voice.start({ mode: 'local' })).toBe(true)
    const engine = Engine.instances[0]!
    expect(Engine.available).toHaveBeenCalledWith({ langs: ['zh-CN'], processLocally: true })
    expect(engine).toMatchObject({ processLocally: true, lang: 'zh-CN', continuous: true, interimResults: true, maxAlternatives: 1 })
    expect(voice.snapshot().phase).toBe('starting')
    engine.onstart?.(); expect(voice.snapshot().phase).toBe('listening')
  })
  it.each(['unavailable', 'downloadable', 'downloading'])('does not install language packs or fall back to service when local status is %s', async (availability) => {
    Engine.available.mockResolvedValue(availability)
    const voice = controller()
    expect(await voice.start({ mode: 'local' })).toBe(false)
    expect(voice.snapshot()).toMatchObject({ phase: 'error', error: 'language-unavailable' })
    expect(Engine.instances[0]!.start).not.toHaveBeenCalled()
  })
  it('updates complete Chinese result snapshots without duplicates and waits for final results on stop', async () => {
    const voice = controller(); const view: unknown[] = []
    voice.subscribe(state => view.push({ phase: state.phase, final: state.finalText, interim: state.interimText }))
    await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.(); engine.result(['你好', false]); engine.result(['你好世界', false])
    expect(voice.snapshot()).toMatchObject({ finalText: '', interimText: '你好世界' })
    engine.result(['你好世界', true], ['继续', false])
    expect(voice.snapshot()).toMatchObject({ finalText: '你好世界', interimText: '继续' })
    voice.stop(); voice.stop(); expect(engine.stop).toHaveBeenCalledTimes(1)
    engine.result(['你好世界', true], ['继续写作', true]); engine.onend?.()
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', finalText: '你好世界继续写作', interimText: '', error: null })
    expect(view.slice(-3)).toMatchInlineSnapshot(`
      [
        {
          "final": "你好世界",
          "interim": "继续",
          "phase": "stopping",
        },
        {
          "final": "你好世界继续写作",
          "interim": "",
          "phase": "stopping",
        },
        {
          "final": "你好世界继续写作",
          "interim": "",
          "phase": "idle",
        },
      ]
    `)
    expect(engine.abort).not.toHaveBeenCalled()
  })
  it('rejects double start while a local availability check is pending and never starts after account cancellation', async () => {
    let ready!: (value: string) => void
    Engine.available.mockImplementation(() => new Promise((resolve) => { ready = resolve }))
    const voice = controller(); const first = voice.start({ mode: 'local' })
    expect(voice.snapshot().phase).toBe('checking')
    expect(await voice.start(service)).toBe(false)
    voice.cancel(); ready('available')
    expect(await first).toBe(false)
    expect(Engine.instances[0]!.start).not.toHaveBeenCalled()
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', mode: null, finalText: '', interimText: '' })
    expect(await voice.start(service)).toBe(true)
    expect(Engine.instances).toHaveLength(2)
  })
  it('stop during capability checking cancels instead of opening the microphone later', async () => {
    let ready!: (value: string) => void
    Engine.available.mockImplementation(() => new Promise((resolve) => { ready = resolve }))
    const voice = controller(); const pending = voice.start({ mode: 'local' })
    voice.stop(); ready('available'); expect(await pending).toBe(false)
    expect(Engine.instances[0]!.start).not.toHaveBeenCalled()
  })
  it.each(['cancel', 'dispose'] as const)('%s aborts owned audio, clears texts and ignores already-queued callbacks', async (action) => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!
    const result = engine.onresult!; const error = engine.onerror!; const end = engine.onend!
    engine.result(['旧账号私密文本', true]); voice[action]()
    result({ results: [{ isFinal: true, 0: { transcript: '迟到转写' } }] }); error({ error: 'network' }); end()
    expect(engine.abort).toHaveBeenCalledTimes(1)
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', mode: null, finalText: '', interimText: '', error: null })
    if (action === 'dispose') expect(await voice.start(service)).toBe(false)
  })
  it.each([
    ['not-allowed', 'permission-denied'], ['service-not-allowed', 'permission-denied'],
    ['audio-capture', 'no-device'], ['network', 'network'], ['no-speech', 'no-speech'],
    ['language-not-supported', 'language-unavailable'], ['aborted', 'aborted'], ['unknown', 'recognition-failed'],
  ])('reports browser %s as %s without error/end turning it into success', async (native, expected) => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!; const end = engine.onend!
    engine.onerror?.({ error: native }); end()
    expect(voice.snapshot()).toMatchObject({ phase: 'error', error: expected, interimText: '' })
  })
  it('maps synchronous permission and device failures and permits an explicit retry', async () => {
    const voice = controller('zh-HK'); const first = Engine.instances[0]!
    first.start.mockImplementation(() => { throw new DOMException('blocked', 'NotAllowedError') })
    expect(await voice.start(service)).toBe(false)
    expect(voice.snapshot().error).toBe('permission-denied')
    expect(await voice.start(service)).toBe(true)
    expect(Engine.instances[1]!.lang).toBe('zh-HK')
    Engine.instances[1]!.stop.mockImplementation(() => { throw new DOMException('device gone', 'NotFoundError') })
    voice.stop(); expect(voice.snapshot().error).toBe('no-device')
  })
  it('does not acquire audio if a consumer cancels while the starting state is published', async () => {
    const voice = controller()
    voice.subscribe((state) => { if (state.phase === 'starting') voice.cancel() })
    expect(await voice.start(service)).toBe(false)
    expect(Engine.instances[0]!.start).not.toHaveBeenCalled()
  })
})


describe('utterance silence and release lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers() })
  it.each([true, false])('keeps a held utterance through pauses until key release (acoustic events: %s)', async (acousticEvents) => {
    const voice = createBrowserVoiceInput({ autoStopOnSilence: false })
    controllers.push(voice)
    const control = document.createElement('button')
    let starting: Promise<boolean> | undefined
    const unbind = bindHoldToTalk(control, {
      start: () => { starting = voice.start(service) },
      finish: () => { voice.stop() }, cancel: () => { voice.cancel() }, cancelling: () => {},
      active: () => !['idle', 'error'].includes(voice.snapshot().phase),
    })
    try {
      control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
      expect(await starting).toBe(true)
      const engine = Engine.instances[0]!
      engine.onstart?.()
      if (acousticEvents) engine.onspeechstart?.()
      engine.result(['第一句。', true])
      if (acousticEvents) engine.onspeechend?.()
      vi.advanceTimersByTime(10_000)
      expect(voice.snapshot().phase).toBe('listening')
      expect(engine.stop).not.toHaveBeenCalled()
      expect(engine.abort).not.toHaveBeenCalled()
      if (acousticEvents) engine.onspeechstart?.()
      engine.result(['第一句。', true], ['暂停后继续说。', true])
      if (acousticEvents) engine.onspeechend?.()
      vi.advanceTimersByTime(10_000)
      expect(engine.stop).not.toHaveBeenCalled()
      control.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }))
      expect(engine.stop).toHaveBeenCalledOnce()
      expect(voice.snapshot().phase).toBe('stopping')
      engine.onend?.()
      expect(voice.snapshot()).toMatchObject({ phase: 'idle', finalText: '第一句。暂停后继续说。' })
    } finally { unbind() }
  })
  it('keeps acoustic silence timing when delayed interim text arrives after speech ends', async () => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.(); engine.onspeechstart?.(); engine.result(['正在识别', false]); engine.onspeechend?.()
    vi.advanceTimersByTime(900); engine.result(['正在识别更多文字', false])
    vi.advanceTimersByTime(499); expect(engine.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(engine.stop).toHaveBeenCalledTimes(1)
    expect(voice.snapshot().phase).toBe('stopping')
  })
  it('does not stop continuous speech merely because a segment becomes final', async () => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.(); engine.onspeechstart?.(); engine.result(['第一句话。', true])
    vi.advanceTimersByTime(3000); expect(engine.stop).not.toHaveBeenCalled()
    engine.onspeechend?.(); vi.advanceTimersByTime(1000)
    engine.onspeechstart?.(); vi.advanceTimersByTime(5000); expect(engine.stop).not.toHaveBeenCalled()
    engine.onspeechend?.(); vi.advanceTimersByTime(1400); expect(engine.stop).toHaveBeenCalledTimes(1)
  })
  it('uses final-text timing only when acoustic events are unavailable, resetting for new interim speech', async () => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.(); engine.result(['第一句', true]); vi.advanceTimersByTime(1000)
    engine.result(['第一句', true], ['第二句', false]); vi.advanceTimersByTime(3000)
    expect(engine.stop).not.toHaveBeenCalled()
    engine.result(['第一句', true], ['第二句', true]); vi.advanceTimersByTime(1400)
    expect(engine.stop).toHaveBeenCalledTimes(1)
  })
  it('releases a recognizer without onend once, preserves final words and discards unresolved interim', async () => {
    const voice = controller(); const phases: string[] = []; voice.subscribe((state) => { phases.push(state.phase) })
    await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.(); engine.result(['已确认', true], ['未确认', false])
    const end = engine.onend!; const result = engine.onresult!
    voice.stop(); voice.stop(); vi.advanceTimersByTime(2499)
    expect(voice.snapshot().phase).toBe('stopping'); vi.advanceTimersByTime(1)
    expect(engine.abort).toHaveBeenCalledTimes(1)
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', finalText: '已确认', interimText: '' })
    const emissions = phases.length
    end(); result({ results: [{ isFinal: true, 0: { transcript: '迟到文字' } }] })
    vi.advanceTimersByTime(5000)
    expect(phases).toHaveLength(emissions); expect(engine.abort).toHaveBeenCalledTimes(1)
    expect(voice.snapshot().finalText).toBe('已确认')
  })
  it('clears the release deadline after a normal end and permits the next utterance', async () => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.(); engine.result(['第一句', true]); voice.stop(); engine.onend?.()
    await voice.start(service); const next = Engine.instances[1]!; next.onstart?.()
    vi.advanceTimersByTime(3000)
    expect(next.stop).not.toHaveBeenCalled(); expect(next.abort).not.toHaveBeenCalled()
    expect(voice.snapshot()).toMatchObject({ phase: 'listening', finalText: '' })
  })
  it.each(['cancel', 'dispose'] as const)('%s clears every pending silence/end callback', async (operation) => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.(); engine.result(['旧会话', true]); engine.onspeechend?.()
    const speechEnd = engine.onspeechend!; const result = engine.onresult!
    voice[operation](); speechEnd(); result({ results: [{ isFinal: true, 0: { transcript: '旧账号文字' } }] })
    vi.advanceTimersByTime(10000)
    expect(engine.stop).not.toHaveBeenCalled(); expect(engine.abort).toHaveBeenCalledTimes(1)
    expect(voice.snapshot()).toMatchObject({ phase: 'idle', mode: null, finalText: '', interimText: '' })
  })
  it('does not install an old result timer after a subscriber cancels and starts a new recognizer', async () => {
    const voice = controller(); await voice.start(service); const engine = Engine.instances[0]!
    engine.onstart?.()
    let changed = false
    voice.subscribe((state) => {
      if (state.finalText !== '旧会话' || changed) return
      changed = true; voice.cancel(); void voice.start(service)
      Engine.instances[1]!.onstart?.()
    })
    engine.result(['旧会话', true]); vi.advanceTimersByTime(5000)
    expect(voice.snapshot()).toMatchObject({ phase: 'listening', finalText: '' })
    expect(Engine.instances[1]!.stop).not.toHaveBeenCalled()
  })
})
