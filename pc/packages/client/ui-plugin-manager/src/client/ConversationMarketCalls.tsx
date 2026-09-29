/** Persistent market history bridge and one chronologically placed task card. */
import { useLayoutEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatTimelineEntryProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { createConversationMarketStore } from './conversation-market-store.ts'
import { isConversationMarketCall } from './conversation-market-store.ts'
import { canCallMarketCapability } from './market-capabilities-controller.ts'
import { MarketTaskCall } from './MarketTaskCall.tsx'
import { marketTaskProgressLabels } from './market-task-progress-locales.ts'
import type { ConversationMarketBridgeInject, ConversationMarketTimelineInject } from './conversation-market-entry.ts'
import css from './ConversationMarketCalls.module.css'

type BridgeProps = PropsRuntime<'conversation.content.entries'>
  & PropsStore<ReturnType<typeof createConversationMarketStore>> & PropsLocale<'qianshou.marketCalls'>
  & InjectFace<ConversationMarketBridgeInject>

/** Keep the original store and presence semantics; cards render in Chat's ordered flow. */
export function ConversationMarketCalls({ sessionId, useStore, reportPresence, publish, activate, t }: BridgeProps) {
  const stored = useStore(state => state.calls)
  const rows: unknown[] = Array.isArray(stored) ? stored : []
  const calls = rows.filter(row => isConversationMarketCall(row, sessionId))
  const invalid = !Array.isArray(stored) || calls.length !== rows.length
  const present = calls.length > 0 || invalid
  useLayoutEffect(() => activate(), [activate])
  useLayoutEffect(() => { publish(calls) }, [stored, sessionId, publish])
  useLayoutEffect(() => {
    reportPresence('qianshou-market-calls', present)
    return () => { reportPresence('qianshou-market-calls', false) }
  }, [present, reportPresence])
  return invalid ? <p role="alert">{t('invalid')}</p> : null
}

type CardProps = ChatTimelineEntryProps & PropsLocale<'qianshou.marketCalls'>
  & PropsStore<ReturnType<typeof createConversationMarketStore>>
  & InjectFace<ConversationMarketTimelineInject>

/** Render the original request and evolving result at its immutable submission position. */
export function ConversationMarketTimelineCall({ sessionId, entryId, useStore, useMarketCatalog,
  continueCall, recordDispatch, refreshCatalog, loadInputPresentation, prepareVideoAssetPlan, t }: CardProps) {
  const call = useStore(state => Array.isArray(state.calls) ? state.calls.find(row => row.id === entryId) : undefined)
  const catalog = useMarketCatalog(state => state)
  if (!isConversationMarketCall(call, sessionId)) return null
  const catalogReady = call.draftOnly !== true && catalog.loaded && !catalog.loading && !catalog.error
    && catalog.capabilities.some(item => item.taskType === call.capability.taskType
      && item.capabilityId === call.capability.capabilityId && canCallMarketCapability(item)
      && (call.selectedProduct === undefined || item.products.some(product =>
        product.productId === call.selectedProduct?.productId
        && product.publicationId === call.selectedProduct?.publicationId
        && product.ownerId === call.selectedProduct?.ownerId
        && product.version === call.selectedProduct?.version)))
  const catalogStatus = call.draftOnly === true ? 'not-callable' : catalog.error ? 'unavailable'
    : !catalog.loaded || catalog.loading ? 'loading' : 'not-callable'
  return <article className={css.card} data-market-call-id={call.id} data-conversation-market-calls={sessionId}>
    <div className={css.request}>
      <p><strong>@{call.capability.name}</strong> {call.goal}</p>
      {call.selectedProduct !== undefined && <small>{t('selectedProductVersion')}
        {' '}{call.selectedProduct.version}</small>}
      <time dateTime={call.createdAt}>{new Date(call.createdAt).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit',
      })}</time>
    </div>
    <MarketTaskCall capability={call.capability} draftOnly={call.draftOnly === true}
      directVideoEntry={call.directVideoEntry === true || call.draftOnly === true}
      {...(call.selectedProduct === undefined ? {} : { selectedProduct: call.selectedProduct })} catalogReady={catalogReady}
      catalogStatus={catalogStatus} refreshCatalog={refreshCatalog}
      loadInputPresentation={loadInputPresentation}
      prepareVideoAssetPlan={prepareVideoAssetPlan}
      initialGoal={call.goal} progressLabels={marketTaskProgressLabels(t)}
      continuation={call.continuation} onContinuation={(next) => {
        if (!continueCall(call.id, next)) return
        if (call.continuation.workloadId === null && next.workloadId !== null && call.usageOwner !== undefined) {
          recordDispatch(call.id, call.capability.taskType, next.workloadId, call.usageOwner)
        }
      }} />
  </article>
}
