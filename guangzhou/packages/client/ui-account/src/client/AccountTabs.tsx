/**
 * 个人中心的四个标签页：总览 / 档位 / 充值 / 用量。
 *
 * ## 为什么分区而不是一页到底
 *
 * 四件事的**读者心态不同**：总览是「我现在什么状态」，档位是「我要不要换」，
 * 充值是「怎么给钱」，用量是「我的钱花哪了」。堆成一页会让"我在哪"这件事消失，
 * 而用户来这一页通常只关心其中一个。标签页让每一段自带答案。
 *
 * ## 充值这一页为什么没有付款按钮
 *
 * **后端没有支付。** `packages/host/model-gateway/src/subscription-routes.ts` 写得很明白：
 * 支付回调、订单号、退款由**部署方**接自己的系统，然后调管理路由把权益给上；
 * 网关只负责"钱已经收过了，把权益给上"。上游账号 API 里也只有 auth 与 profile。
 *
 * 所以这一页做的是把**真实的计价模型讲清楚**并给出**真实的升级路径**。
 * 画一个能点的"立即支付"然后什么都不发生，比空着更糟：用户会以为钱付了。
 */

import { useCallback, useEffect, useState } from 'react'
import { useAccountView } from './use-account-view.ts'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountView } from './store.ts'
import { readUsage, type UsageRead } from './usage.ts'
import { OverviewTab } from './tabs/OverviewTab.tsx'
import { PlanTab } from './tabs/PlanTab.tsx'
import { CreditTab } from './tabs/CreditTab.tsx'
import { UsageTab } from './tabs/UsageTab.tsx'
import type { TranslateAccount } from './locales.ts'
import css from './AccountPage.module.css'

/** 四个标签页的 id。 */
export type AccountTab = 'overview' | 'plan' | 'credit' | 'usage'

/** 标签页顺序；`overview` 在最前，因为它是默认落点。 */
export const ACCOUNT_TABS: readonly AccountTab[] = ['overview', 'plan', 'credit', 'usage']

/** 页面从宿主注入的东西。 */
export interface AccountTabsInjected {
  /**
   * 快照源。类型写 `SnapshotStore<AccountView>` 而不是一个手写的
   * `{subscribe, getSnapshot}`：`useSyncExternalStore` 的桥接函数按前者声明，
   * 手写一个更窄的形状会因为缺 `update`/`set` 而不可赋值——而组件根本不需要那两个，
   * 这正是"用真实类型而不是近似类型"的收益：桥接层不用改签名去迁就调用方。
   */
  readonly view: SnapshotStore<AccountView>
  /** 按 TTL 读一次（挂载时）。 */
  readonly refresh: () => void
  /** 绕过 TTL 读一次（用户点了刷新 / 重试）。 */
  readonly forceRefresh: () => void
  /** 关闭 / 返回。**语义由座位决定**：主面板是"回对话"，设置里是"关设置"。 */
  readonly back: () => void
}

/** 标签页的显示名键在 `qianshou.account` 字典里。 */
const TAB_LABEL = {
  overview: 'tab.overview',
  plan: 'tab.plan',
  credit: 'tab.credit',
  usage: 'tab.usage',
} as const

/** 一页的标题与副标题键。 */
const TAB_HEAD = {
  overview: 'tab.overview.lead',
  plan: 'plan.lead',
  credit: 'credit.lead',
  usage: 'usage.lead',
} as const

/** 组件的完整入参；`t` 与 `back` 由调用方（注册点）提供。 */
export interface AccountTabsProps extends AccountTabsInjected {
  readonly readAt: number | null
  readonly t: TranslateAccount
}

/**
 * 个人中心：标题 + 标签页 + 内容。
 * @param props - 快照源、用量、动作与文案。
 */
export function AccountTabs({ view, refresh, forceRefresh, back, readAt, t }: AccountTabsProps) {
  const state = useAccountView(view)
  const [tab, setTab] = useState<AccountTab>('overview')
  useEffect(() => { refresh() }, [refresh])

  /**
   * 用量是**本组件自己读的**，不是从座位注入的。
   *
   * 原来它在 `AccountCenter`（主面板包装层）里读、再把结果透传下来。
   * 这样做的代价是：想在**设置**里也渲染同一份内容时，包装层拿不到那个 hook，
   * 于是要么复制一份读取逻辑、要么把状态提到插件层（多一份可能不一致的真相）。
   * 搬到这里之后两个座位都只是"透传 props + 给一个 back 语义"，
   * 用量读取只有一处实现、也只有一份数字。
   */
  const [usageState, setUsageState] = useState<{ usage: UsageRead | null; loading: boolean }>({ usage: null, loading: true })
  const [token, setToken] = useState(0)
  const onForce = useCallback(() => { forceRefresh(); setToken(current => current + 1) }, [forceRefresh])
  useEffect(() => {
    // 每次刷新换一个 AbortController：否则先发的慢响应会覆盖后发的快响应。
    const abort = new AbortController()
    setUsageState(previous => ({ usage: previous.usage, loading: true }))
    void readUsage(abort.signal).then((result) => {
      if (abort.signal.aborted) return
      setUsageState({ usage: result, loading: false })
    })
    return () => { abort.abort() }
  }, [token])
  const { usage, loading: usageLoading } = usageState

  return (
    <div className={css.page} data-qianshou-account-page="" data-tab={tab}>
      <header className={css.head}>
        <div className={css.headText}>
          <h1 className={css.title}>{t('page.title')}</h1>
          <p className={css.subtitle}>{t(TAB_HEAD[tab])}</p>
        </div>
        <div className={css.headActions}>
          {readAt === null ? null : (
            <span className={css.readAt}>{t('field.readAt')} {new Date(readAt).toLocaleTimeString()}</span>
          )}
          <button type="button" className={css.ghost} onClick={onForce} data-qianshou-account-refresh="">{t('card.refresh')}</button>
          <button type="button" className={css.ghost} onClick={back}>{t('page.back')}</button>
        </div>
      </header>

      {/* 角色是 `tablist`/`tab`/`tabpanel`：键盘左右键、屏幕阅读器靠它知道
          "这里有四个视图，当前是哪一个"。用一排 div 加样式是最容易写错的地方。 */}
      <div className={css.tabs} role="tablist" aria-label={t('page.title')}>
        {ACCOUNT_TABS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`qianshou-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`qianshou-panel-${id}`}
            className={css.tab}
            data-active={tab === id ? '1' : '0'}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
      </div>

      <div
        className={css.panel}
        role="tabpanel"
        id={`qianshou-panel-${tab}`}
        aria-labelledby={`qianshou-tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'overview' && (
          <OverviewTab
            state={state}
            onRefresh={onForce}
            onGoPlan={() => setTab('plan')}
            onGoCredit={() => setTab('credit')}
            t={t}
          />
        )}
        {tab === 'plan' && <PlanTab state={state} t={t} />}
        {tab === 'credit' && <CreditTab state={state} t={t} />}
        {tab === 'usage' && <UsageTab usage={usage} loading={usageLoading} onRefresh={onForce} t={t} />}
      </div>
    </div>
  )
}
