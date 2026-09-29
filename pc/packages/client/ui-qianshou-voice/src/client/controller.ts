/** Session-bound capture and transcription; input mutation stays with the Conversation owner. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionInput, ExternalTextRequest } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VoiceStatus } from '@deepseek-ai/dsh-api-remotes/client'
import { openCapture, type CaptureOptions, type VoiceCapture } from './capture.ts'
import type { SystemSpeech } from './speech.ts'

/** A retained Session instance, never merely the globally selected id. */
export interface VoiceTarget {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly identity: object
  readonly input: SessionInput
  readonly current: () => boolean
  readonly watch: (changed: () => void) => () => void
}

/** Localized status keys; no raw network errors or audio are published. */
export type VoiceNotice = 'idle' | 'checking' | 'permission' | 'recording' | 'cancelling' | 'recognizing' | 'submitting'
  | 'inserted' | 'accepted' | 'review' | 'conflict' | 'blocked' | 'nonempty' | 'empty' | 'failed' | 'unavailable'
  | 'busy' | 'denied' | 'lost' | 'short' | 'limit' | 'timeout'

/** One page owns one capture; completed text remains only while its originating view lives. */
export interface VoiceViewState {
  readonly sessionId: SessionId | null
  readonly phase: 'idle' | 'checking' | 'permission' | 'recording' | 'recognizing' | 'submitting' | 'result'
  readonly notice: VoiceNotice
  readonly mode: 'insert' | 'send'
  readonly cancelling: boolean
  readonly pendingText: string | null
}

/** Host operations injected by plugin assembly; neither accepts a globally selected Session. */
export interface VoiceApi {
  status(signal: AbortSignal): Promise<VoiceStatus>
  transcribe(target: VoiceTarget, audio: Blob, signal: AbortSignal): Promise<string>
}

/** Explicit gesture state with one generation spanning permission, ASR and draft admission. */
export class VoiceController {
  /** Plain state consumed by all three registered voice entries. */
  readonly store = createSnapshotStore<VoiceViewState>({ sessionId: null, phase: 'idle', notice: 'idle', mode: 'insert', cancelling: false, pendingText: null })
  private revision = 0
  private aborter: AbortController | undefined
  private capture: VoiceCapture | undefined
  private target: VoiceTarget | undefined
  private owner: object | undefined
  private request: Omit<ExternalTextRequest, 'text'> | undefined
  private limits: VoiceStatus | undefined
  private disposed = false
  private unwatch: (() => void) | undefined

  constructor(
    private readonly api: VoiceApi,
    readonly speech: SystemSpeech,
    private readonly acquire: (options: CaptureOptions) => Promise<VoiceCapture> = openCapture,
  ) {}

  /**
   * Change the release action only while no utterance is in flight.
   * @param mode - Explicit dictation or queued-send preference.
   */
  setMode(mode: 'insert' | 'send'): void {
    if (this.active()) return
    this.store.set({ ...this.store.getSnapshot(), mode })
  }

  /**
   * Report whether a gesture or asynchronous voice operation is in flight.
   * @returns Whether the controller currently owns an active operation.
   */
  active(): boolean {
    return !['idle', 'result'].includes(this.store.getSnapshot().phase)
  }

  /**
   * Start an explicit held gesture against its captured Session instance.
   * @param target - Currently mounted Session/input binding.
   * @param owner - Identity of the view that must cancel on unmount.
   */
  async start(target: VoiceTarget | undefined, owner: object): Promise<void> {
    if (this.disposed || this.active()) return
    const cleanup = this.cancel()
    this.owner = owner; this.target = target
    if (target === undefined || !target.current()) { await cleanup; this.result('blocked'); return }
    const snapshot = target.input.state.getSnapshot()
    const mode = this.store.getSnapshot().mode
    this.store.set({ ...this.store.getSnapshot(), sessionId: target.sessionId, phase: 'checking', notice: 'checking' })
    if (snapshot.phase !== 'plain') { await cleanup; this.result('blocked'); return }
    if (mode === 'send' && (snapshot.draft !== '' || snapshot.attachmentIds.length !== 0)) { await cleanup; this.result('nonempty'); return }
    this.request = { expectedDraftRev: snapshot.draftRev, expectedAttachmentIds: [...snapshot.attachmentIds], intent: mode }
    const revision = ++this.revision
    const aborter = new AbortController(); this.aborter = aborter
    this.unwatch = target.watch(() => { if (!target.current()) { void this.cancel() } })
    this.speech.stop()
    try {
      await cleanup
      if (!this.live(revision)) return
      const status = await this.api.status(aborter.signal)
      if (!this.live(revision)) return
      this.limits = status
      if (!status.available) { this.result('unavailable'); return }
      if (status.busy) { this.result('busy'); return }
      this.store.set({ ...this.store.getSnapshot(), phase: 'permission', notice: 'permission' })
      const capture = await this.acquire({
        signal: aborter.signal, maxDurationSeconds: status.maxDurationSeconds, minDurationSeconds: status.minDurationSeconds,
        onLimit: () => { if (this.live(revision)) { void this.finish(true) } },
        onLost: () => {
          if (this.live(revision)) {
            const cancelled = revision + 1
            void this.cancel().then(() => { if (this.revision === cancelled && !this.disposed) this.result('lost') })
          }
        },
      })
      if (!this.live(revision)) { await capture.cancel(); return }
      this.capture = capture
      this.store.set({ ...this.store.getSnapshot(), phase: 'recording', notice: 'recording' })
    } catch (error) {
      if (this.live(revision)) this.result(error instanceof DOMException && error.name === 'NotAllowedError' ? 'denied' : 'failed')
    }
  }

  /**
   * Release exactly one capture; releasing while permission is pending cancels it.
   * @param reachedLimit - Whether capture hit the Host duration bound.
   */
  async finish(reachedLimit = false): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.phase === 'checking' || state.phase === 'permission') { await this.cancel(); return }
    if (state.phase !== 'recording') return
    const capture = this.capture; this.capture = undefined
    const target = this.target; const request = this.request; const signal = this.aborter?.signal
    const revision = this.revision
    if (capture === undefined || target === undefined || request === undefined || signal === undefined) return
    this.store.set({ ...state, phase: 'recognizing', notice: reachedLimit ? 'limit' : 'recognizing', cancelling: false })
    try {
      const audio = await capture.finish()
      if (!this.live(revision)) return
      if (audio === null) { this.result('short'); return }
      if (this.limits === undefined || audio.size > this.limits.maxAudioBytes) { this.result('failed'); return }
      const text = (await this.api.transcribe(target, audio, signal)).trim()
      if (!this.live(revision)) return
      if (text === '') { this.result('empty'); return }
      this.store.set({ ...this.store.getSnapshot(), phase: 'submitting', notice: 'submitting' })
      const outcome = await target.input.commitExternalText({ ...request, text })
      if (!this.live(revision)) return
      if (outcome.kind === 'rejected') {
        const conflict = outcome.reason === 'conflict' || outcome.reason === 'blocked' || outcome.reason === 'nonempty'
        const retain = conflict || (outcome.reason === 'failed' && target.input.state.getSnapshot().draft !== text)
        this.result(conflict ? 'conflict' : outcome.reason === 'empty' ? 'empty' : 'failed', retain ? text : null)
      } else this.result(outcome.kind)
    } catch (error) {
      if (!this.live(revision)) return
      const code = error instanceof Error ? error.message : ''
      this.result(code === 'NO_AUDIO' ? 'empty' : code === 'VOICE_BUSY' ? 'busy' : code === 'VOICE_TIMEOUT' ? 'timeout'
        : code === 'VOICE_UNAVAILABLE' ? 'unavailable' : code === 'SESSION_UNAVAILABLE' || code === 'SESSION_MISMATCH' ? 'blocked' : 'failed')
    }
  }

  /**
   * Explicitly append a retained recognition result to the originating draft's current revision.
   * @returns completion; repeated conflicts keep the result available for review.
   */
  async insertPending(): Promise<void> {
    const target = this.target; const text = this.store.getSnapshot().pendingText
    if (target === undefined || text === null || !target.current()) return
    const revision = this.revision
    const snapshot = target.input.state.getSnapshot()
    const result = await target.input.commitExternalText({ text, expectedDraftRev: snapshot.draftRev,
      expectedAttachmentIds: [...snapshot.attachmentIds], intent: 'insert' })
    if (!this.live(revision)) return
    if (result.kind === 'inserted') this.result('inserted')
    else this.result('conflict', text)
  }

  /**
   * Mark an upward held gesture as cancelling without changing its captured audio.
   * @param cancelling - Current release intent.
   */
  setCancelling(cancelling: boolean): void {
    this.store.set({ ...this.store.getSnapshot(), cancelling })
  }

  /**
   * Compare the view identity with the owner of the current gesture or result.
   * @param owner - View identity.
   * @returns Whether that view owns the current gesture or result.
   */
  owns(owner: object): boolean { return this.owner === owner }

  /** Cancel input resources; an already admitted Session message remains owned by its existing queue. */
  async cancel(): Promise<void> {
    const revision = ++this.revision
    this.aborter?.abort(); this.aborter = undefined
    this.unwatch?.(); this.unwatch = undefined
    const capture = this.capture; this.capture = undefined
    this.request = undefined; this.limits = undefined
    this.store.set({ ...this.store.getSnapshot(), phase: 'idle', notice: 'idle', cancelling: false, pendingText: null })
    if (capture !== undefined) {
      try { await capture.cancel() } catch (error) {
        void error
        if (!this.disposed && revision === this.revision) this.result('failed')
      }
    }
  }

  /**
   * Cancel only the departing capture view, preserving a newer view's gesture.
   * @param owner - Mounted control identity.
   */
  release(owner: object): void {
    if (this.owner === owner) { this.owner = undefined; void this.cancel() }
  }

  /** Dispose the page's voice resources and system speech. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.speech.dispose()
    await this.cancel()
  }

  private live(revision: number): boolean {
    return !this.disposed && revision === this.revision && this.aborter?.signal.aborted === false && this.target?.current() === true
  }

  private result(notice: VoiceNotice, pendingText: string | null = null): void {
    this.store.set({ ...this.store.getSnapshot(), phase: 'result', notice, cancelling: false, pendingText })
  }
}
