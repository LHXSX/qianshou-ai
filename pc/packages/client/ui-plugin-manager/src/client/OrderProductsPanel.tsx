/** The executable goods market. A platform listing, account purchase and device install have separate receipts. */
import { useEffect } from 'react'
import { Button, SkillCover } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OrderProductsView } from './order-products-controller.ts'
import type { OrderPurchaseFailure } from './order-products-controller.ts'
import type { MarketplaceKey } from './marketplace-locales.ts'
import { categoryLabel } from './market-mention-source.ts'
import type { EnterMarketConversation } from './market-conversation-entry.ts'
import { useMarketConversation } from './use-market-conversation.ts'
import css from './OrderProductsPanel.module.css'

export interface OrderProductsPanelProps {
  view: OrderProductsView
  reload: () => void
  buyAndActivate?: (productId: string) => void
  focusProductId?: string | null
  enterConversation?: EnterMarketConversation | undefined
}

const failureText: Record<OrderPurchaseFailure, string> = {
  auth: '请先登录账号，再获取此技能。',
  balance_or_changed: '平台拒绝本次购买，可能是余额不足或商品状态已变化。请刷新商品后重试。',
  node_offline: '这台电脑尚未连上中央服务器。连接恢复后可继续设备验收。',
  attestor_unavailable: '独立设备验收暂不可用。若已购买，权益仍在；稍后可重试验收。',
  source_invalid: '安装包或本机样例未通过校验，尚未取得接单资格。',
  network: '网络暂不可用；请恢复连接后重试。',
  refunded: '这笔购买已退款，设备没有激活。',
  client_update: '当前客户端缺少完整验收能力；更新客户端后再试。',
  product_not_ready: '这台电脑还不支持该商品的完整安装验收；没有扣款。',
}

const localReason = {
  'unsupported-platform': '当前系统尚不支持这个接单源包的安装验收，不能在这台设备上购买。',
  'configuration-missing': '这台电脑缺少已信任的安装或验收配置，暂不能购买。',
  'node-offline': '这台电脑尚未连接中央服务器，连接后即可继续。',
  'client-update': '客户端尚未提供一键安装验收入口，请更新客户端。',
  unavailable: '暂时无法检查这台设备是否就绪，请刷新后再试。',
} as const

export function OrderProductsPanel({ view, reload, buyAndActivate, focusProductId, enterConversation, t }: OrderProductsPanelProps & {
  t: (key: MarketplaceKey) => string
}) {
  const call = useMarketConversation(enterConversation)
  useEffect(() => { if (!view.loaded && !view.loading && view.error === null) reload() }, [view.loaded, view.loading, view.error, reload])
  useEffect(() => {
    if (!focusProductId || !view.products.some(item => item.id === focusProductId)) return
    const card = document.getElementById(`qianshou-order-product-${focusProductId}`)
    if (typeof card?.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' })
    card?.focus()
  }, [focusProductId, view.products])
  return <section className={css.panel} data-qianshou-order-products>
    <div className={css.head}>
      <div>
        <h2>{t('orderProductsTitle')}</h2>
        <p>{t('orderProductsIntro')}</p>
      </div>
      <Button variant="outline" size="sm" disabled={view.loading} onClick={reload}>{t('orderProductsRefresh')}</Button>
    </div>
    <p className={css.notice} role="status">{!view.buyerReadiness.ready && view.buyerReadiness.reason
      ? localReason[view.buyerReadiness.reason]
      : !view.entitlementsKnown ? '暂时无法确认账号的已购权益，请登录或刷新；现在不会扣款。'
        : view.products.some(item => item.availableToPurchase)
          ? t('orderProductsOneClickIntro') : t('orderProductsPurchasePaused')}</p>
    {view.loading && <p role="status">{t('orderProductsLoading')}</p>}
    {!view.loading && view.error !== null && <div className={css.state} role="alert">
      <strong>{t(view.error === 'route_unavailable' ? 'orderProductsRouteTitle'
        : view.error === 'invalid' ? 'orderProductsInvalidTitle' : 'orderProductsUnavailableTitle')}</strong>
      <p>{view.error === 'route_unavailable'
        ? t('orderProductsRouteBody')
        : view.error === 'invalid'
          ? t('orderProductsInvalidBody')
          : t('orderProductsUnavailableBody')}</p>
    </div>}
    {!view.loading && view.error === null && view.loaded && view.products.length === 0
      && <div className={css.empty} role="status"><strong>{t('orderProductsEmptyTitle')}</strong>
        <p>{t('orderProductsEmptyBody')}</p></div>}
    {view.error === null && view.products.length > 0 && <div className={css.grid}>{view.products.map((item) => {
      const action = view.action?.productId === item.id ? view.action : null
      const entitlement = view.entitlements.find(owned => owned.productId === item.id)
      const serverInstalled = entitlement?.status === 'installed' && entitlement.deviceInstalled
      const serverOwned = entitlement?.status === 'pending_install' || entitlement?.status === 'installed'
      const ownershipUnknown = entitlement?.status === 'unknown'
      const expired = entitlement?.status === 'pending_install' && entitlement.installExpiresAt !== null
        && Date.parse(entitlement.installExpiresAt) <= Date.now()
      const busy = action?.phase === 'purchasing' || action?.phase === 'activating'
      const isAuthor = view.sellerProductIds?.includes(item.id) === true
      const canStart = !isAuthor && !ownershipUnknown && view.buyerReadiness.ready && view.entitlementsKnown && !expired
        && (item.availableToPurchase || action?.owned === true || serverOwned)
      const purchaseLabel = isAuthor ? '我的商品'
        : ownershipUnknown ? '权益状态待核对'
          : action?.phase === 'purchasing' ? '正在购买…'
            : action?.phase === 'activating' ? '正在安装并验收…'
              : action?.phase === 'ready' || serverInstalled ? '本机已激活'
                : expired ? '等待自动退款'
                  : action?.owned || serverOwned ? '继续设备验收'
                    : item.availableToPurchase && view.buyerReadiness.ready && view.entitlementsKnown
                      ? '一键获取并启用'
                      : t('orderProductsPurchaseDisabled')
      return <article
        className={css.card} key={item.id} id={`qianshou-order-product-${item.id}`}
        tabIndex={-1} data-focused={focusProductId === item.id || undefined}>
        <SkillCover category={item.category} atlasUrl="/assets/qianshou-skill-category-atlas.png" />
        <div className={css.top}>
          <div><h3>{item.name}</h3><small>{t('orderProductsCardScope')
            .replace('{category}', categoryLabel(item.category)).replace('{version}', item.version)}</small></div></div>
        <p>{item.description}</p>
        <small className={css.scope}>{t('orderProductsTaskType').replace('{taskType}', item.taskType)}</small>
        <div className={css.foot}>
          <strong>{t('orderProductsPrice').replace('{price}', item.salePriceYuan)}</strong>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={enterConversation === undefined || call.pending === item.taskType}
              onClick={() => { call.select({ taskType: item.taskType, product: {
                productId: item.id, publicationId: item.publicationId, version: item.version, ownerId: item.ownerId } }) }}>
              {t(call.pending === item.taskType ? 'marketConversationChecking' : 'productConversationView')}</Button>
            <Button variant="outline" size="sm"
              disabled={!canStart || busy || action?.phase === 'ready' || serverInstalled || !buyAndActivate}
              onClick={() => { buyAndActivate?.(item.id) }}>{purchaseLabel}</Button>
          </div>
        </div>
        {!item.availableToPurchase && action?.owned !== true && !serverOwned && <small className={css.blockReason}>
          {item.purchaseBlockReason || '独立验收尚未就绪；现在不会扣款。'}</small>}
        {isAuthor && <small className={css.blockReason}>这是你发布的商品，无需重复购买；本机接单请在“我的技能”启用已审核能力。</small>}
        {ownershipUnknown && <small className={css.blockReason}>中央服务器保留了未确认的权益记录。请刷新核对；不会重复购买或启动设备验收。</small>}
        {serverOwned && !serverInstalled && action?.phase !== 'ready' && <small className={css.blockReason}>
          {expired ? '购买安装期已过，平台退款任务将处理这笔托管款。'
            : '已查到你的购买权益；设备验收通过前不会显示为可接单。'}</small>}
        {action?.phase === 'failed' && <p className={css.actionError} role="alert">
          {failureText[action.reason ?? 'client_update']}</p>}
        {(action?.phase === 'ready' || serverInstalled) && <p className={css.actionReady} role="status">
          中央服务器已确认这台设备的激活回执。是否接单由你在接单页打开总开关。</p>}
        <small className={css.scope}>{t('orderProductsContractScope')}</small>
        {call.failed === item.taskType && <p role="alert">{t('marketConversationFailed')}</p>}
      </article> })}</div>}
    {view.entitlementsKnown && view.entitlements.some(item => !view.products.some(product => product.id === item.productId))
      && <div className={css.state}><strong>我的已购技能</strong>
        <p>以下商品当前不在上架目录；购买记录仍保存在中央服务器。</p>
        {view.entitlements.filter(item => !view.products.some(product => product.id === item.productId))
          .map(item => <p key={item.entitlementId}>{item.productName} · {item.status === 'refunded' ? '已退款'
            : item.status === 'unknown' ? '权益状态待核对' : item.deviceInstalled ? '本机已激活' : '等待设备验收或退款'}</p>)}</div>}
  </section>
}
