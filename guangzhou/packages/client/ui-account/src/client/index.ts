/**
 * 账户区的浏览器半边。
 *
 * 三件事，各自独立：
 * 1. **侧栏最底部的账户卡**（`sidebar.footer.action`）+ 一次跨包重排（见 `foot.css`）；
 * 2. **套餐与额度**：同一份内容挂在两处——`main` 槽的 `qianshou-account` 面板，
 *    以及设置里的「套餐与额度」小节（用户要求功能性入口统一收进设置）；
 * 3. 设置里的「套餐与额度」小节（`settings.section`）——左栏不再单独占一行。
 *
 * 为什么账户卡与个人中心页共用**同一个** `AccountViewService` 实例：
 * 两处显示的额度必须是同一个数字。各拉各的缓存迟早会出现
 * 「侧栏说 389、页面说 385」这种没法解释的差异，而用户会把它当成计费问题。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { AccountCard } from './AccountCard.tsx'
import { AccountCenter } from './AccountCenter.tsx'
import { AccountSettingsSection } from './AccountSettingsSection.tsx'
import { AccountViewService } from './store.ts'
import { NS, en, zh, type AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'qianshou.account': AccountKey
  }
}

/** 主面板与侧栏导航共用的 id。 */
const PANEL_ID = 'qianshou-account'

/** 需要的服务：槽位注册与文案字典。 */
export const inject = ['slots', 'locale']

/**
 * 注册账户卡、个人中心页与导航行，并在侧栏 footer 里落一条分隔线。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  // 读状态的服务按插件生命周期持有：侧栏卡片与页面共享它，
  // 于是"打开页面"不会触发第二次往返，两处数字也永远一致。
  const service = new AccountViewService()
  ctx.effect(() => () => { service.dispose() }, 'ui-account: read lifetime')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-account: dictionaries')



  const layoutOf = (): { selectPanel: (id: MainPanelId | null) => void } | undefined =>
    ctx.reflect.get('layout', false) as { selectPanel: (id: MainPanelId | null) => void } | undefined

  const openPanel = (): void => {
    layoutOf()?.selectPanel(PANEL_ID as MainPanelId)
  }

  /**
   * 注入面**只构造一次**，这是必须的而不是风格问题。
   *
   * `inject` 工厂每次渲染都会被调用；如果它每次返回新对象，
   * 里面的箭头函数每次都是新身份，而组件把「挂载即读一次」写成
   * `useEffect(() => refresh(), [refresh])` —— 依赖每次都在变，
   * 效应于是**空转且永不生效**：卡片会永远停在 `idle`，界面上什么都不显示，
   * 控制台一行错也没有。这个组合极难从现象反推原因，所以这里用注释钉住它。
   */
  const refreshOnce = (): void => { void service.refresh() }
  const refreshForced = (): void => { void service.refresh({ force: true }) }
  const cardFace = {
    // 传入 store 本身而不是快照：组件用 useSyncExternalStore 订阅，
    // 这样"读快照"与"订阅"在一次渲染里成对发生，不会出现订阅晚一步的撕裂。
    view: service.store,
    open: openPanel,
    // 两个动作刻意分开：挂载时走 TTL（侧栏重挂不该变成轮询），
    // 用户点刷新时走 force（点了就必须真去读）。
    refresh: refreshOnce,
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    // 这个槽是 `list` 类，条目必须带 id——它是渲染 key，
    // 也是将来需要按 id 定位或替换某一条时唯一的抓手。
    id: 'qianshou-account',
    locale: NS,
    inject: () => cardFace,
  }, AccountCard))

  const pageFace = {
    view: service.store,
    refresh: refreshOnce,
    forceRefresh: refreshForced,
    back: (): void => { layoutOf()?.selectPanel(null) },
    // 传函数而不是值：这是**注入面**，每次渲染都会读一次；传值会把更新时间
    // 冻结在注入那一刻，页面上那个时间永远不会变。
    readAt: (): number | null => service.store.getSnapshot().readAt,
  }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => pageFace,
  }, AccountCenter))

  /**
   * 设置里的「套餐与额度」小节。
   *
   * 这是用户要求的落点：**个人中心应该出现在设置里**，左栏不再单独占一行。
   * 与 `main` 面板共用同一个 `AccountTabs`，所以两处显示的数字必然一致。
   *
   * 名字刻意不叫"账户"：设置里已有一个上游的「账号」小节（登录 / 2FA / 退出），
   * 那是"我是谁"，这里是"我买到什么、还剩多少"，两个入口不能同名。
   */
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PANEL_ID,
    /* 排在上游「账号」之后（那条 order 是 5）、「模型」之前：
       先确认身份，再看套餐与额度，最后是模型与路由。 */
    order: 6,
    label: () => ctx.locale.bind(NS)('settings.title'),
    locale: NS,
    inject: () => pageFace,
  }, AccountSettingsSection))

}

/*
 * 这里**故意不再注册 `sidebar.panellist`**。
 *
 * 原来左栏有一行「个人中心」直达 `qianshou-account` 主面板。用户的要求是：
 * "个人中心应该是在下面的设置里面，设置里面包含所有功能性的东西。"
 * 也就是说左栏只承载"对话 + 历史会话"，而**功能性入口统一收进设置**——
 * 这与之前把智能体广场/任务中心/工作流等 8 项搬进设置是同一条规则。
 *
 * 主面板注册（上面的 `main`）保留：账户卡点击走它（那是最可靠的跳转机制），
 * 别处按 id 跳转也还依赖它。设置里的小节与主面板**渲染同一个 `AccountTabs`**、
 * 读同一个 store，所以两处数字必然一致，不构成"两个入口两份真相"。
 *
 * `个人中心` 作为设置小节时改名为「套餐与额度」：设置里**已经有**一个
 * 上游的「账号」小节（登录 / 注册 / 2FA / 退出），两者职责必须分开、
 * 名字也不能都叫"账户"——见 locales.ts 里 `settings.title` 的注释。
 */
