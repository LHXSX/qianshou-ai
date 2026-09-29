import { claimSpeechOutput, subscribeSpeechClaims } from './speech-ownership.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerBlock, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '../../contract/snapshot.ts'
import { assistantText } from '../turn-assistant.ts'
import { useTurnDataValue } from '../use-turn-data.ts'
import { openMicrophone, type Microphone } from './audio.ts'
import { speakReply } from './speech.ts'
import { subscribeSpeechPlayback } from './speech-playback.ts'
import { FloatingVoicePanel } from './FloatingVoicePanel.tsx'
import { ComposerVoiceEntry, type VoiceDelivery } from './ComposerVoiceEntry.tsx'
import { VoicePicker, type VoicePreviewState } from './VoicePicker.tsx'
import { loadVoiceCatalog, loadPlaybackSpeaker, type VoiceId } from './voice-catalog.ts'
import css from './VoiceConversation.module.css'

export interface VoiceInjected {
  status: (signal: AbortSignal) => Promise<boolean>
  transcribe: (audio: Blob, signal: AbortSignal) => Promise<string>
  stopAgent: () => void
  hooks: { voiceBlock: ObservableSnapshot<ComposerBlock | undefined> }
}

type VoiceProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'chat'> & InjectFace<VoiceInjected>
type Phase = 'off' | 'starting' | 'listening' | 'transcribing' | 'submitting' | 'waiting' | 'speaking' | 'paused'
type VoiceReply = { readonly seq: number; readonly text: string }

function latestVoiceTurn(chat: ChatSnapshot) {
  const last = chat.timeline.turnOrder.at(-1)
  const tail = last === undefined ? undefined : chat.timeline.turns.get(last)
  const id = tail?.status === 'open' ? chat.timeline.turnOrder.at(-2) : last
  const turn = id === undefined ? undefined : chat.timeline.turns.get(id)
  return turn?.status === 'closed' ? turn : undefined
}

/**
 * Read the latest closed Turn's final output through at most two Locations.
 * Reactive consumers must also subscribe to its keyed turn-tail data source.
 * @param chat - current framework-owned Chat snapshot.
 * @returns the closed final answer, or null when no final answer is available.
 */
export function latestVoiceReply(chat: ChatSnapshot): VoiceReply | null {
  const closing = latestVoiceTurn(chat)?.data.get('turn-tail')?.closing
  return closing === undefined || closing === null ? null : { seq: closing.finalNode.seq, text: assistantText(closing.blocks) }
}

/** Local interaction controller. Agent state and approvals remain owned by the existing session. */
export function VoiceConversation({
  sessionId, useSession, useSessions, useChat, useInput, inputActions, useSessionPendingInteraction,
  useVoiceBlock, status, transcribe, stopAgent, t,
}: VoiceProps) {
  const session = useSession(value => value)
  const input = useInput(value => value)
  const replyTurn = useChat(latestVoiceTurn)
  const replyTail = useTurnDataValue(replyTurn?.data, 'turn-tail')
  const reply = useMemo(() => {
    const closing = replyTail?.closing
    return closing === undefined || closing === null ? null : { seq: closing.finalNode.seq, text: assistantText(closing.blocks) }
  }, [replyTail])
  const toolsRunning = useChat(value => value.legacy.runningCalls.length > 0)
  const pending = useSessionPendingInteraction(value => value.get(sessionId))
  const block = useVoiceBlock(value => value)
  const workspace = useSessions(value => value.byId[sessionId]?.cwd)
  const [phase, setPhase] = useState<Phase>('off')
  const [deliveryChoice, setDelivery] = useState<VoiceDelivery>('manager')
  const delivery = session.subagent != null && deliveryChoice !== 'current' ? 'current' : deliveryChoice
  const [dictation, setDictation] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [heard, setHeard] = useState('')
  const [voice, setVoice] = useState<VoiceId | null>(() => loadPlaybackSpeaker() ?? null)
  const voiceRevision = useRef(0)
  const selectVoice = useCallback((speaker: VoiceId | null) => {
    voiceRevision.current += 1
    if (speaker !== null) setVoice(speaker)
  }, [])
  const chosenVoice = useRef<VoiceId | null>(null)
  chosenVoice.current = voice
  const [bargeInAvailable, setBargeInAvailable] = useState(false)
  const [speechPlaying, setSpeechPlaying] = useState(false)
  const [previewState, setPreviewState] = useState<VoicePreviewState>('idle')
  const cancelPreview = useRef<(() => void) | null>(null)
  const outputOwner = useRef(Symbol('voice-conversation'))
  const mic = useRef<Microphone | null>(null)
  const controller = useRef<AbortController | null>(null)
  const epoch = useRef(0)
  const cancelSpeech = useRef<(() => void) | null>(null)
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>()
  const submitTimer = useRef<ReturnType<typeof setTimeout> | undefined>()
  const submittedText = useRef<string | null>(null)
  const replySeq = useRef<number | undefined>()
  const playback = useRef<VoiceReply[]>([])
  const suppressPlayback = useRef(false)
  const playbackNotBefore = useRef(0)
  const original = useRef({ draft: '', rev: 0 })
  const active = useRef(false)
  const live = useRef({ session, input, block, delivery, dictation, phase, reply, workspace, pending })
  live.current = { session, input, block, delivery, dictation, phase, reply, workspace, pending }

  useEffect(() => {
    setSpeechPlaying(false)
    if (phase !== 'speaking') return
    let playbackId: number | undefined
    return subscribeSpeechPlayback((event) => {
      if (event.type === 'start') { playbackId = event.playbackId; setSpeechPlaying(true) }
      else if (event.playbackId === playbackId) { playbackId = undefined; setSpeechPlaying(false) }
    })
  }, [phase])

  const cleanup = useCallback(() => {
    epoch.current += 1; active.current = false
    cancelPreview.current?.(); cancelPreview.current = null
    controller.current?.abort(); controller.current = null
    mic.current?.close(); mic.current = null
    cancelSpeech.current?.(); cancelSpeech.current = null
    clearTimeout(resumeTimer.current); clearTimeout(submitTimer.current)
    submittedText.current = null; playback.current = []; playbackNotBefore.current = 0; suppressPlayback.current = false
  }, [])
  useEffect(() => { setPhase('off'); setError(null); setHeard(''); return cleanup }, [sessionId, cleanup])

  // Load the remembered speaker once so an already-open conversation reads with
  // the user's choice. A temporary catalog failure cannot clear that identity.
  useEffect(() => {
    const request = new AbortController()
    const revision = voiceRevision.current
    void loadVoiceCatalog(request.signal).then(({ catalog }) => {
      if (!request.signal.aborted && voiceRevision.current === revision && catalog.available) setVoice(catalog.selected)
    })
    return () => { request.abort() }
  }, [])

  const pause = useCallback((message: string) => {
    cancelPreview.current?.(); cancelPreview.current = null
    live.current = { ...live.current, phase: 'paused' }
    epoch.current += 1
    controller.current?.abort(); controller.current = null
    cancelSpeech.current?.(); cancelSpeech.current = null
    clearTimeout(resumeTimer.current); clearTimeout(submitTimer.current)
    submittedText.current = null; playback.current = []; suppressPlayback.current = true
    mic.current?.listen(false)
    setError(message === '' ? null : message); setPhase('paused')
  }, [])

  useEffect(() => subscribeSpeechClaims((owner) => {
    if (active.current && owner !== outputOwner.current && live.current.phase !== 'paused') pause('')
  }), [pause])

  const listen = useCallback(() => {
    cancelPreview.current?.(); cancelPreview.current = null
    if (!active.current) return
    const value = live.current
    if (value.block !== undefined || value.session.removed || value.pending !== undefined) {
      pause(value.block?.reason ?? t('voice.approval')); return
    }
    if (value.input.phase !== 'plain' || value.input.draft !== '' || value.input.attachmentIds.length > 0) {
      pause(t('voice.draftChanged')); return
    }
    original.current = { draft: value.input.draft, rev: value.input.draftRev }
    claimSpeechOutput(() => {}, outputOwner.current)()
    mic.current?.listen(true); setError(null); setPhase('listening')
  }, [pause, t])

  const cancelPlayback = useCallback(() => {
    epoch.current += 1
    cancelSpeech.current?.(); cancelSpeech.current = null
    clearTimeout(resumeTimer.current)
    playback.current = []; suppressPlayback.current = true
    playbackNotBefore.current = Date.now() + 1500
  }, [])

  const onBargeIn = useCallback(() => {
    if (!active.current || live.current.phase !== 'speaking') return
    cancelPlayback()
    const value = live.current
    if (value.block !== undefined || value.pending !== undefined || value.session.removed) {
      pause(value.block?.reason ?? t('voice.approval')); return
    }
    if (value.input.phase !== 'plain' || value.input.draft !== '' || value.input.attachmentIds.length > 0) {
      pause(t('voice.typingPaused')); return
    }
    original.current = { draft: value.input.draft, rev: value.input.draftRev }
    // The microphone already owns the confirmed onset and pre-roll. Calling
    // listen(true) here would reset that buffer and clip the user's first word.
    live.current = { ...live.current, phase: 'listening' }
    setError(null); setPhase('listening')
  }, [cancelPlayback, pause, t])

  const isActive = () => active.current
  const onSegment = useCallback(async (audio: Blob) => {
    if (!active.current || live.current.phase !== 'listening') return
    const generation = epoch.current
    const start = live.current
    const saved = original.current
    setPhase('transcribing')
    const request = new AbortController(); controller.current = request
    try {
      const text = await transcribe(audio, request.signal)
      if (!isActive() || generation !== epoch.current) return
      if (text === '') {
        if (start.dictation) { mic.current?.listen(true); setPhase('listening') } else listen()
        return
      }
      setHeard(text)
      const value = live.current
      if (value.input.draftRev !== saved.rev || value.input.draft !== saved.draft || value.input.phase !== 'plain') {
        pause(t('voice.draftChanged')); return
      }
      if (value.block !== undefined || value.pending !== undefined || value.session.removed) {
        pause(value.block?.reason ?? t('voice.approval')); return
      }
      if (start.dictation) {
        inputActions.setDraft(saved.draft === '' ? text : `${saved.draft}\n${text}`)
        cleanup(); setPhase('off'); return
      }
      if (value.input.attachmentIds.length > 0) { pause(t('voice.draftChanged')); return }
      submittedText.current = text
      setPhase('submitting')
      inputActions.setDraft(text)
      submitTimer.current = setTimeout(() => {
        if (active.current && generation === epoch.current && submittedText.current !== null) pause(t('voice.sendFailed'))
      }, 15000)
    } catch (cause) {
      if (!isActive() || generation !== epoch.current || request.signal.aborted) return
      const code = cause instanceof Error ? cause.message : ''
      pause(t(code === 'VOICE_UNAVAILABLE' ? 'voice.unavailable' : code === 'VOICE_BUSY' ? 'voice.busy' : code === 'VOICE_TIMEOUT' ? 'voice.timeout' : 'voice.transcribeFailed'))
    }
  }, [cleanup, inputActions, listen, pause, t, transcribe])

  // Wait for the editor publication before submit; this preserves the normal
  // attachment, command, policy, approval, and session-log machinery.
  useEffect(() => {
    if (!active.current || phase !== 'submitting' || submittedText.current === null) return
    if (input.draft !== submittedText.current || input.phase !== 'plain') return
    if (block !== undefined || pending !== undefined || session.removed) { pause(block?.reason ?? t('voice.approval')); return }
    if (input.attachmentIds.length > 0 || input.occurrences.length > 0) { pause(t('voice.draftChanged')); return }
    submittedText.current = null; clearTimeout(submitTimer.current)
    suppressPlayback.current = false
    const mode: Parameters<InputActions['submit']>[0] = delivery === 'parallel' ? 'parallel' : session.running ? 'steer' : 'queue'
    inputActions.submit(mode)
    setPhase('waiting')
  }, [phase, input, inputActions, block, pending, session.removed, session.running, delivery, pause, t])

  useEffect(() => {
    if (!active.current || phase !== 'waiting') return
    if (session.promptError !== null) { pause(t('voice.sendFailed')); return }
    if (pending !== undefined) { mic.current?.listen(false); return }
    // The manager receives the same logged user text on the existing Session.
    // It can converse while its tools or delegated children keep working.
    if (delivery !== 'current' && input.phase === 'plain' && input.draft === '') listen()
  }, [phase, session.promptError, pending, delivery, input, listen, pause, t])

  // This queue is only playback state for observed immutable final answers;
  // model history and task state remain in the framework-owned Session.
  useEffect(() => {
    if (!active.current || dictation || reply === null || (replySeq.current !== undefined && reply.seq <= replySeq.current)) return
    replySeq.current = reply.seq
    if (!suppressPlayback.current && reply.text.trim() !== '') playback.current.push(reply)
    else if (phase === 'waiting' && !session.running) listen()
  }, [reply, dictation, phase, session.running, listen])

  useEffect(() => {
    if (!active.current || dictation || playback.current.length === 0) return
    const generation = epoch.current
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      if (!active.current || epoch.current !== generation) return
      const current = live.current
      if (current.phase !== 'listening' && current.phase !== 'waiting') return
      if (current.block !== undefined || current.pending !== undefined || current.session.removed) return
      if (current.input.phase !== 'plain' || current.input.draft !== '' || current.input.attachmentIds.length > 0) return
      if (current.delivery === 'current' && (current.session.running || current.session.pendingSubmissions.length > 0)) return
      if (mic.current?.isVoicing() || Date.now() < playbackNotBefore.current) {
        retryTimer = setTimeout(attempt, 300); return
      }
      const answer = playback.current.shift()
      if (answer === undefined) return
      mic.current?.monitorPlayback(); setPhase('speaking')
      cancelSpeech.current = speakReply(answer.text, t('voice.language'), () => {
        if (active.current && epoch.current === generation) {
          mic.current?.listen(false)
          resumeTimer.current = setTimeout(listen, 500)
        }
      }, () => { if (active.current && epoch.current === generation) pause(t('voice.speechFailed')) }, chosenVoice.current ?? loadPlaybackSpeaker(), () => {
        if (active.current && epoch.current === generation) pause('')
      }, outputOwner.current)
    }
    if (phase === 'listening' || phase === 'waiting') attempt()
    return () => { clearTimeout(retryTimer) }
  }, [reply, phase, delivery, dictation, session.running, session.pendingSubmissions.length, input, pending, block, listen, pause, t])

  useEffect(() => {
    if (!active.current || dictation || (phase !== 'speaking' && phase !== 'listening' && phase !== 'waiting')) return
    if (input.phase !== 'plain' || input.draft !== '' || input.attachmentIds.length > 0) pause(t('voice.typingPaused'))
  }, [dictation, phase, input.phase, input.draft, input.attachmentIds.length, pause, t])

  useEffect(() => {
    if (!active.current || phase === 'off'  || phase === 'paused') return
    if (session.removed || block !== undefined) pause(block?.reason ?? t('voice.sendFailed'))
    else if (pending !== undefined) pause(t('voice.approval'))
    else if (session.promptError !== null) pause(t('voice.sendFailed'))
  }, [session.removed, session.promptError, block, pending, phase, pause, t])

  const start = async (asDictation: boolean) => {
    cleanup(); claimSpeechOutput(() => {}, outputOwner.current)(); setHeard(''); setError(null)
    if (typeof navigator.mediaDevices === 'undefined' || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof AudioContext === 'undefined') { setError(t('voice.unsupported')); return }
    if (!asDictation && (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined')) { setError(t('voice.speechUnavailable')); return }
    if (block !== undefined || session.removed || workspace === undefined) { setError(block?.reason ?? t('voice.workspace')); return }
    if (input.phase !== 'plain' || input.occurrences.length > 0 || (!asDictation && (input.draft !== '' || input.attachmentIds.length > 0))) { setError(t('voice.draftChanged')); return }
    setDictation(asDictation); live.current = { ...live.current, dictation: asDictation }
    setPhase('starting'); active.current = true
    replySeq.current = reply?.seq
    original.current = { draft: input.draft, rev: input.draftRev }
    const generation = epoch.current
    const request = new AbortController(); controller.current = request
    try {
      if (!await status(request.signal)) throw new Error('VOICE_UNAVAILABLE')
      if (!isActive() || generation !== epoch.current) return
      const capture = await openMicrophone((audio) => { void onSegment(audio) }, () => { if (active.current) pause(t('voice.microphoneLost')) }, onBargeIn)
      if (!isActive() || generation !== epoch.current) { capture.close(); return }
      mic.current = capture; setBargeInAvailable(capture.bargeInAvailable); capture.listen(true); setPhase('listening')
    } catch (cause) {
      if (!isActive() || generation !== epoch.current || request.signal.aborted) return
      cleanup(); setPhase('off')
      setError(t(cause instanceof Error && cause.message === 'VOICE_UNAVAILABLE' ? 'voice.unavailable' : 'voice.microphoneDenied'))
    }
  }
  const stop = () => { cleanup(); setPhase('off'); setError(null) }
  const interrupt = () => {
    cancelPlayback()
    listen()
  }
  const phaseKey = phase === 'speaking' && !speechPlaying ? 'voice.preparingSpeech' : phase === 'waiting' && pending !== undefined ? 'voice.approval' : phase === 'waiting' && toolsRunning ? 'voice.executing' : `voice.${phase}` as const
  const controls = <>
    <div className={css.controls}>
      <span className={css.signal} data-active={phase === 'listening' || undefined} aria-hidden="true" />
      {phase !== 'paused' && phase !== 'starting' && <button className={css.quietButton} type="button" onClick={() => { pause('') }}>{t('voice.pauseMic')}</button>}
      {phase === 'paused' && <button className={css.button} type="button" onClick={interrupt}>{t('voice.resumeMic')}</button>}
      {(phase === 'speaking' || phase === 'waiting' || (phase === 'paused' && error !== null)) && <button className={css.quietButton} type="button" onClick={interrupt}>{t('voice.interrupt')}</button>}
      {phase === 'waiting' && session.running && <button className={css.quietButton} type="button" onClick={stopAgent}>{t('voice.stopTask')}</button>}
      <label className={css.delivery}>{t('voice.delivery')}<select
        aria-label={t('voice.delivery')}
        value={delivery}
        disabled={phase !== 'off'}
        onChange={(event) => { setDelivery(event.target.value as VoiceDelivery) }}
      ><option value="manager" disabled={session.subagent != null}>{t('voice.manager')}</option><option value="parallel" disabled={session.subagent != null}>{t('voice.parallel')}</option><option value="current">{t('voice.current')}</option></select></label>
    </div>
    <VoicePicker t={t} onVoiceChange={selectVoice}
      onPreviewStart={(cancel) => { pause(''); cancelPreview.current = cancel }}
      onPreviewStateChange={(state) => { setPreviewState(state); if (state === 'idle') cancelPreview.current = null }} />
    {phase === 'listening' && <p className={css.hint}>{t(dictation ? 'voice.dictationHint' : delivery === 'manager' ? 'voice.managerHint' : delivery === 'parallel' ? 'voice.parallelHint' : 'voice.listeningHint')}</p>}
    {phase === 'speaking' && <p className={css.hint}>{t(bargeInAvailable ? 'voice.bargeInHint' : 'voice.manualInterruptHint')}</p>}
    {heard !== '' && <p className={css.heard}>{t('voice.heard', { text: heard })}</p>}
    {error !== null && <p className={css.error} role="alert">{error}</p>}
  </>
  return phase === 'off'
    ? <section className={css.root} aria-label={t('voice.title')}>
      <ComposerVoiceEntry t={t} delivery={delivery} isSubagent={session.subagent != null}
        onStartConversation={() => { void start(false) }} onStartDictation={() => { void start(true) }} onDeliveryChange={setDelivery} />
      {error !== null && <p className={css.error} role="alert">{error}</p>}
    </section>
    : <FloatingVoicePanel t={t} state={previewState === 'playing' ? 'speaking' : previewState === 'preparing' ? 'thinking' : phase === 'waiting' ? toolsRunning ? 'executing' : 'thinking' : phase}
      status={t(previewState === 'playing' ? 'voice.voicePreviewPlaying' : previewState === 'preparing' ? 'voice.voicePreviewPreparing' : phaseKey)}
      revealControls={phase === 'paused'} activity={session.running ? t(toolsRunning ? 'voice.executing' : 'voice.thinking') : undefined}
      onClose={stop} onInterrupt={previewState !== 'idle' ? () => { cancelPreview.current?.() } : phase === 'speaking' || phase === 'waiting' ? interrupt : undefined}>{controls}</FloatingVoicePanel>
}
