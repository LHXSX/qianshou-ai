/** Official media quotes and receipts in the original conversation timeline and @ entry. */
import { useLayoutEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsStore, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatTimelineEntry, ChatTimelineEntryProps, ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ClientSessionContext, SubmitAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { WorkspaceSessionPreviewProvider } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { FormalMediaCard } from './FormalMediaCard.tsx'
import { createFormalMediaTransport, FormalMediaHostError, type FormalMediaTransport } from './formal-media-transport.ts'
import { formalMediaIntent } from './formal-media-intent.ts'
import { formalMediaAttachments } from './formal-media-attachments.ts'
import { FORMAL_MEDIA_STORE_KEY, createFormalMediaStore, isFormalMediaCall, persistFormalMediaCall, type FormalMediaCall } from './formal-media-store.ts'
import { en, zh, type FormalMediaKey } from './formal-media-locales.ts'

const ID = 'qianshou-formal-media'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'qianshou.formalMedia': FormalMediaKey }
}
type Store = ReturnType<typeof createFormalMediaStore>
function bridgeInjection(publish: (calls: readonly FormalMediaCall[]) => void, activate: () => () => void) { return { publish, activate } }
type BridgeProps = PropsRuntime<'conversation.content.entries'> & PropsStore<Store> & PropsLocale<'qianshou.formalMedia'>
  & InjectFace<ReturnType<typeof bridgeInjection>>
function Bridge({ sessionId, useStore, publish, activate, reportPresence, t }: BridgeProps) {
  const saved = useStore(state => state.calls)
  const calls = Array.isArray(saved) ? saved.filter(row => isFormalMediaCall(row, sessionId)) : []
  const invalid = !Array.isArray(saved) || saved.length !== calls.length
  useLayoutEffect(() => activate(), [activate])
  useLayoutEffect(() => { publish(calls) }, [saved, sessionId, publish])
  useLayoutEffect(() => {
    reportPresence(ID, invalid || calls.length > 0)
    return () => { reportPresence(ID, false) }
  }, [invalid, calls.length, reportPresence])
  return invalid ? <p role="alert">{t('invalid')}</p> : null
}
function cardInjection(transport: FormalMediaTransport, confirm: (call: FormalMediaCall) => Promise<boolean>,
  quote: (call: FormalMediaCall) => Promise<boolean>) {
  return { transport, confirm, quote }
}
type CardProps = ChatTimelineEntryProps & PropsStore<Store> & PropsLocale<'qianshou.formalMedia'> & InjectFace<ReturnType<typeof cardInjection>>
function Card({ sessionId, entryId, useStore, transport, confirm, quote, t }: CardProps) {
  const call = useStore(state => Array.isArray(state.calls) ? state.calls.find(r => r.id === entryId) : undefined)
  return isFormalMediaCall(call, sessionId) ? <FormalMediaCard call={call} transport={transport}
    onConfirm={confirm} onQuote={quote} t={t} /> : null
}

/** Register official quote cards without changing the three main product entries.
 * @param ctx - Client plugin scope with Session, timeline, slot and locale services.
 * @returns Read-only admission and a conversation-scoped quote action; payment requires a card click.
 */
export function registerConversationFormalMedia(ctx: Context) {
  const store = createFormalMediaStore()
  const transport = createFormalMediaTransport(document.baseURI)
  const writers = new Map<SessionId, PropsStore<Store>['actions']>()
  const entries = new Map<SessionId, readonly ChatTimelineEntry[]>()
  const listeners = new Set<(sessionId: SessionId) => void>()
  const previewListeners = new Set<(sessionId: SessionId) => void>()
  const pending = new Map<string, Promise<boolean>>()
  const quoting = new Map<string, Promise<boolean>>()
  const lifetime = new AbortController()
  let ready = false
  const writer = (call: FormalMediaCall) => !lifetime.signal.aborted && ready && ctx.sessions.binding(call.sessionId) !== undefined
    ? writers.get(call.sessionId) : undefined
  const safeError = (failure: unknown) => failure instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/u.test(failure.message)
    ? failure.message : 'FORMAL_MEDIA_UNAVAILABLE'
  const requestQuote = async (call: FormalMediaCall): Promise<boolean> => {
    if (!['quoted', 'quote-failed', 'quoting', 'assets-pending'].includes(call.submission)) return false
    const actions = writer(call)
    if (actions === undefined) return false
    if (call.submission === 'assets-pending' || call.assetUploads?.some(a => a.status !== 'registered')) {
      const uploads = call.assetUploads
      if (uploads === undefined || uploads.length === 0) return false
      try {
        const reconciled = []
        for (const upload of uploads) {
          const status = await transport.assetStatus(upload, lifetime.signal)
          if (status.status !== 'registered' || writer(call) !== actions) return false
          reconciled.push({ ...upload, status: 'registered' as const })
        }
        call = { ...call, assetUploads: reconciled }
      } catch (failure) {
        if (writer(call) === actions) actions.save({ ...call, errorCode: safeError(failure) })
        return false
      }
    }
    const next: FormalMediaCall = { ...call, submission: 'quoting', quote: null }
    if (!persistFormalMediaCall(actions, next, true)) return false
    try {
      const result = await transport.quote(call, call.input, lifetime.signal)
      if (writer(call) !== actions) return false
      actions.save({ ...next, submission: 'quoted', quote: result })
      return true
    } catch (failure) {
      if (writer(call) === actions) actions.save({ ...next, submission: 'quote-failed', errorCode: safeError(failure) })
      return false
    }
  }
  const quote = (call: FormalMediaCall): Promise<boolean> => {
    const key = `${call.sessionId}:${call.requestId}`
    const prior = quoting.get(key)
    if (prior !== undefined) return prior
    const operation = Promise.resolve().then(() => requestQuote(call))
    quoting.set(key, operation)
    void operation.finally(() => { quoting.delete(key) }).catch(() => undefined)
    return operation
  }
  const confirm = (call: FormalMediaCall): Promise<boolean> => {
    const key = `${call.sessionId}:${call.requestId}`
    const prior = pending.get(key)
    if (prior !== undefined) return prior
    const actions = writer(call)
    if (actions === undefined || call.submission !== 'quoted' || call.quote === null
      || !call.quote.balanceEnough || Date.parse(call.quote.expiresAt) <= Date.now()) return Promise.resolve(false)
    let rows: unknown
    try {
      const saved = localStorage.getItem(`${FORMAL_MEDIA_STORE_KEY}.${call.sessionId}`)
      rows = saved === null ? null : JSON.parse(saved) as unknown
    } catch { return Promise.resolve(false) }
    if (rows === null || typeof rows !== 'object' || !('calls' in rows) || !Array.isArray(rows.calls)
      || !rows.calls.some(row => isFormalMediaCall(row, call.sessionId)
        && JSON.stringify(row) === JSON.stringify(call))) return Promise.resolve(false)
    const uncertain: FormalMediaCall = { ...call, submission: 'uncertain' }
    if (!persistFormalMediaCall(actions, uncertain, true)) return Promise.resolve(false)
    const receipt = call.quote
    const operation = transport.confirm(receipt, lifetime.signal).then((result) => {
      if (writer(call) !== actions) return false
      actions.save({ ...uncertain, submission: 'submitted', taskId: result.taskId })
      return true
    }, (failure: unknown) => {
      if (failure instanceof FormalMediaHostError && failure.rejectedBeforeSubmission) {
        pending.delete(key)
        if (writer(call) === actions) actions.save({ ...call, quote: null, submission: 'quote-failed', errorCode: safeError(failure) })
      } else if (writer(call) === actions) actions.save({ ...uncertain, errorCode: safeError(failure) })
      return false
    })
    pending.set(key, operation)
    return operation
  }
  const provider: ChatTimelineEntryProvider = { id: ID, read: id => entries.get(id) ?? [],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const preview: WorkspaceSessionPreviewProvider = {
    read(sessionId) {
      try {
        const raw = localStorage.getItem(`${FORMAL_MEDIA_STORE_KEY}.${sessionId}`)
        if (raw === null) return null
        if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) return { kind: 'unavailable' }
        const value: unknown = JSON.parse(raw)
        if (value === null || typeof value !== 'object' || !('calls' in value) || !Array.isArray(value.calls)) return { kind: 'unavailable' }
        const calls = value.calls.filter(row => isFormalMediaCall(row, sessionId))
        const last = calls.at(-1)
        if (last === undefined) return value.calls.length === 0 ? null : { kind: 'unavailable' }
        return { kind: 'content', title: `@${last.input.capability === 'image' ? '出图' : '出视频'} ${last.input.prompt}`.slice(0, 48),
          searchText: last.input.prompt.slice(0, 512), updatedAt: Date.parse(last.createdAt) }
      } catch { return { kind: 'unavailable' } }
    },
    subscribe: (listener) => { previewListeners.add(listener); return () => { previewListeners.delete(listener) } },
  }
  ctx.effect(() => ctx.locale.register('qianshou.formalMedia', { zh, en }), 'formal media: locale copy')
  ctx.effect(() => () => { lifetime.abort(); ready = false; pending.clear(); quoting.clear(); entries.clear(); writers.clear(); listeners.clear(); previewListeners.clear() }, 'formal media: client lifetime')
  ctx.inject(['uiWorkspace'], (scope) => { scope.effect(() => scope.uiWorkspace.registerSessionPreview(preview), 'formal media: Session previews') })
  ctx.inject(['chatTimelineEntries'], (scope) => {
    scope.effect(() => { const dispose = scope.chatTimelineEntries.register(provider); ready = true; return () => { ready = false; dispose() } }, 'formal media: chronological receipts')
    scope.slots.inject('conversation.chat.timelineEntry', () => scope.slots.register({
      name: 'conversation.chat.timelineEntry', key: ID, store, locale: 'qianshou.formalMedia',
      inject: sessionId => cardInjection(transport, call => call.sessionId === sessionId ? confirm(call) : Promise.resolve(false),
        call => call.sessionId === sessionId ? quote(call) : Promise.resolve(false)),
    }, Card))
  })
  ctx.slots.inject('conversation.content.entries', () => ctx.slots.register({
    name: 'conversation.content.entries', id: ID, order: 13, store, locale: 'qianshou.formalMedia',
    inject: (sessionId, actions) => bridgeInjection((calls) => {
      if (writers.get(sessionId) !== actions || lifetime.signal.aborted) return
      const next = calls.map(call => ({ id: call.id, createdAt: Date.parse(call.createdAt) }))
      if (JSON.stringify(entries.get(sessionId)) !== JSON.stringify(next)) {
        entries.set(sessionId, next); notifySubscribers(listeners, 'formal media timeline', sessionId)
      }
      notifySubscribers(previewListeners, 'formal media previews', sessionId)
    }, () => {
      if (lifetime.signal.aborted) return () => {}
      writers.set(sessionId, actions)
      return () => { if (writers.get(sessionId) === actions) { writers.delete(sessionId); entries.delete(sessionId); notifySubscribers(listeners, 'formal media timeline', sessionId) } }
    }),
  }, Bridge))
  const text = ctx.locale.bind('qianshou.formalMedia')
  return {
    text,
    async enabled(signal?: AbortSignal) {
      const directory = await transport.directory(signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]))
      return directory.billing_status === 'ready' && directory.profiles.some(p => p.enabled)
    },
    async open(session: ClientSessionContext, capability: 'image' | 'video', prompt: string, attachments: readonly SubmitAttachment[]):
    Promise<{ kind: 'success' } | { kind: 'error'; text: string }> {
      const directory = await transport.directory(lifetime.signal)
      if (directory.billing_status !== 'ready') return { kind: 'error', text: text('quoteFailed') }
      let prepared: Awaited<ReturnType<typeof formalMediaAttachments>>
      try { prepared = await formalMediaAttachments(session.sessionId, capability, attachments) }
      catch { return { kind: 'error', text: text('assetsUnavailable') } }
      const assets = prepared.map(({ intent }) => ({ asset_id: intent.assetId, sha256: intent.sha256, role: intent.role }))
      const intent = formalMediaIntent(capability, prompt, directory.profiles, assets)
      if ('error' in intent) return { kind: 'error', text: text(intent.error) }
      let call: FormalMediaCall = { id: '', sessionId: session.sessionId, createdAt: new Date().toISOString(),
        requestId: randomUUID(), input: intent.input, quote: null, submission: prepared.length === 0 ? 'quoting' : 'assets-pending', taskId: null,
        ...(prepared.length === 0 ? {} : { assetUploads: prepared.map(({ intent }) => ({ ...intent, status: 'uncertain' as const })) }) }
      call.id = `formal-media-${call.requestId}`
      const actions = writer(call)
      if (actions === undefined || !persistFormalMediaCall(actions, call)) return { kind: 'error', text: text('notReady') }
      notifySubscribers(previewListeners, 'formal media previews', call.sessionId)
      await Promise.allSettled(prepared.map(async ({ intent, data }) => {
        try {
          const status = await transport.uploadAsset(intent, data, lifetime.signal)
          if (status.status !== 'registered' || writer(call) !== actions) return
          const uploads = call.assetUploads
          if (uploads === undefined) return
          call = { ...call, assetUploads: uploads.map(a => a.assetId === intent.assetId ? { ...a, status: 'registered' } : a) }
          persistFormalMediaCall(actions, call, true)
        } catch (failure) {
          if (writer(call) === actions) actions.save({ ...call, errorCode: safeError(failure) })
        }
      }))
      if (call.assetUploads?.some(a => a.status !== 'registered') || writer(call) !== actions) return { kind: 'success' }
      call = { ...call, submission: 'quoting' }
      await quote(call)
      return { kind: 'success' }
    },
  }
}
