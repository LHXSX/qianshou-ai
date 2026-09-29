/** Controlled capture/ASR lifecycle tests; these do not record from a real microphone. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { VoiceStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { VoiceController, type VoiceTarget, type VoiceApi } from '../src/client/controller.ts'
import { SystemSpeech } from '../src/client/speech.ts'
import type { VoiceCapture } from '../src/client/capture.ts'

const STATUS: VoiceStatus = { available: true, busy: false, reason: 'ready', backend: 'whisper.cpp', language: 'zh',
  maxAudioBytes: 3844096, maxDurationSeconds: 120, minDurationSeconds: 0.1 }
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
function setup() {
  let current = true
  const changed = new Set<() => void>()
  const sink = vi.fn(async () => ({ kind: 'success' as const }))
  const input = new SessionInputShell({ actx: {} as Context, canAcceptExternalText: () => current, defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' } })
  const capture = { finish: vi.fn<VoiceCapture['finish']>(async () => new Blob(['fixture'], { type: 'audio/wav' })), cancel: vi.fn<VoiceCapture['cancel']>(async () => {}) }
  const api = { status: vi.fn<VoiceApi['status']>(async () => STATUS), transcribe: vi.fn<VoiceApi['transcribe']>(async () => '识别的文字') }
  const acquire = vi.fn(async () => capture)
  const speech = new SystemSpeech()
  const controller = new VoiceController(api, speech, acquire)
  const target: VoiceTarget = { sessionId: 'original' as SessionId, cwd: '/test', identity: {}, input,
    current: () => current, watch: (callback) => { changed.add(callback); return () => { changed.delete(callback) } } }
  const invalidate = (): void => { current = false; for (const callback of changed) callback() }
  return { controller, capture, input, api, acquire, target, sink, invalidate,
    close: async () => { await controller.dispose(); input.dispose() } }
}

describe('voice session and draft ownership', () => {
  it('defaults to dictation and appends once on release without dispatching a model message', async () => {
    const b = setup(); await b.controller.start(b.target, {})
    expect(b.controller.store.getSnapshot().phase).toBe('recording')
    await Promise.all([b.controller.finish(), b.controller.finish()])
    expect(b.capture.finish).toHaveBeenCalledOnce(); expect(b.api.transcribe).toHaveBeenCalledOnce()
    expect(b.input.snapshot.draft).toBe('识别的文字'); expect(b.sink).not.toHaveBeenCalled()
    expect(b.controller.store.getSnapshot().notice).toBe('inserted')
    await b.close()
  })

  it('release before status resolution never acquires a microphone', async () => {
    const b = setup(); const status = Promise.withResolvers<VoiceStatus>(); b.api.status.mockReturnValueOnce(status.promise)
    const starting = b.controller.start(b.target, {})
    await b.controller.finish(); status.resolve(STATUS); await starting
    expect(b.acquire).not.toHaveBeenCalled(); expect(b.api.transcribe).not.toHaveBeenCalled()
    await b.close()
  })

  it('stops a late permission result after its view unmounts', async () => {
    const b = setup(); const acquired = Promise.withResolvers<VoiceCapture>()
    b.acquire.mockReturnValueOnce(acquired.promise as Promise<typeof b.capture>)
    const owner = {}; const starting = b.controller.start(b.target, owner)
    await flush(); expect(b.controller.store.getSnapshot().phase).toBe('permission')
    b.controller.release(owner); acquired.resolve(b.capture); await starting
    expect(b.capture.cancel).toHaveBeenCalledOnce(); expect(b.api.transcribe).not.toHaveBeenCalled()
    expect(b.controller.store.getSnapshot().phase).toBe('idle'); await b.close()
  })

  it('preserves typed changes and requires an explicit append after recognition', async () => {
    const b = setup(); const recognized = Promise.withResolvers<string>(); b.api.transcribe.mockReturnValueOnce(recognized.promise)
    await b.controller.start(b.target, {}); const finishing = b.controller.finish()
    await flush(); b.input.setDraft('user typing'); recognized.resolve('voice text'); await finishing
    expect(b.input.snapshot.draft).toBe('user typing')
    expect(b.controller.store.getSnapshot()).toMatchObject({ notice: 'conflict', pendingText: 'voice text' })
    await b.controller.insertPending()
    expect(b.input.snapshot.draft).toBe('user typing\nvoice text'); expect(b.sink).not.toHaveBeenCalled()
    await b.close()
  })

  it('aborts recognition and drops its late text when the actual binding changes', async () => {
    const b = setup(); const recognized = Promise.withResolvers<string>(); b.api.transcribe.mockReturnValueOnce(recognized.promise)
    await b.controller.start(b.target, {}); const finishing = b.controller.finish(); await flush()
    const signal = b.api.transcribe.mock.calls[0]?.[2]
    b.invalidate(); recognized.resolve('must not land'); await finishing
    expect(signal?.aborted).toBe(true); expect(b.input.snapshot.draft).toBe('')
    expect(b.controller.store.getSnapshot().phase).toBe('idle'); await b.close()
  })

  it('requires explicit send mode and reports only actual sink acceptance', async () => {
    const b = setup(); b.controller.setMode('send'); await b.controller.start(b.target, {}); await b.controller.finish()
    expect(b.sink).toHaveBeenCalledExactlyOnceWith('识别的文字', [], 'queue', expect.any(AbortSignal))
    expect(b.controller.store.getSnapshot().notice).toBe('accepted'); await b.close()
  })

  it('does not capture or send a pre-existing draft in release-send mode', async () => {
    const b = setup(); b.input.setDraft('private draft'); b.controller.setMode('send'); await b.controller.start(b.target, {})
    expect(b.acquire).not.toHaveBeenCalled(); expect(b.input.snapshot.draft).toBe('private draft')
    expect(b.controller.store.getSnapshot().notice).toBe('nonempty'); await b.close()
  })

  it('keeps unavailable, busy, short and empty recognition as visible failures', async () => {
    const b = setup()
    b.api.status.mockResolvedValueOnce({ ...STATUS, available: false, reason: 'not-configured' })
    await b.controller.start(b.target, {}); expect(b.controller.store.getSnapshot().notice).toBe('unavailable')
    b.api.status.mockResolvedValueOnce({ ...STATUS, busy: true })
    await b.controller.start(b.target, {}); expect(b.controller.store.getSnapshot().notice).toBe('busy')
    b.capture.finish.mockResolvedValueOnce(null)
    await b.controller.start(b.target, {}); await b.controller.finish(); expect(b.controller.store.getSnapshot().notice).toBe('short')
    b.api.transcribe.mockResolvedValueOnce('   ')
    await b.controller.start(b.target, {}); await b.controller.finish(); expect(b.controller.store.getSnapshot().notice).toBe('empty')
    expect(b.sink).not.toHaveBeenCalled(); await b.close()
  })
})
