/**
 * 左下角的账户卡。
 *
 * 为什么在**侧栏底部**而不是右上角：这是这一行的通行做法，也是它唯一合理的位置。
 * 它与"设置"同属"关于我自己/这台机器"的一组，和内容导航在语义上分层；
 * 放在侧栏底部意味着无论你在哪个面板，它都在同一个坐标上，
 * 用户的肌肉记忆只在建立时付一次成本。
 *
 * 本组件只做两件事：**如实显示**当前账号与额度，**把点击交出去**。
 * 它自己不发请求、不跳面板——那些分别由 `store.ts` 与 `client/index.ts` 负责，
 * 这样它可以被单独渲染成一个页面快照来测试。
 */

import { useEffect } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { remainingRatio, type AccountFacts, type GatewayFacts } from './status.ts'
import type { AccountView } from './store.ts'
import { useAccountView } from './use-account-view.ts'
import type { AccountKey } from './locales.ts'
import css from './AccountCard.module.css'

/** 账户卡从宿主注入的东西。 */
export interface AccountCardInjected {
  /** 只读快照源；组件自己订阅，避免"订阅晚一步"的撕裂。 */
  readonly view: SnapshotStore<AccountView>
  /** 打开个人中心。 */
  readonly open: () => void
  /**
   * 按 TTL 读一次（挂载时用；store 自己节流，不会变成轮询）。
   *
   * 卡片上**没有**手动刷新按钮：刷新属于"我想核对一下"的动作，放在个人中心里
   * 更合适（那一页本来就有一排动作与更新时间）。底部这一块保持最简——
   * 头像、名字、档位、额度，以及一个打开它的点击，多一个按钮就多一次分心。
   */
  readonly refresh: () => void
}

/** 组件的完整入参。 */
export type AccountCardProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'qianshou.account'>
  & AccountCardInjected


/** 档位标签：优先用服务端给的名字，服务端没给才回落本地字典。 */
function tierLabel(gateway: GatewayFacts, t: (key: AccountKey) => string): string {
  const id = gateway.tier.id
  if (gateway.tier.label.length > 0 && gateway.tier.label !== id) return gateway.tier.label
  if (id === 'basic' || id === 'plus' || id === 'max') return t(`tier.${id}` as AccountKey)
  return t('tier.unknown')
}

/** 头像里的字：用户名首字，退到邮箱首字，再退到一个中性符号。 */
function initialOf(account: AccountFacts | null): string {
  const source = account?.username.trim() || account?.email.trim() || ''
  return source.length > 0 ? source.slice(0, 1).toUpperCase() : '·'
}

/**
 * 侧栏底部的账户卡。
 * @param props - 快照源、动作与文案。
 */
export function AccountCard({ wide, view: store, open, refresh, t }: AccountCardProps) {
  const view = useAccountView(store)
  /**
   * 挂载即读一次。**不传 force**：store 自己有 TTL 与单飞，所以
   * 侧栏重挂（收起/展开、面板切换）不会变成打自己后端的轮询器；
   * 而"刚进页面就该有数字"这条仍然成立。
   */
  useEffect(() => { refresh() }, [refresh])
  /**
   * 首屏失败要有界自愈。
   *
   * 为什么必须有这一段（实测逼出来的，不是保险起见）：冷启动后第一次读
   * `/api/qianshou/account/state` 可能赶上账号会话还没 hydrate 完而失败。
   * 那时 `store` 已经把 TTL 退避设为"可重试"，但**没有任何人在驱动第二次读**——
   * 上面的挂载效应只会在挂载时跑一次，组件不会再因为"状态不可用"而重挂。
   * 现象是卡片一直停在"暂时读不到"，用户点一下刷新立刻就好——那说明数据没问题、
   * 缺的只是重试。而让用户去点一次毫无道理。
   *
   * 三次、退避 1.5s／3s／6s，之后**放弃**：这是有界自愈，不是轮询。
   * 依赖里放 phase 本身，所以每次失败都会重新排一次队；成功（ready）后
   * 布尔值变 false，效应不再排任何东西。
   */
  const unsettled = view.accountPhase === 'unavailable' || view.gatewayPhase === 'unavailable'
  useEffect(() => {
    if (!unsettled) return
    const attempts = [1_500, 3_000, 6_000]
    let index = 0
    let timer = 0
    const tick = (): void => {
      refresh()
      index += 1
      if (index < attempts.length) timer = window.setTimeout(tick, attempts[index] ?? 0)
    }
    timer = window.setTimeout(tick, attempts[0] ?? 0)
    return () => { window.clearTimeout(timer) }
  }, [unsettled, refresh])
  const account = view.account
  const gateway = view.gateway
  const phase = view.gatewayPhase
  // 额度比例：算不出来（总量未知）时不画进度条，画一条**不确定**的底纹。
  const ratio = gateway === null ? null : remainingRatio(gateway.credit)
  const low = ratio !== null && ratio <= 0.15

  const name = account === null
    ? (view.accountPhase === 'loading' ? t('card.loading') : view.accountPhase === 'anonymous' ? t('card.anonymous') : t('card.unavailable'))
    : (account.username.trim() || account.email.trim() || `#${account.id}`)
  /**
   * 副行只放**一个事实**：还剩多少。
   *
   * 原来这里是 `档位 · 剩余`，而档位在名字右边还有一个**彩色胶囊**——
   * 同一个信息在一张 256px 宽的卡里出现两次，读起来像贴纸堆，
   * 这就是用户说的"额度显示太 low"的来源。
   * 现在两行各说一件事：主行 = 我是谁 + 什么档位，副行 = 还剩多少。
   */
  const sub = account !== null
    ? (gateway === null ? t('card.anonymous.hint') : t('card.remaining.value', { sp: gateway.credit.remainingSp.toFixed(2) }))
    : (view.accountPhase === 'anonymous' ? t('card.anonymous.hint') : view.accountPhase === 'unavailable' ? t('card.unavailable.hint') : '')

  return (
    <div className={css.card} data-qianshou-account-card="" data-phase={phase} data-wide={wide ? '1' : '0'}>
      <button
        type="button"
        className={css.hit}
        onClick={open}
        title={t('card.expand')}
        aria-label={t('card.expand')}
        data-qianshou-account-hit=""
      >
        <span className={css.avatar} data-low={low ? '1' : '0'} aria-hidden="true">
          {initialOf(account)}
        </span>
        {wide ? (
          <span className={css.body}>
            <span className={css.nameRow}>
              <span className={css.name}>{name}</span>
              {gateway === null ? null : (
                /* 档位是**次要文字**，不再用彩色胶囊：
                   胶囊在 256px 宽的卡里会把主行切成"名字｜色块｜余额"三段，
                   视觉上像贴纸。改成同一行里的次级文字——层级靠字号与颜色表达，
                   这也是规范 §2 的层级三件套（留白、字号、颜色）里的前两件。 */
                <span className={css.tier} data-tier={gateway.tier.id}>{tierLabel(gateway, t)}</span>
              )}
            </span>
            {sub.length > 0 ? <span className={css.sub}>{sub}</span> : null}
            <span className={css.meter} data-known={ratio === null ? '0' : '1'} aria-hidden="true">
              <span className={css.meterFill} style={{ width: `${Math.round((ratio ?? 0) * 100)}%` }} data-low={low ? '1' : '0'} />
            </span>
          </span>
        ) : null}
      </button>
    </div>
  )
}
