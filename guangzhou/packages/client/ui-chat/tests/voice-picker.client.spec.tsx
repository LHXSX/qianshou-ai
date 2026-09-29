// @vitest-environment jsdom
/**
 * Voice picker contract: the speaker list is read from the authenticated host
 * status route, an unusable stored choice remains visible, the preview plays
 * a real synthesized WAV, and the chosen speaker reaches reply playback.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { EMPTY_CHAT_SNAPSHOT } from '../src/client/contract/snapshot.ts'
import { VoiceConversation } from '../src/client/chat/voice/VoiceConversation.tsx'
import {
  KNOWN_VOICES, VOICE_PREVIEW_TEXT, VOICE_STORAGE_KEY, PLAYBACK_VOICE_STORAGE_KEY, loadPreferredSpeaker, loadVoiceCatalog,
  playVoiceSample, resolveVoice, savePreferredSpeaker, toVoiceId,
} from '../src/client/chat/voice/voice-catalog.ts'
import { VoicePicker } from '../src/client/chat/voice/VoicePicker.tsx'
import { subscribeSpeechPlayback, type SpeechPlaybackEvent } from '../src/client/chat/voice/speech-playback.ts'

const t = makeTranslate(zh, commonZh)
const request = vi.fn<typeof fetch>()
const media: TestAudio[] = []
const revoke = vi.fn()
class TestAudio {
  onplaying: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  pause = vi.fn()
  load = vi.fn()
  removeAttribute = vi.fn()
  play = vi.fn(async () => {})
  constructor(readonly src: string) { media.push(this) }
}

const status = (overrides: Record<string, unknown> = {}) => Response.json({
  available: true, ready: true, engine: 'qwen3-tts', speakers: ['Vivian', 'Serena'], defaultSpeaker: 'Vivian', ...overrides,
})

/** One host-shaped 24 kHz PCM16 WAV inside the read bound. */
function wavResponse() {
  const bytes = new Uint8Array(2444)
  const writer = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('RIFF'), 0); writer.setUint32(4, bytes.length - 8, true)
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8); writer.setUint32(16, 16, true)
  writer.setUint16(20, 1, true); writer.setUint16(22, 1, true); writer.setUint32(24, 24000, true)
  writer.setUint32(28, 48000, true); writer.setUint16(32, 2, true); writer.setUint16(34, 16, true)
  bytes.set(new TextEncoder().encode('data'), 36); writer.setUint32(40, bytes.length - 44, true)
  return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } })
}

beforeEach(() => {
  sessionStorage.clear()
  media.length = 0; revoke.mockClear(); localStorage.clear()
  request.mockReset().mockImplementation(async () => status())
  vi.stubGlobal('fetch', request)
  vi.stubGlobal('Audio', TestAudio)
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:voice-sample')
    static override revokeObjectURL = revoke
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('voice catalog', () => {
  it('accepts only the speakers the host can render', () => {
    expect(KNOWN_VOICES).toEqual(['Vivian', 'Serena'])
    expect(toVoiceId('Serena')).toBe('Serena')
    for (const rejected of ['serena', 'tingting', '', 42, null, undefined, { name: 'Vivian' }]) {
      expect(toVoiceId(rejected)).toBeUndefined()
    }
  })

  it('survives absent, malformed, and throwing storage', () => {
    expect(loadPreferredSpeaker()).toBeUndefined()
    localStorage.setItem(VOICE_STORAGE_KEY, 'Serena')
    expect(loadPreferredSpeaker()).toBe('Serena')
    localStorage.setItem(VOICE_STORAGE_KEY, 'Tingting')
    expect(loadPreferredSpeaker()).toBeUndefined()
    expect(loadPreferredSpeaker({ getItem: () => { throw new Error('storage blocked') } })).toBeUndefined()
    expect(savePreferredSpeaker('Serena')).toBe(true)
    expect(localStorage.getItem(VOICE_STORAGE_KEY)).toBe('Serena')
    expect(savePreferredSpeaker('Vivian', { setItem: () => { throw new Error('quota') } })).toBe(false)
  })

  it('prefers the stored speaker, reports a rejected one, and defaults otherwise', () => {
    expect(resolveVoice(['Vivian', 'Serena'], 'Serena', 'Vivian')).toEqual({ speaker: 'Serena', selectionUnavailable: false })
    expect(resolveVoice(['Vivian', 'Serena'], undefined, 'Serena')).toEqual({ speaker: 'Serena', selectionUnavailable: false })
    expect(resolveVoice(['Vivian'], 'Serena', 'Vivian')).toEqual({ speaker: 'Serena', selectionUnavailable: true })
    expect(resolveVoice(['Serena'], 'Vivian', 'Vivian')).toEqual({ speaker: 'Vivian', selectionUnavailable: true })
  })

  it('reads the host speaker list instead of a hard-coded one', async () => {
    request.mockResolvedValue(status({ speakers: ['Serena'], defaultSpeaker: 'Serena' }))
    const { catalog, statusError } = await loadVoiceCatalog()
    expect(statusError).toBe(false)
    expect(catalog).toEqual({ available: true, speakers: ['Serena'], selected: 'Serena', selectionUnavailable: false })
    expect(request.mock.calls[0]?.[0]).toBe('/api/forge/voice/tts/status')
    expect(request.mock.calls[0]?.[1]?.credentials).toBe('same-origin')
  })

  it('keeps a stored speaker the host still reports', async () => {
    localStorage.setItem(VOICE_STORAGE_KEY, 'Serena')
    const { catalog } = await loadVoiceCatalog()
    expect(catalog.selected).toBe('Serena')
    expect(catalog.selectionUnavailable).toBe(false)
  })

  it('reads the latest preference after a slow status request finishes', async () => {
    let resolve!: (response: Response) => void
    localStorage.setItem(VOICE_STORAGE_KEY, 'Vivian')
    request.mockReturnValue(new Promise<Response>((done) => { resolve = done }))
    const loading = loadVoiceCatalog()
    localStorage.setItem(VOICE_STORAGE_KEY, 'Serena')
    resolve(status())
    expect((await loading).catalog.selected).toBe('Serena')
  })

  it('preserves an unavailable saved identity until the user chooses another', async () => {
    request.mockResolvedValue(status({ speakers: ['Vivian'], defaultSpeaker: 'Vivian' }))
    localStorage.setItem(VOICE_STORAGE_KEY, 'Serena')
    const { catalog } = await loadVoiceCatalog()
    expect(catalog).toEqual({ available: true, speakers: ['Vivian'], selected: 'Serena', selectionUnavailable: true })
  })

  it.each([
    ['an explicit unavailability', async () => status({ available: false }), false],
    ['an installed-status rejection', async () => new Response(null, { status: 404 }), false],
    ['an authentication failure', async () => new Response(null, { status: 401 }), true],
    ['a malformed payload', async () => Response.json({ available: true }), true],
    ['a transport failure', async () => { throw new Error('offline') }, true],
  ])('reports %s without inventing speakers', async (_label, answer, statusError) => {
    request.mockImplementation(answer)
    const load = await loadVoiceCatalog()
    expect(load.statusError).toBe(statusError)
    expect(load.catalog.available).toBe(false)
    expect(load.catalog.speakers).toEqual([])
  })

  it('plays only a validated WAV and releases its object URL', async () => {
    request.mockResolvedValue(wavResponse())
    const fail = vi.fn()
    const ended = vi.fn()
    playVoiceSample('试听', 'Serena', fail, ended)
    await waitFor(() => { expect(media).toHaveLength(1) })
    expect(request.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ text: '试听', speaker: 'Serena' }))
    expect(media[0]?.play).toHaveBeenCalledOnce()
    media[0]?.onended?.()
    expect(ended).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
    expect(fail).not.toHaveBeenCalled()
  })

  it.each([
    ['a rejected speaker', async () => Response.json({ error: 'INVALID_TEXT' }, { status: 400 })],
    ['a non-audio body', async () => new Response('nope', { headers: { 'Content-Type': 'audio/wav' } })],
  ])('reports %s instead of pretending the sample played', async (_label, answer) => {
    request.mockImplementation(answer)
    const fail = vi.fn()
    playVoiceSample('试听', 'Serena', fail)
    await waitFor(() => { expect(fail).toHaveBeenCalledOnce() })
    expect(media).toHaveLength(0)
  })

  it('announces only actual media playback and closes the same identity when cancelled', async () => {
    request.mockResolvedValue(wavResponse())
    const events: SpeechPlaybackEvent[] = []; const unsubscribe = subscribeSpeechPlayback(event => events.push(event))
    const playing = vi.fn(); const failed = vi.fn(); const ended = vi.fn()
    const stop = playVoiceSample('试听', 'Vivian', failed, ended, playing)
    await waitFor(() => { expect(media).toHaveLength(1) })
    expect(events).toEqual([]); expect(playing).not.toHaveBeenCalled()
    const latePlaying = media[0]?.onplaying
    media[0]?.onplaying?.(); media[0]?.onplaying?.()
    expect(events).toHaveLength(1); expect(playing).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem(PLAYBACK_VOICE_STORAGE_KEY)).toBeNull()
    expect(events[0]).toMatchObject({ type: 'start', source: 'neural', element: media[0] })
    if (events[0]?.type === 'start' && events[0].source === 'neural') expect(events[0].wav.byteLength).toBe(2444)
    stop(); stop(); latePlaying?.()
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ type: 'cancel', playbackId: events[0]?.playbackId })
    expect(failed).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledOnce(); unsubscribe()
  })

  it('cancels an oversized unannounced streaming body before creating a media element', async () => {
    const cancel = vi.fn(); const chunk = new Uint8Array(1024 * 1024)
    request.mockResolvedValue(new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk) }, cancel }),
      { headers: { 'Content-Type': 'audio/wav' } }))
    const failed = vi.fn()
    playVoiceSample('试听', 'Vivian', failed)
    await waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    expect(cancel).toHaveBeenCalledOnce(); expect(media).toHaveLength(0)
  })

  it('stops a pending sample without reporting success or failure', async () => {
    let resolve!: (response: Response) => void
    request.mockReturnValue(new Promise<Response>((done) => { resolve = done }))
    const fail = vi.fn()
    const stop = playVoiceSample('试听', 'Vivian', fail)
    stop(); stop(); resolve(wavResponse())
    await Promise.resolve(); await Promise.resolve()
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(media).toHaveLength(0)
    expect(fail).not.toHaveBeenCalled()
  })
})

describe('voice picker', () => {
  it('lists the host speakers and previews its own short sample', async () => {
    const view = render(<VoicePicker t={t} />)
    const select = view.getByRole('combobox', { name: zh['voice.voice'] })
    expect((select as HTMLSelectElement).disabled).toBe(true)
    expect(view.getByText(zh['voice.voiceLoading'])).toBeTruthy()
    await waitFor(() => { expect((select as HTMLSelectElement).disabled).toBe(false) })
    expect(Array.from((select as HTMLSelectElement).options).map(option => option.value)).toEqual(['Vivian', 'Serena'])
    expect((select as HTMLSelectElement).value).toBe('Vivian')

    request.mockResolvedValue(wavResponse())
    fireEvent.click(view.getByRole('button', { name: zh['voice.voicePreviewVoice'].replace('{voice}', zh['voice.vivian']) }))
    await waitFor(() => { expect(media).toHaveLength(1) })
    expect(request.mock.calls.at(-1)?.[1]?.body).toBe(JSON.stringify({ text: VOICE_PREVIEW_TEXT, speaker: 'Vivian' }))
    expect(view.getByText(zh['voice.voicePreviewPreparing'])).toBeTruthy()
    expect(view.queryByText(zh['voice.voicePreviewPlaying'])).toBeNull()
    act(() => { media[0]?.onplaying?.() })
    expect(view.getByText(zh['voice.voicePreviewPlaying'])).toBeTruthy()
    act(() => { media[0]?.onended?.() })
    await waitFor(() => { expect(view.queryByText(zh['voice.voicePreviewPlaying'])).toBeNull() })
  })

  it('pauses the capture owner before requesting audio and offers cancellation during preparation', async () => {
    const before = vi.fn(); const states = vi.fn()
    const view = render(<VoicePicker t={t} onPreviewStart={before} onPreviewStateChange={states} />)
    await waitFor(() => { expect((view.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false) })
    let signal: AbortSignal | null | undefined
    request.mockImplementation((_url, options) => {
      expect(before).toHaveBeenCalledOnce(); signal = options?.signal
      return new Promise<Response>(() => {})
    })
    fireEvent.click(view.getByRole('button', { name: /试听/ }))
    expect(states).toHaveBeenLastCalledWith('preparing')
    fireEvent.click(view.getByRole('button', { name: zh['voice.voicePreviewStop'] }))
    expect(signal?.aborted).toBe(true); expect(states).toHaveBeenLastCalledWith('idle')
    expect(view.queryByText(zh['voice.voicePreviewFailed'])).toBeNull()
  })

  it('persists a real change and reports it to the reply controller', async () => {
    const changed = vi.fn()
    const view = render(<VoicePicker t={t} onVoiceChange={changed} />)
    const select = view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement
    await waitFor(() => { expect(select.disabled).toBe(false) })
    expect(changed).toHaveBeenLastCalledWith('Vivian')
    fireEvent.change(select, { target: { value: 'Serena' } })
    expect(select.value).toBe('Serena')
    expect(localStorage.getItem(VOICE_STORAGE_KEY)).toBe('Serena')
    expect(changed).toHaveBeenLastCalledWith('Serena')
  })

  it('announces an unavailable service and disables both controls', async () => {
    request.mockResolvedValue(status({ available: false }))
    const view = render(<VoicePicker t={t} />)
    await waitFor(() => { expect(view.getByText(zh['voice.voiceUnavailable'])).toBeTruthy() })
    expect((view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: /试听/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('names a failed status read as a failure, not as an absent feature', async () => {
    request.mockRejectedValue(new Error('offline'))
    const view = render(<VoicePicker t={t} />)
    await waitFor(() => { expect(view.getByText(zh['voice.voiceStatusFailed'])).toBeTruthy() })
    expect(view.queryByText(zh['voice.voiceUnavailable'])).toBeNull()
  })

  it('keeps the unavailable saved voice visible and requires an explicit replacement', async () => {
    request.mockResolvedValue(status({ speakers: ['Vivian'], defaultSpeaker: 'Vivian' }))
    localStorage.setItem(VOICE_STORAGE_KEY, 'Serena')
    const view = render(<VoicePicker t={t} />)
    await waitFor(() => {
      expect(view.getByText(zh['voice.voiceRejected'].replace('{voice}', zh['voice.serena']))).toBeTruthy()
    })
    const select = view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement
    expect(select.value).toBe('Serena')
    expect((view.getByRole('button', { name: /试听/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'Vivian' } })
    expect(select.value).toBe('Vivian'); expect(localStorage.getItem(VOICE_STORAGE_KEY)).toBe('Vivian')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('leaves the alert visible when the preview fails', async () => {
    request.mockImplementation(async path => path === '/api/forge/voice/synthesize'
      ? Response.json({ error: 'INVALID_TEXT' }, { status: 400 })
      : status())
    const view = render(<VoicePicker t={t} />)
    await waitFor(() => { expect(view.getByText(zh['voice.voice'])).toBeTruthy() })
    fireEvent.click(await view.findByRole('button', { name: new RegExp(zh['voice.voicePreview']) }))
    await waitFor(() => { expect(view.getByText(zh['voice.voicePreviewFailed'])).toBeTruthy() })
  })

  it('warns when the device cannot remember the choice', async () => {
    const view = render(<VoicePicker t={t} />)
    const select = view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement
    await waitFor(() => { expect(select.disabled).toBe(false) })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    fireEvent.change(select, { target: { value: 'Serena' } })
    expect(view.getByText(zh['voice.voicePreferenceFailed'])).toBeTruthy()
    expect(select.value).toBe('Serena')
    vi.restoreAllMocks()
  })
})

const capture = vi.hoisted(() => ({
  open: vi.fn(), listen: vi.fn(), close: vi.fn(), onSegment: undefined as ((blob: Blob) => void) | undefined,
}))
vi.mock('../src/client/chat/voice/audio.ts', () => ({
  openMicrophone: async (onSegment: (blob: Blob) => void) => {
    await capture.open(); capture.onSegment = onSegment
    return { listen: capture.listen, close: capture.close, isVoicing: vi.fn(() => false),
      bargeInAvailable: false, monitorPlayback: vi.fn() }
  },
}))
vi.mock('../src/client/chat/voice/VRMCompanion.tsx', () => ({ VRMCompanion: () => <span aria-hidden="true" /> }))

const speech = vi.hoisted(() => ({ speakers: [] as (string | undefined)[], cancel: vi.fn() }))
vi.mock('../src/client/chat/voice/speech.ts', () => ({
  speakReply: (_text: string, _language: string, _done: () => void, _fail: () => void, speaker?: string) => {
    speech.speakers.push(speaker)
    return speech.cancel
  },
}))

/** Minimal authenticated conversation bench mirroring the reply-playback path. */
function benchConversation() {
  const input = createSnapshotStore({ draft: '', draftRev: 1, phase: 'plain', attachmentIds: [], occurrences: [], queue: [] })
  const session = createSnapshotStore(sessionSnapshot('voice-session' as SessionId))
  const chat = createSnapshotStore(EMPTY_CHAT_SNAPSHOT)
  const pending = createSnapshotStore(new Map<string, unknown>())
  const submit = vi.fn()
  const props = {
    sessionId: 'voice-session' as SessionId,
    useSession: bindSnapshotSelector(session), useInput: bindSnapshotSelector(input), useChat: bindSnapshotSelector(chat),
    useSessions: (select: (state: unknown) => unknown) => select({ byId: { 'voice-session': { cwd: '/project' } } }),
    useSessionPendingInteraction: bindSnapshotSelector(pending),
    useVoiceBlock: (select: (state: undefined) => unknown) => select(undefined),
    inputActions: {
      setDraft: (text: string) => { input.set({ ...input.getSnapshot(), draft: text, draftRev: input.getSnapshot().draftRev + 1 }) },
      submit,
    },
    status: vi.fn(async () => true), transcribe: vi.fn(async () => ''), stopAgent: vi.fn(), t,
  } as unknown as ComponentProps<typeof VoiceConversation>
  const view = render(<VoiceConversation {...props} />)
  return { view, chat, props, input, submit }
}

/** Publish one closed final answer through the real turn-tail data source. */
function publishAnswer(b: ReturnType<typeof benchConversation>, text: string) {
  const store = createSnapshotStore({ closing: { finalNode: { seq: 7 }, blocks: [{ kind: 'text', text }] } })
  const turn = {
    turn: 1, status: 'closed', steps: [], start: undefined, end: undefined,
    data: { get: () => store.getSnapshot(), source: () => store },
  }
  b.chat.set({ ...EMPTY_CHAT_SNAPSHOT, timeline: { turnOrder: [1], turns: new Map([[1, turn]]) } } as never)
}

describe('reply playback speaker wiring', () => {
  beforeEach(() => {
    speech.speakers.length = 0; speech.cancel.mockClear(); capture.open.mockReset(); capture.listen.mockClear(); capture.close.mockClear()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } })
    vi.stubGlobal('AudioContext', function AudioContext() {})
    vi.stubGlobal('SpeechSynthesisUtterance', function SpeechSynthesisUtterance() {})
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {} })
  })

  it('reads replies in the speaker the picker reports', async () => {
    localStorage.setItem(VOICE_STORAGE_KEY, 'Serena')
    const b = benchConversation()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    await waitFor(() => { expect((b.view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement).value).toBe('Serena') })
    publishAnswer(b, '已经按你选的声线朗读。')
    await waitFor(() => { expect(speech.speakers).toEqual(['Serena']) })
  })

  it('reads replies with the newly picked speaker after a live change', async () => {
    const b = benchConversation()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    const select = b.view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement
    await waitFor(() => { expect(select.disabled).toBe(false) })
    fireEvent.change(select, { target: { value: 'Serena' } })
    expect(localStorage.getItem(VOICE_STORAGE_KEY)).toBe('Serena')
    publishAnswer(b, '换成 Serena 之后朗读。')
    await waitFor(() => { expect(speech.speakers).toEqual(['Serena']) })
  })

  it('keeps a live speaker choice when the initial catalog request resolves late', async () => {
    let resolveInitial!: (response: Response) => void
    request.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveInitial = resolve }))
    const b = benchConversation()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    const select = b.view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement
    await waitFor(() => { expect(select.disabled).toBe(false) })
    fireEvent.change(select, { target: { value: 'Serena' } })
    await act(async () => { resolveInitial(status()); await Promise.resolve() })
    act(() => { publishAnswer(b, '保持用户刚选定的声线。') })
    await waitFor(() => { expect(speech.speakers).toEqual(['Serena']) })
  })

  it('retains the controller identity if a later picker status is temporarily unavailable', async () => {
    request.mockResolvedValueOnce(status({ defaultSpeaker: 'Serena' }))
      .mockImplementation(async () => status({ available: false }))
    const b = benchConversation()
    await waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    await waitFor(() => { expect(b.view.getByText(zh['voice.voiceUnavailable'])).toBeTruthy() })
    act(() => { publishAnswer(b, '保留 Serena，不切换到系统声音。') })
    await waitFor(() => { expect(speech.speakers).toEqual(['Serena']) })
  })

  it('applies a live selection despite a blocked preference write', async () => {
    localStorage.setItem(VOICE_STORAGE_KEY, 'Vivian')
    const b = benchConversation()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    const select = b.view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement
    await waitFor(() => { expect(select.disabled).toBe(false) })
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      fireEvent.change(select, { target: { value: 'Serena' } })
      act(() => { publishAnswer(b, '当前对话使用刚选的声线。') })
      await waitFor(() => { expect(speech.speakers).toEqual(['Serena']) })
      expect(b.view.getByText(zh['voice.voicePreferenceFailed'])).toBeTruthy()
    } finally { blocked.mockRestore() }
  })

  it('keeps the host default when the service is unavailable', async () => {
    request.mockResolvedValue(new Response(null, { status: 404 }))
    const b = benchConversation()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    await waitFor(() => { expect(b.view.getByText(zh['voice.voiceUnavailable'])).toBeTruthy() })
    publishAnswer(b, '本地语音不可用时仍要朗读。')
    await waitFor(() => { expect(speech.speakers).toEqual([undefined]) })
  })
  it('mutes capture before preview, cancels the old reply and requires explicit resume afterwards', async () => {
    const b = benchConversation()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    await waitFor(() => { expect((b.view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement).disabled).toBe(false) })
    act(() => { publishAnswer(b, '当前读音') })
    expect(speech.speakers).toHaveLength(1)
    request.mockResolvedValue(wavResponse())
    fireEvent.click(b.view.getByRole('button', { name: /试听.*声音/ }))
    expect(capture.listen).toHaveBeenLastCalledWith(false)
    expect(speech.cancel).toHaveBeenCalledOnce()
    act(() => { capture.onSegment?.(new Blob(['preview echo'])) })
    expect(b.props.transcribe).not.toHaveBeenCalled()
    await waitFor(() => { expect(media).toHaveLength(1) })
    act(() => { media[0]?.onplaying?.() })
    expect(b.view.getByRole('complementary', { name: zh['character.label'] }).getAttribute('data-state')).toBe('speaking')
    act(() => { media[0]?.onended?.() })
    expect(capture.listen).toHaveBeenLastCalledWith(false)
    expect(b.view.getByRole('button', { name: zh['voice.resumeMic'] })).toBeTruthy()
    expect(b.submit).not.toHaveBeenCalled(); expect(b.props.stopAgent).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.resumeMic'] }))
    expect(capture.listen).toHaveBeenLastCalledWith(true)
  })

  it('cancels a playing preview through the compact interruption and through End voice', async () => {
    const b = benchConversation()
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.start'] }))
    await waitFor(() => { expect(capture.open).toHaveBeenCalledOnce() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.more'] }))
    await waitFor(() => { expect((b.view.getByRole('combobox', { name: zh['voice.voice'] }) as HTMLSelectElement).disabled).toBe(false) })
    request.mockImplementation(async () => wavResponse())
    fireEvent.click(b.view.getByRole('button', { name: /试听.*声音/ }))
    await waitFor(() => { expect(media).toHaveLength(1) })
    act(() => { media[0]?.onplaying?.() })
    fireEvent.click(b.view.getByRole('button', { name: zh['character.interrupt'] }))
    expect(media[0]?.pause).toHaveBeenCalledOnce()
    expect(capture.listen).toHaveBeenLastCalledWith(false)
    fireEvent.click(b.view.getByRole('button', { name: /试听.*声音/ }))
    await waitFor(() => { expect(media).toHaveLength(2) })
    act(() => { media[1]?.onplaying?.() })
    const late = media[1]?.onplaying
    fireEvent.click(b.view.getByRole('button', { name: zh['voice.stop'] }))
    expect(media[1]?.pause).toHaveBeenCalledOnce(); expect(capture.close).toHaveBeenCalledOnce()
    act(() => { late?.() })
    expect(b.view.queryByRole('complementary', { name: zh['character.label'] })).toBeNull()
    expect(b.submit).not.toHaveBeenCalled(); expect(b.props.stopAgent).not.toHaveBeenCalled()
  })

})
