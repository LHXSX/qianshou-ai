/** Register Session-bound market call cards through the Conversation scroll body. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { canCallMarketCapability, type MarketCapabilitiesController, type MarketCapabilityView } from './market-capabilities-controller.ts'
import { createConversationMarketStore } from './conversation-market-store.ts'
import { createConversationMarketPreview } from './conversation-market-preview.ts'
import { ConversationMarketCalls, ConversationMarketTimelineCall } from './ConversationMarketCalls.tsx'
import { createConversationMarketTimeline, MARKET_TIMELINE_ID } from './conversation-market-timeline.ts'
import type { ConversationMarketCall } from './conversation-market-store.ts'
import type { MarketTaskContinuation } from './MarketTaskCall.tsx'
import type { MarketInputFile } from './market-task-transport.ts'
import type { LoadMarketInputPresentation } from './market-legacy-input-presentation.ts'
import { en, zh, type ConversationMarketKey } from './conversation-market-locales.ts'
import type { MarketUsageController } from './market-usage.ts'
import type { PrepareVideoAssetPlan } from './video-asset-plan.ts'

interface MarketCallPreferences {
  catalog: MarketCapabilitiesController['store']
  reloadCatalog: () => Promise<void>
  readOwner: () => Promise<number | null>
  usage: Pick<MarketUsageController, 'recordDispatch'>
  loadInputPresentation?: LoadMarketInputPresentation
  prepareVideoAssetPlan?: PrepareVideoAssetPlan
}

function bridgeInjection(publish: (rows: readonly ConversationMarketCall[]) => void, activate: () => () => void) {
  return { publish, activate }
}

function timelineInjection(continueCall: (id: string, next: MarketTaskContinuation) => boolean,
  recordDispatch: (callId: string, taskType: string, workloadId: string, owner: number) => void,
  catalog: MarketCapabilitiesController['store'], refreshCatalog: () => Promise<void>,
  loadInputPresentation?: LoadMarketInputPresentation, prepareVideoAssetPlan?: PrepareVideoAssetPlan) {
  return { continueCall, recordDispatch, refreshCatalog, loadInputPresentation,
    prepareVideoAssetPlan, hooks: { marketCatalog: catalog } }
}

/** Single persisted-store bridge face; no task cards occupy the composer tail. */
export type ConversationMarketBridgeInject = ReturnType<typeof bridgeInjection>
/** Scoped continuation and optional dispatch-history callbacks. */
export type ConversationMarketTimelineInject = ReturnType<typeof timelineInjection>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session market request cards. */
    'qianshou.marketCalls': ConversationMarketKey
  }
}

/** Register the card store and return the source's Session-addressed submission callback.
 * @param ctx - Plugin scope with Slots, locale and Sessions already injected.
 * @param preferences - Current public account reader and optional dispatch-history writer.
 * @returns A callback that records one explicitly submitted natural-language request.
 */
export function registerConversationMarketCalls(ctx: Context, preferences: MarketCallPreferences) {
  const store = createConversationMarketStore()
  type Actions = PropsStore<typeof store>['actions']
  const writers = new Map<SessionId, { actions: Actions }>()
  const pendingSelections = new Map<SessionId, ConversationMarketCall>()
  const preview = createConversationMarketPreview()
  const timeline = createConversationMarketTimeline()
  const recordedDispatches = new Set<string>()
  let live = true
  let timelineReady = false
  ctx.effect(() => ctx.locale.register('qianshou.marketCalls', { zh, en }), 'ui-plugin-manager: Session market copy')
  ctx.effect(() => () => {
    live = false
    writers.clear()
    pendingSelections.clear()
    preview.dispose()
    timeline.dispose()
    recordedDispatches.clear()
  }, 'ui-plugin-manager: Session market writers')
  const recordCall = (sessionId: SessionId, writer: { actions: Actions }, call: ConversationMarketCall): void => {
    writer.actions.addCall(call)
    preview.recorded(call)
    void preferences.readOwner().then((owner) => {
      if (!live || owner === null || writers.get(sessionId) !== writer
        || ctx.sessions.binding(sessionId) === undefined) return
      writer.actions.captureUsageOwner(call.id, owner)
      preview.changed(sessionId)
    }, (_failure: unknown) => { /* Optional history identity never blocks the request. */ })
  }
  ctx.inject(['uiWorkspace'], (scope) => {
    scope.effect(() => scope.uiWorkspace.registerSessionPreview(preview.provider),
      'ui-plugin-manager: Session market previews')
  })
  ctx.inject(['chatTimelineEntries'], (scope) => {
    scope.effect(() => {
      const unregister = scope.chatTimelineEntries.register(timeline.provider)
      timelineReady = true
      return () => { timelineReady = false; unregister() }
    }, 'ui-plugin-manager: chronological market requests')
    scope.slots.inject('conversation.chat.timelineEntry', () => scope.slots.register({
      name: 'conversation.chat.timelineEntry', key: MARKET_TIMELINE_ID, locale: 'qianshou.marketCalls', store,
      inject: sessionId => timelineInjection((id, next) => {
        const writer = writers.get(sessionId)
        if (!live || writer === undefined || ctx.sessions.binding(sessionId) === undefined
          || !timeline.provider.read(sessionId).some(entry => entry.id === id)) return false
        // The bridge and timeline Slots can receive distinct action wrappers for
        // the same Session. Always use the currently mounted bridge writer.
        writer.actions.continueCall(id, next)
        return true
      }, (callId, taskType, workloadId, owner) => {
        if (!live || writers.get(sessionId) === undefined || ctx.sessions.binding(sessionId) === undefined
          || !timeline.provider.read(sessionId).some(entry => entry.id === callId)) return
        const key = JSON.stringify([sessionId, callId, workloadId])
        if (recordedDispatches.has(key)) return
        recordedDispatches.add(key)
        void preferences.usage.recordDispatch(taskType, workloadId, owner)
      }, preferences.catalog, async () => {
        if (live && writers.get(sessionId) !== undefined && ctx.sessions.binding(sessionId) !== undefined) {
          await preferences.reloadCatalog()
        }
      }, preferences.loadInputPresentation, preferences.prepareVideoAssetPlan),
    }, ConversationMarketTimelineCall))
  })
  ctx.slots.inject('conversation.content.entries', () => ctx.slots.register({
    name: 'conversation.content.entries', id: 'qianshou-market-calls', order: 10,
    locale: 'qianshou.marketCalls', store,
    inject: (sessionId, actions) => {
      return bridgeInjection(
        (rows) => { if (live && writers.get(sessionId)?.actions === actions) timeline.publish(sessionId, rows) },
        () => {
          if (!live) return () => {}
          const writer = { actions }
          writers.set(sessionId, writer)
          const pending = pendingSelections.get(sessionId)
          if (pending !== undefined && ctx.sessions.binding(sessionId) !== undefined) {
            pendingSelections.delete(sessionId)
            recordCall(sessionId, writer, pending)
          }
          return () => {
            if (writers.get(sessionId) !== writer) return
            writers.delete(sessionId)
            timeline.release(sessionId)
          }
        },
      )
    },
  }, ConversationMarketCalls))
  return (session: Pick<ClientSessionContext, 'sessionId'>, capability: MarketCapabilityView, goal: string,
    files?: readonly MarketInputFile[], selectedProduct?: MarketCapabilityView['products'][number],
    draftOnly = false, directVideoEntry = false): boolean => {
    if (!live || !timelineReady || ctx.sessions.binding(session.sessionId) === undefined) return false
    if (draftOnly && (capability.taskType !== 'video_generate' || capability.capabilityId !== 'video.render'
      || capability.category !== 'video' || files !== undefined || selectedProduct !== undefined)) return false
    if (directVideoEntry && (capability.capabilityId !== 'video.render' || capability.category !== 'video'
      || files !== undefined || selectedProduct !== undefined)) return false
    if (selectedProduct !== undefined && (files !== undefined || !capability.products.some(product =>
      product.productId === selectedProduct.productId && product.publicationId === selectedProduct.publicationId
      && product.ownerId === selectedProduct.ownerId && product.version === selectedProduct.version))) return false
    const catalog = preferences.catalog.getSnapshot()
    if (!draftOnly && (!catalog.loaded || catalog.loading || catalog.error || !catalog.capabilities.some(item =>
      item.taskType === capability.taskType && item.capabilityId === capability.capabilityId
      && canCallMarketCapability(item) && (selectedProduct === undefined || item.products.some(product =>
        product.productId === selectedProduct.productId && product.publicationId === selectedProduct.publicationId
        && product.ownerId === selectedProduct.ownerId && product.version === selectedProduct.version))))) return false
    const writer = writers.get(session.sessionId)
    const call = { id: `market-call-${randomUUID()}`, sessionId: session.sessionId,
      createdAt: new Date().toISOString(), goal,
      capability: { taskType: capability.taskType, capabilityId: capability.capabilityId,
        name: capability.name, category: capability.category },
      ...(draftOnly ? { draftOnly: true as const } : {}),
      ...(directVideoEntry || draftOnly ? { directVideoEntry: true as const } : {}),
      ...(selectedProduct === undefined ? {} : { selectedProduct: {
        productId: selectedProduct.productId, publicationId: selectedProduct.publicationId,
        ownerId: selectedProduct.ownerId, version: selectedProduct.version,
      } }),
      continuation: { planId: null, workloadId: null, submission: 'idle' as const,
        ...(files === undefined ? {} : { draft: { goal, input: {}, params: {}, files } }) } }
    if (writer === undefined) {
      if (selectedProduct === undefined && !draftOnly) return false
      pendingSelections.set(session.sessionId, call)
    } else recordCall(session.sessionId, writer, call)
    return true
  }
}
