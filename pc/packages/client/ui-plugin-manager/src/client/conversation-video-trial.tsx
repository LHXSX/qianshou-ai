/** Independently persisted research cards in the existing chronological conversation. */
import { useLayoutEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsStore, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatTimelineEntry, ChatTimelineEntryProps, ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createVideoTrialStore, isVideoTrialCall, recordVideoTrialCall, type VideoTrialCall } from './video-trial-store.ts'
import { createVideoTrialTransport, VideoTrialHostError, type VideoTrialTransport, type VideoTrialFrame, type VideoTrialReference } from './video-trial-transport.ts'
import { VideoTrialCard } from './VideoTrialCard.tsx'
import { en, zh, type VideoTrialKey } from './video-trial-locales.ts'
import { createConversationVideoTrialPreview } from './conversation-video-trial-preview.ts'

const ID = 'qianshou-video-trials'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.videoTrials': VideoTrialKey }
}
type Store = ReturnType<typeof createVideoTrialStore>
function bridgeInjection(publish: (rows: readonly VideoTrialCall[]) => void, activate: () => () => void) {
  return { publish, activate }
}
type BridgeProps = PropsRuntime<'conversation.content.entries'> & PropsStore<Store>
  & PropsLocale<'qianshou.videoTrials'> & InjectFace<ReturnType<typeof bridgeInjection>>
function Bridge({ sessionId, useStore, publish, activate, reportPresence, t }: BridgeProps) {
  const rows = useStore(state => state.calls)
  const calls = Array.isArray(rows) ? rows.filter(row => isVideoTrialCall(row, sessionId)) : []
  const invalid = !Array.isArray(rows) || calls.length !== rows.length
  useLayoutEffect(() => activate(), [activate])
  useLayoutEffect(() => { publish(calls) }, [rows, sessionId, publish])
  useLayoutEffect(() => {
    reportPresence(ID, calls.length > 0 || invalid)
    return () => { reportPresence(ID, false) }
  }, [calls.length, invalid, reportPresence])
  return invalid ? <p role="alert">{t('invalid')}</p> : null
}
function cardInjection(isSubmitting: (id: string) => boolean, transport: VideoTrialTransport,
  onRegenerate: (call: VideoTrialCall) => Promise<boolean>) {
  return { isSubmitting, transport, onRegenerate }
}
type CardProps = ChatTimelineEntryProps & PropsStore<Store> & PropsLocale<'qianshou.videoTrials'>
  & InjectFace<ReturnType<typeof cardInjection>>
function Card({ sessionId, entryId, useStore, isSubmitting, transport, onRegenerate, t }: CardProps) {
  const call = useStore(state => Array.isArray(state.calls) ? state.calls.find(row => row.id === entryId) : undefined)
  return isVideoTrialCall(call, sessionId) ? <VideoTrialCard call={call} isSubmitting={isSubmitting}
    transport={transport} onRegenerate={onRegenerate} t={t} /> : null
}

export interface VideoTrialSubmission {
  outcome: 'accepted' | 'unknown' | 'busy' | 'refused' | 'notReady'
  request?: VideoTrialReference
}
/** Explicit submissions own POST; restored activity can only query its original identity. */
export function createVideoTrialSubmitter(options: {
  transport: VideoTrialTransport
  record: (call: VideoTrialCall) => boolean
  update: (call: VideoTrialCall) => void
}) {
  const pending = new Map<string, AbortController>()
  const regenerating = new Map<string, Promise<boolean>>()
  const lifetime = new AbortController()
  const isLive = (): boolean => !lifetime.signal.aborted
  const submit = async (session: { sessionId: SessionId }, prompt: string,
    source: VideoTrialCall['source'], frame?: VideoTrialFrame): Promise<VideoTrialSubmission> => {
    if (!isLive()) return { outcome: 'notReady' }
    const request: VideoTrialReference = { id: randomUUID(), sessionId: session.sessionId, prompt,
      seconds: 5, orientation: 'landscape', quality: 'fast',
      ...(source.kind === 'reuse' ? { reuseJobId: source.jobId } : {}) }
    const call: VideoTrialCall = { id: `video-trial-${request.id}`, sessionId: session.sessionId,
      createdAt: new Date().toISOString(), prompt, request, source, submission: 'pending' }
    const controller = new AbortController()
    pending.set(request.id, controller)
    try {
      if (!options.record(call)) { pending.delete(request.id); return { outcome: 'notReady' } }
    } catch { pending.delete(request.id); return { outcome: 'notReady' } }
    let settled: VideoTrialCall = { ...call, submission: 'settled' }
    let outcome: VideoTrialSubmission['outcome'] = 'unknown'
    try {
      await options.transport.start({ ...request, ...(frame === undefined ? {} : { firstFrame: frame }) }, controller.signal)
      outcome = 'accepted'
    } catch (failure) {
      if (failure instanceof VideoTrialHostError && failure.rejectedBeforeAcceptance) {
        outcome = failure.code === 'VIDEO_TRIAL_BUSY' ? 'busy' : 'refused'
        settled = { ...settled, request: null, rejection: outcome, rejectionCode: failure.code }
      }
    } finally {
      pending.delete(request.id)
      if (isLive()) options.update(settled)
    }
    return { outcome, request }
  }
  return {
    isSubmitting: (id: string): boolean => pending.has(id),
    submit(session: { sessionId: SessionId }, prompt: string, frame?: VideoTrialFrame, sha256?: string): Promise<VideoTrialSubmission> {
      if (frame === undefined) return submit(session, prompt, { kind: 'generated' })
      if (sha256 === undefined || !/^[a-f0-9]{64}$/u.test(sha256)) return Promise.resolve({ outcome: 'notReady' })
      return submit(session, prompt, { kind: 'attachment', mediaType: frame.mediaType, sha256 }, frame)
    },
    async reconcile(request: VideoTrialReference): Promise<VideoTrialSubmission> {
      if (!isLive()) return { outcome: 'unknown', request }
      try {
        await options.transport.read(request, AbortSignal.timeout(10000))
        return { outcome: 'accepted', request }
      } catch { return { outcome: 'unknown', request } }
    },
    regenerate(call: VideoTrialCall): Promise<boolean> {
      if (!isLive() || !isVideoTrialCall(call, call.sessionId) || call.request === null
        || pending.has(call.request.id)) return Promise.resolve(false)
      const key = JSON.stringify([call.sessionId, call.id])
      const inflight = regenerating.get(key)
      if (inflight !== undefined) return inflight
      const original = { sessionId: call.sessionId, prompt: call.request.prompt, jobId: call.request.id }
      const operation = Promise.resolve().then(() => submit(original, original.prompt, { kind: 'reuse', jobId: original.jobId }))
        .then(result => result.outcome === 'accepted').catch(() => false).finally(() => { regenerating.delete(key) })
      regenerating.set(key, operation)
      return operation
    },
    dispose(): void {
      lifetime.abort()
      for (const controller of pending.values()) controller.abort()
      pending.clear(); regenerating.clear()
    },
  }
}

/** Register independent trial cards without adding a marketplace listing or paid order.
 * @param ctx - Client plugin scope with Session, slot and locale services.
 * @returns A current Host enablement check and an explicit Session-scoped submit action.
 */
export function registerConversationVideoTrials(ctx: Context) {
  const store = createVideoTrialStore()
  const transport = createVideoTrialTransport(document.baseURI)
  const preview = createConversationVideoTrialPreview()
  const writers = new Map<SessionId, PropsStore<Store>['actions']>()
  const entries = new Map<SessionId, readonly ChatTimelineEntry[]>()
  const listeners = new Set<(sessionId: SessionId) => void>()
  let live = true
  let ready = false
  const submitter = createVideoTrialSubmitter({ transport,
    record: (call) => {
      const writer = writers.get(call.sessionId)
      if (!live || !ready || writer === undefined || ctx.sessions.binding(call.sessionId) === undefined) return false
      if (!recordVideoTrialCall(writer, call)) return false
      preview.changed(call.sessionId)
      return true
    },
    update: (call) => {
      if (live && ctx.sessions.binding(call.sessionId) !== undefined) writers.get(call.sessionId)?.save(call)
    },
  })
  const provider: ChatTimelineEntryProvider = {
    id: ID, read: sessionId => entries.get(sessionId) ?? [],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  ctx.effect(() => ctx.locale.register('qianshou.videoTrials', { zh, en }), 'video trial: localized copy')
  ctx.effect(() => () => { live = false; submitter.dispose(); preview.dispose(); writers.clear(); entries.clear(); listeners.clear() }, 'video trial: lifetime')
  ctx.inject(['uiWorkspace'], (scope) => {
    scope.effect(() => scope.uiWorkspace.registerSessionPreview(preview.provider), 'video trial: Session previews')
  })
  ctx.inject(['chatTimelineEntries'], (scope) => {
    scope.effect(() => {
      const dispose = scope.chatTimelineEntries.register(provider)
      ready = true
      return () => { ready = false; dispose() }
    }, 'video trial: timeline')
    scope.slots.inject('conversation.chat.timelineEntry', () => scope.slots.register({
      name: 'conversation.chat.timelineEntry', key: ID, store, locale: 'qianshou.videoTrials',
      inject: sessionId => cardInjection(submitter.isSubmitting, transport, call =>
        isVideoTrialCall(call, sessionId) ? submitter.regenerate(call) : Promise.resolve(false)),
    }, Card))
  })
  ctx.slots.inject('conversation.content.entries', () => ctx.slots.register({
    name: 'conversation.content.entries', id: ID, order: 12, store, locale: 'qianshou.videoTrials',
    inject: (sessionId, actions) => bridgeInjection((rows) => {
      if (!live || writers.get(sessionId) !== actions) return
      const next = rows.map(row => ({ id: row.id, createdAt: Date.parse(row.createdAt) }))
      if (JSON.stringify(entries.get(sessionId)) === JSON.stringify(next)) return
      entries.set(sessionId, next); notifySubscribers(listeners, 'video trial timeline', sessionId)
    }, () => {
      if (!live) return () => {}
      writers.set(sessionId, actions)
      return () => {
        if (writers.get(sessionId) !== actions) return
        writers.delete(sessionId); entries.delete(sessionId)
        notifySubscribers(listeners, 'video trial timeline', sessionId)
      }
    }),
  }, Bridge))
  return {
    enabled: (signal?: AbortSignal) => transport.enabled(signal),
    text: ctx.locale.bind('qianshou.videoTrials'),
    open: (...args: Parameters<typeof submitter.submit>) => submitter.submit(...args),
    reconcile: (request: VideoTrialReference) => submitter.reconcile(request),
  }
}
