/** A task-first market: official and user implementations are alternatives behind one @ capability. */
import { useEffect, useMemo, useState } from 'react'
import { Button, SkillCover } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketCapabilitiesView } from './market-capabilities-controller.ts'
import { categoryLabel } from './market-mention-source.ts'
import { canComposeMarketCapability } from './market-selection.ts'
import type { EnterMarketConversation } from './market-conversation-entry.ts'
import { useMarketConversation } from './use-market-conversation.ts'
import { zh, type MarketplaceKey } from './marketplace-locales.ts'
import css from './OrderProductsPanel.module.css'

export function MarketCapabilitiesPanel({ view, reload, focusTaskType, focusGoal = '', enterConversation, t = key => zh[key] }: {
  view: MarketCapabilitiesView
  reload: () => void
  focusTaskType?: string | null
  focusGoal?: string
  enterConversation?: EnterMarketConversation | undefined
  t?: (key: MarketplaceKey) => string
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部')
  const [showUnavailable, setShowUnavailable] = useState(false)
  const call = useMarketConversation(enterConversation)
  const catalogReady = view.loaded && !view.error
  useEffect(() => { if (!view.loaded && !view.loading && !view.error) reload() }, [view.loaded, view.loading, view.error, reload])
  useEffect(() => {
    if (!focusTaskType || !view.capabilities.some(item => item.taskType === focusTaskType)) return
    const card = document.getElementById(`qianshou-market-capability-${focusTaskType}`)
    if (typeof card?.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' })
  }, [focusTaskType, view.capabilities])
  const categories = useMemo(() => ['全部', ...new Set(view.capabilities.map(item => categoryLabel(item.category, item.categoryLabelZh)))],
    [view.capabilities])
  const needle = query.trim().toLocaleLowerCase()
  const filtered = view.capabilities.filter(item =>
    (showUnavailable || canComposeMarketCapability(item, view.capabilities))
    && (category === '全部' || categoryLabel(item.category, item.categoryLabelZh) === category)
    && (!needle || [item.name, item.description, item.taskType, item.categoryLabelZh]
      .some(value => value.toLocaleLowerCase().includes(needle))))
  return <section className={css.panel} data-qianshou-market-capabilities>
    <div className={css.head}><div><h2>{t('workspaceMarket')}</h2>
      <p>{t('marketConversationIntro')}</p></div>
      <Button variant="outline" size="sm" onClick={reload} disabled={view.loading}>刷新</Button></div>
    <div className={css.filters}>
      <input type="search" aria-label="搜索市场能力" value={query} placeholder="搜索能力名称或用途"
        onChange={event => { setQuery(event.currentTarget.value) }} />
      <select aria-label="筛选能力分类" value={category} onChange={event => { setCategory(event.currentTarget.value) }}>
        {categories.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      {view.capabilities.some(item => !canComposeMarketCapability(item, view.capabilities)) && <label className={css.availability}>
        <input type="checkbox" checked={showUnavailable} onChange={event => { setShowUnavailable(event.currentTarget.checked) }} />
        {t('marketShowUnavailable')}</label>}
    </div>
    {view.loading && <p role="status">正在读取市场能力…</p>}
    {view.error && <p role="alert">{t(view.errorKind === 'invalid'
      ? 'marketCapabilitiesInvalid' : 'marketCapabilitiesUnavailable')}</p>}
    {view.loaded && !view.error && filtered.length === 0 && <p role="status">没有找到对应能力。</p>}
    <div className={css.grid}>{filtered.map(item => <article className={css.card}
      key={item.taskType} id={`qianshou-market-capability-${item.taskType}`}
      data-focused={focusTaskType === item.taskType || undefined}>
      <SkillCover category={item.category} atlasUrl="/assets/qianshou-skill-category-atlas.png" />
      <div className={css.top}>
        <div><h3>{item.name}</h3><small>{categoryLabel(item.category, item.categoryLabelZh)} · {item.publisherKinds.includes('official') ? '官方' : '用户'}
          {item.publisherKinds.includes('official') && item.publisherKinds.includes('user') ? '与用户' : ''}
          {' · '}{item.executionMode === 'cloud' ? '云端' : '设备调度'}</small></div></div>
      <p>{item.description}</p>
      <small className={css.scope}>{item.products.length > 0
        ? `${item.products.length} 个已审核商品` : '按能力任务调用'}</small>
      <div className={css.foot}>
        <span>{item.availability !== 'contract_ready' ? '暂未开放'
          : item.formReady === false ? '等待输入配置'
            : !canComposeMarketCapability(item, view.capabilities) ? t('marketConversationUnavailable') : '按本次任务报价'}</span>
        <Button variant="outline" size="sm" disabled={!catalogReady || enterConversation === undefined
          || call.pending === item.taskType || !canComposeMarketCapability(item, view.capabilities)}
          onClick={() => { call.select({ taskType: item.taskType, expected: item,
            ...(focusTaskType === item.taskType && focusGoal !== '' ? { goal: focusGoal } : {}) }) }}>
          {t(call.pending === item.taskType ? 'marketConversationChecking' : 'marketConversationUse')}</Button>
      </div>
      {call.failed === item.taskType && <p role="alert">{t('marketConversationFailed')}</p>}
    </article>)}</div>
  </section>
}
