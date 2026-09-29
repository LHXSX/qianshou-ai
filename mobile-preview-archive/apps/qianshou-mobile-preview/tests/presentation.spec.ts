// @vitest-environment jsdom
/** User actions and original text are preserved by the product presentation. */
import { afterEach, expect, it, vi } from 'vitest'
import { createWelcomeScreen } from '../src/components/welcome.ts'
import { decorateMessages } from '../src/components/message-view.ts'
import { copy } from '../src/copy.ts'

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('shows the splash and gates the shell behind Shanghai login', async () => {
  const login = vi.fn()
  const welcome = createWelcomeScreen({ onLogin: login, durationMs: 0, mottoDurationMs: 0 })
  welcome.element.showModal = () => { welcome.element.open = true }
  welcome.element.close = () => { welcome.element.open = false }
  document.body.append(welcome.element)
  welcome.open()
  expect(login).not.toHaveBeenCalled()
  expect(welcome.element.classList.contains('splash-screen')).toBe(true)
  expect(welcome.element.textContent).toContain(copy.splashTagline)
  expect(welcome.element.textContent).toContain('无极问道')
  expect(welcome.element.textContent).toContain('千手执棋')
  expect(welcome.element.querySelector('.splash-help')).toBeNull()
  expect(welcome.element.querySelectorAll('.splash-glyph')).toHaveLength(0)
  expect(Array.from(welcome.element.querySelectorAll('.splash-motto-line'), line => line.textContent))
    .toEqual(['无极问道', '千手执棋'])
  await vi.waitFor(() => { expect(login).toHaveBeenCalledOnce(); expect(welcome.element.open).toBe(false) })
  welcome.open()
  const escape = new Event('cancel', { cancelable: true })
  welcome.element.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(true)
  expect(welcome.element.open).toBe(true)
  welcome.close()
})

it('holds the brand for 3 seconds, then shows the two complete motto lines before login', () => {
  vi.useFakeTimers()
  const login = vi.fn()
  const welcome = createWelcomeScreen({ onLogin: login })
  welcome.element.showModal = () => { welcome.element.open = true }
  welcome.element.close = () => { welcome.element.open = false }
  document.body.append(welcome.element)
  welcome.open()
  expect(welcome.element.style.getPropertyValue('--splash-duration')).toBe('4800ms')
  expect(welcome.element.dataset.stage).toBe('brand')
  vi.advanceTimersByTime(2999)
  expect(login).not.toHaveBeenCalled()
  expect(welcome.element.open).toBe(true)
  vi.advanceTimersByTime(1)
  expect(welcome.element.dataset.stage).toBe('motto')
  expect(login).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1799)
  expect(login).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(login).toHaveBeenCalledOnce()
  expect(welcome.element.open).toBe(false)
})

it.each([1000, 3500])('closing the splash after %i ms cancels the pending login transition', (elapsed) => {
  vi.useFakeTimers()
  const login = vi.fn()
  const welcome = createWelcomeScreen({ onLogin: login })
  welcome.element.showModal = () => { welcome.element.open = true }
  welcome.element.close = () => { welcome.element.open = false }
  welcome.open()
  vi.advanceTimersByTime(elapsed)
  welcome.close()
  vi.advanceTimersByTime(5000)
  expect(login).not.toHaveBeenCalled()
  expect(welcome.element.open).toBe(false)
  welcome.open()
  expect(welcome.element.dataset.stage).toBe('brand')
  vi.advanceTimersByTime(4800)
  expect(login).toHaveBeenCalledOnce()
})

it('renders original text safely with real speaker metadata and copies only on user action', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const root = document.createElement('div')
  for (const id of ['user-a', 'assistant-b']) {
    const node = document.createElement('div')
    node.dataset.testid = `mobile-turn-${id}`
    root.append(node)
  }
  const original = '<img src=x onerror=alert(1)>\nkeep original whitespace'
  decorateMessages(root, [
    { id: 'user-a', role: 'user', text: original, at: 1_700_000_000_000 },
    { id: 'assistant-b', role: 'assistant', text: '回复\n第二行', at: 1_700_000_000_100 },
  ])
  document.body.append(root)
  expect(root.querySelector('img')).toBeNull()
  expect(root.querySelector('.message-user .message-body')?.textContent).toBe(original)
  expect(root.querySelector('.message-assistant .message-speaker')?.textContent).toBe(copy.brand)
  expect(writeText).not.toHaveBeenCalled()
  root.querySelector<HTMLButtonElement>('.message-copy')!.click()
  await vi.waitFor(() => { expect(root.textContent).toContain(copy.messageCopied) })
  expect(writeText).toHaveBeenCalledExactlyOnceWith(original)
})

it('keeps raw SVG inside a wrapping code block instead of overflowing the phone', () => {
  const root = document.createElement('div')
  const node = document.createElement('div')
  node.dataset.testid = 'mobile-turn-svg'
  root.append(node)
  decorateMessages(root, [{
    id: 'svg', role: 'assistant', at: 0,
    text: '<svg xmlns="http://www.w3.org/2000/svg" width="400"><path d="M125,145 L100,50 L195,105 Z"/></svg>',
  }])
  expect(root.querySelector('pre')).not.toBeNull()
  expect(root.querySelector('.message-body')?.textContent).toContain('<svg')
})

it('lets the host paint a growing assistant body while copy still uses the Session original', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const root = document.createElement('div')
  const node = document.createElement('div')
  node.dataset.testid = 'mobile-turn-live'
  root.append(node)
  const original = '猜你是想要一张小猫的图'
  decorateMessages(root, [{ id: 'live', role: 'assistant', text: original, at: Date.now() }], {
    streaming: true,
    displayText: () => original.slice(0, 4),
  })
  expect(root.querySelector('.message-body')?.textContent).toBe('猜你是想')
  expect(root.querySelector('.message-streaming')).not.toBeNull()
  root.querySelector<HTMLButtonElement>('.message-copy')!.click()
  await vi.waitFor(() => { expect(writeText).toHaveBeenCalledExactlyOnceWith(original) })
})

it('puts copy and speak marks under assistant replies, copies only that turn, and speaks only that turn', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  class Utterance {
    lang = ''
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly text: string) {}
  }
  const spoken: string[] = []
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
  vi.stubGlobal('speechSynthesis', {
    cancel: vi.fn(),
    speak: (utterance: InstanceType<typeof Utterance>) => {
      spoken.push(utterance.text)
      utterance.onstart?.()
      utterance.onend?.()
    },
  })
  const root = document.createElement('div')
  for (const id of ['user-a', 'assistant-b']) {
    const node = document.createElement('div')
    node.dataset.testid = `mobile-turn-${id}`
    root.append(node)
  }
  decorateMessages(root, [
    { id: 'user-a', role: 'user', text: '用户原话不要播报', at: 1 },
    { id: 'assistant-b', role: 'assistant', text: '助手这一段', at: 2 },
  ])
  const assistant = root.querySelector('.message-assistant')!
  expect(assistant.querySelector('.message-copy .message-action-label')?.textContent).toBe(copy.messageCopy)
  expect(assistant.querySelector('.message-speak .message-action-label')?.textContent).toBe(copy.messageSpeak)
  expect(assistant.querySelector('.message-copy')?.getAttribute('aria-label')).toBe(copy.messageCopy)
  expect(assistant.querySelector('.message-copy')?.getAttribute('title')).toBe(copy.messageCopy)
  expect(assistant.querySelector('.message-speak')?.getAttribute('aria-label')).toBe(copy.messageSpeak)
  expect(assistant.querySelector('.message-speak')?.getAttribute('title')).toBe(copy.messageSpeak)
  expect(assistant.querySelectorAll('svg.message-action-icon')).toHaveLength(2)
  expect(assistant.querySelector('svg.message-action-icon')?.getAttribute('width')).toBe('16')
  expect(root.querySelector('.message-user .message-speak')).toBeNull()
  expect(root.textContent).not.toMatch(/[⧉◖♪♩♬◉♫]/)
  assistant.querySelector<HTMLButtonElement>('.message-copy')!.click()
  await vi.waitFor(() => { expect(writeText).toHaveBeenCalledExactlyOnceWith('助手这一段') })
  expect(assistant.querySelector('[role="status"]')?.getAttribute('data-feedback')).toBe('success')
  expect(assistant.querySelector('[role="status"]')?.getAttribute('aria-atomic')).toBe('true')
  assistant.querySelector<HTMLButtonElement>('.message-speak')!.click()
  expect(spoken).toEqual(['助手这一段'])
  expect(root.textContent).toContain(copy.messageSpoken)
})

it('marks a speaking icon busy while keeping live feedback distinct from a visible error', () => {
  class Utterance {
    lang = ''
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly text: string) {}
  }
  let current: Utterance | undefined
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
  vi.stubGlobal('speechSynthesis', {
    cancel: vi.fn(),
    speak: (utterance: Utterance) => { current = utterance },
  })
  const root = document.createElement('div')
  const turn = document.createElement('article')
  turn.dataset.testid = 'mobile-turn-feedback'
  root.append(turn)
  decorateMessages(root, [{ id: 'feedback', role: 'assistant', text: '这一段正文', at: 0 }])
  const speak = root.querySelector<HTMLButtonElement>('.message-speak')!
  const status = root.querySelector<HTMLElement>('[role="status"]')!
  expect(speak.getAttribute('aria-busy')).toBe('false')
  speak.click()
  current!.onstart!()
  expect(speak.getAttribute('aria-busy')).toBe('true')
  expect(status.dataset.feedback).toBe('active')
  expect(status.textContent).toBe(copy.messageSpeaking)
  current!.onend!()
  expect(speak.getAttribute('aria-busy')).toBe('false')
  expect(status.dataset.feedback).toBe('success')
  speak.click()
  current!.onstart!()
  current!.onerror!()
  expect(speak.getAttribute('aria-busy')).toBe('false')
  expect(status.dataset.feedback).toBe('error')
  expect(status.textContent).toBe(copy.messageSpeakFailed)
})

it('keeps text available if clipboard is denied or the browser has no clipboard service', async () => {
  const root = document.createElement('div')
  const node = document.createElement('div')
  node.dataset.testid = 'mobile-turn-a'
  root.append(node)
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
  decorateMessages(root, [{ id: 'a', role: 'assistant', text: '仍可选择的原文', at: 0 }])
  root.querySelector<HTMLButtonElement>('button')!.click()
  await vi.waitFor(() => { expect(root.textContent).toContain(copy.messageCopyFailed) })
  expect(root.querySelector<HTMLElement>('[role="status"]')?.dataset.feedback).toBe('error')
  expect(root.querySelector('.message-body')?.textContent).toBe('仍可选择的原文')
  vi.stubGlobal('navigator', {})
  root.querySelector<HTMLButtonElement>('button')!.click()
  expect(root.textContent).toContain(copy.messageCopyUnavailable)
})
