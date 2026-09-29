/**
 * 「套餐与额度」设置小节：把个人中心**整页内容**放进设置面板。
 *
 * ## 为什么要有这一层（用户的要求）
 *
 * 用户原话：「个人中心应该是在下面的设置里面，设置里面包含所有功能性的东西。」
 * 所以左栏不再单独占一行（那条 `sidebar.panellist` 注册已删除），
 * 功能性入口统一收进设置——与之前把智能体广场/任务中心/工作流等 8 项搬进设置同一条规则。
 *
 * ## 为什么不叫「账户」
 *
 * 设置里**已经有一个上游的「账号」小节**（登录 / 注册 / 2FA / 退出，
 * 见 `ui-settings-general` 的 `AccountSection`）。两者职责不同：
 * - 「账号」= 我是谁、怎么登录；
 * - 「套餐与额度」= 我买到什么、还剩多少、这个周期用了多少。
 * 名字必须分开，否则用户会在两个都叫"账户"的入口之间来回点。
 *
 * ## 为什么是与 `main` 面板共用 `AccountTabs`
 *
 * 同一份内容要在两个座位里渲染（主面板 `main` 与设置小节 `settings.section`）。
 * 两个座位的**通用部分一致**（都提供 locale 与 hook 位），差异只有设置多一个 `close`。
 * 所以这里把 settings 的 props 透传给同一个 `AccountTabs`，
 * 只把 `back` 从"回主面板"换成"关设置面板"——那是唯一语义不同的地方。
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountTabs, type AccountTabsInjected } from './AccountTabs.tsx'

/** 设置小节的座位 props（比主面板多一个 `close`）。 */
export type AccountSettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'qianshou.account'> & AccountTabsInjected

/** 在设置面板里渲染套餐与额度。 */
export function AccountSettingsSection({ close, view, refresh, forceRefresh, t }: AccountSettingsProps) {
  return (
    <AccountTabs
      view={view}
      refresh={refresh}
      forceRefresh={forceRefresh}
      /* 设置里"返回"的正确语义是**关掉设置面板**，回到用户原来的位置；
         而不是把他丢回一个主面板（那样设置还开着，反而更绕）。 */
      back={close}
      readAt={view.getSnapshot().readAt}
      t={t}
    />
  )
}
