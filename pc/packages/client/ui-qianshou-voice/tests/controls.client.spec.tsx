// @vitest-environment jsdom
/** Visible voice behavior with silent adapters; hardware acceptance is a separate stage. */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { VoiceController, type VoiceTarget } from '../src/client/controller.ts'
import { SystemSpeech } from '../src/client/speech.ts'
import { VoiceControl, VoiceStatus, ReadAloudAction } from '../src/client/VoiceControls.tsx'
import { zh } from '../src/client/locales.ts'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { cleanup(); for (const dispose of disposers.splice(0)) await dispose() })
function setup() {
  const sessionId = 'voice-view' as SessionId
  const input = new SessionInputShell({ actx: {} as Context, canAcceptExternalText: () => true,
    defaultSink: async () => ({ kind: 'success' }), commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' } })
  const audio = { finish: vi.fn(async () => new Blob(['fixture'])), cancel: vi.fn(async () => {}) }
  const acquire = vi.fn(async () => audio)
  const engine = { getVoices: () => [{ localService: true, lang: 'zh-CN', name: 'Fixture' }],
    speak: vi.fn(), cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const speech = new SystemSpeech(engine as unknown as SpeechSynthesis, text => ({ text } as SpeechSynthesisUtterance))
  const controller = new VoiceController({ status: async () => ({ available: true, busy: false, reason: 'ready', backend: 'whisper.cpp', language: 'zh',
    maxAudioBytes: 3844096, maxDurationSeconds: 120, minDurationSeconds: 0.1 }), transcribe: async () => '录音转成文字' }, speech, acquire)
  const target: VoiceTarget = { sessionId, cwd: '/fixture', identity: {}, input, current: () => true, watch: () => () => {} }
  const shared = { sessionId, controller, target: () => target, t: makeTranslate(zh),
    useVoice: bindSnapshotSelector(controller.store), useSpeech: bindSnapshotSelector(speech.store) }
  const control = { ...shared, locked: false } as unknown as Parameters<typeof VoiceControl>[0]
  const status = shared as unknown as Parameters<typeof VoiceStatus>[0]
  const reading = { ...shared, messageId: 'final-answer', text: '这是完成的回复。' } as unknown as Parameters<typeof ReadAloudAction>[0]
  disposers.push(async () => { await controller.dispose(); input.dispose() })
  return { input, acquire, audio, engine, controller, control, status, reading }
}

describe('voice controls', () => {
  it('shows explicit release modes and keeps recording status outside the input row', async () => {
    const b = setup()
    const view = render(<><VoiceStatus {...b.status} /><div data-testid="input-row"><VoiceControl {...b.control} /></div></>)
    fireEvent.click(view.getByRole('button', { name: '语音松开后的操作' }))
    expect(view.getByText('松开转文字')).toBeTruthy(); expect(view.getByText('松开发送（忙时排队）')).toBeTruthy()
    fireEvent.click(view.getByText('松开转文字'))
    const button = view.getByRole('button', { name: '按住说话' })
    fireEvent.keyDown(button, { key: ' ' })
    await waitFor(() =>{  expect(b.acquire).toHaveBeenCalledOnce() })
    expect(view.getByRole('status').textContent).toContain('正在录音')
    expect(view.getByTestId('input-row').contains(view.getByRole('status'))).toBe(false)
    fireEvent.keyUp(button, { key: ' ' })
    await waitFor(() =>{  expect(view.getByRole('status').textContent).toContain('文字已加入草稿') })
    expect(b.input.snapshot.draft).toBe('录音转成文字')
    expect(view.container).toMatchSnapshot()
  })
  it('stops capture when the owning view unmounts or becomes locked', async () => {
    const b = setup(); const view = render(<VoiceControl {...b.control} />)
    fireEvent.keyDown(view.getByRole('button', { name: '按住说话' }), { key: ' ' })
    await waitFor(() =>{  expect(b.controller.store.getSnapshot().phase).toBe('recording') })
    view.rerender(<VoiceControl {...b.control} locked />)
    await waitFor(() =>{  expect(b.audio.cancel).toHaveBeenCalledOnce() })
    expect(b.input.snapshot.draft).toBe('')
    view.unmount(); expect(b.audio.cancel).toHaveBeenCalledOnce()
  })
  it('offers a stop action during requested narration and releases it with the final reply view', async () => {
    const b = setup(); const view = render(<ReadAloudAction {...b.reading} />)
    fireEvent.click(view.getByRole('button', { name: '朗读' }))
    expect(b.engine.speak).toHaveBeenCalledOnce()
    expect(view.getByRole('button', { name: '停止朗读' }).getAttribute('title')).toBe('正在启动朗读')
    fireEvent.click(view.getByRole('button', { name: '停止朗读' })); expect(b.engine.cancel).toHaveBeenCalledOnce()
    fireEvent.click(view.getByRole('button', { name: '朗读' })); view.unmount()
    expect(b.engine.cancel).toHaveBeenCalledTimes(2)
  })
  it('disables narration while capture is active and leaves the new draft intact on cancel', async () => {
    const b = setup(); const view = render(<ReadAloudAction {...b.reading} />)
    await act(async () => { await b.controller.start(b.control.target(), {}) })
    expect(view.getByRole('button', { name: '朗读' })).toHaveProperty('disabled', true)
    await act(async () => { await b.controller.cancel() })
    expect(view.getByRole('button', { name: '朗读' })).toHaveProperty('disabled', false)
  })
})
