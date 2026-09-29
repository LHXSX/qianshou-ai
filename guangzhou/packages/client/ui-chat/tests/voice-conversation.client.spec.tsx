// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputActions, InputState, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { EMPTY_CHAT_SNAPSHOT } from '../src/client/contract/snapshot.ts'
import { latestVoiceReply, VoiceConversation } from '../src/client/chat/voice/VoiceConversation.tsx'
import { claimSpeechOutput } from '../src/client/chat/voice/speech-ownership.ts'
import { startSpeechPlayback } from '../src/client/chat/voice/speech-playback.ts'

// Canvas drawing has its own renderer suite; these tests exercise capture and task ownership.
vi.mock('../src/client/chat/voice/VRMCompanion.tsx', () => ({ VRMCompanion: () => <span aria-hidden="true" /> }))

const capture = vi.hoisted(() => ({
  onSegment: undefined as ((blob: Blob) => void) | undefined,
  onBargeIn: undefined as (() => void) | undefined, bargeInAvailable: true, monitorPlayback: vi.fn(),
  listen: vi.fn(), close: vi.fn(), open: vi.fn(), voicing: vi.fn(() => false),
}))
vi.mock('../src/client/chat/voice/audio.ts', () => ({
  openMicrophone: async (onSegment: (blob: Blob) => void, _onLost: () => void, onBargeIn: () => void) => {
    await capture.open(); capture.onSegment = onSegment; capture.onBargeIn = onBargeIn
    return {
      listen: capture.listen, close: capture.close, isVoicing: capture.voicing,
      bargeInAvailable: capture.bargeInAvailable, monitorPlayback: capture.monitorPlayback,
    }
  },
}))

const speech = vi.hoisted(() => ({
  autoStart: true, begin: undefined as (() => void) | undefined,
  speak: vi.fn(), cancel: vi.fn(), done: undefined as (() => void) | undefined, fail: undefined as (() => void) | undefined,
}))
vi.mock('../src/client/chat/voice/speech.ts', () => ({
  speakReply: (text: string, _language: string, done: () => void, fail: () => void) => {
    let finish: ReturnType<typeof startSpeechPlayback> | undefined
    speech.begin = () => { finish ??= startSpeechPlayback({ source: 'system' }) }
    speech.speak(text)
    if (speech.autoStart) speech.begin()
    speech.done = () => { finish?.('end'); done() }
    speech.fail = () => { finish?.('error'); fail() }
    return () => { speech.cancel(); finish?.('cancel') }
  },
}))

function bench(draft = '', transcribe: ComponentProps<typeof VoiceConversation>['transcribe'] = vi.fn(async () => '检查项目的启动流程')) {
  const input = createSnapshotStore<InputState>({ draft, draftRev: 1, phase: 'plain', attachmentIds: [], occurrences: [], queue: [] })
  const session = createSnapshotStore(sessionSnapshot('voice-session' as SessionId))
  const chat = createSnapshotStore(EMPTY_CHAT_SNAPSHOT)
  const pending = createSnapshotStore(new Map<string, unknown>())
  const status = vi.fn(async () => true)
  const task = new AbortController()
  const submitted: { mode: Parameters<InputActions['submit']>[0]; text: string }[] = []
  const submit = vi.fn((mode: Parameters<InputActions['submit']>[0]) => {
    submitted.push({ mode, text: input.getSnapshot().draft })
    input.set({ ...input.getSnapshot(), draft: '', draftRev: input.getSnapshot().draftRev + 1 })
  })
  const props = {
    sessionId: 'voice-session' as SessionId,
    useSession: bindSnapshotSelector(session), useInput: bindSnapshotSelector(input), useChat: bindSnapshotSelector(chat),
    useSessions: (select: (s: unknown) => unknown) => select({ byId: { 'voice-session': { cwd: '/project' } } }),
    useSessionPendingInteraction: bindSnapshotSelector(pending),
    useVoiceBlock: (select: (s: undefined) => unknown) => select(undefined),
    inputActions: {
      setDraft: (text: string) => { input.set({ ...input.getSnapshot(), draft: text, draftRev: input.getSnapshot().draftRev + 1 }) },
      submit,
    },
    status, transcribe, stopAgent: vi.fn(() => { task.abort() }), t: makeTranslate(zh, commonZh),
  } as unknown as ComponentProps<typeof VoiceConversation>
  const view = render(<VoiceConversation {...props} />)
  return { view, input, session, chat, pending, status, transcribe, submit, submitted, props, task }
}

/**
 * Read the companion panel's own status line. The voice picker renders its own
 * polite live region inside the same panel, so an unscoped role query is
 * ambiguous; scoping keeps these assertions about panel state.
 */
function voiceStatus(view: ReturnType<typeof render>): string {
  const panel = view.getByRole('complementary', { name: zh['character.label'] })
  return panel.querySelector('[data-character-status]')?.textContent ?? ''
}
/** Read the panel's own alert text, or null when the panel reports no alert. */
function voiceAlert(view: ReturnType<typeof render>): string | null {
  const line = view.queryAllByRole('alert')
  return line.length === 1 ? line[0]!.textContent : null
}

function voiceOption(view: ReturnType<typeof render>, name: string) {
  fireEvent.click(view.getByRole('button', { name: zh['voice.delivery'] }))
  fireEvent.click(view.getByRole('menuitem', { name }))
}

function voiceTailData(tail: unknown) {
  const store = createSnapshotStore(tail)
  return { get: () => store.getSnapshot(), source: () => store }
}

function answer(turn: number, seq: number, text: string, status: 'open' | 'closed' = 'closed') {
  return {
    turn, status, steps: [], start: undefined, end: undefined,
    data: voiceTailData({ closing: { finalNode: { seq }, blocks: [{ kind: 'text', text }] } }),
  } as unknown as TurnLocation
}

function publish(b: ReturnType<typeof bench>, ...turns: ReturnType<typeof answer>[]) {
  const typed = turns as unknown as { turn: number }[]
  b.chat.set({ ...EMPTY_CHAT_SNAPSHOT, timeline: {
    turnOrder: typed.map(turn => turn.turn),
    turns: new Map(typed.map((turn, index) => [turn.turn, turns[index]!])),
  } })
}

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear()
  vi.clearAllMocks()
  capture.voicing.mockReturnValue(false)
  capture.bargeInAvailable = true
  speech.autoStart = true
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } })
  vi.stubGlobal('AudioContext', function AudioContext() {})
  vi.stubGlobal('SpeechSynthesisUtterance', function SpeechSynthesisUtterance() {})
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('voice conversation lifecycle', () => {
  it('keeps the draft and agent untouched when microphone permission is denied', async () => {
    const b = bench('保留原稿')
    capture.open.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
    voiceOption(b.view, zh['voice.dictate'])
    await waitFor(() => { expect(voiceAlert(b.view)).toBe(zh['voice.microphoneDenied']) })
    expect(b.input.getSnapshot().draft).toBe('保留原稿')
    expect(b.submit).not.toHaveBeenCalled()
    expect(b.transcribe).not.toHaveBeenCalled()
    expect(b.view.getByRole('button', { name: '开始语音对话' })).toBeTruthy()
  })
  it('aborts an in-flight transcription when approval pauses voice and ignores the late result', async () => {
    let resolve!: (text: string) => void
    const transcribe = vi.fn((_audio: Blob, _signal: AbortSignal) => new Promise<string>((done) => { resolve = done }))
    const b = bench('', transcribe)
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { capture.onSegment?.(new Blob(['audio'])) })
    const signal = transcribe.mock.calls[0]?.[1]
    act(() => { b.pending.set(new Map([['voice-session', {}]])) })
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolve('审批出现后不能自动发送') })
    expect(b.submit).not.toHaveBeenCalled()
    expect(b.input.getSnapshot().draft).toBe('')
    expect(voiceAlert(b.view)).toBe(zh['voice.approval'])
  })
  it('only opens after explicit activation and sends original speech to the current concierge session', async () => {
    const b = bench()
    expect(capture.open).not.toHaveBeenCalled()
    expect(b.status).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(b.view.getByText('正在聆听')).toBeTruthy() })
    await act(async () => { capture.onSegment?.(new Blob(['audio'])) })
    expect(b.submit).toHaveBeenCalledWith('queue')
    expect(b.submitted).toEqual([{ mode: 'queue', text: '检查项目的启动流程' }])
    expect(b.view.getByText('刚刚识别：检查项目的启动流程')).toBeTruthy()
    await waitFor(() => { expect(b.view.getByText('正在聆听')).toBeTruthy() })
    fireEvent.click(b.view.getByRole('button', { name: '结束语音' }))
    expect(capture.close).toHaveBeenCalledOnce()
  })
  it('keeps an existing draft intact and offers non-submitting dictation', async () => {
    const b = bench('原来的内容')
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    expect(capture.open).not.toHaveBeenCalled()
    expect(b.input.getSnapshot().draft).toBe('原来的内容')
    voiceOption(b.view, zh['voice.dictate'])
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    await act(async () => { capture.onSegment?.(new Blob(['audio'])) })
    expect(b.input.getSnapshot().draft).toBe('原来的内容\n检查项目的启动流程')
    expect(b.submit).not.toHaveBeenCalled()
  })
  it('aborts transcription and ignores its late response after stop', async () => {
    let resolve!: (text: string) => void
    const pending = new Promise<string>((done) => { resolve = done })
    const b = bench('', vi.fn(() => pending))
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { capture.onSegment?.(new Blob(['audio'])) })
    fireEvent.click(b.view.getByRole('button', { name: '结束语音' }))
    await act(async () => { resolve('不能发送这段话') })
    expect(b.submit).not.toHaveBeenCalled()
    expect(b.input.getSnapshot().draft).toBe('')
    expect(capture.close).toHaveBeenCalledOnce()
  })
  it('does not overwrite text edited during transcription', async () => {
    let resolve!: (text: string) => void
    const b = bench('', vi.fn(() => new Promise<string>((done) => { resolve = done })))
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { capture.onSegment?.(new Blob(['audio'])) })
    act(() => { b.input.set({ ...b.input.getSnapshot(), draft: '手动输入', draftRev: 2 }) })
    await act(async () => { resolve('识别内容') })
    expect(b.input.getSnapshot().draft).toBe('手动输入')
    expect(b.submit).not.toHaveBeenCalled()
    expect(voiceAlert(b.view)).not.toBeNull()
  })
  it('waits for a real closed assistant turn before reading in current-task mode', async () => {
    const b = bench()
    voiceOption(b.view, zh['voice.current'])
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    await act(async () => { capture.onSegment?.(new Blob(['audio'])) })
    expect(b.submit).toHaveBeenCalledWith('queue')
    expect(speech.speak).not.toHaveBeenCalled()
    act(() => { b.session.set({ ...b.session.getSnapshot(), running: true }) })
    expect(speech.speak).not.toHaveBeenCalled()
    act(() => {
      b.chat.set({ ...EMPTY_CHAT_SNAPSHOT, timeline: { turnOrder: [1], turns: new Map([[1, {
        turn: 1, status: 'closed', steps: [], start: undefined, end: undefined,
        data: voiceTailData({ closing: { finalNode: { seq: 5 }, blocks: [{ kind: 'text', text: '启动流程已确认' }] } }),
      } as never]]) } })
      b.session.set({ ...b.session.getSnapshot(), running: false })
    })
    expect(speech.speak).toHaveBeenCalledWith('启动流程已确认')
    expect(b.view.getByText('正在朗读回复')).toBeTruthy()
    act(() => { b.pending.set(new Map([['voice-session', {}]])) })
    expect(speech.cancel).toHaveBeenCalledOnce()
    expect(capture.listen).toHaveBeenLastCalledWith(false)
    expect(voiceAlert(b.view)).toBe(zh['voice.approval'])
    b.view.unmount()
    expect(speech.cancel).toHaveBeenCalled()
    expect(capture.close).toHaveBeenCalled()
  })
  it('ends capture on session navigation and rejects late transcription', async () => {
    let resolve!: (text: string) => void
    const b = bench('', vi.fn(() => new Promise<string>((done) => { resolve = done })))
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { capture.onSegment?.(new Blob(['audio'])) })
    b.view.rerender(<VoiceConversation {...b.props} sessionId={'different-session' as SessionId} />)
    await act(async () => { resolve('旧会话的语音') })
    expect(capture.close).toHaveBeenCalledOnce()
    expect(b.submit).not.toHaveBeenCalled()
    expect(b.view.getByRole('button', { name: '开始语音对话' })).toBeTruthy()
  })
  it('keeps listening when a parallel task is dispatched during a running parent turn', async () => {
    const b = bench()
    voiceOption(b.view, zh['voice.parallel'])
    act(() => { b.session.set({ ...b.session.getSnapshot(), running: true }) })
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    await act(async () => { capture.onSegment?.(new Blob(['audio'])) })
    expect(b.submit).toHaveBeenCalledWith('parallel')
    expect(b.props.stopAgent).not.toHaveBeenCalled()
    expect(b.view.getByText('正在聆听')).toBeTruthy()
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('automatically reads the real closed parent response after parallel settlement and resumes the next dispatch', async () => {
    const b = bench()
    voiceOption(b.view, zh['voice.parallel'])
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    await act(async () => { capture.onSegment?.(new Blob(['audio'])) })
    expect(b.submit).toHaveBeenCalledWith('parallel')
    expect(b.view.getByText('正在聆听')).toBeTruthy()

    // Runtime settlement wakes the parent. A running parent and a draft
    // closing projection must not be confused with its completed answer.
    const turn = {
      turn: 1, status: 'open', steps: [], start: undefined, end: undefined,
      data: voiceTailData({ closing: { finalNode: { seq: 8 }, blocks: [{ kind: 'text', text: '独立任务已完成，测试通过。' }] } }),
    }
    act(() => {
      b.session.set({ ...b.session.getSnapshot(), running: true })
      b.chat.set({ ...EMPTY_CHAT_SNAPSHOT, timeline: { turnOrder: [1], turns: new Map([[1, turn as never]]) } })
    })
    expect(speech.speak).not.toHaveBeenCalled()
    act(() => {
      b.chat.set({ ...EMPTY_CHAT_SNAPSHOT, timeline: { turnOrder: [1], turns: new Map([[1, { ...turn, status: 'closed' } as never]]) } })
      b.session.set({ ...b.session.getSnapshot(), running: false })
    })
    expect(speech.speak).toHaveBeenCalledExactlyOnceWith('独立任务已完成，测试通过。')
    expect(capture.monitorPlayback).toHaveBeenCalledOnce()
    expect(b.view.getByText('正在朗读回复')).toBeTruthy()
    act(() => { speech.done?.() })
    await waitFor(() => { expect(b.view.getByText('正在聆听')).toBeTruthy() })
    expect(capture.listen).toHaveBeenLastCalledWith(true)
    await act(async () => { capture.onSegment?.(new Blob(['next audio'])) })
    expect(b.submit).toHaveBeenCalledTimes(2)
    expect(b.submit).toHaveBeenLastCalledWith('parallel')
    expect(speech.speak).toHaveBeenCalledOnce()
  })

  it('keeps chat, clarification and follow-up utterances on the same concierge input flow', async () => {
    const transcribe = vi.fn()
      .mockResolvedValueOnce('我们先聊聊，你觉得这个想法怎么样？')
      .mockResolvedValueOnce('就是刚才那个家庭账本，先只给我自己用。')
      .mockResolvedValueOnce('对，接着做，但先别接入真实支付。')
    const b = bench('', transcribe)
    expect(b.view.getByRole('button', { name: zh['voice.start'] }).getAttribute('aria-description')).toBe(zh['voice.manager'])
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    await act(async () => { capture.onSegment?.(new Blob(['greeting'])) })
    expect(b.view.getByText('正在聆听')).toBeTruthy()
    act(() => { publish(b, answer(1, 5, '你希望这个账本只服务你自己，还是全家一起用？')) })
    expect(speech.speak).toHaveBeenLastCalledWith('你希望这个账本只服务你自己，还是全家一起用？')
    act(() => { speech.done?.() })
    await waitFor(() => { expect(b.view.getByText('正在聆听')).toBeTruthy() })
    await act(async () => { capture.onSegment?.(new Blob(['clarification'])) })
    act(() => { b.session.set({ ...b.session.getSnapshot(), running: true }) })
    await act(async () => { capture.onSegment?.(new Blob(['follow-up'])) })
    expect(b.submitted).toEqual([
      { mode: 'queue', text: '我们先聊聊，你觉得这个想法怎么样？' },
      { mode: 'queue', text: '就是刚才那个家庭账本，先只给我自己用。' },
      { mode: 'steer', text: '对，接着做，但先别接入真实支付。' },
    ])
    expect(b.submit).not.toHaveBeenCalledWith('parallel')
    expect(b.props.stopAgent).not.toHaveBeenCalled()
    expect(b.view.getByText('正在聆听')).toBeTruthy()
  })

  it('keeps listening while the manager works, and speaks only its completed answer', async () => {
    const b = bench()
    act(() => { b.session.set({ ...b.session.getSnapshot(), running: true }) })
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    await act(async () => { capture.onSegment?.(new Blob(['supplement'])) })
    expect(b.submit).toHaveBeenCalledWith('steer')
    expect(b.view.getByText('正在聆听')).toBeTruthy()
    act(() => { publish(b, answer(1, 7, '中间推理不应朗读', 'open')) })
    expect(speech.speak).not.toHaveBeenCalled()
    act(() => { publish(b, answer(1, 9, '这项交给团队处理，你还想补充什么？')) })
    expect(speech.speak).toHaveBeenCalledExactlyOnceWith('这项交给团队处理，你还想补充什么？')
    // Background activity does not require cancelling the current agent.
    expect(b.props.stopAgent).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('button', { name: zh['character.interrupt'] }))
    expect(speech.cancel).toHaveBeenCalledOnce()
    expect(capture.listen).toHaveBeenLastCalledWith(true)
    await act(async () => { capture.onSegment?.(new Blob(['another supplement'])) })
    expect(b.submit).toHaveBeenCalledTimes(2)
    expect(b.submit).toHaveBeenLastCalledWith('steer')
  })

  it('retains final replies while the user speaks and a new turn opens, then reads them in order', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    capture.voicing.mockReturnValue(true)
    const first = answer(1, 5, '第一项已经安排好了。')
    act(() => { publish(b, first) })
    act(() => { publish(b, first, answer(2, 8, '尚未完成的推理', 'open')) })
    expect(latestVoiceReply(b.chat.getSnapshot())?.text).toBe('第一项已经安排好了。')
    act(() => { publish(b, first, answer(2, 10, '补充要求也已记录。')) })
    expect(speech.speak).not.toHaveBeenCalled()
    capture.voicing.mockReturnValue(false)
    await waitFor(() => { expect(speech.speak).toHaveBeenCalledExactlyOnceWith('第一项已经安排好了。') })
    act(() => { speech.done?.() })
    await waitFor(() => { expect(speech.speak).toHaveBeenLastCalledWith('补充要求也已记录。') })
    expect(speech.speak).toHaveBeenCalledTimes(2)
    expect(capture.monitorPlayback).toHaveBeenCalledTimes(2)
    fireEvent.click(b.view.getByRole('button', { name: '结束语音' }))
    act(() => { speech.done?.() })
    expect(b.view.getByRole('button', { name: '开始语音对话' })).toBeTruthy()
    expect(capture.close).toHaveBeenCalledOnce()
  })

  it('observes a final reply published only through the Turn Location after the Chat snapshot settles', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    const tail = createSnapshotStore<unknown>(undefined)
    const turn = { ...answer(1, 5, ''), data: { get: () => tail.getSnapshot(), source: () => tail } } as unknown as TurnLocation
    act(() => { publish(b, turn) })
    const snapshot = b.chat.getSnapshot()
    expect(speech.speak).not.toHaveBeenCalled()
    act(() => { tail.set({ closing: { finalNode: { seq: 5 }, blocks: [{ kind: 'text', text: '位置数据已独立发布。' }] } }) })
    expect(b.chat.getSnapshot()).toBe(snapshot)
    expect(speech.speak).toHaveBeenCalledExactlyOnceWith('位置数据已独立发布。')
    expect(b.task.signal.aborted).toBe(false)
  })

  it('stops playback on sustained speech without resetting the buffered onset or cancelling the agent', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { b.session.set({ ...b.session.getSnapshot(), running: true }); publish(b, answer(1, 5, '先说已经安排好的第一项。')) })
    expect(capture.monitorPlayback).toHaveBeenCalledOnce()
    expect(b.view.getByText(zh['voice.bargeInHint'])).toBeTruthy()
    const staleDone = speech.done; const staleFail = speech.fail
    act(() => { publish(b, answer(1, 5, '先说已经安排好的第一项。'), answer(2, 9, '等待播放的旧回答。')) })
    const listensBeforeOnset = capture.listen.mock.calls.length
    act(() => { capture.onBargeIn?.() })
    expect(speech.cancel).toHaveBeenCalledOnce()
    expect(capture.listen).toHaveBeenCalledTimes(listensBeforeOnset)
    expect(voiceStatus(b.view)).toBe(zh['voice.listening'])
    act(() => { staleDone?.(); staleFail?.() })
    expect(voiceStatus(b.view)).toBe(zh['voice.listening'])
    expect(voiceAlert(b.view)).toBeNull()
    await act(async () => { capture.onSegment?.(new Blob(['first-word-and-rest'])) })
    expect(b.submitted).toEqual([{ mode: 'steer', text: '检查项目的启动流程' }])
    expect(b.task.signal.aborted).toBe(false)
    expect(b.props.stopAgent).not.toHaveBeenCalled()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)) })
    expect(speech.speak).toHaveBeenCalledOnce()
    act(() => { publish(b, answer(1, 5, '先说已经安排好的第一项。'), answer(2, 9, '等待播放的旧回答。'), answer(3, 12, '根据刚才补充的新回答。')) })
    expect(speech.speak).toHaveBeenLastCalledWith('根据刚才补充的新回答。')
    expect(speech.speak).toHaveBeenCalledTimes(2)
  })

  it('pauses playback for typing, preserves the draft, and never replays cancelled replies on resume', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { publish(b, answer(1, 5, '当前正在播放的回答。')) })
    const staleDone = speech.done; const staleFail = speech.fail
    act(() => { publish(b, answer(1, 5, '当前正在播放的回答。'), answer(2, 9, '排队的旧回答。')) })
    act(() => { b.input.set({ ...b.input.getSnapshot(), draft: '等一下，我想先改需求', draftRev: 2 }) })
    expect(voiceStatus(b.view)).toBe(zh['voice.paused'])
    expect(voiceAlert(b.view)).toBe(zh['voice.typingPaused'])
    expect(b.input.getSnapshot().draft).toBe('等一下，我想先改需求')
    expect(speech.cancel).toHaveBeenCalledOnce()
    expect(capture.listen).toHaveBeenLastCalledWith(false)
    act(() => { staleDone?.(); staleFail?.(); capture.onSegment?.(new Blob(['ignored'])) })
    expect(b.transcribe).not.toHaveBeenCalled()
    expect(b.submit).not.toHaveBeenCalled()
    expect(b.task.signal.aborted).toBe(false)
    expect(b.props.stopAgent).not.toHaveBeenCalled()
    act(() => { publish(b, answer(1, 5, '当前正在播放的回答。'), answer(2, 9, '排队的旧回答。'), answer(3, 12, '暂停期间的回答。')) })
    act(() => { b.input.set({ ...b.input.getSnapshot(), draft: '', draftRev: 3 }) })
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.resumeMic'] }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)) })
    expect(voiceStatus(b.view)).toBe(zh['voice.listening'])
    expect(speech.speak).toHaveBeenCalledOnce()
    expect(b.submit).not.toHaveBeenCalled()
  })

  it('shows preparation until actual playback starts, while allowing cancellation of pending synthesis', async () => {
    speech.autoStart = false
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { publish(b, answer(1, 5, '需要合成的新回复。')) })
    expect(voiceStatus(b.view)).toBe(zh['voice.preparingSpeech'])
    expect(b.view.getByRole('button', { name: zh['character.interrupt'] })).toBeTruthy()
    act(() => { speech.begin?.() })
    expect(voiceStatus(b.view)).toBe(zh['voice.speaking'])
    fireEvent.click(b.view.getByRole('button', { name: zh['character.interrupt'] }))
    expect(voiceStatus(b.view)).toBe(zh['voice.listening'])
    expect(speech.cancel).toHaveBeenCalledOnce()
    expect(b.task.signal.aborted).toBe(false)
  })

  it('keeps manual interruption available when actual echo cancellation is not confirmed', async () => {
    capture.bargeInAvailable = false
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { publish(b, answer(1, 5, '当前回答。')) })
    expect(b.view.getByText(zh['voice.manualInterruptHint'])).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: zh['character.interrupt'] }))
    expect(speech.cancel).toHaveBeenCalledOnce()
    expect(capture.listen).toHaveBeenLastCalledWith(true)
    expect(voiceStatus(b.view)).toBe(zh['voice.listening'])
    expect(b.task.signal.aborted).toBe(false)
  })

  it('preserves an attachment added during transcription instead of submitting it with speech', async () => {
    let resolve!: (text: string) => void
    const b = bench('', vi.fn(() => new Promise<string>((done) => { resolve = done })))
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { capture.onSegment?.(new Blob(['audio'])) })
    act(() => { b.input.set({ ...b.input.getSnapshot(), attachmentIds: ['kept-image' as never] }) })
    await act(async () => { resolve('只发这句话') })
    expect(b.submit).not.toHaveBeenCalled()
    expect(b.input.getSnapshot().attachmentIds).toEqual(['kept-image'])
    expect(b.input.getSnapshot().draft).toBe('')
    expect(voiceAlert(b.view)).toBe(zh['voice.draftChanged'])
  })

  it('keeps a selected child on its authorized input route instead of silently invoking the concierge', async () => {
    const b = bench()
    act(() => { b.session.set({ ...b.session.getSnapshot(), subagent: {
      address: { parentSessionId: 'parent' as SessionId, childSessionId: 'voice-session' as SessionId, mode: 'continuable' },
      parentAvailable: true,
    } }) })
    expect(b.view.getByRole('button', { name: zh['voice.start'] }).getAttribute('aria-description')).toBe(zh['voice.current'])
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.delivery'] }))
    expect((b.view.getByRole('menuitem', { name: zh['voice.manager'] }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(b.view.getByRole('menuitem', { name: zh['voice.current'] }))
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    await act(async () => { capture.onSegment?.(new Blob(['child follow-up'])) })
    expect(b.submitted).toEqual([{ mode: 'queue', text: '检查项目的启动流程' }])
  })

  it('drops deferred playback on navigation and ignores a late speech callback after manual interruption', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { publish(b, answer(1, 5, '可以，我先问清楚你的目标。')) })
    const staleDone = speech.done
    fireEvent.click(b.view.getByRole('button', { name: zh['character.interrupt'] }))
    act(() => { staleDone?.() })
    expect(capture.listen).toHaveBeenLastCalledWith(true)
    capture.voicing.mockReturnValue(true)
    act(() => { publish(b, answer(1, 5, '可以，我先问清楚你的目标。'), answer(2, 9, '这句尚未播放。')) })
    b.view.rerender(<VoiceConversation {...b.props} sessionId={'different-session' as SessionId} />)
    capture.voicing.mockReturnValue(false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(speech.speak).toHaveBeenCalledOnce()
    expect(capture.close).toHaveBeenCalledOnce()
    expect(b.view.getByRole('button', { name: '开始语音对话' })).toBeTruthy()
  })

  it('pauses capture for a manual audio owner and cancels a pending automatic microphone resume', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    act(() => { publish(b, answer(1, 5, '已经完成的自动回复。')) })
    expect(speech.speak).toHaveBeenCalledOnce()
    act(() => { speech.done?.() })
    let release!: () => void
    act(() => { release = claimSpeechOutput(() => {}) })
    expect(voiceStatus(b.view)).toBe(zh['voice.paused'])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)) })
    expect(capture.listen).toHaveBeenLastCalledWith(false)
    expect(voiceStatus(b.view)).toBe(zh['voice.paused'])
    expect(b.props.stopAgent).not.toHaveBeenCalled(); expect(b.submit).not.toHaveBeenCalled()
    release()
  })

  it('pauses microphone capture without ending the current agent and resumes explicitly', async () => {
    const { view, props, submit } = bench()
    fireEvent.click(view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(voiceStatus(view)).toBe('正在聆听') })
    fireEvent.click(view.getByRole('button', { name: zh['character.more'] }))
    fireEvent.click(view.getByRole('button', { name: '暂停麦克风' }))
    expect(capture.listen).toHaveBeenLastCalledWith(false)
    expect(voiceStatus(view)).toBe('语音已暂停')
    await act(async () => { capture.onSegment?.(new Blob(['ignored'])) })
    expect(submit).not.toHaveBeenCalled()
    expect(props.stopAgent).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '继续聆听' }))
    expect(capture.listen).toHaveBeenLastCalledWith(true)
    expect(voiceStatus(view)).toBe('正在聆听')
  })

  it('keeps voice active while collapsed and closes the same controller from the pet', async () => {
    const { view } = bench()
    fireEvent.click(view.getByRole('button', { name: '开始语音对话' }))
    await waitFor(() => { expect(voiceStatus(view)).toBe('正在聆听') })
    fireEvent.click(view.getByRole('button', { name: zh['character.more'] }))
    fireEvent.click(view.getByRole('button', { name: zh['character.less'] }))
    expect(capture.close).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '结束语音' }))
    expect(capture.close).toHaveBeenCalledOnce()
    expect(view.queryByRole('complementary', { name: zh['character.label'] })).toBeNull()
    expect(view.getByRole('button', { name: '开始语音对话' })).toBeTruthy()
  })

})
