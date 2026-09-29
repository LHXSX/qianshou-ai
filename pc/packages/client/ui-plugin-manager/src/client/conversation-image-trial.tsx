/** Independently persisted research cards in the existing chronological conversation. */
import { useLayoutEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsStore, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatTimelineEntry, ChatTimelineEntryProps, ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createImageTrialStore, isImageTrialCall, recordImageTrialCall, type ImageTrialCall } from './image-trial-store.ts'
import { createImageTrialTransport, ImageTrialHostError, type ImageTrialTransport,
  type ImageTrialSize, type ImageTrialSteps } from './image-trial-transport.ts'
import { ImageTrialCard } from './ImageTrialCard.tsx'
import { en, zh, type ImageTrialKey } from './image-trial-locales.ts'
import { createConversationImageTrialPreview } from './conversation-image-trial-preview.ts'

const ID = 'qianshou-image-trials'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.imageTrials': ImageTrialKey }
}
type Store = ReturnType<typeof createImageTrialStore>
function bridgeInjection(publish: (rows: readonly ImageTrialCall[]) => void, activate: () => () => void) {
  return { publish, activate }
}
type BridgeProps = PropsRuntime<'conversation.content.entries'> & PropsStore<Store>
  & PropsLocale<'qianshou.imageTrials'> & InjectFace<ReturnType<typeof bridgeInjection>>
function Bridge({ sessionId, useStore, publish, activate, reportPresence, t }: BridgeProps) {
  const rows = useStore(state => state.calls)
  const calls = Array.isArray(rows) ? rows.filter(row => isImageTrialCall(row, sessionId)) : []
  const invalid = !Array.isArray(rows) || calls.length !== rows.length
  useLayoutEffect(() => activate(), [activate])
  useLayoutEffect(() => { publish(calls) }, [rows, sessionId, publish])
  useLayoutEffect(() => {
    reportPresence(ID, calls.length > 0 || invalid)
    return () => { reportPresence(ID, false) }
  }, [calls.length, invalid, reportPresence])
  return invalid ? <p role="alert">{t('invalid')}</p> : null
}
function cardInjection(isSubmitting: (id: string) => boolean, transport: ImageTrialTransport,
  onRegenerate: (call: ImageTrialCall, steps?: ImageTrialSteps) => Promise<boolean>) {
  return { isSubmitting, transport, onRegenerate }
}
type CardProps = ChatTimelineEntryProps & PropsStore<Store> & PropsLocale<'qianshou.imageTrials'>
  & InjectFace<ReturnType<typeof cardInjection>>
function Card({ sessionId, entryId, useStore, isSubmitting, transport, onRegenerate, t }: CardProps) {
  const call = useStore(state => Array.isArray(state.calls) ? state.calls.find(row => row.id === entryId) : undefined)
  return isImageTrialCall(call, sessionId) ? <ImageTrialCard call={call} isSubmitting={isSubmitting}
    transport={transport} onRegenerate={onRegenerate} t={t} /> : null
}

/** Own explicit composer submissions and never resume a POST from persisted display state.
 * @param options - Local carrier and the Session store's synchronous write operations.
 * @returns Explicit submission, result regeneration, in-flight lookup and lifetime teardown.
 */
export function createImageTrialSubmitter(options: {
  transport: ImageTrialTransport
  record: (call: ImageTrialCall) => boolean
  update: (call: ImageTrialCall) => void
}) {
  const pending = new Map<string, AbortController>()
  const regenerating = new Map<string, Promise<boolean>>()
  let live = true
  const isLive = (): boolean => live
  const submit = async (session: { sessionId: SessionId }, prompt: string, size: ImageTrialSize,
    outcome: 'recorded' | 'accepted', steps?: ImageTrialSteps): Promise<boolean> => {
    if (!live) return false
    const request = { id: randomUUID(), sessionId: session.sessionId, prompt, size,
      ...(steps === undefined ? {} : { steps }) }
    const call: ImageTrialCall = { id: `image-trial-${request.id}`, sessionId: session.sessionId,
      createdAt: new Date().toISOString(), prompt, size, request, submission: 'pending',
      ...(steps === undefined ? {} : { steps }) }
    const controller = new AbortController()
    pending.set(request.id, controller)
    try {
      if (!options.record(call)) { pending.delete(request.id); return false }
    } catch {
      pending.delete(request.id)
      return false
    }
    let settled: ImageTrialCall = { ...call, submission: 'settled' }
    let accepted = false
    try { accepted = (await options.transport.start(request, controller.signal)).status !== 'failed' }
    catch (failure) {
      if (failure instanceof ImageTrialHostError && failure.rejectedBeforeAcceptance) {
        settled = { ...settled, request: null, rejection: failure.code === 'IMAGE_TRIAL_BUSY' ? 'busy'
          : failure.code === 'IMAGE_TRIAL_CREDENTIAL_UNAVAILABLE' ? 'credential' : 'rejected' }
      }
      // Unknown responses retain the same request id and allow only read-only reconciliation.
    } finally {
      pending.delete(request.id)
      if (isLive()) options.update(settled)
    }
    return outcome === 'recorded' || (isLive() && accepted)
  }
  return {
    isSubmitting: (id: string): boolean => pending.has(id),
    submit: (session: { sessionId: SessionId }, prompt: string, size: ImageTrialSize): Promise<boolean> =>
      submit(session, prompt, size, 'recorded'),
    regenerate(call: ImageTrialCall, steps?: ImageTrialSteps): Promise<boolean> {
      if (!live || !isImageTrialCall(call, call.sessionId) || call.request === null
        || pending.has(call.request.id)) return Promise.resolve(false)
      const key = JSON.stringify([call.sessionId, call.id])
      const inflight = regenerating.get(key)
      if (inflight !== undefined) return inflight
      const original = { sessionId: call.sessionId, prompt: call.request.prompt, size: call.request.size }
      // Reserve the original result before writing the new row, including synchronous store notifications.
      const operation = Promise.resolve().then(() => submit(original, original.prompt, original.size,
        'accepted', steps ?? call.request?.steps))
        .catch(() => false).finally(() => { regenerating.delete(key) })
      regenerating.set(key, operation)
      return operation
    },
    dispose(): void {
      live = false
      for (const controller of pending.values()) controller.abort()
      pending.clear(); regenerating.clear()
    },
  }
}

/** Register independent trial cards without adding a marketplace listing or paid order.
 * @param ctx - Client plugin scope with Session, slot and locale services.
 * @returns A current Host enablement check and an explicit Session-scoped submit action.
 */
export function registerConversationImageTrials(ctx: Context) {
  const store = createImageTrialStore()
  const transport = createImageTrialTransport(document.baseURI)
  const preview = createConversationImageTrialPreview()
  const writers = new Map<SessionId, PropsStore<Store>['actions']>()
  const entries = new Map<SessionId, readonly ChatTimelineEntry[]>()
  const listeners = new Set<(sessionId: SessionId) => void>()
  let live = true
  let ready = false
  const submitter = createImageTrialSubmitter({ transport,
    record: (call) => {
      const writer = writers.get(call.sessionId)
      if (!live || !ready || writer === undefined || ctx.sessions.binding(call.sessionId) === undefined) return false
      if (!recordImageTrialCall(writer, call)) return false
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
  ctx.effect(() => ctx.locale.register('qianshou.imageTrials', { zh, en }), 'image trial: localized copy')
  ctx.effect(() => () => { live = false; submitter.dispose(); preview.dispose(); writers.clear(); entries.clear(); listeners.clear() }, 'image trial: lifetime')
  ctx.inject(['uiWorkspace'], (scope) => {
    scope.effect(() => scope.uiWorkspace.registerSessionPreview(preview.provider), 'image trial: Session previews')
  })
  ctx.inject(['chatTimelineEntries'], (scope) => {
    scope.effect(() => {
      const dispose = scope.chatTimelineEntries.register(provider)
      ready = true
      return () => { ready = false; dispose() }
    }, 'image trial: timeline')
    scope.slots.inject('conversation.chat.timelineEntry', () => scope.slots.register({
      name: 'conversation.chat.timelineEntry', key: ID, store, locale: 'qianshou.imageTrials',
      inject: sessionId => cardInjection(submitter.isSubmitting, transport, (call, steps) =>
        isImageTrialCall(call, sessionId) ? submitter.regenerate(call, steps) : Promise.resolve(false)),
    }, Card))
  })
  ctx.slots.inject('conversation.content.entries', () => ctx.slots.register({
    name: 'conversation.content.entries', id: ID, order: 11, store, locale: 'qianshou.imageTrials',
    inject: (sessionId, actions) => bridgeInjection((rows) => {
      if (!live || writers.get(sessionId) !== actions) return
      const next = rows.map(row => ({ id: row.id, createdAt: Date.parse(row.createdAt) }))
      if (JSON.stringify(entries.get(sessionId)) === JSON.stringify(next)) return
      entries.set(sessionId, next); notifySubscribers(listeners, 'image trial timeline', sessionId)
    }, () => {
      if (!live) return () => {}
      writers.set(sessionId, actions)
      return () => {
        if (writers.get(sessionId) !== actions) return
        writers.delete(sessionId); entries.delete(sessionId)
        notifySubscribers(listeners, 'image trial timeline', sessionId)
      }
    }),
  }, Bridge))
  return {
    enabled: (signal?: AbortSignal) => transport.enabled(signal),
    text: ctx.locale.bind('qianshou.imageTrials'),
    open: submitter.submit,
  }
}
